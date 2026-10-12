// 单元测验卷后端（2026-10-12）
// 解锁逻辑：完成该单元全部5节课 → 解锁测验卷
const fs = require('fs');
const path = require('path');

let db = null;
function setDb(d) { db = d; }

// 加载试卷JSON（去掉答案，供前端）
function getExam(id) {
  try {
    const p = path.join(__dirname, '..', 'content', 'exams', id + '.json');
    const exam = JSON.parse(fs.readFileSync(p, 'utf8'));
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

// 服务端判分（2026-10-12修）：前端只传原始答案，答案不出前端
// 返回 {score, total_objective, pending, detail}
// speak/writing 标 pending，不给假分
function gradeExam(exam_id, answers) {
  try {
    const p = path.join(__dirname, '..', 'content', 'exams', exam_id + '.json');
    const exam = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ansMap = answers || {};
    let score = 0, total_objective = 0;
    const detail = [], pending = [];
    exam.sections.forEach(sec => sec.parts.forEach(part => {
      part.questions.forEach((q, qi) => {
        const qid = sec.id + '-' + part.id + '-' + qi;
        const given = ansMap[qid];
        let got = 0, status = 'auto';
        if (q.type === 'choice') {
          total_objective += q.score;
          // 前端传的是选项索引（数字）或选项文本
          let g = given;
          if (typeof g === 'string' && q.options && q.options.includes(g)) g = q.options.indexOf(g);
          if (Number(g) === Number(q.answer)) got = q.score;
        } else if (q.type === 'fill') {
          total_objective += q.score;
          const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const accepts = Array.isArray(q.answer) ? q.answer : [q.answer];
          if (accepts.some(a => norm(given) === norm(a) && norm(given) !== '')) got = q.score;
        } else if (q.type === 'speak' || q.type === 'writing') {
          status = 'pending';
          pending.push({ qid, type: q.type, max: q.score, num: q.num });
        }
        score += got;
        detail.push({ qid, num: q.num, type: q.type, given: given ?? null, got, max: q.score, status });
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

module.exports = { setDb, getExam, getExamList, saveScore, initTable, isUnitDone, gradeExam };
