// ============================================================
// 福建信息职业技术学院 · 福信智慧教务 → 拾光课程表 适配脚本
// ============================================================
// 教务前端: https://jw.fjpit.com   (Vue3 + Vben Admin 5.5.6, 超星系)
// 教务接口: https://jw-api.fjpit.com/api
//
// ============================================================
// ★ 取数：直接读教务接口，不解析页面 HTML
// ============================================================
// 这套接口来自移动端 m.fjpit.com（与主站共用同一后端与同一鉴权），
// 返回结构化 JSON，因此不需要做 rowspan/colspan 网格重建，
// 开学日期、总周数、作息时间也都能直接拿到，无需从页面里抠。
//
//   GET  /semesters                        → {semesters:[{label,value,isCurrent,isXxq}]}
//   POST /semesterConfig {semester}        → {semestersConfig:{startDate,totalWeeks,xxqStartDate,...}}
//   POST /scheduleTime   {dqz}             → {<key>:{jcdm,jcmc,jcskkssj,jcskjssj,remark}}
//   POST /schedule {semester,week,showxxq} → {list:[{course,teacherName,spaceName,
//                                              DayIndex,startNode,endNode,mergeTaskId,...}]}
//   鉴权：请求头 ba-token + server: 1
//
// 官方文档《WebView 页面显示异常的处理》也建议
// 「放弃从页面 HTML 提取数据，改用 Fetch API 请求接口获取课程数据」。
//
// ============================================================
// ★ X-WebView-Post-Id 是 WAF 的触发点
// ============================================================
// App 注入的 JS_INTERCEPT_POST 会给每个带字符串 body 的非 GET 请求
// 自动加该头，而教务 WAF 直接拒绝带它的请求（fetch 抛 Failed to fetch、耗时极短）。
// 诊断 v6 铁证：同一接口同一 frame，body 为字符串→FAIL、为 Blob→OK 200。
//
// 「电脑模式」救不了它：App 的拦截器要求 requestId != null，
// 而那个 id 恰恰只能靠这个头传递 —— 可这个头本身就是毒药。
//
// 因此本脚本：
//   1. 修复页面自身网络通道（让用户能正常登录，否则连登录都发不出去）
//      · window.fetch → 子 frame 的原生实现
//      · XHR 的 setRequestHeader 包一层丢弃该头（走原型链）
//   2. 自身所有请求走同一干净通道
//   （App 的 evaluateJavascript 只注入主 frame，子 frame 是干净的）
//
// ------------------------------------------------------------
// 与官方案例（如 NEUQ / YANGTZEU 树维教务）的关键差异
// ------------------------------------------------------------
// 它们的做法是「用户先在页面里登录好 → 点执行导入 → 直接 fetch」，
// 因为登录发生在独立的 CAS 域名上，绕开了教务系统的 WAF
// （长江大学的 import_url 就直接指向 CAS 认证页）。
//
// 福信不同：登录 POST 就在被 WAF 拦的域名上（诊断 v6：主 frame POST 全 FAIL、
// 去掉该头的请求全部 200）。所以「先登录」在未加工前走不通，
// 必须先运行本脚本把请求通道理通 —— 这是学校侧的限制，不是适配设计绕弯。
//
// 而且只在【首次使用或登录过期】时需要：token 存在 localStorage
// （fjpit-vben-auth-core-access），后续打开页面即为已登录，直接点导入即可。
// ------------------------------------------------------------

// 数据规则（沿用已验证结论）：
//   · 教师/教室原样透传：教务给空就是空，不填「无」
//   · 逐周抓 1~N 周，不用学期计划视图（军训不整周、调课、节假日）
// ============================================================

const FJPIT_API = 'https://jw-api.fjpit.com/api';
const FJPIT_HOST_KEY = 'fjpit.com';
const FJPIT_ID_HEADER = 'x-webview-post-id';

const FJPIT_LOGIN_WAIT_MS = 5 * 60 * 1000;

// ---------- 通用工具 ----------

function fjpitDelay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

function fjpitUuid() {
    try { return crypto.randomUUID(); } catch (e) { return 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2); }
}

/**
 * 把日期对齐到「所在周的周一」，返回 YYYY-MM-DD。
 *
 * 为什么需要：移动端前端就是这么算的（`const u = s===0 ? -6 : 1-s; l.setDate(l.getDate()+u)`），
 * 说明教务给的 startDate 不一定是周一。实测该校的 startDate = 2026-09-09（周三），
 * 而第 1 周周一应是 2026-09-07（该日期另经教务页面表头与移动端算法两处印证）。
 *
 * 用 UTC 运算避免设备时区把日期挪走一天。
 */
function fjpitAlignToMonday(dateStr) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr == null ? '' : dateStr));
    if (!m) return '';
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    if (isNaN(d.getTime())) return '';
    const dow = d.getUTCDay();                       // 0 = 周日
    const delta = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + delta);
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function fjpitSafeToast(msg) {
    try { window.shiguangBridge.showToast(msg); } catch (e) { console.log('JS[toast]: ' + msg); }
}

// ============================================================
// 一、干净网络通道（绕开 App 的 JS 补丁）
// ============================================================

let FJPIT_CLEAN_WIN = null;
let FJPIT_CLEAN_FETCH = null;

function fjpitCleanWindow() {
    if (FJPIT_CLEAN_WIN && FJPIT_CLEAN_WIN.fetch) return FJPIT_CLEAN_WIN;
    const ifr = document.createElement('iframe');
    ifr.setAttribute('data-fjpit-helper', '1');
    ifr.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
    (document.body || document.documentElement).appendChild(ifr);
    FJPIT_CLEAN_WIN = ifr.contentWindow;
    return FJPIT_CLEAN_WIN;
}

function fjpitCleanFetch() {
    if (FJPIT_CLEAN_FETCH) return FJPIT_CLEAN_FETCH;
    try {
        const w = fjpitCleanWindow();
        const f = w && w.fetch;
        if (typeof f === 'function') {
            FJPIT_CLEAN_FETCH = f.bind(w);
            return FJPIT_CLEAN_FETCH;
        }
    } catch (e) {}
    try {
        const g = (typeof window !== 'undefined' && window.fetch) || (typeof fetch !== 'undefined' && fetch);
        if (typeof g === 'function') FJPIT_CLEAN_FETCH = g.bind(window || null);
    } catch (e) {}
    if (!FJPIT_CLEAN_FETCH) {
        FJPIT_CLEAN_FETCH = function () { return Promise.reject(new Error('当前环境没有可用的 fetch')); };
    }
    return FJPIT_CLEAN_FETCH;
}

function fjpitFetch(url, init) {
    return fjpitCleanFetch()(url, init);
}

function fjpitRepairPageNetwork() {
    const report = { fetch: false, xhr: false };

    try {
        const clean = fjpitCleanFetch();
        if (typeof clean === 'function' && clean !== window.fetch) {
            window.fetch = clean;
            report.fetch = true;
        }
    } catch (e) { console.warn('JS: 替换 fetch 失败', e); }

    try {
        const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (proto && !proto.__fjpitHeaderHooked) {
            const prev = proto.setRequestHeader;
            proto.setRequestHeader = function (header, value) {
                try {
                    if (header && String(header).toLowerCase() === FJPIT_ID_HEADER) return;
                } catch (e) {}
                return prev.apply(this, arguments);
            };
            proto.__fjpitHeaderHooked = true;
            report.xhr = true;
        }
    } catch (e) { console.warn('JS: hook XHR 失败', e); }

    return report;
}

// ============================================================
// 二、页面可用性修复 + 控制条
// ============================================================

function fjpitReadScale() {
    try {
        if (window.visualViewport && window.visualViewport.scale) return window.visualViewport.scale;
    } catch (e) {}
    return 1;
}

function fjpitSetViewportMeta(content) {
    const doc = document;
    const list = doc.querySelectorAll('meta[name="viewport"]');
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].parentNode) list[i].parentNode.removeChild(list[i]);
    }
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', content);
    (doc.head || doc.documentElement).appendChild(meta);
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    return meta;
}

async function fjpitUnlockViewport() {
    const info = { before: fjpitReadScale(), after: 1, mode: 'none', zoom: 1 };
    if (info.before >= 0.85) return info;

    fjpitSetViewportMeta(
        'width=device-width, initial-scale=1.0, minimum-scale=0.25, maximum-scale=5.0, user-scalable=yes'
    );
    await fjpitDelay(280);
    info.after = fjpitReadScale();
    if (info.after >= 0.85) { info.mode = 'meta'; return info; }

    info.mode = 'zoom';
    info.zoom = Math.max(1, Math.min(4, 1 / Math.max(0.05, info.after)));
    return info;
}

/**
 * 页面上的引导 UI。两种形态：
 *   · 中央引导卡片 —— 只在「还没登录」时出现，明确告诉用户「现在该登录了」
 *   · 底部状态条   —— 常驻，显示当前进度
 *
 * 为什么要卡片：App 里只有一个「执行导入」按钮，而由于教务 WAF 的限制，
 * 必须先运行本脚本才能正常登录 —— 顺序反直觉，靠 toast 容易被忽略。
 *
 * 尺寸处理：电脑模式下 webView 会把浏览器缩放锁到约 0.3 倍，
 * 所以 root 的宽高要除以 zoom；定位只用 0 / 百分比（不受 zoom 影响）。
 */
/**
 * 底部状态条（常驻）。
 * 登录引导走 App 原生弹窗（shiguangBridgePromise.showAlert），
 * 比页面内的小提示醒目得多。
 *
 * 尺寸处理：电脑模式下 WebView 会把缩放锁到约 0.3 倍，
 * 所以 root 的宽高要除以 zoom；定位只用 0（不受 zoom 影响）。
 */
function fjpitBuildControlBar(initialZoom) {
    const root = document.createElement('div');
    root.setAttribute('data-fjpit-ui', '1');
    root.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'pointer-events:none', 'box-sizing:border-box',
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif'
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = [
        'pointer-events:auto', 'width:100%', 'box-sizing:border-box',
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:10px 12px',
        'background:rgba(17,20,26,.94)', 'color:#fff',
        'font-size:13px', 'box-shadow:0 -2px 10px rgba(0,0,0,.3)'
    ].join(';');

    const status = document.createElement('span');
    status.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    status.textContent = '准备中…';

    function makeBtn(text, title) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (title) b.title = title;
        b.style.cssText = [
            'flex:0 0 auto', 'min-width:34px', 'height:26px', 'padding:0 8px',
            'border:1px solid rgba(255,255,255,.28)', 'border-radius:6px',
            'background:rgba(255,255,255,.10)', 'color:#fff',
            'font:12px/1 inherit', 'cursor:pointer'
        ].join(';');
        return b;
    }

    const zoomLabel = document.createElement('span');
    zoomLabel.style.cssText = 'flex:0 0 auto;opacity:.8;font-size:11px';

    const btnOut = makeBtn('A−', '缩小');
    const btnIn = makeBtn('A＋', '放大');
    const btnReset = makeBtn('1:1', '复位');

    const zoomBox = document.createElement('span');
    zoomBox.style.cssText = 'flex:0 0 auto;display:none;align-items:center;gap:6px';
    [btnOut, zoomLabel, btnIn, btnReset].forEach(function (el) { zoomBox.appendChild(el); });

    bar.appendChild(status);
    bar.appendChild(zoomBox);
    root.appendChild(bar);
    (document.head || document.documentElement).appendChild(root);

    let zoom = initialZoom || 1;

    function syncSize() {
        const w = Math.round((window.innerWidth || 360) / zoom);
        root.style.width = w + 'px';
    }

    function applyZoom(z) {
        zoom = Math.max(0.3, Math.min(4, z));
        try {
            if (Math.abs(zoom - 1) < 0.001) document.documentElement.style.removeProperty('zoom');
            else document.documentElement.style.zoom = String(zoom);
        } catch (e) {}
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
        syncSize();
    }

    // 只有在「确实做了缩放补偿」时才露出缩放按钮，平时不干扰
    if (Math.abs((initialZoom || 1) - 1) > 0.01) zoomBox.style.display = 'flex';

    applyZoom(zoom);
    window.addEventListener('resize', syncSize);

    btnOut.addEventListener('click', function () { applyZoom(zoom / 1.15); });
    btnIn.addEventListener('click', function () { applyZoom(zoom * 1.15); });
    btnReset.addEventListener('click', function () { applyZoom(initialZoom || 1); });

    setTimeout(function () {
        try {
            const de = document.documentElement;
            const visW = (window.visualViewport && window.visualViewport.width) || de.clientWidth;
            if (de.scrollWidth > visW + 4) window.scrollTo(Math.max(0, (de.scrollWidth - visW) / 2), 0);
        } catch (e) {}
    }, 350);

    return {
        /**
         * 弹原生弹窗告诉用户「现在该登录了」。
         * 返回 Promise：用户点掉弹窗后 resolve，随后进入等待登录。
         */
        needLogin: function () {
            status.textContent = '等待登录…';
            let p = null;
            try {
                p = window.shiguangBridgePromise.showAlert(
                    '第 1 步：登录教务',
                    '福信教务的防火墙会拦下未加工过的登录请求，'
                    + '所以需要你先点一下本工具，把请求通道理通。\n\n'
                    + '点「去登录」关闭本提示后，请在页面中登录你的教务账号；'
                    + '登录成功会自动开始导入课表，不需要再点任何按钮。\n\n'
                    + '※ 只有首次使用或登录过期时才需要这一步，'
                    + '之后直接点「执行导入」即可。',
                    '去登录'
                );
            } catch (e) {
                console.warn('JS: 弹窗失败', e);
            }
            return p || Promise.resolve(true);
        },
        /** 只更新底部文字（等待登录期间用） */
        setWaiting: function (t) { status.textContent = t; },
        /** 更新底部状态 */
        setStatus: function (t) { status.textContent = t; },
        destroy: function () {
            try { if (root.parentNode) root.parentNode.removeChild(root); } catch (e) {}
            try { document.documentElement.style.removeProperty('zoom'); } catch (e) {}
        }
    };
}

// ============================================================
// 三、鉴权
// ============================================================

function fjpitGetAccessToken() {
    const root = document.querySelector('#app') || document.body.firstElementChild;
    const app = root && root.__vue_app__;
    if (!app) return null;
    const gp = app.config && app.config.globalProperties;
    const pinia = gp && gp.$pinia;
    if (!pinia || !(pinia._s instanceof Map)) return null;
    let fallback = null;
    for (const entry of pinia._s) {
        const store = entry[1];
        if (store && typeof store === 'object' && typeof store.accessToken === 'string' && store.accessToken) {
            if (String(entry[0]).indexOf('access') >= 0) return store.accessToken;
            if (!fallback) fallback = store.accessToken;
        }
    }
    return fallback;
}

/** 通道 A（结构化 API）用的头 —— 与移动端 m.fjpit.com 一致 */
function fjpitApiHeaders(token) {
    const h = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'server': '1',
        'unique-request-id': fjpitUuid(),
        'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    if (token) h['ba-token'] = token;
    return h;
}

// ============================================================
// 四、取数（结构化 API）
// ============================================================

async function fjpitApiGet(path, token) {
    const resp = await fjpitFetch(FJPIT_API + path, {
        method: 'GET', headers: fjpitApiHeaders(token), credentials: 'omit', mode: 'cors'
    });
    if (!resp.ok) throw new Error(path + ' HTTP ' + resp.status);
    const json = await resp.json();
    if (json.code !== 1) throw new Error(path + ' code=' + json.code + ' ' + (json.msg || ''));
    return json.data;
}

async function fjpitApiPost(path, body, token) {
    const resp = await fjpitFetch(FJPIT_API + path, {
        method: 'POST', headers: fjpitApiHeaders(token), credentials: 'omit', mode: 'cors',
        body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(path + ' HTTP ' + resp.status);
    const json = await resp.json();
    if (json.code !== 1) throw new Error(path + ' code=' + json.code + ' ' + (json.msg || ''));
    return json.data;
}

/**
 * 走结构化 API 取全部数据。
 * 任一步失败直接抛错，由调用方回退 HTML 通道。
 * 返回 { entries, timeSlots, semesterStartDate, totalWeeks, meta }
 */
async function fjpitCollectData(token, bar) {
    // 1) 学期列表
    bar.setStatus('读取学期列表…');
    const semData = await fjpitApiGet('/semesters', token);
    const semList = (semData && semData.semesters) || [];
    if (!semList.length) throw new Error('/semesters 无学期数据');
    let cur = null;
    for (let i = 0; i < semList.length; i++) if (semList[i] && semList[i].isCurrent) { cur = semList[i]; break; }
    if (!cur) cur = semList[0];
    const semester = cur.value;
    const showXxq = (cur.isCurrent && cur.isXxq) ? 1 : 0;
    console.log('JS[A]: 学期 ' + semester + '，showxxq=' + showXxq);

    // 2) 学期配置（开学日期 + 总周数）
    bar.setStatus('读取学期配置…');
    const cfgData = await fjpitApiPost('/semesterConfig', { semester: semester }, token);
    const sc = (cfgData && cfgData.semestersConfig) || cfgData || {};
    const totalWeeks = Number(sc.totalWeeks) || 0;
    const startDate = fjpitAlignToMonday(sc.startDate);   // 教务给的不一定是周一
    if (!(totalWeeks >= 1)) throw new Error('/semesterConfig 未返回有效 totalWeeks');
    console.log('JS[A]: 开学 ' + startDate + '，共 ' + totalWeeks + ' 周');

    // 3) 作息时间
    bar.setStatus('读取作息时间…');
    let timeSlots = [];
    try {
        const stData = await fjpitApiPost('/scheduleTime', { dqz: 1 }, token);
        const arr = Array.isArray(stData) ? stData : Object.values(stData || {});
        timeSlots = arr.map(function (e) {
            const num = Number(e && e.jcdm);
            const st = String((e && e.jcskkssj) || '').slice(0, 5);
            const et = String((e && e.jcskjssj) || '').slice(0, 5);
            return { number: num, startTime: st, endTime: et };
        }).filter(function (t) {
            return t.number >= 1 && /^\d{1,2}:\d{2}$/.test(t.startTime) && /^\d{1,2}:\d{2}$/.test(t.endTime);
        }).sort(function (a, b) { return a.number - b.number; });
    } catch (e) {
        console.warn('JS[A]: 作息读取失败（不影响课表）: ' + e.message);
    }

    // 4) 逐周课表
    const entries = [];
    for (let w = 1; w <= totalWeeks; w++) {
        bar.setStatus('抓取第 ' + w + '/' + totalWeeks + ' 周…');
        const d = await fjpitApiPost('/schedule',
            { semester: semester, week: w, showxxq: showXxq }, token);
        const list = (d && d.list) || [];
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (!r) continue;
            const name = String(r.course == null ? '' : r.course).trim();
            const day = Number(r.DayIndex);
            const start = Number(r.startNode);
            const end = Number(r.endNode);
            if (!name || !(day >= 1 && day <= 7) || !(start >= 1) || !(end >= start)) continue;
            entries.push({
                week: w, day: day, date: '',
                start: start, end: end,
                name: name,
                teacher: r.teacherName == null ? '' : String(r.teacherName).trim(),
                room: r.spaceName == null ? '' : String(r.spaceName).trim()
            });
        }
    }

    return {
        entries: entries, timeSlots: timeSlots,
        semesterStartDate: startDate, totalWeeks: totalWeeks,
        meta: { semester: semester }
    };
}

// ============================================================
// 五、聚合（教师/教室原样透传）
// ============================================================

function fjpitAggregate(entries) {
    const SEP = '\u0001';
    const map = new Map();
    entries.forEach(function (e) {
        const key = [e.name, e.teacher, e.room, e.day, e.start, e.end].join(SEP);
        if (!map.has(key)) {
            map.set(key, {
                name: e.name,
                teacher: e.teacher,      // 可能为空字符串，原样保留
                position: e.room,        // 可能为空字符串，原样保留
                day: e.day,
                startSection: e.start,
                endSection: e.end,
                weeks: []
            });
        }
        const course = map.get(key);
        if (course.weeks.indexOf(e.week) < 0) course.weeks.push(e.week);
    });
    const list = Array.from(map.values());
    list.forEach(function (c) { c.weeks.sort(function (a, b) { return a - b; }); });
    list.sort(function (a, b) {
        return a.day - b.day || a.startSection - b.startSection || a.name.localeCompare(b.name);
    });
    return list;
}

// ============================================================
// 六、保存
// ============================================================

async function fjpitSaveCourses(courses) {
    await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses, null, 2));
}

async function fjpitSaveTimeSlots(timeSlots) {
    if (!timeSlots.length) return false;
    timeSlots.sort(function (a, b) { return a.number - b.number; });
    for (let i = 0; i < timeSlots.length; i++) {
        if (timeSlots[i].number !== i + 1) return false;
    }
    await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(timeSlots));
    return true;
}

async function fjpitSaveConfig(semesterStartDate, totalWeeks) {
    const config = { semesterTotalWeeks: totalWeeks };
    if (semesterStartDate) config.semesterStartDate = semesterStartDate;
    await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify(config));
}

// ============================================================
// 七、等待登录
// ============================================================

async function fjpitWaitForLogin(bar, deadlineTs) {
    const bodyRef = document.body;
    let lastTip = 0;
    while (Date.now() < deadlineTs) {
        if (document.body !== bodyRef) return null;      // 页面已整页重载
        const token = fjpitGetAccessToken();
        if (token) return token;
        const left = Math.ceil((deadlineTs - Date.now()) / 1000);
        if (Date.now() - lastTip > 900) {
            lastTip = Date.now();
            bar.setWaiting('等待登录（' + left + 's）… 登录后会自动继续');
        }
        await fjpitDelay(700);
    }
    return null;
}

// ============================================================
// 八、体检模式（诊断）
// ============================================================
// 目的：判定「昨天能用、今天失效」到底断在哪一层。
//
// 探测刻意分成「修复前 / 修复后」两组：
//   A 组 —— 用 App 补丁污染过的 window.fetch（尚未修复）
//           A1 字符串 body（补丁会加 X-WebView-Post-Id）→ 预期被 WAF 拒
//           A2 Blob body（补丁取不到 bodyStr，加不上该头）→ 预期通过
//           A3 GET（补丁不改 GET）→ 预期通过
//   B 组 —— 执行修复后再测（window.fetch 已换成子 frame 原生实现）
//           B1 主 frame 走替换后的 fetch
//           B2 子 frame 原生 fetch
//           B3 子 frame 原生 XHR
//   C 组 —— 四个取数接口逐项
//   D/E 组 —— 旧接口与旧头组合对照
//
// 判定逻辑：
//   A1 挂 + A2/B* 通   ⇒ 老机制仍成立，失效点在别处（登录态 / 后端 / 保存）
//   A1 挂 + A2 也挂    ⇒ WAF 拦截面扩大，不再只看那个头
//   B* 全挂            ⇒ 干净通道被封，修复方案需重做
//   返回 303           ⇒ 接口层正常，纯粹是未登录
//   返回 code=1        ⇒ 接口正常，问题在后续环节
// ============================================================

const FJPIT_SEMESTER_FALLBACK = '2026-2027-1';

function fjpitBodyText(t) {
    return String(t == null ? '' : t).replace(/\s+/g, ' ').slice(0, 200);
}

function fjpitDiagPad(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
}

function fjpitDiagLine(it) {
    return fjpitDiagPad(it.name, 32) + fjpitDiagPad(it.ok ? 'OK' : 'FAIL', 6)
        + fjpitDiagPad(it.status, 6) + fjpitDiagPad(it.ms + 'ms', 8)
        + (it.body ? it.body : (it.err || ''));
}

/** 弹窗里用的短名（手机弹窗一行放不下长名字） */
function fjpitDiagShort(name) {
    let s = String(name);
    s = s.replace('主frame ', '主f ').replace('子frame ', '子f ')
         .replace('主frame(', '主f(')
         .replace('POST 字符串body', 'P-str')
         .replace('POST Blob body', 'P-blob')
         .replace('POST 字符串', 'P-str')
         .replace('干净 fetch POST', 'cleanP')
         .replace('干净 XHR POST', 'cleanX')
         .replace('（仅原型hook）', '(hook)')
         .replace('（仅原型hook丢头）', '(hook)')
         .replace('原生 XHR 类', 'XHR')
         .replace('(已替换)', '→clean')
         .replace(/^\w\d\s/, '');
    if (s.length > 18) s = s.slice(0, 18);
    return s;
}

/** 弹窗里用的紧凑行：不带 body（body 另列），只留状态与耗时 */
function fjpitDiagLineShort(it) {
    return fjpitDiagPad(fjpitDiagShort(it.name), 20)
        + fjpitDiagPad(it.ok ? 'OK' : 'FAIL', 6)
        + fjpitDiagPad(it.status, 6)
        + (it.ms + 'ms');
}

/** 把行数组按每段 n 行切开 */
function fjpitDiagChunks(lines, n) {
    const out = [];
    for (let i = 0; i < lines.length; i += n) out.push(lines.slice(i, i + n));
    return out;
}

async function fjpitDiagSend(fetcher, path, opts) {
    const o = opts || {};
    const url = /^https?:/.test(path) ? path : (FJPIT_API + path);
    const init = {
        method: o.method || 'GET',
        headers: o.headers || { 'Content-Type': 'application/json;charset=UTF-8' },
        credentials: 'omit',
        mode: 'cors'
    };
    if (o.body !== undefined) init.body = o.body;
    const t0 = Date.now();
    try {
        const resp = await fetcher(url, init);
        let text = '';
        try { text = await resp.text(); } catch (e) {}
        return { status: String(resp.status), ok: !!resp.ok, ms: Date.now() - t0, body: fjpitBodyText(text) };
    } catch (e) {
        return {
            status: 'ERR', ok: false, ms: Date.now() - t0, body: '',
            err: ((e && e.name) ? e.name + ': ' : '') + ((e && e.message) || String(e))
        };
    }
}

function fjpitDiagXhr(XHRClass, url, headers, body) {
    return new Promise(function (resolve) {
        const t0 = Date.now();
        try {
            const x = new XHRClass();
            x.open('POST', url, true);
            const hs = headers || { 'Content-Type': 'application/json;charset=UTF-8', 'server': '1' };
            for (const k in hs) {
                if (Object.prototype.hasOwnProperty.call(hs, k)) x.setRequestHeader(k, hs[k]);
            }
            x.onload = function () {
                resolve({
                    status: String(x.status), ok: x.status >= 200 && x.status < 300,
                    ms: Date.now() - t0, body: fjpitBodyText(x.responseText)
                });
            };
            x.onerror = function () {
                resolve({ status: 'ERR', ok: false, ms: Date.now() - t0, body: '', err: 'XHR 网络错误（onerror）' });
            };
            x.send(body);
        } catch (e) {
            resolve({ status: 'ERR', ok: false, ms: Date.now() - t0, body: '', err: (e && e.message) || String(e) });
        }
    });
}

async function runDiagFlow() {
    const D = { items: [], env: {}, verdict: [], t0: Date.now() };

    function add(name, r) {
        const it = {
            name: name, ok: !!r.ok, status: r.status || '-',
            ms: r.ms || 0, body: r.body || '', err: r.err || ''
        };
        D.items.push(it);
        console.log('[FJPIT-DIAG] ' + fjpitDiagLine(it));
        return it;
    }

    async function probe(name, fn) {
        const t0 = Date.now();
        let r;
        try { r = await fn(); } catch (e) {
            r = {
                status: 'ERR', ok: false, ms: Date.now() - t0, body: '',
                err: ((e && e.name) ? e.name + ': ' : '') + ((e && e.message) || String(e))
            };
        }
        return add(name, r);
    }

    // ---------- 0. 环境 ----------
    let token = null;
    try { token = fjpitGetAccessToken(); } catch (e) {}
    D.env.ua = navigator.userAgent;
    D.env.url = location.href;
    D.env.host = location.host;
    D.env.token = token
        ? (String(token).slice(0, 8) + '…' + String(token).slice(-4) + ' (len ' + String(token).length + ')')
        : '(未取到)';

    console.log('[FJPIT-DIAG] ========== 体检开始 ==========');
    console.log('[FJPIT-DIAG] UA: ' + D.env.ua);
    console.log('[FJPIT-DIAG] URL: ' + D.env.url);
    console.log('[FJPIT-DIAG] token: ' + D.env.token);

    // 页面浮层（可滚动）
    const layer = document.createElement('div');
    layer.setAttribute('data-fjpit-diag', '1');
    layer.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'background:#fff', 'color:#111', 'overflow:auto', '-webkit-overflow-scrolling:touch',
        'font:12px/1.55 SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace',
        'padding:12px', 'box-sizing:border-box', 'white-space:pre-wrap', 'word-break:break-all'
    ].join(';');

    function paint(txt) {
        try {
            if (!layer.parentNode) (document.head || document.documentElement).appendChild(layer);
            layer.textContent = txt;
        } catch (e) {}
    }
    paint('体检中…\n\n' + D.env.ua + '\n' + D.env.url);

    // ---------- 先保存主 frame 的原始 fetch，但【延迟到最后一组才使用】 ----------
    // A 组是故意发「会被 WAF 拒」的请求（这正是它的目的）。
    // 若放在最前面执行，很可能触发教务风控、连带拦掉后面正常的请求，
    // 从而把「风控连带」误判成「接口不可达」。所以挪到最后。
    let mainFetchRaw = null;
    try { mainFetchRaw = window.fetch.bind(window); } catch (e) {}

    // ---------- 执行修复 ----------
    const repair = fjpitRepairPageNetwork();
    D.env.repair = repair;
    console.log('[FJPIT-DIAG] 页面网络修复: ' + JSON.stringify(repair));

    // ---------- B. 修复后 ----------
    const clean = fjpitCleanFetch();
    const apiHeaders = fjpitApiHeaders(token);

    await probe('B1 主frame(已替换) POST 字符串', function () {
        return fjpitDiagSend(window.fetch.bind(window), '/scheduleTime',
            { method: 'POST', headers: apiHeaders, body: JSON.stringify({ dqz: 1 }) });
    });
    await probe('B2 子frame 干净 fetch POST', function () {
        return fjpitDiagSend(clean, '/scheduleTime',
            { method: 'POST', headers: apiHeaders, body: JSON.stringify({ dqz: 1 }) });
    });
    await probe('B3 主frame XHR（仅原型hook）', function () {
        return fjpitDiagXhr(window.XMLHttpRequest, FJPIT_API + '/scheduleTime', apiHeaders,
            JSON.stringify({ dqz: 1 }));
    });
    await probe('B4 子frame 原生 XHR 类', function () {
        let XC = null;
        try { XC = fjpitCleanWindow().XMLHttpRequest; } catch (e) {}
        if (!XC) return { status: 'ERR', ok: false, body: '', err: '拿不到子 frame 的 XMLHttpRequest' };
        return fjpitDiagXhr(XC, FJPIT_API + '/scheduleTime', apiHeaders, JSON.stringify({ dqz: 1 }));
    });

    // ---------- C. 取数接口逐项 ----------
    let semester = FJPIT_SEMESTER_FALLBACK;
    const rSem = await probe('C1 GET /semesters', function () {
        return fjpitDiagSend(clean, '/semesters', { headers: apiHeaders });
    });
    try {
        const j = JSON.parse(rSem.body);
        const list = (j && j.data && j.data.semesters) || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i] && list[i].isCurrent) semester = list[i].value || semester;
        }
        D.env.semester = semester;
        D.env.semesterCount = list.length;
    } catch (e) {}

    await probe('C2 POST /semesterConfig', function () {
        return fjpitDiagSend(clean, '/semesterConfig',
            { method: 'POST', headers: apiHeaders, body: JSON.stringify({ semester: semester }) });
    });
    await probe('C3 POST /scheduleTime', function () {
        return fjpitDiagSend(clean, '/scheduleTime',
            { method: 'POST', headers: apiHeaders, body: JSON.stringify({ dqz: 1 }) });
    });
    await probe('C4 POST /schedule (week1)', function () {
        return fjpitDiagSend(clean, '/schedule',
            {
                method: 'POST', headers: apiHeaders,
                body: JSON.stringify({ semester: semester, week: 1, showxxq: 0 })
            });
    });
    await probe('C5 GET /sectionConfig', function () {
        return fjpitDiagSend(clean, '/sectionConfig', { headers: apiHeaders });
    });

    // ---------- D. 旧接口对照 ----------
    await probe('D1 GET /student/week (旧)', function () {
        return fjpitDiagSend(clean, '/student/week', { headers: apiHeaders });
    });
    await probe('D2 POST /student/scheduleTable (旧)', function () {
        return fjpitDiagSend(clean, '/student/scheduleTable',
            { method: 'POST', headers: apiHeaders, body: JSON.stringify({ dqz: 1 }) });
    });

    // ---------- E. 旧头组合对照 ----------
    await probe('E1 POST /schedule + is-main 头', function () {
        const h = fjpitApiHeaders(token);
        h['is-main'] = 'true';
        delete h['server'];
        return fjpitDiagSend(clean, '/schedule',
            {
                method: 'POST', headers: h,
                body: JSON.stringify({ semester: semester, week: 1, showxxq: 0 })
            });
    });
    await probe('E2 POST /schedule 无任何自定义头', function () {
        return fjpitDiagSend(clean, '/schedule',
            {
                method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                body: JSON.stringify({ semester: semester, week: 1, showxxq: 0 })
            });
    });

    // ---------- A（最后执行）：主 frame 原始 fetch 的对照 ----------
    // 与 B1/B2 的唯一区别就是「用了哪个 fetch」，且都带同样的 token，
    // 因此可直接判定 App 补丁的影响面。
    if (mainFetchRaw) {
        await probe('A1 主frame POST 字符串body', function () {
            return fjpitDiagSend(mainFetchRaw, '/scheduleTime',
                { method: 'POST', headers: apiHeaders, body: JSON.stringify({ dqz: 1 }) });
        });
        await probe('A2 主frame POST Blob body', function () {
            return fjpitDiagSend(mainFetchRaw, '/scheduleTime',
                {
                    method: 'POST', headers: apiHeaders,
                    body: new Blob([JSON.stringify({ dqz: 1 })], { type: 'application/json' })
                });
        });
        await probe('A3 主frame GET /semesters', function () {
            return fjpitDiagSend(mainFetchRaw, '/semesters', { headers: apiHeaders });
        });
    } else {
        add('A0 取 window.fetch', { status: 'ERR', ok: false, err: '拿不到 window.fetch' });
    }

    // ---------- 判定 ----------
    const get = function (n) {
        for (let i = 0; i < D.items.length; i++) {
            if (D.items[i].name.indexOf(n) === 0) return D.items[i];
        }
        return null;
    };
    const a1 = get('A1'), a2 = get('A2'), b2 = get('B2'), b3 = get('B3'), b4 = get('B4');
    const cList = [get('C1'), get('C2'), get('C3'), get('C4')];
    const v = [];

    if (!token) {
        v.push('★ 未取到 token（未登录或登录已过期）');
        v.push('  若各接口返回 303「请先登录」，说明接口层完好，先登录再看');
    }

    if (a1 && a2) {
        if (!a1.ok && a2.ok) {
            v.push('★ A2 通 / A1 挂 → 老机制仍成立');
            v.push('  X-WebView-Post-Id 依旧是 WAF 触发点，干净通道有效');
        } else if (!a2.ok) {
            v.push('★★ A2（不含 id 头的 Blob POST）也挂');
            v.push('  ⇒ WAF 拦截面已扩大，不再只看那个头');
        } else {
            v.push('★ A1/A2 都通 → 当前模式下主 frame POST 未被拦');
        }
    }

    if (b2 && b4) {
        if (b2.ok && b4.ok) {
            v.push('★ 干净通道正常：子 frame fetch 通 / 子 frame XHR 通 ✓');
        } else if (!b2.ok && !b4.ok) {
            v.push('★★ 干净通道也失效 → 修复方案需重做');
        } else {
            v.push('★ 干净通道部分失效：子 frame fetch ' + (b2.ok ? '通' : '挂')
                + ' / 子 frame XHR ' + (b4.ok ? '通' : '挂'));
        }
    }

    if (b3) {
        if (b3.ok) {
            v.push('★ 主 frame XHR（仅靠原型 hook 丢头）可通');
        } else {
            v.push('★★ 主 frame XHR 仍被拦（仅靠 setRequestHeader 原型 hook 无效）');
            v.push('  ⇒ App 的 XHR 补丁绕过了原型 hook（多半在 send 内部用了原始引用）');
            v.push('  ⇒ 页面登录走 axios→XHR，因此会失败；需整体替换 window.XMLHttpRequest');
        }
    }

    const okC = cList.filter(function (x) { return x && x.ok; });
    const loginC = cList.filter(function (x) {
        return x && (x.body.indexOf('请先登录') >= 0 || x.body.indexOf(':303') >= 0);
    });

    if (okC.length === 4) {
        v.push('★ 四个取数接口全部可达 ✓ → 数据链路没问题');
        v.push(loginC.length
            ? '  但返回「请先登录」→ 仅是登录态问题，重新登录即可'
            : '  且已返回正常数据 → 问题应在保存/聚合环节');
    } else if (okC.length === 0) {
        v.push('★★ 四个取数接口全部不可达 → 服务端或网络层有变化');
    } else {
        v.push('★ 取数接口部分可达（' + okC.length + '/4），看明细逐项状态');
    }

    v.push('');
    v.push('注：A 组是故意发「会被 WAF 拒」的请求（这就是它的用途），');
    v.push('    故安排在最后执行，以免其风控连带影响前面的正常请求。');

    D.verdict = v;
    for (let i = 0; i < v.length; i++) console.log('[FJPIT-DIAG] ' + v[i]);

    // ---------- 输出 ----------
    const out = [];
    out.push('=== 结论 ===');
    v.forEach(function (x) { out.push(x); });
    out.push('');
    out.push('=== 环境 ===');
    out.push('host : ' + D.env.host);
    out.push('token: ' + D.env.token);
    out.push('学期 : ' + (D.env.semester || '(未取到，用兜底 ' + FJPIT_SEMESTER_FALLBACK + ')'));
    out.push('修复 : ' + JSON.stringify(repair));
    out.push('UA   : ' + D.env.ua);
    out.push('');
    out.push('=== 明细 ===');
    D.items.forEach(function (it) { out.push(fjpitDiagLine(it)); });
    out.push('');
    out.push('=== 接口返回原文（截断 200 字）===');
    D.items.forEach(function (it) {
        if (it.body) out.push('· ' + it.name + ' → ' + it.body);
    });
    out.push('');
    out.push('耗时合计 ' + (Math.round((Date.now() - D.t0) / 100) / 10) + 's');
    out.push('（点本浮层空白处可关闭）');

    paint(out.join('\n'));
    layer.addEventListener('click', function () {
        try { layer.parentNode.removeChild(layer); } catch (e) {}
    });

    // ---------- 弹窗（分批） ----------
    // App 的弹窗内容【不能滚动】，所以按每段 14 行分批弹，确保信息能送达。
    const flow = [];
    v.forEach(function (l) { flow.push(l); });
    flow.push('');
    flow.push('=== 明细 ===');
    D.items.forEach(function (it) { flow.push(fjpitDiagLineShort(it)); });

    const keyReturns = D.items.filter(function (it) {
        if (it.err) return true;
        const n = it.name.charAt(0);
        return (n === 'B' || n === 'C' || n === 'E') && !!it.body;
    }).map(function (it) {
        return '· ' + fjpitDiagShort(it.name) + ' → '
            + (it.body ? it.body.slice(0, 88) : (it.err || '(无)'));
    });

    if (keyReturns.length) {
        flow.push('');
        flow.push('=== 返回原文（截 88 字）===');
        keyReturns.forEach(function (l) { flow.push(l); });
    }

    const chunks = fjpitDiagChunks(flow, 14);
    for (let i = 0; i < chunks.length; i++) {
        const isLast = (i === chunks.length - 1);
        try {
            await window.shiguangBridgePromise.showAlert(
                '体检结果 ' + (i + 1) + '/' + chunks.length,
                chunks[i].join('\n'),
                isLast ? '完成' : '下一段');
        } catch (e) {
            console.warn('JS: 体检弹窗失败', e);
            break;
        }
    }
}

runDiagFlow().catch(function (e) {
    console.error('JS: 体检异常', e);
    try { window.shiguangBridge.showToast('体检异常: ' + (e && e.message)); } catch (x) {}
});
