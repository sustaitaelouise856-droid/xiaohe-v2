'use strict';
// 复测闭环（2026-10-03）：copied/看答案过 → 待复测 → 下次学习自动出同一知识点换材料复测题
// 零帮助独立答对才算解决。
// 每日闯关（2026-10-14）：每天开始前先做复测，画像驱动选题，通关记打卡
const db = require('./db.js');
const path = require('path');
const fs = require('fs');
const seed = require('./seed.js');

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

// 不规则变化题（2026-10-14补画像）：bad/good/heavy 等特殊变化，孩子高频错
// 用于 backfillWrongToRetest 的知识点分类和 attempts.js 的弱点打标
const IRREGULAR_ITEMS = new Set([
  'u3-consolidate-v1-s3',  // bad → the worst（4连错）
  'u3-consolidate-v1-s6',  // good → the best
  'u3r2-v1-s20',           // bad → the worst
  'u3r2-v1-s19',           // interesting → the most interesting
  'review3-v1-s5',         // bad → worse
  'review3-v1-s10',        // heavy → the heaviest
  'review3-v1-s1',         // 认出 the best
]);
// 比较级专项（2026-10-14补画像）
const COMPARATIVE_ITEMS = new Set([
  'u3r5-v1-s22',   // A is more expensive than C but...
  'u3r3-v1-s20',   // the faster
]);

function classifyKnowledgePoint(itemId) {
  if (IRREGULAR_ITEMS.has(itemId)) return 'irregular';
  if (COMPARATIVE_ITEMS.has(itemId)) return 'comparative';
  return 'general';
}

// 从多次答错回填复测队列（2026-10-14补画像）
// 之前只有 copied（看答案过）进队列，普通 wrong 漏掉了（如 u3-consolidate s3 连错4次）
// 规则：同一题累计 2+ 次 wrong/wrong_retry 且不在 pending 队列 → 入队
function backfillWrongToRetest() {
  try {
    const rows = db.prepare(`
      SELECT a.item_id, COUNT(*) AS c, MAX(a.session_id) AS sid
      FROM attempts a
      LEFT JOIN retest_queue q ON q.item_id = a.item_id
      WHERE a.verdict IN ('wrong', 'wrong_retry') AND q.id IS NULL
      AND a.item_id NOT LIKE 'yw-%' AND a.item_id NOT LIKE 'sx%'
      GROUP BY a.item_id
      HAVING c >= 2
    `).all();
    let n = 0;
    for (const r of rows) {
      const kp = classifyKnowledgePoint(r.item_id);
      db.prepare(`INSERT INTO retest_queue(item_id, knowledge_point, status, source_session)
        VALUES(?, ?, 'pending', ?)`)
        .run(r.item_id, kp, r.sid || '');
      n++;
    }
    return n;
  } catch { return 0; }
}

// 获取待复测列表（2026-10-20 Elouise 学科分离：只返回英语，语文 yw-/数学 sx 不混入）
function getPending() {
  try {
    return db.prepare(`
      SELECT id, item_id, knowledge_point, source_session, variant_item_id, created_at
      FROM retest_queue WHERE status = 'pending'
      AND item_id NOT LIKE 'yw-%' AND item_id NOT LIKE 'sx%'
      ORDER BY created_at
    `).all();
  } catch { return []; }
}

// 标记解决：复测题零帮助独立答对
function resolveRetest(itemId, knowledgePoint) {
  try {
    // 2026-10-16修：只按 item_id 匹配，不要求 knowledge_point 一致
    // （前端单题重做时只传 item_id，knowledge_point 对不上导致永远消不掉——Elouise 2026-10-16 报告阻塞性bug）
    const r = db.prepare(`
      UPDATE retest_queue SET status='resolved', resolved_at=datetime('now')
      WHERE item_id=? AND status='pending'
    `).run(itemId);
    if (r.changes > 0) return true;
    // 2026-10-16 21:35修：如果没有 pending 记录（比如只有1次wrong没进队列），直接插入一条 resolved
    // 否则错题本里永远消不掉——Elouise 21:32 报告"做了也不消失"
    // 2026-10-18修：先检查是否已有resolved，避免重复插入
    try {
      const existing = db.prepare(
        "SELECT id FROM retest_queue WHERE item_id=? AND status='resolved' LIMIT 1"
      ).get(itemId);
      if (!existing) {
        db.prepare(`
          INSERT INTO retest_queue(item_id, knowledge_point, status, resolved_at, source_session)
          VALUES(?, ?, 'resolved', datetime('now'), 'manual_resolve')
        `).run(itemId, knowledgePoint || 'general');
      }
      return true;
    } catch { return false; }
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

// 每日闯关选题（2026-10-14）：画像驱动，优先级：不规则变化 > 比较级 > 拼写 > 其他
// 返回 [{item_id, knowledge_point, priority, source}]
function selectDailyRetestItems(maxCount) {
  const max = Math.min(Math.max(Number(maxCount) || 8, 1), 12);
  try {
    // 候选1：retest_queue pending（已按知识点分类）
    // 2026-10-20 Elouise 学科分离：只选英语题，排除 yw-/sx
    const queued = db.prepare(`
      SELECT item_id, knowledge_point, created_at
      FROM retest_queue WHERE status = 'pending'
      AND item_id NOT LIKE 'yw-%' AND item_id NOT LIKE 'sx%'
    `).all();
    // 候选2：最近7天 weakness_events（去重，不在队列里的）
    const weak = db.prepare(`
      SELECT DISTINCT we.item_id, we.tag, MAX(we.created_at) AS last_at
      FROM weakness_events we
      LEFT JOIN retest_queue q ON q.item_id = we.item_id AND q.status = 'pending'
      WHERE we.created_at >= datetime('now', '-7 days') AND q.id IS NULL
      AND we.item_id NOT LIKE 'yw-%' AND we.item_id NOT LIKE 'sx%'
      GROUP BY we.item_id
    `).all();

    const seen = new Set();
    const cands = [];
    const prioOf = (kp, tag) => {
      if (kp === 'irregular' || tag === '不规则变化') return 0;
      if (kp === 'comparative' || tag === '比较级') return 1;
      if (tag === '拼写') return 2;
      return 3;
    };
    for (const q of queued) {
      if (seen.has(q.item_id)) continue;
      seen.add(q.item_id);
      cands.push({ item_id: q.item_id, knowledge_point: q.knowledge_point || 'general',
        priority: prioOf(q.knowledge_point, null), created_at: q.created_at || '' });
    }
    for (const w of weak) {
      if (seen.has(w.item_id)) continue;
      seen.add(w.item_id);
      const kp = classifyKnowledgePoint(w.item_id);
      cands.push({ item_id: w.item_id, knowledge_point: kp,
        priority: prioOf(kp, w.tag), created_at: w.last_at || '' });
    }
    // 排序：优先级 > 知识点内按时间（旧的先，避免堆积）
    cands.sort((a, b) => (a.priority - b.priority) || (a.created_at < b.created_at ? -1 : 1));
    // 2026-10-18修：同优先级内随机打乱，避免每天题目顺序完全一样
    const result = [];
    let i = 0;
    while (i < cands.length && result.length < max) {
      const prio = cands[i].priority;
      const group = [];
      while (i < cands.length && cands[i].priority === prio) {
        group.push(cands[i++]);
      }
      // Fisher-Yates shuffle with daily seed
      const seed = new Date().toISOString().slice(0, 10);
      let h = 0;
      for (let k = 0; k < seed.length; k++) h = (h * 31 + seed.charCodeAt(k)) >>> 0;
      for (let k = group.length - 1; k > 0; k--) {
        h = (h * 1103515245 + 12345) >>> 0;
        const j = h % (k + 1);
        [group[k], group[j]] = [group[j], group[k]];
      }
      result.push(...group);
    }
    return result.slice(0, max);
  } catch { return []; }
}

// 从 item_id 反查原始 step 定义（格式如 u3r5-v1-s28）
const _lessonCache = {};
function loadOriginalStep(itemId) {
  try {
    const m = /^([a-z0-9-]+)-v\d+-s(\d+)$/i.exec(String(itemId || ''));
    if (!m) return null;
    const lid = m[1], snum = Number(m[2]);
    if (!_lessonCache[lid]) {
      const fp = path.join(seed.contentDir(), `lesson-${lid}.json`);
      if (!fs.existsSync(fp)) return null;
      _lessonCache[lid] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
    const lesson = _lessonCache[lid];
    const step = (lesson.steps || []).find(s => s.step === snum && (s.kind === 'mcq' || s.kind === 'short'));
    if (!step) return null;
    return { lessonId: lid, version: lesson.version || 1, step };
  } catch { return null; }
}

// 生成每日闯关的步骤列表（供 /api/lesson?lesson=daily-retest）
function generateDailyRetest() {
  const items = selectDailyRetestItems(8);
  const steps = [];
  let n = 0;
  for (const it of items) {
    const orig = loadOriginalStep(it.item_id);
    if (!orig) continue;
    n++;
    // 复用原始 step，但标为复习题，step 序号重排为闯关序号
    const s = Object.assign({}, orig.step, {
      step: n,
      item_step: orig.step.step,  // 保留原始题号用于 item_id 生成
      review: true,
      daily_retest: true,
    });
    // 拼句转换（2026-10-14学句乐部）：句子级 short 题转成点词块拼句，治中式英语
    // 条件：答案是完整句子（4+词），不是单个词
    if (s.kind === 'short' && s.answer_text) {
      const words = String(s.answer_text).trim().split(/\s+/);
      if (words.length >= 4) {
        // 洗牌（固定种子保证同一天同一题顺序一致，避免孩子背位置）
        const shuffled = words.slice();
        const seedNum = n * 7919 + it.item_id.length;
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (seedNum * (i + 1) + i * 13) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        // 如果洗完和原序一样，强制换一下
        if (shuffled.join(' ') === words.join(' ') && shuffled.length > 1) {
          [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
        }
        s.kind = 'chunk';
        s.chunks = shuffled;
        s.task = '点词块拼出英文句子。';
      }
    }
    steps.push({ origLessonId: orig.lessonId, origVersion: orig.version, step: s,
      knowledge_point: it.knowledge_point });
  }
  return { steps, total: steps.length };
}

module.exports = { backfillFromHistory, backfillWrongToRetest, getPending, resolveRetest, isPendingRetest, IRREGULAR_ITEMS, COMPARATIVE_ITEMS, classifyKnowledgePoint, selectDailyRetestItems, generateDailyRetest, loadOriginalStep };
