'use strict';
// 小禾英语 V2 试点服务(本阶段:本机运行,不对外开放)
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
  try { return !!db.prepare('SELECT 1 FROM lessons WHERE lesson_id=?').get(lid); }
  catch { return false; }
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
// lesson_id 只允许 u<数字>r<数字>（英语正课）、review<数字>（练习课）、sx<数字>（数学课）、
// yw-xxx（语文课）、deep<数字>/moon<数字>（CLIL 跨学科课），防止路径穿越
const LESSON_CACHE = {};
// 练习课（练习模式）：正课全部学完后开放，可反复练（豁免防重做）
function isReviewLesson(lid) { return /^review\d+$/.test(String(lid || '')); }
function loadLesson(lessonId) {
  const lid = String(lessonId || 'u2r1');
  if (!/^(?:u2r\d+|u3r\d+|u4r\d+|u5r\d+|u6r\d+|review\d+|sx\d+|yw\d*-[a-z0-9]+|deep\d+|moon\d+)$/.test(lid)) return null;
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
  const rows = db.prepare(
    'SELECT item_id, independent, helped, correct FROM attempts WHERE item_id LIKE ?'
  ).all(lid + '-%');
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
  if (s.kind === 'mcq' || s.kind === 'short') o.item_id = `${lessonId}-v${version}-s${s.item_step || s.step}`;
  if (s.kind === 'mcq') o.options = s.options;
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
  const { access_code } = req.body || {};
  if (!auth.isSetupDone()) {
    return res.status(400).json({ ok: false, error: 'not_setup' });
  }
  if (!auth.checkVerifyCode(access_code)) {
    if (auth.recordVerifyFail(ip)) {
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    }
    return res.status(401).json({ ok: false, error: 'bad_code' });
  }
  auth.verifyRateReset(ip);
  auth.issueAuthCookie(res);
  res.json({ ok: true });
});

// 魔法链接：/go/<token> 直接登录，不用输码
// token = sha256('xh-magic:' + ACCESS_CODE)，不可猜，换平板书签打开就行
app.get('/go/:token', (req, res) => {
  const crypto = require('crypto');
  const envCode = process.env.ACCESS_CODE;
  if (!envCode) return res.status(404).send('not found');
  const expect = crypto.createHash('sha256').update('xh-magic:' + envCode).digest('hex').slice(0, 32);
  if (req.params.token !== expect) return res.status(404).send('not found');
  auth.issueAuthCookie(res);
  res.redirect('/');
});

// 需验证
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/lessons', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT lesson_id, title, status FROM lessons ORDER BY created_at').all();
  res.json({ lessons: rows });
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
  for (const w of ['old_info', 'spelling', 'omission']) {
    if (byWeak[w] > 0) weaknesses.push(WEAK_PARENT[w]);
  }
  for (const t of agg.weaknesses) {
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
  res.json({ ok: true });
});

// 课程步骤（去答案版；需验证）。?lesson=u2r2 取第 2 课；第 2 课的步骤 1 开场与复盘题由服务端动态生成/筛选
app.get('/api/lesson', auth.requireAuth, (req, res) => {
  if (req.query.lesson && !validLesson(String(req.query.lesson))) return badLesson(res);
  const lid = String(req.query.lesson || 'u2r1');
  const L = loadLesson(lid);
  if (!L) return res.status(404).json({ ok: false, error: 'no_lesson' });
  // 二审三1：前面的课没做完，这门课不开放（直接拼 URL 也进不来）
  if (!lessonOpen(lid)) return res.status(403).json({ ok: false, error: 'lesson_locked' });
  const steps = lid === 'u2r2' ? review.serveU2r2(L.lesson) : L.lesson.steps;
  const choices = loadChoices(lid); // 剧情回调：该课学生已做的选择
  res.json({
    lesson_id: lid, version: L.lesson.version, title: L.lesson.title,
    practice_end: L.lesson.practice_end || 22,
    home_subtitle: L.lesson.home_subtitle || '',
    part1_desc: L.lesson.part1_desc || '',
    part2_desc: L.lesson.part2_desc || '',
    // 数学课标记（前端按需加载 KaTeX）+ 多学科品牌/kicker 数据驱动
    math: !!L.lesson.math,
    brand: L.lesson.brand || '',
    kicker_story: L.lesson.kicker_story || '',
    kicker_teach: L.lesson.kicker_teach || '',
    answer_placeholder: L.lesson.answer_placeholder || '',
    steps: steps.map(s => publicStep(s, lid, L.lesson.version, choices)),
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
  res.json({ ok: true, pending: retest.getPending() });
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
  db.prepare("UPDATE diagnostic_sessions SET status='completed', completed_at=datetime('now') WHERE id=?")
    .run(session_id);
  res.json({ ok: true });
});

// 诊断状态：各段完成情况
app.get('/api/diagnostic/status', auth.requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT form, section, status FROM diagnostic_sessions ORDER BY form, section'
  ).all();
  res.json({ ok: true, sessions: rows });
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
  // 二审三1：课没开放就拒绝作答（防直接调接口）
  if (!lessonOpen(lid)) return res.status(403).json({ ok: false, error: 'lesson_locked' });
  const L = loadLesson(lid);
  const st = lessonState(lid);
  const step = L ? L.stepsByItem[itemId] : null;
  const phase = step ? (step.phase || 'practice') : 'practice';
  const sid = String(body.session_id || '');
  if (step) {
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
  const r = attempts.submitAttempt({ item_id: body.item_id, answer: body.answer,
    session_id: body.session_id, saw_feedback: body.saw_feedback,
    elapsed_ms: body.elapsed_ms, copied: body.copied ? 1 : 0, predicted });
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
      "SELECT lesson_id FROM lessons WHERE status != 'draft' ORDER BY lesson_id"
    ).all();
    if (rows.length) {
      // 正课在前（按课号），练习课在后：练习课不参与正课之间的开放门禁
      // 2026-10-08：主线英语课(u2r-u6r)优先，deep/moon为补充不阻塞主线
      const ids = rows.map(r => r.lesson_id);
      const main = ids.filter(id => /^u\dr\d+$/.test(id)).sort();
      const supp = ids.filter(id => /^(deep|moon)\d+$/.test(id)).sort();
      const other = ids.filter(id => !/^u\dr\d+$/.test(id) && !/^(deep|moon)\d+$/.test(id) && !isReviewLesson(id)).sort();
      const reviews = ids.filter(id => isReviewLesson(id)).sort();
      return [...main, ...supp, ...other, ...reviews];
    }
  } catch { /* 查不到就用默认 */ }
  return ['u2r1'];
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
// 某课是否已开放：正课看它前面的正课是否全部学完（第 1 课永远开放）；
// 练习课在正课全部学完后开放。学会马上往下学，不看日期（2026-10-02 总任务书）。
function lessonOpen(lid) {
  const ids = orderedLessons();
  if (!ids.includes(lid)) return true; // 未入库的 id 由各调用点的白名单先拦，这里保持旧行为
  const regular = ids.filter(id => !isReviewLesson(id));
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
  return res.redirect('/lesson?lesson=' + encodeURIComponent(currentLesson()));
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
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

const PORT = process.env.PORT || 3101;
// 开机自动入库：空库或缺题时自动 seed，不依赖人工执行
// （2026-09-29 C10 事故：安装漏了 seed，作答提交 no_item）
seedReport = require('./seed').autoSeed();
for (const r of seedReport) {
  if (r.error) console.error(`[seed] ${r.lesson_id} 自动入库失败：${r.error}`);
  else if (r.seeded) console.log(`[seed] ${r.lesson_id} 自动入库 ${r.seeded} 道题`);
}
if (require.main === module) {
  // 灾难恢复：如果数据库被清空（setup_done丢失），用环境变量ACCESS_CODE自动重建
  // 保证重部署后访问码永远可用，不卡死用户
  try {
    const db = require('./db.js').db;
    const row = db.prepare("SELECT value FROM app_state WHERE key='setup_done'").get();
    if (!row && process.env.ACCESS_CODE && process.env.ACCESS_CODE.length >= 6) {
      // 用 auth.js 的 setState/hashAccessCode，保证格式一致
      // 注意：auth.js 顶部会 require db.js，但 db.js 不依赖 auth.js，无循环引用
      const authMod = require('./auth.js');
      // 直接调内部函数：通过 trySetup 的逻辑太绕，这里手动做
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const h = crypto.scryptSync(String(process.env.ACCESS_CODE), salt, 32).toString('hex');
      const hashStr = `salt:${salt}:hash:${h}`;
      db.prepare("INSERT INTO app_state(key,value) VALUES('access_code_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hashStr);
      db.prepare("INSERT INTO app_state(key,value) VALUES('setup_done','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      console.log('[auth] 数据库被清空，已用环境变量自动重建访问码');
    }
  } catch (e) { console.log('[auth] 自动重建跳过:', e.message); }
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
