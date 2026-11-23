'use strict';
// 听说模拟（2026-11-21，Elouise 定：三块大件之一）：广州新中考听说约 30 分（MASTER.md），期中听说 12/30。
// 三部分：①模仿朗读（短文 + 金句跟读，录音存库等 Muse 判）；②信息获取（听对话答题，服务端判分；听写错词自动进生词本）；
// ③信息转述及询问（听材料复述要点 + 提一个问题，录音存库等 Muse 判）。
// 只练：不写 attempts、不进错题本、不颁称号、不计门禁；学习分钟只读 attempts，听说练习不产生分钟。
// 录音本体 BLOB 存库，随备份走（沿用 /api/exam/speech 做法）；不做语音自动评分（Muse 事后听、判分）。
// 题型结构依据：通用中考听说结构（模仿朗读/信息获取/信息转述及询问），非官方原文；repo 内无书面题型依据。
const fs = require('fs');
const path = require('path');
const express = require('express');

// 各录音上限（秒）：客户端同值自动停；服务端再拦一次（+10 秒容差）
const PARTS = {
  read: { max: 60, label: '模仿朗读' },
  golden: { max: 30, label: '金句跟读' },
  retell: { max: 90, label: '复述' },
  question: { max: 30, label: '提问' },
};
const MAX_B64 = 4 * 1024 * 1024; // 单段录音上限 4MB 字符，同 /api/exam/speech

let _setsCache = null;
function loadSets() {
  if (_setsCache) return _setsCache;
  const fp = path.join(__dirname, '..', 'content', 'speaking-sets.json');
  _setsCache = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return _setsCache;
}
function findSet(id) {
  const d = loadSets();
  return (d.sets || []).find(s => s.id === String(id || '')) || null;
}
function findQuestion(set, qid) {
  if (!set) return null;
  return (set.listen.questions || []).find(q => q.qid === String(qid || '')) || null;
}

let _zhCache = null;
function loadWordZh() {
  if (_zhCache) return _zhCache;
  const map = {};
  try {
    const dir = path.join(__dirname, '..', 'content', 'words');
    for (const f of fs.readdirSync(dir)) {
      if (!/^unit\d+\.json$/.test(f)) continue;
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (const w of (d.words || [])) {
        const en = String(w.en || '').toLowerCase().trim();
        if (en && !map[en]) map[en] = String(w.cn || '');
      }
    }
  } catch (e) { console.error('[speaking] loadWordZh', e.message); }
  _zhCache = map;
  return map;
}

function initTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS speaking_recordings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id       TEXT NOT NULL,
  part         TEXT NOT NULL,
  mime         TEXT,
  audio        BLOB NOT NULL,
  duration_sec REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  score        REAL,
  note         TEXT,
  graded_at    TEXT,
  UNIQUE(set_id, part)
);`);
  db.exec(`
CREATE TABLE IF NOT EXISTS speaking_answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id       TEXT NOT NULL,
  qid          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  answer_text  TEXT,
  correct      INTEGER,
  verdict      TEXT,
  detail_json  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(set_id, qid)
);`);
}

// ---- 听写判分：词级比对（纯函数，可单测） ----
// 归一化：小写、去标点、压空格。verdict correct 当且仅当词序也全对；
// correct_n 按多重集匹配计（顺序错了也认词）；wrong_words = 预期里没写对的词（去重、保序），进生词本用。
function normWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
}
function gradeDictation(expected, given) {
  const exp = normWords(expected);
  const got = normWords(given);
  const pool = {};
  for (const w of got) pool[w] = (pool[w] || 0) + 1;
  let correctN = 0;
  const wrong = [];
  for (const w of exp) {
    if (pool[w] > 0) { pool[w]--; correctN++; }
    else if (!wrong.includes(w)) wrong.push(w);
  }
  const exact = exp.join(' ') === got.join(' ');
  return {
    verdict: exact ? 'correct' : 'wrong',
    correct_n: correctN,
    total_n: exp.length,
    wrong_words: wrong,
    expected: exp.join(' '),
  };
}
function gradeMcq(answer, expectedLetter) {
  const ok = String(answer || '').trim().toUpperCase() === String(expectedLetter || '').trim().toUpperCase();
  return { verdict: ok ? 'correct' : 'wrong' };
}

// 听写错词进生词本：vocab_words（INSERT OR IGNORE，带原句）+ word_mastery 答错 -1 级（同 /api/words/mastery 口径）
function addWrongWordsToVocab(db, wrongWords, sentence) {
  const zhMap = loadWordZh();
  const added = [];
  const sent = String(sentence || '').slice(0, 500);
  for (const w of wrongWords) {
    const word = String(w || '').toLowerCase().trim();
    if (!word) continue;
    db.prepare(`INSERT OR IGNORE INTO vocab_words(word, zh, ph, sent) VALUES(?,?,?,?)`)
      .run(word, zhMap[word] || '', '', sent);
    const cur = db.prepare('SELECT level, correct_n, wrong_n FROM word_mastery WHERE word=?').get(word);
    const level = Math.max(0, (cur ? cur.level : 0) - 1);
    const cn = cur ? cur.correct_n : 0;
    const wn = (cur ? cur.wrong_n : 0) + 1;
    db.prepare(`INSERT INTO word_mastery(word, level, correct_n, wrong_n, last_at, updated_at)
      VALUES(?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(word) DO UPDATE SET level=excluded.level, correct_n=excluded.correct_n,
      wrong_n=excluded.wrong_n, last_at=excluded.last_at, updated_at=excluded.updated_at`)
      .run(word, level, cn, wn);
    added.push(word);
  }
  return added;
}

// 信息获取作答：服务端判分并落库（speaking_answers，不碰 attempts/错题本/称号）
function submitAnswer(db, body) {
  const setId = String((body && body.set_id) || '');
  const qid = String((body && body.qid) || '');
  const answer = String((body && body.answer) || '');
  const set = findSet(setId);
  if (!set) return { ok: false, error: 'bad_set' };
  const q = findQuestion(set, qid);
  if (!q) return { ok: false, error: 'bad_qid' };
  if (!answer.trim()) return { ok: false, error: 'empty_answer' };
  let correct = 0, verdict = 'wrong', detail = {}, vocabAdded = [];
  if (q.kind === 'mcq') {
    const g = gradeMcq(answer, q.answer);
    verdict = g.verdict;
    correct = verdict === 'correct' ? 1 : 0;
    detail = { given: answer.trim() };
  } else if (q.kind === 'dictation') {
    const g = gradeDictation(q.sentence, answer);
    verdict = g.verdict;
    correct = verdict === 'correct' ? 1 : 0;
    detail = { correct_n: g.correct_n, total_n: g.total_n, wrong_words: g.wrong_words, expected: g.expected };
    if (g.wrong_words.length) vocabAdded = addWrongWordsToVocab(db, g.wrong_words, q.sentence);
  } else {
    return { ok: false, error: 'bad_kind' };
  }
  db.prepare(`INSERT INTO speaking_answers(set_id, qid, kind, answer_text, correct, verdict, detail_json, created_at)
    VALUES(?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(set_id, qid) DO UPDATE SET kind=excluded.kind, answer_text=excluded.answer_text,
    correct=excluded.correct, verdict=excluded.verdict, detail_json=excluded.detail_json,
    created_at=excluded.created_at`)
    .run(setId, qid, q.kind, answer.slice(0, 2000), correct, verdict, JSON.stringify(detail));
  return { ok: true, set_id: setId, qid, kind: q.kind, correct, verdict, explain: q.explain || '', detail, vocab_added: vocabAdded };
}

// 录音保存/重录：同 (set_id, part) 重录覆盖旧行并清空旧批改（同 exams.saveSpeech 口径）
function saveRecording(db, body) {
  const setId = String((body && body.set_id) || '');
  const part = String((body && body.part) || '');
  if (!findSet(setId)) return { ok: false, error: 'bad_set' };
  if (!PARTS[part]) return { ok: false, error: 'bad_part' };
  let b64 = String(body.audio_b64 || '');
  const di = b64.indexOf('base64,');
  if (di >= 0) b64 = b64.slice(di + 7);
  if (!b64) return { ok: false, error: 'bad_request' };
  if (b64.length > MAX_B64) return { ok: false, error: 'too_large' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { ok: false, error: 'empty_audio' };
  const dur = Number(body.duration_sec);
  if (!isFinite(dur) || dur <= 0 || dur > PARTS[part].max + 10) return { ok: false, error: 'bad_duration' };
  db.prepare(`INSERT INTO speaking_recordings(set_id, part, mime, audio, duration_sec, created_at, score, note, graded_at)
    VALUES(?,?,?,?,?,datetime('now'),NULL,NULL,NULL)
    ON CONFLICT(set_id, part) DO UPDATE SET mime=excluded.mime, audio=excluded.audio,
    duration_sec=excluded.duration_sec, created_at=excluded.created_at,
    score=NULL, note=NULL, graded_at=NULL`)
    .run(setId, part, String(body.mime || '').slice(0, 128) || null, buf, dur);
  const row = db.prepare(`SELECT id FROM speaking_recordings WHERE set_id=? AND part=?`).get(setId, part);
  return { ok: true, id: row ? row.id : null, set_id: setId, part };
}

// 各套进度：只读服务端表（attempts/错题本/称号一律不动）
function setsProgress(db) {
  const d = loadSets();
  const out = [];
  for (const s of d.sets) {
    const a = db.prepare(`SELECT qid, correct FROM speaking_answers WHERE set_id=?`).all(s.id);
    const r = db.prepare(`SELECT part, score, graded_at FROM speaking_recordings WHERE set_id=?`).all(s.id);
    const totalQ = (s.listen.questions || []).length;
    const totalR = Object.keys(PARTS).length;
    out.push({
      id: s.id, title: s.title, title_zh: s.title_zh, topic_zh: s.topic_zh,
      answers_done: a.length, answers_total: totalQ,
      answers_correct: a.filter(x => x.correct === 1).length,
      recordings_done: r.length, recordings_total: totalR,
      recordings_graded: r.filter(x => x.graded_at != null).length,
      done: a.length >= totalQ && r.length >= totalR,
    });
  }
  return out;
}

function checkAdminToken(req) {
  const token = req.query.token || req.headers['x-backup-token'] || ((req.body || {}).token);
  if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) return false;
  return true;
}

function register(app, db) {
  initTables(db);
  // 注意：/api/speaking/record 的 6mb body 解析在 index.js 顶部注册（必须在全局 256kb 之前，同 /api/exam/speech 做法）；这里不再重复挂，免得被全局解析器先拦。

  // GET /api/speaking/sets：套数列表 + 各套进度（只读 speaking_* 表）
  app.get('/api/speaking/sets', (req, res) => {
    try { res.json({ ok: true, sets: setsProgress(db) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /api/speaking/set/:id：一套的全部内容（文本/题目/音频地址；不含答案以外的批改信息）
  app.get('/api/speaking/set/:id', (req, res) => {
    try {
      const set = findSet(req.params.id);
      if (!set) return res.status(400).json({ ok: false, error: 'bad_set' });
      const answers = db.prepare(`SELECT qid, answer_text, correct, verdict FROM speaking_answers WHERE set_id=?`).all(set.id);
      const recs = db.prepare(`SELECT part, duration_sec, created_at, score, note, graded_at FROM speaking_recordings WHERE set_id=?`).all(set.id);
      res.json({ ok: true, set, answers, recordings: recs });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /api/speaking/answer：信息获取作答（选择/听写），服务端判分
  app.post('/api/speaking/answer', (req, res) => {
    try {
      const r = submitAnswer(db, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /api/speaking/record：录音上传（BLOB 存库，随备份走）
  app.post('/api/speaking/record', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const r = saveRecording(db, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 管理：待批改录音列表（不含 BLOB 本体，未批改排前面）。鉴权同 /api/admin/speech：备份 token。
  app.get('/api/admin/speaking/pending', (req, res) => {
    if (!checkAdminToken(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.set('Cache-Control', 'no-store');
    try {
      const rows = db.prepare(`
        SELECT id, set_id, part, mime, length(audio) AS size, duration_sec,
               created_at, score, note, graded_at
        FROM speaking_recordings
        ORDER BY (graded_at IS NOT NULL) ASC, id DESC`).all();
      res.json({ ok: true, list: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 管理：听一段录音（按存档 mime 返回 BLOB 本体）
  app.get('/api/speaking/recording/:id/audio', (req, res) => {
    if (!checkAdminToken(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.set('Cache-Control', 'no-store');
    try {
      const r = db.prepare(`SELECT audio, mime FROM speaking_recordings WHERE id=?`).get(Number(req.params.id) || 0);
      if (!r || !r.audio) return res.status(404).json({ ok: false, error: 'no_audio' });
      res.set('Content-Type', r.mime || 'audio/webm');
      res.send(Buffer.from(r.audio));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 管理：给一段录音写批改分数与评语（分期批改的落点）
  app.post('/api/admin/speaking/grade', (req, res) => {
    if (!checkAdminToken(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const b = req.body || {};
      const id = Number(b.id) || 0;
      const score = Number(b.score);
      if (!id || !isFinite(score)) return res.status(400).json({ ok: false, error: 'bad_request' });
      const r = db.prepare(`UPDATE speaking_recordings SET score=?, note=?, graded_at=datetime('now') WHERE id=?`)
        .run(score, String(b.note || '').slice(0, 2000), id);
      if (!r.changes) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { register, loadSets, gradeDictation, gradeMcq, submitAnswer, saveRecording, setsProgress, PARTS };
