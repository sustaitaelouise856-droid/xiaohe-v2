'use strict';
// 简答题判分引擎测试：等价写法、拼写容错、旧信息矛盾、中文提示、多关键词逐项记录
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeShort } = require('../server/grade.js');

const TIME_9AM = { expects: [{ id: 'time', type: 'time', hour: 9, minute: 0, meridiem: 'am', old: { hour: 8, minute: 30, meridiem: 'am' } }] };
const DATE_OCT11 = { expects: [{ id: 'date', type: 'date', month: 10, day: 11, old: { month: 10, day: 10 } }] };
const WORD_STADIUM = { expects: [{ id: 'place', type: 'word', answers: ['stadium'], olds: ['playground'], cn: ['体育场'], cn_old: ['操场'] }] };
const MULTI = {
  expects: [
    { id: 'day', type: 'word', answers: ['sunday'], olds: ['saturday'], cn: ['星期天', '周日'], cn_old: ['星期六'] },
    { id: 'date', type: 'date', month: 10, day: 11, old: { month: 10, day: 10 }, cn: ['10月11日', '十月十一日'], cn_old: ['10月10日'] },
    { id: 'time', type: 'time', hour: 9, minute: 0, meridiem: 'am', old: { hour: 8, minute: 30, meridiem: 'am' }, cn: ['上午9点', '早上9点', '9点'], cn_old: ['8点半', '上午8点半'] },
  ],
};

test('时间等价写法都算对', () => {
  for (const a of ['9:00', '9:00 a.m.', '9:00 am', '9 a.m.', '9am', "nine o'clock", 'Nine O\'Clock']) {
    const g = gradeShort(a, TIME_9AM);
    assert.equal(g.verdict, 'correct', `应接受: ${a}`);
  }
});

test('half past four 算对', () => {
  const spec = { expects: [{ id: 'time', type: 'time', hour: 4, minute: 30, meridiem: 'pm' }] };
  for (const a of ['4:30', '4:30 p.m.', 'half past four']) {
    assert.equal(gradeShort(a, spec).verdict, 'correct', `应接受: ${a}`);
  }
});

test('时间上下午写错判错', () => {
  assert.equal(gradeShort('9:00 p.m.', TIME_9AM).verdict, 'wrong');
});

test('日期等价写法都算对', () => {
  for (const a of ['October 11', 'Oct. 11', 'Oct 11', 'October 11th', '11 October', '11th October']) {
    assert.equal(gradeShort(a, DATE_OCT11).verdict, 'correct', `应接受: ${a}`);
  }
});

test('大小写标点空格不影响', () => {
  assert.equal(gradeShort('  STADIUM!!! ', WORD_STADIUM).verdict, 'correct');
  assert.equal(gradeShort('The city  stadium.', WORD_STADIUM).verdict, 'correct');
});

test('完整句子作答能识别', () => {
  const g = gradeShort('The sports day is in the city stadium.', WORD_STADIUM);
  assert.equal(g.verdict, 'correct');
  const g2 = gradeShort('It is Sunday, October 11 at 9:00 a.m.', MULTI);
  assert.equal(g2.verdict, 'correct');
});

test('小拼写错误判为内容对拼写错', () => {
  const g = gradeShort('stadiam', WORD_STADIUM);
  assert.equal(g.verdict, 'typo');
  assert.ok(g.note.includes('stadiam') && g.note.includes('stadium'));
  const g2 = gradeShort('Saturdy', { expects: [{ id: 'day', type: 'word', answers: ['saturday'] }] });
  assert.equal(g2.verdict, 'typo');
});

test('新旧信息混写判错', () => {
  const g = gradeShort('playground and stadium', WORD_STADIUM);
  assert.equal(g.verdict, 'wrong');
  assert.ok(g.note.includes('旧信息'));
  const g2 = gradeShort('Sunday, October 10, 9:00 a.m.', MULTI);
  assert.equal(g2.verdict, 'wrong');
  const dateItem = g2.items.find(i => i.id === 'date');
  assert.equal(dateItem.status, 'contradiction');
});

test('只写旧信息判错', () => {
  assert.equal(gradeShort('playground', WORD_STADIUM).verdict, 'wrong');
  assert.equal(gradeShort('October 10', DATE_OCT11).verdict, 'wrong');
});

test('中文答对提示用英文重写', () => {
  const g = gradeShort('体育场', WORD_STADIUM);
  assert.equal(g.verdict, 'chinese');
  assert.ok(g.note.includes('英文'));
});

test('多关键词逐项记录缺失', () => {
  const g = gradeShort('Sunday 9:00', MULTI);
  assert.equal(g.verdict, 'wrong');
  const byId = Object.fromEntries(g.items.map(i => [i.id, i.status]));
  assert.equal(byId.day, 'ok');
  assert.equal(byId.date, 'missing');
  assert.equal(byId.time, 'ok');
});

test('多关键词全对', () => {
  const g = gradeShort('sunday october 11 9:00 a.m.', MULTI);
  assert.equal(g.verdict, 'correct');
  assert.ok(g.items.every(i => i.status === 'ok'));
});

test('空答案和无关答案判错', () => {
  assert.equal(gradeShort('', WORD_STADIUM).verdict, 'wrong');
  assert.equal(gradeShort('I don\'t know', WORD_STADIUM).verdict, 'wrong');
});

test('数字地点 302 精确匹配', () => {
  const spec = { expects: [{ id: 'place', type: 'word', answers: ['302'], cn: ['302教室', '302'] }] };
  assert.equal(gradeShort('Classroom 302', spec).verdict, 'correct');
  assert.equal(gradeShort('302', spec).verdict, 'correct');
  assert.equal(gradeShort('303', spec).verdict, 'wrong'); // 数字不做拼写容错
});

test('判分宽容边界：写成另一个星期是选错值，不是拼写小错（2026-10-02）', () => {
  const spec = { expects: [{ id: 'day', type: 'word', answers: ['sunday'], olds: ['saturday'] }] };
  // Monday 离 Sunday 编辑距离 2，但它是另一个值，必须判错，不能判 typo 蒙混
  assert.equal(gradeShort('The book sale is on Monday.', spec).verdict, 'wrong');
  assert.equal(gradeShort('on monday', spec).verdict, 'wrong');
  // 真拼写小错仍判 typo
  assert.equal(gradeShort('on Suday', spec).verdict, 'typo');
  assert.equal(gradeShort('on Sunay', spec).verdict, 'typo');
});

test('判分宽容：3 个字母的关键词拼错一处也判 typo', () => {
  const spec = { expects: [{ id: 'u1', type: 'word', answers: ['day'] }] };
  assert.equal(gradeShort('dey', spec).verdict, 'typo');
});

test('拼写容错不跨首字母：框架词不能被当成答案词的拼写小错（2026-10-02 g 版）', () => {
  // 真实事故：u2r3 s18 "It went up 50% from September." 里 went 被当成 twenty 的拼写小错，
  // 50% 写成 20% 的值错误被判成"拼写需注意"算对。首字母不同直接排除。
  const spec = { expects: [{ id: 'dirpct', type: 'word',
    answers: ['up 20', 'up twenty'], olds: ['down 20', 'up 10'] }] };
  assert.equal(gradeShort('It went up 50% from September.', spec).verdict, 'wrong');
  assert.equal(gradeShort('It went up 20% from September.', spec).verdict, 'correct');
  // 首字母相同的真拼写小错仍放行
  assert.equal(gradeShort('It went up twonty percent.', spec).verdict, 'typo');
});

test('中文时间上午/下午冲突判错（h 版 BLOCK-C）', () => {
  const spec = { expects: [
    { id: 'time', type: 'time', hour: 7, minute: 0, meridiem: 'pm', cn: ['7点', '晚上7点', '七点'] },
    { id: 'src', type: 'word', answers: ['second', '2'], cn: ['第二张'] },
  ] };
  // 上午7点 vs 晚上7点：冲突 → wrong，不能是 chinese/correct
  const bad = gradeShort('上午7点第2张通知', spec);
  assert.equal(bad.verdict, 'wrong');
  assert.equal(bad.items[0].status, 'contradiction');
  assert.equal(bad.items[0].conflict.kind, 'meridiem');
  // 晚上7点 → chinese（意思对，提示用英文重写）
  assert.equal(gradeShort('晚上7点第二张通知', spec).verdict, 'chinese');
  // 七点（没写上午/下午，不冲突）→ chinese，不断然判错
  assert.equal(gradeShort('七点第二张', spec).verdict, 'chinese');
  // 英文 7 pm 2 → correct
  assert.equal(gradeShort('7 pm 2', spec).verdict, 'correct');
  // 英文 am 写反 → wrong（已有多年行为，保持）
  assert.equal(gradeShort('7 am 2', spec).verdict, 'wrong');
});

test('中文星期写错判错，星期天能识别', () => {
  const spec = { expects: [{ id: 'day', type: 'word', answers: ['sunday'], olds: ['saturday'], cn: ['周日', '星期日'], cn_old: ['周六'] }] };
  assert.equal(gradeShort('周日', spec).verdict, 'chinese');
  assert.equal(gradeShort('星期天', spec).verdict, 'chinese'); // 不在 cn 表里也能识别
  const bad = gradeShort('周一', spec);
  assert.equal(bad.verdict, 'wrong');
  assert.equal(bad.items[0].conflict.kind, 'weekday');
  assert.equal(gradeShort('周六', spec).verdict, 'wrong'); // 旧值
});

test('中文数字精确匹配，不用包含判断', () => {
  const spec = { expects: [{ id: 'total', type: 'word', answers: ['2740'], cn: ['2740', '两千七百四十'] }] };
  assert.equal(gradeShort('2740', spec).verdict, 'correct'); // 纯数字走英文路径
  assert.equal(gradeShort('共2740本', spec).verdict, 'chinese'); // 含中文 → 意思对，提示用英文重写
  assert.equal(gradeShort('两千七百四十', spec).verdict, 'chinese');
  assert.equal(gradeShort('27400', spec).verdict, 'wrong'); // 包含"2740"也不能算对
  assert.equal(gradeShort('共27400本', spec).verdict, 'wrong');
});

test('数学等价形式判分：因式分解', () => {
  const spec = { expects: [{ id: 'f', type: 'math', answers: ['4(a+2)'] }] };
  const ok = [
    '4(a+2)', '4 (a + 2)', '(a+2)*4', '(a+2)×4', '4（a+2）', '4·(a+2)',
  ];
  for (const a of ok) {
    assert.equal(gradeShort(a, spec).verdict, 'correct', `应接受: ${a}`);
  }
  const bad = ['4(a+8)', '4(a+2)+1', '2(2a+4)', 'a(4+8)', '不知道', '4a+8', ''];
  for (const a of bad) {
    assert.equal(gradeShort(a, spec).verdict, 'wrong', `应判错: ${a || '(空)'}`);
  }
});

test('数学等价形式判分：数字 1/2 = 0.5', () => {
  const spec = { expects: [{ id: 'n', type: 'math', answers: ['1/2'] }] };
  for (const a of ['1/2', '0.5', '0.50', ' 1 / 2 ']) {
    assert.equal(gradeShort(a, spec).verdict, 'correct', `应接受: ${a}`);
  }
  for (const a of ['1/3', '0.6', '2/1']) {
    assert.equal(gradeShort(a, spec).verdict, 'wrong', `应判错: ${a}`);
  }
});

test('数学：减法不交换，提不干净判错', () => {
  const spec = { expects: [{ id: 'f', type: 'math', answers: ['a(a-5)'] }] };
  assert.equal(gradeShort('a(a-5)', spec).verdict, 'correct');
  assert.equal(gradeShort('(a-5)a', spec).verdict, 'correct'); // 乘法可交换
  assert.equal(gradeShort('a(5-a)', spec).verdict, 'wrong'); // 减法不可交换
  const spec2 = { expects: [{ id: 'f', type: 'math', answers: ['4(x+3)'] }] };
  assert.equal(gradeShort('2(2x+6)', spec2).verdict, 'wrong'); // 提不干净
});

test('数学：加法项可交换', () => {
  const spec = { expects: [{ id: 'f', type: 'math', answers: ['x+2'] }] };
  assert.equal(gradeShort('2+x', spec).verdict, 'correct');
});

test('数学：多项式项序不同算对（符号跟项走）', () => {
  const spec = { expects: [{ id: 'f', type: 'math', answers: ['x^2-10x+25'] }] };
  for (const a of ['x^2-10x+25', '25-10x+x^2', 'x^2+25-10x']) {
    assert.equal(gradeShort(a, spec).verdict, 'correct', `应接受: ${a}`);
  }
  for (const a of ['x^2+10x+25', 'x^2-10x-25', '10x-x^2-25']) {
    assert.equal(gradeShort(a, spec).verdict, 'wrong', `应判错: ${a}`);
  }
});
