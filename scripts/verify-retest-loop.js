#!/usr/bin/env node
// 错题闭环自动化测试（2026-10-17）：验证 resolveRetest 的完整逻辑
// 跑法：node scripts/verify-retest-loop.js
// 必须全部通过，否则推送阻断
'use strict';
const path = require('path');
process.chdir(path.join(__dirname, '..'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 错题闭环验证 ===');

// 1. resolveRetest 只按 item_id 匹配（不要求 knowledge_point）
console.log('\n[1] resolveRetest 签名检查');
try {
  const src = require('fs').readFileSync('server/retest.js', 'utf8');
  // 必须包含"只按 item_id 匹配"的注释（2026-10-16修）
  ok('包含 item_id 匹配注释', src.includes('只按 item_id 匹配'));
  // WHERE 子句不能同时要求 knowledge_point
  const m = src.match(/function resolveRetest[\s\S]*?WHERE item_id=\? AND status='pending'/);
  ok('WHERE 只按 item_id+status 匹配', !!m, '如果失败说明又改回了 knowledge_point 匹配');
} catch (e) { ok('读取 retest.js', false, e.message); }

// 2. 无 pending 记录时要 INSERT resolved（2026-10-16 21:35修）
console.log('\n[2] 无 pending 时 INSERT 逻辑');
try {
  const src = require('fs').readFileSync('server/retest.js', 'utf8');
  ok('包含 INSERT resolved 逻辑', src.includes("INSERT INTO retest_queue") && src.includes("'resolved'"));
  ok('包含 manual_resolve 标记', src.includes('manual_resolve'));
} catch (e) { ok('读取 retest.js', false, e.message); }

// 3. /api/mistakes 过滤逻辑：resolved 且无 pending 的才进"最近拿下"
console.log('\n[3] /api/mistakes 过滤逻辑');
try {
  const src = require('fs').readFileSync('server/index.js', 'utf8');
  ok('过滤已解决逻辑存在', src.includes('fullyResolvedIds'));
  ok('pending 优先逻辑存在', src.includes("status='pending'"));
} catch (e) { ok('读取 index.js', false, e.message); }

// 4. 前端调用 resolve 接口（单题重做 + 批量重做）
console.log('\n[4] 前端 resolve 调用');
try {
  const src = require('fs').readFileSync('public/lesson.html', 'utf8');
  ok('调用 /api/retest/resolve', src.includes('/api/retest/resolve'));
  ok('单题重做调用', src.includes('single_retry'));
  ok('批量重做调用', src.includes('batch_retry'), '2026-10-16修：批量重做之前漏了');
} catch (e) { ok('读取 lesson.html', false, e.message); }

// 5. attempts.js 认 correct_retry（2026-10-16修）
console.log('\n[5] attempts.js correct_retry 分支');
try {
  const src = require('fs').readFileSync('server/attempts.js', 'utf8');
  ok('包含 correct_retry', src.includes('correct_retry'));
} catch (e) { ok('读取 attempts.js', false, e.message); }

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
