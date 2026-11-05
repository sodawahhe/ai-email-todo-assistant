# Changelog — Academic Assistant (Apps Script v1)

> **已冻结（2026-10-13）**：后续开发在 `../v4-apps-script/`，改动日志见那边的 CHANGELOG.md。本文件不再修改。

## v1.8 — 2026-10-13（简报瘦身 + 过期内容根治）

项目停维约两个月后用户反馈：简报被非课程内容和过期通知淹没；邮件正文里 8 月初的通知
被标成 10 月的日期；Ed 区块全是过期帖；侧边栏标签太多。

### 根因：相对日期按"今天"解析，而不是按"写出那天"

`parseDeadline(raw, today)` 的锚点是运行时的今天。8 月帖子里的 `Wednesday 12:00 PM`
在 10 月跑简报时被解析成"这周三"，于是 2 个月前的帖子带着 10/14 的日期混进 48h 桶。
同类问题还有三个，都在 `08_DateParser.gs`：

1. **原文自带完整日期仍被星期几带偏**：`Saturday 12:00 AM (2026-08-15)` 被解析成"下一个周六"。
   现在原文含 `YYYY-MM-DD` 就直接用它。
2. **不带年份的日期被解析成 2001 年**：V8 的 `new Date("Aug 5")` 补的是 2001，而 `> 2000`
   的合法性检查放行了它——这类日期一直被当成"2001 年的过期任务"悄悄丢掉。现在原生解析
   只信任原文带 4 位年份的字符串。
3. **`10th September 2026 @23:55` 解析失败**（序数词 + `@`）后走 AI 兜底，而 AI 提示词
   要求"过去日期推到下一次出现"。现在预处理去掉序数词和 `@`；AI 提示词改为按每条自带的
   `written`（写出日期）解析，明确日期不得推到未来。

另外无年份日期的"已过去就推明年"规则改为"落后参照日超过半年才推明年"，否则几天前的
日期会变成明年同日，在"之后"桶里冒充远期任务。

#### 修复
- `batchParseDeadlines(rawList, refs)`：每条任务带自己的参照日 `refDate`
  （Ed = 发帖时间，Gmail = 任务入库时间）；缺失时才退回当前时间
- `_collectGmailTasks` / `_collectEdTasks` 填 `refDate`
- 简报里每条待办的日期旁显示"发布 MM/dd · 原文 “…”"，解析结果是否可信一眼可核对

### 1. 非课程内容分类

- `buildTodoList()` 给每条待办打 `category`：本学期课程 = `course`；其余命中
  `TODO_CONFIG.CAREER_PATTERN` = `career`（实习/求职）；再其余 = `campus`（校园活动）
- 课程待办保持原来的 逾期/48h/本周/之后 分桶，`total` / `urgentCount` / 邮件主题的
  `[48h:N]` 只算课程
- 非课程待办进 `todo.extras`：简报里排在课程之后，只收 逾期/48h/本周，每类最多
  `EXTRA_LIMIT`=5 条，超出提示"还有 N 条，见仪表盘"；仪表盘完整显示两类
- 课程判定统一为 `isConfiguredCourse()`（`USER_CONFIG.COURSES` 是唯一依据），取代
  `04_SheetsWriter.gs` / `07_TodoList.gs` 各自复制的一份。副作用：Gmail 里被 AI 标成
  往学期课程代码（如 FIT5197）的任务不再冒充课程待办
- `FIT5230` 关键词删掉裸 `phan`（会命中 Stephanie / elephant 等，把无关邮件误归到课程）

### 2 + 3. 过期内容清理（邮件正文 + Ed 区块）

- **Ed 区块**：之前标题写"近 30 天"，实际 `getRecentEdPosts(…, minDate)` 里 `minDate`
  覆盖了时间窗口，等于"7 月 25 日以来的全部"，再加置顶优先排序、带截止日期的置顶帖永不
  衰减——老帖把新通知挤出 15 条上限。现在：
  - 只列最近 `ED_CONFIG.RECENT_DAYS`=7 天发的帖，最新在前，上限 `DIGEST_LIMIT`=10
  - 有可解析截止日期的帖子不在这里重复（已在 To-Do，带完成/忽略按钮）
  - 在 To-Do 里点过完成/忽略的帖子不再出现
  - 每条显示发帖日期；摘要和要点做 HTML 转义
- **邮件正文**删掉四块冗余内容：
  - "紧急任务 / 本周任务"两张 AI 卡片：和 To-Do 完全重复，且喂给 AI 的是未过滤的任务表
  - "今日邮件更新"：`cacheEmailSummary` 从未被调用，这张卡永远是"暂无新邮件"
  - 问候语 / 提示语：每天白烧一次 AI 调用
  - 每条待办上的 H/M/L 置信度圆点（几乎全是 H，没有信息量；数据仍在表里）
- To-Do 构建失败时简报显示红色错误卡并在主题标 `[待办生成失败]`，不再静默发出一封空简报

### 4. 标签

- `applyEmailLabels`：课程标签只给 `USER_CONFIG.COURSES` 里的课程打，不再"AI 返回什么
  就建什么"。`COURSE_ALIASES` 的 S1 条目清空
- 新增 `previewOldCourseLabels()`（只列清单 + 每个标签的邮件数）和
  `cleanupOldCourseLabels()`（摘除 `Academic/<课程代码>` 且不在本学期配置里的标签）
- ⚠️ 只摘标签，**邮件本身不删、不移动**；`⭐Important` / `Low Priority` / `Processed` 不动。
  需要用户在编辑器里手动先 preview 再 cleanup，脚本不会自动执行

### 删除的死代码

`03_ClaudeAPI.gs`（无人调用）、`09_StudentFAQ.gs` 及 Ed Student Posts 相关函数
（v1.5.2 起已禁用）、`generateDigestContent` / `_generateDigestFallback` /
`getPendingTasks` / `getRecentEmailSummaries` / `cacheEmailSummary` / `_buildFaqHtml`、
重复的 `getApiKey`、`ENABLE_STUDENT_FAQ`、`PINNED_STALE_DAYS`。
`buildDigestHtml` 签名 `(d, dateStr, emailCount, taskCount, edPosts, todo, faqs)`
→ `(dateStr, edPosts, todo, todoError)`。

### 验证

- 本地用 node 在 vm 里加载真实 `.gs` 源码跑断言，全部通过：
  - 8/10 的帖子里的 `Wednesday 12:00 PM` → 08/12；同样的 `Friday` 以 10/12 为参照 → 10/16
  - `Saturday 12:00 AM (2026-08-15)` → 08/15；`10th September 2026 @23:55` → 09/10 23:55
  - `Aug 5`（10 月参照）→ 今年 08/05 而不是 2001 年；`Jan 5`（12 月参照）→ 次年 01/05
  - 8 月帖子的解析结果在 `_bucketize` 里被丢弃，不再进 48h 桶
  - 简报 HTML 冒烟渲染：分类卡片、限量提示、转义、Ed 课程名归一、错误卡
- 全部 `.gs` 通过语法检查

### 已知限制

- 本地规则解析不了、靠 AI 兜底的截止日期，如果 AI 解析出结果，这条帖子会同时出现在
  To-Do 和 Ed 区块（Ed 区块只用本地规则判断"有无截止"）
- `Week 6 Sunday` 这类只会被解析成"发帖之后的第一个周日"，`Week N` 本身没有学期周历可对照
- 标签清理必须手动运行；Gmail 分类标签（Career / Campus）没有建——只在简报和仪表盘里分类，
  避免标签再变多

### 用户操作步骤

1. `clasp push`（有文件被删除，推送后远端同步移除）
2. 编辑器运行 `previewOldCourseLabels()`，核对清单 → 没问题再运行 `cleanupOldCourseLabels()`
3. `runDigestNow()` 看新简报；Ed 区块只剩最近 7 天的无截止帖
4. 想调整分类：改 `TODO_CONFIG.CAREER_PATTERN`；想多/少看几天 Ed：改 `ED_CONFIG.RECENT_DAYS`

---

## v1.7.1 — 2026-08-14（Ed token 修复后的两个追加问题）

v1.7 推送并让用户重新抓取 ED_TOKEN 后，Ed 同步恢复工作，但暴露出两个新问题：

### 问题 1：已下线课程借着别名死灰复燃

`runEdSync()` 意外拉回了 7 条 `FIT4005/FIT5125`（S1 已下线课程）的帖子。根因：
`_extractCourses`（06_EdDiscussion.gs）和 `getRecentEdPosts` 的 `_isCourseConfigured`
（04_SheetsWriter.gs）都在用 `COURSE_ALIASES` 的 key 额外放行课程，但 `COURSE_ALIASES`
的真实用途是给 `normalizeCourseCode()` 合并 Gmail 标签用的（`FIT4005 → FIT5125`），
不是"额外允许同步/展示的课程白名单"。`USER_CONFIG.COURSES` 里已经没有 FIT5125，
课程是否还在范围内应该只看这一份配置。

#### 修复
- `_extractCourses`、`getRecentEdPosts#_isCourseConfigured` 都去掉 `aliasKeys` 判断分支
- `_collectEdTasks`（07_TodoList.gs）之前**完全没有课程过滤**，只要带 deadline 就会进
  To-Do——新增同样的 `_isCourseConfigured` 检查，避免旧课程帖子借着 v1.7 刚加的日期
  过滤（帖子是今天同步写入的，日期检查会放行）漏进 Todo 列表

### 问题 2：Ed 摘要啰嗦，标题和内容重复

用户反馈"Welcome!"这类无实质行动项的置顶帖，AI 摘要依然展开成 2-4 句 + 4 条要点，
把标题的意思换个说法重复一遍，浪费 token 也浪费阅读时间。同时开学第一周的置顶帖
（如 Welcome）会一直占位在简报里，因为置顶帖没有"过期"机制。

#### 修复（06_EdDiscussion.gs / 04_SheetsWriter.gs / 00_Config.gs）
- AI 提示词里 `has_action` 字段的语义收紧为"是否有具体行动项"，并明确要求
  `has_action=false` 时摘要压缩到一句≤25字的极简概括、`key_points` 返回空数组
- `_composeEdSummary` 之前完全没用到 `has_action` 字段（AI 已经在返回，只是被忽略）——
  现在 `has_action===false` 时只用一句话摘要，不拼接要点列表
- 新增 `ED_CONFIG.PINNED_STALE_DAYS = 14`：置顶帖发布超过 14 天且**没有硬截止日期**
  时不再进简报（`getRecentEdPosts` 里过滤，帖子仍留在 Ed Posts 表可查）。有截止日期的
  置顶帖（如作业规范）不受影响，因为那类内容不会"过时"
- 已经同步过的旧摘要（用户已看到的 4 条）不会被自动重新生成——`backfillEdSummaries`
  只补空摘要，不重跑已有摘要，避免不必要的 token 消耗；新同步的帖子会用新格式

### 验证
- 本地模拟 `_extractCourses` 匹配逻辑：5 门真实 Ed 返回课程中，S1 的
  `FIT4005/FIT5125` 不再被别名放行，S2 四门全部正常匹配
- 本地模拟置顶帖衰减过滤：开学第一周无截止日期的 Welcome 帖被过滤；有截止日期的
  作业规范帖、14 天内的近期置顶帖均不受影响
- 全部改动文件通过 `node --check` 语法校验

---

## v1.7 — 2026-08-12（四个用户反馈修复）

### 用户反馈的 4 个问题

1. 简报里还有上学期（S1，FIT5197/FIT5145）的任务，早该被 `MIN_TASK_DATE` 挡掉
2. Ed 的通知和消息完全没收录进来
3. 今日任务里混着已过期的 ddl，看不出哪些已经逾期
4. 点「完成」要等整页跳转，很累赘；且任务只有英文，容易偷懒不看

### 问题 1 的根因：一条完全绕过日期过滤的数据通路

`MIN_TASK_DATE` 本身和 `buildTodoList()` 那条路都工作正常，但用户看到的条目根本不
来自 To-Do 渲染器——`getPendingTasks()`（供「紧急任务」「本周任务」两张 AI 卡片使用）
的过滤逻辑只看 Status，**完全没有日期过滤**，Tasks 表里从建表至今每一条 Pending 行
都会被返回并拼进简报。

#### 修复（04_SheetsWriter.gs / 03_API.gs）
- `getPendingTasks()` 新增基于 `Date Added` 列的日期过滤，默认取 `TODO_CONFIG.MIN_TASK_DATE`
- **fail-closed**：日期为空或无法解析的行现在**一律排除**（之前是放行——这是残留的次要来源）
- 过滤后按 Date Added 降序排列，避免老行把新任务挤出 AI 提示词的 `slice(20)` 窗口
- AI 提示词补充今日日期与「不要引用早于本学期的日期」的显式约束
- `07_TodoList.gs` 里另外三处相同的 fail-open 日期比较（`_collectGmailTasks` /
  `_collectEdTasks` / `cleanupPreviousSemester`）统一改为 fail-closed

### 问题 2 的根因：Ed 链路任何一环失败都不产生可见信号

`runEdSync` 触发器本身注册正常，但 token 失效 / 课程代码零匹配 / 单课程拉取失败
都只 `Logger.log`，简报里 Ed 区块直接渲染成空字符串——用户完全看不出「这几天真没
重要帖」和「同步已经挂了」的区别。

#### 修复（06_EdDiscussion.gs / 05_DigestEmail.gs / 01_Main.gs）
- `syncEdDiscussion()` 成功/失败都把状态写入 Script Properties（`ED_LAST_OK` /
  `ED_LAST_ERROR`），供简报判断
- 课程匹配 0 门不再是静默成功，视为异常并记录 Ed 侧实际返回的课程代码，方便排查
  是配置问题还是 token 问题
- Ed 区块为空时，若最近有记录的错误、或距上次成功同步超过 24 小时，简报显示红色
  告警条（含具体原因 + 排查指引），不再是无提示的空白
- `testSetup()` 按函数名逐个校验触发器（之前只数总数 `>= 4`，`runEdSync` 缺失也能
  通过健康检查），并新增 Ed 同步最近状态一行

### 问题 3：逾期任务混在 48h 桶里，毫无区分

`_bucketize` 对负数 `diff`（已过期）恒满足 `diff < h48Threshold`，逾期任务和未到期
任务被塞进同一个桶，长得一模一样，还因为按 deadline 升序排在最上面。

#### 修复（07_TodoList.gs / 05_DigestEmail.gs / dashboard.html）
- 新增独立 `overdue` 桶，排在 48h 桶之前；`STALE_DAYS`（3 天）窗口不变，超过仍自动隐藏
- 每条逾期任务挂 `overdueDays`，简报和仪表盘都渲染「⚠️ 已逾期 N 天」红色徽章
- `urgentCount`（邮件主题 `[48h:N]`）现在把逾期任务也计入

### 问题 4a：点击「完成」很卡

`_doActionDone` 之前直接调 `_renderDashboard()`，会重跑整个 `buildTodoList()`
（重读两张表、重新解析 deadline、去重、整表重写 To-Do sheet）才出第一个像素。

#### 修复（10_WebApp.gs）
- 新增 `_actionResultPage()`：只做状态写入，不重跑 `buildTodoList`，秒开
- 任务标题带删除线变灰，1.5 秒后 `window.close()` 自动关闭标签页；浏览器拦截关闭时
  （对非脚本打开的标签页很常见）降级显示「可以关闭本页返回邮件了」提示
- 「↩️ 撤销」链接首次真正接入（之前 `_htmlPage` 的 `todoId` 参数是死代码，没有调用点传值）

### 问题 4b：任务行只有英文

`t.titleEn || t.titleZh` 二选一，英文优先；`titleZh` 字段其实一直都有，只是没渲染。

#### 修复（05_DigestEmail.gs / dashboard.html）
- 任务行改为中文粗体主行 + 英文灰色次行；两者相同或缺一时只渲染一行，不重复
- 覆盖简报所有桶（overdue/48h/week/later）和仪表盘

### 技术约束核实（影响问题 4a 的方案选择）

- Gmail 剥离邮件中的 `<script>`/`<form>`，项目也没用 AMP for Email——邮件里无法做
  到真正的「原地划线」，只能做到点击后打开的确认页尽量轻量
- Apps Script `doGet` 不能返回真图片（`ContentService` 无 IMAGE MIME），Gmail 又会
  预抓取远程 `<img>`——图片式打点方案会导致「打开邮件就被标记完成」，已排除
- 已投递邮件正文不可修改（Gmail API 消息不可变），不存在「原邮件重绘」的选项
- 本次改动未新增任何发送/删除邮件的行为，遵守既有的留痕原则

### 验证

22 项本地单测全部通过（对 `.gs` 源码直接抽函数体测，非副本）：
- `_bucketize` 逾期分桶 8 项：含用户三个真实案例、staleCutoff 边界、diff=0 边界
- `getPendingTasks` 过滤/排序 7 项：含 fail-closed 回归（空/无法解析日期必须排除）、
  向后兼容（无 cutoff 时行为不变）
- 双语渲染 5 项：两者都有/只有一个/相同/都空
- 逾期徽章文案 2 项

全部 11 个改动过的 `.gs` 文件逐一通过 `node --check` 语法校验；跨文件函数名冲突扫描
确认新增的 4 个函数名无重复声明（唯一发现的 `getApiKey` 重复是本次改动前就存在的）。

### 用户操作步骤

1. `clasp push --force`
2. **先跑 `testEdAuth()`**（编辑器里）—— 判断 Ed 完全空白是 token 失效还是课程匹配问题
3. `testSetup()` —— 确认触发器和 Ed 同步状态都正常
4. `runDigestNow()` —— 检查简报：S1 任务消失、逾期任务独立红色区块、任务双语、
   Ed 区块要么有内容要么有明确红色告警
5. 简报里点一次「✅完成」验证秒开 + 自动关闭

---

## v1.6 — 2026-08-10（S2 新学期 + Ed 置顶帖归纳）

### 用户反馈的 2 个问题

1. 新学期开学，四门新课，不再需要 7.25 之前的任务提醒和 Ed 提醒
2. Ed 老师发的帖（**尤其是置顶的**）没有提取内容发到邮箱，只有帖子列举没有归纳总结

### 问题 2 的根因（两个 bug 叠加）

**根因 A — 置顶帖被静默丢弃。** `_classifyEdPost` 从没读过 `is_pinned`（全项目 grep 无此字段）。
v1.5.2 为省 token 把 TA 帖并入 student 分支，而 `syncEdDiscussion` 对 student 帖是
**直接 continue、连表都不写**。于是「作者角色是 tutor/TA 的置顶帖」既不进 Ed Posts 表，
也不进简报 —— 不是摘要没生成，是帖子从头到尾就没被收录。

**根因 B — 摘要只在写入时生成一次。** `aiSummary` 仅在 `syncEdDiscussion` 里调 AI 后写入第 9 列，
外层 `catch` 只 log 不重试。任何一次 AI 报错 → 该帖摘要列永久为空 →
简报每天读到空字符串 → 永远只渲染一个光秃秃的标题。

### 修复

#### 置顶帖成为一等公民（06_EdDiscussion.gs）
- `_classifyEdPost` 新增 `pinned` 类型，**优先级高于作者角色**：`pinned > announcement > instructor > ta > student`
- 兼容 Ed 的两种字段写法（`is_pinned` / `pinned`）
- `ta` / `tutor` / `mentor` 恢复为独立 `ta` 类型，不再当学生帖丢弃
- 置顶帖 `aiPriority` 下限设为 `high`（老师置顶 = 整学期都重要）

#### 分级摘要策略（00_Config.gs `ED_CONFIG`）
- `pinned` / `announcement` / `instructor` → 一律调 AI 摘要
- `ta` → 先本地扫 `DEADLINE_KEYWORDS`（due/deadline/submit/week N/截止/提交…），命中才调 AI
- `student` → 完全不调（保留 v1.5.2 的省 token 收益）

#### 摘要内容真正「归纳」而非「列举」（`_extractEdTaskWithAI`）
- 提示词重写：要求 2-4 句中文归纳 + `key_points` 数组（最多 4 条硬信息：日期/分值/人数上限/提交方式）
- 明确禁止「老师发布了一条公告」这类无信息量的话
- 正文截断 2000 → 3000 字（置顶帖常是长篇作业规范，截太早会丢关键信息）
- 置顶帖在提示词里额外标注，要求格外仔细提取
- max_tokens 500 → 800

#### 摘要补写机制（`backfillEdSummaries`）—— 修根因 B
- 每次生成简报前自动跑：扫 Ed Posts 表里「该摘要但摘要列为空」的本学期帖，补调 AI 回填
- 每次最多补 `ED_CONFIG.BACKFILL_LIMIT`（默认 8）条，成本可控
- AI 某次失败不再是永久性的，下次简报会自动补上

#### 简报渲染（05_DigestEmail.gs）
- 摘要按 ` ▸ ` 拆成「正文段 + 要点列表」两部分渲染
- 置顶帖加 📌 标签 + 琥珀色左侧强调条
- 截止日期改为红底徽章，更醒目

#### 读取端放行（04_SheetsWriter.gs / 07_TodoList.gs）
- `getRecentEdPosts` 和 `_collectEdTasks` 的类型白名单加入 `pinned` / `ta`
  （v1.5.2 只放行 `announcement` / `instructor`，是置顶帖即使入表也不显示的原因）
- 简报 Ed 区块排序改为：置顶 > 公告 > 讲师 > 助教，同档内按时间降序
- To-Do 的 `titleZh` 去掉 ` ▸ 要点` 后缀，保持任务标题干净

### 新学期切换（S2 2026）

- `USER_CONFIG.COURSES` 换成四门新课：
  FIT5196 Data Wrangling / FIT5202 Data Processing for Big Data /
  FIT5230 Malicious AI / FIT9137 Computer Architecture and Networks
- `TODO_CONFIG.MIN_TASK_DATE`: `2026-04-27` → `2026-07-25`
- **Ed 课程 ID 无需手填**：`_extractCourses` 本来就按课程代码从 `/user` 接口自动匹配，
  改完 COURSES 的 key 后新学期 ID 自动解析（旧的 31659/33732/33706/33225 自然失效）
- 新增 `cleanupPreviousSemester()`（07_TodoList.gs）：把 Tasks / Ed Posts 表里
  早于 MIN_TASK_DATE 的 Pending 行批量标为「忽略 Ignored」
  - ⚠️ **只改 Status 列，不删除任何行、不动任何邮件**，旧数据全部留在表里可追溯
- `COURSE_ALIASES` 的 FIT4005→FIT5125 保留（旧邮件标签仍引用，删掉会破坏历史数据）

### 验证

44 项单元测试全部通过（对 .gs 源码直接抽函数测，非副本）：
- 分类 10 项：含「tutor 发的置顶帖」这一用户实际遇到的 case
- 摘要门控 9 项：含中英文截止关键词、助教闲聊不触发 AI
- 摘要合成 6 项：含 null / 缺字段 / 非数组的健壮性
- 简报渲染往返 2 项：` ▸ ` 拆分能无损还原正文和要点
- 课程识别 16 项：FIT9137 的 9xxx 前缀、带学期/校区后缀、Ed 课程自动匹配、日期切线

### 用户操作步骤

1. `clasp push`
2. 编辑器跑 `cleanupPreviousSemester()` —— 清掉上学期遗留待办（不删数据）
3. 跑 `runEdSync()` —— 拉新学期四门课的 Ed 帖（含置顶帖）
4. 跑 `runDigestNow()` —— 检查简报里置顶帖带 📌 标签和归纳内容

---

## v1.6.1 — 2026-08-10（补齐 S2 教学团队姓名）

用户提供了四门课的教学团队名单，补进 `USER_CONFIG.COURSES`，
用于识别**正文/主题里不写课程代码**的邮件（`detectCourse` 匹配 subject + sender）。

| 课程 | 教学团队 |
|------|----------|
| FIT5196 | （教学团队姓名已隐去） |
| FIT5202 | （教学团队姓名已隐去） |
| FIT5230 | （教学团队姓名已隐去） |
| FIT9137 | （教学团队姓名已隐去） |

### 匹配安全性

`detectCourse` 是**子串匹配、第一个命中即返回**，所以姓名一律写全名小写。
常见姓氏（`li` / `tan` / `ting` / `ge` / `leong`）**不单独作为关键词**，
否则任意一封来自同姓陌生人的邮件都会被误判成该课程。
例外只有 `phan`（（姓名已隐去））。

特别注意：S1 的 FIT5147 讲师 **（姓名已隐去）** 与 S2 的 **（姓名已隐去）** 同姓，
已加测试确保前者不会误命中 FIT5202。

### 验证

22 项检测测试全部通过（对 .gs 源码抽 `detectCourse` 实测）：
- 10 项：每位老师的姓名 + 邮箱能正确映射到所属课程（模拟无课号邮件）
- 3 项：课程代码/课程名匹配未被破坏
- 7 项：**误判探针** —— （姓名已隐去）、无关的 Li/Tan/Leong/George/"Wrong room"、非学术邮件均正确返回空
- 2 项：关键词跨课重复审计 + 子串碰撞审计，均为 0

---

## v1.5.2 — 2026-05-06（同步 + 链接 + 过滤）

### 用户反馈的 4 个问题

1. 链接打开仍是 Gmail 搜索页（v1.5.1 修复只影响新任务，旧任务的搜索 URL 还在）
2. 简报里点 ✅完成 → 跳到独立确认页 → 仪表盘还显示未完成（同步断层）
3. 学生 Ed 帖无价值，浪费 token，不应再提取
4. 旧任务（4-27 之前）仍在堆积，"无明确截止"区噪音多

### 修复

#### 同步：勾选完成立刻全局生效
- 新增 `_applyStatusEverywhere(todoId, status)` 替代裸 `_writeStatusToSource`
- 写主源 + 读 To-Do sheet 的「Merged IDs」列把所有合并的同义任务源**一起**改 Done/Ignored
- 顺便同步 To-Do sheet 当前行 Status 列，避免下次 buildTodoList 之前的中间状态错乱
- v1.5.1 加的合并源跟踪是只在下一次 buildTodoList 才生效，导致点完 Done 后仪表盘还显示同义任务为 Pending —— 这是这次修的核心 Bug

#### 仪表盘和确认页合二为一
- 点击 ✅完成 / ⏭️忽略 / ↩️撤销 不再跳到独立确认页
- 直接渲染仪表盘，顶部一条绿色 flash 横幅显示动作结果（如 `✅ 已完成 +10 XP`），3.5 秒后自动淡出
- 用户看到的不是"另一张静态页"，而是已经更新好的仪表盘本身（任务消失、进度条、XP、连胜全部刷新）

#### Gmail 直链改用 ?authuser=
- `thread.getPermalink()` 默认返回 `/u/0/`，多账号浏览器（学校账号是第二个登录的）会跳错号→ Gmail 落到搜索页
- 新增 `_gmailDirectLink(permalink, email)`：把 `/u/N/` 替换为 `?authuser=<email>`，强制路由到学校账号
- 搜索 URL 也补 `authuser` 参数

#### 一次性回填旧 Gmail 链接
- 新增 `fixGmailTaskLinks()`：遍历 Tasks 表所有 `#search/` 形式的旧链接，按 subject 搜回原邮件 thread，写入直链
- 找不到对应邮件的保留原搜索 URL（不破坏数据）

#### 4-27 硬切线
- `TODO_CONFIG.MIN_TASK_DATE = '2026-04-27'`
- `_collectGmailTasks` 跳过 Date Added 早于该日的行
- `_collectEdTasks` 跳过帖子日期早于该日的行
- `getRecentEdPosts(hours, minDate)` 第二参数支持硬日期；简报传入 `MIN_TASK_DATE`，让置顶/重要老师助教帖一直显示直到学期结束（不再是 24 小时滑窗）

#### 简报隐藏「无明确截止」桶
- `TODO_CONFIG.HIDE_NO_DEADLINE_IN_DIGEST = true`
- 简报里完全不渲染该桶（仪表盘仍可见）

#### 学生帖与 FAQ 全部禁用
- `06_EdDiscussion.gs`：学生帖完全跳过，不再写 `Ed Student Posts` 表
- `05_DigestEmail.gs`：移除 `extractStudentFAQs(24)` 调用和 FAQ 区块
- `TODO_CONFIG.ENABLE_STUDENT_FAQ = false`（标志位，09_StudentFAQ.gs 保留为死代码）

### 用户操作建议

1. 编辑器跑一次 `fixGmailTaskLinks()` —— 回填旧任务的 Gmail 直链
2. 编辑器跑一次 `cleanupNoDeadlineTasks()`（v1.5.1 的）—— 清掉 39 条无截止积压
3. 跑 `runDigestNow()` 看新简报：
   - Ed 区块包含 4-27 起的所有重要帖（不只 24h）
   - 无明确截止区不显示
   - 链接点击直接打开邮件/Ed 帖
4. 在简报里点 ✅完成 验证：新页面 = 仪表盘（不是确认页），任务已消失，flash 横幅显示 +10 XP

---

## v1.5.1 — 2026-05-05 晚（Todo 准确性修复）

### 用户痛点
1. 同一任务在「48 小时内」和「本周」两个桶里都出现；标记其中一个 Done 后另一个不变
2. 点 Todo 链接打开的是 Gmail 搜索页，需要手动二次筛选才能找到原邮件
3. 「无明确截止」桶有 39 条任务，绝大多数是改造前从学生帖标题误提取的噪音
4. 显然同义的任务没合并（`FIT5197 Avoid Generative AI` vs `FIT5197 Avoid Use of Generative AI`）

### 修复

#### Gmail 任务直链（02_GmailScanner.gs + 04_SheetsWriter.gs）
- `processMessage` 调用 `thread.getPermalink()` 获取真实 Gmail 直链
- `writeTasks` 接收 `threadUrl` 参数并写入 Sheet 第 13 列；找不到时回退到原搜索 URL（保护已有数据）
- 新生成的 Todo 点链接直接打开对应邮件，不再走搜索页

#### 跨桶去重（07_TodoList.gs）
- `_normTitle` 统一归一化：去 `FIT5197 ` 课程前缀、去停用词（the/a/of/use/to/for/...）、去标点、转小写。`Avoid Generative AI` 和 `Avoid Use of Generative AI` 归一化后完全一致
- `_isDuplicate` 改两档判断：标题相似度 ≥0.85 时跨 deadline 合并（修跨桶重复的根因），≥0.55 时还要 deadline 同一天才算
- 之前 `if (deadline 一边有一边没) return false` 的逻辑被移除——这是 48h/本周/无截止 之间互不去重的根因

#### 合并源跟踪 + 状态联动（07_TodoList.gs）
- `_dedupTodos` 把被合并掉的 todoId 记到保留项的 `_mergedIds` 数组
- `To-Do / 待办` Sheet 新增第 15 列 `合并来源 Merged IDs`，存合并 todoId 的 JSON
- `_syncStatusToSourceSheets`：用户标 Done/Ignored 时，**同时**把状态写到所有合并源 Sheet 行，避免"标记一个另一个又冒出来"

#### 陈旧无截止任务自动隐藏（07_TodoList.gs）
- 常量 `STALE_NO_DEADLINE_DAYS = 7`
- `_collectGmailTasks` 跳过：无 deadline + 添加超过 7 天的 Pending 行（多半是改造前误提取的旧噪音）
- 这些任务不会在 Todo 列表 / 简报 / 仪表盘里出现，但 Tasks Sheet 里仍保留可追溯

#### 一次性清理函数（07_TodoList.gs）
- `cleanupNoDeadlineTasks()` —— 把 Tasks Sheet 里所有「无截止 + Pending」的行批量改成「忽略 Ignored」
- 用户在编辑器里手动跑一次即可清掉那 39 条积压

#### 简报 noDate 桶限流（05_DigestEmail.gs）
- 简报里 `❓ 无明确截止` 桶最多显示 5 条
- 超过部分头部显示「另有 N 条」提示，完整列表去 Sheet/仪表盘看

### 用户操作建议
1. 编辑器里跑一次 `cleanupNoDeadlineTasks()`（一键清掉 39 条积压）
2. 跑 `runDigestNow()` 看新简报：跨桶重复消失、Gmail 直链可用、noDate 区简洁
3. 旧任务的链接还是搜索页（数据已写入），新邮件产生的任务才有直链

---

## v1.5 — 2026-05-05（仪表盘 + FAQ + 一键完成）

### 触发本次迭代的痛点
1. 私人 Google 账号那边也部署过同一份脚本，假期里它意外开始发简报，全是乱码。
2. 学生 Ed 帖大量出现在 Todo 和简报里，浪费 token，简报过长。
3. Ed 通知邮件不断进教育邮箱。
4. Sheet 打勾的 Todo 体验粗糙，简报里看到任务也无法直接完成。

### 新增

#### Web App 仪表盘（10_WebApp.gs + dashboard.html）
- 部署为 Apps Script Web App，给一个独立 URL，可加书签。
- 点 URL 看到实时仪表盘：进度条、🔥连胜、⭐XP、本周完成数；按 48h / 本周 / 之后 / 无截止 分桶展示。
- 仪表盘 UI 支持点击勾选完成（即时划线 + toast 反馈，异步触发后端写 Sheet）。
- URL 加 `token=` 鉴权，token 在 `setupTriggers()` 时自动生成并存到 Script Properties `WEBAPP_TOKEN`。
- 简报里每个 Todo 旁加 ✅完成 / ⏭️忽略 胶囊按钮，点击跳到 Web App 完成动作并显示确认页（含 XP/连胜反馈和「↩️ 撤销」链接）。

#### 学生帖高频问题聚类（09_StudentFAQ.gs）
- 新表 `Ed Student Posts`（仅存 postId / 时间 / 课程 / 标题，不存正文）。
- 简报生成前调用 `extractStudentFAQs(24)`：1 次 AI 调用聚合过去 24h 学生帖标题，按课程分组（每课最多 30 条标题），返回 Top 3-5 个**多人重复问的**共同主题。
- 简报新区块「🔥 学生热议 / Student FAQs」，每个主题显示课程 / 主题描述 / "N 人问" 徽章 / 2 条示例标题。
- 学生帖少于 5 条时跳过聚类，节省 token。

#### 游戏化进度系统（Stats sheet）
- 新表 `Stats`：日期 / 已完成 / 今日总数 / XP / 连胜天数。
- 每完成一个任务：done +1、XP +10、连胜计算（昨日完成 ≥ 1 则 +1，否则置 1）。
- 简报顶部新增「🏆 今日进度」绿色卡片：进度条（done/total %）+ 4 项数据格 + 仪表盘跳转按钮。

### 修改

#### Ed 帖处理逻辑全面调整
- **02_GmailScanner.gs#quickClassify**：Ed 通知邮件改为 `needsAI: false`，彻底不再调 AI 提取任务（学生帖经 Gmail 通道污染 Todo 的根因）。
- **06_EdDiscussion.gs#syncEdDiscussion**：学生帖只把标题写入 `Ed Student Posts` 独立表，不写主表、不调 AI；TA 帖与 instructor 同等对待（写主表、调 AI、进 Todo、进简报）。
- **04_SheetsWriter.gs#getRecentEdPosts**：返回结果改为公告优先 + 时间降序，最多 6 条，简报 Ed 区块不再刷屏。
- **07_TodoList.gs#_collectEdTasks**：过滤白名单加入 `ta` 类型。
- **05_DigestEmail.gs**：Ed 卡片显示 TA 帖时标 🧑‍🏫 助教 标签。

#### setupTriggers 自动生成 Web App token
- 首次 `setupTriggers()` 时调用 `setupWebAppToken()`，UUID 去横线作为 token 存 Script Properties。
- `testSetup()` 新增 Web App 配置检查（WEBAPP_URL + WEBAPP_TOKEN），未部署时打印部署引导。

### 移除
- 之前实验过的 `_isSchoolAccount()` 运行时账号守卫（`Session.getActiveUser/EffectiveUser` 在 Monash Workspace 域策略下不可靠）。改为靠用户在私人账号那边手动删除触发器解决。

### 新增文件
- `09_StudentFAQ.gs` — FAQ 聚类
- `10_WebApp.gs` — Web App 路由 + 一键操作 + 仪表盘渲染
- `dashboard.html` — 仪表盘前端模板（HtmlService scriptlet 渲染）

### 部署后用户必做（一次性）
1. Apps Script 编辑器 → 部署 → 新部署 → Web 应用（执行身份：我；谁可访问：任何人）
2. 复制 URL → 脚本属性新增 `WEBAPP_URL` = 该 URL
3. 编辑器里跑一次 `setupTriggers()` → 自动生成 token、重建触发器
4. 跑 `testSetup()` 验证全绿
5. 跑 `runEdSync()` 预热 Ed Student Posts 表
6. 跑 `runDigestNow()` 看新简报

### 调试入口
- `testStudentFAQs()` — 单独跑 FAQ 聚类
- `setupWebAppToken()` — 重新生成 / 查看 token

---

## v1.4 / V3.1 — 2026-04-28（智能 To-Do 版）

### 新增
- **`07_TodoList.gs`**：把 Gmail 任务（Tasks/任务 sheet）和 Ed 讲师帖（Ed Posts sheet 中带 deadline 的）合并成统一 To-Do 视图，按 **48h / 本周 / 之后 / 无明确截止** 四桶分类。
- **`08_DateParser.gs`**：截止日期解析。本地规则优先（覆盖 `Friday 11:59 PM` / `next Monday` / `tonight` / `5月5日` / ISO 等格式），失败的批量走一次 AI 兜底（DeepSeek）。
- **新 sheet `To-Do / 待办`**：14 列、Status 列带下拉框、按桶/状态条件配色、首行冻结。
- **简报邮件顶部 To-Do section**：四张折叠卡片（48h 红 / 本周黄 / 之后灰 / 无期限紫）；每条带课程徽章、置信度徽章、源链接（📧 邮件 / 💬 Ed 帖）。
- **双向同步**：用户在 To-Do sheet 把 Status 改成"已完成 Done"或"忽略 Ignored"，下次刷新时回写到源 sheet（Tasks 第 8 列 / Ed Posts 第 13 列）。`Ed Posts` 第 13 列首次运行自动加。
- **新邮件主题格式**：`[48h:N] 学术简报 MM/dd — M 条待办`（48h 桶非空时），否则 `学术简报 MM/dd — M 条待办`。

### 修改
- `00_Config.gs`：新增 `TODO_CONFIG`（H48_HOURS / WEEK_DAYS / MIN_CONFIDENCE / HIDE_IGNORED / AI_FALLBACK）。
- `05_DigestEmail.gs`：`generateAndSendDigest` 头部调用 `buildTodoList()`（用 try/catch 包住，失败降级到 v1.3 简报）；`buildDigestHtml` 接收 todo 参数并在 Greeting 卡片后注入 `_buildTodoSectionHtml`。

### 调试入口
- `testParseDeadline()` — 跑 30 个日期格式用例
- `testBuildTodo()` — 打印分桶统计 + 前 5 条 48h 任务

### 不在 V3.1 范围
- Flask 本地 dashboard、SQLite、Web UI、Windows 自启 → 推迟到 V3.2（V3.1 用满 1 周后再做）

---

## v1.3 — 2026-04-28

### 变更
- **AI 提供商切换**：将默认主力从 Gemini 改为 DeepSeek v4-flash（`deepseek-chat`，后端自动映射到 v4-flash）。原因：Gemini 持续触发 429 限速，三次重试全部失败。
- **Fallback 更新**：备用从 DeepSeek 改为智谱 Zhipu（因 DeepSeek 已升为主力）。
- **注释更新**：`03_API.gs` 顶部说明、各提供商注释更新，反映新的主力/备用角色。

### 费用参考（DeepSeek v4-flash）
- 输入 1元/M tokens，输出 2元/M tokens。本项目预估 **约 1.3元/月**。

---

## v1.2 — 2026-04-27

### 新增
- **Clasp 配置**：添加 `.clasp.json`、`.claspignore`、`push.bat`，支持 `clasp push` 一键同步代码到 Google Apps Script，无需手动复制粘贴。
- **课程配置**：`00_Config.gs` 填入四门课程关键词（FIT5125/FIT5145/FIT5147/FIT5197）及各讲师姓名，用于邮件课程识别。
- **摘要邮件地址**：`USER_CONFIG.EMAIL` 设为 `学校邮箱`。

### 修复
- **Ed Discussion 过度标记**：`quickClassify()` 新增 Ed Discussion 检测，来自 edstem.org 的通知邮件跳过紧急关键词判断，避免其他学生提问被误标为 Important。
- **AI 提示词优化**：`processEmailWithAI()` 明确说明 Ed Discussion 学生帖属于 medium/low，不提取任务。
- **标签重复修复**：新增 `COURSE_ALIASES`（FIT4005 → FIT5125），`normalizeCourseCode()` 增加别名查询，防止同一课程生成多个标签。
- **一次性标签合并**：运行 `fixFIT5125Labels()` 将 `Academic/FIT4005`（7条）和 `Academic/FIT4005_FIT5125`（6条）合并到 `Academic/FIT5125`，旧标签已删除。该辅助函数在完成后已从代码中移除。

### 待办 / 下一版计划
- [ ] **v1.3**：接入 Ed Discussion API，直接读取帖子内容，识别讲师发帖 vs 学生提问，不依赖邮件转发。
- [ ] 考虑是否启用每日简报邮件发送（需在 `appsscript.json` 加 `gmail.send` 权限）。

---

## v1.1 — 2026-04 （初始版本搭建）

### 功能
- Gmail 扫描 + 自动标签（Academic/⭐ Important、Academic/✅ Processed 等）
- AI 提取邮件任务，写入 Google Sheets
- 多 AI 提供商支持（智谱 GLM、DeepSeek、SiliconFlow）
- 每日摘要邮件生成（双语中英文）
- `03_ClaudeAPI.gs`：Claude API 直连封装（备用）

---

## 使用说明

### 推送代码
```
cd v1-apps-script
clasp push
```

### 切换 AI 提供商
在 Apps Script 编辑器 → 项目设置 → 脚本属性，修改 `AI_PROVIDER`：
- `deepseek`（默认，v4-flash，稳定，约 1.3 元/月）
- `zhipu`（备用，免费，有限速）
- `siliconflow`（完全免费，Qwen 模型）

### 课程列表
| 课程代码 | 课程名 | 识别关键词 |
|----------|--------|------------|
| FIT5125 | （已隐去） | fit5125, 讲师姓名（已隐去） |
| FIT5145 | （已隐去） | fit5145, 讲师姓名（已隐去） |
| FIT5147 | （已隐去） | fit5147, 讲师姓名（已隐去） |
| FIT5197 | （已隐去） | fit5197, 讲师姓名（已隐去） |
