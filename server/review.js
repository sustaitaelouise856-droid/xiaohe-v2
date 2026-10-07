'use strict';
// 第 2 课复盘逻辑（2026-09-29，Claude 二审通过版清单）：
// - 步骤 1 开场文案：按第 1 课第二部分（验证阶段）真实 attempts 动态生成
// - 步骤 3–5 复盘题：按错因自动挑 2–3 题；无数据时 3 题全上
const db = require('./db');

// 错因中文名（步骤 1 文案用）
const WEAK_CN = { old_info: '旧信息干扰', spelling: '拼写', omission: '漏项' };
// 错因短语（并列如实列举时用，2026-10-02）
const WEAK_PHRASE = { old_info: '被旧信息带偏', spelling: '栽在拼写上', omission: '漏了项' };
const WEAK_ORDER = ['old_info', 'spelling', 'omission'];
// 复盘题步骤 -> 错因
const REVIEW_STEP_WEAKNESS = { 3: 'old_info', 4: 'spelling', 5: 'omission' };

function parseDetail(row) {
  try { return JSON.parse(row.detail_json || '{}'); } catch { return {}; }
}

// 把一次作答归为错因：拼写 / 旧信息干扰 / 漏项 / other
// - typo 判分 -> 拼写
// - 简答 wrong 且明细里有 contradiction -> 旧信息干扰；有 missing -> 漏项
// - 第 1 课验证阶段的选择题均为新旧辨析，答错 -> 旧信息干扰
function classify(itemKind, row) {
  const v = row.verdict;
  if (v === 'typo') return 'spelling';
  if (v === 'chinese') return 'other'; // 中文答对已有独立弱点事件，不参与复盘选题
  // g 版：copied（看答案后抄写通过）按 wrong 同样归因，detail 里是 wrong 时的 items
  if (v !== 'wrong' && v !== 'copied') return 'other';
  if (itemKind === 'short') {
    const items = parseDetail(row).items || [];
    if (items.some(i => i.status === 'contradiction')) return 'old_info';
    if (items.some(i => i.status === 'missing')) return 'omission';
    return 'other';
  }
  if (itemKind === 'mcq') return 'old_info';
  return 'other';
}

// 第 1 课第二部分（验证阶段）的统计：取最近一个有验证作答的 session，
// 每题只看第一次作答（correct/wrong/typo/chinese）。
// 返回 null 表示暂无数据。
function u2r1ValidateStats() {
  let rows;
  try {
    rows = db.prepare(`
      SELECT a.session_id, a.item_id, a.verdict, a.detail_json,
             i.kind, i.step_no
      FROM attempts a JOIN items i ON i.item_id = a.item_id
      WHERE a.item_id LIKE 'u2r1-v%-s%' AND i.phase = 'validate' AND a.session_id <> ''
      ORDER BY a.id DESC
    `).all();
  } catch {
    return null; // 表结构异常时降级为无数据
  }
  if (!rows.length) return null;
  const sid = rows[0].session_id;
  const seen = new Set();
  const first = [];
  for (const r of [...rows].reverse()) { // 按时间正序，每题取第一次
    if (r.session_id !== sid || seen.has(r.item_id)) continue;
    seen.add(r.item_id);
    if (!['correct', 'wrong', 'typo', 'chinese', 'copied'].includes(r.verdict)) continue;
    first.push(r);
  }
  if (!first.length) return null;

  const total = first.length;
  const correct = first.filter(r => r.verdict === 'correct').length;
  const byWeak = { old_info: 0, spelling: 0, omission: 0 };
  const examples = {};
  for (const r of first) {
    if (r.verdict === 'correct') continue;
    const w = classify(r.kind, r);
    if (!(w in byWeak)) continue;
    byWeak[w]++;
    if (examples[w]) continue;
    if (w === 'spelling') {
      const it = (parseDetail(r).items || []).find(i => i.status === 'typo');
      examples[w] = { given: it && it.matched, want: it && it.want };
    } else if (w === 'omission') {
      const missing = (parseDetail(r).items || []).filter(i => i.status === 'missing').map(i => i.id);
      examples[w] = { stepNo: r.step_no, missing };
    } else {
      examples[w] = { stepNo: r.step_no };
    }
  }
  return { total, correct, byWeak, examples };
}

function topWeakness(stats) {
  let best = null;
  for (const w of WEAK_ORDER) {
    if (!best || stats.byWeak[w] > stats.byWeak[best]) best = w;
  }
  return stats.byWeak[best] > 0 ? best : null;
}

// 步骤 1 动态开场文案（5 种，方括号内容全部用真实数据填充）
function renderStep1(stats) {
  const fallback = '<p>新的一天，广播站开门。</p><p>今天先复盘三个小地方——上节课最容易错的类型，换新题考你；然后练个新的：通知连着改两次，怎么追踪。</p>';
  if (!stats) return fallback;
  const { total, correct, byWeak, examples } = stats;
  const errors = total - correct;
  if (errors <= 0) {
    return `<p>上次验证阶段共 ${total} 道题，你全对，一次过。旧通知作废、只认最新，你已经很熟了。</p><p>今天加难度：一天连改两次。</p>`;
  }
  const top = topWeakness(stats);
  if (!top) return fallback;
  if (correct / total >= 0.5) {
    // A2 大部分对：点出错因类型。只有一类错因时才说“主要是”；多类并列时如实列出（2026-10-02 改）
    const present = WEAK_ORDER.filter(w => byWeak[w] > 0);
    if (present.length === 1) {
      return `<p>上次验证阶段 ${total} 道里对了 ${correct} 道。错的几道主要是${WEAK_CN[present[0]]}，今天复盘先热身，再练连改两次。</p>`;
    }
    const list = present.map(w => `${byWeak[w]}道${WEAK_PHRASE[w]}`).join('，');
    return `<p>上次验证阶段 ${total} 道里对了 ${correct} 道。错的${errors}道：${list}。今天复盘先热身，再练连改两次。</p>`;
  }
  if (top === 'old_info') {
    return `<p>上次有 ${byWeak.old_info} 道题栽在旧信息上——旧通知作废了，还拿它当答案。今天先复盘热身，再练连改两次。</p>`;
  }
  if (top === 'spelling') {
    const ex = examples.spelling || {};
    const detail = ex.want ? `比如“${ex.want}”写成了“${ex.given}”` : '比如有单词拼错了';
    return `<p>上次内容都找对了，就是拼写丢了分——${detail}。今天复盘先把拼写补上。</p>`;
  }
  // omission
  const ex = examples.omission || {};
  const where = ex.stepNo ? `上次第 ${ex.stepNo} 题漏了项——` : '上次有题漏了项——';
  return `<p>${where}有信息没写全。今天练“找全”。</p>`;
}

// 复盘题自动选题：按错因错题数排序，取有错的错因对应的题（最多 3 题）；
// 无数据或全对时 3 题全上。返回要保留的步骤号数组。
function pickReviewSteps(stats) {
  // 保证 2-3 道：优先放真实错因对应的题，不足 2 道时用其他复盘题补足
  const ALL = [3, 4, 5];
  if (!stats) return ALL;
  const ranked = WEAK_ORDER
    .filter(w => stats.byWeak[w] > 0)
    .sort((a, b) => stats.byWeak[b] - stats.byWeak[a]);
  if (!ranked.length) return ALL;
  const keep = [];
  for (const [step, w] of Object.entries(REVIEW_STEP_WEAKNESS)) {
    if (ranked.includes(w)) keep.push(Number(step));
  }
  keep.sort((a, b) => a - b);
  for (const s of ALL) {
    if (keep.length >= 2) break;
    if (!keep.includes(s)) keep.push(s);
  }
  return keep.sort((a, b) => a - b).slice(0, 3);
}

// ---- 第二部分开场复习（2026-10-02 真人老师规范第 7 条；原“第二天开场复习”，
// 取消两天制后改为第二部分一开放就触发）----
// 第二部分开放时（第一部分学完即可），把按第一部分错因挑的复习题（复用步骤 3–5 池子，上限 2 道）
// 放在第二部分最前面、标为复习（不计验证）。实现要点：
// - 复习题是池题的"副本"：步号排在 practice_end 之后，item_step 指回原题，
//   提交仍走原 item_id（零新题、零改 JSON）；第二部分原有题步号顺延、item_step 锚定原步。
// - /api/attempt 对复习池题在第二部分的会话里放行一次重答（见 isReviewPoolItem），
//   不算"重做第一部分"。
// 第二部分现在是否开放（取消两天制后：第一部分完成即开放，不看日期）
function p2OpenNow(lessonId) {
  try {
    const st = db.prepare('SELECT p1_done FROM lesson_state WHERE lesson_id=?')
      .get(lessonId);
    return !!(st && st.p1_done === 1);
  } catch { return false; }
}

function isReviewPoolItem(lessonId, itemId) {
  if (lessonId !== 'u2r2') return false;
  const m = /-s(\d+)$/.exec(String(itemId || ''));
  return !!m && Object.prototype.hasOwnProperty.call(REVIEW_STEP_WEAKNESS, Number(m[1]));
}

// 第一部分（练习阶段）按"每题第一次作答"归因出的错因分布
function u2r2PracticeWeakness() {
  let rows;
  try {
    rows = db.prepare(`
      SELECT a.item_id, a.verdict, a.detail_json, i.kind
      FROM attempts a JOIN items i ON i.item_id = a.item_id
      WHERE i.lesson_id = 'u2r2' AND i.phase = 'practice'
      ORDER BY a.id ASC
    `).all();
  } catch { return null; }
  if (!rows.length) return null;
  const seen = new Set();
  const byWeak = { old_info: 0, spelling: 0, omission: 0 };
  for (const r of rows) {
    if (seen.has(r.item_id)) continue;
    seen.add(r.item_id);
    const w = classify(r.kind, r);
    if (w in byWeak) byWeak[w]++;
  }
  return { byWeak };
}

// 第二部分开场挑哪几道复习题：错因多的先练，上限 2 道；无错因时默认前 2 道热身
function pickPart2ReviewSteps(stats) {
  const ALL = [3, 4, 5];
  let ordered = ALL;
  if (stats && stats.byWeak) {
    const ranked = WEAK_ORDER
      .filter(w => stats.byWeak[w] > 0)
      .sort((a, b) => stats.byWeak[b] - stats.byWeak[a]);
    if (ranked.length) {
      ordered = ranked.map(w =>
        Number(Object.keys(REVIEW_STEP_WEAKNESS).find(k => REVIEW_STEP_WEAKNESS[k] === w)));
    }
  }
  return ordered.slice(0, 2);
}

// 给第二部分开头插入复习副本（原地返回新数组；p2 未开放或池子为空时原样返回）
function withPart2Review(lesson, steps) {
  if (!p2OpenNow('u2r2')) return steps;
  const pe = lesson.practice_end || 22;
  const pool = new Map(lesson.steps.filter(s => s.review_weakness).map(s => [s.step, s]));
  const picks = pickPart2ReviewSteps(u2r2PracticeWeakness()).filter(sn => pool.has(sn));
  if (!picks.length) return steps;
  const copies = picks.map((sn, i) => ({
    ...pool.get(sn),
    step: pe + 1 + i,
    item_step: sn,
    review: true,
    phase: 'practice',
    // 第一道复习题带一句引入（孩子可见）：先复习一下第一部分学的
    ...(i === 0
      ? { scene: ['先复习一下第一部分学的。', pool.get(sn).scene].filter(Boolean).join(' ') }
      : {}),
  }));
  const head = steps.filter(s => s.step <= pe);
  const tail = steps.filter(s => s.step > pe)
    .map(s => ({ ...s, step: s.step + copies.length, item_step: s.step }));
  return [...head, ...copies, ...tail];
}

// 下发第 2 课步骤：复盘题过滤 + 步骤 1 动态文案 + 第二部分开场复习
function serveU2r2(lesson) {
  const stats = u2r1ValidateStats();
  const keep = pickReviewSteps(stats);
  const opening = renderStep1(stats);
  const steps = lesson.steps
    .filter(s => (s.review_weakness ? keep.includes(s.step) : true))
    .map(s => (s.step === 1 && s.dynamic_opening ? { ...s, teach_html: opening } : s));
  return withPart2Review(lesson, steps);
}

module.exports = {
  WEAK_CN, REVIEW_STEP_WEAKNESS,
  classify, u2r1ValidateStats, topWeakness, renderStep1, pickReviewSteps, serveU2r2,
  p2OpenNow, isReviewPoolItem, u2r2PracticeWeakness, pickPart2ReviewSteps, withPart2Review,
};
