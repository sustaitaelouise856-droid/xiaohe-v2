'use strict';
// 复测闭环（2026-10-03）：copied/看答案过 → 待复测 → 下次学习自动出同一知识点换材料复测题
// 零帮助独立答对才算解决。
const db = require('./db.js');

// 从历史 weakness_events（tag='看答案过'）回填复测队列
// h 上线前已存的记录也要能被读取
function backfillFromHistory() {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT we.item_id, we.session_id
      FROM weakness_events we
      LEFT JOIN retest_queue rq ON rq.item_id = we.item_id AND rq.status = 'pending'
      WHERE we.tag = '看答案过' AND rq.id IS NULL
    `).all();
    let n = 0;
    for (const r of rows) {
      // 历史记录没有维度明细，用通用知识点标记
      db.prepare(`INSERT INTO retest_queue(item_id, knowledge_point, status, source_session)
        VALUES(?, 'general', 'pending', ?)`)
        .run(r.item_id, r.session_id || '');
      n++;
    }
    return n;
  } catch { return 0; }
}

// 获取待复测列表
function getPending() {
  try {
    return db.prepare(`
      SELECT id, item_id, knowledge_point, source_session, variant_item_id, created_at
      FROM retest_queue WHERE status = 'pending' ORDER BY created_at
    `).all();
  } catch { return []; }
}

// 标记解决：复测题零帮助独立答对
function resolveRetest(itemId, knowledgePoint) {
  try {
    const r = db.prepare(`
      UPDATE retest_queue SET status='resolved', resolved_at=datetime('now')
      WHERE item_id=? AND knowledge_point=? AND status='pending'
    `).run(itemId, knowledgePoint);
    return r.changes > 0;
  } catch { return false; }
}

// 检查某题是否在待复测队列中（用于前端显示"复测题"标记）
function isPendingRetest(itemId) {
  try {
    const r = db.prepare(
      "SELECT id FROM retest_queue WHERE item_id=? AND status='pending' LIMIT 1"
    ).get(itemId);
    return !!r;
  } catch { return false; }
}

module.exports = { backfillFromHistory, getPending, resolveRetest, isPendingRetest };
