'use strict';
// sync-merge.js — 把 U 盘离线库的记录按行合并回主站库。
//
// 原则（硬规则）：
//  1. 只 INSERT 缺失的行、只做“向前”的状态合并；全程没有任何 DELETE，
//     绝不整库覆盖，绝不改写主站已有的作答内容。
//  2. 去重键全部是业务键 + 时间戳，不依赖自增 id（离线库和主站库的
//     自增 id 会撞号，所以插入时一律不带 id，让主站重新分配）。
//  3. 跑两遍结果一样（幂等）：第二遍所有计数都是 0。
//  4. 整个合并包在一个事务里：中途出错全部回滚，主站库原样不动。
//
// 用法：
//   const { mergeOfflineDb } = require('./sync-merge');
//   const stats = mergeOfflineDb(serverDb, uploadedDb); // 两个 DatabaseSync 句柄
//   // stats = { inserted: { attempts: 3, ... }, updated: { lesson_state: 1, ... } }
//
// 注意：本文件不碰网络、不读 token、不写文件，只做库到库的合并。
// HTTP 层（token 校验、收文件、写临时文件）在 sync-upload.js 里。

const APPEND_TABLES = [
  // [表名, 去重键列, 插入列（不含 id）]
  ['attempts', ['item_id', 'session_id', 'created_at', 'answer_given'],
   ['item_id', 'helped', 'correct', 'answer_given', 'created_at', 'verdict', 'detail_json', 'session_id', 'independent', 'elapsed_ms', 'pasted']],
  ['help_events', ['item_id', 'session_id', 'created_at', 'level'],
   ['item_id', 'created_at', 'session_id', 'level']],
  ['weakness_events', ['item_id', 'session_id', 'tag', 'created_at'],
   ['item_id', 'session_id', 'tag', 'created_at']],
  ['diagnostic_answers', ['session_id', 'step', 'knowledge_point', 'created_at'],
   ['session_id', 'step', 'knowledge_point', 'category', 'verdict', 'created_at']],
  ['diagnostic_results', ['session_id', 'knowledge_point', 'created_at'],
   ['session_id', 'knowledge_point', 'category', 'status', 'correct', 'total', 'created_at']],
  ['tonight_practice', ['created_at', 'section', 'field', 'answer_text'],
   ['created_at', 'date', 'section', 'field', 'answer_text', 'correct', 'audio_blob', 'audio_mime', 'audio_duration_s', 'user_agent']],
  ['student_feedback', ['created_at', 'lesson_id', 'step_no', 'text'],
   ['created_at', 'lesson_id', 'step_no', 'item_id', 'text', 'image_b64', 'url', 'user_agent', 'status', 'reply', 'replied_at', 'images_json', 'student_deleted', 'audio_blob', 'audio_mime', 'audio_duration_s']],
  ['client_errors', ['message', 'source', 'lineno', 'colno', 'created_at'],
   ['message', 'source', 'lineno', 'colno', 'stack', 'url', 'user_agent', 'created_at']],
  ['exam_scores', ['exam_id', 'created_at', 'score'],
   ['exam_id', 'score', 'detail_json', 'created_at', 'answers_json']],
  ['exam_writing_grades', ['exam_id', 'qid', 'graded_at'],
   ['exam_id', 'qid', 'score', 'note', 'graded_at']],
  ['exam_speech', ['exam_id', 'qid', 'created_at'],
   ['exam_id', 'qid', 'mime', 'audio', 'duration_sec', 'created_at', 'score', 'note', 'graded_at']],
  ['checkins', ['day', 'kind'], ['day', 'kind', 'created_at']],
  ['titles', ['title_id'], ['title_id', 'earned_at']],
  ['vocab_words', ['word'], ['word', 'zh', 'ph', 'added_at', 'sent']],
  ['retest_passes', ['point', 'pass_date', 'source'],
   ['point', 'pass_date', 'source', 'note', 'created_at']],
  ['story_retells', ['story', 'retell_date', 'source'],
   ['story', 'retell_date', 'source', 'note', 'created_at']],
];

function keyWhere(cols) {
  return cols.map((c) => `COALESCE(${c},'') = COALESCE(?,'')`).join(' AND ');
}

function mergeAppend(db, up, table, keyCols, insCols, stats) {
  const exists = db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${keyWhere(keyCols)} LIMIT 1`);
  const insert = db.prepare(
    `INSERT INTO ${table}(${insCols.join(',')}) VALUES(${insCols.map(() => '?').join(',')})`);
  const rows = up.prepare(`SELECT ${insCols.join(',')} FROM ${table}`).all();
  let n = 0;
  for (const r of rows) {
    const keyVals = keyCols.map((c) => r[c]);
    if (exists.get(...keyVals)) continue;
    insert.run(...insCols.map((c) => r[c]));
    n++;
  }
  if (n) stats.inserted[table] = n;
}

function maxStr(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return a >= b ? a : b;
}

function minStr(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return a <= b ? a : b;
}

function mergeOfflineDb(db, up) {
  // 先校验上传的库：必须是完好的本站数据库。
  const chk = up.prepare('PRAGMA integrity_check').get();
  if (!chk || chk.integrity_check !== 'ok') throw new Error('uploaded db failed integrity_check');
  const tables = new Set(
    up.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const need of ['attempts', 'items', 'retest_queue', 'lesson_state']) {
    if (!tables.has(need)) throw new Error('uploaded db missing table: ' + need);
  }

  const stats = { inserted: {}, updated: {} };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, keyCols, insCols] of APPEND_TABLES) {
      if (!tables.has(table)) continue;
      mergeAppend(db, up, table, keyCols, insCols, stats);
    }

    // lesson_state：完成标记取“或”，开始日取最早，更新时间取最晚。
    {
      const sel = db.prepare('SELECT p1_started_day, p1_done, p2_done, updated_at FROM lesson_state WHERE lesson_id = ?');
      const ins = db.prepare('INSERT INTO lesson_state(lesson_id, p1_started_day, p1_done, p2_done, updated_at) VALUES(?,?,?,?,?)');
      const upd = db.prepare('UPDATE lesson_state SET p1_started_day = ?, p1_done = ?, p2_done = ?, updated_at = ? WHERE lesson_id = ?');
      let n = 0;
      for (const r of up.prepare('SELECT * FROM lesson_state').all()) {
        const cur = sel.get(r.lesson_id);
        if (!cur) { ins.run(r.lesson_id, r.p1_started_day, r.p1_done, r.p2_done, r.updated_at); n++; continue; }
        const merged = {
          day: minStr(cur.p1_started_day, r.p1_started_day),
          p1: Math.max(cur.p1_done || 0, r.p1_done || 0),
          p2: Math.max(cur.p2_done || 0, r.p2_done || 0),
          at: maxStr(cur.updated_at, r.updated_at),
        };
        if (merged.day !== cur.p1_started_day || merged.p1 !== cur.p1_done ||
            merged.p2 !== cur.p2_done || merged.at !== cur.updated_at) {
          upd.run(merged.day, merged.p1, merged.p2, merged.at, r.lesson_id);
          n++;
        }
      }
      if (n) stats.updated.lesson_state = n;
    }

    // progress：缺失的补上；已有的取最晚更新时间。
    {
      const sel = db.prepare('SELECT updated_at FROM progress WHERE lesson_id = ? AND part = ? AND item_id = ?');
      const ins = db.prepare('INSERT INTO progress(lesson_id, part, item_id, updated_at) VALUES(?,?,?,?)');
      const upd = db.prepare('UPDATE progress SET updated_at = ? WHERE lesson_id = ? AND part = ? AND item_id = ?');
      let n = 0;
      for (const r of up.prepare('SELECT * FROM progress').all()) {
        const cur = sel.get(r.lesson_id, r.part, r.item_id);
        if (!cur) { ins.run(r.lesson_id, r.part, r.item_id, r.updated_at); n++; continue; }
        const at = maxStr(cur.updated_at, r.updated_at);
        if (at !== cur.updated_at) { upd.run(at, r.lesson_id, r.part, r.item_id); n++; }
      }
      if (n) stats.updated.progress = n;
    }

    // retest_queue：缺失的补上；主站还是 pending、离线已解决的，把解决状态推过来。
    {
      const sel = db.prepare('SELECT status, resolved_at, variant_item_id FROM retest_queue WHERE item_id = ? AND knowledge_point = ? AND created_at = ?');
      const ins = db.prepare('INSERT INTO retest_queue(item_id, knowledge_point, status, source_session, variant_item_id, created_at, resolved_at) VALUES(?,?,?,?,?,?,?)');
      const upd = db.prepare('UPDATE retest_queue SET status = ?, resolved_at = ?, variant_item_id = ? WHERE item_id = ? AND knowledge_point = ? AND created_at = ?');
      let ni = 0, nu = 0;
      for (const r of up.prepare('SELECT * FROM retest_queue').all()) {
        const cur = sel.get(r.item_id, r.knowledge_point, r.created_at);
        if (!cur) { ins.run(r.item_id, r.knowledge_point, r.status, r.source_session, r.variant_item_id, r.created_at, r.resolved_at); ni++; continue; }
        if (cur.status === 'pending' && r.status === 'resolved') {
          upd.run('resolved', r.resolved_at, r.variant_item_id || cur.variant_item_id,
            r.item_id, r.knowledge_point, r.created_at);
          nu++;
        } else if (!cur.variant_item_id && r.variant_item_id) {
          upd.run(cur.status, cur.resolved_at, r.variant_item_id, r.item_id, r.knowledge_point, r.created_at);
          nu++;
        }
      }
      if (ni) stats.inserted.retest_queue = ni;
      if (nu) stats.updated.retest_queue = nu;
    }

    // word_mastery：等级和次数取两边最大值（次数可能少计，但等级绝不会丢）。
    {
      const sel = db.prepare('SELECT level, correct_n, wrong_n, last_at, updated_at FROM word_mastery WHERE word = ?');
      const ins = db.prepare('INSERT INTO word_mastery(word, level, correct_n, wrong_n, last_at, updated_at) VALUES(?,?,?,?,?,?)');
      const upd = db.prepare('UPDATE word_mastery SET level = ?, correct_n = ?, wrong_n = ?, last_at = ?, updated_at = ? WHERE word = ?');
      let n = 0;
      for (const r of up.prepare('SELECT * FROM word_mastery').all()) {
        const cur = sel.get(r.word);
        if (!cur) { ins.run(r.word, r.level, r.correct_n, r.wrong_n, r.last_at, r.updated_at); n++; continue; }
        const m = {
          level: Math.max(cur.level || 0, r.level || 0),
          c: Math.max(cur.correct_n || 0, r.correct_n || 0),
          w: Math.max(cur.wrong_n || 0, r.wrong_n || 0),
          last: maxStr(cur.last_at, r.last_at),
          at: maxStr(cur.updated_at, r.updated_at),
        };
        if (m.level !== cur.level || m.c !== cur.correct_n || m.w !== cur.wrong_n ||
            m.last !== cur.last_at || m.at !== cur.updated_at) {
          upd.run(m.level, m.c, m.w, m.last, m.at, r.word);
          n++;
        }
      }
      if (n) stats.updated.word_mastery = n;
    }

    // weak_point_notes：次数取最大，首次取最早，末次取最晚；任一边已解决就算解决。
    {
      const sel = db.prepare('SELECT * FROM weak_point_notes WHERE point_key = ?');
      const ins = db.prepare('INSERT INTO weak_point_notes(point_key, label, first_lesson, last_lesson, status, times_seen, first_seen_at, last_seen_at, resolved_at) VALUES(?,?,?,?,?,?,?,?,?)');
      const upd = db.prepare('UPDATE weak_point_notes SET status = ?, times_seen = ?, first_seen_at = ?, last_seen_at = ?, resolved_at = ? WHERE point_key = ?');
      let n = 0;
      for (const r of up.prepare('SELECT * FROM weak_point_notes').all()) {
        const cur = sel.get(r.point_key);
        if (!cur) {
          ins.run(r.point_key, r.label, r.first_lesson, r.last_lesson, r.status, r.times_seen, r.first_seen_at, r.last_seen_at, r.resolved_at);
          n++; continue;
        }
        const resolved = (cur.status === 'resolved' || r.status === 'resolved') ? 'resolved' : cur.status;
        const m = {
          status: resolved,
          times: Math.max(cur.times_seen || 0, r.times_seen || 0),
          first: minStr(cur.first_seen_at, r.first_seen_at),
          last: maxStr(cur.last_seen_at, r.last_seen_at),
          rat: maxStr(cur.resolved_at, r.resolved_at),
        };
        if (m.status !== cur.status || m.times !== cur.times_seen || m.first !== cur.first_seen_at ||
            m.last !== cur.last_seen_at || m.rat !== cur.resolved_at) {
          upd.run(m.status, m.times, m.first, m.last, m.rat, r.point_key);
          n++;
        }
      }
      if (n) stats.updated.weak_point_notes = n;
    }

    // “最新者胜”的状态表：整行取 updated_at 更晚的那边。
    const latestWins = [
      ['story_choices', ['lesson_id', 'choice_key'], ['lesson_id', 'choice_key', 'value', 'updated_at']],
      ['exam_progress', ['exam_id', 'qid'], ['exam_id', 'qid', 'given_json', 'got', 'result', 'updated_at']],
      ['exam_drafts', ['exam_id'], ['exam_id', 'started_at', 'elapsed_sec', 'updated_at']],
      ['knowledge_mastery', ['knowledge_point'], ['knowledge_point', 'status', 'updated_at']],
    ];
    for (const [table, keyCols, allCols] of latestWins) {
      if (!tables.has(table)) continue;
      const sel = db.prepare(`SELECT updated_at FROM ${table} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`);
      const ins = db.prepare(`INSERT INTO ${table}(${allCols.join(',')}) VALUES(${allCols.map(() => '?').join(',')})`);
      const upd = db.prepare(`UPDATE ${table} SET ${allCols.filter((c) => !keyCols.includes(c)).map((c) => `${c} = ?`).join(', ')} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`);
      let n = 0;
      for (const r of up.prepare(`SELECT * FROM ${table}`).all()) {
        const cur = sel.get(...keyCols.map((c) => r[c]));
        if (!cur) { ins.run(...allCols.map((c) => r[c])); n++; continue; }
        if (r.updated_at && (!cur.updated_at || r.updated_at > cur.updated_at)) {
          const setCols = allCols.filter((c) => !keyCols.includes(c));
          upd.run(...setCols.map((c) => r[c]), ...keyCols.map((c) => r[c]));
          n++;
        }
      }
      if (n) stats.updated[table] = n;
    }

    // diagnostic_sessions：缺失的补上；离线已完成的，把完成状态推过来。
    {
      const sel = db.prepare('SELECT status, completed_at FROM diagnostic_sessions WHERE form = ? AND section = ? AND started_at = ?');
      const ins = db.prepare('INSERT INTO diagnostic_sessions(form, section, status, started_at, completed_at) VALUES(?,?,?,?,?)');
      const upd = db.prepare('UPDATE diagnostic_sessions SET status = ?, completed_at = ? WHERE form = ? AND section = ? AND started_at = ?');
      let ni = 0, nu = 0;
      for (const r of up.prepare('SELECT * FROM diagnostic_sessions').all()) {
        const cur = sel.get(r.form, r.section, r.started_at);
        if (!cur) { ins.run(r.form, r.section, r.status, r.started_at, r.completed_at); ni++; continue; }
        if (cur.status !== 'completed' && r.status === 'completed') {
          upd.run('completed', r.completed_at, r.form, r.section, r.started_at);
          nu++;
        }
      }
      if (ni) stats.inserted.diagnostic_sessions = ni;
      if (nu) stats.updated.diagnostic_sessions = nu;
    }

    // 注意：app_state、items、lessons、readings 故意不合并——主站是内容和
    // 系统状态的唯一来源；离线包不可能产生比主站更新的课程内容。
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (ignored) {}
    throw e;
  }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (ignored) {}
  return stats;
}

module.exports = { mergeOfflineDb };
