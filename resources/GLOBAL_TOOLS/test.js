// ============================================================
// 福信教务 · App 内 WebView 网络诊断脚本（临时，非适配代码）
// ============================================================
// 用途：在没有 ADB / DevTools 的情况下，让脚本自己在 App 的 WebView
//       里发几个探测请求，把结果直接弹出来，定位「网络异常」到底卡在哪。
//
// 用法：把 App 的「自定义仓库分支」切到 diag-fjpit，更新仓库，
//       然后在登录页直接点「执行导入」（不需要登录成功）。
// ============================================================

(function () {
    'use strict';

    const API = 'https://jw-api.fjpit.com/api';
    const TIMEOUT = 12000;

    const lines = [];
    function add(s) {
        lines.push(s);
        console.log('[FJPIT-DIAG]', s);
    }

    function short(s, n) {
        s = String(s == null ? '' : s);
        return s.length > (n || 90) ? s.slice(0, n || 90) + '…' : s;
    }

    // 带超时的 fetch 探测
    function probe(label, url, init) {
        const t0 = Date.now();
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT);
        const opts = Object.assign({}, init || {});
        if (ctl) opts.signal = ctl.signal;

        return fetch(url, opts).then(function (r) {
            return r.text().then(function (txt) {
                clearTimeout(timer);
                return {
                    label: label, ok: true, status: r.status,
                    type: r.headers.get('content-type') || '',
                    len: txt.length, head: short(txt, 110),
                    ms: Date.now() - t0
                };
            }, function () {
                clearTimeout(timer);
                return { label: label, ok: true, status: r.status, note: '(响应体读取失败)', ms: Date.now() - t0 };
            });
        }).catch(function (e) {
            clearTimeout(timer);
            return {
                label: label, ok: false,
                err: (e && e.name ? e.name : 'Error') + ': ' + (e && e.message ? e.message : String(e)),
                ms: Date.now() - t0
            };
        });
    }

    function fmt(r) {
        if (r.ok) {
            return r.label + ' → HTTP ' + r.status + ' (' + r.ms + 'ms)\n    ' + (r.head || r.note || '');
        }
        return r.label + ' → 失败 ' + r.ms + 'ms\n    ' + r.err;
    }

    // ---------- 收集环境信息 ----------
    function envInfo() {
        const out = [];
        out.push('页面: ' + location.href);
        out.push('UA: ' + short(navigator.userAgent, 150));

        const root = document.querySelector('#app') || document.body.firstElementChild;
        const app = root && root.__vue_app__;
        out.push('Vue app: ' + (app ? '有' : '无'));
        const gp = app && app.config && app.config.globalProperties;
        const pinia = gp && gp.$pinia;
        out.push('Pinia: ' + (pinia && pinia._s instanceof Map ? ('有，' + pinia._s.size + ' 个 store') : '无'));

        let token = null;
        if (pinia && pinia._s instanceof Map) {
            for (const e of pinia._s) {
                const st = e[1];
                if (st && typeof st.accessToken === 'string' && st.accessToken) { token = st.accessToken; break; }
            }
        }
        out.push('accessToken: ' + (token ? ('已登录（' + token.length + ' 位）') : '未登录'));
        return out;
    }

    async function run() {
        add('=== 开始诊断 ===');

        envInfo().forEach(add);

        const probes = [];

        // A. 同源静态资源（验证同源请求通路）
        probes.push(await probe('A 同源 /favicon.ico', location.origin + '/favicon.ico', { method: 'GET' }));

        // B. 跨域 API · 普通 GET，不带自定义头（最简形态）
        probes.push(await probe('B 跨域 GET 无自定义头', API + '/student/week', {
            method: 'GET', mode: 'cors', credentials: 'omit'
        }));

        // C. 跨域 API · 带自定义头（会触发 CORS 预检，与适配脚本一致）
        probes.push(await probe('C 跨域 GET 带 ba-token 头', API + '/student/week', {
            method: 'GET', mode: 'cors', credentials: 'omit',
            headers: { 'ba-token': 'diag-fake-token', 'is-main': 'true', 'Accept': 'application/json, text/plain, */*' }
        }));

        // D. 跨域 POST（适配脚本真正用到的形态）
        probes.push(await probe('D 跨域 POST scheduleTable', API + '/student/scheduleTable', {
            method: 'POST', mode: 'cors', credentials: 'omit',
            headers: { 'ba-token': 'diag-fake-token', 'is-main': 'true', 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify({ dqz: 1 })
        }));

        // E. 头回显服务：能看到 WebView 到底加了哪些请求头（如 X-Requested-With）
        probes.push(await probe('E 头回显 httpbin', 'https://httpbin.org/headers', {
            method: 'GET', mode: 'cors'
        }));

        probes.forEach(function (r) {
            add(fmt(r));
            if (r.label.indexOf('E ') === 0 && r.ok && r.head) add('    ← 见下方完整报告里的请求头');
        });

        // ---------- 判定 ----------
        const A = probes[0], B = probes[1], C = probes[2], D = probes[3];
        const verdict = [];
        if (!A.ok) verdict.push('同源请求都失败 → WebView 网络栈整体异常');
        else if (!B.ok) verdict.push('跨域最简 GET 就失败 → 跨域被拦（CORS/预检/拦截器）');
        else if (B.ok && !C.ok) verdict.push('不带自定义头能通、带自定义头失败 → 预检被拦');
        else if (C.ok && D.ok) verdict.push('接口层全部可达 → 问题在前端自身的调用方式，不在网络');
        else verdict.push('部分可达，见各项明细');

        add('=== 判定 ===');
        verdict.forEach(add);

        // ---------- 输出 ----------
        const summary = lines.slice(0, 40).join('\n');

        // 页面上放一个大浮层，方便截图（不动原页面）
        try {
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
                + 'background:#fff;color:#111;font:12px/1.5 monospace;padding:12px;overflow:auto;white-space:pre-wrap;';
            box.textContent = summary;
            document.body.appendChild(box);
        } catch (e) { /* ignore */ }

        try {
            window.shiguangBridge.showToast('诊断完成，请看弹窗');
        } catch (e) {}

        try {
            await window.shiguangBridgePromise.showAlert(
                '福信网络诊断结果',
                summary,
                '知道了'
            );
        } catch (e) {}
    }

    window.__fjpitDiag = run;
    run().catch(function (e) {
        add('诊断异常终止: ' + (e && e.message));
        try {
            window.shiguangBridgePromise.showAlert('诊断异常', lines.join('\n'), '知道了');
        } catch (x) {}
    });
})();
