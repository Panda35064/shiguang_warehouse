// ============================================================
// 福信教务 · App 内 WebView 诊断 v3（临时，非适配代码）
// ============================================================
// 背景：v2 已确认 —— 教务服务端拒 POST（第三方 POST 正常），
//       且 WebView 自动加了 X-Requested-With = App 包名。
//       代理已排除（全程未开代理 + 校园网），SSO 回跳也被拒。
//
// 本版要回答的两个问题：
//   Q1  WAF 是不是因为 POST 的 X-Requested-With 不是 XMLHttpRequest 而拦截？
//   Q2  JS 能不能覆盖 WebView 自动加的那个值？（能覆盖 ⇒ 适配脚本可自救）
//
// 结论放最前面。
// ============================================================

(function () {
    'use strict';

    const API = 'https://jw-api.fjpit.com/api';
    const P = API + '/student/scheduleTable';
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

        // 基准：v2 里失败的那个
        R.bare = await probe('POST 裸', P,
            { method: 'POST', mode: 'cors', credentials: 'omit', body: BODY });

        // ★ 核心实验：显式把 X-Requested-With 设成 XMLHttpRequest
        R.xrwOnly = await probe('POST +XRW:XMLHttpRequest', P,
            { method: 'POST', mode: 'cors', credentials: 'omit',
              headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: BODY });

        // ★ 真实形态的修正版：XRW + ba-token + is-main + json
        R.xrwFull = await probe('POST +XRW+ba-token+json', P,
            { method: 'POST', mode: 'cors', credentials: 'omit',
              headers: {
                  'X-Requested-With': 'XMLHttpRequest',
                  'ba-token': 'x', 'is-main': 'true',
                  'Content-Type': 'application/json;charset=UTF-8'
              },
              body: BODY });

        // 对照：无需鉴权的 POST 端点（看是不是「受保护端点」才被拦）
        R.logout = await probe('POST /auth/logout', API + '/auth/logout',
            { method: 'POST', mode: 'cors', credentials: 'omit',
              headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: '{}' });

        // 对照：POST 到一个不存在的路径 —— 区分「整域名拦 POST」还是「只有这个端点」
        R.nxPath = await probe('POST 不存在路径', API + '/__diag_probe__',
            { method: 'POST', mode: 'cors', credentials: 'omit', body: BODY });

        // 对照：同一路径的 GET（v2 只测了 /student/week）
        R.getSched = await probe('GET scheduleTable', P,
            { method: 'GET', mode: 'cors', credentials: 'omit' });

        // Q2：JS 设的 XRW 能不能压过 WebView 自动加的那个？用第三方回显看
        R.echo = await probe('POST httpbin +XRW', 'https://httpbin.org/post',
            { method: 'POST', mode: 'cors',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
              body: BODY });

        // ---------- 判定 ----------
        const v = [];
        if (R.xrwOnly.ok || R.xrwFull.ok) {
            v.push('★★ 加上 X-Requested-With: XMLHttpRequest 后 POST 通了！');
            v.push('   → WAF 就是按这个头拦的，适配脚本可以自救');
        } else if (R.bare.ok) {
            v.push('裸 POST 也通了（与 v2 不一致，可能环境有变）');
        } else if (R.logout.ok || R.nxPath.ok) {
            v.push('★ 其他 POST 端点通、只有 scheduleTable 不通');
            v.push('   → POST 没被整体拦，是该端点/未登录状态的问题');
        } else if (!R.getSched.ok) {
            v.push('★ 同路径 GET 也挂 → 罕见，需复测');
        } else {
            v.push('★ 加 XRW 也无效，且该域名下所有 POST 都挂');
            v.push('   → 整个 jw-api 域名拒绝来自本 WebView 的 POST，单靠改头解决不了');
        }

        // 回显解析：看最终 XRW 到底是什么 / 有没有重复
        let xrwEcho = '(未取到)';
        try {
            const j = JSON.parse(R.echo.text);
            const h = (j && j.headers) || {};
            const keys = Object.keys(h).filter(function (k) { return k.toLowerCase() === 'x-requested-with'; });
            xrwEcho = keys.length ? (keys.map(function (k) { return h[k]; }).join(' | ')) : '(响应里没有 X-Requested-With)';
        } catch (e) { xrwEcho = '(httpbin 响应解析失败)'; }

        // ---------- 输出 ----------
        const out = [];
        out.push('=== 结论 ===');
        v.forEach(function (x) { out.push(x); });
        out.push('');
        out.push('=== 明细 ===');
        out.push('POST 裸                    ' + line(R.bare));
        out.push('POST +XRW:XMLHttpRequest   ' + line(R.xrwOnly));
        out.push('POST +XRW+ba-token+json    ' + line(R.xrwFull));
        out.push('POST /auth/logout(免鉴权)  ' + line(R.logout));
        out.push('POST 不存在路径            ' + line(R.nxPath));
        out.push('GET  scheduleTable         ' + line(R.getSched));
        out.push('POST httpbin(第三方)       ' + line(R.echo));
        out.push('');
        out.push('=== 第三方回显的 X-Requested-With ===');
        out.push(xrwEcho);
        out.push('');
        out.push('=== 各失败响应体片段 ===');
        [['bare', R.bare], ['xrwOnly', R.xrwOnly], ['xrwFull', R.xrwFull],
         ['logout', R.logout], ['nxPath', R.nxPath], ['getSched', R.getSched]]
            .forEach(function (p) {
                const r = p[1];
                out.push(p[0] + ': ' + (r.ok ? ('HTTP ' + r.status + ' ' + String(r.text).slice(0, 60))
                    : ('ERR ' + r.err)));
            });

        const text = out.join('\n');

        try {
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
                + 'background:#fff;color:#111;font:12px/1.6 monospace;padding:10px;overflow:auto;white-space:pre-wrap;';
            box.textContent = text;
            document.body.appendChild(box);
        } catch (e) {}

        try { window.shiguangBridge.showToast('诊断v3 完成'); } catch (e) {}
        try { await window.shiguangBridgePromise.showAlert('福信诊断 v3', text, '知道了'); } catch (e) {}
    }

    window.__fjpitDiag3 = run;
    run().catch(function (e) {
        try {
            window.shiguangBridgePromise.showAlert('诊断v3 异常', String(e && e.message), '知道了');
        } catch (x) {}
    });
})();
