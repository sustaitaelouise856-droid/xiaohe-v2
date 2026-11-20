'use strict';
// 睡前故事（2026-11-20，Elouise 批准）：只听故事，不做题、不判分、不进门禁、不颁称号。
// 计时与学习分钟完全分开：story_listens 表只记故事收听；
// 夜画像的学习分钟只读 attempts 表（作答段），周报同理——故事行永远加不进去。
// 音频状态 UNVERIFIED（未人耳验证，见音频红线，不写 PASS）。
const { shanghaiDay } = require('./time');

const STORIES = {
  king: { id: 'king', title: '国王和大城堡', title_en: 'The King and the Big Castle', audio: '/audio/bedtime/king.mp3' },
  sam: { id: 'sam', title: 'Sam 和跑步比赛', title_en: 'Sam and the School Race', audio: '/audio/bedtime/sam.mp3' },
};

function isValidSession(s) {
  return typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
}

// POST /api/story-listen：客户端心跳（播放中每 30 秒）+ 暂停/播完上报。
// body: { session, story_id, seconds, completed }。
// session 是客户端一次播放的随机 id；同一 session 多次上报只更新一行（UPSERT），
// 不产生多行。seconds 是本次播放累计听到的秒数（取 audio.currentTime 下限）。
function recordListen(db, body) {
  const storyId = String((body && body.story_id) || '');
  if (!STORIES[storyId]) throw new Error('bad_story');
  if (!isValidSession(body.session)) throw new Error('bad_session');
  let seconds = Number(body.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.min(Math.floor(seconds), 86400);
  const completed = body.completed ? 1 : 0;
  db.prepare(
    `INSERT INTO story_listens(session_id, story_id, seconds_listened, completed)
     VALUES(?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       seconds_listened=excluded.seconds_listened,
       completed=excluded.completed,
       updated_at=datetime('now')`
  ).run(body.session, storyId, seconds, completed);
  return { ok: true, story_id: storyId, seconds_listened: seconds, completed };
}

// GET /api/bedtime/today：今日收听汇总（上海日），供故事页显示“今晚已听 X 分钟”
// 与画像核对。只读 story_listens，不读 attempts。
function todaySummary(db) {
  const day = shanghaiDay();
  const rows = db.prepare(
    `SELECT story_id, seconds_listened, completed FROM story_listens
     WHERE date(started_at,'+8 hours') = ?`
  ).all(day);
  let total = 0;
  const stories = {};
  for (const r of rows) {
    total += r.seconds_listened || 0;
    const cur = stories[r.story_id] || { seconds: 0, completed: 0 };
    cur.seconds = Math.max(cur.seconds, r.seconds_listened || 0);
    cur.completed = Math.max(cur.completed, r.completed || 0);
    stories[r.story_id] = cur;
  }
  // 续听（2026-11-20）：每篇故事上次听到哪（跨天，取最新一行），供故事页打开时接着放。只读，不改计时口径。
  const last = {};
  for (const id of Object.keys(STORIES)) {
    const r = db.prepare(
      `SELECT seconds_listened, completed, updated_at FROM story_listens
       WHERE story_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get(id);
    last[id] = r ? { seconds: r.seconds_listened || 0, completed: r.completed || 0, updated_at: r.updated_at || null }
                 : { seconds: 0, completed: 0, updated_at: null };
  }
  return { ok: true, day, minutes: Math.floor(total / 60), seconds: total, sessions: rows.length, stories, last };
}

module.exports = { STORIES, recordListen, todaySummary };
