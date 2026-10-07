'use strict';
// SQLite 数据层：试点阶段只用测试数据
// 用 Node 24 自带的 node:sqlite，不再依赖 better-sqlite3（免编译，npm ci 纯 JS）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// 数据库文件名：环境变量可覆盖，默认 xiaohe.sqlite（备份脚本用同样规则解析，保持一致）
const DB_FILE = process.env.XH_DB_FILE || 'xiaohe.sqlite';
// 时间约定（2026-10-01 修）：所有时间列统一存 UTC（datetime('now')）。
// 正式库旧表的默认值本来就是 UTC，混用北京时间会出错。
// 北京时间只用于：两天制日期判断（shanghaiDay()）、日志时间戳、备份文件名。
const db = new DatabaseSync(path.join(dataDir, DB_FILE));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  lesson_id  TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS readings (
  reading_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body_en    TEXT NOT NULL,
  audio_id   TEXT,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS items (
  item_id      TEXT PRIMARY KEY,   -- 例: u2r1-v1-q03, 修订必须换新 id
  lesson_id    TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  step_no      INTEGER NOT NULL,   -- 课内顺序
  kind         TEXT NOT NULL,      -- teach | mcq | short
  prompt       TEXT NOT NULL,
  options_json TEXT,               -- mcq: 4 个选项的 JSON 数组
  answer       TEXT,               -- mcq: 'A'|'B'|'C'|'D'; short: 关键词
  answer_pos   INTEGER,            -- mcq: 正确答案下标 0..3
  audio_id     TEXT,
  skill        TEXT,               -- 考查的能力, 如 notice-update
  reading_id   TEXT,
  teach_html   TEXT,               -- teach 步骤的讲解内容(已转义的安全 HTML)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL,
  helped       INTEGER NOT NULL DEFAULT 0,  -- 1=用过"老师教我"
  correct      INTEGER NOT NULL,             -- 1=答对
  answer_given TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

module.exports = db;

// ---- 轻量迁移（试点期，可直接补列） ----
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn('attempts', 'verdict', "TEXT DEFAULT 'wrong'"); // correct|typo|chinese|wrong|correct_retry|wrong_retry
ensureColumn('attempts', 'detail_json', 'TEXT');              // 逐项判分明细
ensureColumn('attempts', 'session_id', "TEXT DEFAULT ''");     // 同一次走课的会话 id（重答判定用）
ensureColumn('attempts', 'independent', 'INTEGER DEFAULT 0');  // 1=独立完成（练习：答对且无帮助；验证：首次答对）
ensureColumn('attempts', 'elapsed_ms', 'INTEGER');             // 本次作答用时（毫秒）：从题目出现到提交
ensureColumn('items', 'grading_json', 'TEXT');                // 简答题判分规格
ensureColumn('items', 'phase', "TEXT DEFAULT 'practice'");     // practice|validate|teach
db.exec(`
CREATE TABLE IF NOT EXISTS help_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
ensureColumn('help_events', 'session_id', "TEXT DEFAULT ''");
ensureColumn('help_events', 'level', 'INTEGER DEFAULT 1'); // 三级提示（2026-10-02）：1 指方向，2 高亮原句，3 给答案讲原因
// 课程进度（服务端记录，防重做）：单课单行；p1_started_day 为上海自然日 YYYY-MM-DD
db.exec(`
CREATE TABLE IF NOT EXISTS lesson_state (
  lesson_id      TEXT PRIMARY KEY,
  p1_started_day TEXT,
  p1_done        INTEGER NOT NULL DEFAULT 0,
  p2_done        INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// 续课进度（服务端落盘，按题目ID记录，不按序号；动态插入的复习题不影响续课位置）
// 旧版浏览器 localStorage（pos 序号）首次打开时自动迁移到这里，之后以服务端为准
db.exec(`
CREATE TABLE IF NOT EXISTS progress (
  lesson_id  TEXT NOT NULL,
  part       INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lesson_id, part)
);`);
// 弱点事件：如下节课要复习的"英文书写"
db.exec(`
CREATE TABLE IF NOT EXISTS weakness_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// 复测队列表（2026-10-03）：copied/看答案过 → 待复测 → 下次学习自动出同一知识点换材料复测题
// 零帮助独立答对才算解决。h 上线前的历史"看答案过"记录从 weakness_events 回填。
db.exec(`
CREATE TABLE IF NOT EXISTS retest_queue (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          TEXT NOT NULL,  -- 原题
  knowledge_point  TEXT NOT NULL,  -- 知识点维度（如 time/src），历史记录可能为通用标记
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|resolved
  source_session   TEXT NOT NULL DEFAULT '',
  variant_item_id  TEXT,           -- 复测用的题（换材料，P1 内容储备后填充）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT
);`);
// 客户端错误日志表（2026-10-03 k包）
db.exec(`
CREATE TABLE IF NOT EXISTS client_errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message    TEXT,
  source     TEXT,
  lineno     INTEGER,
  colno      INTEGER,
  stack      TEXT,
  url        TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// 摸底诊断（2026-10-03 P2）：广播站"新人能力检测"
// 3段×15-20分钟，自适应（连错3停），两套平行卷A/B
db.exec(`
CREATE TABLE IF NOT EXISTS diagnostic_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form       TEXT NOT NULL,  -- A|B
  section    INTEGER NOT NULL,  -- 1|2|3
  status     TEXT NOT NULL DEFAULT 'active',  -- active|completed|abandoned
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);`);
db.exec(`
CREATE TABLE IF NOT EXISTS diagnostic_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL,
  knowledge_point TEXT NOT NULL,  -- 知识点ID，如 vocab-l3, phonics, grammar-tense
  category        TEXT NOT NULL,  -- 单词量|拼读|语法|阅读|听力|写作|朗读
  status          TEXT NOT NULL,  -- 会了|不稳|不会|没测到
  correct         INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES diagnostic_sessions(id)
);`);
// 诊断作答明细（2026-10-03 P2）：每次提交记一条，verdict=correct|wrong|gave_up
db.exec(`
CREATE TABLE IF NOT EXISTS diagnostic_answers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL,
  step            INTEGER NOT NULL,
  knowledge_point TEXT,
  category        TEXT,
  verdict         TEXT NOT NULL,  -- correct|wrong|gave_up|not_tested
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES diagnostic_sessions(id)
);`);
// 知识点掌握追踪（2026-10-03 P2）：没学|学过|会了|牢固
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_mastery (
  knowledge_point TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT '没学',  -- 没学|学过|会了|牢固
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// 故事选择持久化（2026-10-02 总指挥补充条款）：广播站剧情里学生的选择（如选哪首歌），
// 后续课程用 {{choice:key|默认文本}} 占位回调。单课单 key 单行，重复选直接覆盖。
db.exec(`
CREATE TABLE IF NOT EXISTS story_choices (
  lesson_id  TEXT NOT NULL,
  choice_key TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lesson_id, choice_key)
);`);
