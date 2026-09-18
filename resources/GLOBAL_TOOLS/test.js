// 通道探针：判定「页面通道是否仍被加了东西」
// 用法：放到 resources/GLOBAL_TOOLS/test.js，App 里点「适配代码测试」→ 执行导入
// 判据：
//   · 字符串 body 的 POST 失败 / Blob body 的 POST 成功
//     ⇒ 页面通道仍按「字符串 body」规则加了头（App 侧修复未覆盖该路径）
//   · 两种都失败 ⇒ 不是这个头，是限流或其它原因
//   · 子 frame 成功而页面通道失败 ⇒ 证实是「主 frame 被注入补丁」

const API = 'https://jw-api.fjpit.com/api';
const REPORT = [];

function ms(t) { return (Date.now() - t) + 'ms'; }

function getToken() {
    try {
        const root = document.querySelector('#app') || document.body.firstElementChild;
        const app = root && root.__vue_app__;
        const gp = app && app.config && app.config.globalProperties;
        const pinia = gp && gp.$pinia;
        if (!pinia || !(pinia._s instanceof Map)) return '';
        for (const entry of pinia._s) {
            const s = entry[1];
            if (s && typeof s.accessToken === 'string' && s.accessToken) return s.accessToken;
        }
    } catch (e) { }
    return '';
}

function headers(token) {
    const h = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'server': '1',
        'unique-request-id': 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    if (token) h['ba-token'] = token;
    return h;
}

/** 一个干净通道（子 frame 的原生 fetch）—— App 只注入主 frame */
let CLEAN = null;
function cleanFetch() {
    if (CLEAN) return CLEAN;
    try {
        const ifr = document.createElement('iframe');
        ifr.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
        (document.body || document.documentElement).appendChild(ifr);
        CLEAN = ifr.contentWindow.fetch.bind(ifr.contentWindow);
    } catch (e) {
        CLEAN = fetch;
    }
    return CLEAN;
}

function wait(ms2) { return new Promise(function (r) { setTimeout(r, ms2); }); }

/** 跑一次探测，返回一行结果 */
async function probe(label, kind, bodyKind, token) {
    const t = Date.now();
    const init = { method: 'POST', headers: headers(token), credentials: 'omit', mode: 'cors' };
    let url = API + '/scheduleTime';
    if (kind === 'get') {
        init.method = 'GET';
        delete init.body;
        url = API + '/semesters';
    } else if (bodyKind === 'blob') {
        init.body = new Blob([JSON.stringify({ dqz: 1 })], { type: 'application/json' });
    } else {
        init.body = JSON.stringify({ dqz: 1 });
    }

    try {
        let resp;
        if (kind === 'clean') resp = await cleanFetch()(url, init);
        else if (kind === 'xhr') resp = await xhrPost(url, init);
        else resp = await fetch(url, init);
        const status = resp && resp.status;
        const text = await resp.text().catch(function () { return ''; });
        let code = '';
        try { code = 'code=' + JSON.parse(text).code; } catch (e) { code = 'nonJSON'; }
        return label + '  →  OK ' + status + ' ' + code + '  ' + ms(t);
    } catch (e) {
        return label + '  →  FAIL ' + ms(t) + '  ' + (e && e.message);
    }
}

function xhrPost(url, init) {
    return new Promise(function (resolve, reject) {
        try {
            const x = new XMLHttpRequest();
            x.open(init.method, url, true);
            Object.keys(init.headers).forEach(function (k) { x.setRequestHeader(k, init.headers[k]); });
            x.onload = function () {
                resolve({ status: x.status, text: function () { return Promise.resolve(x.responseText); } });
            };
            x.onerror = function () { reject(new Error('XHR error')); };
            x.send(init.body || null);
        } catch (e) { reject(e); }
    });
}

(async function () {
    const token = getToken();
    REPORT.push('URL  : ' + location.href);
    REPORT.push('UA   : ' + String(navigator.userAgent).slice(0, 70));
    REPORT.push('token: ' + (token ? ('已取到 ' + token.slice(0, 8) + '…') : '**未取到**'));
    REPORT.push('bridge: ' + (window.shiguangBridgePromise ? '有' : '无'));
    REPORT.push('');

    const gap = 1500;
    REPORT.push(await probe('① GET  无 body        页 fetch', 'get', '', token)); await wait(gap);
    REPORT.push(await probe('② POST 字符串 body    页 fetch', 'page', 'str', token)); await wait(gap);
    REPORT.push(await probe('③ POST Blob  body     页 fetch', 'page', 'blob', token)); await wait(gap);
    REPORT.push(await probe('④ POST 字符串 body    页 fetch', 'page', 'str', token)); await wait(gap);
    REPORT.push(await probe('⑤ POST Blob  body     页 fetch', 'page', 'blob', token)); await wait(gap);
    REPORT.push(await probe('⑥ POST 字符串 body    子 frame', 'clean', 'str', token)); await wait(gap);
    REPORT.push(await probe('⑦ POST 字符串 body    页 XHR  ', 'xhr', 'str', token));

    const txt = REPORT.join('\n');
    console.log('JS[probe]:\n' + txt);
    try {
        await window.shiguangBridgePromise.showAlert('通道探针结果', txt, '知道了');
    } catch (e) {
        try { window.shiguangBridge.showToast('探针完成，见日志'); } catch (e2) { }
    }
})();
