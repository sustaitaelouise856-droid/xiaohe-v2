// 月度限时模考后端（2026-11-21）
// 模考是测量，不是日常练习：不计门禁、不消错题、不颁称号。成绩存库。
// 判分/录音留存/作文回填全部复用 server/exams.js（同一 exam_id 口径，
// 主观题由 Muse 事后判分、走已有管理端回填落点，不开网页家长录分入口）；
// mock_results 只存模考特有元数据（开始时间、用时、超时、分题型得分、薄弱点一句话）。
'use strict';
const fs = require('fs');
const path = require('path');
const exams = require('./exams');

const MOCK_ID = 'mock-202611';
const GRACE_SEC = 300; // 超时宽限 5 分钟（网络延迟/提交耗时），超了仍收卷、只标超时

let db = null;
function setDb(d) { db = d; }

function mockPath() {
  return path.join(__dirname, '..', 'content', 'exams', MOCK_ID + '.json');
}
function loadMockRaw() {
  return JSON.parse(fs.readFileSync(mockPath(), 'utf8'));
}

// 公开版试卷：去掉答案和听力原文（听力原文只在交卷后回顾里给，不进页面源码）
function getMock() {
  try {
    const mock = loadMockRaw();
    const pub = JSON.parse(JSON.stringify(mock));
    pub.sections.forEach(sec => sec.parts.forEach(part => {
      part.questions.forEach(q => { delete q.answer; delete q.dialogue; });
    }));
    return { ok: true, mock: pub };
  } catch (e) {
    return { ok: false, error: 'not_found' };
  }
}

function initTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mock_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mock_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        started_at TEXT NOT NULL,
        submitted_at TEXT,
        elapsed_sec INTEGER,
        overtime INTEGER NOT NULL DEFAULT 0,
        score REAL,
        total REAL,
        sections_json TEXT,
        report_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mock_results_mock ON mock_results(mock_id);
    `);
  } catch (e) { console.error('[mock] initTable', e.message); }
}

function utcNowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function parseUtc(s) {
  return new Date(String(s).replace(' ', 'T') + 'Z').getTime();
}

// 开始一次模考：限时内未交卷的进行中记录可续答（刷新页面不重开）；否则新开一行
function startMock() {
  try {
    const mock = loadMockRaw();
    const limitSec = (mock.time_limit_minutes || 75) * 60;
    const now = new Date();
    const nowStr = utcNowStr();
    const open = db.prepare(`
      SELECT id, started_at FROM mock_results
      WHERE mock_id=? AND status='started' ORDER BY id DESC LIMIT 1
    `).get(MOCK_ID);
    if (open) {
      const elapsed = Math.floor((now.getTime() - parseUtc(open.started_at)) / 1000);
      if (elapsed < limitSec + GRACE_SEC) {
        const pub = getMock();
        if (!pub.ok) return pub;
        return { ok: true, mock_id: MOCK_ID, attempt_id: open.id, started_at: open.started_at, elapsed_sec: elapsed, time_limit_minutes: mock.time_limit_minutes, total: mock.total_score, resumed: true, mock: pub.mock };
      }
      // 超时未交：标记过期（不判分，成绩以交卷行为准）
      db.prepare(`UPDATE mock_results SET status='expired' WHERE id=?`).run(open.id);
    }
    const r = db.prepare(`
      INSERT INTO mock_results (mock_id, status, started_at, created_at)
      VALUES (?, 'started', ?, ?)
    `).run(MOCK_ID, nowStr, nowStr);
    const pub = getMock();
    if (!pub.ok) return pub;
    return { ok: true, mock_id: MOCK_ID, attempt_id: Number(r.lastInsertRowid), started_at: nowStr, elapsed_sec: 0, time_limit_minutes: mock.time_limit_minutes, total: mock.total_score, resumed: false, mock: pub.mock };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const SEC_ADVICE = {
  listening: { name: '听说', advice: '听力丢分多——每天听 10 分钟，先听一遍再看题。' },
  reading: { name: '阅读理解', advice: '阅读丢分多——先通读再做题，别只看一句话就选。' },
  cloze: { name: '完形填空', advice: '完形丢分多——先通读全篇再选，别只看空前后一个词。' },
  grammar: { name: '语法选择', advice: '语法丢分多——先把错的那几个点在课本里找到，再做 5 道同类题。' },
  writing: { name: '书面表达', advice: '' },
};

// 按 section 汇总：got 含已批改主观分；objGot/objMax 只算客观题（薄弱点只看客观题，
// 写作/口语待批改时不参与排名，否则永远是写作最弱）；pending 为待批改分值
function buildSections(mock, detail) {
  const bySec = {};
  mock.sections.forEach(sec => {
    bySec[sec.id] = {
      id: sec.id,
      name: (SEC_ADVICE[sec.id] || {}).name || sec.title,
      got: 0, max: sec.score, objGot: 0, objMax: 0, pending: 0,
    };
  });
  (detail || []).forEach(d => {
    const secId = String(d.qid || '').split('-')[0];
    const s = bySec[secId];
    if (!s) return;
    if (d.status === 'pending') { s.pending += d.max; return; }
    s.got += d.got;
    s.objGot += d.got;
    s.objMax += d.max;
  });
  return Object.values(bySec);
}

// 薄弱点一句话（大白话，只按客观题得分率说，不猜答案内容）：
// 最弱 <60% 点名 + 具体做法；都 ≥60% 说最弱项保持；客观全对说等主观批改
function buildWeakness(sections) {
  const obj = sections.filter(s => s.objMax > 0);
  if (!obj.length) return '客观题 0 分，先看逐题回顾找找原因。';
  const worst = obj.slice().sort((a, b) => (a.objGot / a.objMax) - (b.objGot / b.objMax))[0];
  const rate = worst.objGot / worst.objMax;
  if (rate >= 1) return '客观题全对，作文和口语等老师批完再看总分。';
  if (rate >= 0.6) return '客观题都过关了，最弱的是' + worst.name + '（' + worst.objGot + '/' + worst.objMax + ' 分），保持就行；作文和口语等老师批完再看。';
  return worst.name + '只拿了 ' + worst.objGot + '/' + worst.objMax + ' 分。' + (SEC_ADVICE[worst.id] || {}).advice;
}

function safeJson(s) {
  try { return JSON.parse(s || 'null'); } catch { return null; }
}

// 交卷：服务端判分（不信任前端分数）→ 存 exam_scores（主观题 pending，
// 老师批改后走 exams.applySubjectiveGrades 回填）→ 记 mock_results → 返回成绩报告
function submitMock(attemptId, answers, clientElapsedSec) {
  try {
    const mock = loadMockRaw();
    const limitSec = (mock.time_limit_minutes || 75) * 60;
    const now = new Date();
    const nowStr = utcNowStr();
    // 用时以服务端 started_at 为准（客户端上报只作下限兜底，防刷新丢计时）
    let elapsed = Math.max(0, Math.floor(Number(clientElapsedSec) || 0));
    let attempt = null;
    if (attemptId) {
      attempt = db.prepare(`SELECT id, started_at, status FROM mock_results WHERE id=? AND mock_id=?`).get(Number(attemptId), MOCK_ID);
    }
    if (!attempt) {
      attempt = db.prepare(`SELECT id, started_at, status FROM mock_results WHERE mock_id=? AND status='started' ORDER BY id DESC LIMIT 1`).get(MOCK_ID);
    }
    if (attempt) {
      elapsed = Math.max(elapsed, Math.floor((now.getTime() - parseUtc(attempt.started_at)) / 1000));
    }
    const overtime = elapsed > limitSec + GRACE_SEC ? 1 : 0;
    const g = exams.gradeExam(MOCK_ID, answers || {});
    if (!g.ok) return { ok: false, error: 'grade_failed' };
    exams.saveScore(MOCK_ID, g.score, g.detail, answers || {});
    const sections = buildSections(mock, g.detail);
    const weakness = buildWeakness(sections);
    const report = { sections, weakness, overtime: !!overtime, elapsed_sec: elapsed };
    if (attempt && attempt.status === 'started') {
      db.prepare(`
        UPDATE mock_results SET status='submitted', submitted_at=?, elapsed_sec=?, overtime=?, score=?, total=?, sections_json=?, report_json=?
        WHERE id=?
      `).run(nowStr, elapsed, overtime, g.score, mock.total_score, JSON.stringify(sections), JSON.stringify(report), attempt.id);
    } else {
      // 无进行中记录（服务重启后直接交卷）：补记一行已提交
      const startedAt = attempt ? attempt.started_at : nowStr;
      db.prepare(`
        INSERT INTO mock_results (mock_id, status, started_at, submitted_at, elapsed_sec, overtime, score, total, sections_json, report_json, created_at)
        VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(MOCK_ID, startedAt, nowStr, elapsed, overtime, g.score, mock.total_score, JSON.stringify(sections), JSON.stringify(report), nowStr);
    }
    // 交卷后回顾：听力原文只在这时给
    const dialogues = {};
    mock.sections.forEach(sec => sec.parts.forEach(part => {
      part.questions.forEach((q, qi) => {
        if (q.dialogue) dialogues[sec.id + '-' + part.id + '-' + qi] = q.dialogue;
      });
    }));
    return {
      ok: true, mock_id: MOCK_ID, score: g.score, total: mock.total_score,
      total_objective: g.total_objective, pending: g.pending, detail: g.detail,
      sections, weakness, overtime: !!overtime, elapsed_sec: elapsed, dialogues,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 最新一次模考：交卷时分数 + 实时总分（老师批改作文/口语后，exam_scores 回填会变，
// 这里永远读最新存档，保证首页卡片和报告看到的是批改后的总分）
function latestMock() {
  try {
    const mock = loadMockRaw();
    const row = db.prepare(`SELECT * FROM mock_results WHERE mock_id=? AND status='submitted' ORDER BY id DESC LIMIT 1`).get(MOCK_ID);
    const live = exams.getLatestScore(MOCK_ID);
    let sections = null;
    let weakness = null;
    if (live.ok) {
      sections = buildSections(mock, live.detail);
      weakness = buildWeakness(sections);
    }
    const taken = db.prepare(`SELECT COUNT(*) AS n FROM mock_results WHERE mock_id=? AND status='submitted'`).get(MOCK_ID);
    return {
      ok: true,
      mock_id: MOCK_ID,
      title: mock.title,
      subtitle: mock.subtitle,
      time_limit_minutes: mock.time_limit_minutes,
      total: mock.total_score,
      taken: taken ? taken.n : 0,
      attempt: row ? {
        id: row.id, started_at: row.started_at, submitted_at: row.submitted_at,
        elapsed_sec: row.elapsed_sec, overtime: !!row.overtime,
        score: row.score, total: row.total,
        sections: safeJson(row.sections_json), report: safeJson(row.report_json),
      } : null,
      live: live.ok ? { score: live.score, sections, weakness } : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { setDb, getMock, initTable, startMock, submitMock, latestMock, buildSections, buildWeakness, MOCK_ID };
