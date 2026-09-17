// ============================================================
// 福建信息职业技术学院 · 福信智慧教务 → 拾光课程表 适配脚本
// ============================================================
// 教务前端: https://jw.fjpit.com   (Vue3 + Vben Admin 5.5.6, 超星系)
// 教务接口: https://jw-api.fjpit.com/api
// 鉴权    : 请求头 ba-token + is-main（无 Cookie 依赖）
//
// 数据规则（与手工抓取手册一致）：
//   1. 逐周抓 1~N 周生成数据，不用 {"type":"xqkb"} 学期计划视图
//      —— 课程不是固定死的（军训不整周、调课、节假日、周末补课）
//   2. HTML 表格必须做 rowspan/colspan 网格重建后，再按列归属星期
//   3. title='课程\n教师\n教室' 要同时兼容真实换行与字面 \n
//   4. 「中午1/中午2」这类非节次行用「第N节」匹配不到就跳过
//   5. 教师/教室原样透传：教务给空就是空，不做任何回填或替换
//
// ★ 运行环境适配（针对 App 内置 WebView 实测结论）
//   A. 页面可用性修复
//      「电脑模式」下 App 会把 viewport 强制成 width=1280
//      （WebCompatDelegate.injectDesktopViewportFix），手机屏上整页被缩到
//      约 0.3 倍，登录框小到无法操作，且双指缩放不响应。
//       → 脚本注入后立即解锁 viewport；若解锁无效则用 CSS zoom 反向补偿，
//         并提供控制条让用户手动微调。
//   B. 为什么必须用电脑模式
//      实测该 WebView 中：GET 正常、POST 全部 Failed to fetch（37~118ms），
//      连「不存在的路径」「免鉴权端点」「不带任何自定义头」的 POST 都挂，
//      而第三方域名 POST 正常 → 是教务侧针对 WebView 客户端拦截 POST。
//      App 侧 WebViewRequestInterceptor.intercept() 第一行即
//        if (!rawUrl.startsWith("http") || !isDesktopMode) return null
//      手机模式下直接放行给 WebView 原生网络栈（带 wv UA + WebView 指纹），
//      电脑模式下才把带 X-WebView-Post-Id 的请求改由 App 进程的 Ktor 发出，
//      并剥离 X-Requested-With / X-WebView-Post-Id 两个指纹头。
//      → 所以本脚本在电脑模式下运行时，自己的 fetch POST 同样会被 Ktor 接管。
//   C. 等待登录
//      不再要求「必须先登录」，未登录时先解锁页面 + 探测通道，
//      然后等待用户完成登录并自动继续（页面若整页重载则脚本终止，
//      此时重新点一次「执行导入」即可）。
// ============================================================

const FJPIT_API = 'https://jw-api.fjpit.com/api';
const FJPIT_HOST_KEY = 'fjpit.com';

const FJPIT_LOGIN_WAIT_MS = 5 * 60 * 1000;   // 等待登录的最长时间

// ---------- 通用工具 ----------

function fjpitDelay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

function fjpitUuid() {
    try { return crypto.randomUUID(); } catch (e) { return 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2); }
}

function fjpitStripTags(s) {
    return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ');
}

function fjpitNormText(s) {
    return fjpitStripTags(s).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function fjpitAttrInt(attrs, name) {
    const m = new RegExp(name + '\\s*=\\s*"?\\d+"?', 'i').exec(attrs || '');
    if (!m) return 1;
    const n = /(\d+)/.exec(m[0]);
    return n ? parseInt(n[1], 10) : 1;
}

function fjpitSafeToast(msg) {
    try { window.shiguangBridge.showToast(msg); } catch (e) { console.log('JS[toast]: ' + msg); }
}

// ============================================================
// 一、页面可用性修复 + 控制条
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

/**
 * 解除 App 电脑模式下的 viewport 锁定。
 * 返回值 { before, after, mode, zoom }
 *   mode = 'none'  本来就没被缩（手机模式），无需处理
 *   mode = 'meta'  viewport meta 修改已生效，页面按设备宽度重排
 *   mode = 'zoom'  meta 修改没生效，改用 CSS zoom 反向补偿
 */
async function fjpitUnlockViewport() {
    const info = { before: fjpitReadScale(), after: 1, mode: 'none', zoom: 1 };

    // 本来就正常（缩放接近 1），不做任何改动
    if (info.before >= 0.85) return info;

    // 1. 替换 viewport meta
    fjpitSetViewportMeta(
        'width=device-width, initial-scale=1.0, minimum-scale=0.25, maximum-scale=5.0, user-scalable=yes'
    );
    await fjpitDelay(280);
    info.after = fjpitReadScale();

    if (info.after >= 0.85) {
        info.mode = 'meta';
        return info;
    }

    // 2. meta 没生效 → 用 CSS zoom 把内容放大回去
    //    页面被 WebView 整体缩放 before 倍；对根元素设 zoom = 1/before
    //    后，1 CSS px 的视觉尺寸恢复为 1。
    info.mode = 'zoom';
    info.zoom = Math.max(1, Math.min(4, 1 / Math.max(0.05, info.after)));
    return info;
}

/**
 * 控制条：显示状态 + 手动缩放。
 * 之所以要手动缩放：meta 解锁在部分机型上可能不生效，
 * 此时 zoom 补偿会让页面横向溢出，用户需要自己微调。
 */
function fjpitBuildControlBar(initialZoom) {
    const bar = document.createElement('div');
    bar.setAttribute('data-fjpit-bar', '1');
    bar.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'z-index:2147483647',
        'box-sizing:border-box', 'display:flex', 'align-items:center',
        'padding:7px 10px', 'gap:8px',
        'background:rgba(17,20,26,.94)', 'color:#fff',
        'font:13px/1.35 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
        'box-shadow:0 2px 10px rgba(0,0,0,.35)'
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
    const btnReset = makeBtn('1:1', '复位到我算出的初始比例');
    const btnGo = makeBtn('开始导入', '立即开始（已登录时）');

    bar.appendChild(status);   // 状态占满剩余空间，按钮被推到右侧
    [btnOut, zoomLabel, btnIn, btnReset, btnGo].forEach(function (el) { bar.appendChild(el); });

    const head = document.head || document.documentElement;
    head.appendChild(bar);

    let zoom = initialZoom || 1;

    function applyZoom(z) {
        zoom = Math.max(0.3, Math.min(4, z));
        try {
            if (Math.abs(zoom - 1) < 0.001) {
                document.documentElement.style.removeProperty('zoom');
            } else {
                document.documentElement.style.zoom = String(zoom);
            }
        } catch (e) {}
        // 控制条自身也要跟随：其包含块是布局视口（可能是 1280），
        // 除以 zoom 后视觉宽度才等于屏幕宽度
        const w = Math.round((window.innerWidth || 360) / zoom);
        bar.style.width = w + 'px';
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }

    applyZoom(zoom);
    window.addEventListener('resize', function () {
        const w = Math.round((window.innerWidth || 360) / zoom);
        bar.style.width = w + 'px';
    });

    btnOut.addEventListener('click', function () { applyZoom(zoom / 1.15); });
    btnIn.addEventListener('click', function () { applyZoom(zoom * 1.15); });
    btnReset.addEventListener('click', function () { applyZoom(initialZoom || 1); });

    // 首次修复后，把内容横向居中，让用户直接看到中间的登录框
    setTimeout(function () {
        try {
            const de = document.documentElement;
            const visW = (window.visualViewport && window.visualViewport.width) || de.clientWidth;
            const total = de.scrollWidth;
            if (total > visW + 4) window.scrollTo(Math.max(0, (total - visW) / 2), 0);
        } catch (e) {}
    }, 350);

    let goHandler = null;
    btnGo.addEventListener('click', function () {
        if (goHandler) goHandler();
    });

    return {
        setStatus: function (t) { status.textContent = t; },
        applyZoom: applyZoom,
        onGo: function (fn) { goHandler = fn; },
        destroy: function () {
            try { if (bar.parentNode) bar.parentNode.removeChild(bar); } catch (e) {}
            try { document.documentElement.style.removeProperty('zoom'); } catch (e) {}
        }
    };
}

// ============================================================
// 二、鉴权
// ============================================================

// 实测：页面 #app 上挂着 __vue_app__，其 config.globalProperties.$pinia
// 里有 store `core-access`，accessToken 就明文存在其中。
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

function fjpitHeaders(token) {
    const h = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'is-main': 'true',
        'unique-request-id': fjpitUuid(),
        'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    if (token) h['ba-token'] = token;
    return h;
}

// ============================================================
// 三、网络
// ============================================================

async function fjpitGetWeekList(token) {
    const resp = await fetch(FJPIT_API + '/student/week', {
        method: 'GET', headers: fjpitHeaders(token), credentials: 'omit', mode: 'cors'
    });
    if (!resp.ok) throw new Error('获取周次失败，HTTP ' + resp.status);
    const json = await resp.json();
    if (json.code !== 1) throw new Error('获取周次失败: ' + (json.msg || '未知错误'));
    const data = json.data || {};
    const list = Array.isArray(data.weekList) ? data.weekList : [];
    return { currentWeek: data.dqz, totalWeeks: list.length || 20 };
}

async function fjpitGetWeekHtml(token, week) {
    const resp = await fetch(FJPIT_API + '/student/scheduleTable', {
        method: 'POST', headers: fjpitHeaders(token), credentials: 'omit', mode: 'cors',
        body: JSON.stringify({ dqz: week })
    });
    if (!resp.ok) throw new Error('第 ' + week + ' 周请求失败，HTTP ' + resp.status);
    const json = await resp.json();
    if (json.code !== 1) throw new Error('第 ' + week + ' 周返回异常: ' + (json.msg || '未知错误'));
    return typeof json.data === 'string' ? json.data : '';
}

/**
 * POST 通道探测：确认脚本发的 POST 是否被 App 的 Ktor 接管。
 * 未登录时预期返回 {"code":303,"msg":"请先登录！"} → 说明通道是通的。
 * 返回 { ok, detail }
 */
async function fjpitProbePost() {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 10000) : null;
    try {
        const resp = await fetch(FJPIT_API + '/student/scheduleTable', {
            method: 'POST',
            headers: fjpitHeaders(null),
            credentials: 'omit', mode: 'cors',
            body: JSON.stringify({ dqz: 1 }),
            signal: ctrl ? ctrl.signal : undefined
        });
        if (timer) clearTimeout(timer);
        let body = '';
        try { body = await resp.text(); } catch (e) {}
        return { ok: true, detail: 'HTTP ' + resp.status + ' ' + String(body).slice(0, 80) };
    } catch (e) {
        if (timer) clearTimeout(timer);
        return { ok: false, detail: (e && e.message) || String(e) };
    }
}

// ============================================================
// 四、解析
// ============================================================

/**
 * 从 <td> 内部 HTML 取 (课程名, 教师, 教室)；空格子返回 null。
 * 结构固定为：
 *   <div title='课程\n教师\n教室'>
 *     <div class='xxx'>课程</div><div>教师</div>
 *     <div class='xxx'><font color=blue>教室</font></div></div>
 */
function fjpitCellPayload(content) {
    if (!content) return null;
    const m = /title\s*=\s*(["'])([\s\S]*?)\1/.exec(content);
    if (m) {
        // 真实换行 与 字面 \n 都要切
        const parts = m[2].split(/[\r\n]+|\\n/).map(function (s) { return s.trim(); });
        while (parts.length < 3) parts.push('');
        if (parts[0]) return { name: parts[0], teacher: parts[1], room: parts[2] };
    }
    // 兜底：按内层 div 顺序取
    const divs = content.match(/<div[^>]*>([\s\S]*?)<\/div>/g);
    if (divs && divs.length >= 3) {
        const get = function (i) {
            return fjpitNormText(divs[i].replace(/^<div[^>]*>/, '').replace(/<\/div>$/, ''));
        };
        const name = get(0), teacher = get(1), room = get(2);
        if (name) return { name: name, teacher: teacher, room: room };
    }
    return null;
}

/**
 * 解析一周的课表 HTML。
 * 返回 { entries, timeSlots, mondayDate }
 */
function fjpitParseWeek(html, week) {
    const out = { entries: [], timeSlots: [], mondayDate: '' };
    if (!html) return out;

    const rowHtmls = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const grid = new Map();
    const occupied = new Set();

    rowHtmls.forEach(function (tr, r) {
        const tds = [];
        const re = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
        let m;
        while ((m = re.exec(tr)) !== null) tds.push({ attrs: m[1], content: m[2] });

        let c = 0;
        tds.forEach(function (td) {
            while (occupied.has(r + ',' + c)) c += 1;   // 跳过上方 rowspan 占位
            const rs = fjpitAttrInt(td.attrs, 'rowspan');
            const cs = fjpitAttrInt(td.attrs, 'colspan');
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    occupied.add((r + dr) + ',' + (c + dc));
                    grid.set((r + dr) + ',' + (c + dc), {
                        content: td.content, rowspan: rs, colspan: cs,
                        primary: (dr === 0 && dc === 0)
                    });
                }
            }
            c += cs;
        });
    });

    const lastRow = rowHtmls.length - 1;

    // 表头：第 1~7 列 = 星期一~日 + 日期
    const days = {};
    for (let c = 1; c <= lastRow; c++) {
        const cell = grid.get('0,' + c);
        if (!cell) continue;
        const txt = fjpitStripTags(cell.content);
        const dm = /(\d{4}-\d{2}-\d{2})/.exec(txt);
        const nm = /(星期[一二三四五六日天])/.exec(txt);
        days[c] = { date: dm ? dm[1] : '', name: nm ? nm[1] : '' };
    }
    out.mondayDate = (days[1] && days[1].date) || '';

    // 每行的节次号 + 时间
    const rowPeriod = {};
    for (let r = 1; r <= lastRow; r++) {
        const cell = grid.get(r + ',0');
        if (!cell) continue;
        const txt = fjpitNormText(cell.content);
        const pm = /第\s*(\d+)\s*节/.exec(txt);
        const tm = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(txt);
        if (pm) rowPeriod[r] = parseInt(pm[1], 10);
        if (pm && tm && out.timeSlots.length < 32) {
            out.timeSlots.push({ number: parseInt(pm[1], 10), startTime: tm[1], endTime: tm[2] });
        }
    }

    for (let r = 1; r <= lastRow; r++) {
        if (rowPeriod[r] === undefined) continue;   // 中午1/中午2 等非节次行
        for (let c = 1; c <= lastRow; c++) {
            const cell = grid.get(r + ',' + c);
            if (!cell || !cell.primary) continue;
            const payload = fjpitCellPayload(cell.content);
            if (!payload) continue;

            // 结束节次 = rowspan 覆盖范围内真实的最后一个节次
            const covered = [];
            for (let rr = r; rr < r + cell.rowspan; rr++) {
                if (rowPeriod[rr] !== undefined) covered.push(rowPeriod[rr]);
            }
            if (!covered.length) covered.push(rowPeriod[r]);
            const start = Math.min.apply(null, covered);
            const end = Math.max.apply(null, covered);

            const d = days[c] || {};
            out.entries.push({
                week: week, day: c, date: d.date || '',
                start: start, end: end,
                name: payload.name, teacher: payload.teacher, room: payload.room
            });
        }
    }
    return out;
}

/**
 * 不做任何教师/教室回填。
 *
 * 实测教务会在同一 (课程,星期,起节,止节) 组内时有时无地给教室，例如：
 *   Java程序设计 周二1-2节 → 8~11、13、16~18 周有「304(龙腰校区教学楼)」，
 *                             12、14、15、19 周为空
 * 空值是教务真实给出的状态，原样保留；因此同一课程同一时段可能聚合出
 * 两行（一行有教室、一行空），这是符合事实的，不要合并。
 */
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
// 五、保存
// ============================================================

async function fjpitSaveCourses(courses) {
    await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses, null, 2));
}

async function fjpitSaveTimeSlots(timeSlots) {
    if (!timeSlots.length) return false;
    timeSlots.sort(function (a, b) { return a.number - b.number; });
    // 校验要求 number 从 1 连续
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
// 六、等待登录
// ============================================================

/**
 * 轮询等待用户登录。页面若发生整页重载（登录跳转），
 * 旧脚本上下文会失效 —— 用 document.body 引用变化来检测并退出。
 */
async function fjpitWaitForLogin(bar, deadlineTs) {
    const bodyRef = document.body;
    let lastTip = 0;
    while (Date.now() < deadlineTs) {
        if (document.body !== bodyRef) return null;      // 页面已重载
        const token = fjpitGetAccessToken();
        if (token) return token;
        const left = Math.ceil((deadlineTs - Date.now()) / 1000);
        if (Date.now() - lastTip > 900) {
            lastTip = Date.now();
            bar.setStatus('等待登录… 请在页面中完成教务登录（' + left + 's）');
        }
        await fjpitDelay(700);
    }
    return null;
}

// ============================================================
// 七、主流程
// ============================================================

async function runImportFlow() {
    console.log('JS: 福信智慧教务课表导入开始');

    if (location.host.indexOf(FJPIT_HOST_KEY) < 0) {
        fjpitSafeToast('请先在福信智慧教务页面登录后再执行导入。');
        return;
    }

    // ---- 0. 页面可用性修复（电脑模式下 viewport 被锁 1280）----
    const vp = await fjpitUnlockViewport();
    console.log('JS: viewport 修复 ' + JSON.stringify(vp));
    const bar = fjpitBuildControlBar(vp.zoom);

    // ---- 1. POST 通道探测（确认是否已由 App 的 Ktor 代发）----
    bar.setStatus('检测 POST 通道…');
    const probe = await fjpitProbePost();
    console.log('JS: POST 通道探测 ' + JSON.stringify(probe));
    if (!probe.ok) {
        bar.setStatus('✘ POST 通道不通 · 请切换到「电脑模式」后重试');
        fjpitSafeToast('POST 通道不通：请用右上角菜单切换到「电脑模式」后重新执行导入。');
        await window.shiguangBridgePromise.showAlert(
            '需要切换到电脑模式',
            '当前 WebView 直接发出的 POST 被教务系统拒绝（' + probe.detail + '）。\n\n'
            + '请点右上角菜单 →「切换到电脑模式」→ 重新加载本页面 → '
            + '再点一次「执行导入」。\n\n'
            + '（电脑模式下 POST 会改由 App 自身发出，可绕过该限制）',
            '知道了'
        );
        bar.destroy();
        return;
    }

    // ---- 2. 令牌（未登录则等待）----
    let token = fjpitGetAccessToken();
    if (!token) {
        bar.setStatus('未登录 · 请在页面中登录教务');
        fjpitSafeToast('页面已解锁缩放，请先登录教务，登录后自动继续。');
        token = await fjpitWaitForLogin(bar, Date.now() + FJPIT_LOGIN_WAIT_MS);
        if (!token) {
            bar.destroy();
            fjpitSafeToast('未等到登录状态，请登录后重新点「执行导入」。');
            return;
        }
    }
    bar.setStatus('已登录，准备导入…');

    // ---- 3. 确认 ----
    const confirmed = await window.shiguangBridgePromise.showAlert(
        '福信智慧教务课表导入',
        '已登录教务系统。\n\n本脚本将逐周抓取本学期全部周课表，'
        + '自动获取开学日期与作息时间，然后导入课表。\n\n'
        + '视网络情况需要数秒，请勿离开页面。',
        '开始导入'
    );
    if (!confirmed) {
        bar.destroy();
        fjpitSafeToast('已取消导入。');
        return;
    }

    // ---- 4. 周次 ----
    let weekInfo;
    bar.setStatus('获取周次…');
    try {
        weekInfo = await fjpitGetWeekList(token);
    } catch (e) {
        bar.destroy();
        fjpitSafeToast('获取周次失败: ' + e.message);
        return;
    }
    const totalWeeks = weekInfo.totalWeeks;
    console.log('JS: 总周数 ' + totalWeeks + '，当前周 ' + weekInfo.currentWeek);

    // ---- 5. 逐周抓取 + 解析 ----
    const allEntries = [];
    let timeSlots = [];
    let semesterStartDate = '';
    const failedWeeks = [];

    for (let w = 1; w <= totalWeeks; w++) {
        bar.setStatus('抓取第 ' + w + '/' + totalWeeks + ' 周…');
        let html = '';
        try {
            html = await fjpitGetWeekHtml(token, w);
        } catch (e) {
            console.warn('JS: 第 ' + w + ' 周抓取失败: ' + e.message);
            failedWeeks.push(w);
            continue;
        }
        const parsed = fjpitParseWeek(html, w);
        allEntries.push.apply(allEntries, parsed.entries);
        if (w === 1) {
            timeSlots = parsed.timeSlots;
            semesterStartDate = parsed.mondayDate;
        }
    }

    if (!allEntries.length) {
        bar.setStatus('未解析到课程');
        fjpitSafeToast('未解析到任何课程，请确认本学期是否有排课。');
        return;
    }

    // ---- 6. 聚合（不做教师/教室回填，原样透传）----
    const courses = fjpitAggregate(allEntries);
    console.log('JS: 原始条目 ' + allEntries.length + '，聚合为 ' + courses.length
        + ' 条课程；开学日期 ' + semesterStartDate);

    // ---- 7. 保存 ----
    bar.setStatus('保存课程…');
    try {
        await fjpitSaveCourses(courses);
    } catch (e) {
        bar.destroy();
        fjpitSafeToast('课程保存失败: ' + e.message);
        return;
    }
    let timeSlotSaved = false;
    try {
        timeSlotSaved = await fjpitSaveTimeSlots(timeSlots);
    } catch (e) {
        console.warn('JS: 作息时间导入失败: ' + e.message);
    }
    try {
        await fjpitSaveConfig(semesterStartDate, totalWeeks);
    } catch (e) {
        console.warn('JS: 课表配置保存失败: ' + e.message);
    }

    // ---- 8. 汇总 ----
    const summary = [
        '导入完成',
        '课程行数：' + courses.length,
        '学期周数：' + totalWeeks,
        '开学日期：' + (semesterStartDate || '未取到'),
        '作息时间：' + (timeSlotSaved ? timeSlots.length + ' 节' : '未导入'),
        failedWeeks.length ? '失败周次：' + failedWeeks.join(',') : '全部周次抓取成功'
    ];
    console.log('JS: ' + summary.join(' | '));
    bar.destroy();
    await window.shiguangBridgePromise.showAlert('导入完成', summary.join('\n'), '好的');
    fjpitSafeToast('导入成功，共 ' + courses.length + ' 条课程');
    window.shiguangBridge.notifyTaskCompletion();
}

runImportFlow().catch(function (e) {
    console.error('JS: 导入流程异常', e);
    try { window.shiguangBridge.showToast('导入失败: ' + (e && e.message)); } catch (x) {}
});
