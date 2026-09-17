// ============================================================
// 福信教务 · App 内 WebView 诊断 v4（临时，非适配代码）
// ============================================================
// v3 结论：jw-api.fjpit.com 下**所有** POST 都挂（含不存在路径、免鉴权端点），
//          GET 完全正常，第三方 POST 正常，且 JS 改 X-Requested-With 无效。
//
// ⇒ WAF 看的是我们改不了的东西（UA / 客户端提示 / App 注入的头）。
//
// 还剩最后一个「我们可控」的变量值得验证：
//   App 的 fetch 补丁会给**所有带字符串 body 的非 GET 请求**
//   自动加一个 `X-WebView-Post-Id` 头（值形如 fetch_xxx）。
//   而 body 若是 Blob / ArrayBuffer，补丁取不到 bodyStr，**不会加这个头**。
//
//   若 POST 用 Blob body 就能通 ⇒ 那个头就是触发点，适配脚本可以直接绕开！
//
// 本版还要用第三方回显，直接列出每种 body 形态下**实际发出**的头。
// ============================================================

(function () {
    'use strict';

    const API = 'https://jw-api.fjpit.com/api';
    const P = API + '/student/scheduleTable';
    const TIMEOUT = 10000;
    const BODY = JSON.stringify({ dqz: 1 });

    function probe(url, init) {
        const t0 = Date.now();
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT);
        const opts = Object.assign({}, init || {});
        if (ctl) opts.signal = ctl.signal;

        return fetch(url, opts).then(function (r) {
            return r.text().then(function (t) {
                clearTimeout(timer);
                return { ok: true, status: r.status, ms: Date.now() - t0, text: t };
            });
        }).catch(function (e) {
            clearTimeout(timer);
            return { ok: false, ms: Date.now() - t0, err: (e && e.name) + ': ' + (e && e.message) };
        });
    }

    const line = function (r) {
        return (r.ok ? ('OK   ' + r.status) : ('FAIL ' + r.err)) + '  ' + r.ms + 'ms';
    };

    function headersFrom(r) {
        try {
            const j = JSON.parse(r.text);
            return Object.keys((j && j.headers) || {});
        } catch (e) { return null; }
    }

    async function run() {
        const out = [];
        const R = {};

        // ---------- 1. 先确认各 body 形态实际发出哪些头（第三方回显）----------
        const blobin = new Blob([BODY], { type: 'application/json' });
        const formin = new URLSearchParams();
        formin.append('dqz', '1');

        const eStr = await probe('https://httpbin.org/post',
            { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: BODY });
        const eBlob = await probe('https://httpbin.org/post',
            { method: 'POST', mode: 'cors', body: blobin });
        const eForm = await probe('https://httpbin.org/post',
            { method: 'POST', mode: 'cors', body: formin });

        const hStr = headersFrom(eStr), hBlob = headersFrom(eBlob), hForm = headersFrom(eForm);
        const has = function (hs, name) {
            if (!hs) return '?';
            return hs.some(function (k) { return k.toLowerCase() === name.toLowerCase(); }) ? '有' : '无';
        };

        // ---------- 2. 用同样三种 body 去打教务 ----------
        R.str = await probe(P, { method: 'POST', mode: 'cors', credentials: 'omit',
            headers: { 'Content-Type': 'application/json' }, body: BODY });
        R.blob = await probe(P, { method: 'POST', mode: 'cors', credentials: 'omit', body: blobin });
        R.form = await probe(P, { method: 'POST', mode: 'cors', credentials: 'omit', body: formin });
        R.blobFull = await probe(P, { method: 'POST', mode: 'cors', credentials: 'omit',
            headers: { 'ba-token': 'x', 'is-main': 'true' }, body: blobin });

        // ---------- 3. 判定 ----------
        const v = [];
        if (R.blob.ok) {
            v.push('★★ Blob body 的 POST 通了！');
            v.push('   → 触发点就是补丁自动加的 X-WebView-Post-Id，适配脚本可绕开');
        } else if (R.str.ok || R.form.ok) {
            v.push('★ 某种 body 形态通了，见明细');
        } else {
            v.push('★ 三种 body 形态都挂');
            if (has(hBlob, 'X-WebView-Post-Id') === '无' && has(hStr, 'X-WebView-Post-Id') === '有') {
                v.push('   （回显已确认 Blob 确实没带 X-WebView-Post-Id）');
                v.push('   → 排除该头，WAF 依据的是 UA / 客户端提示等改不了的东西');
            } else {
                v.push('   → WAF 依据的是 UA / 客户端提示等改不了的东西');
            }
        }

        // ---------- 4. 输出 ----------
        out.push('=== 结论 ===');
        v.forEach(function (x) { out.push(x); });
        out.push('');
        out.push('=== 打教务的 POST ===');
        out.push('字符串 body     ' + line(R.str));
        out.push('Blob body       ' + line(R.blob));
        out.push('Blob+ba-token   ' + line(R.blobFull));
        out.push('URLSearchParams ' + line(R.form));
        out.push('');
        out.push('=== 第三方回显：实际带了哪些头 ===');
        out.push('X-WebView-Post-Id   字符串=' + has(hStr, 'X-WebView-Post-Id')
            + '  Blob=' + has(hBlob, 'X-WebView-Post-Id')
            + '  Form=' + has(hForm, 'X-WebView-Post-Id'));
        out.push('X-Requested-With    字符串=' + has(hStr, 'X-Requested-With')
            + '  Blob=' + has(hBlob, 'X-Requested-With')
            + '  Form=' + has(hForm, 'X-Requested-With'));

        const text = out.join('\n');

        try {
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
                + 'background:#fff;color:#111;font:12px/1.6 monospace;padding:10px;overflow:auto;white-space:pre-wrap;';
            box.textContent = text;
            document.body.appendChild(box);
        } catch (e) {}

        try { window.shiguangBridge.showToast('诊断v4 完成'); } catch (e) {}
        try { await window.shiguangBridgePromise.showAlert('福信诊断 v4', text, '知道了'); } catch (e) {}
    }

    window.__fjpitDiag4 = run;
    run().catch(function (e) {
        try {
            window.shiguangBridgePromise.showAlert('诊断v4 异常', String(e && e.message), '知道了');
        } catch (x) {}
    });
})();
