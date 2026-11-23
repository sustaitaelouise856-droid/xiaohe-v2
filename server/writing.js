'use strict';
// 整篇写作训练（2026-11-21，Elouise 批准：三块大件之一）。
// 五步流程：审题 → 列提纲 → 写 → 对照范文 → 改写。只练、不判分。
// 提交不自动给分、不计门禁、不消错题、不颁称号、不写 attempts 行；
// 作文存 writing_answers 表，等 Muse 事后经管理接口判分（0–25 分 + 评语），
// 孩子下次打开本页能看到分数和评语。范文只用 U1–U8 505 词 + 已学句型写。
const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'writing-topics.json'), 'utf8'));
const TOPIC_MAP = {};
for (const t of DATA.topics) TOPIC_MAP[t.id] = t;
const MAX_SCORE = DATA.max_score || 25;

function isValidSession(s) {
  return typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function initWritingTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS writing_answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  outline_json TEXT,
  draft        TEXT NOT NULL,
  rewrite_text TEXT,
  word_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  score        REAL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  graded_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_writing_answers_session ON writing_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_writing_answers_status ON writing_answers(status);
`);
}

// GET /api/writing/topics：3 个话题 + 句框 + 范文 + 自查清单（公开教学内容，无答案可泄）。
function getTopics() {
  return {
    ok: true,
    word_min: DATA.word_min,
    word_max: DATA.word_max,
    max_score: MAX_SCORE,
    checklist: DATA.checklist,
    topics: DATA.topics.map(t => ({
      id: t.id, title_cn: t.title_cn, title_en: t.title_en,
      prompt_cn: t.prompt_cn, prompt_en: t.prompt_en,
      think: t.think, frames: t.frames,
      model_title: t.model_title, model: t.model, model_cn: t.model_cn,
      model_audio: t.model_audio, compare: t.compare,
    })),
  };
}

// POST /api/writing/submit：交初稿。{topic_id, session, outline:[5条要点], draft}
// 只存库，不判分、不计分、不碰 attempts / retest_queue / titles。
function submitEssay(db, body) {
  const topicId = String((body && body.topic_id) || '');
  if (!TOPIC_MAP[topicId]) throw new Error('bad_topic');
  if (!isValidSession(body.session)) throw new Error('bad_session');
  const draft = String((body && body.draft) || '').trim();
  if (draft.length < 10) throw new Error('draft_too_short');
  if (draft.length > 5000) throw new Error('draft_too_long');
  let outlineJson = null;
  if (Array.isArray(body.outline)) {
    const outline = body.outline.slice(0, 5).map(x => String(x || '').trim().slice(0, 200));
    outlineJson = JSON.stringify(outline);
  }
  const wc = wordCount(draft);
  const r = db.prepare(
    `INSERT INTO writing_answers(topic_id, session_id, outline_json, draft, word_count)
     VALUES(?,?,?,?,?)`
  ).run(topicId, body.session, outlineJson, draft, wc);
  return { ok: true, id: Number(r.lastInsertRowid), status: 'pending', word_count: wc };
}

// POST /api/writing/rewrite：交改写。{id, session, rewrite_text}
// 只改本人的那一行（id + session 匹配），改写不重新判分、不改状态。
function rewriteEssay(db, body) {
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad_id');
  if (!isValidSession(body.session)) throw new Error('bad_session');
  const text = String((body && body.rewrite_text) || '').trim();
  if (text.length < 10) throw new Error('rewrite_too_short');
  if (text.length > 5000) throw new Error('rewrite_too_long');
  const row = db.prepare('SELECT id FROM writing_answers WHERE id=? AND session_id=?').get(id, body.session);
  if (!row) throw new Error('not_found');
  db.prepare(
    `UPDATE writing_answers SET rewrite_text=?, word_count=?, updated_at=datetime('now') WHERE id=?`
  ).run(text, wordCount(text), id);
  return { ok: true, id, word_count: wordCount(text) };
}

// GET /api/writing/my?session=…：本 session 的作文列表（最新在前），含批改结果。
function getMyEssays(db, query) {
  if (!isValidSession(query && query.session)) throw new Error('bad_session');
  const rows = db.prepare(
    `SELECT id, topic_id, draft, rewrite_text, word_count, status, score, note, created_at, graded_at
     FROM writing_answers WHERE session_id=? ORDER BY id DESC LIMIT 20`
  ).all(query.session);
  return { ok: true, essays: rows.map(r => ({
    id: r.id, topic_id: r.topic_id,
    topic_cn: TOPIC_MAP[r.topic_id] ? TOPIC_MAP[r.topic_id].title_cn : r.topic_id,
    draft: r.draft, rewrite_text: r.rewrite_text, word_count: r.word_count,
    status: r.status, score: r.score, note: r.note,
    created_at: r.created_at, graded_at: r.graded_at,
  })) };
}

// GET /api/admin/writing-essays/pending：待批作文列表（供 Muse 判分，备份 token 鉴权在 index.js）。
function listPending(db) {
  const rows = db.prepare(
    `SELECT id, topic_id, session_id, outline_json, draft, rewrite_text, word_count, created_at
     FROM writing_answers WHERE status='pending' ORDER BY id ASC`
  ).all();
  return { ok: true, pending: rows.map(r => ({
    id: r.id, topic_id: r.topic_id,
    topic_cn: TOPIC_MAP[r.topic_id] ? TOPIC_MAP[r.topic_id].title_cn : r.topic_id,
    session_id: r.session_id, outline: r.outline_json ? JSON.parse(r.outline_json) : [],
    draft: r.draft, rewrite_text: r.rewrite_text, word_count: r.word_count,
    created_at: r.created_at, max_score: MAX_SCORE,
  })) };
}

// POST /api/admin/writing-essays/grade：Muse 判分。{id, score, note}
// 0–25 分，超范围拒绝；note 最长 2000 字。只改这一行，不碰任何别的表。
function gradeEssay(db, body) {
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad_id');
  const score = Number(body && body.score);
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    const e = new Error('score_out_of_range'); e.max = MAX_SCORE; throw e;
  }
  const note = String((body && body.note) || '').slice(0, 2000);
  const row = db.prepare('SELECT id FROM writing_answers WHERE id=?').get(id);
  if (!row) throw new Error('not_found');
  db.prepare(
    `UPDATE writing_answers SET status='graded', score=?, note=?, graded_at=datetime('now'),
     updated_at=datetime('now') WHERE id=?`
  ).run(score, note, id);
  return { ok: true, id, score, max_score: MAX_SCORE };
}

module.exports = {
  MAX_SCORE, isValidSession, wordCount,
  initWritingTable, getTopics, submitEssay, rewriteEssay, getMyEssays,
  listPending, gradeEssay,
};
