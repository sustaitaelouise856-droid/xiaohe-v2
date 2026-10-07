'use strict';
// 题目入库（含开机自动入库）。
//
// 2026-09-29 C10 事故：安装说明漏了 seed 步骤，空数据库导致作答提交 no_item，
// 孩子点任何选项都显示"提交没成功，再点一次试试"。从此服务启动时自动检查入库，
// 不再依赖人工执行 seed。
//
// 内容不变性（2026-09-30 Elouise 二审三11）："做过的题不原地修改"。
// - 已存在的题目一律不覆盖（INSERT … ON CONFLICT DO NOTHING）。
// - 已存在的题内容对不上课程 JSON 时，报错并提示"改题必须升版本号"，
//   不静默覆盖，保证孩子做过的题面、答案、作答记录都不变。
// - lessons 表的 title/status 是元数据（非题目内容），仍允许更新。
//
// 幂等：重复跑只新增缺失的题，从不删除、不碰 attempts 等作答数据。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function contentDir() {
  // 测试可用 XH_CONTENT_DIR 指向临时内容目录（与 XH_DATA_DIR 同一约定）；生产默认 content/
  return process.env.XH_CONTENT_DIR || path.join(__dirname, '..', 'content');
}

// 一课里要入库的步骤（mcq + short）
function gradableSteps(lesson) {
  return lesson.steps.filter(s => s.kind === 'mcq' || s.kind === 'short');
}

// 一道题入库用的规范字段（与 items 表列一一对应）
function itemFields(lid, lesson, s) {
  const item_id = `${lid}-v${lesson.version}-s${s.step}`;
  const answer = s.kind === 'mcq' ? s.answer : (s.answer_text || '');
  const answer_pos = s.kind === 'mcq' ? 'ABCD'.indexOf(answer) : -1;
  return {
    item_id,
    lesson_id: lid,
    version: lesson.version,
    step_no: s.step,
    kind: s.kind,
    prompt: s.stem || s.task || '',
    options_json: s.kind === 'mcq' ? JSON.stringify(s.options) : null,
    answer,
    answer_pos: Number.isInteger(answer_pos) && answer_pos >= 0 ? answer_pos : null,
    audio_id: s.audio_id || null,
    skill: 'notice-update',
    teach_html: s.teach_html || null,
    grading_json: s.kind === 'short' ? JSON.stringify({ expects: s.expects || [] }) : null,
    phase: s.phase || 'practice',
  };
}

// 内容指纹：比较"课程 JSON 里的题"和"数据库里的题"是否一致。
// 归一化后再哈希，避免 null/''、数字/字符串这类类型差异造成误报。
function fingerprint(f) {
  const norm = {
    item_id: String(f.item_id),
    lesson_id: String(f.lesson_id),
    version: Number(f.version),
    step_no: Number(f.step_no),
    kind: String(f.kind),
    prompt: String(f.prompt == null ? '' : f.prompt),
    options_json: f.options_json == null ? null : String(f.options_json),
    answer: String(f.answer == null ? '' : f.answer),
    answer_pos: f.answer_pos == null ? null : Number(f.answer_pos),
    audio_id: f.audio_id == null ? null : String(f.audio_id),
    skill: String(f.skill == null ? '' : f.skill),
    teach_html: f.teach_html == null ? null : String(f.teach_html),
    grading_json: f.grading_json == null ? null : String(f.grading_json),
    phase: String(f.phase == null ? '' : f.phase),
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

// 入库一课。返回 { n, version }，n 为本次新增的题数。
// 已存在的题内容不一致时抛错（改题必须升版本号），不覆盖。
function seedLesson(lid, lesson) {
  if (!lesson) {
    lesson = JSON.parse(
      fs.readFileSync(path.join(contentDir(), `lesson-${lid}.json`), 'utf-8')
    );
  }
  db.prepare(
    `INSERT INTO lessons(lesson_id, title, status) VALUES(?,?,?)
     ON CONFLICT(lesson_id) DO UPDATE SET title=excluded.title, status=excluded.status`
  ).run(lid, lesson.title, 'pilot');

  const ins = db.prepare(
    `INSERT INTO items(item_id, lesson_id, version, step_no, kind, prompt, options_json,
       answer, answer_pos, audio_id, skill, teach_html, grading_json, phase)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO NOTHING`
  );
  const get = db.prepare(
    `SELECT item_id, lesson_id, version, step_no, kind, prompt, options_json,
            answer, answer_pos, audio_id, skill, teach_html, grading_json, phase
     FROM items WHERE item_id=?`
  );

  let n = 0;
  for (const s of gradableSteps(lesson)) {
    const f = itemFields(lid, lesson, s);
    const row = get.get(f.item_id);
    if (!row) {
      ins.run(
        f.item_id, f.lesson_id, f.version, f.step_no, f.kind, f.prompt, f.options_json,
        f.answer, f.answer_pos, f.audio_id, f.skill, f.teach_html, f.grading_json, f.phase
      );
      n++;
    } else if (fingerprint(row) !== fingerprint(f)) {
      // 做过的题不原地修改：内容对不上说明有人想改题，必须升版本号换新 item_id
      throw new Error(
        `题目内容不一致，已拒绝覆盖：${f.item_id}。` +
        `改题必须升版本号（做过的题不原地修改）。`
      );
    }
  }
  return { n, version: lesson.version };
}

// 开机自动入库：逐课检查 lessons 记录 + items 数量 + 内容指纹，对不上就处理。
// 返回 [{ lesson_id, seeded, error? }]。失败只记录，不抛（不能因此起不来服务；
// 健康检查 /api/health 会标出失败状态，见 2026-09-30 二审三10）。
function autoSeed() {
  const dir = contentDir();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    // 正文课 u2r<数字>/u3r<数字>/u4r<数字> + 练习课 review<数字>（2026-10-02 总任务书：学完新课自动接着练）
    const m = /^lesson-(u2r\d+|u3r\d+|u4r\d+|review\d+)\.json$/.exec(f);
    if (!m) continue;
    const lid = m[1];
    try {
      const lesson = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const expected = gradableSteps(lesson).length;
      const row = db.prepare('SELECT lesson_id FROM lessons WHERE lesson_id=?').get(lid);
      const have = db.prepare('SELECT COUNT(*) c FROM items WHERE lesson_id=?').get(lid).c;
      if (!row || have !== expected) {
        const { n, version } = seedLesson(lid, lesson);
        out.push({ lesson_id: lid, seeded: n, version });
      } else {
        // 数量对上时也要验内容指纹：防止有人绕过版本号改了题面
        const get = db.prepare(
          `SELECT item_id, lesson_id, version, step_no, kind, prompt, options_json,
                  answer, answer_pos, audio_id, skill, teach_html, grading_json, phase
           FROM items WHERE lesson_id=?`
        );
        const dbRows = new Map(get.all(lid).map(r => [r.item_id, r]));
        let bad = null;
        for (const s of gradableSteps(lesson)) {
          const f = itemFields(lid, lesson, s);
          const r = dbRows.get(f.item_id);
          if (!r || fingerprint(r) !== fingerprint(f)) { bad = f.item_id; break; }
        }
        if (bad) {
          out.push({
            lesson_id: lid, seeded: 0,
            error: `题目内容不一致，已拒绝覆盖：${bad}。改题必须升版本号（做过的题不原地修改）。`,
          });
        } else {
          out.push({ lesson_id: lid, seeded: 0 });
        }
      }
    } catch (e) {
      out.push({ lesson_id: lid, seeded: 0, error: String((e && e.message) || e) });
    }
  }
  return out;
}

module.exports = { seedLesson, autoSeed, gradableSteps, itemFields, fingerprint, contentDir };
