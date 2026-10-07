'use strict';
// 访问保护：一次性设置口令 + 访问码哈希 + 签名 Cookie + 限速
// 口令/访问码/密钥只存哈希或随机值，绝不写代码、不进日志文件。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const SETUP_TOKEN_BYTES = 16;          // 一次性设置口令：16 字节随机
const CODE_MIN_LEN = 6;                // 访问码最短 6 位
const COOKIE_NAME = 'xh_auth';
const COOKIE_MAX_AGE_MS = 180 * 24 * 3600 * 1000; // 验证一次记住 180 天（Elouise 2026-10-02）
const VERIFY_LIMIT = 5;                // 10 分钟内最多试 5 次
const VERIFY_WINDOW_MS = 10 * 60 * 1000;

function getState(k) {
  const r = db.prepare('SELECT value FROM app_state WHERE key=?').get(k);
  return r ? r.value : null;
}
function setState(k, v) {
  db.prepare(
    'INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(k, v);
}
function delState(k) { db.prepare('DELETE FROM app_state WHERE key=?').run(k); }

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---- 访问码：scrypt 加盐哈希，只存哈希 ----
function hashAccessCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(code, salt, 32).toString('hex');
  return `salt:${salt}:hash:${h}`;
}
function checkAccessCode(code, stored) {
  const m = /^salt:([0-9a-f]+):hash:([0-9a-f]+)$/.exec(stored || '');
  if (!m) return false;
  const calc = crypto.scryptSync(code, m[1], 32);
  const want = Buffer.from(m[2], 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

// ---- Cookie 签名密钥：落盘持久化，更新/重启服务不失效（Elouise 2026-10-02）----
// 密钥存 data/cookie_secret 文件（0600）；进程内缓存，轮换时同步更新。
// 兼容老部署：密钥原来只存数据库 app_state——文件缺失时先读库里的值写成文件，
// 保证已签发的老 Cookie 继续有效。只有改访问码时轮换密钥，老 Cookie 才失效。
function dataDir() {
  const d = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function secretFile() { return path.join(dataDir(), 'cookie_secret'); }
let _secretCache = null;
function getCookieSecret() {
  if (_secretCache) return _secretCache;
  try {
    const s = fs.readFileSync(secretFile(), 'utf8').trim();
    if (s) { _secretCache = s; return s; }
  } catch { /* 文件还没有，往下走 */ }
  const fromDb = getState('cookie_secret');
  if (fromDb) { // 老部署迁移：库里的密钥落盘，老 Cookie 不作废
    try { fs.writeFileSync(secretFile(), fromDb, { mode: 0o600 }); } catch { /* 写不成也能用 */ }
    _secretCache = fromDb;
    return fromDb;
  }
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(secretFile(), s, { mode: 0o600 }); }
  catch { setState('cookie_secret', s); } // 落盘失败时退回存库，至少本进程可用
  _secretCache = s;
  return s;
}
// 轮换密钥：改访问码时调用，之后老 Cookie 一律验不过
function rotateCookieSecret() {
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(secretFile(), s, { mode: 0o600 }); } catch { /* 退回存库 */ }
  setState('cookie_secret', s);
  _secretCache = s;
  return s;
}
// 改访问码：换码哈希 + 轮换签名密钥（老 Cookie 失效）
function changeAccessCode(newCode) {
  setState('access_code_hash', hashAccessCode(String(newCode)));
  rotateCookieSecret();
}

function signCookie(expiry) {
  const payload = `v1:${expiry}`;
  const sig = crypto.createHmac('sha256', getCookieSecret()).update(payload).digest();
  return `${Buffer.from(payload).toString('base64url')}.${sig.toString('base64url')}`;
}

function verifyCookie(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  let payload, sig;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    sig = Buffer.from(parts[1], 'base64url').toString('hex');
  } catch { return false; }
  const expect = crypto.createHmac('sha256', getCookieSecret()).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expect, 'hex'))) return false;
  const m = /^v1:(\d+)$/.exec(payload);
  return !!m && Number(m[1]) > Date.now();
}

// ---- 一次性设置口令：只存哈希；成功设置后立即作废 ----
function ensureSetupToken() {
  if (getState('setup_done') === '1') return null;
  if (getState('setup_token_hash')) return null; // 已生成过，不重复发放
  const token = crypto.randomBytes(SETUP_TOKEN_BYTES).toString('hex');
  setState('setup_token_hash', sha256hex(token));
  return token; // 调用方只在启动控制台打印一次
}

function trySetup(setupToken, accessCode) {
  if (getState('setup_done') === '1') return { ok: false, reason: 'already_setup' };
  const hash = getState('setup_token_hash');
  if (!hash || !setupToken || sha256hex(String(setupToken)) !== hash) {
    return { ok: false, reason: 'bad_token' };
  }
  if (!accessCode || String(accessCode).length < CODE_MIN_LEN) {
    return { ok: false, reason: 'weak_code' };
  }
  setState('access_code_hash', hashAccessCode(String(accessCode)));
  setState('setup_done', '1');
  delState('setup_token_hash'); // 作废，一次性口令失效
  return { ok: true };
}

function isSetupDone() { return getState('setup_done') === '1'; }

function checkVerifyCode(accessCode) {
  const stored = getState('access_code_hash');
  if (!stored || !accessCode) return false;
  return checkAccessCode(String(accessCode), stored);
}

// ---- 校验接口限速：防暴力猜 ----
const attempts = new Map(); // ip -> {count, resetAt}
function verifyRateLimited(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + VERIFY_WINDOW_MS });
    return false;
  }
  e.count += 1;
  return e.count > VERIFY_LIMIT;
}
function verifyRateReset(ip) { attempts.delete(ip); }

// ---- 中间件与 Cookie ----
function getCookieValue(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const found = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!found) return null;
  try { return decodeURIComponent(found.slice(COOKIE_NAME.length + 1)); }
  catch { return null; }
}

function requireAuth(req, res, next) {
  if (verifyCookie(getCookieValue(req))) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

function issueAuthCookie(res) {
  const expiry = Date.now() + COOKIE_MAX_AGE_MS;
  const val = signCookie(expiry);
  // COOKIE_SECURE=1 时加 Secure（生产走 HTTPS 时用；本机 HTTP 测试保持关闭）
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`
  );
}

module.exports = {
  ensureSetupToken,
  trySetup,
  isSetupDone,
  checkVerifyCode,
  changeAccessCode,
  rotateCookieSecret,
  verifyRateLimited,
  verifyRateReset,
  requireAuth,
  issueAuthCookie,
  verifyCookie,
  getCookieValue,
  COOKIE_NAME,
  CODE_MIN_LEN,
};
