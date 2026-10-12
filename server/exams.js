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

// 检查单元是否完成（5节课都有作答记录）
function isUnitDone(unit) {
  try {
    const lessons = [];
    for (let r = 1; r <= 5; r++) lessons.push(`u${unit}r${r}`);
    const placeholders = lessons.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT lesson_id FROM attempts
      WHERE lesson_id IN (${placeholders})
    `).all(...lessons);
    const done = new Set(rows.map(r => r.lesson_id));
    return lessons.every(l => done.has(l));
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

// 保存成绩
function saveScore(exam_id, score, detail) {
  try {
    db.prepare(`
      INSERT INTO exam_scores (exam_id, score, detail_json, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(exam_id, score, JSON.stringify(detail || []));
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
  } catch (e) { console.error('[exams] initTable', e.message); }
}

module.exports = { setDb, getExam, getExamList, saveScore, initTable, isUnitDone };
