'use strict';
// 作答提交与判分规则（Elouise 2026-09-29 确认，2026-09-29 晚补充，2026-10-14 重构）：
// - 练习阶段：反馈可以讲清楚；但点了"老师教我"（help_events 有记录）后答对 -> helped=1（有帮助完成），independent=0
// - 验证阶段：只以第一次作答判定；重答 -> verdict 为 correct_retry/wrong_retry，不计独立完成
// - 2026-10-14重构：不再信任客户端 saw_feedback（多个 bug 污染），helped 只认服务端 help_events 表
//   答错后"再想一想"不算帮助；只有点了"老师教我"才算
// - 中文作答（verdict=chinese）：内容理解记 independent=1（独立完成），英文书写记 helped=1
//   （有帮助完成），并记一条弱点事件 tag='英文书写'，供下节课复习
// - 每次作答记录 elapsed_ms（客户端上报：题目出现到提交的毫秒数），供后台判断是否猜题
const db = require('./db');
const grade = require('./grade');
const retest = require('./retest');

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

function submitAttempt({ item_id, answer, session_id, saw_feedback, elapsed_ms, copied, predicted, pasted }) {
  const item = db.prepare('SELECT * FROM items WHERE item_id=?').get(String(item_id || ''));
  if (!item) return { error: 'no_item' };
  const sid = String(session_id || '');
  const phase = item.phase || 'practice';

  // 2026-10-14彻底重构（Elouise要求）：helped 只认服务端记录，不再信任客户端 saw_feedback
  // 原因：saw_feedback 是前端上报的布尔值，被多个 bug 污染（答错反馈误置、session_id 复用等），不可靠
  // 新规则：
  // 1. help_events 表有记录（点了"老师教我"）→ helped=1
  // 2. verdict='copied'（看了答案照抄）→ helped=1（在下面的 copied 分支已处理）
  // 3. verdict='chinese'（中文作答）→ helped=1（在下面的 chinese 分支已处理）
  // 4. 其他情况 → helped=0（答错后"再想一想"不算帮助）
  let helpEventCutoff = '2000-01-01';
  try {
    if (item.item_id && item.item_id.startsWith('u3-consolidate')) {
      const sr = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
      if (sr && sr.value) helpEventCutoff = sr.value;
    }
  } catch {}
  const helped = (
    db.prepare('SELECT COUNT(*) AS c FROM help_events WHERE item_id=? AND session_id=? AND created_at >= ?')
      .get(item.item_id, sid, helpEventCutoff).c > 0
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
  // 不规则变化/比较级答错：记专项弱点标签（2026-10-14补画像，供每日闯关优先抽题）
  if (r.verdict === 'wrong' || r.verdict === 'wrong_retry') {
    try {
      let tag = null;
      if (retest.IRREGULAR_ITEMS.has(item.item_id)) tag = '不规则变化';
      else if (retest.COMPARATIVE_ITEMS.has(item.item_id)) tag = '比较级';
      if (tag) {
        db.prepare('INSERT INTO weakness_events(item_id, session_id, tag) VALUES(?,?,?)')
          .run(item.item_id, sid, tag);
      }
    } catch {}
  }

  let verdict = r.verdict;
  let independent = 0;
  let finalHelped = helped;
  if (copied) {
    // 抄写（g 版保底）：看过答案后照着写——直接放行，不卡孩子（2026-10-12修：之前要求完全一致，标点差一个都卡死）
    // 记有帮助完成，不计独立完成，记"看答案过"弱点；
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
    // 2026-10-12：粘贴作答不算独立完成
    independent = (contentOk && !helped && !pasted) ? 1 : 0;
  }
  // 预判错法记入明细（只在判 wrong 时，供反馈首句与复盘归因）
  if (predicted && r.detail && typeof r.detail === 'object'
      && (verdict === 'wrong' || verdict === 'wrong_retry')) {
    r.detail.predicted = predicted;
  }

  const ms = Number(elapsed_ms);
  const pastedFlag = pasted ? 1 : 0;
  db.prepare(
    'INSERT INTO attempts(item_id, session_id, helped, correct, independent, answer_given, verdict, detail_json, elapsed_ms, pasted) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(item.item_id, sid, finalHelped, contentOk, independent, String(answer ?? ''), verdict, JSON.stringify(r.detail),
    Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null, pastedFlag);

  // 复测闭环（2026-10-03）：零帮助独立答对 → 解决待复测
  // verdict=correct/correct_retry 且 independent=1（无帮助）时，清除该题所有 pending 复测
  // 2026-10-16修：加 correct_retry——重做时答对 verdict 是 correct_retry，不是 correct（Elouise报告阻塞性bug）
  if ((verdict === 'correct' || verdict === 'correct_retry') && independent === 1) {
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
