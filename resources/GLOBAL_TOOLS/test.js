// ============================================================
// 福信教务 · App 内 WebView 诊断 v2（临时，非适配代码）
// ============================================================
// v1 结论：GET（含自定义头 + CORS 预检）→ HTTP 200；
//          POST scheduleTable → 53ms 内 TypeError: Failed to fetch
//          → 不是超时，是请求被提前拒绝。
//
// v2 目的：
//   1) 把 POST 按「请求头组合」逐一拆开，定位是哪个头触发拒绝
//   2) 用第三方域名的 POST 做对照，区分「WebView 拦 POST」还是「教务服务端拦 POST」
//   3) 回显请求头，确认 WebView 到底带了哪些指纹头
// 结论放最前面，避免被弹窗截断。
// ============================================================

(function () {
    'use strict';

    const API = 'https://jw-api.fjpit.com/api';
    const TIMEOUT = 10000;
    const BODY = JSON.stringify({ dqz: 1 });

    function probe(label, url, init) {
        const t0 = Date.now();
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT);
        const opts = Object.assign({}, init || {});
        if (ctl) opts.signal = ctl.signal;

        return fetch(url, opts).then(function (r) {
            return r.text().then(function (t) {
                clearTimeout(timer);
                return { label: label, ok: true, status: r.status, ms: Date.now() - t0, text: t };
            }, function () {
                clearTimeout(timer);
                return { label: label, ok: true, status: r.status, ms: Date.now() - t0, text: '' };
            });
        }).catch(function (e) {
            clearTimeout(timer);
            return {
                label: label, ok: false, ms: Date.now() - t0,
                err: (e && e.name ? e.name : 'Error') + ': ' + (e && e.message ? e.message : String(e))
            };
        });
    }

    function line(r) {
        return (r.ok ? ('OK   ' + r.status) : ('FAIL ' + r.err)) + '  ' + r.ms + 'ms';
    }

    async function run() {
        const R = {};

        // ---- GET 基准 ----
        R.getPlain = await probe('GET 无头', API + '/student/week',
            { method: 'GET', mode: 'cors', credentials: 'omit' });
        R.getHdr = await probe('GET +ba-token', API + '/student/week',
            { method: 'GET', mode: 'cors', credentials: 'omit', headers: { 'ba-token': 'x', 'is-main': 'true' } });

        // ---- POST 变体：逐个头往上加 ----
        const P = API + '/student/scheduleTable';
        R.postBare = await probe('POST 无任何头', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', body: BODY });
        R.postText = await probe('POST +text/plain', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: BODY });
        R.postJson = await probe('POST +json头', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: BODY });
        R.postTok = await probe('POST +ba-token', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'ba-token': 'x', 'is-main': 'true' }, body: BODY });
        R.postFull = await probe('POST +ba-token+json', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'ba-token': 'x', 'is-main': 'true', 'Content-Type': 'application/json;charset=UTF-8' }, body: BODY });

        // ---- 对照组：第三方域名的 POST（区分 WebView vs 教务服务端）----
        R.postThird = await probe('POST httpbin(第三方)', 'https://httpbin.org/post',
            { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: BODY });

        // ---- 另一台主机 ----
        R.wx = await probe('GET wx.fjpit.com', 'https://wx.fjpit.com/',
            { method: 'GET', mode: 'cors', credentials: 'omit' });

        // ---- 请求头回显 ----
        R.echo = await probe('头回显 httpbin', 'https://httpbin.org/headers', { method: 'GET', mode: 'cors' });

        // ---------- 判定 ----------
        const v = [];
        if (R.postThird.ok && !R.postBare.ok) {
            v.push('★ 第三方 POST 通、教务 POST 不通');
            v.push('  → 不是 WebView 的问题，是教务服务端拦 POST');
        } else if (!R.postThird.ok && !R.postBare.ok) {
            v.push('★ 连第三方 POST 都失败 → WebView 层面拦了 POST');
        } else if (R.postBare.ok) {
            v.push('POST 最简形态可通，逐个加头定位：');
            if (!R.postText.ok) v.push('  → 加 text/plain 就挂');
            else if (!R.postJson.ok) v.push('  → 只有 application/json 挂（服务端允许头不含 content-type）');
            else if (!R.postTok.ok) v.push('  → 加 ba-token 就挂（自定义头预检被拒）');
            else if (!R.postFull.ok) v.push('  → 组合头挂');
            else v.push('  → 全通，与 v1 矛盾，需复测');
        }
        if (R.getHdr.ok && !R.postBare.ok) v.push('  （GET 带自定义头通 → 预检机制本身正常，问题在 POST）');

        // ---------- 输出 ----------
        const out = [];
        out.push('=== 结论 ===');
        v.forEach(function (x) { out.push(x); });
        out.push('');
        out.push('=== 明细 ===');
        out.push('GET  无头               ' + line(R.getPlain));
        out.push('GET  +ba-token          ' + line(R.getHdr));
        out.push('POST 无任何头           ' + line(R.postBare));
        out.push('POST +text/plain        ' + line(R.postText));
        out.push('POST +json头            ' + line(R.postJson));
        out.push('POST +ba-token          ' + line(R.postTok));
        out.push('POST +ba-token+json     ' + line(R.postFull));
        out.push('POST 第三方 httpbin     ' + line(R.postThird));
        out.push('GET  wx.fjpit.com       ' + line(R.wx));
        out.push('');
        out.push('=== WebView 实际请求头 ===');
        if (R.echo.ok) {
            let keys = null;
            try {
                const j = JSON.parse(R.echo.text);
                if (j && j.headers) keys = Object.keys(j.headers);
            } catch (e) { /* 忽略 */ }
            if (keys) {
                out.push(keys.join(', '));
                out.push('含 X-Requested-With ? ' + (keys.some(function (k) {
                    return k.toLowerCase() === 'x-requested-with';
                }) ? '是 ★' : '否'));
            } else {
                out.push('（响应体过长未解析）');
            }
        } else {
            out.push('失败: ' + R.echo.err);
        }
        out.push('');
        out.push('=== 已登录？ ===');
        out.push((function () {
            try {
                const r = document.querySelector('#app') || document.body.firstElementChild;
                const p = r && r.__vue_app__ && r.__vue_app__.config.globalProperties.$pinia;
                if (!p || !(p._s instanceof Map)) return '无 pinia';
                for (const e of p._s) {
                    const s = e[1];
                    if (s && typeof s.accessToken === 'string' && s.accessToken) return '是';
                }
                return '否（' + p._s.size + ' 个 store）';
            } catch (e) { return '异常: ' + e.message; }
        })());

        const text = out.join('\n');

        try {
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
                + 'background:#fff;color:#111;font:12px/1.6 monospace;padding:10px;overflow:auto;white-space:pre-wrap;';
            box.textContent = text;
            document.body.appendChild(box);
        } catch (e) {}

        try { window.shiguangBridge.showToast('诊断v2 完成'); } catch (e) {}
        try { await window.shiguangBridgePromise.showAlert('福信诊断 v2', text, '知道了'); } catch (e) {}
    }

    window.__fjpitDiag2 = run;
    run().catch(function (e) {
        try {
            window.shiguangBridgePromise.showAlert('诊断v2 异常', String(e && e.message), '知道了');
        } catch (x) {}
    });
})();
