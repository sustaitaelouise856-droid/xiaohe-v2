// 单元测验卷后端（2026-10-12）
// 解锁逻辑：完成该单元全部5节课 → 解锁测验卷
const fs = require('fs');
const path = require('path');

let db = null;
function setDb(d) { db = d; }

function loadExamRaw(id) {
  const p = path.join(__dirname, '..', 'content', 'exams', id + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 加载试卷JSON（去掉答案，供前端）
function getExam(id) {
  try {
    const exam = loadExamRaw(id);
    // 深拷贝并去掉答案
    const pub = JSON.parse(JSON.stringify(exam));
    pub.sections.forEach(sec => sec.parts.forEach(part => {
      part.questions.forEach(q => { delete q.answer; });
    }));
    return { ok: true, exam: pub };
  } catch (e) {
    return { ok: false, error: 'not_found' };
  }
}

// 检查单元是否完成（2026-10-12修）：5节课的 p1_done+p2_done 都为1才算
// 之前只查"有无作答记录"，点开一节课就算完成，是错的
function isUnitDone(unit) {
  try {
    const lessons = [];
    for (let r = 1; r <= 5; r++) lessons.push(`u${unit}r${r}`);
    const placeholders = lessons.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT lesson_id, p1_done, p2_done FROM lesson_state
      WHERE lesson_id IN (${placeholders})
    `).all(...lessons);
    const doneMap = {};
    rows.forEach(r => { doneMap[r.lesson_id] = (r.p1_done === 1 && r.p2_done === 1); });
    return lessons.every(l => doneMap[l] === true);
  } catch { return false; }
}

// 获取所有测验卷的解锁状态
function getExamList() {
  const units = [2, 3, 4, 5, 6];
  const unitNames = { 2: '广播站', 3: 'Computers', 4: 'Inventions', 5: '教育交流', 6: '古代故事' };
  return units.map(u => {
    const id = `exam-u${u}`;
    const examPath = path.join(__dirname, '..', 'content', 'exams', id + '.json');
    const exists = fs.existsSync(examPath);
    const unlocked = exists && isUnitDone(u);
    // 取最高分
    let best = null;
    try {
      const r = db.prepare(`SELECT MAX(score) as m FROM exam_scores WHERE exam_id=?`).get(id);
      if (r && r.m != null) best = r.m;
    } catch {}
    return { id, unit: u, name: unitNames[u] || `Unit ${u}`, exists, unlocked, best_score: best };
  });
}

// ===== 单题判分核心（2026-10-22 抽出，整卷判分与课程式逐题判分共用同一逻辑，保证口径一致）=====
// 计分口径与 2026-10-12 原 gradeExam 逐字一致：
// - choice：选项索引（或选项文本）与 q.answer 比对
// - fill：normalize（去首尾空格/转小写/折叠空白）后与 q.answer 比对；
//   2026-10-22 起（Elouise 授权"发现问题直接解决"）：q.accept（等价答案列表）一并参与判分，
//   学生写出任一等价写法（如 Sat. / book sale / 2.5 hours）同样给分。此前 accept 根本不被判分认，
//   五卷共有数十条等价写法会被判错（统计见 exams-full-audit-report.md）。
// - speak/writing：不自动给分，标 pending（老师批改）
// 返回 { got, pending, objective }（objective=是否计入客观题总分，与原口径一致：仅 choice/fill）
function gradeQuestion(q, given) {
  let got = 0;
  if (q.type === 'choice') {
    let g = given;
    if (typeof g === 'string' && q.options && q.options.includes(g)) g = q.options.indexOf(g);
    if (Number(g) === Number(q.answer)) got = q.score;
    return { got, pending: false, objective: true };
  }
  if (q.type === 'fill') {
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const cands = [];
    (Array.isArray(q.answer) ? q.answer : [q.answer]).forEach(a => cands.push(a));
    if (Array.isArray(q.accept)) q.accept.forEach(a => cands.push(a));
    const g = norm(given);
    if (g !== '' && cands.some(a => g === norm(a))) got = q.score;
    return { got, pending: false, objective: true };
  }
  if (q.type === 'speak' || q.type === 'writing') {
    return { got: 0, pending: true, objective: false };
  }
  return { got: 0, pending: false, objective: false };
}

// 服务端判分（2026-10-12修）：前端只传原始答案，答案不出前端
// 返回 {score, total_objective, pending, detail}
// speak/writing 标 pending，不给假分
function gradeExam(exam_id, answers) {
  try {
    const exam = loadExamRaw(exam_id);
    const ansMap = answers || {};
    let score = 0, total_objective = 0;
    const detail = [], pending = [];
    exam.sections.forEach(sec => sec.parts.forEach(part => {
      part.questions.forEach((q, qi) => {
        const qid = sec.id + '-' + part.id + '-' + qi;
        const given = ansMap[qid];
        const r = gradeQuestion(q, given);
        let status = 'auto';
        if (r.pending) {
          status = 'pending';
          pending.push({ qid, type: q.type, max: q.score, num: q.num });
        } else if (r.objective) {
          total_objective += q.score;
        }
        score += r.got;
        detail.push({ qid, num: q.num, type: q.type, given: given ?? null, got: r.got, max: q.score, status });
      });
    }));
    return { ok: true, score, total_objective, pending, detail };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 保存成绩（含原始答案，供家长查阅写作/口语）
function saveScore(exam_id, score, detail, answers) {
  try {
    db.prepare(`
      INSERT INTO exam_scores (exam_id, score, detail_json, answers_json, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(exam_id, score, JSON.stringify(detail || []), JSON.stringify(answers || {}));
    return true;
  } catch (e) {
    console.error('[exams] saveScore', e.message);
    return false;
  }
}

function initTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS exam_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id TEXT NOT NULL,
        score REAL NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id);
    `);
    // 2026-10-12加：存原始答案
    try { db.exec(`ALTER TABLE exam_scores ADD COLUMN answers_json TEXT`); } catch {}
  } catch (e) { console.error('[exams] initTable', e.message); }
}

// ===== 课程式（一题一屏）支持（2026-10-22，Elouise 拍板：立即反馈，先只转 exam-u2 试水）=====
// 只有名单内的卷子启用逐题判分+进度续答；其他卷仍走一页式整卷提交，行为不变。
const COURSE_STYLE_EXAMS = new Set(['exam-u2']);
function isCourseStyle(exam_id) { return COURSE_STYLE_EXAMS.has(String(exam_id)); }

// 按 qid（secId-partId-题序，与整卷判分同一构造规则）定位题目
function findQuestion(exam, qid) {
  let found = null;
  exam.sections.forEach(sec => sec.parts.forEach(part => {
    part.questions.forEach((q, qi) => {
      if (sec.id + '-' + part.id + '-' + qi === qid) found = q;
    });
  }));
  return found;
}

// 正确答案的展示文本（只在该题已作答后才下发，不泄未答题答案）
function answerDisplay(q) {
  if (q.type === 'choice') {
    const i = Number(q.answer);
    return { letter: 'ABCD'[i] || '', text: (q.options && q.options[i]) || '' };
  }
  if (q.type === 'fill') {
    return { text: Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer) };
  }
  return null;
}

// 逐题判分（课程式立即反馈用）：与 gradeExam 共用 gradeQuestion，口径一致
// 返回 { ok, got, max, result: 'correct'|'wrong'|'pending', answer_display, material }
function gradeOne(exam_id, qid, given) {
  try {
    if (!isCourseStyle(exam_id)) return { ok: false, error: 'not_course_style' };
    const exam = loadExamRaw(exam_id);
    const q = findQuestion(exam, qid);
    if (!q) return { ok: false, error: 'unknown_qid' };
    const r = gradeQuestion(q, given);
    return {
      ok: true,
      got: r.got,
      max: q.score,
      result: r.pending ? 'pending' : (r.got === q.score ? 'correct' : 'wrong'),
      answer_display: answerDisplay(q),
      material: q.dialogue || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function initProgressTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS exam_progress (
        exam_id TEXT NOT NULL,
        qid TEXT NOT NULL,
        given_json TEXT,
        got REAL NOT NULL DEFAULT 0,
        result TEXT NOT NULL DEFAULT 'wrong',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (exam_id, qid)
      );
      CREATE TABLE IF NOT EXISTS exam_drafts (
        exam_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        elapsed_sec INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  } catch (e) { console.error('[exams] initProgressTable', e.message); }
}

// 保存一题答案（课程式逐题提交）：判分后落库，支撑中途退出再回来续答
function saveAnswer(exam_id, qid, given, elapsedSec) {
  const g = gradeOne(exam_id, qid, given);
  if (!g.ok) return g;
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`
      INSERT INTO exam_progress (exam_id, qid, given_json, got, result, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(exam_id, qid) DO UPDATE SET given_json=excluded.given_json, got=excluded.got, result=excluded.result, updated_at=excluded.updated_at
    `).run(exam_id, qid, JSON.stringify(given ?? null), g.got, g.result, now);
    const el = Math.max(0, Math.floor(Number(elapsedSec) || 0));
    db.prepare(`
      INSERT INTO exam_drafts (exam_id, started_at, elapsed_sec, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(exam_id) DO UPDATE SET elapsed_sec=MAX(exam_drafts.elapsed_sec, excluded.elapsed_sec), updated_at=excluded.updated_at
    `).run(exam_id, now, el, now);
    return g;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 读取进度（续答用）：只对已答题附带正确答案展示，未答题不下发任何答案信息
function getProgress(exam_id) {
  try {
    if (!isCourseStyle(exam_id)) return { ok: true, progress: null };
    const draft = db.prepare(`SELECT started_at, elapsed_sec FROM exam_drafts WHERE exam_id=?`).get(exam_id);
    if (!draft) return { ok: true, progress: null };
    const exam = loadExamRaw(exam_id);
    const rows = db.prepare(`SELECT qid, given_json, got, result FROM exam_progress WHERE exam_id=?`).all(exam_id);
    const answers = {};
    rows.forEach(r => {
      const q = findQuestion(exam, r.qid);
      let given = null;
      try { given = JSON.parse(r.given_json); } catch {}
      answers[r.qid] = {
        given, got: r.got, max: q ? q.score : 0, result: r.result,
        answer_display: q ? answerDisplay(q) : null,
        material: q ? (q.dialogue || null) : null,
      };
    });
    return { ok: true, progress: { started_at: draft.started_at, elapsed_sec: draft.elapsed_sec, answers } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 取进度里的原始答案（交卷时以服务端存档为准合并，防止前端状态丢失导致漏题）
function getProgressAnswers(exam_id) {
  try {
    const rows = db.prepare(`SELECT qid, given_json FROM exam_progress WHERE exam_id=?`).all(exam_id);
    const out = {};
    rows.forEach(r => { try { out[r.qid] = JSON.parse(r.given_json); } catch {} });
    return out;
  } catch { return {}; }
}

// 交卷成功后清进度（成绩已进 exam_scores，进度使命完成）
function clearProgress(exam_id) {
  try {
    db.prepare(`DELETE FROM exam_progress WHERE exam_id=?`).run(exam_id);
    db.prepare(`DELETE FROM exam_drafts WHERE exam_id=?`).run(exam_id);
    return true;
  } catch { return false; }
}

module.exports = { setDb, getExam, getExamList, saveScore, initTable, isUnitDone, gradeExam, isCourseStyle, gradeOne, initProgressTable, saveAnswer, getProgress, getProgressAnswers, clearProgress };
