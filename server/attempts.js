'use strict';
// 作答提交与判分规则（Elouise 2026-09-29 确认，2026-09-29 晚补充）：
// - 练习阶段：反馈可以讲清楚；但看过反馈/帮助后答对 -> helped=1（有帮助完成），independent=0
// - 验证阶段：只以第一次作答判定；重答 -> verdict 为 correct_retry/wrong_retry，不计独立完成
// - "看过反馈后重答"靠客户端上报 saw_feedback=1；同一 session 内按 (session_id, item_id) 判定重答
// - 中文作答（verdict=chinese）：内容理解记 independent=1（独立完成），英文书写记 helped=1
//   （有帮助完成），并记一条弱点事件 tag='英文书写'，供下节课复习
// - 每次作答记录 elapsed_ms（客户端上报：题目出现到提交的毫秒数），供后台判断是否猜题
const db = require('./db');
const grade = require('./grade');

function contentVerdict(item, answer) {
  if (item.kind === 'mcq') {
    const ok = String(answer || '').trim().toUpperCase() === item.answer;
    return { verdict: ok ? 'correct' : 'wrong', detail: { given: String(answer || '') } };
  }
  if (item.kind === 'short') {
    let spec = {};
    try { spec = JSON.parse(item.grading_json || '{}'); } catch { spec = {}; }
    const g = grade.gradeShort(answer, spec);
    return { verdict: g.verdict, detail: g };
  }
  return null;
}

function submitAttempt({ item_id, answer, session_id, saw_feedback, elapsed_ms, copied, predicted }) {
  const item = db.prepare('SELECT * FROM items WHERE item_id=?').get(String(item_id || ''));
  if (!item) return { error: 'no_item' };
  const sid = String(session_id || '');
  const phase = item.phase || 'practice';

  const helped = (
    db.prepare('SELECT COUNT(*) AS c FROM help_events WHERE item_id=? AND session_id=?')
      .get(item.item_id, sid).c > 0 || saw_feedback
  ) ? 1 : 0;
  const prior = db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE item_id=? AND session_id=?')
    .get(item.item_id, sid).c;

  const r = contentVerdict(item, answer);
  if (!r) return { error: 'bad_kind' };
  const contentOk = (r.verdict === 'correct' || r.verdict === 'typo' || r.verdict === 'chinese') ? 1 : 0;
  // 拼写小错：内容算对，同时记一条"拼写"弱点供复盘与家长报告（2026-10-02 判分宽容）
  if (r.verdict === 'typo') {
    db.prepare('INSERT INTO weakness_events(item_id, session_id, tag) VALUES(?,?,?)')
      .run(item.item_id, sid, '拼写');
  }

  let verdict = r.verdict;
  let independent = 0;
  let finalHelped = helped;
  if (copied && contentOk) {
    // 抄写（g 版保底）：看过答案后照着写对——记有帮助完成，不计独立完成，记"看答案过"弱点；
    // detail 用最近一次 wrong 的明细（items 原样带上，供复盘归因）再加 copied:true
    let d = null;
    try {
      const lw = db.prepare(`SELECT detail_json FROM attempts
        WHERE item_id=? AND session_id=? AND verdict IN ('wrong','wrong_retry')
        ORDER BY rowid DESC LIMIT 1`).get(item.item_id, sid);
      if (lw && lw.detail_json) d = JSON.parse(lw.detail_json);
    } catch {}
    d = (d && typeof d === 'object') ? d : r.detail;
    d.copied = true;
    if (predicted) d.predicted = predicted;
    r.detail = d;
    verdict = 'copied';
    finalHelped = 1;
    db.prepare('INSERT INTO weakness_events(item_id, session_id, tag) VALUES(?,?,?)')
      .run(item.item_id, sid, '看答案过');
    // 复测闭环（2026-10-03）：copied 入复测队列，按失败维度记录知识点
    try {
      const dims = [];
      if (d && Array.isArray(d.items)) {
        for (const it of d.items) {
          if (it.status === 'contradiction' || it.status === 'missing') {
            dims.push(String(it.id || 'general'));
          }
        }
      }
      const kps = dims.length ? dims : ['general'];
      for (const kp of kps) {
        // 去重：同一题同一知识点 pending 只留一条
        const ex = db.prepare(
          "SELECT id FROM retest_queue WHERE item_id=? AND knowledge_point=? AND status='pending'"
        ).get(item.item_id, kp);
        if (!ex) {
          db.prepare(`INSERT INTO retest_queue(item_id, knowledge_point, status, source_session)
            VALUES(?,?, 'pending', ?)`)
            .run(item.item_id, kp, sid);
        }
      }
    } catch {}
  } else if (r.verdict === 'chinese') {
    // 中文答对：内容理解独立完成，英文书写记有帮助完成，并记弱点
    independent = 1;
    finalHelped = 1;
    db.prepare('INSERT INTO weakness_events(item_id, session_id, tag) VALUES(?,?,?)')
      .run(item.item_id, sid, '英文书写');
  } else if (phase === 'validate' && prior > 0) {
    // 验证阶段重答：内容对错照记，但不计独立完成
    verdict = contentOk ? 'correct_retry' : 'wrong_retry';
    independent = 0;
  } else {
    // 练习阶段：看过反馈/帮助后答对 = 有帮助完成；验证阶段首次答对 = 独立完成
    independent = (contentOk && !helped) ? 1 : 0;
  }
  // 预判错法记入明细（只在判 wrong 时，供反馈首句与复盘归因）
  if (predicted && r.detail && typeof r.detail === 'object'
      && (verdict === 'wrong' || verdict === 'wrong_retry')) {
    r.detail.predicted = predicted;
  }

  const ms = Number(elapsed_ms);
  db.prepare(
    'INSERT INTO attempts(item_id, session_id, helped, correct, independent, answer_given, verdict, detail_json, elapsed_ms) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(item.item_id, sid, finalHelped, contentOk, independent, String(answer ?? ''), verdict, JSON.stringify(r.detail),
    Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null);

  // 复测闭环（2026-10-03）：零帮助独立答对 → 解决待复测
  // verdict=correct 且 independent=1（无帮助）时，清除该题所有 pending 复测
  if (verdict === 'correct' && independent === 1) {
    try {
      db.prepare(`
        UPDATE retest_queue SET status='resolved', resolved_at=datetime('now')
        WHERE item_id=? AND status='pending'
      `).run(item.item_id);
    } catch {}
  }

  return { ok: true, verdict, correct: contentOk, helped: finalHelped, independent,
    detail: r.detail, first_try: prior === 0 };
}

module.exports = { submitAttempt };
