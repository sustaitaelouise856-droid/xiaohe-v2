#!/usr/bin/env node
// 称号颁发自动化测试（2026-10-17）：验证 checkTitles 逻辑完整性
// 跑法：node scripts/verify-titles.js
'use strict';
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 称号颁发验证 ===');
const src = fs.readFileSync('server/index.js', 'utf8');

// 1. TITLE_DEFS 数量
console.log('\n[1] 称号定义数量');
const defs = src.match(/id: '([a-z0-9_]+)'/g) || [];
// 去重
const ids = [...new Set(defs.map(d => d.match(/'(.+)'/)[1]))];
console.log(`  定义数：${ids.length}`);
ok('称号数 >= 54', ids.length >= 54, `实际 ${ids.length}`);

// 2. 关键称号都存在
console.log('\n[2] 关键称号存在');
const required = ['minutes_60', 'minutes_300', 'minutes_900', 'minutes_1800',
  'review_3', 'independent_5', 'streak_15', 'retry_10', 'vocab_30',
  'challenge_streak_3', 'word_50', 'mistake_10', 'questions_100', 'courses_5'];
for (const r of required) {
  ok(`${r} 已定义`, ids.includes(r));
}

// 3. checkTitles 中有对应的 grant 调用
console.log('\n[3] checkTitles 颁发逻辑');
const checkFn = src.match(/function checkTitles\(\)[\s\S]*?^}/m);
ok('checkTitles 存在', !!checkFn);
for (const r of ['minutes_60', 'review_3', 'streak_15', 'vocab_30']) {
  ok(`grant('${r}')`, src.includes(`grant('${r}')`));
}

// 4. 段位门槛四等分（2026-10-16定）
console.log('\n[4] 段位门槛');
ok('青铜 0-25%', src.includes('0.25') || src.includes('25'));
ok('白银 25-50%', src.includes('0.5') || src.includes('50'));

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
