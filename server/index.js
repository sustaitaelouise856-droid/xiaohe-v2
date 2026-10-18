'use strict';
// 小禾英语 V2 试点服务(本阶段:本机运行,不对外开放)
//
// Google Drive 恢复（必须在 require('./db') 之前）
//
require('./gdrive-restore');
//
// 进程守护（2026-09-30）：stop.ps1 主动停服务时会写 data/.stop-intent 标记；
// 服务每次成功启动都删掉这个标记。看门狗（scripts/watchdog.js）只在
// "3101 无监听且无标记"时才拉起服务，避免和主动停服打架。
try {
  const _dd = process.env.XH_DATA_DIR ||
    require('path').join(__dirname, '..', 'data');
  require('fs').unlinkSync(require('path').join(_dd, '.stop-intent'));
} catch { /* 没有标记很正常 */ }

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const auth = require('./auth');
const grade = require('./grade');
const attempts = require('./attempts');
const review = require('./review');
const retest = require('./retest');
const exams = require('./exams');
const seed = require('./seed');
const { shanghaiDay } = require('./time');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.set('trust proxy', false);

const bootTime = Date.now();

// ---- 时间统一走 server/time.js（北京时间 Asia/Shanghai，不跟服务器本地时区） ----
function lessonState(lessonId) {
  const lid = lessonId || 'u2r1';
  let row = db.prepare('SELECT * FROM lesson_state WHERE lesson_id=?').get(lid);
  if (!row) {
    db.prepare('INSERT INTO lesson_state(lesson_id) VALUES(?)').run(lid);
    row = db.prepare('SELECT * FROM lesson_state WHERE lesson_id=?').get(lid);
  }
  return row;
}
// ?lesson= 白名单（2026-10-02）：参数给了但不在已入库课程（lessons 表）里 -> 400，
// 且校验通过前不得调 lessonState()，免得垃圾 lesson_id 在 lesson_state 里留一行。
function validLesson(lid) {
  try { if (db.prepare('SELECT 1 FROM lessons WHERE lesson_id=?').get(lid)) return true; }
  catch {}
  // 兜底（2026-10-18）：draft 学科（yw-/sx-）若 DB 未入库但文件存在，也放行——
  // loadLesson 本就从文件读，validLesson 不应成为单点故障
  try {
    return /^(yw-[a-z0-9]+|sx\d+)$/.test(lid) &&
           fs.existsSync(path.join(seed.contentDir(), `lesson-${lid}.json`));
  } catch { return false; }
}
function badLesson(res) { return res.status(400).json({ ok: false, error: 'bad_lesson' }); }
// ---- 故事选择持久化（2026-10-02 总指挥补充条款）：第 4 课起，广播站剧情里学生的选择
// （如选哪首歌点播）存进 story_choices；后续步骤用 {{choice:key|默认文本}} 占位回调已选的值。
// substituteChoices 是纯函数（可测试）：choices 为 {key: value}；没有已存值（或空串）时用占位里的默认值。
function substituteChoices(text, choices) {
  return String(text == null ? '' : text).replace(/\{\{choice:([^{}|]+)\|([^{}]*)\}\}/g, function (m, key, def) {
    const k = String(key).trim();
    const v = choices ? choices[k] : undefined;
    return (v == null || v === '') ? def : String(v);
  });
}
function loadChoices(lid) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT choice_key, value FROM story_choices WHERE lesson_id=?').all(lid)) {
      map[r.choice_key] = r.value;
    }
  } catch { /* 老库第一次启动表可能不存在，就空着 */ }
  return map;
}
// 用时过短的轻提醒阈值（毫秒）：有阅读材料的题，首次作答快于此时提醒"再看一遍通知"
const NUDGE_MS = 5000;

// ---- 课程内容：按 lesson_id 加载（content/lesson-{id}.json），常驻内存 ----
// lesson_id 只允许 u2r<数字>（正课）或 review<数字>（练习课），防止路径穿越
const LESSON_CACHE = {};
// 练习课（练习模式）：正课全部学完后开放，可反复练（豁免防重做）
function isReviewLesson(lid) { return /^review\d+$/.test(String(lid || '')); }
function loadLesson(lessonId) {
  const lid = String(lessonId || 'u2r1');
  if (!/^(?:u[2-6]r\d+|review\d+|u3-consolidate|deep\d+|moon\d+|sx\d+|yw-[a-z0-9]+|yw\d+-[a-z]+)$/.test(lid)) return null;
  if (!LESSON_CACHE[lid]) {
    const fp = path.join(seed.contentDir(), `lesson-${lid}.json`);
    if (!fs.existsSync(fp)) return null;
    const lesson = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const stepsByItem = {};
    for (const s of lesson.steps) {
      if (s.kind === 'mcq' || s.kind === 'short') stepsByItem[`${lid}-v${lesson.version}-s${s.step}`] = s;
    }
    LESSON_CACHE[lid] = { lesson, stepsByItem };
  }
  return LESSON_CACHE[lid];
}
// 从 item_id 反查 lesson_id（格式如 u2r2-v1-s10）
function lessonOf(itemId) {
  const m = /^([a-z0-9]+)-v\d+-s\d+$/i.exec(String(itemId || ''));
  return m ? m[1] : null;
}
// 逻辑题号：去掉 -v<版本>-，同一道题跨版本算同一题（u2r2-v1-s5 与 u2r2-v3-s5 同题）。
// 完成页统计按逻辑题号归一化，孩子在升版本前用旧版做的题不能凭空消失（2026-10-02）。
function logicalItemId(itemId) {
  return String(itemId || '').replace(/-v\d+(?=-s\d+$)/i, '');
}
// 一课的归一化聚合：以当前版本题目为准绳，attempts 按逻辑题号折叠取 MAX。
// 返回 { independent, helped, items, weaknesses, totalMs }
function lessonAgg(lid) {
  const L = loadLesson(lid);
  const ver = L ? L.lesson.version : null;
  const curRows = db.prepare(
    `SELECT item_id FROM items WHERE lesson_id=?${ver != null ? ' AND version=?' : ''}`
  ).all(...(ver != null ? [lid, ver] : [lid]));
  const curLogical = new Set(curRows.map(r => logicalItemId(r.item_id)));
  // u3-consolidate 只统计当前挑战轮次（u3_consolidation_session 之后），
  // 历史轮次的误标 helped 不能污染当前轮次的过关判定（2026-10-14 修）。
  let sessFilter = '';
  let sessArgs = [];
  if (lid === 'u3-consolidate') {
    const sess = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
    if (sess && sess.value) {
      sessFilter = ' AND created_at >= ?';
      sessArgs = [sess.value];
    }
  }
  const rows = db.prepare(
    `SELECT item_id, independent, helped, correct FROM attempts WHERE item_id LIKE ?${sessFilter}`
  ).all(lid + '-%', ...sessArgs);
  const byLogical = new Map();
  for (const r of rows) {
    const key = logicalItemId(r.item_id);
    if (!curLogical.has(key)) continue; // 已下架的题不计入
    const g = byLogical.get(key) || { ind: 0, helped: 0, correct: 0 };
    g.ind = Math.max(g.ind, r.independent || 0);
    g.helped = Math.max(g.helped, r.helped || 0);
    g.correct = Math.max(g.correct, r.correct || 0);
    byLogical.set(key, g);
  }
  let independent = 0, helped = 0;
  for (const g of byLogical.values()) {
    if (g.ind) independent++;
    if (g.helped && g.correct) helped++; // 中文作答的题会同时计入（内容独立、书写用了帮助）
  }
  const weak = db.prepare(
    'SELECT DISTINCT tag FROM weakness_events WHERE item_id LIKE ?'
  ).all(lid + '-%').map(r => r.tag);
  const totalMs = db.prepare(
    'SELECT COALESCE(SUM(elapsed_ms),0) AS ms FROM attempts WHERE item_id LIKE ?'
  ).get(lid + '-%').ms || 0;
  return { independent, helped, items: curRows.length, weaknesses: weak, totalMs };
}
function publicStep(s, lessonId, version, choices) {
  // 下发给学生的步骤：去掉答案与判分规格
  const C = choices || {};
  // 剧情回调占位（2026-10-02）：teach_html/scene/stem/title 里的 {{choice:key|默认文本}}
  // 换成该课已存的学生选择，没有就换默认值
  const o = {
    step: s.step, kind: s.kind, phase: s.phase || 'practice',
    title: substituteChoices(s.title, C), scene: substituteChoices(s.scene, C),
    stem: substituteChoices(s.stem, C), task: s.task,
    teach_html: substituteChoices(s.teach_html, C), reading: s.reading, audio_id: s.audio_id,
  };
  if (s.kind === 'mcq' || s.kind === 'short' || s.kind === 'chunk') o.item_id = `${lessonId}-v${version}-s${s.item_step || s.step}`;
  if (s.kind === 'mcq') o.options = s.options;
  // 拼句题（2026-10-14）：下发打乱的词块，前端点选拼句；答案用 expects 判分
  if (s.kind === 'chunk') o.chunks = s.chunks;
  // choice 步骤：下发 choice_key 与选项（选项只有标签，没有答案可泄）；选择不记作答不判分
  if (s.kind === 'choice') { o.choice_key = s.choice_key; o.options = s.options; }
  // 第二天开场复习副本的标记（2026-10-02）：前端据此打"复习题"标
  if (s.review) o.review = true;
  // “再看材料”按钮与材料来源标签（2026-10-02）：see_also/material_label 是给孩子看的公开内容，原样透传；
  // help_line（指向答案那句）绝不随步骤下发，只由 /api/help 在孩子求助二级时揭示，
  // 免得答案行提前写进页面源码。
  if (s.see_also) o.see_also = s.see_also;
  if (s.material_label) o.material_label = s.material_label;
  return o;
}

// 公开：健康检查
// 开机自动入库的逐课报告：更新脚本用健康检查核对它（2026-09-30 二审三10）
let seedReport = [];
app.get('/api/health', (req, res) => {
  const lessons = {};
  try {
    for (const r of db.prepare('SELECT lesson_id, COUNT(*) c FROM items GROUP BY lesson_id').all()) {
      lessons[r.lesson_id] = r.c;
    }
  } catch { /* 表不存在时就空着 */ }
  const seedErrors = seedReport.filter(r => r.error).map(r => ({ lesson_id: r.lesson_id, error: r.error }));
  res.json({
    ok: true,
    uptime_secs: Math.floor((Date.now() - bootTime) / 1000),
    lessons,                       // 各课题目条数，如 {u2r1:20,u2r2:19}
    seed: { ok: seedErrors.length === 0, errors: seedErrors },  // 自动入库失败会在这里标出
    today: shanghaiDay(),          // 服务端认为的北京时间日期（供核对时区）
  });
});

// 公开：首次设置访问码（需一次性设置口令）
app.post('/api/setup', (req, res) => {
  const { setup_token, access_code } = req.body || {};
  const r = auth.trySetup(setup_token, access_code);
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason });
  // 设置成功：删掉一次性口令文件
  try { fs.unlinkSync(path.join(process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data'), 'setup_token.txt')); } catch {}
  res.json({ ok: true });
});

// 公开：访问码校验（限速）
app.post('/api/verify', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (auth.verifyRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }
  const { access_code } = req.body || {};
  if (!auth.isSetupDone()) {
    return res.status(400).json({ ok: false, error: 'not_setup' });
  }
  if (!auth.checkVerifyCode(access_code)) {
    return res.status(401).json({ ok: false, error: 'bad_code' });
  }
  auth.verifyRateReset(ip);
  auth.issueAuthCookie(res);
  res.json({ ok: true });
});

// 需验证
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ ok: true }));
// 学习地图用：返回服务器真实进度（lesson_state 表为准）
// completed: 两部分都完成的课；started: 学过但没学完的课（含作答时间）；
// current: 最近在学的那门课。2026-10-11 修复：attempts 表没有 lesson_id 列，
// 旧写法 SELECT DISTINCT lesson_id FROM attempts 直接报错被吞，永远返回 ok:false。
app.get('/api/done-lessons', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const rows = db.prepare(
      'SELECT lesson_id, p1_done, p2_done, p1_started_day, updated_at FROM lesson_state'
    ).all();
    const seen = new Set();
    const completed = [], started = [];
    let current = null, latestT = '';
    const touch = (id, t) => { if (id && t >= latestT) { latestT = t; current = id; } };
    for (const r of rows) {
      if (!r || !r.lesson_id || seen.has(r.lesson_id)) continue;
      seen.add(r.lesson_id);
      const done = r.p1_done === 1 && r.p2_done === 1;
      const active = r.p1_started_day || r.p1_done === 1 || r.p2_done === 1;
      const t = r.updated_at || '';
      if (done) { completed.push(r.lesson_id); }
      else if (active) { started.push({ id: r.lesson_id, updated_at: t }); touch(r.lesson_id, t); }
    }
    // 兜底：attempts 里有作答、但 lesson_state 没行的旧数据，也算 started
    try {
      const arows = db.prepare(
        "SELECT substr(item_id, 1, instr(item_id, '-') - 1) AS lid, MAX(created_at) AS mx " +
        "FROM attempts WHERE item_id LIKE '%-%' GROUP BY lid"
      ).all();
      for (const a of arows) {
        if (!a.lid || seen.has(a.lid)) continue;
        seen.add(a.lid);
        started.push({ id: a.lid, updated_at: a.mx || '' });
        touch(a.lid, a.mx || '');
      }
    } catch (e2) { console.error('[done-lessons] attempts 兜底失败:', e2.message); }
    completed.sort(); started.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
    res.json({ ok: true, completed, started, current, lessons: completed });
  } catch (e) {
    console.error('[done-lessons]', e.message);
    res.json({ ok: false, error: 'db_error', completed: [], started: [], current: null, lessons: [] });
  }
});

// ---- 每日签到（2026-10-11 Elouise 要加）：上海自然日，一天一行，服务端落盘 ----
function addDaysStr(dayStr, n) {
  const parts = String(dayStr).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + n * 86400000).toISOString().slice(0, 10);
}
function weekdayLabel(dayStr) {
  const wd = new Date(dayStr + 'T12:00:00+08:00').getDay();
  return ['日', '一', '二', '三', '四', '五', '六'][wd];
}
function checkinStatus() {
  const today = shanghaiDay();
  const set = new Set();
  try {
    for (const r of db.prepare('SELECT day FROM checkins').all()) {
      if (r && r.day) set.add(r.day);
    }
  } catch (e) { console.error('[checkin] read', e.message); }
  const checked_today = set.has(today);
  // 连续天数：今天已签就从今天往回数，还没签就从昨天往回数
  let streak = 0;
  let cursor = checked_today ? today : addDaysStr(today, -1);
  let guard = 0;
  while (set.has(cursor) && guard++ < 3650) { streak++; cursor = addDaysStr(cursor, -1); }
  // 最近7天（含今天）- 保留兼容
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = addDaysStr(today, -i);
    week.push({ day, label: '周' + weekdayLabel(day), checked: set.has(day), isToday: day === today });
  }
  // 本月日历（2026-10-12加）：返回本月每天的签到状态
  const [y, m] = today.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstWeekday = new Date(y, m - 1, 1).getDay(); // 0=周日
  const month = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    month.push({ day: d, date: dayStr, checked: set.has(dayStr), isToday: dayStr === today, isFuture: dayStr > today });
  }
  return { ok: true, today, checked_today, streak, total: set.size, week, month, monthLabel: `${y}年${m}月`, firstWeekday };
}
app.get('/api/checkin', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(checkinStatus()); }
  catch (e) { console.error('[checkin]', e.message); res.json({ ok: false }); }
});
app.post('/api/checkin', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    db.prepare("INSERT OR IGNORE INTO checkins(day, kind, created_at) VALUES(?, 'manual', datetime('now'))").run(shanghaiDay());
  } catch (e) { console.error('[checkin] write', e.message); }
  const newTitles = checkTitles(); // 签到可能触发"坚持小勇士"
  try { res.json({ ...checkinStatus(), newTitles }); }
  catch (e) { console.error('[checkin]', e.message); res.json({ ok: false }); }
});
app.get('/api/lessons', auth.requireAuth, (req, res) => {
  // 2026-10-11：课程数据修好后浏览器仍显示旧版（u2r5 事件），动态接口一律禁缓存，
  // 以后更新孩子直接刷新页面就行，永远不需要清缓存/强制刷新
  res.set('Cache-Control', 'no-store');
  const rows = db.prepare('SELECT lesson_id, title, status FROM lessons ORDER BY created_at').all();
  // 2026-10-12：返回每门课是否解锁，前端用于显示🔒和过滤"继续学习"
  const lessons = rows.map(r => ({ ...r, open: lessonOpen(r.lesson_id) }));
  res.json({ lessons });
});

// 学习小结：默认按一次走课（session_id）统计；带 ?lesson= 时按整课聚合（完成页用）
// 2026-10-02：完成页原先用浏览器 localStorage 里的 session_id 查，存储一丢就显示 0；
// 改为按课向服务器查，不依赖浏览器，清数据/换浏览器结果也一致。
app.get('/api/summary', auth.requireAuth, (req, res) => {
  if (req.query.lesson) {
    const lid = String(req.query.lesson);
    if (!validLesson(lid)) return badLesson(res);
    const agg = lessonAgg(lid);
    return res.json({
      independent: agg.independent, helped: agg.helped,
      items: agg.items, weaknesses: agg.weaknesses,
    });
  }
  const sid = String(req.query.session_id || '');
  const rows = db.prepare(
    `SELECT item_id, MAX(independent) AS ind, MAX(helped) AS helped, MAX(correct) AS correct
     FROM attempts WHERE session_id=? GROUP BY item_id`
  ).all(sid);
  let independent = 0, helped = 0;
  for (const r of rows) {
    if (r.ind) independent++;
    if (r.helped && r.correct) helped++; // 中文作答的题会同时计入（内容独立、书写用了帮助）
  }
  const weak = db.prepare(
    'SELECT DISTINCT tag FROM weakness_events WHERE session_id=?').all(sid).map(r => r.tag);
  res.json({ independent, helped, items: rows.length, weaknesses: weak });
});

// 家长一句话报告（2026-10-02，真人老师规范第 8 条）：课末给家长一句话——
// 学会了什么（独立/有帮助完成数）、哪里还弱（弱点译成给家长看的话）、用了多久。
// 聚合口径与 /api/summary?lesson= 一致（版本归一化）。
const WEAK_PARENT = { old_info: '分清新旧通知', spelling: '单词拼写', omission: '把时间地点写全' };
const WEAK_PARENT_SX = { old_info: '审题看条件', spelling: '计算准确性', omission: '步骤写完整' };
const WEAK_PARENT_YW = { old_info: '分清新旧信息', spelling: '字词书写', omission: '要点写全' };
app.get('/api/parent-report', auth.requireAuth, (req, res) => {
  const lid = String(req.query.lesson || '');
  if (!lid || !validLesson(lid)) return badLesson(res);
  const L = loadLesson(lid);
  const agg = lessonAgg(lid);
  const st = lessonState(lid);
  const done = st.p1_done === 1 && st.p2_done === 1;
  // 弱点：先从作答明细归因（旧信息/拼写/漏项），再加上弱点事件标签（如英文书写）
  const kindByItem = new Map(
    db.prepare('SELECT item_id, kind FROM items WHERE lesson_id=?').all(lid)
      .map(r => [r.item_id, r.kind]));
  const attRows = db.prepare(
    'SELECT item_id, verdict, detail_json FROM attempts WHERE item_id LIKE ? ORDER BY id'
  ).all(lid + '-%');
  const byWeak = { old_info: 0, spelling: 0, omission: 0 };
  for (const r of attRows) {
    const w = review.classify(kindByItem.get(r.item_id), r);
    if (w in byWeak) byWeak[w]++;
  }
  const weaknesses = [];
  const WP = /^sx-/.test(lid) ? WEAK_PARENT_SX : (/^yw-/.test(lid) ? WEAK_PARENT_YW : WEAK_PARENT);
  for (const w of ['old_info', 'spelling', 'omission']) {
    if (byWeak[w] > 0) weaknesses.push(WP[w]);
  }
  for (const t of agg.weaknesses) {
    // 语文课过滤（2026-10-18）："英文书写"是英语课概念，yw- 课不显示
    if (/^yw-/.test(lid) && t === '英文书写') continue;
    const label = t === '英文书写' ? '用英文把句子写出来' : (t === '拼写' ? '单词拼写'
      : (t === '看答案过' ? '看过答案的题要重练' : t));
    if (!weaknesses.includes(label)) weaknesses.push(label);
  }
  const minutes = Math.round((agg.totalMs || 0) / 60000);
  const title = (L && L.lesson.title) || lid;
  let sentence;
  if (!attRows.length) {
    sentence = '孩子还没有开始这一课。';
  } else {
    const learn = done
      ? `孩子学完了《${title}》`
      : `孩子正在学《${title}》`;
    const timePart = minutes >= 1 ? `一共用了大约 ${minutes} 分钟` : '一共用时不到 1 分钟（多半是试一点就停了）';
    const weakPart = weaknesses.length
      ? `还要多练：${weaknesses.slice(0, 3).join('、')}`
      : '暂时没有发现明显的薄弱点';
    sentence = `${learn}：${agg.items} 道题里独立完成 ${agg.independent} 道、看提示后完成 ${agg.helped} 道；${weakPart}；${timePart}。`;
  }
  res.json({
    lesson: lid, title, done,
    independent: agg.independent, helped: agg.helped, items: agg.items,
    weaknesses: weaknesses.slice(0, 3), minutes, sentence,
  });
});

// 改访问码（需已登录 + 现码验证）：换码同时轮换 Cookie 签名密钥，老 Cookie 立即失效，
// 本人拿新签发的 Cookie 继续（Elouise 2026-10-02：只有改码才让老登录失效）。
app.post('/api/change-access-code', auth.requireAuth, (req, res) => {
  const { current_code, new_code } = req.body || {};
  if (!auth.checkVerifyCode(current_code)) {
    return res.status(401).json({ ok: false, error: 'bad_code' });
  }
  if (!new_code || String(new_code).length < auth.CODE_MIN_LEN) {
    return res.status(400).json({ ok: false, error: 'weak_code' });
  }
  auth.changeAccessCode(String(new_code));
  auth.issueAuthCookie(res); // 给改码的人换发新 Cookie
  res.json({ ok: true });
});

// 课程进度（服务端记录）：完成即学 + 防重做
// 第二部分开放规则（2026-10-02 总任务书取消两天制）：第一部分完成即可学第二部分，
// 前端版本检测（2026-10-14）：服务端重启/重新部署后，前端自动重载拿新JS，避免"修了但浏览器还是旧代码"
const SERVER_BOOT_TIME = Date.now();
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, version: SERVER_BOOT_TIME });
});

// 2026-10-18：学习活跃度探针（给推送门禁 watch 用）
// 返回最近一次作答时间（UTC），推送前判断孩子是否正在学，避免重启打断
app.get('/api/activity', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = db.prepare('SELECT MAX(created_at) AS m FROM attempts').get();
    res.json({ ok: true, last_attempt: r && r.m ? r.m : null });
  } catch { res.json({ ok: true, last_attempt: null }); }
});

// 不再等到第二天。p1_started_day 仍记录（历史数据），只是不再作为开放条件。
app.get('/api/state', auth.requireAuth, (req, res) => {
  if (req.query.lesson && !validLesson(String(req.query.lesson))) return badLesson(res);
  const lid = String(req.query.lesson || 'u2r1');
  const st = lessonState(lid);
  const today = shanghaiDay();
  const p2_open = st.p1_done === 1;
  res.json({
    p1_done: st.p1_done === 1, p2_done: st.p2_done === 1,
    p2_open: !!p2_open, today,
    p2_note: st.p1_done ? '' : '完成第一部分后，就可以学第二部分',
  });
});

// 开始一部分：记录第一部分开始的上海自然日（只记第一次）
app.post('/api/start', auth.requireAuth, (req, res) => {
  const part = Number((req.body || {}).part);
  if ((req.body || {}).lesson && !validLesson(String((req.body || {}).lesson))) return badLesson(res);
  const lid = String((req.body || {}).lesson || 'u2r1');
  if (part === 1) {
    const st = lessonState(lid);
    if (!st.p1_started_day) {
      db.prepare("UPDATE lesson_state SET p1_started_day=?, updated_at=datetime('now') WHERE lesson_id=?")
        .run(shanghaiDay(), lid);
    }
  }
  res.json({ ok: true });
});

// 完成一部分：服务端记 done；之后该部分的作答一律拒绝（清浏览器数据/换浏览器也一样）
app.post('/api/complete', auth.requireAuth, (req, res) => {
  const part = Number((req.body || {}).part);
  if ((req.body || {}).lesson && !validLesson(String((req.body || {}).lesson))) return badLesson(res);
  const lid = String((req.body || {}).lesson || 'u2r1');
  if (part === 1) db.prepare("UPDATE lesson_state SET p1_done=1, updated_at=datetime('now') WHERE lesson_id=?").run(lid);
  else if (part === 2) db.prepare("UPDATE lesson_state SET p2_done=1, updated_at=datetime('now') WHERE lesson_id=?").run(lid);
  else return res.status(400).json({ ok: false, error: 'bad_part' });
  // Unit 3 专项巩固过关检查（2026-10-11 Elouise：零求助、独立手写正确率≥85%才解锁Unit 4）
  let consolidationPassed = null;
  if (lid === 'u3-consolidate' && part === 2) {
    consolidationPassed = checkConsolidationPass();
    if (consolidationPassed) {
      db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES('u3_consolidation_done', '1')").run();
    }
  }
  // 称号检查（2026-10-12）：课程完成时判定 mastery-based 称号
  const newTitles = checkTitles();
  res.json({ ok: true, consolidationPassed, newTitles });
});

// 称号列表：返回全部称号定义 + 已获得状态
// 2026-10-18 史诗级：称号进度计算（供 /api/titles 和 checkTitles 共用）
function getTitleProgressMap() {
  const progressData = {};
  try {
    const mistakeCount = db.prepare("SELECT COUNT(DISTINCT item_id) as c FROM retest_queue WHERE status='resolved'").get();
    progressData.mistake = mistakeCount ? mistakeCount.c : 0;
    const qCount = db.prepare("SELECT COUNT(*) as c FROM attempts").get();
    progressData.questions = qCount ? qCount.c : 0;
    const qcCount = db.prepare("SELECT COUNT(*) as c FROM attempts WHERE correct=1").get();
    progressData.correct = qcCount ? qcCount.c : 0;
    const cCount = db.prepare("SELECT COUNT(*) as c FROM lesson_state WHERE p1_done=1 AND p2_done=1").get();
    progressData.courses = cCount ? cCount.c : 0;
    const wCount = db.prepare("SELECT COUNT(*) as c FROM word_mastery WHERE level>=4").get();
    progressData.words = wCount ? wCount.c : 0;
    const sCount = db.prepare("SELECT COUNT(DISTINCT day) as c FROM checkins WHERE kind='manual'").get();
    progressData.signin = sCount ? sCount.c : 0;
    const chCount = db.prepare("SELECT COUNT(DISTINCT day) as c FROM checkins WHERE kind='challenge'").get();
    progressData.challenge = chCount ? chCount.c : 0;
    const rCount = db.prepare("SELECT COUNT(*) as c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND lesson_id LIKE '%review%'").get();
    progressData.review = rCount ? rCount.c : 0;
    const weCount = db.prepare("SELECT COUNT(*) as c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND strftime('%w', datetime(updated_at, '+8 hours')) IN ('0', '6')").get();
    progressData.weekend = weCount ? weCount.c : 0;
    progressData.minutes = (progressData.questions || 0) * 1.5;
  } catch (e) {}
  return {
    'mistake_10': { current: progressData.mistake || 0, target: 10 },
    'mistake_50': { current: progressData.mistake || 0, target: 50 },
    'mistake_200': { current: progressData.mistake || 0, target: 200 },
    'mistake_500': { current: progressData.mistake || 0, target: 500 },
    'mistake_slayer': { current: progressData.mistake || 0, target: 100 },
    'questions_100': { current: progressData.questions || 0, target: 100 },
    'questions_500': { current: progressData.questions || 0, target: 500 },
    'questions_1000': { current: progressData.questions || 0, target: 1000 },
    'questions_2000': { current: progressData.questions || 0, target: 2000 },
    'century': { current: progressData.correct || 0, target: 1000 },
    'courses_5': { current: progressData.courses || 0, target: 5 },
    'courses_10': { current: progressData.courses || 0, target: 10 },
    'courses_15': { current: progressData.courses || 0, target: 15 },
    'courses_20': { current: progressData.courses || 0, target: 20 },
    'word_50': { current: progressData.words || 0, target: 50 },
    'word_150': { current: progressData.words || 0, target: 150 },
    'word_250': { current: progressData.words || 0, target: 250 },
    'word_350': { current: progressData.words || 0, target: 350 },
    'vocab_master_50': { current: progressData.words || 0, target: 50 },
    'vocab_master_100': { current: progressData.words || 0, target: 100 },
    'signin_14': { current: progressData.signin || 0, target: 14 },
    'signin_21': { current: progressData.signin || 0, target: 21 },
    'signin_36': { current: progressData.signin || 0, target: 36 },
    'signin_100': { current: progressData.signin || 0, target: 100 },
    'signin_120': { current: progressData.signin || 0, target: 120 },
    'streak_warrior': { current: progressData.signin || 0, target: 7 },
    'challenge_streak_3': { current: progressData.challenge || 0, target: 3 },
    'challenge_streak_7': { current: progressData.challenge || 0, target: 7 },
    'challenge_streak_14': { current: progressData.challenge || 0, target: 14 },
    'challenge_streak_30': { current: progressData.challenge || 0, target: 30 },
    'challenge_streak_60': { current: progressData.challenge || 0, target: 60 },
    'daily_7': { current: progressData.challenge || 0, target: 7 },
    'daily_30': { current: progressData.challenge || 0, target: 30 },
    'daily_challenger': { current: progressData.challenge || 0, target: 3 },
    'review_3': { current: progressData.review || 0, target: 3 },
    'review_10': { current: progressData.review || 0, target: 10 },
    'weekend_50': { current: progressData.weekend || 0, target: 50 },
    'weekend_100': { current: progressData.weekend || 0, target: 100 },
    'minutes_60': { current: Math.floor(progressData.minutes || 0), target: 60 },
    'minutes_300': { current: Math.floor(progressData.minutes || 0), target: 300 },
    'minutes_900': { current: Math.floor(progressData.minutes || 0), target: 900 },
    'minutes_1800': { current: Math.floor(progressData.minutes || 0), target: 1800 },
    'minutes_3600': { current: Math.floor(progressData.minutes || 0), target: 3600 },
  };
}

app.get('/api/titles', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const earned = new Set(db.prepare('SELECT title_id FROM titles').all().map(r => r.title_id));
    const progressMap = getTitleProgressMap();
    res.json({
      ok: true,
      titles: TITLE_DEFS.map(t => ({
        ...t,
        earned: earned.has(t.id),
        progress: progressMap[t.id] || null,
      })),
    });
  } catch (e) {
    res.json({ ok: false, titles: [] });
  }
});

// 成长档案（2026-10-12）：给家长看的学生画像+趋势+弱点，大白话
// 2026-10-18：每晚深度画像覆盖（定时任务 23 点写入 nightly_profile，36 小时内优先显示）
function nightlyProfileOverride(fallback) {
  try {
    const row = db.prepare("SELECT value FROM app_state WHERE key='nightly_profile'").get();
    if (!row || !row.value) return fallback;
    const p = JSON.parse(row.value);
    if (!p || !p.date) return fallback;
    const ageH = (Date.now() - new Date(p.date + 'T23:59:59+08:00').getTime()) / 36e5;
    if (!(ageH > -3 && ageH < 36)) return fallback; // 允许当天提前写入（负数）
    return {
      summary: p.summary || fallback.summary,
      weaknesses: (Array.isArray(p.weaknesses) && p.weaknesses.length) ? p.weaknesses : fallback.weaknesses,
      strengths: (Array.isArray(p.strengths) && p.strengths.length) ? p.strengths : fallback.strengths,
      nightly_date: p.date,
    };
  } catch { return fallback; }
}

app.get('/api/growth', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    // --- 弱点清单：按出现次数排序 ---
    const wrows = db.prepare(
      `SELECT tag, COUNT(*) as c, MAX(date(created_at)) as last
       FROM weakness_events GROUP BY tag ORDER BY c DESC`
    ).all();
    const weakness_list = wrows.map(r => ({
      tag: r.tag, count: r.c, last: r.last || '',
    }));

    // --- 近7天趋势：每天做题数、正确率 ---
    const trows = db.prepare(
      `SELECT date(created_at) as d, COUNT(*) as n,
              ROUND(100.0 * SUM(correct) / COUNT(*)) as rate
       FROM attempts
       WHERE date(created_at) >= date('now', '-6 days')
       GROUP BY d ORDER BY d`
    ).all();
    // 补全7天（含0做题的日子），日期显示 MM-DD
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      const key = d.toISOString().slice(0, 10);
      const label = key.slice(5); // MM-DD
      const row = trows.find(r => r.d === key);
      trend.push({
        date: label,
        attempts: row ? row.n : 0,
        rate: row ? Math.round(row.rate) : null,
      });
    }

    // --- 本周（周一起）汇总 ---
    const wrow = db.prepare(
      `SELECT COUNT(*) as n,
              ROUND(100.0 * SUM(correct) / COUNT(*)) as rate
       FROM attempts
       WHERE date(created_at) >= date('now', 'weekday 0', '-7 days')`
    ).get() || { n: 0, rate: null };
    const lessonsDone = db.prepare(
      `SELECT COUNT(*) as c FROM lesson_state
       WHERE p2_done = 1 AND date(updated_at) >= date('now', 'weekday 0', '-7 days')`
    ).get();
    const weekly = {
      minutes: Math.round((wrow.n || 0) * 1.5), // 估算：每题1.5分钟
      lessons: (lessonsDone && lessonsDone.c) || 0,
      avg_rate: wrow.rate != null ? Math.round(wrow.rate) : null,
      attempts: wrow.n || 0,
    };

    // --- 画像：弱点 top3 + 强项 ---
    const topWeak = weakness_list.slice(0, 3).map(w => w.tag);
    // 强项：从已获称号推导；没有称号就看坚持情况
    const earnedTitles = db.prepare('SELECT title_id FROM titles').all().map(r => r.title_id);
    const titleToStrength = {
      comparative_master: '比较级掌握牢固',
      superlative_slayer: '最高级拿手',
      spelling_star: '拼写过关',
      streak_warrior: '学习习惯好',
      unit3_conqueror: 'Unit 3 已吃透',
    };
    const strengths = earnedTitles
      .map(id => titleToStrength[id])
      .filter(Boolean);
    if (strengths.length === 0) {
      const chk = db.prepare('SELECT COUNT(*) as c FROM checkins').get();
      if (chk && chk.c >= 3) strengths.push('坚持学习');
      // 选择题正确率高也算强项
      const mcq = db.prepare(
        `SELECT ROUND(100.0*SUM(correct)/COUNT(*)) as r FROM attempts
         WHERE item_id LIKE '%-t%' AND date(created_at) >= date('now','-14 days')`
      ).get();
      if (mcq && mcq.r != null && mcq.r >= 80) strengths.push('选择题识别能力不错');
    }

    // --- 一句话总结 ---
    let summary = '还在积累数据，多做几天就能看出画像。';
    if (topWeak.length > 0) {
      const weakStr = topWeak.join('、');
      // 看当前在攻哪块：最近学的课
      const cur = db.prepare(
        `SELECT lesson_id FROM lesson_state WHERE p2_done = 0
         ORDER BY updated_at DESC LIMIT 1`
      ).get();
      const lessonName = cur ? cur.lesson_id : '';
      if (/u3/.test(lessonName)) {
        summary = `正在巩固 Unit 3（比较级/最高级），${weakStr}是目前的短板。`;
      } else if (/u4/.test(lessonName)) {
        summary = `正在学 Unit 4（被动语态），${weakStr}需要多注意。`;
      } else {
        summary = `目前${weakStr}是短板，正在针对性加强。`;
      }
    } else if (strengths.length > 0) {
      summary = `学得不错，${strengths.join('、')}，继续保持。`;
    }

    res.json({
      ok: true,
      profile: nightlyProfileOverride({ summary, weaknesses: topWeak, strengths }),
      trend,
      weakness_list,
      weekly,
    });
  } catch (e) {
    res.json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---- 称号系统（2026-10-12 Elouise：mastery-based，不是打卡）----
// 称号必须绑定真实掌握度，孩子看到称号就知道"我真学会了什么"
const TITLE_DEFS = [
  {
    id: 'comparative_master', name: '比较级小达人', icon: '🏅',
    desc: '完成 Unit 3 专项巩固，零求助、独立正确率≥85%', cat: '突破', rarity: '稀有' },
  {
    id: 'superlative_slayer', name: '最高级终结者', icon: '⚔️',
    desc: '完成最高级专项复习（加练3），正确率≥90%', cat: '突破', rarity: '稀有' },
  {
    id: 'spelling_star', name: '拼写小能手', icon: '✏️',
    desc: '连续答对20道拼写题（零求助）', cat: '突破', rarity: '普通' },
  {
    id: 'streak_warrior', name: '坚持小勇士', icon: '🔥',
    desc: '连续签到7天', cat: '坚持', rarity: '普通' },
  {
    id: 'unit3_conqueror', name: 'Unit 3 征服者', icon: '👑',
    desc: 'u3r1-u3r5全部完成，平均正确率≥80%', cat: '学业', rarity: '稀有' },
  // 2026-10-13 Elouise要求：称号墙补到U4/U5/U6
  {
    id: 'passive_voice_pro', name: '被动语态达人', icon: '🔧',
    desc: 'u4r1-u4r5全部完成，平均正确率≥80%', cat: '学业', rarity: '稀有' },
  {
    id: 'unit4_conqueror', name: 'Unit 4 征服者', icon: '🏭',
    desc: '完成 Unit 4 全部课程（发明主题）', cat: '学业', rarity: '稀有' },
  {
    id: 'present_perfect_master', name: '现在完成时高手', icon: '⏳',
    desc: 'u5r1-u5r5全部完成，平均正确率≥80%', cat: '学业', rarity: '稀有' },
  {
    id: 'unit5_conqueror', name: 'Unit 5 征服者', icon: '✈️',
    desc: '完成 Unit 5 全部课程（交流主题）', cat: '学业', rarity: '稀有' },
  {
    id: 'unit6_conqueror', name: 'Unit 6 征服者', icon: '🏛️',
    desc: 'u6r1-u6r5全部完成，平均正确率≥80%', cat: '学业', rarity: '史诗' },
  // 2026-10-14 Elouise要求：错题成就（2026-10-14 19:05加难度：太容易，提10-20倍）
  {
    id: 'mistake_slayer', name: '错题克星', icon: '🗡️',
    desc: '累计消灭100道待复测错题（零帮助独立答对）', cat: '探索', rarity: '稀有' },
  {
    id: 'comeback_kid', name: '知错就改', icon: '💪',
    desc: '从错题本重做20道题并答对', cat: '探索', rarity: '普通' },
  {
    id: 'daily_challenger', name: '闯关达人', icon: '🎯',
    desc: '完成3次每日闯关', cat: '坚持', rarity: '稀有' },
  // 2026-10-15 Elouise要求：连闯/签到系列称号
  {
    id: 'challenge_streak_7', name: '连闯七天', icon: '🔥',
    desc: '连续7天完成今日闯关', cat: '坚持', rarity: '稀有' },
  {
    id: 'signin_14', name: '半月坚持', icon: '📅',
    desc: '连续签到14天', cat: '坚持', rarity: '普通' },
  {
    id: 'signin_21', name: '三周习惯', icon: '🌱',
    desc: '连续签到21天', cat: '坚持', rarity: '普通' },
  {
    id: 'signin_36', name: '月余不辍', icon: '🏵️',
    desc: '连续签到36天', cat: '坚持', rarity: '稀有' },
  {
    id: 'signin_100', name: '百日筑基', icon: '💯',
    desc: '连续签到100天', cat: '坚持', rarity: '史诗' },
  {
    id: 'signin_120', name: '百廿持恒', icon: '👑',
    desc: '连续签到120天', cat: '坚持', rarity: '史诗' },
  {
    id: 'irregular_slayer', name: '不规则克星', icon: '⚡',
    desc: '不规则变化6道题全部独立答对', cat: '突破', rarity: '普通' },
  // 2026-10-16 Elouise要求：加20个成就（连胜闯关/单词学习/错题累积/做题数/课程数）
  // ——— 每天连胜闯关（4） ———
  { id: 'challenge_streak_3', name: '连闯三天', icon: '🔥', desc: '连续3天完成今日闯关', cat: '坚持', rarity: '普通' },
  { id: 'challenge_streak_14', name: '连闯两周', icon: '🌟', desc: '连续14天完成今日闯关', cat: '坚持', rarity: '史诗' },
  { id: 'challenge_streak_30', name: '月度闯关王', icon: '👑', desc: '连续30天完成今日闯关', cat: '坚持', rarity: '史诗' },
  { id: 'challenge_streak_60', name: '闯关传奇', icon: '💎', desc: '连续60天完成今日闯关', cat: '传奇', rarity: '传说' },
  // ——— 单词学习（4） ———
  { id: 'word_50', name: '单词新秀', icon: '📝', desc: '单词学习累计掌握50个词', cat: '探索', rarity: '稀有' },
  { id: 'word_150', name: '单词能手', icon: '📚', desc: '单词学习累计掌握150个词', cat: '探索', rarity: '史诗' },
  { id: 'word_250', name: '单词大师', icon: '🎓', desc: '单词学习累计掌握250个词', cat: '探索', rarity: '史诗' },
  { id: 'word_350', name: '单词王者', icon: '👑', desc: '单词学习累计掌握350个词（全掌握）', cat: '传奇', rarity: '传说' },
  // ——— 错题累积（4） ———
  { id: 'mistake_10', name: '初露锋芒', icon: '🗡️', desc: '累计消灭10道错题', cat: '探索', rarity: '普通' },
  { id: 'mistake_50', name: '错题猎人', icon: '🏹', desc: '累计消灭50道错题', cat: '探索', rarity: '稀有' },
  { id: 'mistake_200', name: '错题终结者', icon: '⚔️', desc: '累计消灭200道错题', cat: '探索', rarity: '史诗' },
  { id: 'mistake_500', name: '错题传奇', icon: '🌟', desc: '累计消灭500道错题', cat: '传奇', rarity: '传说' },
  // ——— 整体做题数（4） ———
  { id: 'questions_100', name: '小试牛刀', icon: '🎯', desc: '累计做题100道', cat: '学业', rarity: '普通' },
  { id: 'questions_500', name: '渐入佳境', icon: '📈', desc: '累计做题500道', cat: '学业', rarity: '稀有' },
  { id: 'questions_1000', name: '题海无涯', icon: '🌊', desc: '累计做题1000道', cat: '学业', rarity: '史诗' },
  { id: 'questions_2000', name: '题王', icon: '👑', desc: '累计做题2000道', cat: '传奇', rarity: '传说' },
  // ——— 做完课程数（4） ———
  { id: 'courses_5', name: '初涉课堂', icon: '🚪', desc: '累计完成5节课', cat: '学业', rarity: '普通' },
  { id: 'courses_10', name: '学有所成', icon: '📖', desc: '累计完成10节课', cat: '学业', rarity: '稀有' },
  { id: 'courses_15', name: '学富五车', icon: '🎒', desc: '累计完成15节课', cat: '学业', rarity: '史诗' },
  { id: 'courses_20', name: '全部征服', icon: '🏆', desc: '累计完成20节课', cat: '传奇', rarity: '传说' },
  // 2026-10-16 Elouise要求：加4个累计学习分钟数成就 + 10个其他新成就
  // ——— 累计学习分钟数（4） ———
  { id: 'minutes_60', name: '初涉学海', icon: '⏱️', desc: '累计学习60分钟', cat: '坚持', rarity: '普通' },
  { id: 'minutes_300', name: '渐入佳境', icon: '⏰', desc: '累计学习300分钟（5小时）', cat: '坚持', rarity: '普通' },
  { id: 'minutes_900', name: '持之以恒', icon: '🕐', desc: '累计学习900分钟（15小时）', cat: '坚持', rarity: '普通' },
  { id: 'minutes_1800', name: '学霸本色', icon: '👑', desc: '累计学习1800分钟（30小时）', cat: '坚持', rarity: '普通' },
  // ——— 其他新成就（10） ———
  { id: 'review_3', name: '复习达人', icon: '📝', desc: '完成3节复习课', cat: '学业', rarity: '普通' },
  { id: 'independent_5', name: '自力更生', icon: '💪', desc: '零求助完成5节课', cat: '突破', rarity: '普通' },
  { id: 'streak_15', name: '连对高手', icon: '🔥', desc: '连续答对15道题（零求助）', cat: '突破', rarity: '普通' },
  { id: 'retry_10', name: '知错能改', icon: '🔄', desc: '重做答对10道题', cat: '探索', rarity: '普通' },
  { id: 'vocab_30', name: '生词收藏家', icon: '📚', desc: '生词本收藏30个词', cat: '探索', rarity: '普通' },
  { id: 'perfect_1', name: '满分闯关', icon: '💯', desc: '每日闯关获得满分', cat: '突破', rarity: '普通' },
  { id: 'morning_1', name: '早起鸟', icon: '🌅', desc: '早上7点前完成一节课', cat: '坚持', rarity: '普通' },
  { id: 'night_1', name: '夜读星', icon: '🌙', desc: '晚上22点后完成一节课', cat: '坚持', rarity: '普通' },
  { id: 'weekend_50', name: '周末学霸', icon: '📅', desc: '周末累计完成50节课', cat: '坚持', rarity: '普通' },
  { id: 'no_typo_50', name: '火眼金睛', icon: '👁️', desc: '连续50道题无错误', cat: '突破', rarity: '普通' },

  // 2026-10-17 Elouise：补齐到80个——等级制+新类别
  { id: 'streak_30', name: '连对大师', icon: '🔥', desc: '连续答对30道（零求助）', cat: '突破', rarity: '普通' },
  { id: 'streak_50', name: '连对宗师', icon: '💥', desc: '连续答对50道（零求助）', cat: '突破', rarity: '普通' },
  { id: 'minutes_3600', name: '学霸本色·金', icon: '⏰', desc: '累计学习3600分钟（60小时）', cat: '坚持', rarity: '普通' },
  { id: 'vocab_100', name: '生词大户', icon: '📚', desc: '生词本100个词', cat: '探索', rarity: '普通' },
  { id: 'review_10', name: '复习专家', icon: '🔄', desc: '完成10节复习课', cat: '学业', rarity: '普通' },
  { id: 'independent_10', name: '独立大师', icon: '💪', desc: '零求助完成10节课', cat: '突破', rarity: '普通' },
  { id: 'retry_30', name: '知错能改·金', icon: '🛠️', desc: '重做答对30道', cat: '探索', rarity: '普通' },
  { id: 'perfect_3', name: '满分常客', icon: '💯', desc: '每日闯关满分3次', cat: '突破', rarity: '普通' },
  { id: 'vocab_master_50', name: '词汇小成', icon: '📖', desc: '50个单词达到掌握级', cat: '探索', rarity: '普通' },
  { id: 'vocab_master_100', name: '词汇大师', icon: '👑', desc: '100个单词达到掌握级', cat: '探索', rarity: '普通' },
  { id: 'morning_7', name: '早起习惯', icon: '🌅', desc: '7天早上7点前学习', cat: '坚持', rarity: '普通' },
  { id: 'night_7', name: '夜读习惯', icon: '🌙', desc: '7天晚上22点后学习', cat: '坚持', rarity: '普通' },
  { id: 'daily_7', name: '闯关一周', icon: '🎯', desc: '完成7天每日闯关', cat: '坚持', rarity: '普通' },
  { id: 'daily_30', name: '闯关一月', icon: '🏆', desc: '完成30天每日闯关', cat: '坚持', rarity: '普通' },
  { id: 'no_typo_100', name: '火眼金睛·金', icon: '👁️', desc: '连续100道无错误', cat: '突破', rarity: '普通' },
  { id: 'help_free_20', name: '独立20连', icon: '🚀', desc: '连续20道零求助', cat: '突破', rarity: '普通' },
  { id: 'weekend_100', name: '周末战神', icon: '⚔️', desc: '周末累计完成100节课', cat: '坚持', rarity: '普通' },
  { id: 'midnight_oil', name: '夜猫子', icon: '🦉', desc: '凌晨0-5点完成学习（隐藏）', cat: '传奇', rarity: '普通' },
  { id: 'first_light', name: '破晓者', icon: '🌄', desc: '早上5-6点完成学习（隐藏）', cat: '传奇', rarity: '普通' },
  { id: 'marathon', name: '马拉松', icon: '🏃', desc: '单日学习超过120分钟', cat: '坚持', rarity: '普通' },
  { id: 'comeback', name: '卷土重来', icon: '💫', desc: '同一道错题重做3次后答对', cat: '探索', rarity: '普通' },
  { id: 'perfectionist', name: '完美主义', icon: '✨', desc: '单节课100%正确率（20题+）', cat: '突破', rarity: '普通' },
  { id: 'explorer', name: '探索者', icon: '🧭', desc: '使用过全部4种单词模式', cat: '探索', rarity: '普通' },
  { id: 'social', name: '分享达人', icon: '💌', desc: '分享学习报告给家长（隐藏）', cat: '传奇', rarity: '普通' },
  { id: 'lucky_7', name: '幸运七', icon: '🍀', desc: '7月7日完成学习（隐藏）', cat: '传奇', rarity: '普通' },
  { id: 'century', name: '百年大计', icon: '💯', desc: '累计答对1000道题', cat: '学业', rarity: '普通' },
];

// 计算某课程的独立正确率（每题取最后一次作答，helped=0才算独立）
function lessonIndependentRate(lidPrefix) {
  try {
    const rows = db.prepare(
      "SELECT item_id, correct, helped FROM attempts WHERE item_id LIKE ?"
    ).all(lidPrefix + '%');
    if (rows.length === 0) return { rate: 0, count: 0, helpedAny: false };
    const last = {};
    for (const r of rows) last[r.item_id] = r;
    const ids = Object.keys(last);
    const correct = ids.filter(id => last[id].correct === 1).length;
    const helpedAny = ids.some(id => last[id].helped === 1);
    // 也查 help_events 表（旧数据可能只记在这里）
    let he = { c: 0 };
    try {
      he = db.prepare("SELECT COUNT(*) c FROM help_events WHERE item_id LIKE ?").get(lidPrefix + '%');
    } catch {}
    return { rate: ids.length ? correct / ids.length : 0, count: ids.length, helpedAny: helpedAny || (he.c > 0) };
  } catch { return { rate: 0, count: 0, helpedAny: false }; }
}

function lessonDone(lid) {
  try {
    const st = db.prepare('SELECT p1_done, p2_done FROM lesson_state WHERE lesson_id=?').get(lid);
    return st && st.p1_done === 1 && st.p2_done === 1;
  } catch { return false; }
}

// 检查并颁发称号，返回新获得的称号 id 列表
function checkTitles() {
  const newly = [];
  let earned = new Set();
  try {
    for (const r of db.prepare('SELECT title_id FROM titles').all()) earned.add(r.title_id);
  } catch {}
  const grant = (id) => {
    if (earned.has(id)) return;
    try {
      db.prepare('INSERT OR IGNORE INTO titles(title_id) VALUES(?)').run(id);
      earned.add(id);
      newly.push(id);
    } catch {}
  };
  // 1. 比较级小达人：u3-consolidate 零求助、独立正确率≥85%
  try {
    const s = lessonIndependentRate('u3-consolidate');
    if (s.count > 0 && !s.helpedAny && s.rate >= 0.85) grant('comparative_master');
  } catch {}
  // 2. 最高级终结者：review3 正确率≥90%（允许求助，但正确率高）
  try {
    const s = lessonIndependentRate('review3');
    if (s.count >= 10 && s.rate >= 0.90) grant('superlative_slayer');
  } catch {}
  // 3. 拼写小能手：连续20道拼写题全对且零求助（按时间顺序）
  try {
    const rows = db.prepare(
      "SELECT correct, helped FROM attempts ORDER BY id DESC LIMIT 60"
    ).all();
    let streak = 0;
    for (const r of rows) {
      if (r.correct === 1 && r.helped === 0) streak++;
      else break;
    }
    if (streak >= 20) grant('spelling_star');
  } catch {}
  // 4. 坚持小勇士：连续签到7天
  // 2026-10-15 Elouise：加签到系列称号（14/21/36/100/120天）+ 连闯7天
  try {
    const st = checkinStatus();
    if (st && st.streak >= 7) grant('streak_warrior');
    if (st && st.streak >= 7) grant('challenge_streak_7');
    if (st && st.streak >= 14) grant('signin_14');
    if (st && st.streak >= 21) grant('signin_21');
    if (st && st.streak >= 36) grant('signin_36');
    if (st && st.streak >= 100) grant('signin_100');
    if (st && st.streak >= 120) grant('signin_120');
  } catch {}
  // 5. Unit 3 征服者：u3r1-u3r5全完成，平均独立正确率≥80%
  try {
    const lids = ['u3r1', 'u3r2', 'u3r3', 'u3r4', 'u3r5'];
    if (lids.every(lessonDone)) {
      let sum = 0, n = 0;
      for (const lid of lids) {
        const s = lessonIndependentRate(lid);
        if (s.count > 0) { sum += s.rate; n++; }
      }
      if (n > 0 && sum / n >= 0.80) grant('unit3_conqueror');
    }
  } catch {}
  // 2026-10-13 Elouise要求：U4/U5/U6称号
  const unitConqueror = (unit, titleId) => {
    try {
      const lids = [1,2,3,4,5].map(i => `u${unit}r${i}`);
      if (lids.every(lessonDone)) {
        let sum = 0, n = 0;
        for (const lid of lids) {
          const s = lessonIndependentRate(lid);
          if (s.count > 0) { sum += s.rate; n++; }
        }
        if (n > 0 && sum / n >= 0.80) grant(titleId);
      }
    } catch {}
  };
  unitConqueror(4, 'passive_voice_pro');
  unitConqueror(4, 'unit4_conqueror');
  unitConqueror(5, 'present_perfect_master');
  unitConqueror(5, 'unit5_conqueror');
  unitConqueror(6, 'unit6_conqueror');
  // 2026-10-14 Elouise要求：错题成就
  // 1. 错题克星：累计 resolved 100道待复测（零帮助独立答对才会计入 resolved）——2026-10-14 19:05加难度（10倍）
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM retest_queue WHERE status='resolved'").get();
    if (r && r.c >= 100) grant('mistake_slayer');
  } catch {}
  // 2. 知错就改：从错题本单题重做20道并答对——2026-10-14 19:05加难度（20倍）
  // 判定：有 attempts 的 item_id 来自单题重做且 correct=1。单题重做的 session 特征：URL 带 retry_item，
  // 服务端无法直接区分，改用：错题本展示过的 item（attempts correct=0 过）后来 correct=1 且 independent=1
  try {
    const r = db.prepare(`
      SELECT COUNT(DISTINCT a.item_id) c FROM attempts a
      WHERE a.correct=1 AND a.independent=1
      AND EXISTS (SELECT 1 FROM attempts b WHERE b.item_id=a.item_id AND b.correct=0)
    `).get();
    if (r && r.c >= 20) grant('comeback_kid');
  } catch {}
  // 3. 闯关达人：完成3次每日闯关
  try {
    const r = db.prepare("SELECT value FROM app_state WHERE key='daily_retest_count'").get();
    if (r && (parseInt(r.value, 10) || 0) >= 3) grant('daily_challenger');
  } catch {}
  // 4. 不规则克星：6道不规则题全部独立答对（取最后一次作答）
  try {
    const irregularIds = ['u3-consolidate-v1-s3','u3-consolidate-v1-s6','u3r2-v1-s20','u3r2-v1-s19','review3-v1-s5','review3-v1-s10','review3-v1-s1'];
    let okCount = 0;
    for (const iid of irregularIds) {
      const r = db.prepare("SELECT correct, helped FROM attempts WHERE item_id=? ORDER BY rowid DESC LIMIT 1").get(iid);
      if (r && r.correct === 1 && r.helped === 0) okCount++;
    }
    if (okCount >= 6) grant('irregular_slayer');
  } catch {}
  // 2026-10-16 Elouise要求：20个新成就（连胜闯关/单词/错题累积/做题数/课程数）
  // ——— 连胜闯关：查每日闯关完成天数 ———
  try {
    const r = db.prepare("SELECT COUNT(DISTINCT date(created_at)) c FROM daily_challenge WHERE completed=1").get();
    const days = r ? r.c : 0;
    if (days >= 3) grant('challenge_streak_3');
    if (days >= 14) grant('challenge_streak_14');
    if (days >= 30) grant('challenge_streak_30');
    if (days >= 60) grant('challenge_streak_60');
  } catch {}
  // ——— 单词学习：查服务端同步的掌握词数 ———
  try {
    const r = db.prepare("SELECT value FROM app_state WHERE key='word_mastered_count'").get();
    const wc = r ? (parseInt(r.value, 10) || 0) : 0;
    if (wc >= 50) grant('word_50');
    if (wc >= 150) grant('word_150');
    if (wc >= 250) grant('word_250');
    if (wc >= 350) grant('word_350');
  } catch {}
  // ——— 错题累积：resolved 计数 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM retest_queue WHERE status='resolved'").get();
    const mc = r ? r.c : 0;
    if (mc >= 10) grant('mistake_10');
    if (mc >= 50) grant('mistake_50');
    if (mc >= 200) grant('mistake_200');
    if (mc >= 500) grant('mistake_500');
  } catch {}
  // ——— 整体做题数 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM attempts").get();
    const qc = r ? r.c : 0;
    if (qc >= 100) grant('questions_100');
    if (qc >= 500) grant('questions_500');
    if (qc >= 1000) grant('questions_1000');
    if (qc >= 2000) grant('questions_2000');
  } catch {}
  // ——— 做完课程数 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1").get();
    const cc = r ? r.c : 0;
    if (cc >= 5) grant('courses_5');
    if (cc >= 10) grant('courses_10');
    if (cc >= 15) grant('courses_15');
    if (cc >= 20) grant('courses_20');
  } catch {}
  // 2026-10-16 Elouise要求：4个累计学习分钟数 + 10个其他新成就
  // ——— 累计学习分钟数 ———
  try {
    const r = db.prepare("SELECT COALESCE(SUM(elapsed_ms),0) ms FROM attempts").get();
    const mins = Math.round((r ? r.ms : 0) / 60000);
    if (mins >= 60) grant('minutes_60');
    if (mins >= 300) grant('minutes_300');
    if (mins >= 900) grant('minutes_900');
    if (mins >= 1800) grant('minutes_1800');
  } catch {}
  // ——— 复习达人：完成3节复习课 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE lesson_id LIKE 'review%' AND p1_done=1 AND p2_done=1").get();
    if (r && r.c >= 3) grant('review_3');
  } catch {}
  // ——— 自力更生：零求助完成5节课 ———
  try {
    const r = db.prepare(`
      SELECT COUNT(DISTINCT ls.lesson_id) c FROM lesson_state ls
      WHERE ls.p1_done=1 AND ls.p2_done=1
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.item_id LIKE ls.lesson_id || '%' AND a.helped=1)
      AND NOT EXISTS (SELECT 1 FROM help_events h WHERE h.item_id LIKE ls.lesson_id || '%')
    `).get();
    if (r && r.c >= 5) grant('independent_5');
  } catch {}
  // ——— 连对高手：连续答对15道题（零求助） ———
  try {
    const rows = db.prepare("SELECT correct, helped FROM attempts ORDER BY id DESC LIMIT 30").all();
    let streak = 0;
    for (const r of rows) {
      if (r.correct === 1 && r.helped === 0) streak++;
      else break;
    }
    if (streak >= 15) grant('streak_15');
  } catch {}
  // ——— 知错能改：重做答对10道题 ———
  try {
    const r = db.prepare("SELECT COUNT(DISTINCT item_id) c FROM attempts WHERE verdict='correct_retry'").get();
    if (r && r.c >= 10) grant('retry_10');
  } catch {}
  // ——— 生词收藏家：生词本收藏30个词 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM vocab_words").get();
    if (r && r.c >= 30) grant('vocab_30');
  } catch {}
  // ——— 满分闯关：每日闯关获得满分 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM daily_challenge WHERE completed=1 AND score=100").get();
    if (r && r.c >= 1) grant('perfect_1');
  } catch {}
  // ——— 早起鸟：早上7点前完成学习 ———
  // ——— 早起鸟：早上7点前完成一节课（2026-10-17 Elouise：按完成课程数） ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) < 7").get();
    if (r && r.c >= 1) grant('morning_1');
  } catch {}
  // ——— 夜读星：晚上22点后完成一节课 ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) >= 22").get();
    if (r && r.c >= 1) grant('night_1');
  } catch {}
  // ——— 周末学霸：周末累计完成50节课（2026-10-17 Elouise：按完成课程数，不是答题数） ———
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND strftime('%w', datetime(updated_at, '+8 hours')) IN ('0','6')").get();
    if (r && r.c >= 50) grant('weekend_50');
  } catch {}
  // ——— 火眼金睛：连续50道题无拼写错误 ———
  try {
    const rows = db.prepare("SELECT verdict FROM attempts ORDER BY id DESC LIMIT 60").all();
    let streak = 0;
    for (const r of rows) {
      if (r.verdict !== 'typo') streak++;
      else break;
    }
    if (streak >= 50) grant('no_typo_50');
  } catch {}
  // ——— 2026-10-17新增26个：等级制 ———
  // 连对30/50
  try {
    const rows = db.prepare("SELECT correct, helped FROM attempts ORDER BY id DESC LIMIT 60").all();
    let s = 0;
    for (const r of rows) { if (r.correct === 1 && r.helped === 0) s++; else break; }
    if (s >= 30) grant('streak_30');
    if (s >= 50) grant('streak_50');
  } catch {}
  // 3600分钟
  try {
    const r = db.prepare("SELECT COALESCE(SUM(elapsed_ms),0) ms FROM attempts").get();
    if (r && r.ms >= 3600 * 60 * 1000) grant('minutes_3600');
  } catch {}
  // 生词100
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM vocab_words").get();
    if (r && r.c >= 100) grant('vocab_100');
  } catch {}
  // 复习10节
  try {
    const r = db.prepare("SELECT COUNT(DISTINCT lesson_id) c FROM lesson_state WHERE p2_done=1 AND lesson_id LIKE 'review%'").get();
    if (r && r.c >= 10) grant('review_10');
  } catch {}
  // 零求助10节
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM (
      SELECT lesson_id FROM attempts GROUP BY lesson_id HAVING SUM(helped)=0 AND COUNT(*)>=5
    )`).get();
    if (r && r.c >= 10) grant('independent_10');
  } catch {}
  // 重做30道
  try {
    const r = db.prepare("SELECT COUNT(DISTINCT item_id) c FROM attempts WHERE verdict='correct_retry'").get();
    if (r && r.c >= 30) grant('retry_30');
  } catch {}
  // 满分3次
  try {
    const r = db.prepare("SELECT value FROM app_state WHERE key='daily_retest_perfect'").get();
    if (r && parseInt(r.value) >= 3) grant('perfect_3');
  } catch {}
  // 掌握50/100词
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM word_mastery WHERE level>=4").get();
    if (r && r.c >= 50) grant('vocab_master_50');
    if (r && r.c >= 100) grant('vocab_master_100');
  } catch {}
  // 早起7次/夜读7次（按天去重，2026-10-17：按完成课程数）
  try {
    const r1 = db.prepare("SELECT COUNT(DISTINCT date(updated_at, '+8 hours')) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) < 7").get();
    if (r1 && r1.c >= 7) grant('morning_7');
    const r2 = db.prepare("SELECT COUNT(DISTINCT date(updated_at, '+8 hours')) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) >= 22").get();
    if (r2 && r2.c >= 7) grant('night_7');
  } catch {}
  // 闯关7/30天
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM checkins WHERE kind='challenge'").get();
    if (r && r.c >= 7) grant('daily_7');
    if (r && r.c >= 30) grant('daily_30');
  } catch {}
  // 100道无拼写错
  try {
    const rows = db.prepare("SELECT verdict FROM attempts ORDER BY id DESC LIMIT 120").all();
    let streak = 0;
    for (const r of rows) { if (r.verdict !== 'typo') streak++; else break; }
    if (streak >= 100) grant('no_typo_100');
  } catch {}
  // 连续20道零求助
  try {
    const rows = db.prepare("SELECT helped FROM attempts ORDER BY id DESC LIMIT 25").all();
    let s = 0;
    for (const r of rows) { if (r.helped === 0) s++; else break; }
    if (s >= 20) grant('help_free_20');
  } catch {}
  // 周末100次
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND strftime('%w', datetime(updated_at, '+8 hours')) IN ('0','6')").get();
    if (r && r.c >= 100) grant('weekend_100');
  } catch {}
  // 凌晨0-5点（隐藏，2026-10-17：按完成课程数）
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) BETWEEN 0 AND 4").get();
    if (r && r.c >= 1) grant('midnight_oil');
  } catch {}
  // 早上5-6点（隐藏）
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM lesson_state WHERE p1_done=1 AND p2_done=1 AND CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) BETWEEN 5 AND 5").get();
    if (r && r.c >= 1) grant('first_light');
  } catch {}
  // 单日120分钟
  try {
    const r = db.prepare(`SELECT MAX(ms) m FROM (SELECT SUM(elapsed_ms) ms FROM attempts GROUP BY date(created_at, '+8 hours'))`).get();
    if (r && r.m >= 120 * 60 * 1000) grant('marathon');
  } catch {}
  // 累计1000道
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM attempts WHERE correct=1").get();
    if (r && r.c >= 1000) grant('century');
  } catch {}
  // 2026-10-18修：进度条类称号，进度达标自动颁发（防"934/300还未获得"bug）
  try {
    const progressMap = getTitleProgressMap();
    for (const [id, p] of Object.entries(progressMap)) {
      if (p.current >= p.target) grant(id);
    }
  } catch {}
  return newly;
}

// 检查 Unit 3 专项巩固是否过关：零求助、纯独立手写正确率 ≥ 85%
// 2026-10-12修：按session统计。孩子重做一次就是新的一轮，只看本轮的求助和正确率，
// 不再因很久以前用过一次HELP就永远卡死。
function getConsolidationSessionStart() {
  try {
    const r = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
    return r ? r.value : null;
  } catch { return null; }
}

function checkConsolidationPass() {
  try {
    const sessStart = getConsolidationSessionStart();
    const timeFilter = sessStart ? `AND created_at >= '${sessStart}'` : '';
    // 取本轮的作答
    const attempts = db.prepare(
      `SELECT item_id, correct FROM attempts WHERE item_id LIKE 'u3-consolidate%' ${timeFilter}`
    ).all();
    if (attempts.length === 0) return false;
    // 检查本轮是否有求助记录
    const helps = db.prepare(
      `SELECT COUNT(*) as c FROM help_events WHERE item_id LIKE 'u3-consolidate%' ${timeFilter}`
    ).get();
    if (helps && helps.c > 0) return false; // 本轮用过求助，不算过关
    // 计算独立正确率（每题取最后一次作答）
    const lastAttempt = {};
    for (const a of attempts) lastAttempt[a.item_id] = a.correct;
    const ids = Object.keys(lastAttempt);
    const correct = ids.filter(id => lastAttempt[id] === 1).length;
    const rate = ids.length > 0 ? correct / ids.length : 0;
    return rate >= 0.85;
  } catch { return false; }
}

// 开始新的巩固轮次：记录开始时间
function startConsolidationSession() {
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES('u3_consolidation_session', ?)").run(now);
  } catch (e) { console.error('[consolidation] startSession', e.message); }
}

// 课程步骤（去答案版；需验证）。?lesson=u2r2 取第 2 课；第 2 课的步骤 1 开场与复盘题由服务端动态生成/筛选
app.get('/api/lesson', auth.requireAuth, (req, res) => {
  // 2026-10-11：课程数据修好后浏览器仍显示旧版（u2r5 事件），禁缓存，
  // 以后更新孩子直接刷新页面就行，永远不需要清缓存/强制刷新
  res.set('Cache-Control', 'no-store');
  const qlid = String(req.query.lesson || 'u2r1');
  // 每日闯关（2026-10-14）：虚拟课程，画像驱动动态选题，不走文件和门禁
  if (qlid === 'daily-retest') {
    // 回填漏网错题，保证选题池最新
    try { retest.backfillWrongToRetest(); } catch {}
    const gen = retest.generateDailyRetest();
    const choices = {};
    const steps = gen.steps.map((g, idx) => {
      // 用原始 lessonId 生成 item_id，保证作答记到原题、复测能解决
      const pub = publicStep(g.step, g.origLessonId, g.origVersion, choices);
      pub.step = idx + 1;
      pub.daily_retest = true;
      pub.knowledge_point = g.knowledge_point;
      return pub;
    });
    return res.json({
      lesson_id: 'daily-retest', version: 1, title: '今日闯关',
      home_subtitle: '每天开始先闯关，补上昨天的短板',
      practice_end: steps.length, part1_desc: '', part2_desc: '',
      steps, daily_retest: true,
    });
  }
  // 批量重做（2026-10-15 Elouise）：错题本多选一起做，items=逗号分隔的 item_id 列表
  // 虚拟课程，不走文件和门禁，每道题用原 lesson 的判分
  if (qlid === 'batch-retry') {
    const itemsParam = String(req.query.items || '');
    const itemIds = itemsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
    if (!itemIds.length) return res.status(400).json({ ok: false, error: 'no_items' });
    const steps = [];
    const choices = {};
    for (const iid of itemIds) {
      const m = /^([a-z0-9-]+)-v(\d+)-s(\d+)$/i.exec(iid);
      if (!m) continue;
      const origLid = m[1], origVer = Number(m[2]), stepNum = Number(m[3]);
      const OL = loadLesson(origLid);
      if (!OL) continue;
      const origStep = (OL.lesson.steps || []).find(s => s.step === stepNum && (s.kind === 'mcq' || s.kind === 'short' || s.kind === 'chunk'));
      if (!origStep) continue;
      const pub = publicStep(origStep, origLid, origVer, choices);
      pub.step = steps.length + 1;
      pub.batch_retry = true;
      pub.review = true;
      pub.retry_item = iid;
      steps.push(pub);
    }
    if (!steps.length) return res.status(404).json({ ok: false, error: 'no_valid_items' });
    return res.json({
      lesson_id: 'batch-retry', version: 1, title: '错题批量重做',
      home_subtitle: `共 ${steps.length} 道，一道一道来`,
      practice_end: steps.length, part1_desc: '', part2_desc: '',
      steps, batch_retry: true,
    });
  }
  if (req.query.lesson && !validLesson(qlid)) return badLesson(res);
  const lid = qlid;
  const L = loadLesson(lid);
  if (!L) return res.status(404).json({ ok: false, error: 'no_lesson' });
  // 2026-10-16修：单题重做（retry_item）豁免课程解锁检查——错题本是复习，不是新学；
  // 否则"做错题解锁新课"和"做错题需先解锁新课"形成死锁，永远解不了锁。
  const isSingleRetry = !!String(req.query.retry_item || '');
  // 二审三1：前面的课没做完，这门课不开放（直接拼 URL 也进不来）；单题重做豁免
  if (!isSingleRetry && !lessonOpen(lid)) return res.status(403).json({ ok: false, error: 'lesson_locked' });
  // 单题重做（2026-10-14）：错题本"重做这道题"，只返回这一道题，不进整课流程
  const retryItem = String(req.query.retry_item || '');
  if (retryItem) {
    const m = /^([a-z0-9-]+)-v(\d+)-s(\d+)$/i.exec(retryItem);
    if (m) {
      const stepNum = Number(m[3]);
      const origStep = (L.lesson.steps || []).find(s => s.step === stepNum && (s.kind === 'mcq' || s.kind === 'short'));
      if (origStep) {
        const choices = loadChoices(lid);
        const pub = publicStep(origStep, lid, L.lesson.version, choices);
        pub.step = 1;
        pub.single_retry = true;
        pub.review = true;
        return res.json({
          lesson_id: lid, version: L.lesson.version,
          title: '错题重做', home_subtitle: '只做这一道，做对就消掉',
          practice_end: 1, part1_desc: '', part2_desc: '',
          steps: [pub], single_retry: true, retry_item: retryItem,
        });
      }
    }
    // 找不到题目：返回 404，前端会提示
    return res.status(404).json({ ok: false, error: 'retry_item_not_found' });
  }
  // 2026-10-12：u3-consolidate 新一轮开始时重置session计时
  // 如果上次已学完（p1+p2都done），这次打开就是新的一轮
  if (lid === 'u3-consolidate') {
    try {
      const sess = getConsolidationSessionStart();
      // 2026-10-14修：取消"打开已完成课就自动清零"的逻辑（导致"做完→刷新→又没做完"死循环，用户体验极差）
      // 新逻辑：做完就稳定显示完成；想重挑战（刷过关）点"重新挑战"按钮手动重置
      // 只需确保 session 存在（用于过关判定），不重置 p1/p2
      if (!sess) {
        startConsolidationSession();
      }
    } catch (e) { console.error('[consolidation] session', e.message); }
  }
  const steps = lid === 'u2r2' ? review.serveU2r2(L.lesson) : L.lesson.steps;
  const choices = loadChoices(lid); // 剧情回调：该课学生已做的选择
  res.json({
    lesson_id: lid, version: L.lesson.version, title: L.lesson.title,
    practice_end: L.lesson.practice_end || 22,
    home_subtitle: L.lesson.home_subtitle || '',
    part1_desc: L.lesson.part1_desc || '',
    part2_desc: L.lesson.part2_desc || '',
    // 数学课标记（前端按需加载 KaTeX）+ 多学科品牌/kicker 数据驱动（2026-10-08 数学课上线）
    math: !!L.lesson.math,
    brand: L.lesson.brand || '',
    kicker_story: L.lesson.kicker_story || '',
    kicker_teach: L.lesson.kicker_teach || '',
    answer_placeholder: L.lesson.answer_placeholder || '',
    steps: steps.map(s => publicStep(s, lid, L.lesson.version, choices)),
    // 2026-10-14：u3-consolidate 过关状态（供前端显示"重新挑战"）
    consolidation_passed: lid === 'u3-consolidate' ? (() => {
      try {
        const pr = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_done'").get();
        return !!(pr && pr.value === '1');
      } catch { return false; }
    })() : undefined,
    // 2026-10-14：u3-consolidate 当前轮次开始时间（供前端检测新一轮，清掉旧 sid）
    consolidation_session: lid === 'u3-consolidate' ? (() => {
      try {
        const sr = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
        return sr ? sr.value : null;
      } catch { return null; }
    })() : undefined,
  });
});

// 续课进度（h 版）：按题目ID记录，落盘服务端；动态插入的复习题不挤占续课位置
app.get('/api/progress', auth.requireAuth, (req, res) => {
  const lid = String(req.query.lesson || '');
  if (!lid || !validLesson(lid)) return badLesson(res);
  const rows = db.prepare('SELECT part, item_id FROM progress WHERE lesson_id=?').all(lid);
  const progress = { p1: null, p2: null };
  for (const r of rows) progress['p' + r.part] = r.item_id;
  res.json({ ok: true, lesson: lid, progress });
});
app.post('/api/progress', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const lid = String(body.lesson || '');
  const part = parseInt(body.part, 10);
  const itemId = String(body.item_id || '');
  if (!lid || !validLesson(lid) || (part !== 1 && part !== 2) || !itemId) {
    return res.status(400).json({ ok: false, error: 'bad_progress' });
  }
  db.prepare(`INSERT INTO progress(lesson_id, part, item_id, updated_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(lesson_id, part) DO UPDATE SET item_id=excluded.item_id, updated_at=datetime('now')`)
    .run(lid, part, itemId);
  res.json({ ok: true });
});

// 记录"老师教我"（点击帮助按钮时调用；判分时记为有帮助完成），同时下发提示语
// 三级提示（2026-10-02，永不卡死硬规则）：
// - level=1（默认）：指方向的现有 help 文本；
// - level=2（仅练习阶段）：同屏材料原文的原句 help_line，要求答案指向该行；
// - level=3（仅练习阶段）：正确答案 + 讲解原因，孩子照写后记有帮助完成（走 saw_feedback 机制）；
// - 验证阶段 level 一律钳制为 1（只指方向），返回中注明 level 实际为 1。
// 复测闭环（2026-10-03）：待复测列表与解决
app.get('/api/retest/pending', auth.requireAuth, (req, res) => {
  // 每次查询时顺带回填历史，确保 h 上线前的"看答案过"记录可被读取
  retest.backfillFromHistory();
  // 2026-10-14补画像：多次答错（2+次）但未进队列的也回填
  retest.backfillWrongToRetest();
  res.json({ ok: true, pending: retest.getPending() });
});
// 每日闯关状态（2026-10-14）：今日题数、是否已通关、连续闯关天数
app.get('/api/daily-retest/status', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    retest.backfillWrongToRetest();
    const items = retest.selectDailyRetestItems(8);
    const today = shanghaiDay();
    // 今日是否已通关：checkins 有今天，且今天做过 daily-retest 的题
    const checked = db.prepare("SELECT 1 FROM checkins WHERE day=? AND kind='challenge'").get(today);
    let doneCount = 0;
    try {
      doneCount = db.prepare(`SELECT COUNT(DISTINCT item_id) AS c FROM attempts
        WHERE date(created_at, '+8 hours') = ? AND item_id IN (
          SELECT item_id FROM retest_queue WHERE status IN ('pending','resolved')
        )`).get(today).c || 0;
    } catch {}
    // 连续天数：从今天（或昨天）往前数 checkins 连续的天数
    let streak = 0;
    try {
      const days = db.prepare("SELECT day FROM checkins WHERE kind='challenge' ORDER BY day DESC").all().map(r => r.day);
      const set = new Set(days);
      let d = new Date(today + 'T12:00:00');
      if (!set.has(today)) d.setDate(d.getDate() - 1); // 今天没打卡，从昨天算
      while (true) {
        const ds = d.toISOString().slice(0, 10);
        if (set.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
        else break;
      }
    } catch {}
    res.json({ ok: true, today, question_count: items.length,
      checked_in: !!checked, streak,
      has_questions: items.length > 0 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// 每日闯关通关（2026-10-14）：记打卡，返回连续天数（供前端庆祝）
app.post('/api/daily-retest/complete', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    // 2026-10-17防线：当天没做过闯关题，拒绝写通关记录（防前端误调）
    const today = shanghaiDay();
    const ansCount = db.prepare(`
      SELECT COUNT(*) c FROM attempts
      WHERE date(created_at, '+8 hours') = ?
      AND session_id LIKE '%daily-retest%'
    `).get(today);
    if (!ansCount || ansCount.c === 0) {
      return res.json({ ok: false, error: 'no_answers_today' });
    }
    db.prepare("INSERT OR IGNORE INTO checkins(day, kind, created_at) VALUES(?, 'challenge', datetime('now'))").run(today);
    // 2026-10-14：记录每日闯关完成次数（供"闯关达人"称号）
    try {
      const cur = db.prepare("SELECT value FROM app_state WHERE key='daily_retest_count'").get();
      const n = cur ? (parseInt(cur.value, 10) || 0) + 1 : 1;
      db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES('daily_retest_count', ?)").run(String(n));
    } catch {}
    const newTitles = checkTitles();
    // 重算连续天数
    const s = db.prepare('SELECT day FROM checkins ORDER BY day DESC').all().map(r => r.day);
    const set = new Set(s);
    let streak = 0;
    const d = new Date(shanghaiDay() + 'T12:00:00');
    while (true) {
      const ds = d.toISOString().slice(0, 10);
      if (set.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    res.json({ ok: true, streak, newTitles });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// 专项巩固重新挑战（2026-10-14）：手动重置，开始新一轮（替代之前的自动重置）
// 2026-10-14 18:55修：彻底清空——逐题进度(progress表)也要删，否则从第13步续上
app.post('/api/consolidation/retry', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    db.prepare("UPDATE lesson_state SET p1_done=0, p2_done=0, updated_at=datetime('now') WHERE lesson_id='u3-consolidate'").run();
    db.prepare("DELETE FROM progress WHERE lesson_id='u3-consolidate'").run();
    startConsolidationSession();
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// 单元测验卷（2026-10-12）：广州新中考140分制
exams.setDb(db);
exams.initTable();
app.get('/api/exams', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, exams: exams.getExamList() });
});
app.get('/api/exam/:id', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = exams.getExam(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  // 检查解锁：本单元5节课学完即可考
  // 2026-10-13 Elouise定：测验卷不再被每日复习门锁定（学完就能考），新课继续锁
  const m = req.params.id.match(/exam-u(\d)/);
  if (m && !exams.isUnitDone(parseInt(m[1]))) {
    return res.status(403).json({ ok: false, error: 'locked' });
  }
  res.json(r);
});
// 每日待复习项（首页显示）
app.get('/api/daily-reviews', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, pending: getPendingReviews(), dailyMistakes: getDailyMistakeProgress() });
});
app.post('/api/exam/submit', auth.requireAuth, (req, res) => {
  // 2026-10-12改：服务端判分，不再信任前端传来的score
  const { exam_id, answers } = req.body || {};
  if (!exam_id) return res.status(400).json({ ok: false, error: 'no_exam_id' });
  const g = exams.gradeExam(String(exam_id), answers || {});
  if (!g.ok) return res.status(400).json({ ok: false, error: g.error });
  const ok = exams.saveScore(String(exam_id), g.score, g.detail, answers || {});
  res.json({ ok, score: g.score, total_objective: g.total_objective, pending: g.pending, detail: g.detail });
});
// 真正的错题本（2026-10-12）：返回每道错题的原题、孩子答案、正确答案
app.get('/api/mistakes', auth.requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    // 取最近答错的题（含看答案过、粘贴等）
    // 2026-10-13修：items表没有question_json列，改用prompt/answer列
    // 2026-10-15 Elouise：去重，同一题（忽略版本号）只留最后一次答错
    // 2026-10-15修：按 logicalItemId 去重（v1/v2 算同一题），SQL 取100条再 JS 去重
    const rows = db.prepare(`
      SELECT a.item_id, a.answer_given, a.verdict, a.created_at, a.detail_json,
             i.prompt, i.answer, i.lesson_id, i.knowledge_point,
             (SELECT COUNT(*) FROM attempts a2 WHERE a2.item_id=a.item_id AND a2.correct=0) as wrong_count
      FROM attempts a
      LEFT JOIN items i ON a.item_id = i.item_id
      WHERE a.correct = 0
      ORDER BY a.created_at DESC
      LIMIT 100
    `).all();
    // 按 logicalItemId 去重，只保留每题最新的一条
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = logicalItemId(r.item_id);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
      if (deduped.length >= 50) break;
    }
    const mistakes = deduped.map(r => {
      let detail = null;
      try { detail = JSON.parse(r.detail_json || '{}'); } catch {}
      // 提取正确答案
      let correctAnswer = '';
      if (r.answer) correctAnswer = String(r.answer);
      else if (detail && detail.expected) correctAnswer = String(detail.expected);
      // 提取题干
      let question = '';
      if (r.prompt) question = String(r.prompt);
      return {
        item_id: r.item_id,
        lesson_id: r.lesson_id || '',
        question: question.slice(0, 200),
        given: String(r.answer_given || '').slice(0, 200),
        correct: correctAnswer.slice(0, 200),
        verdict: r.verdict,
        created_at: r.created_at,
        knowledge_point: r.knowledge_point || '',
        wrong_count: r.wrong_count || 1,
      };
    });
    // 2026-10-14：过滤掉已解决的（retest_queue.status='resolved'），它们进"最近拿下"
    // 2026-10-15修：只有"无 pending 记录"的才算真正攻克；有 pending 的（即使也有 resolved）仍留在"正在攻克"
    let filtered = mistakes;
    let resolvedList = [];
    try {
      const pendingIds = new Set(
        db.prepare("SELECT item_id FROM retest_queue WHERE status='pending'").all().map(r => r.item_id)
      );
      // 正在攻克：mistakes 里去掉"已解决且无待处理"的
      const fullyResolvedIds = new Set(
        db.prepare(`
          SELECT item_id FROM retest_queue WHERE status='resolved'
          AND item_id NOT IN (SELECT item_id FROM retest_queue WHERE status='pending')
        `).all().map(r => r.item_id)
      );
      filtered = mistakes.filter(m => !fullyResolvedIds.has(m.item_id));
      // 已攻克列表：有 resolved 且无 pending 的，按 resolved_at 倒序，取最近20
      const rRows = db.prepare(`
        SELECT q.item_id, MAX(q.resolved_at) as resolved_at, i.prompt, i.answer, q.knowledge_point
        FROM retest_queue q LEFT JOIN items i ON q.item_id=i.item_id
        WHERE q.status='resolved'
        AND q.item_id NOT IN (SELECT item_id FROM retest_queue WHERE status='pending')
        GROUP BY q.item_id
        ORDER BY resolved_at DESC LIMIT 20
      `).all();
      resolvedList = rRows.map(r => ({
        item_id: r.item_id,
        question: String(r.prompt || '').slice(0, 200),
        correct: String(r.answer || '').slice(0, 200),
        resolved_at: r.resolved_at,
        knowledge_point: r.knowledge_point || '',
      }));
    } catch {}
    res.json({ ok: true, mistakes: filtered, resolved: resolvedList });
  } catch (e) {
    console.error('[mistakes]', e.message);
    res.json({ ok: false, mistakes: [] });
  }
});
app.post('/api/retest/resolve', auth.requireAuth, (req, res) => {
  const { item_id, knowledge_point } = req.body || {};
  if (!item_id) return res.status(400).json({ ok: false, error: 'no_item_id' });
  const ok = retest.resolveRetest(String(item_id), String(knowledge_point || 'general'));
  res.json({ ok: true, resolved: ok });
});

// ---- 摸底诊断 API（2026-10-03 P2）----
const diagnostic = require('./diagnostic');

// 获取诊断内容（不含答案）
app.get('/api/diagnostic', auth.requireAuth, (req, res) => {
  const form = String(req.query.form || 'A').toUpperCase();
  const section = parseInt(req.query.section || '1', 10);
  if (!['A','B'].includes(form) || ![1,2,3].includes(section))
    return res.status(400).json({ ok: false, error: 'bad_form_section' });
  const D = diagnostic.loadDiagnostic(form, section);
  const session = diagnostic.getSession(db, form, section);
  res.json({
    ok: true, session_id: session.id, form, section,
    title: D.title, desc: D.desc,
    steps: D.steps.map(diagnostic.publicDiagStep),
  });
});

// 提交诊断答案：永远只回"收到"，不透露对错
app.post('/api/diagnostic/answer', auth.requireAuth, (req, res) => {
  const { session_id, step, answer, gave_up } = req.body || {};
  if (!session_id || step == null) return res.status(400).json({ ok: false, error: 'no_session_step' });
  const sess = db.prepare('SELECT * FROM diagnostic_sessions WHERE id=?').get(session_id);
  if (!sess) return res.status(404).json({ ok: false, error: 'no_session' });
  const D = diagnostic.loadDiagnostic(sess.form, sess.section);
  const st = D.steps.find(x => x.step === Number(step));
  if (!st) return res.status(404).json({ ok: false, error: 'no_step' });

  let verdict;
  if (gave_up) {
    verdict = 'gave_up';
  } else if (req.body.not_tested) {
    // 朗读容错：麦克风不可用，标"没测到"
    verdict = 'not_tested';
  } else if (st.kind === 'mcq') {
    verdict = String(answer).toUpperCase() === st.answer ? 'correct' : 'wrong';
  } else if (st.kind === 'short') {
    const g = gradeShort(String(answer || ''), { expects: st.expects });
    verdict = g.verdict === 'correct' ? 'correct' : 'wrong';
  } else {
    verdict = 'correct'; // teach/read_aloud 不判分
  }
  db.prepare(
    'INSERT INTO diagnostic_answers(session_id, step, knowledge_point, category, verdict) VALUES(?,?,?,?,?)'
  ).run(session_id, Number(step), st.knowledge_point || null, st.category || null, verdict);

  // 自适应：该知识点连错3次 → 停止该维度
  const stopDim = (st.knowledge_point && verdict !== 'correct')
    ? diagnostic.recordAnswer(db, session_id, st, verdict) : false;

  // 诊断的固定回复：不透露对错
  res.json({ ok: true, message: '收到，下一题。', stop_dimension: stopDim });
});

// 诊断段完成：标记 completed，下次学习自动安排下一段
app.post('/api/diagnostic/complete', auth.requireAuth, (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'no_session_id' });
  const r = db.prepare("UPDATE diagnostic_sessions SET status='completed', completed_at=datetime('now') WHERE id=?")
    .run(session_id);
  // 兜底：session 不存在（数据库被清空过），按 form/section 直接标记完成
  if (r.changes === 0) {
    const { form, section } = req.body || {};
    if (form && section) {
      db.prepare(`INSERT OR IGNORE INTO diagnostic_sessions(id, form, section, status, completed_at)
        VALUES(?, ?, ?, 'completed', datetime('now'))`)
        .run(session_id, String(form).toUpperCase(), Number(section));
      db.prepare(`UPDATE diagnostic_sessions SET status='completed', completed_at=datetime('now')
        WHERE form=? AND section=?`)
        .run(String(form).toUpperCase(), Number(section));
    }
  }
  res.json({ ok: true });
});

// 诊断状态：各段完成情况
app.get('/api/diagnostic/status', auth.requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT form, section, status FROM diagnostic_sessions ORDER BY form, section'
  ).all();
  res.json({ ok: true, sessions: rows });
});

// 生词本（2026-10-08）：localStorage 为主，服务端尽力同步（Render 免费版重启可能丢数据）
app.post('/api/vocab/add', auth.requireAuth, (req, res) => {
  const { word, zh, ph, sent } = req.body || {};
  const w = String(word || '').toLowerCase().trim();
  if (!w) return res.json({ ok: false });
  const s = String(sent || '').slice(0, 500);
  db.prepare(`INSERT OR IGNORE INTO vocab_words(word, zh, ph, sent) VALUES(?,?,?,?)`)
    .run(w, String(zh || ''), String(ph || ''), s);
  if (s) db.prepare(`UPDATE vocab_words SET sent=? WHERE word=? AND (sent IS NULL OR sent='')`).run(s, w);
  res.json({ ok: true });
});
app.post('/api/vocab/del', auth.requireAuth, (req, res) => {
  const w = String((req.body || {}).word || '').toLowerCase().trim();
  if (w) db.prepare('DELETE FROM vocab_words WHERE word=?').run(w);
  res.json({ ok: true });
});
// 2026-10-16：单词学习掌握数同步（供称号 word_50/150/250/350 用）
app.post('/api/word-sync', auth.requireAuth, (req, res) => {
  const count = parseInt((req.body || {}).masteredCount, 10) || 0;
  try {
    const cur = db.prepare("SELECT value FROM app_state WHERE key='word_mastered_count'").get();
    const curN = cur ? (parseInt(cur.value, 10) || 0) : 0;
    if (count > curN) {
      db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES('word_mastered_count', ?)").run(String(count));
    }
    checkTitles();
    res.json({ ok: true, count: Math.max(count, curN) });
  } catch (e) { res.json({ ok: false }); }
});
app.get('/api/vocab/list', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT word, zh, ph, sent FROM vocab_words ORDER BY added_at DESC').all();
  res.json({ ok: true, words: rows });
});

// 单词掌握度（2026-10-17）：5级制，0陌生/1眼熟/2会认/3会拼/4掌握
app.get('/api/words/mastery', auth.requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT word, level, correct_n, wrong_n, last_at FROM word_mastery').all();
    const map = {};
    for (const r of rows) map[r.word] = r;
    res.json({ ok: true, mastery: map });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 更新单词掌握度：correct=1答对+1级，0答错-1级（0-4钳制）
app.post('/api/words/mastery', auth.requireAuth, (req, res) => {
  try {
    const { word, correct } = req.body || {};
    if (!word) return res.json({ ok: false, error: 'no_word' });
    const cur = db.prepare('SELECT level, correct_n, wrong_n FROM word_mastery WHERE word=?').get(word);
    let level = cur ? cur.level : 0;
    let cn = cur ? cur.correct_n : 0;
    let wn = cur ? cur.wrong_n : 0;
    if (correct) { level = Math.min(4, level + 1); cn++; }
    else { level = Math.max(0, level - 1); wn++; }
    db.prepare(`INSERT INTO word_mastery(word, level, correct_n, wrong_n, last_at, updated_at)
      VALUES(?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(word) DO UPDATE SET level=excluded.level, correct_n=excluded.correct_n,
      wrong_n=excluded.wrong_n, last_at=excluded.last_at, updated_at=excluded.updated_at`).run(word, level, cn, wn);
    res.json({ ok: true, word, level });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 每日复习队列（2026-10-17）：昨天错的 + 1-3级超过2天没复习的，最多20个
app.get('/api/words/review', auth.requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT word, level, wrong_n, last_at FROM word_mastery
      WHERE level BETWEEN 1 AND 3
      AND (last_at IS NULL OR date(last_at, '+8 hours') < date('now', '+8 hours', '-2 days'))
      ORDER BY wrong_n DESC, last_at ASC LIMIT 20
    `).all();
    res.json({ ok: true, review: rows });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 诊断报告：知识点状态 + 家长一页报告
app.get('/api/diagnostic/report', auth.requireAuth, (req, res) => {
  const { form } = req.query;
  const f = String(form || 'A').toUpperCase();
  const sessions = db.prepare(
    "SELECT id, section FROM diagnostic_sessions WHERE form=? AND status='active' ORDER BY section"
  ).all(f);
  const allStatus = [];
  for (const s of sessions) {
    const st = diagnostic.calcStatus(db, s.id);
    // 写入 diagnostic_results（供家长报告和后续课程用）
    for (const r of st) {
      db.prepare(`INSERT INTO diagnostic_results(session_id, knowledge_point, category, status, correct, total)
                  VALUES(?,?,?,?,?,?)`).run(s.id, r.knowledge_point, r.category, r.status, r.correct, r.total);
      // 同步到 knowledge_mastery（驱动后续课程）
      // 总指挥2026-10-03：摸底最多标到"学过"，不能直接标"会了"/"牢固"（可能蒙对）。
      // "会了"必须在课程里换材料独立答对才算。
      let mStatus;
      if (r.status === '不稳' || r.status === '会了') mStatus = '学过';
      else if (r.status === '不会') mStatus = '没学';
      else continue; // 没测到：不写入
      db.prepare(`INSERT INTO knowledge_mastery(knowledge_point, status) VALUES(?,?)
                  ON CONFLICT(knowledge_point) DO UPDATE SET status=excluded.status, updated_at=datetime('now')`)
        .run(r.knowledge_point, mStatus);
    }
    allStatus.push({ section: s.section, results: st });
  }
  res.json({ ok: true, form: f, sections: allStatus });
});

app.post('/api/help', auth.requireAuth, (req, res) => {
  const { item_id, session_id } = req.body || {};
  if (!item_id) return res.status(400).json({ ok: false, error: 'no_item_id' });
  const lid = lessonOf(item_id);
  const L = lid ? loadLesson(lid) : null;
  const step = L ? L.stepsByItem[String(item_id)] : null;
  let level = Math.min(Math.max(parseInt((req.body || {}).level, 10) || 1, 1), 3);
  const phase = step ? (step.phase || 'practice') : 'practice';
  if (phase !== 'practice') level = 1; // 验证阶段只指方向
  db.prepare('INSERT INTO help_events(item_id, session_id, level) VALUES(?,?,?)')
    .run(String(item_id), String(session_id || ''), level);
  if (level === 2 && step && step.help_line) {
    return res.json({ ok: true, level: 2, help_line: step.help_line });
  }
  if (level === 3 && step) {
    if (step.kind === 'mcq') {
      const idx = 'ABCD'.indexOf(String(step.answer || '').toUpperCase());
      const opt = (idx >= 0 && step.options) ? step.options[idx] : '';
      if (step.answer && opt) {
        return res.json({ ok: true, level: 3, answer: `正确答案是${String(step.answer).toUpperCase()}：${opt}`, explain: step.explain || '' });
      }
    } else if (step.kind === 'short') {
      if (step.answer_text) {
        return res.json({ ok: true, level: 3, answer: step.answer_text, explain: step.explain || '' });
      }
    }
  }
  // level=1，或 2/3 无对应内容时回退到 1
  res.json({ ok: true, level: 1, help: step ? step.help : '' });
});

// 故事选择持久化（2026-10-02 总指挥补充条款）：剧情里的学生选择（如点播哪首歌），
// 供后续课程用 {{choice:key|默认文本}} 回调。选择不记作答、不判分、不写 attempts。
app.post('/api/choice', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const lid = String(body.lesson || '');
  if (!validLesson(lid)) return badLesson(res);
  const key = String(body.key == null ? '' : body.key).trim();
  const value = String(body.value == null ? '' : body.value);
  if (!key) return res.status(400).json({ ok: false, error: 'bad_key' });
  if (!value.trim()) return res.status(400).json({ ok: false, error: 'bad_value' });
  if (value.length > 200) return res.status(400).json({ ok: false, error: 'value_too_long' });
  db.prepare(`INSERT INTO story_choices(lesson_id, choice_key, value, updated_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(lesson_id, choice_key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`)
    .run(lid, key, value);
  res.json({ ok: true });
});

// 取该课全部故事选择（剧情回调用）
app.get('/api/choices', auth.requireAuth, (req, res) => {
  const lid = String(req.query.lesson || '');
  if (!validLesson(lid)) return badLesson(res);
  const choices = {};
  for (const r of db.prepare('SELECT choice_key, value FROM story_choices WHERE lesson_id=?').all(lid)) {
    choices[r.choice_key] = r.value;
  }
  res.json({ ok: true, lesson: lid, choices });
});

// ---------- 真人老师式纠错：反馈接地（2026-10-02） ----------
// 根因：旧版 feedbackFor 把 common_errors 全部拼接显示，忽略了每条自带的 when 条件
// （如"答 Friday"才显示），导致反馈提到孩子没写的内容。
function escReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 收集 expects 全部值词（小写）：answers/olds/cn/cn_old
function expectValues(step) {
  const vals = [];
  for (const e of (step.expects || [])) {
    for (const k of ['answers', 'olds', 'cn', 'cn_old']) {
      for (const v of (e[k] || [])) {
        const s = String(v).trim().toLowerCase();
        if (s && vals.indexOf(s) < 0) vals.push(s);
      }
    }
  }
  return vals;
}

// token 是否出现在作答里：英文数字串用词边界在 normalize 后文本匹配，否则原文包含
function textHit(tokLow, givenLow, givenNorm) {
  if (/^[a-z0-9 ]+$/.test(tokLow)) {
    return new RegExp('\\b' + escReg(tokLow) + '\\b').test(givenNorm);
  }
  return givenLow.indexOf(tokLow) >= 0;
}

// 维度状态表（供 when 条件做"针对实际作答"的判断）
function dimStatusList(step, detail) {
  const items = ((detail && detail.items) || []);
  return (step.expects || []).map(e => {
    const it = items.find(x => x.id === e.id);
    return { id: e.id, label: dimLabel(step, e.id), status: it ? it.status : 'missing' };
  });
}
// X（如"时间"）对应哪些维度：用 dim_help 的中文标签匹配
function matchDims(dims, X) {
  const nx = grade.normalize(String(X || ''));
  if (!nx) return [];
  return dims.filter(d => {
    const nl = grade.normalize(String(d.label || ''));
    if (!nl) return false;
    return nl === nx || nl.indexOf(nx) >= 0 || nx.indexOf(nl) >= 0;
  });
}

// "方向写反"是否成立：她写了只在 olds 出现的方向词（answers 里没有该方向词）
// 混合步骤（答案里涨跌方向都有）退回旧逻辑：写中 olds 短语即视为方向问题
const DIR_WORD_RE = /^(up|down|rise|fall|increase|decrease|涨|跌|增加|减少|上升|下降|提高|降低)$/;
function dirWordsOf(s) {
  return String(s || '').toLowerCase().split(/[^a-z\u4e00-\u9fff]+/).filter(t => DIR_WORD_RE.test(t));
}
function wrongDirection(step, given) {
  const oldDirs = new Set(), ansDirs = new Set(), oldsP = [];
  for (const e of (step.expects || [])) {
    for (const v of (e.olds || [])) { const s = String(v).toLowerCase(); oldsP.push(s); dirWordsOf(s).forEach(t => oldDirs.add(t)); }
    for (const v of (e.answers || [])) { dirWordsOf(String(v).toLowerCase()).forEach(t => ansDirs.add(t)); }
  }
  const givenLow = String(given || '').toLowerCase();
  const givenNorm = grade.normalize(given);
  for (const wd of dirWordsOf(givenLow)) {
    if (oldDirs.has(wd) && !ansDirs.has(wd)) return true;
  }
  const ambiguous = oldDirs.size > 0 && [...oldDirs].every(d => ansDirs.has(d));
  if (ambiguous) return oldsP.some(v => v && textHit(v, givenLow, givenNorm));
  return false;
}

// when 条件是否成立（只针对她实际写的内容）
// "写了|答|写成 X"→X 必须在作答中出现；"只写了 X"→X（能识别为值词的）必须出现，含"中文"则要求作答含中文；
// "漏项/漏写了一项"→有维度 missing 才成立；"混入旧信息/新旧一起写"→有维度 contradiction（写了旧值）才成立；
// "X写错/X不对/X对不上"→X 对应的维度没对（写错或没写）才成立，对不上维度时退回 true；
// "漏了X"→X 对应的维度都没写才成立；
// "没X"类（没写/没用/没谢/缺少/缺/没）→先看维度：X 对应维度写了（ok/typo）则不成立，
//   都没写则成立，写了但写错则不成立（该走"写错"）；对不上维度时走原来的文字逻辑；
// 其他 when（如"方向写反"）→ true，走下一步接地检查
function whenAllows(when, say, given, vals, step, detail) {
  const w = String(when || '').trim();
  const givenLow = String(given || '').toLowerCase();
  const givenNorm = grade.normalize(given);
  const dims = dimStatusList(step, detail);
  const dimed = (X) => matchDims(dims, X);
  if (w === '漏项' || w === '漏写了一项') {
    return dims.some(d => d.status === 'missing');
  }
  if (w === '混入旧信息' || w === '新旧一起写') {
    return dims.some(d => d.status === 'contradiction');
  }
  if (w === '方向写反') {
    return wrongDirection(step, given);
  }
  let m = /^(.+?)(?:写错|不对|对不上)$/.exec(w);
  if (m) {
    const ds = dimed(m[1]);
    if (ds.length) return ds.some(d => d.status !== 'ok');
    return true;
  }
  m = /^(?:漏了|漏)(.+)$/.exec(w);
  if (m) {
    const ds = dimed(m[1]);
    if (ds.length) return ds.every(d => d.status === 'missing');
    return true;
  }
  m = /^(写了|答|写成)\s*(.+)$/.exec(w);
  if (m) {
    const rest = m[2].trim().toLowerCase();
    if (textHit(rest, givenLow, givenNorm)) return true;
    const toks = rest.split(/[，,、\s]+/).filter(Boolean);
    return toks.length > 0 && toks.every(t => textHit(t, givenLow, givenNorm));
  }
  if (/^只写了/.test(w)) {
    const rest = w.replace(/^只写了/, '');
    if (/中文/.test(rest)) return /[\u4e00-\u9fff]/.test(String(given || ''));
    const toks = rest.split(/[，,、\s]+/).filter(Boolean)
      .map(t => t.toLowerCase())
      .filter(t => vals.some(v => v === t || v.indexOf(t) >= 0));
    // "只写了X"断言没写全：X 对不上值词时（如"只写了一句/一项"），看维度——有 missing 才成立
    if (!toks.length) return dims.some(d => d.status === 'missing');
    return toks.every(t => textHit(t, givenLow, givenNorm));
  }
  m = /^(?:没写|没用|没谢|缺少|缺|没)\s*(.+)$/.exec(w);
  if (m) {
    // 先看维度（最准）：X 对应哪个 dim_help 标签
    const rest0 = m[1].replace(/^(写|用|谢)\s*/, '').trim();
    const ds = dimed(rest0);
    if (ds.length) {
      if (ds.some(d => d.status === 'ok' || d.status === 'typo')) return false; // 写了 → "没X"不成立
      if (ds.every(d => d.status === 'missing')) return true; // 真没写 → 成立
      return false; // 写了但写错 → "没X"不成立（该走"写错"）
    }
    // 对不上维度标签，走原来的文字逻辑
    // say 里提到的值词若全在她作答中出现→"没X"不成立（如"没谢来信"但她写了 thank）
    const sayLow = String(say || '').toLowerCase();
    const sayNorm = grade.normalize(say || '');
    const sayVals = vals.filter(v => textHit(v, sayLow, sayNorm));
    if (sayVals.length && sayVals.every(v => textHit(v, givenLow, givenNorm))) return false;
    // X 本身在作答中出现→"没X"不成立（先去掉"写/用/谢"这类动词）
    const rest = rest0.toLowerCase();
    const toks = rest.split(/[，,、\s]+/).filter(Boolean);
    if (toks.length && toks.every(t => textHit(t, givenLow, givenNorm))) return false;
    return true;
  }
  return true;
}

function dimLabel(step, id) {
  const dh = (step && step.dim_help) || {};
  return (dh[id] && dh[id].label) || id;
}

// 只保留"针对她实际写的内容"的 common_errors：
// 先过 whenAllows；再检查 say 中提到的值词——若提到了值词，但没有一个出现在她作答里、
// 也没有一个落在本次 failed 维度的值词集合里→过滤；没提到任何值词→保留（纯方向指引）
function groundedSays(step, given, detail) {
  const givenLow = String(given || '').toLowerCase();
  const givenNorm = grade.normalize(given);
  const vals = expectValues(step);
  const failedVals = {};
  for (const it of ((detail && detail.items) || [])) {
    if (it.status !== 'missing' && it.status !== 'contradiction') continue;
    const e = (step.expects || []).find(x => x.id === it.id);
    if (!e) continue;
    for (const k of ['answers', 'olds', 'cn', 'cn_old']) {
      for (const v of (e[k] || [])) failedVals[String(v).trim().toLowerCase()] = 1;
    }
  }
  const answerVals = {};
  vals.forEach(v => { if (textHit(v, givenLow, givenNorm)) answerVals[v] = 1; });
  const out = [];
  for (const e of (step.common_errors || [])) {
    if (!whenAllows(e.when, e.say, given, vals, step, detail)) continue;
    const sayLow = String(e.say || '').toLowerCase();
    const sayNorm = grade.normalize(e.say || '');
    const sayVals = vals.filter(v => textHit(v, sayLow, sayNorm));
    if (sayVals.length && !sayVals.some(v => failedVals[v] || answerVals[v])) continue;
    if (e.say && !out.includes(e.say)) out.push(e.say);
  }
  return out;
}

// 部分对肯定：detail 里 status=ok 的维度，"X写对了，不用改。"
function okAffirm(step, detail) {
  const oks = ((detail && detail.items) || []).filter(i => i.status === 'ok');
  return oks.map(i => dimLabel(step, i.id) + '写对了，不用改。');
}

// 预判错法匹配：normalize(given) 与 predicted_errors[].wrong（normalize 后）相等或包含；
// 按 wrong 从长到短匹配，最具体的优先（避免短条目是长条目的前缀时误命中短的）
function matchPredicted(step, given) {
  const list = step && step.predicted_errors;
  if (!Array.isArray(list) || !list.length) return null;
  const ng = grade.normalize(given);
  if (!ng) return null;
  const sorted = list
    .filter(pe => pe && typeof pe.wrong === 'string')
    .map(pe => ({ pe, nw: grade.normalize(pe.wrong) }))
    .filter(x => x.nw)
    .sort((a, b) => b.nw.length - a.nw.length);
  for (const { pe, nw } of sorted) {
    if (ng === nw || ng.indexOf(nw) >= 0) return { wrong: pe.wrong, cause: pe.cause, say: pe.say };
  }
  return null;
}

// 保底答案：mcq 取正确选项文本，short 取 answer_text；原因取 explain
function showAnswerOf(step) {
  if (!step) return { answer: '', reason: '' };
  let answer = '';
  if (step.kind === 'mcq') {
    const idx = 'ABCD'.indexOf(String(step.answer || '').toUpperCase());
    answer = (idx >= 0 && step.options && step.options[idx]) || '';
  } else {
    answer = step.answer_text || '';
  }
  return { answer, reason: step.explain || '' };
}

// 带着做触发：近5次内同一错误答案出现两次，或连续两次 wrong/wrong_retry
function guidedTrigger(itemId, sid) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT answer_given, verdict FROM attempts
      WHERE item_id=? AND session_id=? ORDER BY rowid DESC LIMIT 5`).all(itemId, sid);
  } catch { return false; }
  const isW = v => v === 'wrong' || v === 'wrong_retry';
  if (rows.length >= 2 && isW(rows[0].verdict) && isW(rows[1].verdict)) return true;
  const seen = {};
  for (const r of rows) {
    if (!isW(r.verdict)) continue;
    const n = grade.normalize(r.answer_given);
    if (!n) continue;
    if (seen[n]) return true;
    seen[n] = 1;
  }
  return false;
}

// 带着做步骤：按 expects 顺序，只含本次判错的维度；highlight 取 help_line
function guidedSteps(step, detail) {
  const failed = ((detail && detail.items) || [])
    .filter(i => i.status === 'missing' || i.status === 'contradiction');
  return failed.map(i => {
    const dh = (step.dim_help && step.dim_help[i.id]) || {};
    return {
      dim: i.id,
      label: dh.label || i.id,
      ask: dh.ask || '这一项是什么？只写这一项。',
      highlight: step.help_line || '',
    };
  });
}

function revealOf(entry) {
  if (entry.answers && entry.answers[0]) return entry.answers[0];
  if (entry.type === 'time' && entry.hour != null) {
    return entry.hour + ':' + String(entry.minute || 0).padStart(2, '0');
  }
  if (entry.type === 'date' && entry.month != null) return entry.month + '/' + entry.day;
  return '';
}

// 带着做微步骤判分（不记作答、不判分）：单维度 gradeShort；同一 dim 第二次微答错直接给答案
const guidedMicroWrongs = new Map();
app.post('/api/guided-check', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const itemId = String(body.item_id || '');
  const sid = String(body.session_id || '');
  const dim = String(body.dim || '');
  const lid = lessonOf(itemId) || 'u2r1';
  if (!lessonOpen(lid)) return res.status(403).json({ ok: false, error: 'lesson_locked' });
  const L = loadLesson(lid);
  const step = L ? L.stepsByItem[itemId] : null;
  if (!step || step.kind !== 'short') return res.status(404).json({ ok: false, error: 'no_item' });
  const entry = (step.expects || []).find(e => e.id === dim);
  if (!entry) return res.status(400).json({ ok: false, error: 'bad_dim' });
  const g = grade.gradeShort(body.answer, { expects: [entry] });
  const label = dimLabel(step, dim);
  const key = itemId + '|' + sid + '|' + dim;
  if (g.verdict === 'correct' || g.verdict === 'typo' || g.verdict === 'chinese') {
    guidedMicroWrongs.delete(key);
    return res.json({ ok: true });
  }
  const n = (guidedMicroWrongs.get(key) || 0) + 1;
  guidedMicroWrongs.set(key, n);
  const hint = '「' + label + '」这一项还没写对，再对照材料想一想。';
  if (n >= 2) return res.json({ ok: false, hint, reveal: revealOf(entry) });
  return res.json({ ok: false, hint });
});

// 针对性反馈：判分时发现的具体冲突（中文时间上午/下午写反、星期写错），放最前面
function conflictFeedback(step, detail) {
  const out = [];
  for (const it of ((detail && detail.items) || [])) {
    if (it.status !== 'contradiction' || !it.conflict) continue;
    const e = (step.expects || []).find(x => x.id === it.id);
    const label = dimLabel(step, it.id);
    if (it.conflict.kind === 'meridiem') {
      const wantCn = (e && e.meridiem === 'am') ? '上午' : '晚上';
      out.push(`${label}写错了：你写的是${it.conflict.wrote}，通知里说的是${wantCn}。`);
    } else if (it.conflict.kind === 'weekday') {
      out.push(`${label}写错了，再对照通知看是星期几。`);
    }
  }
  return out;
}

// 挑出给学生看的反馈语（选择题：答对讲原因；答错给针对性提示；简答题：常见错误提示）
function feedbackFor(step, verdict, given, detail) {
  if (!step) return '';
  if (step.kind === 'mcq') {
    if (verdict === 'correct' || verdict === 'correct_retry') return step.explain || '';
    const fb = (step.wrong_feedback || {})[String(given || '').trim().toUpperCase()];
    return fb || '再看一看通知。';
  }
  // short
  if (verdict === 'correct' || verdict === 'correct_retry') return step.explain || '';
  if (verdict === 'copied') return '好的，记为有帮助完成，下次换道题再考这个知识点。';
  if (verdict === 'typo' || verdict === 'chinese') return (detail && detail.note) || '';
  // wrong / wrong_retry：反馈只针对她实际写的内容
  // 顺序：判分冲突针对性反馈（最前面）→ 预判错法 say → 部分对肯定 → 接地后的 common_errors
  const parts = [];
  for (const c of conflictFeedback(step, detail)) parts.push(c);
  if (detail && detail.predicted && detail.predicted.say) parts.push(detail.predicted.say);
  const aff = okAffirm(step, detail);
  for (let i = 0; i < aff.length; i++) parts.push(aff[i]);
  const gs = groundedSays(step, given, detail);
  for (let i = 0; i < gs.length; i++) parts.push(gs[i]);
  const fb = parts.filter(Boolean).join('\n');
  return fb || ((detail && detail.note) || '再想一想。');
}

// 提交作答并判分（规则见 server/attempts.js），附带反馈语
app.post('/api/attempt', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const itemId = String(body.item_id || '');
  // 防重做：该部分已在服务端标记完成，直接拒绝（与浏览器数据无关）
  const lid = lessonOf(itemId) || 'u2r1';
  // 2026-10-16修：错题重做（单题/批量）豁免课程解锁检查——错题本是复习，不是新学；
  // 否则 u4r1 错题在课程未解锁时提交会被 403，客户端 renderHome 又重头开始，形成死循环卡死孩子。
  const isRetryEarly = body.is_retry === true || body.is_retry === 1 || body.is_retry === '1';
  // 二审三1：课没开放就拒绝作答（防直接调接口）；重做模式豁免
  if (!isRetryEarly && !lessonOpen(lid)) return res.status(403).json({ ok: false, error: 'lesson_locked' });
  const L = loadLesson(lid);
  const st = lessonState(lid);
  const step = L ? L.stepsByItem[itemId] : null;
  const phase = step ? (step.phase || 'practice') : 'practice';
  const sid = String(body.session_id || '');
  // 2026-10-15：错题重做（单题/批量）豁免防重做——用户从错题本主动发起，不算刷课
  // （isRetryEarly 已在 lessonOpen 检查前定义，这里复用）
  const isRetry = isRetryEarly;
  if (step && !isRetry) {
    // 第二部分开场复习放行（2026-10-02 规范第 7 条）：第二部分已开放时，复习池题目
    // 在当前（第二部分）会话里、尚未答对前，允许重答一次热身，不算"重做第一部分"。
    const reviewRedo = phase === 'practice'
      && review.isReviewPoolItem(lid, itemId)
      && review.p2OpenNow(lid)
      && db.prepare("SELECT COUNT(*) c FROM attempts WHERE item_id=? AND session_id=? AND correct=1")
        .get(itemId, sid).c === 0;
    // 练习课（review*）豁免防重做：练完一遍还能再练（2026-10-02 总任务书：练习模式可反复练）；
    // 正课防重做保持不变。
    if (!isReviewLesson(lid) && !reviewRedo && ((phase === 'practice' && st.p1_done === 1) || (phase !== 'practice' && st.p2_done === 1))) {
      return res.status(403).json({ ok: false, error: 'part_done' });
    }
  }
  // 预判错法匹配（short 判 wrong 后用；先算好，attempts.js 在判 wrong 时记入 detail_json）
  let predicted = null;
  if (step && step.kind === 'short') predicted = matchPredicted(step, body.answer);
  // 按需补种（2026-10-18）：draft 课（yw-/sx-）若 seed 未入库，作答时从文件补种题目——
  // 防 gdrive-restore 覆盖或 seed 未跑导致的 no_item
  try {
    const hasItem = db.prepare('SELECT 1 FROM items WHERE item_id=?').get(itemId);
    if (!hasItem) {
      const mm = /^(.+)-v\d+-s\d+$/.exec(itemId);
      if (mm) {
        const seedLid = mm[1];
        const st = (/^sx\d+$/.test(seedLid) || /^yw-/.test(seedLid)) ? 'draft' : 'pilot';
        seed.seedLesson(seedLid, null, st);
      }
    }
  } catch {}
  const r = attempts.submitAttempt({ item_id: body.item_id, answer: body.answer,
    session_id: body.session_id, saw_feedback: body.saw_feedback,
    elapsed_ms: body.elapsed_ms, copied: body.copied ? 1 : 0, predicted,
    pasted: body.pasted ? 1 : 0 });
  if (r.error === 'no_item') return res.status(404).json({ ok: false, error: 'no_item' });
  // h 版（2026-10-03）：验证阶段第 2 次答错 → 403 retry_exhausted + show_answer。
  // 先判分再拦：答对（correct_retry）照常放行，只有"又答错了"才给保底出口。
  if (step && phase !== 'practice' && !body.copied &&
      (r.verdict === 'wrong' || r.verdict === 'wrong_retry')) {
    const wrongs = db.prepare(
      `SELECT COUNT(*) c FROM attempts WHERE item_id=? AND session_id=? AND verdict IN ('wrong','wrong_retry')`
    ).get(itemId, sid).c;
    if (wrongs >= 2) {
      return res.status(403).json({ ok: false, error: 'retry_exhausted', show_answer: showAnswerOf(step) });
    }
  }
  if (r.error === 'bad_kind') return res.status(400).json({ ok: false, error: 'bad_kind' });
  r.feedback = feedbackFor(step, r.verdict, body.answer, r.detail);
  // 真人老师式纠错（g 版）：带着做 + 保底出口
  if (step && (r.verdict === 'wrong' || r.verdict === 'wrong_retry')) {
    if (step.kind === 'short' && phase === 'practice' && guidedTrigger(itemId, sid)) {
      const gs = guidedSteps(step, r.detail);
      if (gs.length) r.guided = { steps: gs };
    }
    // 保底：练习阶段同一题第 3 次 wrong（mcq 无带着做，直接保底）
    const wrongs = db.prepare(
      `SELECT COUNT(*) c FROM attempts WHERE item_id=? AND session_id=? AND verdict IN ('wrong','wrong_retry')`
    ).get(itemId, sid).c;
    if (wrongs >= 3 && phase === 'practice') r.show_answer = showAnswerOf(step);
  }
  // 用时过短的轻提醒：有阅读材料的题，首次作答几秒钟就交——只提醒，不扣分不批评
  const ms = Number(body.elapsed_ms);
  if (r.first_try && step && step.reading && Number.isFinite(ms) && ms < NUDGE_MS) {
    r.nudge = '再看一遍通知，确认一下。';
  }
  res.json(r);
});

// 首页：只输域名不再 404。已验证进"当前进行中的课"，未验证去访问码页。
// （2026-09-30 Elouise 二审三1：不能跳"最新一课"，要跳"当前进行中的课"——
//  第 1 课没做完（p2_done=0）就一直进第 1 课；第 1 课做完才开放第 2 课。）
// 之前（2026-09-29 现场修复）是跳最新一课，已按二审意见改掉。
// 2026-10-02 总任务书：正课全学完后首页落练习课（review*），"学完新课自动接着练"。
function orderedLessons() {
  try {
    const rows = db.prepare(
      "SELECT lesson_id FROM lessons WHERE status != 'draft'"
    ).all();
    if (rows.length) {
      const ids = rows.map(r => r.lesson_id);
      // 主线：u2r1-u6r5 按教学顺序（2026-10-10 修复：原按 lesson_id 字母排序，deep1 会排到 u2r1 前面）
      const mainOrder = [];
      for (let u = 2; u <= 6; u++) {
        for (let r = 1; r <= 5; r++) {
          const lid = `u${u}r${r}`;
          if (ids.includes(lid)) mainOrder.push(lid);
        }
      }
      // 加餐/学科课（deep/moon/sx/yw）：不参与英语主线，排在主线后面
      const extras = ids.filter(id => /^(deep|moon)\d+$/.test(id) || /^(sx\d+|yw)/.test(id));
      // 练习课最后（保持现有逻辑）
      const reviews = ids.filter(id => isReviewLesson(id));
      return [...mainOrder, ...extras, ...reviews];
    }
  } catch { /* 查不到就用默认 */ }
  return ['u2r1'];
}
// 最后一次学习的课：按 progress 表的最新更新时间（2026-10-10，Elouise 要求首页回到上次位置）
function lastStudiedLesson() {
  try {
    const row = db.prepare(
      "SELECT lesson_id FROM progress ORDER BY updated_at DESC LIMIT 1"
    ).get();
    if (row && row.lesson_id && validLesson(row.lesson_id)) return row.lesson_id;
  } catch { /* 表不存在或查询失败就回退到 currentLesson */ }
  return null;
}
// 当前进行中的课：第一门没学完的正课；正课全学完则落第一门练习课（没有练习课则回最后一门正课）
function currentLesson() {
  const ids = orderedLessons();
  const regular = ids.filter(id => !isReviewLesson(id));
  for (const lid of regular) {
    const st = lessonState(lid);
    if (!(st && st.p2_done === 1)) return lid;
  }
  const reviews = ids.filter(id => isReviewLesson(id));
  if (reviews.length) return reviews[0];
  return regular[regular.length - 1] || ids[ids.length - 1];
}
// 每日复习门（2026-10-12 Elouise：没完成复习就不解锁新的）
// 待复习项：①待复测错题 ②review课未学完 ③专项巩固未通过
// 有待复习项时：新课、测验卷锁定；复习课、生词本、已开的课保持开放
function getPendingReviews() {
  const pending = [];
  try {
    // ① 待复测错题（一直算）
    const rc = db.prepare("SELECT COUNT(*) as c FROM retest_queue WHERE status='pending'").get();
    if (rc && rc.c > 0) pending.push({ type: 'retest', count: rc.c, label: `待复测错题 ${rc.c} 道` });
    // ② review课：只看当前单元（2026-10-13 Elouise定：旧单元的加练课不算，不永久锁课）
    // 2026-10-13补（Elouise要求）：单元的5节课没学完，它的复习就不算待办。
    // 孩子连单元都没学完，根本没法做这个复习，不能拿它去锁新课，否则死锁。
    // 只有"学完了单元、复习还没做"，才算真正的待办。
    const curUnit = currentUnit();
    const reviewUnit = { review1: 2, review2: 2, review3: 3 };
    const allReviews = ['review1', 'review2', 'review3'];
    const stateMap = {};
    db.prepare("SELECT lesson_id, p1_done, p2_done FROM lesson_state WHERE lesson_id LIKE 'review%'")
      .all().forEach(r => { stateMap[r.lesson_id] = r; });
    for (const rid of allReviews) {
      const u = reviewUnit[rid];
      if (u !== curUnit) continue; // 非当前单元的review不计入
      if (!unitLessonsDone(u)) continue; // 单元没学完：复习还没到该做的时候，不计入
      const st = stateMap[rid];
      if (!st) pending.push({ type: 'review', lesson_id: rid, label: `${rid} 未学` });
      else if (st.p1_done !== 1 || st.p2_done !== 1)
        pending.push({ type: 'review', lesson_id: rid, label: `${rid} 未学完` });
    }
    // ③ u3专项巩固未通过（仅当孩子已进入Unit 3）
    // 2026-10-13补：同样，u3r1-u3r5没学完就不算待办，学完了还没过才算。
    const u3started = db.prepare("SELECT 1 FROM lesson_state WHERE lesson_id LIKE 'u3r%' LIMIT 1").get();
    if (u3started && unitLessonsDone(3)) {
      const cd = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_done'").get();
      if (!cd || cd.value !== '1')
        pending.push({ type: 'consolidate', lesson_id: 'u3-consolidate', label: 'Unit 3 专项巩固未通过' });
    }
  } catch (e) { console.error('[reviews]', e.message); }
  return pending;
}
// 当前单元 = 孩子有真实进度的正课中的最大单元号（2026-10-13：复习门只看当前单元）
// 注意：只看 p1_done/p2_done=1 的课，单纯点开过（0/0）的不算，避免误判
function currentUnit() {
  try {
    const rows = db.prepare(
      "SELECT lesson_id FROM lesson_state WHERE lesson_id GLOB 'u[0-9]r[0-9]*' AND (p1_done = 1 OR p2_done = 1)"
    ).all();
    let m = 0;
    for (const r of rows) {
      const mt = /^u(\d+)r\d+/.exec(r.lesson_id || '');
      if (mt) m = Math.max(m, parseInt(mt[1], 10));
    }
    return m;
  } catch { return 0; }
}
// 单元的5节正课是否全部学完（p2_done=1）。用于判断该单元的复习是否"到该做的时候"。
// 2026-10-13 Elouise要求：单元没学完，它的复习就不算待办，不能锁新课。
function unitLessonsDone(u) {
  try {
    for (let i = 1; i <= 5; i++) {
      const st = db.prepare("SELECT p2_done FROM lesson_state WHERE lesson_id=?").get(`u${u}r${i}`);
      if (!st || st.p2_done !== 1) return false;
    }
    return true;
  } catch { return false; }
}
function hasPendingReviews() { return getPendingReviews().length > 0; }

// 每天10道错题检查（2026-10-14 Elouise：解锁新课要求③）
// 规则：每天从错题本做10道，完全独立完成、不点老师教我；不足10道做完为止
// 2026-10-15修：目标数按"今日开始时的待复测数"算，即 当前剩余 + 今日已完成，
// 避免"越做目标越小"的 bug（之前用 Math.min(10, 当前剩余)，做3道后目标从10变7）
function checkDailyMistakes() {
  try {
    // 今天独立完成的错题数（上海日期）
    // 条件：correct=1, helped=0, independent=1，且这道题曾经错过（是错题本里的）
    const today = shanghaiDay();
    const r = db.prepare(`
      SELECT COUNT(DISTINCT a.item_id) c FROM attempts a
      WHERE a.correct=1 AND a.helped=0 AND a.independent=1
      AND date(a.created_at, '+8 hours') = ?
      AND (
        EXISTS (SELECT 1 FROM retest_queue q WHERE q.item_id=a.item_id)
        OR EXISTS (SELECT 1 FROM attempts b WHERE b.item_id=a.item_id AND b.correct=0 AND b.rowid < a.rowid)
      )
    `).get(today);
    const doneToday = r ? r.c : 0;
    // 当前待复测错题数
    let pending = 0;
    try {
      const pr = db.prepare("SELECT COUNT(*) c FROM retest_queue WHERE status='pending'").get();
      pending = pr ? pr.c : 0;
    } catch {}
    // 目标 = 今日开始时的可做错题数（当前剩余 + 今日已完成），最多10道
    // 例：开始有8道，做3道后剩5道，目标仍是8（不是5），需做完8道
    const target = Math.min(10, pending + doneToday);
    if (target <= 0) return true; // 没错题了，直接过
    return doneToday >= target;
  } catch { return false; }
}

// 今日错题进度（供弹窗显示）：{done, target, pending}
function getDailyMistakeProgress() {
  try {
    const today = shanghaiDay();
    const r = db.prepare(`
      SELECT COUNT(DISTINCT a.item_id) c FROM attempts a
      WHERE a.correct=1 AND a.helped=0 AND a.independent=1
      AND date(a.created_at, '+8 hours') = ?
      AND (
        EXISTS (SELECT 1 FROM retest_queue q WHERE q.item_id=a.item_id)
        OR EXISTS (SELECT 1 FROM attempts b WHERE b.item_id=a.item_id AND b.correct=0 AND b.rowid < a.rowid)
      )
    `).get(today);
    const done = r ? r.c : 0;
    let pending = 0;
    try {
      const pr = db.prepare("SELECT COUNT(*) c FROM retest_queue WHERE status='pending'").get();
      pending = pr ? pr.c : 0;
    } catch {}
    const target = Math.min(10, pending + done);
    return { done, target, pending, ok: done >= target };
  } catch { return { done: 0, target: 10, pending: 0, ok: false }; }
}

// 某课是否已开放：正课看它前面的正课是否全部学完（第 1 课永远开放）；
// 练习课在正课全部学完后开放。学会马上往下学，不看日期（2026-10-02 总任务书）。
function lessonOpen(lid) {
  // 深海/登月加餐课永远开放（补充课不阻塞主线）
  if (/^(deep|moon)\d+$/.test(lid)) return true;
  // review3 是针对性干预复习课（2026-10-11），随时可进，不等主线学完
  if (lid === 'review3') return true;
  // u3-consolidate 是 Unit 3 专项巩固课（2026-10-11 踩刹车），随时可进
  if (lid === 'u3-consolidate') return true;
  // Unit 3 专项巩固课（2026-10-11 Elouise：严禁盲目赶进度），随时可进
  if (lid === 'u3-consolidate') return true;
  // Unit 4 锁定（2026-10-11 Elouise：严禁盲目赶进度；2026-10-12加：review3也必须学完）
  // 解锁条件：①u3-consolidate 通过（零求助、独立正确率≥85%）②review3 学完（p1+p2）
  // 2026-10-14加：③每天从错题本做10道（独立完成、不点老师教我，不足10道做完为止）
  // 没完成复习就不解锁新的
  if (/^u4r\d+$/.test(lid)) {
    try {
      const done = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_done'").get();
      if (!done || done.value !== '1') return false;
      const r3 = db.prepare("SELECT p1_done, p2_done FROM lesson_state WHERE lesson_id='review3'").get();
      if (!r3 || r3.p1_done !== 1 || r3.p2_done !== 1) return false;
      // ③ 每天10道错题（2026-10-14 Elouise）
      if (!checkDailyMistakes()) return false;
      // 2026-10-15修：三条件全过，直接解锁，不再走后面的每日复习门（否则41道待复测永远拦着）
      // 2026-10-17修：三门过只解锁 u4r1，u4r2+ 仍需前一课完成（逐课开放）
      // 之前 return true 导致 u4r1-u4r5 同时开放——Elouise 10-16 报告高风险
      if (lid === 'u4r1') return true;
      // u4r2+：检查前一课是否完成
      const num = parseInt(lid.replace('u4r', ''), 10);
      if (num > 1) {
        const prev = `u4r${num - 1}`;
        const st = lessonState(prev);
        if (!(st && st.p2_done === 1)) return false;
      }
      return true;
    } catch { return false; }
  }
  // 数学/语文课独立，不参与英语主线解锁
  if (/^(sx\d+|yw-[a-z0-9]+|yw\d+-[a-z]+)$/.test(lid)) return true;
  // 每日复习门（2026-10-12）：有待复习项时，未开的新正课锁定
  // 复习课本身、已开的课（有真实进度的）不受影响
  // 2026-10-13修："已开"只认 p1_done/p2_done=1 的真实进度，单纯点开过（0/0）的
  // 不算已开，否则 u5/u6 的 0/0 打开记录会绕过门禁。
  if (/^u[2-6]r\d+$/.test(lid) && !isReviewLesson(lid)) {
    try {
      const st = lessonState(lid);
      const started = st && (st.p1_done === 1 || st.p2_done === 1);
      if (!started) {
        // 2026-10-18修：错题门禁按"每天10道"（Elouise 10-15定），不是清完所有待复测；
        // 之前用 hasPendingReviews()（待复测>0就锁），导致 u5r1 被幽灵错题永久锁死（当晚事故）。
        // review课/专项巩固的待办仍按原来锁，只有 retest 改走每日10道口径。
        const nonRetest = getPendingReviews().filter(p => p.type !== 'retest');
        if (nonRetest.length > 0) return false;
        if (!checkDailyMistakes()) return false;
      }
    } catch {}
  }
  const ids = orderedLessons();
  if (!ids.includes(lid)) return true; // 未入库的 id 由各调用点的白名单先拦，这里保持旧行为
  // 主线只算 u2r-u6r（排除 review、deep、moon、sx、yw）
  const isMainline = id => /^(u[2-6]r\d+|review\d+)$/.test(id);
  const regular = ids.filter(id => isMainline(id) && !isReviewLesson(id));
  const allRegularDone = regular.every(id => {
    const st = lessonState(id);
    return st && st.p2_done === 1;
  });
  if (isReviewLesson(lid)) return allRegularDone;
  const ri = regular.indexOf(lid);
  if (ri <= 0) return true;
  for (let k = 0; k < ri; k++) {
    const st = lessonState(regular[k]);
    if (!(st && st.p2_done === 1)) return false;
  }
  return true;
}
// 管理员数据修复：补记review3的p2完成（2026-10-13：practice_end bug导致P2为空，孩子16步全做完但p2_done=0）
// 验证：review3的16个item都有作答记录，才补记
app.post('/api/admin/fix-review3-p2', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    // 查review3有多少个item
    const items = db.prepare("SELECT COUNT(DISTINCT item_id) c FROM attempts WHERE item_id LIKE 'review3%'").get();
    const doneItems = db.prepare("SELECT COUNT(DISTINCT item_id) c FROM attempts WHERE item_id LIKE 'review3%' AND correct=1").get();
    // 至少做过10个item才补（防止误操作）
    if (!items || items.c < 10) {
      return res.json({ ok: false, error: 'not_enough_attempts', count: items ? items.c : 0 });
    }
    db.prepare("UPDATE lesson_state SET p1_done=1, p2_done=1, updated_at=datetime('now') WHERE lesson_id='review3'").run();
    const st = db.prepare("SELECT p1_done, p2_done FROM lesson_state WHERE lesson_id='review3'").get();
    console.log('[admin] fix-review3-p2: items=' + items.c + ', correct_items=' + (doneItems ? doneItems.c : 0));
    res.json({ ok: true, p1_done: st.p1_done, p2_done: st.p2_done, items: items.c });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员修复：u3-consolidate 被自动重置 bug 卡住，恢复完成状态（2026-10-14）
// 背景：自动重置逻辑导致"做完→刷新→又没做完"死循环，Elouise 10:23-10:30 做的20题被 10:30:26 的重置清空
app.post('/api/admin/fix-consolidation-reset', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    // 验证：10:23-10:30 确实做完了20题
    const done = db.prepare(`
      SELECT COUNT(DISTINCT item_id) c FROM attempts
      WHERE item_id LIKE 'u3-consolidate%' AND correct=1
      AND created_at BETWEEN '2026-10-14 10:20:00' AND '2026-10-14 10:31:00'
    `).get();
    if (!done || done.c < 15) {
      return res.json({ ok: false, error: 'not_enough_evidence', count: done ? done.c : 0 });
    }
    db.prepare("UPDATE lesson_state SET p1_done=1, p2_done=1, updated_at=datetime('now') WHERE lesson_id='u3-consolidate'").run();
    const st = db.prepare("SELECT p1_done, p2_done FROM lesson_state WHERE lesson_id='u3-consolidate'").get();
    console.log('[admin] fix-consolidation-reset: restored p1/p2=1, evidence_items=' + done.c);
    res.json({ ok: true, p1_done: st.p1_done, p2_done: st.p2_done, evidence: done.c });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：彻底清空 u3-consolidate 进度（2026-10-14 18:55）
// Elouise 点"重新挑战"后仍从第13步续上——progress 表没清。现在彻底清掉，回到原生状态
app.post('/api/admin/clear-consolidation', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    db.prepare("UPDATE lesson_state SET p1_done=0, p2_done=0, updated_at=datetime('now') WHERE lesson_id='u3-consolidate'").run();
    db.prepare("DELETE FROM progress WHERE lesson_id='u3-consolidate'").run();
    startConsolidationSession();
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：修复 sawFb bug 导致的误标 helped（2026-10-14 19:10）
// 背景：答错后的反馈把 sawFb 置 true，导致重试被误记为用了提示。Elouise 确认 s7/s8 没点过帮助。
// 2026-10-14 19:54扩展：也修 session_id 复用污染的（s3 用了旧 sid，关联到昨天的 help_events）
app.post('/api/admin/fix-sawfb-helped', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const sess = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
    const sessTime = sess ? sess.value : '2020-01-01';
    // 修 s7/s8（sawFb bug）+ s3（session_id 复用污染）
    // 条件：当前轮次内、correct、没有当前轮次内的 help_events
    const r = db.prepare(`
      UPDATE attempts SET helped=0, independent=1
      WHERE item_id IN ('u3-consolidate-v1-s3', 'u3-consolidate-v1-s7', 'u3-consolidate-v1-s8')
      AND created_at >= ? AND verdict IN ('correct', 'correct_retry')
      AND NOT EXISTS (
        SELECT 1 FROM help_events h 
        WHERE h.item_id=attempts.item_id AND h.created_at >= ?
      )
    `).run(sessTime, sessTime);
    res.json({ ok: true, fixed: r.changes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：移除称号（2026-10-14 19:35 Elouise要求）
// 背景："知错就改"在难度1时就被获得，现难度提到20，需收回
app.post('/api/admin/revoke-title', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const { title_id } = req.body || {};
    if (!title_id) return res.json({ ok: false, error: 'no_title_id' });
    const r = db.prepare('DELETE FROM titles WHERE title_id=?').run(title_id);
    console.log('[admin] revoke-title:', title_id, 'deleted:', r.changes);
    res.json({ ok: true, revoked: title_id, deleted: r.changes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：删除今日打卡（2026-10-17：修复误记的每日闯关打卡）
app.post('/api/admin/delete-checkin', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const { day } = req.body || {};
    const targetDay = day || require('./time').shanghaiDay();
    const r = db.prepare('DELETE FROM checkins WHERE day=?').run(targetDay);
    console.log('[admin] delete-checkin:', targetDay, 'deleted:', r.changes);
    res.json({ ok: true, day: targetDay, deleted: r.changes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：清理错题本重复pending（2026-10-17 Elouise死命令：删重复、删已做对的）
// 2026-10-18：每晚画像写入（23点定时任务调用，把深度分析结果存进库，成长页优先显示）
app.post('/api/admin/set-profile', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const profile = req.body && req.body.profile;
    if (!profile || typeof profile !== 'object' || !profile.date) {
      return res.status(400).json({ ok: false, error: 'bad_profile' });
    }
    db.prepare(`INSERT INTO app_state(key, value) VALUES('nightly_profile', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(profile));
    res.json({ ok: true, date: profile.date });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

app.post('/api/admin/cleanup-retest', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    // 1. 删重复：每个item_id只留最早的一条pending，其余删除
    const dups = db.prepare(`
      DELETE FROM retest_queue WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY id ASC) as rn
          FROM retest_queue WHERE status='pending'
        ) WHERE rn > 1
      )
    `).run();
    // 2. 删已做对的：今天有correct=1,helped=0,independent=1的，删其pending
    const today = require('./time').shanghaiDay();
    const done = db.prepare(`
      DELETE FROM retest_queue WHERE status='pending' AND item_id IN (
        SELECT DISTINCT item_id FROM attempts
        WHERE correct=1 AND helped=0 AND independent=1
        AND date(created_at, '+8 hours') = ?
      )
    `).run(today);
    // 3. 删"已解决又有待办"的：item已有resolved，其pending是旧重复（2026-10-18 Elouise批准清掉）
    const stale = db.prepare(`
      DELETE FROM retest_queue WHERE status='pending' AND item_id IN (
        SELECT item_id FROM retest_queue WHERE status='resolved'
      )
    `).run();
    // 4. 删"卡住"的：pending创建后有过correct作答，但没消掉（2026-10-18 Elouise：重做多次做对还卡着）
    const stuck = db.prepare(`
      DELETE FROM retest_queue WHERE status='pending' AND id IN (
        SELECT q.id FROM retest_queue q
        WHERE q.status='pending'
        AND EXISTS (
          SELECT 1 FROM attempts a
          WHERE a.item_id = q.item_id
          AND a.correct = 1
          AND a.created_at >= q.created_at
        )
      )
    `).run();
    // 5. 测试批次（13:12同秒批量插入、knowledge_point='general'的26道）：标 resolved 而不是删除
    // （2026-10-18教训：直接 DELETE 会被 backfillWrongToRetest 复活——这些题 wrong≥2 且删后无 retest_queue 记录；
    // 标 resolved 后 backfill 的 q.id IS NULL 条件不成立，不会再加回来。2026-10-18 Elouise批准清掉）
    const testIds = ['u2r2-v3-s33','u2r2-v3-s34','u2r2-v3-s35','u2r3-v1-s29','u2r3-v1-s33','u2r3-v1-s35','u2r4-v1-s21','u2r4-v1-s34','u2r4-v1-s35','u2r5-v1-s17','u2r5-v1-s26','u2r5-v1-s34','u3r1-v1-s32','u3r2-v1-s31','u3r2-v1-s33','u3r3-v1-s31','u3r3-v1-s32','u3r4-v1-s30','u3r4-v1-s31','u3r4-v1-s34','u3r5-v1-s28','u3r3-v1-s20','u2r4-v1-s32','u4r2-v1-s29','u4r2-v1-s35','u3r2-v1-s30'];
    const testBatch = db.prepare(`
      UPDATE retest_queue SET status='resolved', resolved_at=datetime('now')
      WHERE status='pending' AND item_id IN (${testIds.map(() => '?').join(',')})
    `).run(...testIds);
    // 兜底：若连 pending 行都没有（已被删），补 resolved 行防 backfill 复活
    const insRes = db.prepare(`INSERT INTO retest_queue(item_id, knowledge_point, status, resolved_at)
      SELECT ?, 'general', 'resolved', datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM retest_queue WHERE item_id=?)`);
    let testBatchIns = 0;
    for (const iid of testIds) { testBatchIns += insRes.run(iid, iid).changes; }
    console.log('[admin] cleanup-retest: dups_deleted=', dups.changes, 'done_deleted=', done.changes, 'stale_deleted=', stale.changes, 'stuck_deleted=', stuck.changes, 'testBatch_resolved=', testBatch.changes, 'testBatch_ins=', testBatchIns);
    res.json({ ok: true, dups_deleted: dups.changes, done_deleted: done.changes, stale_deleted: stale.changes, stuck_deleted: stuck.changes, testBatch_resolved: testBatch.changes, testBatch_ins: testBatchIns });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// 管理员：恢复签到（2026-10-17：恢复误删的Elouise签到）
app.post('/api/admin/restore-checkin', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'] || (req.body || {}).token;
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const { day, kind } = req.body || {};
    const d = day || require('./time').shanghaiDay();
    const k = kind || 'manual';
    db.prepare("INSERT OR IGNORE INTO checkins(day, kind, created_at) VALUES(?, ?, datetime('now'))").run(d, k);
    res.json({ ok: true, day: d, kind: k });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// 管理员备份接口：下载 SQLite 数据库文件（用于 Google Drive 自动备份）
// 需要 BACKUP_TOKEN 环境变量验证
app.get('/api/admin/backup', (req, res) => {
  const token = req.query.token || req.headers['x-backup-token'];
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const dataDir = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
  const dbFile = process.env.XH_DB_FILE || 'xiaohe.sqlite';
  const dbPath = path.join(dataDir, dbFile);
  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ ok: false, error: 'no_db' });
  }
  // 关键修复：WAL 模式下，先把 WAL 合并到主库，否则备份会丢最近的数据
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.error('[backup] WAL checkpoint 失败:', e.message);
  }
  res.download(dbPath, dbFile);
});

// 启动时从 Google Drive 恢复数据库（如果本地库是空的）
app.get('/', (req, res) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) {
    return res.redirect('/verify.html');
  }
  // 摸底诊断安排（总指挥2026-10-03）：j上线后，每次学习开头自动安排一段诊断，
  // 做完直接接着上课，3次学习完成3段。
  const diagNext = nextDiagnosticSection();
  if (diagNext) {
    return res.redirect('/diagnostic?form=A&section=' + diagNext);
  }
  // 学习地图首页（2026-10-11）：显示所有课程节点，孩子点进去上课。
  // "继续学习"按钮由前端按 localStorage 跳转到当前课。
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 下一段未完成的诊断（1/2/3），全部完成返回 null
function nextDiagnosticSection() {
  for (let s = 1; s <= 3; s++) {
    const row = db.prepare(
      "SELECT id FROM diagnostic_sessions WHERE form='A' AND section=? AND status='completed' LIMIT 1"
    ).get(s);
    if (!row) return s;
  }
  return null;
}

// 课程页：需验证（未验证跳到访问码页）
function lessonPage(req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'lesson.html'));
}
// 课程页：需验证（未验证跳到访问码页，与 /lesson.html 同一逻辑，不再回 401 JSON 原文）
app.get('/lesson', (req, res, next) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) return res.redirect('/verify.html');
  next();
}, lessonPage);
app.get('/lesson.html', (req, res, next) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) return res.redirect('/verify.html');
  next();
}, lessonPage);
// 知识点掌握追踪（2026-10-03 P2）
app.get('/api/mastery', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT knowledge_point, status FROM knowledge_mastery ORDER BY updated_at DESC').all();
  res.json({ ok: true, items: rows });
});

// 客户端错误上报（2026-10-03 k包）：页面脚本错误自动发到服务器日志，带设备信息
// 用于定位 C10 等设备上"按钮点不动"这类前端故障
app.post('/api/client-error', auth.requireAuth, (req, res) => {
  const { message, source, lineno, colno, stack, url, user_agent } = req.body || {};
  const ua = String(user_agent || req.headers['user-agent'] || '').slice(0, 500);
  try {
    db.prepare(`INSERT INTO client_errors(message, source, lineno, colno, stack, url, user_agent, created_at)
                VALUES(?,?,?,?,?,?,?,datetime('now'))`)
      .run(String(message || '').slice(0, 2000), String(source || '').slice(0, 500),
           Number(lineno) || 0, Number(colno) || 0,
           String(stack || '').slice(0, 4000), String(url || '').slice(0, 500), ua);
  } catch (e) {
    // 日志表写入失败不影响主流程
    console.error('[client-error] 写入失败:', e.message);
  }
  res.json({ ok: true });
});

// 摸底诊断页（2026-10-03 P2）：同样需要登录
app.get('/diagnostic', (req, res, next) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) return res.redirect('/verify.html');
  next();
}, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'diagnostic.html')));
app.get('/diagnostic.html', (req, res, next) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) return res.redirect('/verify.html');
  next();
}, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'diagnostic.html')));
// 我的进步页（2026-10-03 P2）：掌握追踪 + 错题本
app.get('/progress-page', (req, res, next) => {
  if (!auth.verifyCookie(auth.getCookieValue(req))) return res.redirect('/verify.html');
  next();
}, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'progress.html')));

// 音频：需验证后才能听
app.use('/audio', auth.requireAuth, express.static(path.join(__dirname, '..', 'audio')));

// 静态资源：验证页等公开；课程页走上面的鉴权路由
// 2026-10-12：HTML文件禁缓存，确保Elouise打开即看到最新版（不用清缓存）
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
    }
  }
}));

const PORT = process.env.PORT || 3101;
// 开机自动入库：空库或缺题时自动 seed，不依赖人工执行
// （2026-09-29 C10 事故：安装漏了 seed，作答提交 no_item）
seedReport = require('./seed').autoSeed();
for (const r of seedReport) {
  if (r.error) console.error(`[seed] ${r.lesson_id} 自动入库失败：${r.error}`);
  else if (r.seeded) console.log(`[seed] ${r.lesson_id} 自动入库 ${r.seeded} 道题`);
}
if (require.main === module) {
  // Render/云部署：允许用环境变量 ACCESS_CODE 直接设置访问码（免一次性口令流程）
  if (process.env.ACCESS_CODE && !auth.isSetupDone()) {
    auth.trySetupDirect(String(process.env.ACCESS_CODE));
    console.log('已用环境变量 ACCESS_CODE 设置访问码。');
  }
  const token = auth.ensureSetupToken();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`xiaohe-v2 listening on 0.0.0.0:${PORT}`);
    if (token) {
      // 一次性设置口令：写文件（仅本机可读），不打进日志；设置成功后自动删除
      const dataDir = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const fp = path.join(dataDir, 'setup_token.txt');
      fs.writeFileSync(fp, token + '\n', { mode: 0o600 });
      console.log('一次性设置口令已写入 data/setup_token.txt（仅本机可读），设置成功后自动删除。');
    }
  });
}
module.exports = app;
// 测试钩子（故事选择持久化）：纯函数与步骤下发，供 tests/story-choice.test.js 用
app.choiceHooks = { substituteChoices, publicStep, loadChoices };
// 测试钩子（真人老师式纠错 g 版）：反馈接地与预判匹配，供 tests/guided-never-stuck.test.js 用
app.guidedHooks = { expectValues, textHit, whenAllows, groundedSays, okAffirm,
  dimLabel, matchPredicted, showAnswerOf, guidedTrigger, guidedSteps, feedbackFor };
