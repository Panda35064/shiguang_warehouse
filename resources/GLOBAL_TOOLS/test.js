// ============================================================
// 福信适配 · 诊断 v6
// ============================================================
// 要回答的问题：WebView 里 POST 被拒，到底是被什么触发的？
//
// v3 已排除：端点、鉴权、CORS 预检、X-Requested-With、代理、网络
// 但有一个组合从来没测过 ——
//   App 的 JS_INTERCEPT_POST 会给**每个带字符串 body 的非 GET 请求**
//   加一个 X-WebView-Post-Id 头。所以 v3 的「POST 裸」其实也不裸。
//   而这个头是可以通过 iframe 绕开的：
//     App 只对主 frame 执行 evaluateJavascript，
//     所以 about:blank 子 frame 里的 fetch / XMLHttpRequest 是原生、未打补丁的。
//
// 本轮探测：
//   T1 主 frame fetch  POST /student/scheduleTable   （当前基线，带 id 头）
//   T2 主 frame fetch  POST /schedule                （移动端接口，带 server:1）
//   T3 子 frame fetch  POST /student/scheduleTable   ★ 不带 id 头
//   T4 子 frame fetch  POST /schedule                ★ 不带 id 头 + server:1
//   T5 子 frame XHR    POST /schedule                ★ 另一种传输层
//   T6 Blob body       POST /student/scheduleTable   （补丁加不上 id 头）
//   T7 第三方 httpbin  POST                          （对照组）
//   T8 GET  /api/sectionConfig                       （移动端只读接口）
// ============================================================

const D_API = 'https://jw-api.fjpit.com/api';

function dUuid() {
    try { return crypto.randomUUID(); } catch (e) { return 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2); }
}

function dToken() {
    try {
        const root = document.querySelector('#app');
        const app = root && root.__vue_app__;
        const pinia = app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
        if (!pinia || !(pinia._s instanceof Map)) return null;
        for (const entry of pinia._s) {
            const st = entry[1];
            if (st && typeof st.accessToken === 'string' && st.accessToken) return st.accessToken;
        }
    } catch (e) {}
    return null;
}

/**
 * 拿一个「没被 App 打过补丁」的 window。
 * App 的 evaluateJavascript 只作用于主 frame，子 frame 是干净的。
 */
function dCleanWindow() {
    if (window.__fjpitCleanWin) return window.__fjpitCleanWin;
    const ifr = document.createElement('iframe');
    ifr.setAttribute('data-fjpit-diag', '1');
    ifr.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    (document.body || document.documentElement).appendChild(ifr);
    window.__fjpitCleanWin = ifr.contentWindow;
    return window.__fjpitCleanWin;
}

function dHdrs(token, withServer) {
    const h = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8'
    };
    if (token) h['ba-token'] = token;
    if (withServer) h['server'] = 1;
    else h['is-main'] = 'true';
    h['unique-request-id'] = dUuid();
    return h;
}

function dTimeout(ms) {
    const c = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = c ? setTimeout(function () { try { c.abort(); } catch (e) {} }, ms) : null;
    return { signal: c ? c.signal : undefined, clear: function () { if (t) clearTimeout(t); } };
}

/** 用指定的 fetch 实现发一次请求 */
async function dProbe(label, fetchImpl, url, init) {
    const tk = dTimeout(12000);
    const t0 = Date.now();
    try {
        const resp = await fetchImpl(url, Object.assign({ mode: 'cors', credentials: 'omit', signal: tk.signal }, init));
        tk.clear();
        let body = '';
        try { body = await resp.text(); } catch (e) {}
        return { label: label, ok: true, ms: Date.now() - t0, status: resp.status, body: String(body) };
    } catch (e) {
        tk.clear();
        return { label: label, ok: false, ms: Date.now() - t0, status: 0, err: (e && e.message) || String(e) };
    }
}

/** 用子 frame 的 XHR 发一次请求 */
function dProbeXhr(label, url, headers, body) {
    return new Promise(function (resolve) {
        const t0 = Date.now();
        let XHR;
        try { XHR = dCleanWindow().XMLHttpRequest; } catch (e) { resolve({ label: label, ok: false, ms: 0, err: '拿不到子 frame 的 XHR' }); return; }
        let x;
        try { x = new XHR(); } catch (e) { resolve({ label: label, ok: false, ms: 0, err: String(e) }); return; }
        const timer = setTimeout(function () {
            try { x.abort(); } catch (e) {}
            resolve({ label: label, ok: false, ms: Date.now() - t0, err: '超时(10s)' });
        }, 10000);
        x.onreadystatechange = function () {
            if (x.readyState !== 4) return;
            clearTimeout(timer);
            resolve({
                label: label, ok: true, ms: Date.now() - t0,
                status: x.status, body: String(x.responseText || '').slice(0, 300)
            });
        };
        x.onerror = function () {
            clearTimeout(timer);
            resolve({ label: label, ok: false, ms: Date.now() - t0, err: 'XHR onerror（网络层被拒）' });
        };
        try {
            x.open('POST', url, true);
            Object.keys(headers || {}).forEach(function (k) { try { x.setRequestHeader(k, headers[k]); } catch (e) {} });
            x.send(body);
        } catch (e) {
            clearTimeout(timer);
            resolve({ label: label, ok: false, ms: Date.now() - t0, err: String(e) });
        }
    });
}

function dLine(r) {
    if (r.ok) return 'OK   HTTP ' + r.status + '  ' + r.ms + 'ms  ' + String(r.body || '').replace(/\s+/g, ' ').slice(0, 60);
    return 'FAIL ' + r.err + '  ' + r.ms + 'ms';
}

function dOverlay(text) {
    let el = document.getElementById('fjpit-diag-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'fjpit-diag-overlay';
        el.style.cssText = [
            'position:fixed', 'left:0', 'top:0', 'right:0', 'bottom:0', 'z-index:2147483647',
            'background:rgba(12,14,18,.96)', 'color:#eaeaea', 'overflow:auto',
            'padding:14px 14px 40px', 'font:12px/1.55 Consolas,Menlo,monospace',
            'white-space:pre-wrap', 'word-break:break-all', '-webkit-user-select:text', 'user-select:text'
        ].join(';');
        el.addEventListener('click', function (e) { if (e.target === el) el.remove(); });
        (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
}

async function runDiag() {
    const R = { ua: navigator.userAgent, results: {}, judge: [] };
    R.desktopUA = /Windows NT|Macintosh|X11/.test(R.ua) && !/Android|iPhone/.test(R.ua);

    const token = dToken();

    // 主 frame 的 fetch（被 App 打过补丁）
    const mainFetch = window.fetch.bind(window);

    // 子 frame 的 fetch（原生，未打补丁）
    let cleanFetch = mainFetch;
    try { cleanFetch = dCleanWindow().fetch.bind(dCleanWindow()); } catch (e) {}

    // ---- T1 基线：主 frame + 主站接口 ----
    R.results.T1 = await dProbe('T1 主fetch scheduleTable', mainFetch,
        D_API + '/student/scheduleTable',
        { method: 'POST', headers: dHdrs(token, false), body: JSON.stringify({ dqz: 1 }) });

    // ---- T2 主 frame + 移动端接口（带 server:1）----
    R.results.T2 = await dProbe('T2 主fetch /schedule', mainFetch,
        D_API + '/schedule',
        { method: 'POST', headers: dHdrs(token, true), body: JSON.stringify({ semester: '', week: 1, showxxq: 0 }) });

    // ---- T3 ★ 子 frame 干净 fetch + 主站接口 ----
    R.results.T3 = await dProbe('T3 干净fetch scheduleTable', cleanFetch,
        D_API + '/student/scheduleTable',
        { method: 'POST', headers: dHdrs(token, false), body: JSON.stringify({ dqz: 1 }) });

    // ---- T4 ★ 子 frame 干净 fetch + 移动端接口 ----
    R.results.T4 = await dProbe('T4 干净fetch /schedule', cleanFetch,
        D_API + '/schedule',
        { method: 'POST', headers: dHdrs(token, true), body: JSON.stringify({ semester: '', week: 1, showxxq: 0 }) });

    // ---- T5 ★ 子 frame 干净 XHR + 移动端接口 ----
    R.results.T5 = await dProbeXhr('T5 干净XHR /schedule',
        D_API + '/schedule', dHdrs(token, true),
        JSON.stringify({ semester: '', week: 1, showxxq: 0 }));

    // ---- T6 Blob body（补丁取不到 bodyStr，不会加 id 头）----
    let blobOk = false;
    try {
        const blob = new Blob([JSON.stringify({ dqz: 1 })], { type: 'application/json;charset=UTF-8' });
        R.results.T6 = await dProbe('T6 Blob body scheduleTable', mainFetch,
            D_API + '/student/scheduleTable',
            { method: 'POST', headers: dHdrs(token, false), body: blob });
        blobOk = true;
    } catch (e) { R.results.T6 = { label: 'T6 Blob body', ok: false, err: 'Blob 不可用' }; }

    // ---- T7 第三方对照 ----
    R.results.T7 = await dProbe('T7 主fetch httpbin', mainFetch,
        'https://httpbin.org/post',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 1 }) });

    // ---- T8 GET 对照（移动端只读接口）----
    R.results.T8 = await dProbe('T8 GET /sectionConfig', mainFetch,
        D_API + '/sectionConfig',
        { method: 'GET', headers: { 'Accept': 'application/json', 'ba-token': token || '' } });

    // ---- 判定 ----
    const t = R.results;
    const mainFail = !t.T1.ok && !t.T2.ok;
    const cleanOk = t.T3.ok || t.T4.ok || t.T5.ok;
    const thirdOk = t.T7.ok;

    if (!t.T8.ok && !thirdOk) {
        R.judge.push('★ 网络整体不可用（连 GET / 第三方都不通），先检查网络');
    } else if (cleanOk && mainFail) {
        R.judge.push('★★ 子 frame 干净请求通、主 frame 请求全挂');
        R.judge.push('   ⇒ 元凶就是 App 补丁加的那个 X-WebView-Post-Id 头');
        R.judge.push('   ⇒ 适配脚本可以自救：改用子 frame 的原生 fetch 发请求');
    } else if (mainFail && !cleanOk) {
        R.judge.push('★ 无论主 frame 还是子 frame，POST 全挂');
        R.judge.push('   ⇒ WAF 拦的是 WebView 客户端本身（UA/TLS 指纹），JS 层面绕不开');
        R.judge.push('   ⇒ 需要换思路：改用 m.fjpit.com 页面内已有的数据');
    } else if (!mainFail) {
        R.judge.push('★ 主 frame 的 POST 也通了');
        R.judge.push('   ⇒ 之前的失败可能是偶发/未登录状态导致，可直接跑正式适配脚本');
    }

    R.judge.push('');
    R.judge.push('T8 GET 是否通: ' + (t.T8.ok ? '是（说明域名可达、CORS 正常）' : '否'));
    R.judge.push('当前模式: ' + (R.desktopUA ? '电脑模式（桌面 UA）' : '手机模式（移动 UA）'));

    // ---- 渲染 ----
    const lines = [];
    lines.push('=== 结论 ===');
    R.judge.forEach(function (x) { lines.push(x); });
    lines.push('');
    lines.push('=== 环境 ===');
    lines.push('UA: ' + R.ua);
    lines.push('模式: ' + (R.desktopUA ? '电脑模式' : '手机模式') + ' | 已登录: ' + (token ? '是' : '否'));
    lines.push('子 frame 干净 fetch: ' + (cleanFetch !== mainFetch ? '已取得 ✓' : '取不到 ✗'));
    lines.push('');
    lines.push('=== 明细 ===');
    ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].forEach(function (k) {
        const r = R.results[k];
        if (!r) return;
        lines.push(r.label.padEnd(28) + ' ' + dLine(r));
    });
    lines.push('');
    lines.push('（点击本浮层空白处可关闭）');

    const text = lines.join('\n');
    dOverlay(text);

    try {
        await window.shiguangBridgePromise.showAlert('诊断 v6 结果', text, '关闭');
    } catch (e) {
        console.log(text);
    }
}

runDiag().catch(function (e) {
    const msg = '诊断脚本异常: ' + (e && e.message);
    console.error(msg, e);
    try { window.shiguangBridge.showToast(msg); } catch (x) {}
});
