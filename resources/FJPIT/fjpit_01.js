/**
 * 福建信息职业技术学院（福信智慧教务）课表导入适配脚本
 *
 * 教务前端 https://jw.fjpit.com   教务接口 https://jw-api.fjpit.com/api
 * 鉴权头 ba-token + server: 1；取数直接请求接口，不解析页面 HTML。
 *
 * 两个坑：
 * 1. App 的 JS 补丁给带字符串 body 的非 GET 请求自动加 X-WebView-Post-Id 头，
 *    教务 WAF 直接拒绝带该头的请求（连页面自身的登录 POST 也中招）。故须先把
 *    页面网络通道修干净才能登录 ⇒ 首次先点「执行导入」再登录，之后登录态保留。
 * 2. WAF 有短时速率限制，连续快速请求会被成片拒绝 ⇒ 逐周抓取带节流与退避重试。
 *
 * 数据规则：教师/教室按原文原样保留（空即空，不填「无」）；逐周抓 1~N 周，
 *           不用学期计划视图（军训不整周、调课、节假日）。
 */

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

/** 把日期对齐到所在周的周一（教务给的 startDate 不保证是周一）；用 UTC 运算避免时区挪日 */
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

// ---------- 一、干净网络通道（绕开 App 的 JS 补丁） ----------

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

// ---------- 二、页面可用性修复 + 控制条 ----------

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

/** 底部状态条：显示进度；登录引导走 App 原生弹窗。
 *  电脑模式下 WebView 缩放被锁到约 0.3 倍，故宽高需除以 zoom（定位只用 0）。 */
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
        /** 弹原生弹窗提示用户登录；点掉弹窗后 resolve */
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

// ---------- 三、鉴权 ----------

/** 会话内 token 备份（sessionStorage 在页面重载后仍保留） */
const FJPIT_TOKEN_BACKUP_KEY = 'fjpit-token-backup';

function fjpitSs() {
    try { return window.sessionStorage || null; } catch (e) { return null; }
}

function fjpitReadTokenBackup() {
    const ss = fjpitSs();
    if (!ss) return '';
    try { return String(ss.getItem(FJPIT_TOKEN_BACKUP_KEY) || ''); } catch (e) { return ''; }
}

function fjpitWriteTokenBackup(t) {
    const ss = fjpitSs();
    if (!ss || !t) return;
    try { ss.setItem(FJPIT_TOKEN_BACKUP_KEY, t); } catch (e) {}
}

/** 从 Pinia store 取 accessToken（正常路径） */
function fjpitTokenFromPinia() {
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

/** token 实际来源，便于排查（'pinia' / 'sessionStorage 备份' / ''） */
let FJPIT_TOKEN_FROM = '';

/** 取 accessToken：① Pinia store（正常路径）② 本会话的 sessionStorage 备份（兜底） */
function fjpitGetAccessToken() {
    const t1 = fjpitTokenFromPinia();
    if (t1) {
        FJPIT_TOKEN_FROM = 'pinia';
        fjpitWriteTokenBackup(t1);
        return t1;
    }
    const t2 = fjpitReadTokenBackup();
    if (t2) {
        FJPIT_TOKEN_FROM = 'sessionStorage 备份';
        return t2;
    }
    FJPIT_TOKEN_FROM = '';
    return null;
}

/** 页面就绪度，用于判断「为什么取不到 token」 */
function fjpitPageState() {
    const st = { hash: '', hasLoginForm: false, hasLocalCredential: false, piniaStores: 0 };
    try { st.hash = String(location.hash || ''); } catch (e) {}
    try { st.hasLoginForm = !!document.querySelector('input[type=password]'); } catch (e) {}
    try {
        st.hasLocalCredential = !!window.localStorage.getItem('fjpit-vben-auth-core-access');
    } catch (e) {}
    try {
        const root = document.querySelector('#app') || document.body.firstElementChild;
        const app = root && root.__vue_app__;
        const pinia = app && app.config && app.config.globalProperties
            && app.config.globalProperties.$pinia;
        st.piniaStores = (pinia && pinia._s instanceof Map) ? pinia._s.size : 0;
    } catch (e) {}
    return st;
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

// ---------- 四、取数（结构化 API） ----------

// 请求节奏与重试：教务 WAF 有短时速率限制（实测连续请求会成片被拒，
// 失败耗时仅 70~90ms 即「被立即拒绝」，过一段时间自动恢复），故请求间加间隔、
// 失败退避重试；一旦失败就把间隔翻倍自适应降速，宁可慢也要把数据取全。
const FJPIT_REQ_GAP_MS = 90;        // 相邻请求最小间隔（起始值）
const FJPIT_GAP_MAX_MS = 800;       // 自适应间隔上限
const FJPIT_MAX_ATTEMPT = 3;        // 单个请求最多尝试次数
const FJPIT_RETRY_BASE_MS = 400;    // 退避基数（第 n 次重试等 n × 此值）
const FJPIT_WEEK_CONCURRENCY = 5;   // 逐周抓取的并发度

let FJPIT_CUR_GAP_MS = FJPIT_REQ_GAP_MS;
let FJPIT_LAST_REQ_AT = 0;

/** 请求节流：保证相邻请求之间有最小间隔（间隔随失败自适应放宽） */
async function fjpitPace() {
    const wait = FJPIT_CUR_GAP_MS - (Date.now() - FJPIT_LAST_REQ_AT);
    if (wait > 0) await fjpitDelay(wait);
    FJPIT_LAST_REQ_AT = Date.now();
}

/** 统一请求入口：节流 + 重试退避 */
async function fjpitApiRequest(method, path, body, token) {
    let lastErr = null;
    for (let attempt = 1; attempt <= FJPIT_MAX_ATTEMPT; attempt++) {
        await fjpitPace();
        try {
            const init = {
                method: method,
                headers: fjpitApiHeaders(token),
                credentials: 'omit',
                mode: 'cors'
            };
            if (body !== undefined) init.body = JSON.stringify(body);
            const resp = await fjpitFetch(FJPIT_API + path, init);
            if (!resp.ok) throw new Error(path + ' HTTP ' + resp.status);
            const json = await resp.json();
            if (json.code !== 1) throw new Error(path + ' code=' + json.code + ' ' + (json.msg || ''));
            return json.data;
        } catch (e) {
            lastErr = e;
            // 自适应降速：出现失败说明很可能正在撞限流，把全局间隔翻倍
            const oldGap = FJPIT_CUR_GAP_MS;
            FJPIT_CUR_GAP_MS = Math.min(FJPIT_GAP_MAX_MS, FJPIT_CUR_GAP_MS * 2);
            if (FJPIT_CUR_GAP_MS !== oldGap) {
                console.warn('JS: 请求失败，请求间隔 ' + oldGap + 'ms → ' + FJPIT_CUR_GAP_MS + 'ms');
            }
            if (attempt < FJPIT_MAX_ATTEMPT) {
                const back = FJPIT_RETRY_BASE_MS * attempt;
                console.warn('JS: ' + path + ' 第 ' + attempt + ' 次失败（' + e.message
                    + '），' + back + 'ms 后重试');
                await fjpitDelay(back);
            }
        }
    }
    throw lastErr;
}

async function fjpitApiGet(path, token) {
    return fjpitApiRequest('GET', path, undefined, token);
}

async function fjpitApiPost(path, body, token) {
    return fjpitApiRequest('POST', path, body, token);
}

/** 限并发遍历：最多同时执行 limit 个 worker，结果按原顺序返回 */
async function fjpitForEachLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const n = Math.max(1, Math.min(limit | 0, items.length));
    async function runner() {
        for (;;) {
            const i = next;
            next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    const runners = [];
    for (let k = 0; k < n; k++) runners.push(runner());
    await Promise.all(runners);
    return results;
}

/** 走结构化 API 取全部数据，任一步失败直接抛错。
 *  并发编排：/semesters 串行 → 配置 + 作息并发 → 逐周限并发 FJPIT_WEEK_CONCURRENCY */
async function fjpitCollectData(token, bar) {
    const t0 = Date.now();

    // 1) 学期列表（必须最先，后续依赖它）
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

    // 2) 学期配置 + 作息时间（互不依赖 → 并发）
    bar.setStatus('读取学期配置与作息…');
    const pair = await Promise.all([
        fjpitApiPost('/semesterConfig', { semester: semester }, token).then(
            function (d) { return { ok: true, data: d }; },
            function (e) { return { ok: false, error: e }; }),
        fjpitApiPost('/scheduleTime', { dqz: 1 }, token).then(
            function (d) { return { ok: true, data: d }; },
            function (e) { return { ok: false, error: e }; })
    ]);

    if (!pair[0].ok) throw pair[0].error;           // 学期配置是关键，失败必须中断
    const sc = (pair[0].data && pair[0].data.semestersConfig) || pair[0].data || {};
    const totalWeeks = Number(sc.totalWeeks) || 0;
    const startDate = fjpitAlignToMonday(sc.startDate);   // 教务给的不一定是周一
    if (!(totalWeeks >= 1)) throw new Error('/semesterConfig 未返回有效 totalWeeks');
    console.log('JS[A]: 开学 ' + startDate + '，共 ' + totalWeeks + ' 周');

    let timeSlots = [];
    if (pair[1].ok) {
        try {
            const arr = Array.isArray(pair[1].data) ? pair[1].data : Object.values(pair[1].data || {});
            timeSlots = arr.map(function (e) {
                const num = Number(e && e.jcdm);
                const st = String((e && e.jcskkssj) || '').slice(0, 5);
                const et = String((e && e.jcskjssj) || '').slice(0, 5);
                return { number: num, startTime: st, endTime: et };
            }).filter(function (t) {
                return t.number >= 1 && /^\d{1,2}:\d{2}$/.test(t.startTime) && /^\d{1,2}:\d{2}$/.test(t.endTime);
            }).sort(function (a, b) { return a.number - b.number; });
        } catch (e) {
            console.warn('JS[A]: 作息解析失败（不影响课表）: ' + e.message);
        }
    } else {
        console.warn('JS[A]: 作息读取失败（不影响课表）: ' + pair[1].error.message);
    }

    // 3) 逐周课表（限并发；单周失败只记账不中断）
    bar.setStatus('抓取周课表…');
    const weekNums = [];
    for (let w = 1; w <= totalWeeks; w++) weekNums.push(w);

    let done = 0;
    const results = await fjpitForEachLimit(weekNums, FJPIT_WEEK_CONCURRENCY, async function (w) {
        try {
            const d = await fjpitApiPost('/schedule',
                { semester: semester, week: w, showxxq: showXxq }, token);
            return { week: w, list: (d && d.list) || [], ok: true };
        } catch (e) {
            console.warn('JS: 第 ' + w + ' 周抓取失败: ' + e.message);
            return { week: w, list: [], ok: false };
        } finally {
            done++;
            bar.setStatus('抓取周课表 ' + done + '/' + totalWeeks + '…');
        }
    });

    const entries = [];
    const failedWeeks = [];
    results.forEach(function (r) {
        if (!r.ok) { failedWeeks.push(r.week); return; }
        for (let i = 0; i < r.list.length; i++) {
            const rec = r.list[i];
            if (!rec) continue;
            const name = String(rec.course == null ? '' : rec.course).trim();
            const day = Number(rec.DayIndex);
            const start = Number(rec.startNode);
            const end = Number(rec.endNode);
            if (!name || !(day >= 1 && day <= 7) || !(start >= 1) || !(end >= start)) continue;
            entries.push({
                week: r.week, day: day, date: '',
                start: start, end: end,
                name: name,
                teacher: rec.teacherName == null ? '' : String(rec.teacherName).trim(),
                room: rec.spaceName == null ? '' : String(rec.spaceName).trim()
            });
        }
    });

    if (failedWeeks.length > Math.floor(totalWeeks / 2)) {
        throw new Error('过半周次抓取失败（' + failedWeeks.length + '/' + totalWeeks + '）：'
            + failedWeeks.join(','));
    }

    const elapsedMs = Date.now() - t0;
    console.log('JS[A]: 取数完成，用时 ' + elapsedMs + 'ms；失败周次 ' + failedWeeks.length
        + '；最终请求间隔 ' + FJPIT_CUR_GAP_MS + 'ms');

    return {
        entries: entries, timeSlots: timeSlots,
        semesterStartDate: startDate, totalWeeks: totalWeeks,
        failedWeeks: failedWeeks,
        elapsedMs: elapsedMs,
        meta: { semester: semester }
    };
}

// ---------- 五、聚合（教师/教室原样透传） ----------

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

// ---------- 六、保存 ----------

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

// ---------- 七、等待登录 ----------

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

// ---------- 八、主流程（编排） ----------
// 按官方推荐的编排模式：只做顺序编排；任一步失败立即 return；
// notifyTaskCompletion() 只在完全成功后调用。

/** 第 1 步：公告式确认（对应官方示例的 promptUserToStart） */
async function fjpitAskStart() {
    try {
        return await window.shiguangBridgePromise.showAlert(
            '福信智慧教务课表导入',
            '本工具将逐周抓取本学期全部周课表，并自动导入开学日期与作息时间。\n\n'
            + '数据直接读取教务接口，不解析页面，通常几秒完成。\n'
            + '请勿中途离开页面。',
            '开始导入'
        );
    } catch (e) {
        console.warn('JS: 确认弹窗失败', e);
        return false;
    }
}

/** 第 2 步：确保已登录；未登录则弹公告引导用户登录并等待 */
async function fjpitEnsureLogin(bar) {
    let token = fjpitGetAccessToken();
    if (token) {
        console.log('JS: token 来源：' + FJPIT_TOKEN_FROM);
        return token;
    }

    // 取不到 token ⇒ 走「请登录」引导，等用户登录后自动继续。
    // （诊断信息仍打一份到日志；App 内看不到控制台，排查以汇总弹窗为准）
    const st = fjpitPageState();
    console.log('JS: 未取到 token。页面状态=' + JSON.stringify(st));

    bar.needLogin();
    token = await fjpitWaitForLogin(bar, Date.now() + FJPIT_LOGIN_WAIT_MS);
    if (!token) token = fjpitGetAccessToken();   // 兜底：前端可能刚把 token 写进 store
    if (token) console.log('JS: token 来源：' + FJPIT_TOKEN_FROM);
    return token;
}

/** 第 4 步：聚合 + 保存。课程保存失败会抛出（必须中断）；作息与配置尽力而为 */
async function fjpitSaveAll(data) {
    const courses = fjpitAggregate(data.entries);
    console.log('JS: 原始条目 ' + data.entries.length + '，聚合为 ' + courses.length
        + ' 条课程；开学日期 ' + data.semesterStartDate);

    await fjpitSaveCourses(courses);

    let timeSlotSaved = false;
    try {
        timeSlotSaved = await fjpitSaveTimeSlots(data.timeSlots || []);
    } catch (e) {
        console.warn('JS: 作息时间导入失败: ' + e.message);
    }
    try {
        await fjpitSaveConfig(data.semesterStartDate, data.totalWeeks);
    } catch (e) {
        console.warn('JS: 课表配置保存失败: ' + e.message);
    }

    return { courses: courses, timeSlotSaved: timeSlotSaved };
}

/** 第 5 步：汇总公告 + 尽力导出调试数据 */
async function fjpitReport(data, saved) {
    const courses = saved.courses;

    const nameSet = {};
    let emptyPos = 0, emptyTea = 0;
    courses.forEach(function (c) {
        nameSet[c.name] = 1;
        if (!c.position) emptyPos++;
        if (!c.teacher) emptyTea++;
    });
    const nameCount = Object.keys(nameSet).length;

    // 调试导出：部分 WebView 不支持 <a download>，失败不影响流程
    try {
        const payload = {
            generatedAt: new Date().toISOString(),
            semesterStartDate: data.semesterStartDate,
            totalWeeks: data.totalWeeks,
            timeSlots: data.timeSlots || [],
            rawEntryCount: data.entries.length,
            rawEntries: data.entries,
            courses: courses,
            meta: data.meta || {}
        };
        const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fjpit-debug-' + Date.now() + '.json';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(function () {
            try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
            try { URL.revokeObjectURL(url); } catch (e) {}
        }, 3000);
    } catch (e) { console.warn('JS: 调试导出失败（可忽略）', e); }

    const summary = [
        '导入完成',
        '登录令牌：' + (FJPIT_TOKEN_FROM || '未知'),
        '取数耗时：' + (data.elapsedMs ? ((data.elapsedMs / 1000).toFixed(1) + 's') : '未知'),
        '课程行数：' + courses.length + '（' + nameCount + ' 门课）',
        '原始条目：' + data.entries.length + ' 条',
        '学期周数：' + data.totalWeeks,
        '开学日期：' + (data.semesterStartDate || '未取到'),
        '作息时间：' + (saved.timeSlotSaved ? (data.timeSlots || []).length + ' 节' : '未导入'),
        '空教师 ' + emptyTea + ' 行 / 空教室 ' + emptyPos + ' 行',
        (data.failedWeeks && data.failedWeeks.length)
            ? '失败周次：' + data.failedWeeks.join(',') : '全部周次抓取成功'
    ];
    console.log('JS: ' + summary.join(' | '));

    await window.shiguangBridgePromise.showAlert('导入完成', summary.join('\n'), '好的');
    fjpitSafeToast('导入成功，共 ' + courses.length + ' 条课程');
}

/** 编排入口；任一步失败或用户取消即 return */
async function runImportFlow() {
    console.log('JS: 福信智慧教务课表导入开始（v11）');

    // 0. 环境准备
    if (location.host.indexOf(FJPIT_HOST_KEY) < 0) {
        fjpitSafeToast('请先在福信智慧教务页面登录后再执行导入。');
        return;
    }
    const repair = fjpitRepairPageNetwork();
    console.log('JS: 页面网络通道修复 ' + JSON.stringify(repair));

    const vp = await fjpitUnlockViewport();
    const bar = fjpitBuildControlBar(vp.zoom);

    // 1. 登录（未登录则弹公告引导 + 等待）
    const token = await fjpitEnsureLogin(bar);
    if (!token) {
        bar.destroy();
        fjpitSafeToast('未等到登录状态，请登录后重新点「执行导入」。');
        return;
    }
    bar.setStatus('已登录，准备导入…');

    // 2. 确认
    const confirmed = await fjpitAskStart();
    if (!confirmed) {
        bar.destroy();
        fjpitSafeToast('已取消导入。');
        return;
    }

    // 3. 取数（全部走教务接口，不解析页面 HTML）
    let data;
    try {
        data = await fjpitCollectData(token, bar);
    } catch (e) {
        bar.destroy();
        fjpitSafeToast('取数失败：' + e.message);
        await window.shiguangBridgePromise.showAlert(
            '取数失败',
            '未能取到课表数据：\n' + e.message
            + '\n\n请确认已登录教务系统后重试。',
            '知道了'
        );
        return;
    }
    if (!data.entries.length) {
        bar.setStatus('未取到课程');
        bar.destroy();
        fjpitSafeToast('未取到任何课程，请确认本学期是否有排课。');
        return;
    }

    // 4. 聚合 + 保存
    bar.setStatus('保存课程…');
    let saved;
    try {
        saved = await fjpitSaveAll(data);
    } catch (e) {
        bar.destroy();
        fjpitSafeToast('课程保存失败：' + e.message);
        return;
    }

    // 5. 汇总
    bar.destroy();
    await fjpitReport(data, saved);

    // 6. 完全成功，才发结束信号
    window.shiguangBridge.notifyTaskCompletion();
}

runImportFlow().catch(function (e) {
    console.error('JS: 导入流程异常', e);
    try { window.shiguangBridge.showToast('导入失败: ' + (e && e.message)); } catch (x) {}
});
