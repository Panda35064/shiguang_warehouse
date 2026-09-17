// ============================================================
// 福建信息职业技术学院 · 福信智慧教务 → 拾光课程表 适配脚本
// ============================================================
// 教务前端: https://jw.fjpit.com   (Vue3 + Vben Admin 5.5.6, 超星系)
// 教务接口: https://jw-api.fjpit.com/api
// 鉴权    : 请求头 ba-token + is-main（无 Cookie 依赖）
//
// 设计要点（与手工抓取手册的结论一致）：
//   1. 逐周抓 1~N 周生成数据，不用 {"type":"xqkb"} 学期计划视图
//      —— 课程不是固定死的（军训不整周、调课、节假日、周末补课）
//   2. HTML 表格必须做 rowspan/colspan 网格重建后，再按列归属星期
//   3. title='课程\n教师\n教室' 要同时兼容真实换行与字面 \n
//   4. 「中午1/中午2」这类非节次行用「第N节」匹配不到就跳过
//   5. 教师/教室原样透传：教务给空就是空，不做任何回填或替换
//      （手工抓取手册里「为空填无」那条是给 WakeUp CSV 用的——
//        WakeUp 模板不允许空字段；拾光是 JSON，空字符串是合法值，
//        而且「哪几周没有教室」本身也是有效信息，不该抹平）
// ============================================================

const FJPIT_API = 'https://jw-api.fjpit.com/api';
const FJPIT_HOST_KEY = 'fjpit.com';

// ---------- 通用工具 ----------

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

// ---------- 鉴权：从 Pinia 取 accessToken ----------
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
    return {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'ba-token': token,
        'is-main': 'true',
        'unique-request-id': fjpitUuid(),
        'Accept-Language': 'zh-CN,zh;q=0.9'
    };
}

// ---------- 网络 ----------
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

// ---------- 解析 ----------

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
        const get = function (i) { return fjpitNormText(divs[i].replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')); };
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

// ---------- 保存 ----------
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

// ---------- 主流程 ----------
async function runImportFlow() {
    console.log('JS: 福信智慧教务课表导入开始');

    if (location.host.indexOf(FJPIT_HOST_KEY) < 0) {
        window.shiguangBridge.showToast('请先在福信智慧教务页面登录后再执行导入。');
        return;
    }

    const confirmed = await window.shiguangBridgePromise.showAlert(
        '福信智慧教务课表导入',
        '请确认已登录教务系统。\n\n本脚本将逐周抓取本学期全部周课表，'
        + '自动获取开学日期与作息时间，然后导入课表。\n\n'
        + '视网络情况需要数秒，请勿离开页面。',
        '开始导入'
    );
    if (!confirmed) {
        window.shiguangBridge.showToast('已取消导入。');
        return;
    }

    // 1. 令牌
    const token = fjpitGetAccessToken();
    if (!token) {
        window.shiguangBridge.showToast('未获取到登录令牌，请确认已登录教务系统后重试。');
        return;
    }

    // 2. 周次
    let weekInfo;
    try {
        weekInfo = await fjpitGetWeekList(token);
    } catch (e) {
        window.shiguangBridge.showToast('获取周次失败: ' + e.message);
        return;
    }
    const totalWeeks = weekInfo.totalWeeks;
    console.log('JS: 总周数 ' + totalWeeks + '，当前周 ' + weekInfo.currentWeek);

    // 3. 逐周抓取 + 解析
    const allEntries = [];
    let timeSlots = [];
    let semesterStartDate = '';
    let failedWeeks = [];

    for (let w = 1; w <= totalWeeks; w++) {
        window.shiguangBridge.showToast('正在抓取第 ' + w + '/' + totalWeeks + ' 周...');
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
        window.shiguangBridge.showToast('未解析到任何课程，请确认本学期是否有排课。');
        return;
    }

    // 4. 聚合（不做教师/教室回填，原样透传）
    const courses = fjpitAggregate(allEntries);
    console.log('JS: 原始条目 ' + allEntries.length + '，聚合为 ' + courses.length
        + ' 条课程；开学日期 ' + semesterStartDate);

    // 5. 保存
    try {
        await fjpitSaveCourses(courses);
    } catch (e) {
        window.shiguangBridge.showToast('课程保存失败: ' + e.message);
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

    const summary = [
        '导入完成',
        '课程行数：' + courses.length,
        '学期周数：' + totalWeeks,
        '开学日期：' + (semesterStartDate || '未取到'),
        '作息时间：' + (timeSlotSaved ? timeSlots.length + ' 节' : '未导入'),
        failedWeeks.length ? '失败周次：' + failedWeeks.join(',') : '全部周次抓取成功'
    ];
    console.log('JS: ' + summary.join(' | '));
    await window.shiguangBridgePromise.showAlert('导入完成', summary.join('\n'), '好的');
    window.shiguangBridge.showToast('导入成功，共 ' + courses.length + ' 条课程');
    window.shiguangBridge.notifyTaskCompletion();
}

runImportFlow().catch(function (e) {
    console.error('JS: 导入流程异常', e);
    try { window.shiguangBridge.showToast('导入失败: ' + (e && e.message)); } catch (x) {}
});
