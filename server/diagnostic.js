'use strict';
// 摸底诊断 API（2026-10-03 P2）：广播站"新人能力检测"
// 规则：不显示对错（只回"收到"）、自适应（连错3停该维度）、"这个我不会"跳过、
//       3段可分开做、两套平行卷A/B、讯飞朗读仅参考不卡关
const fs = require('fs');
const path = require('path');
const { gradeShort } = require('./grade');

const DIAG_CACHE = {};
function loadDiagnostic(form, section) {
  const key = `${form}${section}`;
  if (!DIAG_CACHE[key]) {
    const p = path.join(__dirname, '..', 'content', `diagnostic-${form.toLowerCase()}${section}.json`);
    DIAG_CACHE[key] = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return DIAG_CACHE[key];
}

// 孩子可见的步骤：去掉 answer（不能让孩子看到答案）
function publicDiagStep(s) {
  const o = { ...s };
  delete o.answer;
  return o;
}

// 记录一次作答，返回是否应该停止该维度（连错3次）
function recordAnswer(db, sessionId, step, verdict) {
  const kp = step.knowledge_point;
  if (!kp) return false;
  // 取该知识点的历史
  const rows = db.prepare(
    'SELECT verdict FROM diagnostic_answers WHERE session_id=? AND knowledge_point=? ORDER BY id'
  ).all(sessionId, kp);
  // 计算当前连错数（含本次）
  let streak = verdict === 'correct' ? 0 : 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].verdict === 'correct') break;
    streak++;
  }
  return streak >= 3;
}

function getSession(db, form, section) {
  let s = db.prepare(
    "SELECT * FROM diagnostic_sessions WHERE form=? AND section=? AND status='active' ORDER BY id DESC LIMIT 1"
  ).get(form, section);
  if (!s) {
    const r = db.prepare(
      'INSERT INTO diagnostic_sessions(form, section) VALUES(?,?)'
    ).run(form, section);
    s = db.prepare('SELECT * FROM diagnostic_sessions WHERE id=?').get(r.lastInsertRowid);
  }
  return s;
}

// 计算知识点状态：会了/不稳/不会/没测到
function calcStatus(db, sessionId) {
  const answers = db.prepare(
    'SELECT knowledge_point, category, verdict FROM diagnostic_answers WHERE session_id=? ORDER BY id'
  ).all(sessionId);
  const byKp = {};
  for (const a of answers) {
    if (!byKp[a.knowledge_point]) byKp[a.knowledge_point] = { category: a.category, correct: 0, total: 0, gaveUp: false };
    const k = byKp[a.knowledge_point];
    k.total++;
    if (a.verdict === 'correct') k.correct++;
    if (a.verdict === 'gave_up') k.gaveUp = true;
  }
  const result = [];
  for (const [kp, k] of Object.entries(byKp)) {
    let status;
    if (k.gaveUp || k.correct === 0) status = '不会';
    else if (k.correct >= 3) status = '会了';
    else status = '不稳';
    // not_tested 的单独处理：如果全是 not_tested，标"没测到"
    const allNotTested = answers.filter(a => a.knowledge_point === kp).every(a => a.verdict === 'not_tested');
    if (allNotTested) status = '没测到';
    result.push({ knowledge_point: kp, category: k.category, status, correct: k.correct, total: k.total });
  }
  return result;
}

module.exports = { loadDiagnostic, publicDiagStep, recordAnswer, getSession, calcStatus };
