// 课末弱点小结（2026-11-09，Idea：每节课末说清哪一点没学会）
// 只用当节课自己的答错和求助记录；不改课程内容、判分与解锁规则。
// 口径：某题"没学会" = 本课记录里有答错/看答案/中文作答/求助，且从未独立答对过
// （independent=1 且 verdict 为 correct/correct_retry/typo；中文作答 verdict=chinese 不算干净答对）。
// 知识点按答案与题干的模式归类；生词按词聚成一组显示，但跨课记忆按词记（memberKey）。
// 跨课记忆在 weak_point_notes：同一知识点在后一课再出现标"还没学会"，独立答对后消退。
// 链接只给真实存在的对应练习：本课巩固练（整课通用）或写句专项（仅现在完成时/since-for）；
// 没有对应练习的点只说清弱点，不硬凑链接。
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CLEAN_VERDICTS = new Set(['correct', 'correct_retry', 'typo']);
const STRUGGLE_VERDICTS = new Set(['wrong', 'wrong_retry', 'copied', 'chinese']);
const ENGLISH_LESSON = /^(u[2-8]r\d+(-consolidate)?|u3-consolidate)$/;
const IRREGULAR_PP = new Set(('taught bought sold broken grown written taken given seen done made read cut put brought caught thought found left felt kept spent sent built chosen driven eaten fallen forgotten hidden spoken stolen woken worn begun drunk rung sung swum been gone known shown flown drawn slept paid meant met won lost heard held kept sold told understood').split(' '));

function logicalItemId(itemId) {
  return String(itemId || '').replace(/-v\d+(?=-s\d+$)/i, '');
}
function lessonOf(itemId) {
  const m = /^(.+)-v\d+-s\d+$/i.exec(String(itemId || ''));
  return m ? m[1] : null;
}
function isEnglishLesson(lid) { return ENGLISH_LESSON.test(String(lid || '')); }
function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hasParticiple(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z']+/).filter(Boolean);
  return words.some(w => w.endsWith('ed') || w.endsWith('en') || IRREGULAR_PP.has(w));
}

// ---- 知识点归类：输入 { kind, stem, answerText, logicalId } ----
// 返回 { key（展示分组）, memberKey（跨课记忆键）, label, word?, stemQuote? }。
// label 为 null 时用题干原文作兜底显示（不编造知识点名）。
function classifyPoint(inp) {
  const kind = inp.kind || '';
  const stem = stripTags(inp.stem || '');
  const ans = String(inp.answerText || '').trim();
  const ansLow = ans.toLowerCase();
  const stemLow = stem.toLowerCase();
  const fallback = { key: 'item:' + (inp.logicalId || ''), memberKey: 'item:' + (inp.logicalId || ''), label: null, stemQuote: stem.slice(0, 28) };
  // 1. unless
  if (/\bunless\b/.test(ansLow) || /\bunless\b/.test(stemLow)) {
    return { key: 'unless', memberKey: 'unless', label: 'unless 的用法（= if…not，否定句里不能再加 not）' };
  }
  // 2. do/does 否定
  if (/\b(do|does) not\b/.test(ansLow) || /\b(don't|doesn't)\b/.test(ansLow)) {
    return { key: 'do-does-neg', memberKey: 'do-does-neg', label: 'do/does 否定句（he/she/it 用 does not，I/you/they 用 do not）' };
  }
  // 3. 现在完成时 have/has + 过去分词
  if (/\b(has|have)\b/.test(ansLow) && hasParticiple(ansLow)) {
    return { key: 'present-perfect', memberKey: 'present-perfect', label: '现在完成时（have/has + 过去分词）' };
  }
  // 4. since / for（答案本身就是 since/for）
  if (/^(since|for)$/.test(ansLow)) {
    return { key: 'since-for', memberKey: 'since-for', label: 'since 和 for 的用法' };
  }
  // 5. 被动语态 be + 过去分词（不含 have/has 的；含 have/has 的已在 3 里处理）
  if (/\b(is|are|was|were|been|be)\b/.test(ansLow) && hasParticiple(ansLow)) {
    return { key: 'passive', memberKey: 'passive', label: '被动语态（be + 过去分词）' };
  }
  // 6. 比较级/最高级：题干有 than，或答案是 more/most 开头
  if (/\bthan\b/.test(stemLow) || /^(more|most)\b/.test(ansLow)) {
    return { key: 'comparative', memberKey: 'comparative', label: '比较级和最高级' };
  }
  // 7. 第三人称单数 / be 动词：题干括号里给了动词原形，答案是加 s/es 的形式
  const parenGroups = [...stem.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
  const hints = parenGroups.flatMap(g => g.split(/[\s\/,]+/).filter(Boolean)).map(w => w.toLowerCase());
  const ansWords = ansLow.split(/[^a-z']+/).filter(Boolean);
  if (hints.length && ansWords.length) {
    if (hints.includes('be') && ansWords.every(w => w === 'is' || w === 'am' || w === 'are')) {
      return { key: 'be-verb', memberKey: 'be-verb', label: 'be 动词（am/is/are）' };
    }
    if (ansWords.every(w => hints.some(h => w === h + 's' || w === h + 'es' || (h === 'have' && w === 'has')))) {
      return { key: 'third-person-s', memberKey: 'third-person-s', label: '第三人称单数动词加 s' };
    }
  }
  // 8. 固定搭配与短语
  if (/but not least/i.test(stem)) {
    return { key: 'phrase:last-but-not-least', memberKey: 'phrase:last-but-not-least', label: '固定搭配“last but not least”' };
  }
  if (ansWords.length >= 2 && hints.length) {
    return { key: 'phrase:' + ansLow, memberKey: 'phrase:' + ansLow, label: '短语“' + ans + '”' };
  }
  // 9. 生词：题干问词义/中文，或答案是单个英文词且无语法模式（展示时聚成一组，记忆时按词记）
  const quoted = stem.match(/["“]([A-Za-z][A-Za-z'’\- ]*?)["”]/);
  const writeZh = stem.match(/写出\s*([A-Za-z][A-Za-z\- ]*?)\s*的中文/);
  if (/的意思|的中文|means|中文意思/.test(stem)) {
    const w = (writeZh && writeZh[1].trim()) || (quoted && quoted[1].trim()) || ans;
    if (w) return { key: 'vocab', memberKey: 'vocab:' + String(w).toLowerCase(), label: null, word: w };
  }
  if (/^[A-Za-z][A-Za-z\-']*$/.test(ans)) {
    return { key: 'vocab', memberKey: 'vocab:' + ansLow, label: null, word: ans };
  }
  // 10. 兜底：引用题干，不编造知识点名
  return fallback;
}

function classifyFromStep(step, lid) {
  let answerText = '';
  if (step.kind === 'mcq') {
    const idx = 'ABCD'.indexOf(String(step.answer || ''));
    if (idx >= 0 && Array.isArray(step.options) && step.options[idx] != null) answerText = String(step.options[idx]);
  } else {
    answerText = step.answer_text || '';
  }
  return classifyPoint({
    kind: step.kind, stem: step.stem || step.task || '', answerText,
    logicalId: lid + '-s' + step.step,
  });
}

function classifyFromItemRow(row) {
  let answerText = row.answer || '';
  if (row.kind === 'mcq' && row.options_json) {
    try {
      const opts = JSON.parse(row.options_json);
      const idx = (row.answer_pos == null ? -1 : row.answer_pos);
      if (idx >= 0 && opts[idx] != null) answerText = String(opts[idx]);
    } catch {}
  }
  return classifyPoint({
    kind: row.kind, stem: row.prompt || '', answerText,
    logicalId: logicalItemId(row.item_id),
  });
}

function lessonTitleOf(loadLesson, lid) {
  try {
    const OL = loadLesson(lid);
    return (OL && OL.lesson && OL.lesson.title) || lid;
  } catch { return lid; }
}

// ---- 当节课的弱点汇总（只用本课自己的记录；u3-consolidate 只统计当前轮次） ----
function computeLessonWeakness(opts) {
  const lid = String(opts.lid || '');
  const loadLesson = opts.loadLesson;
  const contentDir = opts.contentDir || '';
  if (!isEnglishLesson(lid) || typeof loadLesson !== 'function') {
    return { lesson: lid, title: lid, points: [], total_weak_items: 0 };
  }
  const L = loadLesson(lid);
  if (!L || !L.lesson) return { lesson: lid, title: lid, points: [], total_weak_items: 0 };
  const title = L.lesson.title || lid;
  const ver = L.lesson.version;
  const curRows = db.prepare(
    'SELECT item_id, step_no FROM items WHERE lesson_id=? AND version=?'
  ).all(lid, ver);
  const curLogical = new Set(curRows.map(r => logicalItemId(r.item_id)));
  const stepByLogical = new Map();
  for (const s of (L.lesson.steps || [])) {
    if (s.kind === 'mcq' || s.kind === 'short' || s.kind === 'chunk') {
      stepByLogical.set(lid + '-s' + s.step, s);
    }
  }
  let sessFilter = '';
  let sessArgs = [];
  if (lid === 'u3-consolidate') {
    const sess = db.prepare("SELECT value FROM app_state WHERE key='u3_consolidation_session'").get();
    if (sess && sess.value) { sessFilter = ' AND created_at >= ?'; sessArgs = [sess.value]; }
  }
  const attRows = db.prepare(
    `SELECT item_id, verdict, independent FROM attempts WHERE item_id LIKE ?${sessFilter}`
  ).all(lid + '-%', ...sessArgs);
  const helpRows = db.prepare(
    `SELECT item_id, COUNT(*) c, MAX(level) lv FROM help_events WHERE item_id LIKE ?${sessFilter} GROUP BY item_id`
  ).all(lid + '-%', ...sessArgs);
  const perItem = new Map();
  for (const r of attRows) {
    const key = logicalItemId(r.item_id);
    if (!curLogical.has(key)) continue;
    const g = perItem.get(key) || { struggle: false, clean: false, wrong: 0 };
    if (STRUGGLE_VERDICTS.has(r.verdict)) g.struggle = true;
    if (r.verdict === 'wrong' || r.verdict === 'wrong_retry') g.wrong++;
    if (r.independent === 1 && CLEAN_VERDICTS.has(r.verdict)) g.clean = true;
    perItem.set(key, g);
  }
  const helpByItem = new Map();
  for (const r of helpRows) {
    const key = logicalItemId(r.item_id);
    if (!curLogical.has(key)) continue;
    helpByItem.set(key, { count: r.c, level: r.lv });
  }
  const weakItems = [];
  for (const [key, g] of perItem.entries()) {
    const h = helpByItem.get(key);
    if ((g.struggle || (h && h.count > 0)) && !g.clean) {
      weakItems.push({ logicalId: key, wrong: g.wrong, help: h ? h.count : 0 });
    }
  }
  // 只求助、从未作答过的题：help_events 里有、attempts 里没有，也算弱点
  for (const [key, h] of helpByItem.entries()) {
    if (!perItem.has(key)) weakItems.push({ logicalId: key, wrong: 0, help: h.count });
  }
  const groups = new Map();
  for (const w of weakItems) {
    const step = stepByLogical.get(w.logicalId);
    if (!step) continue;
    const cls = classifyFromStep(step, lid);
    const g = groups.get(cls.key) || {
      key: cls.key, label: cls.label, stemQuote: cls.stemQuote || null,
      words: [], memberKeys: new Set(), items: [], count: 0, minStep: step.step,
    };
    if (cls.word && !g.words.includes(cls.word)) g.words.push(cls.word);
    g.memberKeys.add(cls.memberKey);
    g.items.push({
      step: step.step,
      stem: stripTags(step.stem || step.task || '').slice(0, 40),
      answer: stripTags(step.kind === 'mcq'
        ? (Array.isArray(step.options) && 'ABCD'.indexOf(String(step.answer || '')) >= 0 ? step.options['ABCD'.indexOf(String(step.answer || ''))] : '')
        : (step.answer_text || '')).slice(0, 40),
      wrong: w.wrong, help: w.help,
    });
    g.count++;
    if (step.step < g.minStep) g.minStep = step.step;
    if (!g.stemQuote && cls.stemQuote) g.stemQuote = cls.stemQuote;
    groups.set(cls.key, g);
  }
  const hasCons = !/-consolidate$/.test(lid) && contentDir
    && fs.existsSync(path.join(contentDir, 'lesson-' + lid + '-consolidate.json'));
  const all = [...groups.values()];
  for (const p of all) {
    if (p.key === 'vocab') {
      const shown = p.words.slice(0, 4);
      p.label = '生词：' + shown.join('、') + (p.words.length > 4 ? '等' : '');
    } else if (!p.label && p.stemQuote) {
      p.label = '“' + p.stemQuote + '”这道题';
    } else if (!p.label) {
      p.label = '这节课的一道题';
    }
    p.example = p.items[0] || null;
    if (p.key === 'present-perfect' || p.key === 'since-for') {
      p.link = { type: 'write1', url: '/lesson?lesson=write1', label: '去写句专项练' };
    } else if (hasCons) {
      p.link = { type: 'consolidate', url: '/lesson?lesson=' + lid + '-consolidate', label: '去做巩固练' };
    } else {
      p.link = null;
    }
    p.memberKeys = [...p.memberKeys];
  }
  // 取前 3 组：先按题数排；带写句专项链接的点若被挤出，换掉最后一位（对应的练习必须露出来）
  all.sort((a, b) => (b.count - a.count) || (a.minStep - b.minStep));
  let points = all.slice(0, 3);
  const linkedOutside = all.filter(p => p.link && p.link.type === 'write1' && !points.includes(p));
  if (linkedOutside.length && points.length) {
    const swapIdx = points.length - 1;
    if (!points[swapIdx].link || points[swapIdx].link.type !== 'write1') {
      points[swapIdx] = linkedOutside[0];
    }
  }
  // 跨课记忆：按成员键逐个记；组里任一成员之前在别的课出现过 → 整组标"还没学会"
  // 顺序门（2026-11-09 修）：first_lesson 必须是按课程序最早的那节，不是第一次算的那节。
  // 旧课完成页重算时，若记录的首课比当前课晚，只把首课往前纠正，不标"还没学会"、不重复计数；
  // 只有首课严格早于当前课，才标"还没学会"。
  const curOrd = lessonOrder(lid);
  for (const p of points) {
    p.recurring = false;
    p.first_lesson = null;
    for (const mk of p.memberKeys) {
      try {
        const row = db.prepare('SELECT * FROM weak_point_notes WHERE point_key=?').get(mk);
        if (!row) {
          db.prepare(`INSERT INTO weak_point_notes(point_key,label,first_lesson,last_lesson,status,times_seen,first_seen_at,last_seen_at)
            VALUES(?, ?, ?, ?, 'open', 1, datetime('now'), datetime('now'))`).run(mk, p.label, lid, lid);
        } else if (curOrd < lessonOrder(row.first_lesson)) {
          // 当前课比记录的首课更早：纠正首课（自愈），不标、不计数
          db.prepare(`UPDATE weak_point_notes SET first_lesson=?, label=?, status='open', last_seen_at=datetime('now'), resolved_at=NULL WHERE point_key=?`).run(lid, p.label, mk);
        } else if (curOrd === lessonOrder(row.first_lesson)) {
          // 当前课就是首课：幂等重算，不写、不标
        } else {
          // 首课严格早于当前课：真复发
          p.recurring = true;
          if (!p.first_lesson) p.first_lesson = { id: row.first_lesson, title: lessonTitleOf(loadLesson, row.first_lesson) };
          if (row.last_lesson !== lid) {
            db.prepare(`UPDATE weak_point_notes SET times_seen=times_seen+1, last_lesson=?, label=?, status='open', last_seen_at=datetime('now'), resolved_at=NULL WHERE point_key=?`).run(lid, p.label, mk);
          }
        }
      } catch {}
    }
    delete p.memberKeys;
    delete p.words;
    delete p.stemQuote;
    delete p.minStep;
  }
  return { lesson: lid, title, points, total_weak_items: weakItems.length };
}


// 课程序：u{单元}r{课} → 单元*100+课；巩固练算本单元最后（u3-consolidate=399）
function lessonOrder(lid) {
  if (!lid) return 0;
  if (lid === 'u3-consolidate') return 399;
  const m = /^u(\d+)r(\d+)(-consolidate)?$/.exec(lid);
  if (!m) return 0;
  return parseInt(m[1], 10) * 100 + (m[3] ? 99 : parseInt(m[2], 10));
}

// ---- 独立答对 → 该知识点消退（在 attempts.js 独立答对分支后调用） ----
function resolvePointOnClean(itemRow) {
  if (!itemRow || !itemRow.item_id) return;
  const lid = lessonOf(itemRow.item_id);
  if (!isEnglishLesson(lid)) return;
  let cls;
  try { cls = classifyFromItemRow(itemRow); } catch { return; }
  if (!cls || !cls.key || cls.key.indexOf('item:') === 0) return;
  const mk = cls.memberKey || cls.key;
  try {
    db.prepare("UPDATE weak_point_notes SET status='resolved', resolved_at=datetime('now') WHERE point_key=? AND status='open'").run(mk);
  } catch {}
}

module.exports = {
  classifyPoint, classifyFromStep, classifyFromItemRow,
  computeLessonWeakness, resolvePointOnClean, isEnglishLesson, logicalItemId,
};
