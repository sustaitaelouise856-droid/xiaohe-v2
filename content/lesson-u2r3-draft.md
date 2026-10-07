# 第 3 课《数据播报》逐题清单 v2（按真人老师规范修订，待 Claude 再审）

> **成课状态（2026-10-02）**：已按本清单落成 `content/lesson-u2r3.json`（v1，36 步、23 题：mcq 15＋short 8，practice_end=19）。两处与时俱进调整：① 总任务书取消两天制——原步 21/22「晨间复盘占位」改为第二部分开场复习固定新题（小卖部数据，复现 percent 与 go up/go down，全课不出现"昨天/明天/第二天"）；步 3–5 复盘占位按定题要求落成固定题（第 2 课技能换新题面）。② 开场与结尾用静态中性文案（按真实数据动态生成需程序侧支持，属程序线事项）。音频 5 段已生成到 `audio/u2r3/`（119–129 wpm，-20 LUFS）。走课：`scripts/walkthrough-u2r3.js` 168 项全绿（答对＋一直答错＋逐步音频）。

> **修订说明（v1 → v2，2026-10-02）**：
> ① 判分宽容写成硬规格：写作/简答只看关键信息（数字＋方向），大小写、标点、介词、语序、整句或短语、多写无关词一律不判错；拼写小错单记"拼写需注意"——算答对、记弱点（第六节）。
> ② 两个写作题各附 ≥10 个"应该判对"＋≥5 个"应该判错"的答案写法，作为判分测试用例，程序侧逐个提交验证（第六节）。
> ③ 新增第九节"示范 → 带着做 → 自己做"对照表：percent、go up/go down 两项新知逐项核三段，齐全。
> ④ 新增第八节"难度与降级方案"：每道较难的题预先标好降级版本（换选择题或更小的问题），供程序侧"连错两次自动降一级"调用；验证阶段不降级给答案，连错走既有出口（记未独立完成进下一题）。
> ⑤ 第二天开场加"晨间复盘"2 步（新步 21、22，占位）：按第一天真实错因换题再考，落实规范第 7 条；原第二天步 21–34 顺延为 23–36，全课 36 步，第二部分校准约 30.5 分钟（仍在 25–35 分钟内）。
> ⑥ 新增第十节"家长一句话报告"：课末按真实 attempts 数据生成（学会了什么／哪里还弱／用了多久），不写空话。
> ⑦ 措辞统一"第一天/第二天"，不用"昨天"（孩子不一定隔天上）。其余（硬规则、材料、音频、答案位置）沿 v1。
>
> 36 步，两天制（第一天步骤 1–19 练习，第二天步骤 20–36 验证；第一天没做完，第二天先续做第一部分）。全课校准用时约 59 分钟（第一部分约 28.5、第二部分约 30.5）。
> 题型：teach 10 / mcq 14（自有 12＋复盘占位 2）/ short 5 / 听力填空 2 / 阅读 3，另有第二天晨间复盘占位 2 步（题型随错因定）。选择题 4 选项、每错项有针对性反馈；正确项不总是最长。
> "最终信息""设计备注"仅为设计说明，不进页面。

## 一、答案位置统计（自有 12 道选择题，硬要求）

| 出题序 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 步骤 | 10 | 11 | 12 | 15 | 16 | 24 | 25 | 26 | 27 | 30 | 32 | 33 |
| 答案 | C | A | D | B | B | D | A | C | B | D | A | C |

- 分布：A×3（步 11、25、32）、B×3（步 15、16、26）、C×3（步 10、27、33）、D×3（步 12、24、30）。
- 最长连续相同：2 次（仅出题序 4→5 连续 B，其余无相邻重复）。
- 间隔检查：A（2,7,11）、B（4,5,9）、C（1,8,12）、D（3,6,10），按出题序看均无固定间隔规律。
- 正确项长度：有最短的（步 16、33 的"第②/③句"、步 25"Class Two"、步 32"New books"），有中等的（步 12"fifty (50)"），也有较长的（步 24"went up 15%"），不总是最长。
- 说明：步骤 3、5（第一天复盘）与步骤 21、22（第二天晨间复盘）的占位题不计入上表；定题时其答案位置另行平衡后补统计。
- 补充统计（成课落定，2026-10-02）：步 3＝A、步 5＝C、步 21＝A。全课 15 道选择题答案序列为 A C C A D B B A D A C B D A C，分布 A×5、B×3、C×4、D×3，最长连续相同 2 次；上表自有 12 题分布不变（A/B/C/D 各 3、最长连 2）。步 22、4 为简答题不计。

## 二、材料与音频出现步骤表

| 材料 | 出现步骤 | 形式 |
|---|---|---|
| 材料 A：图书馆借书数据报告 | 步骤 9 | 文字＋表格（阅读原文常显，后续题目可回看） |
| 音频 A1：辨音句 | 步骤 12 | 先听（无文字），选项为数字词 |
| 音频 A2：借书数据播报 | 步骤 14 填空、步骤 15 听后选择 | 先听后答；文字稿在步骤 15 作答后随反馈显示核对 |
| 核对稿 A（3 句，含 1 处数字错误） | 步骤 16–17 | 文字（对照材料 A，材料 A 仍常显） |
| 晨间复盘题（换题面） | 步骤 21–22 | 按第一天错因选题，材料随题出示（见第四节） |
| 材料 B：运动会数据报告 | 步骤 23 | 文字＋表格（阅读原文常显） |
| 音频 B1：辨音句 | 步骤 27 | 先听（无文字），选项为数字词 |
| 音频 B2：运动会数据播报 | 步骤 29 填空、步骤 30 听后选择 | 先听后答；文字稿在步骤 30 作答后随反馈显示核对 |
| 材料 C：广播站经费小表 | 步骤 31 | 文字表格（常显） |
| 核对稿 B（3 句，含 1 处涨跌错误） | 步骤 33–34 | 文字（对照材料 B，材料 B 仍常显） |

## 三、第一天 · 练习阶段（步骤 1–19，校准约 28.5 分钟）

### 开场与复盘（teach ×2＋复盘占位 3 步）

- **步骤 1**（teach·动态文案，按第 2 课真实结果生成，不写死；方括号用真实数据填充）：
- 全对："上次的通知追踪你全对，时间线很稳。今天换个活：播数字——借书量、比分、预算，数字有涨有跌。"
- 大部分对："上次错的几道主要是[错因类型]。今天先复盘，再播数字。"（错因只有一类才说"主要是"；多类并列改为"错的 X 道：[逐类计数如实列]"，与 review.js 已定规则一致）
- 某类突出（旧信息干扰/拼写/漏项——错因分类名只在设计侧用，给孩子看的文案要换成具体说法，如"有 X 道题用了第一份通知上的旧信息"）："上次有 X 道题栽在[具体错法]上。今天先复盘，再播数字。"
- 默认（无数据）：中性文案"新的一天，广播站开门。今天播数字，先复盘热身。"
- **步骤 2**（teach·复盘引入语，按数据生成，两种）：
- 上次有错题版："先热身。上次错的[错因如实列/只有一类说'主要是…']，这次换新题考，看看还错不错。"
- 上次没有错题版："上次没有错题。这次复盘换几道新题，看看是真会了，还是碰巧对的。"（不说"错的都是上次的类型"）
- **步骤 3**（mcq·复盘占位①·时间线追踪）：**占位，待第 2 课错因数据**——第 2 课刚上，错因未回；定题要求：新材料、新题面，考"只认最后一次更新"，系统按错因数据决定上不上。
- **步骤 4**（short·复盘占位②·拼写）：**占位，待第 2 课错因数据**——定题要求：取第 2 课实际拼错的词出新题；判分关键词与常见错误反馈定题时写。
- **步骤 5**（mcq·复盘占位③·旧信息干扰）：**占位，待第 2 课错因数据**——系统按错因数据决定上不上；不上时第一部分少 1 步（校准 27.5 分钟，仍达标）。

### 新知教学（teach ×3）

- **步骤 6**（teach）：站长交代新任务：今天广播站要播一期"校园数字"——图书馆借书量、运动会比分、广播站经费。数字播错了，全校都会听错，先看懂再播。
- **步骤 7**（teach·核心新知，只教这 2 个；每个新知先示范一句完整的播报，照第九节三段式）：
- **percent**：百分之……。25% 读 twenty-five percent；50% 读 fifty percent；100% 读 one hundred percent。看到 %，就想"每一百个里有几个"。示范播报："Grade Seven went up 5 percent."（先听站长读一遍，孩子跟读不计分——示范段）
- **go up / go down**：数字变大是 go up，变小是 go down。例：Books went up 5%.（书变多了）The price went down.（价格降了）
- **步骤 8**（teach·读表提示，不算新知、不考）：看数据表先看三样：①哪一行是谁（年级/班级/项目）；②数字是多少（数字里的逗号是千位分隔，1,250 就是一千二百五十，看懂就行，不用会拼）；③最后一栏和以前比是涨（up）还是跌（down）。谁是第一名，看原文里 "the most / first place" 的字样去找，不用背。

### 材料 A（阅读 ×1＋mcq ×2＋辨音 ×1）

- **步骤 9**（read）：出示材料 A（原文常显）。
> **Library News — October**
> Grade Seven borrowed 850 books. Grade Eight borrowed 1,250 books — the most. Grade Nine borrowed 640 books.
>
> | | Books in October | From September |
> |---|---|---|
> | Grade Seven | 850 | went up 5% |
> | Grade Eight | 1,250 | went up 20% |
> | Grade Nine | 640 | went down 10% |
>
> Story books are the children's favourite.
- **步骤 10**（mcq·材料查找，答案 C）：10 月哪个年级借书最多？A. Grade Seven（850 本，再看看表格里谁的数字最大） B. Grade Nine（640 本，是最少的，再对照一下） C. Grade Eight ✓ D. 三个年级一样多（三个数字不一样大，再比一比）
- **步骤 11**（mcq·核心新知，答案 A）：九年级的借书量和 9 月比有什么变化？A. went down 10% ✓ B. went up 10%（方向反了，材料里 Grade Nine 那一行写的是 down） C. went up 5%（5% 是七年级的，别串行） D. 没有变化（"From September"那一栏写了变化）
- **步骤 12**（mcq·听力辨音 teen/ty，答案 D）：播放音频 A1，先听，选你听到的数字。
> 音频 A1 文案：This week, Grade Seven got fifty new books.
> 问：这周新到的书是多少本？A. fifteen (15) B. thirteen (13) C. thirty (30) D. fifty (50) ✓
> 答错反馈（练习阶段可点方法）：-teen 和 -ty 听尾巴：fifteen 的 -teen 拖长一点，fifty 的 -ty 短。先听整句再选。

### 听力填空（teach ×1＋填空 ×1＋mcq ×1）

- **步骤 13**（teach）：站长：图书馆刚发来一段播报，我读，你记数字。听完要填三个数，填阿拉伯数字就行。
- **步骤 14**（听力填空）：播放音频 A2，填 3 个空：①10 月一共借了多少本书；②比 9 月涨了百分之几；③借得最多的年级借了多少本。
> 音频 A2 文案：Library news. In October, students borrowed two thousand, seven hundred and forty books in all. That is up eight percent from September. Grade Eight borrowed the most — one thousand, two hundred and fifty books.
> 判分（按宽容规格）：数字等值即对——2,740 可写 2740；8% 可写 8；1,250 可写 1250；写英文数字（eight）也判对，不要求拼写；多个数字只看数值对不对。填错反馈指出是哪个空、提醒再听一遍（可重听），不直接报答案。
- **步骤 15**（mcq·听后选择，答案 B）：刚才的播报里，10 月借书总量和 9 月比？A. went down 8%（方向听反了，播报里说的是 up） B. went up 8% ✓ C. went up 18%（是 8，不是 18，再听听那个数字） D. 没有变化（播报里说了变化）
> 本步作答后显示音频 A2 文字稿核对。

### 核对播报稿（mcq ×1＋short ×1）

- **步骤 16**（mcq·核对，答案 B）：出示核对稿 A（站长写的播报稿，有一句数字和材料 A 对不上）：
> ① Grade Seven borrowed 850 books in October.
> ② Grade Nine borrowed 680 books in October.
> ③ Grade Eight borrowed 1,250 books, the most in October.
> 问：哪一句的数字错了？A. 第①句（850 和材料 A 对得上，再核对下一句） B. 第②句 ✓ C. 第③句（1,250 和 the most 都对得上） D. 三句都对（有一句对不上，逐句对材料 A 的表格）
- **步骤 17**（short·改错）：第②句里 Grade Nine 的借书量写错了。把这句改对，写出完整的句子（句框：Grade Nine borrowed ___ books in October.）
> 判分（按宽容规格）：关键词 640，对了即对；句框照抄不判、大小写标点不判、句中多余的词不判。常见错误：写 680→"那是稿子里的错数字，回材料 A 表格里 Grade Nine 那一行看"；写 850→"那是七年级的，看准行再改"。

### 写作输出（short ×1）＋小结

- **步骤 18**（short·写作①练习，写 2 句）：用材料 A 的数据，选一个年级，写 2 句广播句。句子框架：① Grade ___ borrowed ___ books in October. ② It went ___ ___% from September.
> 词库：borrowed、went up、went down、percent、books、Grade Seven / Eight / Nine。
> 判分见第六节《写作判分规格》写作①（含 10+5 测试用例）。
- **步骤 19**（teach）：小结＋预告（中性收尾，不写死表扬）：今天练了读数字、听数字、核对稿子。明天站长出门，换一份新材料，你自己播一期。

## 四、第二天 · 验证阶段（步骤 20–36，校准约 30.5 分钟）

> 设计备注（不进页面）：验证只考不教——percent、go up/down 在练习阶段已教，验证阶段不再讲解新知；反馈只指方向、不给答案，只能引用已出现过的材料（材料 B、音频 B、材料 C），不提后面步骤的内容。材料 B 数据：Class One 86 分、Class Two 92 分（第一名）、Class Three 78 分；总分比去年 went up 15%；参加学生 240 人。

### 过渡与晨间复盘（teach ×1＋复盘占位 ×2，规范第 7 条：第二天先复盘第一天的错题型）

- **步骤 20**（teach·过渡，只放过渡文案）：站长出门了。今天这一期数字新闻你自己播——正式播之前，先热热身。
- **步骤 21**（mcq 或 short·晨间复盘占位①）：**按第一天真实错因定题**——服务端按第 3 课第一天 attempts 里错得最多的题型出一道换题面的新题：
  - 涨跌方向错得多 → 新数字一句播报，选 went up / went down（如"Paper went from 200 yuan to 160 yuan."选 down）；
  - 数字听辨错得多 → teen/ty 换一句新音频（如 forty/fourteen），先听后选；
  - 核对类错得多 → 给一句新稿对材料 A 换个数字，判断对错。
  定题要求：只考第一天教过的，不出新知；反馈只指方向。第一天全对时：出一道同题型的换材料题（口径同步骤 2 的"没有错题版"：看看是真会了，还是碰巧对的）。**占位，题目随错因数据在实现阶段定，并补答案位置统计。**
- **步骤 22**（mcq 或 short·晨间复盘占位②）：同步骤 21 规则，出第一天错得第二多的题型；错因只有一类时，同类换题面再考一次；第一天全对时，出一道核对题热身。**占位，同上。**
- 引入语（按数据生成，两版，措辞用"第一天"不用"昨天"）：
  - 有错版："第一天错的主要是[题型，如实列]，先用新题热热身，再开始今天的。"
  - 无错版："第一天都对了。先抽查两题热热身，看看是真会了。"

### 材料 B（teach ×0＋阅读 ×1＋mcq ×3）

- **步骤 23**（read）：出示材料 B（原文常显）。
  > **Sports Day News**
  > Class One got 86 points. Class Two got 92 points and won first place. Class Three got 78 points.
  > This year, the points went up 15% from last year. 240 students joined the games.
  >
  > | | Points |
  > |---|---|
  > | Class One | 86 |
  > | Class Two | 92 (first place) |
  > | Class Three | 78 |
- **步骤 24**（mcq·核心验证，答案 D）：今年的总分和去年比有什么变化？A. went down 15%（再对照材料 B 里"from last year"那句看方向） B. went up 5%（数字不对，再看看材料里写的百分之几） C. 没有变化（材料里写了变化，再找一找） D. went up 15% ✓
- **步骤 25**（mcq·材料查找，答案 A）：哪个班得了第一名？A. Class Two ✓ B. Class One（再看看表格里谁的分数最高） C. Class Three（再看看表格里谁的分数最高） D. Class Four（材料里只有三个班）
- **步骤 26**（mcq·数字查找，答案 C）：Class One 得了多少分？A. 92 分（那是别的班的，看准行） B. 78 分（那是别的班的，看准行） C. 86 分 ✓ D. 68 分（材料里没有这个数，再对一下表格）

### 听力辨音与填空（mcq ×1＋teach ×1＋填空 ×1＋mcq ×1）

- **步骤 27**（mcq·听力辨音 teen/ty，答案 B）：播放音频 B1，先听，选你听到的数字。
  > 音频 B1 文案：In the first game, Class Three got thirteen points.
  > 问：第一场比赛 Class Three 得了多少分？A. thirty (30) B. thirteen (13) ✓ C. fourteen (14) D. forty (40)
  > 答错反馈（验证阶段只指方向）：再听一遍，听数字的尾巴是拖长还是短促，别急着选。
- **步骤 28**（teach）：下面一段运动会播报，听完填数字。填阿拉伯数字就行。
- **步骤 29**（听力填空·换材料二次验证）：播放音频 B2，填 3 个空：①今年参加运动会的学生有多少人；②比去年涨了百分之几；③得第一名的班得了多少分。
  > 音频 B2 文案：Sports news. This year, two hundred and forty students joined Sports Day. That is up twenty percent from last year. Class Two got the most points — ninety-two points.
  > 判分（按宽容规格）：数字等值即对——240 可写 240；20% 可写 20；92 可写 92；写英文数字也判对，不要求拼写。填错反馈只指出哪个空有问题、提醒再听，不报答案。
- **步骤 30**（mcq·听后选择，答案 D）：刚才的播报里，今年参加的人数和去年比？A. went down 20%（再听一遍方向词） B. went up 2%（数字再听一遍） C. 没有变化（播报里说了变化） D. went up 20% ✓
  > 本步作答后显示音频 B2 文字稿核对。

### 材料 C 与核对播报稿（阅读 ×1＋mcq ×2＋short ×1）

- **步骤 31**（read）：出示材料 C（广播站经费小表，常显）。
  > **Radio Station Money**
  >
  > | | Last term | This term |
  > |---|---|---|
  > | New books | 500 yuan | 650 yuan |
  > | Headphones | 300 yuan | 300 yuan |
  > | Paper | 200 yuan | 160 yuan |
- **步骤 32**（mcq·换材料二次验证，答案 A）：经费表里，哪一项这学期涨了？A. New books ✓ B. Headphones（两学期都是 300，没变） C. Paper（从 200 到 160，是少了） D. 都没涨（有一项涨了，再对一下表）
- **步骤 33**（mcq·核对，答案 C）：出示核对稿 B（要播的稿子，有一句和材料 B 对不上）：
  > ① Class Two won first place with 92 points.
  > ② Class Three got 78 points.
  > ③ The points went down 15% from last year.
  > 问：哪一句错了？A. 第①句（92 分和 first place 都对得上） B. 第②句（78 分对得上，再看看方向那句） C. 第③句 ✓ D. 三句都对（有一句和材料 B 对不上，逐句核对）
- **步骤 34**（short·改错）：第③句的涨跌方向写反了。把这句改对，写出完整的句子（句框：The points went ___ 15% from last year.）
  > 判分（按宽容规格）：关键词 up，对了即对；句框照抄、大小写、标点不判。常见错误：写 down→"回材料 B 看 'from last year' 那句，方向是涨还是跌"；漏 15→"句框里的 15% 要带上"。反馈只指方向，不直接报答案（本步是改错题，孩子提交后按判分给对/错）。

### 写作输出（short ×1）＋结尾

- **步骤 35**（short·写作②验证，写 3 句）：用今天的材料，自己写 3 句数字新闻。句子框架：① Class ___ got ___ points. ② The points went ___ ___% from last year. ③ We will spend ___ yuan on ___ this term.（第③句用材料 C）
  > 词库：got、points、went up、went down、percent、spend、yuan、new books / headphones / paper。
  > 判分见第六节《写作判分规格》写作②（含 10+5 测试用例）。验证阶段：写错后反馈只指哪句哪一处有问题、去对照哪份材料，不给答案。
- **步骤 36**（teach·结尾，按本课真实结果动态生成，不写死表扬；结尾同时触发第十节家长报告）：
  - 全部独立完成："这期数字新闻播完了。[本课统计：选择题 X 道、填空和写作都自己完成]。下一课《来信点播》，有人要给广播站写信了。"
  - 有错版："这期数字新闻播完了。[按真实错因：错的主要是涨跌方向/数字听辨/核对漏看]，下次课开头先复盘。下一课《来信点播》。"
  - 方括号内容全部用本课 attempts 真实数据填充；无数据时用中性版："这期数字新闻播完了。下一课《来信点播》。"

## 五、每步双列用时与两部分合计

校准依据（孩子第 1 课实测，Codex 数据）：选择题首次作答平均约 22 秒、简答题约 23 秒；每部分"答题＋讲解"总共只有约 10 分钟。旧估计（选择题 1.5 分钟、简答 2–2.5 分钟）高估 3–4 倍。
校准列算法：首次作答（22 秒/23 秒）＋读题干与选项/回看材料的时间＋听音频与重听的时间＋写句子的时间（按孩子慢读慢写估）。**以校准列为准**；一般估计列只作对照。

### 第一部分（步骤 1–19）

| 步 | 类型 | 一般估计（分） | 按孩子实测校准（分） |
|---|---|---|---|
| 1 | teach 开场 | 1.5 | 1.0 |
| 2 | teach 复盘引入 | 1.0 | 0.5 |
| 3 | mcq 复盘（占位） | 2.0 | 1.0 |
| 4 | short 复盘（占位） | 2.0 | 1.0 |
| 5 | mcq 复盘（占位） | 1.5 | 1.0 |
| 6 | teach 新任务 | 1.0 | 0.5 |
| 7 | teach 新知 | 2.5 | 1.5 |
| 8 | teach 读表提示 | 2.0 | 1.0 |
| 9 | read 材料 A | 3.5 | 3.0 |
| 10 | mcq | 1.5 | 1.5 |
| 11 | mcq | 1.5 | 1.5 |
| 12 | mcq 听力辨音 | 2.5 | 1.5 |
| 13 | teach 听力引入 | 1.0 | 0.5 |
| 14 | 听力填空 | 3.5 | 3.0 |
| 15 | mcq 听后选择 | 2.0 | 1.5 |
| 16 | mcq 核对播报稿 | 3.0 | 2.5 |
| 17 | short 改错 | 2.5 | 1.5 |
| 18 | short 写作 2 句 | 4.0 | 3.5 |
| 19 | teach 小结 | 1.5 | 1.0 |
| **合计** | | **40.0** | **28.5** |

### 第二部分（步骤 20–36）

| 步 | 类型 | 一般估计（分） | 按孩子实测校准（分） |
|---|---|---|---|
| 20 | teach 过渡 | 1.5 | 1.0 |
| 21 | 复盘（占位） | 2.0 | 1.0 |
| 22 | 复盘（占位） | 2.0 | 1.0 |
| 23 | read 材料 B | 3.5 | 3.0 |
| 24 | mcq | 1.5 | 1.5 |
| 25 | mcq | 1.5 | 1.5 |
| 26 | mcq | 1.5 | 1.5 |
| 27 | mcq 听力辨音 | 2.5 | 1.5 |
| 28 | teach 听力引入 | 1.0 | 0.5 |
| 29 | 听力填空 | 4.0 | 3.5 |
| 30 | mcq 听后选择 | 2.0 | 1.5 |
| 31 | read 材料 C | 2.5 | 2.0 |
| 32 | mcq | 1.5 | 1.5 |
| 33 | mcq 核对播报稿 | 3.0 | 2.5 |
| 34 | short 改错 | 2.5 | 1.5 |
| 35 | short 写作 3 句 | 5.0 | 4.5 |
| 36 | teach 结尾 | 1.5 | 1.0 |
| **合计** | | **39.0** | **30.5** |

**两部分合计：第一部分校准 28.5 分钟、第二部分校准 30.5 分钟，各自落在 25–35 分钟内（全课约 59 分钟）。** 若步骤 5 复盘题不上，第一部分为 27.5 分钟，仍达标。时长来源是长阅读（步 9、23）、听力（步 14、29）、核对播报稿（步 16、33）和写作（步 18、35），不是选择题数量。

## 六、写作判分规格（判分宽容，硬规格；实现阶段按此写判分并加回归测试）

### 总则（写作题和简答题通用，2026-10-02 新硬规则）

- **只看关键信息**：数字、涨/跌方向、对象（哪个年级/班/项目）对了，就算对。
- **一律不判错**：大小写、标点、介词（on/in/at 用混）、冠词（the 有无）、语序（整句里信息块前后换位）、写完整句还是短语、多写无关词（如"I think""in our school"）。
- **拼写小错**：关键信息对、只是个别字母拼错（如 Octber、libary），判为"**拼写需注意**"——**算答对**，但记一个拼写弱点，课末小结和家长报告里如实点出；不算"错"，不挡路。
- **判定输出三档**：①对；②对，但拼写需注意（记弱点）；③错（关键信息缺失或错误）。反馈按档给：②档先肯定关键信息对，再指出哪个词拼错了、正确拼法是什么；③档指出哪项关键信息有问题、去哪份材料看（验证阶段不给答案）。
- **多写错信息要判错**：多写的内容里如果带了和材料冲突的数字/方向（如多写一句把别的年级数字安上），按"关键信息错误"判错——宽容只针对形式，不针对事实。
- 下列每道写作题的"应该判对/应该判错"用例即测试用例，程序侧实现判分时**逐个提交验证**，用例不过不算判分完成。用例里的答案写法均为孩子视角的真实写法，不许改成标准答案再测。

### 写作①（步骤 18，练习阶段，写 2 句，材料 A）

- **任务**：选一个年级，按框架写 2 句：借书量句＋涨跌句。
- **判定维度**（只看这三项）：①所选年级的借书量数字与材料 A 一致；②涨跌方向与材料 A 一致；③写了百分比时，百分比数字与材料 A 一致。
- **算对例子（总则版）**："Grade Eight borrowed 1,250 books in October. It went up 20% from September."（三项全对）
- **算对例子（语法错不判）**："Grade 8 borrow 1250 books. It go up 20%."（数字与方向对 → 判对；时态问题只在反馈里顺带提醒一句，不扣）

**应该判对（测试用例，逐个提交应判 correct；标②的应判"对，拼写需注意"）：**

| # | 答案写法 | 为什么判对 |
|---|---|---|
| 1 | Grade Eight borrowed 1,250 books in October. It went up 20% from September. | 标准全对 |
| 2 | Grade Seven borrowed 850 books in October. It went up 5% from September. | 换年级，三项全对 |
| 3 | Grade Nine borrowed 640 books in October. It went down 10% from September. | 换年级＋down |
| 4 | grade eight borrowed 1250 books in october. it went up 20% from september. | 大小写全错、无千分逗号——不判 |
| 5 | Grade 8 borrow 1250 books. It go up 20%. | 动词原形、go/went 混用——关键信息对 |
| 6 | Grade Eight borrowed one thousand two hundred and fifty books in October. It went up twenty percent from September. | 数字、百分比写英文——不考拼写 |
| 7 | Grade Eight borrowed 1,250 books in October. The number went up 20 percent. | percent 写全、换主语说法——方向与数字对 |
| 8 | Grade Nine borrowed 640 book in October. It went down 10 percent from September, I think. | 单复数错＋多写无关词——不判 |
| 9 | It went down 10% from September. Grade Nine borrowed 640 books in October. | 两句换序——语序不判 |
| 10 | Grade Seven borrowed 850 books in October, and it went up 5%. | 合并成一句、没写 from September——关键信息（数字＋方向＋百分比）齐全 |
| 11 | Grade Eight borrowed 1250 books. It went up 20 per cent. | per cent 写法、省略 October——关键信息对 |
| 12 | Grade Eight borrowed 1,250 books in Octber. It went up 20% from September. | ②：Octber 拼错，但数字与方向全对——判对，记"拼写需注意：October" |

**应该判错（测试用例，逐个提交应判 wrong，反馈按括号执行）：**

| # | 答案写法 | 为什么判错 |
|---|---|---|
| 1 | Grade Eight borrowed 1,250 books in October. It went down 20% from September. | 方向反（反馈：数字对了，方向回材料 A 对 Grade Eight 那一行） |
| 2 | Grade Eight borrowed 980 books in October. It went up 20% from September. | 数字不是材料 A 任何一行（反馈：回表格对数字） |
| 3 | Grade Seven borrowed 1,250 books in October. It went up 5% from September. | 数字张冠李戴：1,250 是八年级的（反馈：先对是哪一行的数字） |
| 4 | Grade Eight borrowed many books in October. It went up. | 没写具体数字（反馈：把表格里的数字写出来） |
| 5 | Grade Nine borrowed 640 books in October. It went up 10% from September. | 方向反：九年级是 down（反馈同 1） |
| 6 | Grade Eight borrowed 1,250 books in October. | 只写了第一句，涨跌句缺失（反馈：还要写一句涨了还是跌了） |

- **中文作答**：如"八年级借了 1250 本书，涨了 20%"——内容三项全对时，内容理解记"独立完成"，英文书写记"有帮助完成"，页面提示用英文框架重写一次（沿用统一规则，英文书写记入下节课复习弱点）。

### 写作②（步骤 35，验证阶段，写 3 句，材料 B＋材料 C）

- **任务**：按框架写 3 句：第①句班级得分（材料 B）、第②句总分涨跌（材料 B）、第③句经费（材料 C，三项任选一项，取 This term 的数）。
- **判定维度**（逐句看）：每句的数字与材料一致；涉及涨跌的句子方向与材料一致；百分比数字一致。名次（first place）不作判定维度（不考排名）。
- **算对**：3 句关键信息全部正确。
- **算错**：任一句数字或方向错 → 整题判错；反馈只指出是哪一句、哪一项信息有问题、去对照哪份材料，**不给正确答案**（验证阶段）。孩子可重答一次：重答对记 correct_retry/wrong_retry 语义沿用既有规则，不算独立完成；两次仍错按既有出口进结尾（记未独立完成）。
- **算对例子**："Class Two got 92 points. The points went up 15% from last year. We will spend 650 yuan on new books this term."
- **算错例子**："Class Two got 92 points. The points went down 15% from last year. We will spend 650 yuan on new books this term."（第②句方向反 → 错，反馈："第②句再对照材料 B 'from last year'那句"）

**应该判对（测试用例，逐个提交应判 correct；标②的应判"对，拼写需注意"）：**

| # | 答案写法 | 为什么判对 |
|---|---|---|
| 1 | Class Two got 92 points. The points went up 15% from last year. We will spend 650 yuan on new books this term. | 标准全对 |
| 2 | Class One got 86 points. The points went up 15% from last year. We will spend 300 yuan on headphones this term. | 换班、换经费项，三句全对 |
| 3 | Class Three got 78 points. The points went up fifteen percent from last year. We will spend 160 yuan on paper this term. | 百分比写英文；paper 取 This term 的 160 |
| 4 | class two got 92 points. the points went up 15% from last year. we will spend 650 yuan on new books this term. | 全小写——不判 |
| 5 | Class Two get 92 point. Points went up 15%. We spend 650 yuan for new books. | get/point 单数、spend 原形、for 介词、缺 from last year——关键信息对 |
| 6 | Class Two got ninety-two points. The points went up 15 percent from last year. We will spend six hundred and fifty yuan on new books this term. | 数字写英文——不考拼写 |
| 7 | We will spend 650 yuan on new books this term. Class Two got 92 points. The points went up 15% from last year. | 三句换序——语序不判 |
| 8 | Class Three got 78 points. The points went up 15% from last year. We will spend 300 yuan on headphones this term, I think. | 多写无关词——不判 |
| 9 | Class One got 86 points! The points went up 15% from last year! We will spend 160 yuan on paper this term! | 感叹号标点——不判 |
| 10 | Class Two got 92 points. The points went up by 15% from last year. We will spend 650 yuan on new books. | 多 by、第③句没写 this term——关键信息对 |
| 11 | Class Two got 92 points. The points went up 15% from last yer. We will spend 650 yuan on new books this term. | ②："last year"拼成"last yer"，关键信息（92、up、15%）全对——判对，记"拼写需注意：year" |

**应该判错（测试用例，逐个提交应判 wrong，反馈只指句序与出处，不给答案）：**

| # | 答案写法 | 为什么判错 |
|---|---|---|
| 1 | Class Two got 92 points. The points went down 15% from last year. We will spend 650 yuan on new books this term. | 第②句方向反 |
| 2 | Class One got 92 points. The points went up 15% from last year. We will spend 650 yuan on new books this term. | 第①句数字张冠李戴（92 是 Class Two 的） |
| 3 | Class Two got 92 points. The points went up 15% from last year. We will spend 500 yuan on new books this term. | 第③句用了 Last term 的 500，不是这学期的 |
| 4 | Class Two got 92 points. The points went up 50% from last year. We will spend 650 yuan on new books this term. | 百分比数字错（50% 不是材料里的数） |
| 5 | Class Two got many points. The points went up from last year. We will spend some yuan on new books this term. | 三句都没具体数字——关键信息缺失 |
| 6 | Class Three got 78 points. The points went up 15% from last year. | 只写两句，缺第③句经费——不完整判错 |

- **不判错的**：同写作①（语法小错、大小写、标点、数字格式、语序、无关词）。
- **中文作答**：三句内容全对 → 内容理解记"独立完成"、英文书写记"有帮助完成"，提示用英文框架重写；英文书写记入下节课复习弱点。

## 七、"核对播报稿"题型设计（本课新增）

- **呈现**：给一份站长写好的播报稿（3 句，每句一个编号），稿中埋 1 处错误（数字错或涨跌方向错）；对应材料同时常显在旁，孩子逐句对照。
- **作答分两步**：第一步选择题"哪一句错了"（步 16、33）；第二步简答"把错句改对"（步 17 改数字、步 34 改方向，带句框，只填/改关键处；判分按宽容规格）。
- **能力衔接**：第 1 课核对通知、第 2 课追踪更新，都是"把稿子和依据对上"；本课把对象换成数字与涨跌，错误从"旧信息"变成"数字抄错/方向写反"。
- **防凑数说明**：这一步的用时来自逐句核对（读 3 句＋回材料逐项比对），不是答题本身；练习阶段错在"数字"（步 16–17），验证阶段错在"方向"（步 33–34），难度递进。

## 八、难度与降级方案（规范二·连错两次自动降一级；内容侧预先标注，程序侧调用）

规则：练习阶段同一题连错 2 次，除三级提示升级外，题目形态自动降一级（按下表换成更小的题再考同一个点）；验证阶段不降级、不给答案，连错 2 次按既有出口记未独立完成、进下一题。

| 步 | 题 | 难点 | 降级版本（连错 2 次后出） |
|---|---|---|---|
| 12 | 听力辨音 fifteen/fifty | teen/ty 尾音听不清 | 选项 4→2（只留 fifteen/fifty），音频再放一遍；仍错则出示两句对比文字让孩子读出声再选 |
| 14 | 听力填空 3 空 | 一遍听写三个数 | 改成逐空选择：每个空给 3 个数字选一个（听完再选） |
| 16 | 核对稿选错句 | 三句逐句比对 | 改成逐句判断：只出第②句问"这句对吗"（对/错两选） |
| 17 | 改错写整句 | 要自己写出 640 的整句 | 改成选择题：两个整句二选一（640 版 vs 680 版） |
| 18 | 写作① 2 句 | 从零写句子 | 改成选句：给 3 个整句选写得对的（数字/方向各埋一处错） |
| 24 | went up 15% 验证 | 方向＋百分比双信息 | 不降级（验证）；错 1 次只给方向提示，错 2 次进下一题 |
| 27 | 听力辨音（验证） | 同 12，但验证阶段 | 不降级；连错 2 次记未独立完成 |
| 29 | 听力填空（验证） | 同 14，但验证阶段 | 不降级；连错 2 次记未独立完成 |
| 33 | 核对稿（验证） | 同 16，但验证阶段 | 不降级；连错 2 次记未独立完成 |
| 34 | 改错写整句（验证） | 方向词填写 | 降为二选一：went ___ 里选 up / down（只考方向，不写整句） |
| 35 | 写作② 3 句 | 三句全写 | 先高亮三个句框的空位再写；仍连错 2 次 → 本题记未独立完成进结尾，不在原地卡住 |

## 九、"示范 → 带着做 → 自己做"三段检查（规范第 1 条）

| 新知 | 示范（老师先做给孩子看） | 带着做（有支架/即时反馈地做） | 自己做（撤支架、换材料） | 验证（第二天，只考不教） |
|---|---|---|---|---|
| percent | 步 7：站长读示范句"Grade Seven went up 5 percent"，讲"每一百个里有几个" | 步 11（对材料 A 选涨跌＋百分比，错项反馈点名串行/方向）→步 14（听填空填 %，可重听） | 步 18 写作①第②句自己写"went ___ ___%" | 步 24（up 15%）、步 30（听后 up 20%）、步 35 写作②第②句 |
| go up / go down | 步 7：例句 Books went up 5% / The price went down，配"变大/变小"动作说法 | 步 11（同上，方向题）→步 15（听后选 up 8%，错项反馈点方向词） | 步 17（改错句里写对方向——练习段改数字、方向在反馈中带）＋步 18 写作 | 步 24、步 30、步 32（经费哪项涨了）、步 35 写作② |

- 结论：两项新知三段齐全，无"直接自己做"的跳步。排名与大数字不入表（只在步 8 给"看原文找"的方法，不教、不考写）。
- 第 2 课的教训已吸收：第 19 步式复合任务（听＋回想＋分辨＋合并＋书写）在本课被拆开——听（14/29）、选（15/30）、核对（16/33）、写（18/35）各成一步，最后才合并输出。

## 十、课末家长一句话报告（规范第 8 条）

- **生成时机**：步骤 36 结尾后，服务端按本课两天 attempts 与 lesson_state 自动生成，显示在课末页（并进家长可见入口，位置实现阶段定）。只说事实，不写"很棒/继续努力"类空话。
- **模板**："第 3 课《数据播报》：学会了[按独立完成的题型列 1–2 项，如'读百分比、听数字']；[第一天或验证阶段错得最多的题型，如'听辨 fifteen/fifty']还不太稳，下节课开头会先复盘；全课用了约[X]分钟（第一天约[a]分钟、第二天约[b]分钟）。"
- **数据来源**：学会了什么＝独立完成（independent）题的题型集合；哪里还弱＝本课错因 TOP1（按题型聚合错次，含"拼写需注意"累计）；用了多久＝两天作答时间戳跨度（无数据时写"用时未记录"，不编）。
- **例子**：
  - 全对版："第 3 课《数据播报》：学会了读百分比和涨跌播报；这课没发现明显弱项；全课用了约 55 分钟（第一天 28 分钟、第二天 27 分钟）。"
  - 有弱项版："第 3 课《数据播报》：学会了核对播报稿里的数字；听辨 fifteen 和 fifty 还不太稳，下节课开头会先复盘；全课用了约 60 分钟（第一天 30 分钟、第二天 30 分钟）。"
  - 中途版（只上完第一天）："第 3 课《数据播报》第一天已完成：练了读数字和听数字；验证阶段还没上，弱项等上完再看。"

## 十一、硬规则自查

- **新知只在练习阶段教**：percent、go up/down 只在步骤 7 教（带示范句），步骤 10–18 练；验证阶段（20–36）无讲解新知的步（步 21、22 复盘只考第一天教过的）。排名、大数字只在步骤 8 给"看原文找"的提示，不教、不考写（步骤 25、26 是材料查找题，答案在原文里）。
- **一步只做一件事**：每题只考一个点；写作输出前有阅读、听力、辨音、核对分步练习（第九节），没有第 2 课第 19 步式的复合任务。
- **三级提示与出口**：练习阶段求助 1 指方向、2 高亮同屏材料原句、3 给答案讲原因（记有帮助完成）；连错 2 次另按第八节降级；验证阶段只指方向，连错 2 次记未独立完成进下一题。每一步都有出口。
- **答案位置**：见第一节统计表（A/B/C/D 各 3、最长连续 2、无固定间隔、正确项不总是最长）。
- **反馈防剧透**：练习阶段反馈只引用材料 A 与已播音频；验证阶段反馈只引用已出现材料（先 B 后 C，步 32 前不提材料 C 的数），不提后续步骤，未给答案的选择题反馈只指方向。写作②反馈不给答案。
- **反馈用孩子的语言**：无 v1/v2/v3、无"漏项/作废"等术语；错在哪就说哪（如"那是稿子里的错数字，回材料 A 表格里 Grade Nine 那一行看"）。
- **选项防剧透**：各选择题选项不含后续材料（B、C、音频 B2）的信息；步骤 26 的干扰项只说"那是别的班的"，不点名是哪个班。
- **过渡页**：步骤 20 只放过渡文案，无"最终信息"类备注上页面。
- **材料形式写明**：见第二节表格（每份材料/音频在哪一步、什么形式）。
- **文案纪律**：开场（步 1）、复盘引入（步 2）、晨间复盘引入（步 21 前）、结尾（步 36）全部按真实数据动态生成，只表扬具体行为（如"上次的通知追踪你全对，时间线很稳"），不写死空话；措辞用"第一天/上次"，不用"昨天"。
- **判分宽容**：第六节总则＋每题 10 对 5 错用例；拼写小错单记"拼写需注意"（算对、记弱点）。
- **中文与完整句**：简答/写作对完整英文句友好；中文作答按统一规则拆分记录（见第六节）。
- **听力规则**：音频先听后看（步 12、27 无文字；填空音频文字稿在作答后显示核对）；填空不考拼写。

## 十二、待定事项

1. **超纲词待核对**：percent（核心新知，按大纲教）、points（分）、thousand（只在音频与数字中出现，不考写）、first place、spend、favourite——等课本 Unit 2 单词表照片核对后定；超纲的加中文注释后再上。
2. **复盘题占位**：步骤 2–5 的引入语已按规则写好（有错/无错两版），步骤 3–5 的具体题目待孩子第 2 课错因数据回传后定题，并补答案位置统计；步骤 21–22 晨间复盘待第一天（本课）错因数据，实现阶段按第四节的题型池定题并补统计。
3. **音频**：需英文播报 4 段（A1、A2、B1、B2，Warm Pebble，120–130 WPM，响度沿用既有标准）；讲解步是否配音随音频清单一起定。
4. **判分实现**：第六节两个写作规格的 11 对＋6 错用例、听力填空"数字等值"判定（逗号、% 可选、英文数字词）、改错题关键词判定，实现阶段落成判分逻辑并逐例加回归测试；"拼写需注意"的判定边界（与关键信息拼错的区分）实现时按总则细化并补用例。
5. **降级与自动升级实现**：第八节降级版本、三级提示自动升级（连错 2 次→L2、第 3 次求助→L3）、家长报告生成，均在实现阶段落地，内容侧只给规格。
6. **材料数值**：借书量、比分、经费均为本课虚构练习数据，非真实校内数据；上线前请确认无敏感含义。

## 十三、预判错法（真人老师式纠错·上线前预判）

> 孩子画像：初二，基础很弱，中考 140 分约 30 分水平，粗心，会用中文答。
> 每条反馈只说她实际写错的地方，不提她没写的具体值；dim_help 供“带着做”按失败维度拆小步。

### 步骤 4（short·拼写 notice）

1. 错写“news”【不会这个知识】→“news 是“新闻”没错，但题目要的是“通知”，第 1 课讲过的那个词，想想怎么拼。”
   【下一批·30 秒小讲解】
 - 示范：“notice 是“通知”，news 是“新闻”。”
 - 带着做：“广播站门口贴的是 notice 还是 news？”
 - 自己做：“把“通知”拼出来。”
   【当场小检查】(1)notice 是什么意思？；(2)news 是什么意思？
2. 错写“message”【不会这个知识】→“message 是“消息”没错，但题目要的是“通知”，不是消息。”
   【下一批·30 秒小讲解】
 - 示范：“message 是“消息”，notice 是“通知”，两个词不一样。”
 - 带着做：“老师发的是通知，用哪个词？”
 - 自己做：“把“通知”拼出来。”
   【当场小检查】(1)message 是什么意思？；(2)“通知”英文是哪个词？
3. 错写“poster”【不会这个知识】→“poster 是“海报”，题目要的是“通知”。”
   【下一批·30 秒小讲解】
 - 示范：“poster 是“海报”，notice 是“通知”，两个词不一样。”
 - 带着做：“贴在门口的是通知，用哪个词？”
 - 自己做：“把“通知”拼出来。”
   【当场小检查】(1)poster 是什么意思？；(2)“通知”英文是哪个词？
4. 错写“letter”【不会这个知识】→“letter 是“信”没错，但题目要的是“通知”。”
   【下一批·30 秒小讲解】
 - 示范：“letter 是“信”，notice 是“通知”。”
 - 带着做：“题目要的是通知，不是信，用哪个词？”
 - 自己做：“把“通知”拼出来。”
   【当场小检查】(1)letter 是什么意思？；(2)“通知”英文是哪个词？

### 步骤 14（short·听填三个数）

1. 错写“2740, 18%, 1250”【不会这个知识】→“百分之几听错了，再听一遍 up 后面那个数，注意尾巴是长还是短。”
   【下一批·30 秒小讲解】
 - 示范：“eighteen 尾巴长（-teen），eighty 尾巴短（-ty），先听尾巴。”
 - 带着做：“播报里这个数尾巴长还是短？”
 - 自己做：“13 是 thirteen 还是 thirty？”
   【当场小检查】(1)15 是 fifteen 还是 fifty？；(2)80 是 eighty 还是 eighteen？
2. 错写“2740, 1250”【粗心】→“少写了一个数：比 9 月涨了百分之几？”
3. 错写“2740, 8%, 850”【没看到材料】→“850 是七年级的，再听一遍借得最多的是哪个年级。”
4. 错写“2740”【粗心】→“只写了第一个数，后面两个数接着听写下来。”
5. 错写“2740, 8%, 640”【没看到材料】→“640 是九年级的，借得最多的是哪个年级？”

### 步骤 17（short·改错句 640）

1. 错写“Grade Nine borrowed 680 books in October.”【粗心】→“680 就是稿子里写错的那个数，照着数据改过来。”
2. 错写“Grade Nine borrowed 850 books in October.”【没看到材料】→“850 是七年级的，看准 Grade Nine 那一行。”
3. 错写“Grade Nine borrowed 460 books in October.”【粗心】→“数字看错了，再看一遍 Grade Nine 那一行的数。”
4. 错写“Grade Nine borrowed 604 books in October.”【粗心】→“两个数字写反了，再看一遍 Grade Nine 那一行的数。”

### 步骤 18（short·写 2 句播报）

1. 错写“Grade Eight borrowed 1,250 books in October.”【粗心】→“第一句对了，第二句还没写：涨了还是跌了，百分之几？”
2. 错写“Grade Eight borrowed 1,250 books in October. It went down 20% from September.”【粗心】→“方向写反了，对照数据看 1,250 比原来多还是少，再定是 up 还是 down。”
3. 错写“Grade Seven borrowed 1,250 books in October. It went up 20% from September.”【没看到材料】→“1,250 不是七年级的，数字和年级对不上，回去对一下数据。”
4. 错写“Grade Eight borrowed 1,250 books in October. It went up 10% from September.”【没看到材料】→“百分之几不对，回数据里看 Grade Eight 那一行写的是百分之几。”
5. 错写“Grade Eight borrowed books in October. It went up from September.”【粗心】→“两句的框架都有了，数字还没填：多少本、百分之几？”

### 步骤 22（short·up 25%）

1. 错写“The milk went down 25% from last term.”【粗心】→“方向反了：400 到 500 是变多了还是变少了？”
2. 错写“The milk went up 20% from last term.”【粗心】→“方向对了，百分之几再算：多出来的 100 瓶占 400 瓶的多少？”
3. 错写“The milk went up from last term.”【粗心】→“涨跌写对了，百分之几还没写，补上。”
4. 错写“The milk went up 125% from last term.”【不会这个知识】→“125% 是涨完之后一共的，“涨了”百分之几只算多出来的那部分。”
   【下一批·30 秒小讲解】
 - 示范：““涨了 25%”是多出来的占原来的 25%，不是一共的。”
 - 带着做：“400 涨到 500，多出来多少？占 400 的多少？”
 - 自己做：“300 涨到 360，涨了百分之几？”
   【当场小检查】(1)200 涨到 250，涨了百分之几？；(2)“涨了 50%”和“一共是 150%”一样吗？

### 步骤 29（short·听填三个数）

1. 错写“240, 12%, 92”【粗心】→“百分之几听错了，再听一遍 up 后面那个数，仔细听尾巴。”
2. 错写“240, 92”【粗心】→“少了一个数：比去年涨了百分之几？”
3. 错写“240, 20%, 29”【粗心】→“这个数听错了，再听一遍 Class Two 的分数，仔细听。”
4. 错写“240, 20%, 86”【没看到材料】→“86 是 Class One 的，得第一的是哪个班？”
5. 错写“240”【粗心】→“只写了第一个数，后面两个接着听。”

### 步骤 34（short·改错 up）

1. 错写“The points went down 15% from last year.”【粗心】→“down 就是稿子里写错的那个词，改成反方向的词。”
2. 错写“The points went ups 15% from last year.”【粗心】→“up 不加 s，直接写 up。”
3. 错写“The points went upper 15% from last year.”【不会这个知识】→“upper 是“更高的”的意思，这里直接用 up。”
   【下一批·30 秒小讲解】
 - 示范：“up 就是“涨”，不加 er，直接用 up。”
 - 带着做：“第 ③ 句要填的是 up 还是 upper？”
 - 自己做：“把“The points went ___ 15%”填完整。”
   【当场小检查】(1)up 加不加 er？；(2)把句子填完整。
4. 错写“The points went rise 15% from last year.”【不会这个知识】→“rise 也是“涨”的意思，但这道题考的是 go up，用 up。”
   【下一批·30 秒小讲解】
 - 示范：“表示涨，这课用 go up：The price went up。”
 - 带着做：“跌了用 go down，那涨了用什么？”
 - 自己做：“把“The points went ___ 15%”填完整。”
   【当场小检查】(1)“涨”在这课里用哪个词？；(2)把“The milk went ___ 25%”填完整。

### 步骤 35（short·写 3 句播报）

1. 错写“Class Two got 92 points. The points went up 15% from last year.”【粗心】→“还少一句：第 ③ 句去经费表里选一项写。”
2. 错写“Class Two got 92 points. The points went down 15% from last year. We will spend 650 yuan on new books this term.”【粗心】→“第 ② 句方向反了：from last year 那句写的是 up 还是 down？”
3. 错写“Class One got 92 points. The points went up 15% from last year. We will spend 650 yuan on new books this term.”【没看到材料】→“92 分不是 Class One 的，得第一的是哪个班？”
4. 错写“Class Two got 92 points. The points went up 15% from last year. We will spend 500 yuan on new books this term.”【没看到材料】→“500 是上学期的旧数字，经费表里这学期写的是多少？”
5. 错写“Class Two got 92 points. The points went up 15% from last year. We will spend 650 yuan on paper this term.”【没看到材料】→“650 元对应的是经费表里的哪一项，再对一下。”

