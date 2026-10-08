'use strict';
// 简答题判分引擎
// 支持：等价写法（时间/日期多种形式）、大小写标点不敏感、整句作答、
// 小拼写错误→"内容对拼写错"、中新旧信息混写→判错、中文作答→提示用英文重写、
// 多关键词题逐项记录（哪项对/哪项缺失）。

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_ABBR = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const HOUR_WORDS = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,;!?'"“”‘’()\[\]{}<>_~*^$#@+=|\\\/?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 值词集合：星期/月份这类"写错了就是换了个值"的词。孩子写出另一个值词（如该写 Sunday 写成 Monday）
// 是选错值，不是拼写小错，不能靠编辑距离判成 typo 蒙混过关（2026-10-02 判分宽容的边界）。
const VALUE_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ...Object.keys(MONTHS), ...Object.keys(MONTH_ABBR),
]);

// ---- 中文结构化抽取（h 版）：时间/星期/数字逐项比对，不用"包含"判断 ----
// "上午7点"对"晚上7点"、"周一"对"周日"、"27400"对"2740"这类冲突必须判错。
const CN_DIGIT = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,两:2,零:0,〇:0};
const CN_UNIT = {十:10,百:100,千:1000,万:10000,亿:100000000};
function cnNumberToInt(s) {
  let total = 0, section = 0, num = 0, hasNum = false, ok = false;
  for (const ch of String(s)) {
    if (CN_DIGIT[ch] !== undefined) { num = CN_DIGIT[ch]; hasNum = true; ok = true; }
    else if (CN_UNIT[ch] !== undefined) {
      const u = CN_UNIT[ch];
      if (u === 10 && !hasNum) num = 1;
      if (u >= 10000) { total += (section + num) * u; section = 0; }
      else section += num * u;
      num = 0; hasNum = false; ok = true;
    } else return NaN;
  }
  return ok ? total + section + num : NaN;
}
const CN_MERIDIEM = {上午:'am',早上:'am',凌晨:'am',中午:'pm',下午:'pm',晚上:'pm',夜里:'pm',半夜:'pm'};
// 中文时间：上午7点 / 晚上7点半 / 七点四十五分
function extractCnTimes(raw) {
  const out = [];
  const re = /(上午|中午|下午|晚上|早上|凌晨|夜里|半夜)?\s*([0-9]+|[一二三四五六七八九十两零〇百千万亿]+)\s*[点時时](?:\s*(半)|([0-9]+|[一二三四五六七八九十两零〇]+)\s*分)?/g;
  let m;
  while ((m = re.exec(raw))) {
    const hs = m[2];
    const h = /^[0-9]+$/.test(hs) ? parseInt(hs, 10) : cnNumberToInt(hs);
    if (!h || h < 1 || h > 12 || isNaN(h)) continue;
    let minute = 0;
    if (m[3]) minute = 30;
    else if (m[4]) {
      const ms = m[4];
      const mm = /^[0-9]+$/.test(ms) ? parseInt(ms, 10) : cnNumberToInt(ms);
      if (!isNaN(mm) && mm >= 0 && mm < 60) minute = mm;
    }
    out.push({ h, m: minute, mer: m[1] ? CN_MERIDIEM[m[1]] : null, merRaw: m[1] || '' });
  }
  return out;
}
const CN_WEEKDAY = {一:'monday',二:'tuesday',三:'wednesday',四:'thursday',五:'friday',六:'saturday',日:'sunday',天:'sunday'};
const EN_WEEKDAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
function extractCnWeekdays(raw) {
  const out = [];
  const re = /(?:星期|周|礼拜)([一二三四五六日天])|周([1-7])/g;
  let m;
  while ((m = re.exec(raw))) {
    const c = m[1] || m[2];
    if (CN_WEEKDAY[c]) out.push(CN_WEEKDAY[c]);
    else if (/^[1-7]$/.test(c)) out.push(EN_WEEKDAYS[+c - 1]);
  }
  return out;
}
// 中文数字：阿拉伯数字（含千分位）+ 中文数字
function extractCnNumbers(raw) {
  const out = [];
  const work = String(raw).replace(/\d[\d,]*/g, m => { out.push(parseInt(m.replace(/,/g, ''), 10)); return ' '; });
  const re = /[一二三四五六七八九十两零〇百千万亿]+/g;
  let m;
  while ((m = re.exec(work))) {
    if (!/[一二三四五六七八九两]/.test(m[0])) continue; // 纯单位（如"百"）跳过
    const v = cnNumberToInt(m[0]);
    if (!isNaN(v)) out.push(v);
  }
  return out;
}
function wordsToNumber(s) {
  let total = 0, cur = 0;
  for (const w of String(s).toLowerCase().split(/\s+/)) {
    if (NUM_WORDS[w] !== undefined) cur += NUM_WORDS[w];
    else if (w === 'hundred') cur *= 100;
    else if (w === 'thousand') { total += cur * 1000; cur = 0; }
  }
  return total + cur;
}
function answerNumbers(list) {
  const out = [];
  for (const a of (list || [])) {
    const s = String(a).toLowerCase().replace(/[\s,]/g, '');
    if (/^\d+$/.test(s)) out.push(parseInt(s, 10));
    else { const v = wordsToNumber(String(a)); if (v) out.push(v); }
  }
  return out;
}
const WEEKDAY_SET = new Set(EN_WEEKDAYS);
function isWeekdayDim(e) {
  const a = (e.answers || []).map(x => String(x).toLowerCase());
  return a.length > 0 && a.every(x => WEEKDAY_SET.has(x));
}
function isNumberDim(e) {
  const a = (e.answers || []);
  if (!a.length) return false;
  return a.every(x => {
    const s = String(x).toLowerCase().replace(/[\s,]/g, '');
    if (/^\d+$/.test(s)) return true;
    return String(x).toLowerCase().split(/\s+/).every(w =>
      NUM_WORDS[w] !== undefined || ['hundred','thousand','and'].includes(w));
  });
}
function longestCnMatch(raw, list) {
  let best = '';
  for (const c of (list || [])) {
    const s = String(c);
    if (s && raw.includes(s) && s.length > best.length) best = s;
  }
  return best;
}
// 中文单项检查：返回 {hit, oldHit, conflict}
// conflict.kind: 'meridiem'（上午/下午写反）| 'weekday'（星期写错）
function checkItemChinese(raw, e) {
  const res = { hit: false, oldHit: false, conflict: null };
  const cn = e.cn || [], cnOld = e.cn_old || [];
  if (e.type === 'time') {
    const ts = extractCnTimes(raw);
    for (const t of ts) {
      const specMin = e.minute || 0;
      if (t.h === e.hour && t.m === specMin) {
        if (!t.mer || !e.meridiem || t.mer === e.meridiem) res.hit = true;
        else if (!res.conflict) res.conflict = { kind: 'meridiem', wrote: t.merRaw, want: e.meridiem };
      }
      if (e.old && t.h === e.old.hour && t.m === (e.old.minute || 0) &&
          (!t.mer || !e.old.meridiem || t.mer === e.old.meridiem)) res.oldHit = true;
    }
    if (!ts.length) {
      if (longestCnMatch(raw, cnOld)) res.oldHit = true;
      else if (longestCnMatch(raw, cn)) res.hit = true;
    }
    return res;
  }
  if (isWeekdayDim(e)) {
    const wds = extractCnWeekdays(raw);
    const ans = (e.answers || []).map(x => String(x).toLowerCase());
    const olds = (e.olds || []).map(x => String(x).toLowerCase());
    for (const wd of wds) {
      if (ans.includes(wd)) res.hit = true;
      else if (olds.includes(wd)) res.oldHit = true;
      else if (!res.conflict) res.conflict = { kind: 'weekday', wrote: wd };
    }
    if (!wds.length) {
      if (longestCnMatch(raw, cnOld)) res.oldHit = true;
      else if (longestCnMatch(raw, cn)) res.hit = true;
    }
    return res;
  }
  if (isNumberDim(e)) {
    const nums = extractCnNumbers(raw);
    const ansN = answerNumbers(e.answers), oldN = answerNumbers(e.olds);
    for (const n of nums) {
      if (ansN.includes(n)) res.hit = true;
      else if (oldN.includes(n)) res.oldHit = true;
    }
    return res;
  }
  // 其他（地点等）：最长匹配，旧优先
  if (longestCnMatch(raw, cnOld)) res.oldHit = true;
  else if (longestCnMatch(raw, cn)) res.hit = true;
  return res;
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- 数学表达式判分（数学课 type:'math'） ----
// 等价形式三层处理：
//  1. 字符归一：全角→半角、去空格、×·→*、²→^2；
//  2. 纯数字表达式求值比对（1/2 = 0.5）；
//  3. 纯乘积/纯加和的因子/项排序（3(x+2) = (x+2)*3，x+2 = 2+x）。
// 减法不参与排序（x-2 ≠ 2-x）；除法不参与排序。超出此范围的等价形式
// 由出题人在 answers 里显式列出（数据驱动，不在代码里猜）。
const MATH_FULL2HALF = {
  '（': '(', '）': ')', '×': '*', '·': '*', '⋅': '*', '＋': '+', '－': '-',
  '—': '-', '–': '-', '＝': '=', '。': '.', '，': ',', '：': ':', '；': ';', '　': ' ',
};
function normalizeMath(s) {
  return String(s || '')
    .replace(/[（）×·⋅＋－—–＝。，：；　]/g, ch => MATH_FULL2HALF[ch] || ch)
    .replace(/[²³]/g, ch => (ch === '²' ? '^2' : '^3'))
    .replace(/\s+/g, '')
    .toLowerCase();
}
function topLevelHas(t, chars) {
  let depth = 0;
  for (const ch of t) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && chars.includes(ch)) return true;
  }
  return false;
}
function splitTop(t, op) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of t) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === op && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}
function canonicalMath(s) {
  let t = normalizeMath(s);
  if (!t) return t;
  // 纯数字表达式：求值比对（1/2 = 0.5 = 0.50）
  if (/^[0-9+\-*/().]+$/.test(t) && /\d/.test(t)) {
    try {
      const v = Function('"use strict"; return (' + t + ')')();
      if (typeof v === 'number' && isFinite(v)) return 'num:' + (Math.round(v * 1e9) / 1e9);
    } catch (e) { /* 非法表达式，走字符串比对 */ }
  }
  // 省略乘号补齐：3(x+2) → 3*(x+2)，a(a-5) → a*(a-5)，(a-5)a → (a-5)*a
  t = t.replace(/(\d|[a-z]|\))\(/g, '$1*(').replace(/\)(\d|[a-z])/g, ')*$1');
  // 纯乘积：因子排序（乘法交换律，安全）
  if (topLevelHas(t, '*') && !topLevelHas(t, '+-/')) {
    return splitTop(t, '*').sort().join('*');
  }
  // 加和（含减号）：按"带符号项"切分再排序（x^2-10x+25 = 25-10x+x^2）。
  // 符号跟项走，减法不参与裸交换，安全；含顶层 * / 的不进此分支。
  if ((topLevelHas(t, '+') || topLevelHas(t, '-')) && !topLevelHas(t, '*/')) {
    const terms = [];
    let depth = 0, cur = '';
    for (const ch of t) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && (ch === '+' || ch === '-') && cur !== '') {
        terms.push(cur);
        cur = ch;
      } else cur += ch;
    }
    terms.push(cur);
    return terms.map(x => x.replace(/^\+/, '')).sort().join('+').replace(/\+\-/g, '-');
  }
  return t;
}
function checkMath(raw, spec) {
  const c = canonicalMath(raw);
  if (!c) return { status: 'missing', matched: null };
  const hit = (spec.answers || []).find(a => canonicalMath(a) === c);
  if (hit) return { status: 'ok', matched: hit };
  return { status: 'missing', matched: null };
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ---- 时间抽取：9:00 / 9:00 a.m. / 9 a.m. / nine o'clock / half past four / nine thirty ----
function extractTimes(norm) {
  const times = [];
  const W = HOUR_WORDS.join('|');
  const val = w => NUM_WORDS[w];
  const patterns = [
    { re: new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*([ap])\\s*m\\b`, 'g'), fn: m => ({ h: +m[1], m: +m[2], mer: m[3] === 'a' ? 'am' : 'pm' }) },
    { re: /\b(\d{1,2}):(\d{2})\b/g, fn: m => ({ h: +m[1], m: +m[2], mer: null }) },
    { re: new RegExp(`\\b(\\d{1,2})\\s*([ap])\\s*m\\b`, 'g'), fn: m => ({ h: +m[1], m: 0, mer: m[2] === 'a' ? 'am' : 'pm' }) },
    { re: new RegExp(`\\b(${W})\\s*o\\s*clock\\b`, 'g'), fn: m => ({ h: val(m[1]), m: 0, mer: null }) },
    { re: new RegExp(`\\bhalf\\s+past\\s+(${W})\\b`, 'g'), fn: m => ({ h: val(m[1]), m: 30, mer: null }) },
    { re: new RegExp(`\\b(${W})\\s+thirty\\b`, 'g'), fn: m => ({ h: val(m[1]), m: 30, mer: null }) },
  ];
  let work = ` ${norm} `;
  for (const p of patterns) {
    work = work.replace(p.re, (...args) => {
      const m = args; // [match, g1, g2, ..., offset, string]
      const t = p.fn(m);
      if (t.h >= 1 && t.h <= 12 && t.m >= 0 && t.m < 60) times.push(t);
      return ' '.repeat(m[0].length);
    });
  }
  return times;
}

function timeMatches(found, spec) {
  if (found.h !== spec.hour || found.m !== spec.minute) return false;
  if (found.mer && spec.meridiem && found.mer !== spec.meridiem) return false;
  return true;
}

// ---- 日期抽取：October 11 / Oct. 11 / October 11th / 11 October ----
function extractDates(norm) {
  const dates = [];
  const full = Object.keys(MONTHS).join('|');
  const abbr = Object.keys(MONTH_ABBR).join('|');
  const patterns = [
    { re: new RegExp(`\\b(${full})\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, 'g'), fn: m => ({ month: MONTHS[m[1]], day: +m[2] }) },
    { re: new RegExp(`\\b(${abbr})\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, 'g'), fn: m => ({ month: MONTH_ABBR[m[1]], day: +m[2] }) },
    { re: new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?\\s+(of\\s+)?(${full})\\b`, 'g'), fn: m => ({ month: MONTHS[m[4]], day: +m[1] }) },
  ];
  let work = ` ${norm} `;
  for (const p of patterns) {
    work = work.replace(p.re, (...args) => {
      const m = args;
      const d = p.fn(m);
      if (d.day >= 1 && d.day <= 31) dates.push(d);
      return ' '.repeat(m[0].length);
    });
  }
  return dates;
}

function dateMatches(found, spec) {
  return found.month === spec.month && found.day === spec.day;
}

// 单个词的拼写容错：在作答 token 里找与目标词编辑距离最小的一个
// 返回 {d, tok} 或 null（3–5 个字母容忍改 1 处，6 个以上容忍改 2 处；
// 作答 token 允许 2 个字母，如 "Sunny Da" 的 "da" 是 "day" 少写一个字母）
function fuzzyToken(norm, wl) {
  if (!/^[a-z]+$/.test(wl) || wl.length < 3) return null;
  let best = null;
  for (const tok of norm.split(' ')) {
    if (!/^[a-z]{2,}$/.test(tok)) continue;
    if (VALUE_WORDS.has(tok) && tok !== wl) continue; // 写的是另一个星期/月份 = 选错值
    if (tok[0] !== wl[0]) continue; // 首字母不同不是拼写小错（如 went vs twenty），直接排除
    const d = lev(tok, wl);
    const lim = wl.length <= 5 ? 1 : 2;
    if (d > 0 && d <= lim && (!best || d < best.d)) best = { d, tok };
  }
  return best;
}

// ---- 单项检查（英文路径） ----
function checkWord(norm, spec) {
  const hasNew = spec.answers.some(f => new RegExp(`\\b${escapeReg(f.toLowerCase())}\\b`).test(norm));
  const olds = spec.olds || [];
  const hasOld = olds.some(f => new RegExp(`\\b${escapeReg(f.toLowerCase())}\\b`).test(norm));
  if (hasNew && hasOld) return { status: 'contradiction', matched: null, note: 'new_and_old' };
  if (hasNew) return { status: 'ok', matched: spec.answers.find(f => new RegExp(`\\b${escapeReg(f.toLowerCase())}\\b`).test(norm)) };
  if (hasOld) return { status: 'contradiction', matched: null, note: 'old_only' };
  // 多词答案的拼写容错（如 "Sunny Day" 写成 "Sunny Da"）：每个词都要在作答里出现，
  // 允许个别词一处拼写小错；有容错命中则整项判 typo（算对、记拼写弱点）。
  let multiTypo = null;
  for (const f of spec.answers) {
    const fl = f.toLowerCase();
    if (!fl.includes(' ')) continue;
    const words = fl.split(/\s+/).filter(Boolean);
    let typoHit = null;
    const allFound = words.every(w => {
      if (new RegExp(`\\b${escapeReg(w)}\\b`).test(norm)) return true;
      const t = fuzzyToken(norm, w);
      if (!t) return false;
      if (!typoHit || t.d < typoHit.d) typoHit = { d: t.d, tok: t.tok, want: w };
      return true;
    });
    if (allFound && !typoHit) return { status: 'ok', matched: f };
    if (allFound && typoHit && !multiTypo) multiTypo = typoHit;
  }
  if (multiTypo) return { status: 'typo', matched: multiTypo.tok, want: multiTypo.want };
  // 拼写容错：纯字母、长度≥3 的关键词（3–5 个字母容忍改 1 处，6 个以上容忍改 2 处）
  let best = null;
  for (const f of spec.answers) {
    const fl = f.toLowerCase();
    if (!/^[a-z]+$/.test(fl) || fl.length < 3) continue;
    const t = fuzzyToken(norm, fl);
    if (t && (!best || t.d < best.d)) best = { d: t.d, tok: t.tok, want: f };
  }
  if (best) return { status: 'typo', matched: best.tok, want: best.want };
  return { status: 'missing', matched: null };
}

function checkTime(norm, spec) {
  const found = extractTimes(norm);
  const newHit = found.find(t => timeMatches(t, spec));
  const oldHit = spec.old && found.find(t => timeMatches(t, spec.old));
  if (newHit && oldHit) return { status: 'contradiction', matched: null, note: 'new_and_old' };
  if (newHit) return { status: 'ok', matched: `${newHit.h}:${String(newHit.m).padStart(2, '0')}` };
  if (oldHit) return { status: 'contradiction', matched: null, note: 'old_only' };
  return { status: found.length ? 'missing' : 'missing', matched: null };
}

function checkDate(norm, spec) {
  const found = extractDates(norm);
  const newHit = found.find(d => dateMatches(d, spec));
  const oldHit = spec.old && found.find(d => dateMatches(d, spec.old));
  if (newHit && oldHit) return { status: 'contradiction', matched: null, note: 'new_and_old' };
  if (newHit) return { status: 'ok', matched: `${newHit.month}/${newHit.day}` };
  if (oldHit) return { status: 'contradiction', matched: null, note: 'old_only' };
  return { status: 'missing', matched: null };
}

function checkItemEnglish(norm, spec) {
  if (spec.type === 'word') return checkWord(norm, spec);
  if (spec.type === 'time') return checkTime(norm, spec);
  if (spec.type === 'date') return checkDate(norm, spec);
  return { status: 'missing', matched: null };
}

/**
 * 判分主函数
 * spec: { expects: [ {id, type:'word'|'time'|'date', answers?, olds?, hour?,minute?,meridiem?, old?, month?,day?, cn?, cn_old?} ] }
 * 返回 { verdict: 'correct'|'typo'|'chinese'|'wrong',
 *         items: [{id, status:'ok'|'typo'|'missing'|'contradiction', matched, want?}],
 *         note: 给学生的提示语 }
 */
function gradeShort(rawAnswer, spec) {
  const raw = String(rawAnswer || '');
  const norm = normalize(raw);
  const hasChinese = /[\u4e00-\u9fff]/.test(raw);
  const expects = (spec && spec.expects) || [];

  // 中文走结构化检查（时间/星期/数字逐项比对），冲突（上午写成晚上等）直接判 contradiction
  const items = expects.map(e => {
    // 数学表达式用 raw（英文 normalize 会 strip 掉括号运算符），走数学归一
    const en = e.type === 'math' ? checkMath(raw, e) : checkItemEnglish(norm, e);
    const cnR = hasChinese ? checkItemChinese(raw, e) : { hit: false, oldHit: false, conflict: null };
    let status, conflict = null;
    if (en.status === 'contradiction' || cnR.oldHit) status = 'contradiction';
    else if (cnR.conflict) { status = 'contradiction'; conflict = cnR.conflict; }
    else if (en.status === 'ok' || cnR.hit) status = 'ok';
    else status = en.status; // missing | typo
    return { id: e.id, en, cnHit: cnR.hit, cnOldHit: cnR.oldHit, status, conflict,
             matched: en.matched || null, want: en.want || undefined };
  });

  const anyContradiction = items.some(it => it.status === 'contradiction');
  if (anyContradiction) {
    const onlyConflict = items.every(it => it.status !== 'contradiction' || it.conflict);
    return {
      verdict: 'wrong',
      items: items.map(it => ({
        id: it.id,
        status: it.status,
        matched: it.matched || null,
        want: it.want || undefined,
        conflict: it.conflict || undefined,
      })),
      note: onlyConflict ? '有信息写错了，再对照通知看一看。' : '答案里混入了旧信息。只写更新后的信息，不要新旧一起写。',
    };
  }

  const allOk = items.every(it => it.status === 'ok');
  // 数学题不走"中文提示英文重写"分支（数学答案无中英文之分；含中文字符的作答
  // 在 checkMath 里本来就匹配不上，走 wrong）
  const hasMath = expects.some(e => e.type === 'math');
  if (hasChinese && allOk && !hasMath) {
    return {
      verdict: 'chinese',
      items: items.map(it => ({ id: it.id, status: 'ok', matched: it.matched || 'cn' })),
      note: '意思对了，请用英文写一遍。',
    };
  }

  const anyMissing = items.some(it => it.status === 'missing');
  if (anyMissing) {
    return {
      verdict: 'wrong',
      items: items.map(it => ({
        id: it.id,
        status: it.status,
        matched: it.matched || null,
        want: it.want || undefined,
        conflict: it.conflict || undefined,
      })),
      note: '再对照通知看一看，有信息没写对。',
    };
  }

  const typoItem = items.find(it => it.status === 'typo');
  if (typoItem && !hasChinese) {
    return {
      verdict: 'typo',
      items: items.map(it => ({
        id: it.id,
        status: it.status,
        matched: it.matched || null,
        want: it.want || undefined,
      })),
      note: `内容对了，有个小拼写错误：把“${typoItem.matched}”改成“${typoItem.want}”再提交。`,
    };
  }

  return {
    verdict: 'correct',
    items: items.map(it => ({ id: it.id, status: 'ok', matched: it.matched || null })),
    note: '',
  };
}

module.exports = { gradeShort, normalize, extractTimes, extractDates, extractCnTimes, extractCnWeekdays, extractCnNumbers, checkItemChinese };
