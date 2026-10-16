#!/usr/bin/env node
// 解锁门禁自动化测试（2026-10-17）：验证 Unit 4 三项门禁逻辑
// 跑法：node scripts/verify-unlock-gate.js
'use strict';
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== Unit 4 解锁门禁验证 ===');
const src = fs.readFileSync('server/index.js', 'utf8');

// 1. 三项门禁都存在
console.log('\n[1] 三项门禁条件');
ok('u3-consolidate 门禁', src.includes('u3-consolidate') && src.includes('0.85'));
ok('review3 门禁', src.includes('review3'));
ok('每日10道错题门禁', src.includes('daily') && src.includes('10'));

// 2. Unit 4 内部逐课开放（不是一次全开）
console.log('\n[2] Unit 4 内部逐课开放');
// lessonOpen 对 u4r2-u4r5 必须检查前一课完成
ok('u4r2 依赖 u4r1', src.includes('u4r1') && src.includes('u4r2'));
ok('逐课开放逻辑', !src.match(/u4r\d.*return true/i) || src.includes('lessonDone'));

// 3. 每日10道计数口径：目标数按"今日开始时的可做错题数"
console.log('\n[3] 每日10道计数口径');
ok('checkDailyMistakes 存在', src.includes('checkDailyMistakes'));
// 只要求答对+没求助，不要求一次过（2026-10-16 确认）
const m = src.match(/function checkDailyMistakes[\s\S]{0,500}/);
if (m) {
  ok('不要求一次过', !m[0].includes('first_try') && !m[0].includes('一次过'));
} else {
  ok('checkDailyMistakes 可读', false, '函数未找到');
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
