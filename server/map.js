'use strict';
// 知识点地图（2026-11-18，DeepTutor Mastery Path 借鉴）
// 一页地图 + 一个 GET 只读接口。状态全部从真数据现算，不读 knowledge_mastery
// （那张表是空的、没人维护）；本模块不写任何数据，不碰门禁、不碰复测队列。
//
// ---- 状态口径（写死；四档是 Elouise 批的，第五档“待巩固”是补漏，见部署清单）----
// 每点挂一到多节课（lessons）。先算这几件事：
//   pending   = 复测队列里 status='pending'、且题属于这几节课（按 items.lesson_id 归属，
//               或 item_ids 里点名的题）。注意 retest_queue.knowledge_point 基本是
//               'general'/'w1'，不能用来认点，所以一律按课归属 + 点名题号。
//   started   = 任一课 p1_started_day 非空，或该课的题有过作答（dict1/write1 这类课
//               不写 lesson_state 也能认出来；今天两者都是 0 作答，规则只作兜底）。
//   done      = 全部课 p1_done=1 且 p2_done=1。
//   everMissed= 这几节课的题进过复测队列（pending 或 resolved 都算）。
//   consolidationDone = 点上挂的巩固课（u3-consolidate / u6r*-consolidate）已完成。
//   passes3   = retest_passes 里该点（passKey）满 3 次——老师记的账，
//               今天全站是 0 行，所以这条腿今天对所有点都不成立（见部署清单）。
// 判定顺序（互斥、完备，一个点只得一个状态）：
//   1. pending > 0                     → 易错 weak
//   2. !started                        → 未学 not_started
//   3. started 但 !done                → 学习中 learning
//   4. done 且 (consolidationDone || passes3 || !everMissed)
//                                      → 已掌握 mastered
//      （!everMissed 这一腿是补漏：从没错过的点，课内挑战一次通过就是证据；
//       否则 U2/U4/U5/U7 这些没巩固课的单元永远出不了“已掌握”。见清单，等 Elouise 认。）
//   5. 其余（done、没待复测、以前错过、但没巩固也没攒够 3 次复测通过）
//                                      → 待巩固 review（新增的第五档）
// “去练”规则：有待复测题才给链接——1 道进单题重做，2 道及以上进批量重做；
//   没题不硬凑、不给死链接。两个例外（永久练习页，不是错题）：
//   写不出来→写句子专项 write1，拼写→精听听写 dict1。
// next_due：复测队列上的下次复测日期（自评算出来的）；NULL=按原 1/3/7 计划。
//   门禁 pending 计数不读 next_due（见部署清单），地图只展示、不改门禁。
// 弱点项的状态是课级别的粗口径（见部署清单）：课里有待复测的题就标易错，
//   不代表那道待复测的题就是这个弱点的题；每点下面会列出是哪几道题，透明可查。
const { shanghaiDay } = require('./time');

const STATUS_LABEL = {
  weak: '易错',
  not_started: '未学',
  learning: '学习中',
  mastered: '已掌握',
  review: '待巩固',
};

const UNITS = [
  { id: 'U1', name: 'Unit 1 · Look it up!' },
  { id: 'U2', name: 'Unit 2 · 广播站' },
  { id: 'U3', name: 'Unit 3 · Computers' },
  { id: 'U4', name: 'Unit 4 · Inventions' },
  { id: 'U5', name: 'Unit 5 · Going on an exchange trip' },
  { id: 'U6', name: 'Unit 6 · Wisdom counts' },
  { id: 'U7', name: 'Unit 7 · The secret of memory' },
  { id: 'U8', name: 'Unit 8 · Pets and us' },
  { id: 'weak', name: '弱点清单（期中卷 + 画像）' },
];

// 点名规则：lesson 点的 title/teach 取自课名与讲课标题（U4–U8 有讲课标题可查，
// U1–U3 只按课名写，不编没核实过的语法细节）；弱点项的 teach 取自弱点清单原文。
const POINTS = [
  // ---- Unit 1（15 课）----
  { id: 'u1r1', unit: 'U1', title: '走进百科全书', teach: '认识百科词：information、related、similar、whole。', lessons: ['u1r1'] },
  { id: 'u1r2', unit: 'U1', title: '达·芬奇条目', teach: '过去式 changed；复数主语用 include。', lessons: ['u1r2'], item_ids: ['u1r2-v2-s43', 'u1r2-v2-s49'] },
  { id: 'u1r3', unit: 'U1', title: '恐龙条目', teach: '数字和时间：245、180、66 各是什么意思。', lessons: ['u1r3'], item_ids: ['u1r3-v1-s12', 'u1r3-v1-s16'] },
  { id: 'u1r4', unit: 'U1', title: '词汇精讲上：look 家族', teach: 'look 家族短语。', lessons: ['u1r4'] },
  { id: 'u1r5', unit: 'U1', title: '词汇句式下：出生与比较', teach: '说出生、说比较。', lessons: ['u1r5'] },
  { id: 'u1r6', unit: 'U1', title: '句式精讲：有些……如此……', teach: '学一个句式：有些……如此……', lessons: ['u1r6'] },
  { id: 'u1r7', unit: 'U1', title: 'Section 1 练：词汇与写钦佩的人', teach: '练词汇，写钦佩的人。', lessons: ['u1r7'] },
  { id: 'u1r8', unit: 'U1', title: 'Section 2 语法上：some 和 any', teach: 'some 和 any 用在哪。', lessons: ['u1r8'] },
  { id: 'u1r9', unit: 'U1', title: 'Section 2 语法下：复合不定代词', teach: 'someone、anyone、everyone 这些词。', lessons: ['u1r9'] },
  { id: 'u1r10', unit: 'U1', title: 'Section 2 练：语法综合 + Let me sum up', teach: '语法综合，学着做小结。', lessons: ['u1r10'] },
  { id: 'u1r11', unit: 'U1', title: '谈论钦佩的人', teach: '开口谈论钦佩的人。', lessons: ['u1r11'] },
  { id: 'u1r12', unit: 'U1', title: '写百科条目：袁隆平', teach: '照着样子写一篇百科条目。', lessons: ['u1r12'] },
  { id: 'u1r13', unit: 'U1', title: '百科全书的历史', teach: '读懂百科全书的历史。', lessons: ['u1r13'] },
  { id: 'u1r14', unit: 'U1', title: '在线百科全书：达·芬奇', teach: '读在线百科：达·芬奇。', lessons: ['u1r14'] },
  { id: 'u1r15', unit: 'U1', title: '单元提升：语法·写作·阅读', teach: '单元提升：语法、写作、阅读一起练。', lessons: ['u1r15'] },
  // ---- Unit 2（5 课）----
  { id: 'u2r1', unit: 'U2', title: '读懂通知', teach: '读懂通知：时间、地点、要求。', lessons: ['u2r1'] },
  { id: 'u2r2', unit: 'U2', title: '广播复盘', teach: '复盘广播：听出关键信息。', lessons: ['u2r2'] },
  { id: 'u2r3', unit: 'U2', title: '数据播报', teach: '播报数据。', lessons: ['u2r3'] },
  { id: 'u2r4', unit: 'U2', title: '来信点播', teach: '读懂来信。', lessons: ['u2r4'] },
  { id: 'u2r5', unit: 'U2', title: '期末大直播', teach: '期末大直播：综合复习。', lessons: ['u2r5'] },
  // ---- Unit 3（5 课；巩固课 u3-consolidate 已完成）----
  { id: 'u3r1', unit: 'U3', title: '比较级入门', teach: '比较级入门：than 前面用比较级。', lessons: ['u3r1'], consolidation: 'u3-consolidate' },
  { id: 'u3r2', unit: 'U3', title: '选购指南', teach: '选购指南：比较着挑。', lessons: ['u3r2'], consolidation: 'u3-consolidate' },
  { id: 'u3r3', unit: 'U3', title: '电话订购', teach: '电话订购：打电话买东西。', lessons: ['u3r3'], consolidation: 'u3-consolidate' },
  { id: 'u3r4', unit: 'U3', title: '写邮件', teach: '写邮件：比较着写。', lessons: ['u3r4'], consolidation: 'u3-consolidate' },
  { id: 'u3r5', unit: 'U3', title: '科技大直播', teach: '科技大直播：综合复习。', lessons: ['u3r5'], consolidation: 'u3-consolidate' },
  // ---- Unit 4（5 课）----
  { id: 'u4r1', unit: 'U4', title: '发明初接触：被动语态入门', teach: '被动语态入门：was/were + 过去分词。', lessons: ['u4r1'] },
  { id: 'u4r2', unit: 'U4', title: '真假发明：否定和疑问', teach: '被动语态的否定和疑问：wasn’t、Was it…?。', lessons: ['u4r2'] },
  { id: 'u4r3', unit: 'U4', title: '现代发明：现在时的被动', teach: '现在时的被动：is/are + 过去分词。', lessons: ['u4r3'] },
  { id: 'u4r4', unit: 'U4', title: '写一写：我的发明', teach: '用被动语态写我的发明。', lessons: ['u4r4'] },
  { id: 'u4r5', unit: 'U4', title: '发明大直播：综合复习', teach: '综合复习：两种被动语态。', lessons: ['u4r5'] },
  // ---- Unit 5（5 课）----
  { id: 'u5r1', unit: 'U5', title: '交流初体验：现在完成时入门', teach: '现在完成时入门：have/has + 过去分词。', lessons: ['u5r1'] },
  { id: 'u5r2', unit: 'U5', title: '你去过吗：疑问句和回答', teach: 'Have you ever…? 问经历。', lessons: ['u5r2'] },
  { id: 'u5r3', unit: 'U5', title: '刚做完：just、already、yet', teach: 'just、already、yet 三个词。', lessons: ['u5r3'] },
  { id: 'u5r4', unit: 'U5', title: '写一写：我的交流日记', teach: '用完成时写交流日记。', lessons: ['u5r4'] },
  { id: 'u5r5', unit: 'U5', title: '交流大直播：综合复习', teach: '综合复习：完成时怎么用。', lessons: ['u5r5'] },
  // ---- Unit 6（5 课；巩固课只开了 u6r1-consolidate 且未完成）----
  { id: 'u6r1', unit: 'U6', title: '故事开场：since 和 for 入门', teach: 'since 和 for：since 跟时间点，for 跟一段时间。', lessons: ['u6r1'], consolidation: 'u6r1-consolidate' },
  { id: 'u6r2', unit: 'U6', title: '多久了：How long 提问', teach: 'How long 提问，for/since 回答。', lessons: ['u6r2'], consolidation: 'u6r2-consolidate' },
  { id: 'u6r3', unit: 'U6', title: '古今对比：完成时 vs 过去时', teach: '完成时 vs 过去时：还继续 vs 结束了。', lessons: ['u6r3'], consolidation: 'u6r3-consolidate' },
  { id: 'u6r4', unit: 'U6', title: '写一写：我的家乡故事', teach: '用 since/for 写家乡故事。', lessons: ['u6r4'], consolidation: 'u6r4-consolidate' },
  { id: 'u6r5', unit: 'U6', title: '故事大直播：综合复习', teach: '综合复习：since/for、两种时态。', lessons: ['u6r5'], consolidation: 'u6r5-consolidate' },
  // ---- Unit 7（5 课）----
  { id: 'u7r1', unit: 'U7', title: '记忆开场：条件句（2）入门', teach: '条件句（2）：说一定会发生的结果。', lessons: ['u7r1'] },
  { id: 'u7r2', unit: 'U7', title: '遗忘曲线：条件句练兵', teach: '条件句换位置，动词一点不变。', lessons: ['u7r2'] },
  { id: 'u7r3', unit: 'U7', title: 'unless 登场：if...not 改写', teach: 'unless = if...not；unless 后面不再加 not。', lessons: ['u7r3'] },
  { id: 'u7r4', unit: 'U7', title: '大树的记忆：条件句综合', teach: '条件句综合 + unless 综合。', lessons: ['u7r4'] },
  { id: 'u7r5', unit: 'U7', title: '记忆大直播：综合复习', teach: '综合复习：条件句、unless、词汇回炉。', lessons: ['u7r5'] },
  // ---- Unit 8（5 课）----
  { id: 'u8r1', unit: 'U8', title: '宠物开场：副词入门', teach: '副词入门：-ly 怎么加，放哪里。', lessons: ['u8r1'], item_ids: ['u8r1-v1-s35', 'u8r1-v1-s45', 'u8r1-v1-s46'] },
  { id: 'u8r2', unit: 'U8', title: '公寓养狗记：-ly 拼写关', teach: '-ly 拼写关：hard/hardly、late/lately。', lessons: ['u8r2'] },
  { id: 'u8r3', unit: 'U8', title: '谁做得更好：副词比较级', teach: '副词比较级：more + -ly；不能双重比较。', lessons: ['u8r3'] },
  { id: 'u8r4', unit: 'U8', title: '宠物从前传：副词最高级', teach: '副词最高级：most + -ly；先数对象。', lessons: ['u8r4'] },
  { id: 'u8r5', unit: 'U8', title: '宠物大直播：综合复习', teach: '综合复习：副词构成、比较级最高级。', lessons: ['u8r5'] },
  // ---- 弱点清单十项（2026-11-12 清单原文；状态按涉及的课算，课级别粗口径）----
  { id: 'weak-write', unit: 'weak', title: '写不出来——产出断了', teach: '期中卷产出题几乎全空（约 35 分）；站内产出题一次答对率 45–56%。练法：作文拆 5 句句框，write1 每天 5 句。', lessons: ['u1r12', 'u4r4', 'u5r4', 'u6r4', 'write1'], permanentPractice: { url: '/lesson?lesson=write1', label: '去写句子专项' } },
  { id: 'weak-giveup', unit: 'weak', title: '考试时放弃——蒙字母、空着不写', teach: '期中语法选择连着选 A、完形连着选 B，全错；36–40、46–50、56–60、作文全空。规矩：不许连着三个同一个字母，空题也要猜。', lessons: ['u3r5', 'u5r5', 'u7r5', 'u8r5'] },
  { id: 'weak-pos', unit: 'weak', title: '词性分不清（形容词 / 副词 / 代词）', teach: '期中 3、4、9 全错：as...as 后面用原级，of 后面用宾格，动词后面用副词。', lessons: ['u3r1', 'u8r1'] },
  { id: 'weak-comparative', unit: 'weak', title: '比较级 / 最高级用不对', teach: '期中 bad 的比较级 worse 错了。than 前面用比较级，the 后面用最高级。', lessons: ['u3r1', 'u3r2', 'u3r3', 'u3r4', 'u3r5', 'u8r3', 'u8r4'], consolidation: 'u3-consolidate' },
  { id: 'weak-verbform', unit: 'weak', title: '动词形式（spend time doing、序数词）', teach: '期中 spent two hours watching、my fifth lesson 错了。spend time doing 句框；my 后面直接跟序数词。', lessons: ['u1r5'] },
  { id: 'weak-cloze', unit: 'weak', title: '完形寓意词（impatient / plan / stop / caused / stronger / mistake）', teach: '期中完形 15–20 全错：没读懂国王故事的寓意就蒙了，不是单词不认识。先讲寓意（小事不做，大事必败），再做题。', lessons: ['u1r3'] },
  { id: 'weak-inference', unit: 'weak', title: '推断题 / 主旨题', teach: '期中 22、25、26、29 错；细节题基本全对。推断三步：找依据句、排除字面、选最贴近的。', lessons: ['u1r3', 'u1r13'] },
  { id: 'weak-unless', unit: 'weak', title: 'unless（条件句）', teach: 'u7r4 复测 58%；11 月 11 日第二部分 3/8。unless = if...not，否定句里不能再加 not。', lessons: ['u7r3', 'u7r4', 'u7r5'] },
  { id: 'weak-perfect', unit: 'weak', title: '现在完成时（have/has + 过去分词 + since/for）', teach: '画像头号短板；has taught 11 月 5 日才第一次拼对。write1 + since/for 句框。', lessons: ['u5r1', 'u5r2', 'u5r3', 'u5r4', 'u5r5', 'u6r1', 'u6r2', 'u6r3'] },
  { id: 'weak-spelling', unit: 'weak', title: '拼写', teach: 'has taugh → has taught 自纠；默写单 232 词无一掌握。dict 听写 + 生词本 5 级制。', lessons: ['dict1', 'dict2'], permanentPractice: { url: '/lesson?lesson=dict1', label: '去精听听写' } },
];

function shortItem(itemId) {
  if (itemId === 'king-story') return '国王故事';
  const m = /^([a-z0-9]+)-v\d+-s(\d+)$/.exec(itemId || '');
  return m ? (m[1] + ' s' + m[2]) : String(itemId || '');
}

// 上海日 +N 天（YYYY-MM-DD），只做日期加法，不依赖服务器时区
function addDays(dayStr, n) {
  const parts = String(dayStr || '').split('-').map(Number);
  const t = new Date(Date.UTC(parts[0] || 1970, (parts[1] || 1) - 1, (parts[2] || 1) + n));
  const p = x => String(x).padStart(2, '0');
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

// next_due 的大白话：NULL=按原计划；明天/后天直接说；其余说 M月D日
function nextDueLabel(nextDue, today) {
  if (!nextDue) return '按计划';
  if (nextDue === addDays(today, 1)) return '明天';
  if (nextDue === addDays(today, 2)) return '后天';
  const parts = String(nextDue).split('-');
  if (parts.length === 3) return Number(parts[1]) + '月' + Number(parts[2]) + '日';
  return String(nextDue);
}

function getMapData(db) {
  const day = shanghaiDay();
  const state = {};
  for (const r of db.prepare('SELECT lesson_id, p1_started_day, p1_done, p2_done FROM lesson_state').all()) {
    state[r.lesson_id] = r;
  }
  const attempted = new Set(db.prepare(
    'SELECT DISTINCT i.lesson_id AS lid FROM attempts a JOIN items i ON i.item_id=a.item_id'
  ).all().map(r => r.lid));
  const pendingRows = db.prepare(
    "SELECT q.item_id, q.next_due, q.recall_rating, i.lesson_id FROM retest_queue q LEFT JOIN items i ON i.item_id=q.item_id WHERE q.status='pending'"
  ).all();
  const everRows = db.prepare(
    'SELECT q.item_id, i.lesson_id FROM retest_queue q LEFT JOIN items i ON i.item_id=q.item_id'
  ).all();
  const passes = {};
  for (const r of db.prepare('SELECT point, COUNT(*) c FROM retest_passes GROUP BY point').all()) {
    passes[r.point] = r.c;
  }
  const isStarted = lid => {
    const s = state[lid];
    return Boolean((s && s.p1_started_day) || attempted.has(lid));
  };
  const isDone = lid => {
    const s = state[lid];
    return Boolean(s && s.p1_done === 1 && s.p2_done === 1);
  };
  const summary = { total: POINTS.length, mastered: 0, weak: 0, learning: 0, not_started: 0, review: 0 };
  const units = UNITS.map(u => {
    const points = POINTS.filter(p => p.unit === u.id).map(pt => {
      const lessonSet = new Set(pt.lessons || []);
      const idSet = new Set(pt.item_ids || []);
      const pend = pendingRows
        .filter(r => lessonSet.has(r.lesson_id) || idSet.has(r.item_id))
        .map(r => ({
          item_id: r.item_id,
          short: shortItem(r.item_id),
          lesson_id: r.lesson_id || (pt.lessons || [])[0] || null,
          next_due: r.next_due || null,
          next_label: nextDueLabel(r.next_due, day),
        }));
      const everMissed = everRows.some(r => lessonSet.has(r.lesson_id) || idSet.has(r.item_id));
      const started = (pt.lessons || []).some(isStarted);
      const done = (pt.lessons || []).length > 0 && (pt.lessons || []).every(isDone);
      const consolidationDone = pt.consolidation ? isDone(pt.consolidation) : false;
      const passes3 = (passes[pt.passKey || pt.id] || 0) >= 3;
      let status;
      if (pend.length > 0) status = 'weak';
      else if (!started) status = 'not_started';
      else if (!done) status = 'learning';
      else if (consolidationDone || passes3 || !everMissed) status = 'mastered';
      else status = 'review';
      summary[status] += 1;
      let practice = null;
      if (pend.length === 1 && pend[0].lesson_id) {
        practice = {
          kind: 'single',
          url: '/lesson?lesson=' + encodeURIComponent(pend[0].lesson_id) + '&retry_item=' + encodeURIComponent(pend[0].item_id),
          label: '去练这道题',
        };
      } else if (pend.length > 1) {
        practice = {
          kind: 'batch',
          url: '/lesson?lesson=batch-retry&items=' + encodeURIComponent(pend.map(p => p.item_id).join(',')),
          label: '去练这 ' + pend.length + ' 道题',
        };
      } else if (pt.permanentPractice) {
        practice = { kind: 'page', url: pt.permanentPractice.url, label: pt.permanentPractice.label };
      }
      return {
        id: pt.id,
        title: pt.title,
        teach: pt.teach,
        status,
        status_label: STATUS_LABEL[status],
        pending: pend,
        practice,
      };
    });
    return { id: u.id, name: u.name, points };
  });
  return { ok: true, day, summary, units };
}

module.exports = { POINTS, UNITS, STATUS_LABEL, getMapData, shortItem, nextDueLabel };
