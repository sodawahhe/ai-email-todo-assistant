# Changelog — Academic Assistant v4

> **规则：每次改动都要在这里加一条（最新在最上面）**——改了什么、为什么、怎么验证、用户要做什么。
> v1.0–v1.8 的历史见 `docs/CHANGELOG_v1.md`（已冻结，不再修改）。

## v4.0 — 2026-10-13

### 为什么出 v4
v1 一路加到 v1.8，编辑器里函数下拉有 108 个条目（其中一大半是内部 helper、一次性脚本、
调试函数），触发器 3 个，AI 提供商 4 个（其中 Gemini 早已不用），还带着无人调用的文件。
每次找一个能运行的函数都要翻半天。v4 不再往 v1 上叠，而是在 `v4-apps-script/` 里整理一份：
**行为以 v1.8 为基线，不重写业务逻辑**，只做精简 + 新增 Career/Campus。

### 新增：Career / Campus Gmail 标签
- 新邮件处理时，非课程邮件按 `CATEGORY_RULES`（`00_Config.gs`）打 `Academic/Career`
  （实习/求职/校招/行业宣讲）或 `Academic/Campus`（Monash / MUM / Moodle / 校园通知）。
  课程优先于 Career，Career 优先于 Campus；和学校无关的营销杂邮不打分类标签（仍有 Processed / Low）
- `backfillCategoryLabels()`：一次性给近 60 天已处理的老邮件补打这两个标签（只加标签，不调 AI）
- `career fair` 从低优先级关键词里移除——实习/求职资源要及时提醒，不能被标成 Low

### 简报：Career / Campus 不再被砍掉
v1.8 把非课程待办限成每类 5 条、只收一周内的，用户反馈"少了特别多内容"。现在：
- **Career 卡片排在 Campus 前面**：所有有截止日期的全部列出，逾期/48h 内的标红 ⏰；无截止的也列
- **Campus 卡片**：有截止日期的全部列出；无截止的只给计数（仪表盘可见）
- 两张卡片下方各附"近 3 天邮件（无待办）"：直接搜 Gmail 标签，纯通知邮件（不会生成待办的那种）
  也能在简报里看到、点开。去重：已经作为待办列出的邮件不重复
- 邮件主题加 `[实习:N]`：N = Career 里逾期/48h/本周有动作的条数
- 紧凑单行渲染（中文标题 + 日期 + 链接 + 完成/忽略），不占版面

### 精简
| | v1.8 | v4 |
|---|---|---|
| 编辑器下拉可见函数 | 108 | **7** |
| 触发器 | 3（runSync / runDailyDigest / runEdSync） | **2**（runSync / runDailyDigest） |
| AI 提供商 | gemini / deepseek / zhipu / siliconflow | deepseek（主）+ zhipu（备） |
| .gs 行数 | 3413 | 3038 |

- **可见函数只剩**：`setupTriggers` `testSetup` `runSync` `runDailyDigest`
  `backfillCategoryLabels` `rolloverSemester` `doGet`。其余 88 个全部改名为以 `_` 结尾
  （Apps Script 约定：不出现在下拉里），`tests/run.js` 里有断言卡住这个清单
- **触发器 3 → 2**：Ed 同步并入 `runSync`（Ed 先、Gmail 后，互不影响，各自 try/catch）。
  `setupTriggers()` 仍会先删光所有旧触发器再重建，顺带清掉历史残留
- **删除的入口**：`runSyncNow` / `runDigestNow`（别名）、`runEdSync`、`testEdAuth` /
  `testEdConnection` / `probeEdEndpoints`（并入 `testSetup`，会真实请求 Ed 并报告匹配几门课）、
  `testAIDetailed`、`testBuildTodo`、`testParseDeadline`（搬到 `tests/run.js`）、
  `fixGmailTaskLinks` / `cleanupNoDeadlineTasks`（一次性，已用完）、`setupWebAppToken`
  （并入 `setupTriggers`，自动生成 token）、`previewOldCourseLabels` / `cleanupOldCourseLabels`
  （合并进 `rolloverSemester`）
- `testSetup()` 重写：之前把 `GEMINI_API_KEY` 当必填项，没设就报 ❌；现在按实际在用的
  提供商检查，并检查触发器恰好为 2 个
- `rolloverSemester()`：换学期时一次性做完——往学期待办/Ed 帖标"忽略"（不删行）+
  摘除不在在读课程里的 `Academic/<课程代码>` 标签（只摘标签，邮件不动）
- 版本字样：简报页脚 "V3.1" → "v4"

### 验证
- `node tests/run.js`：31 项断言通过（日期解析的相对日期/2001 年/自带日期、分桶、分类、
  简报渲染含 Career 全列出与不限量、可见函数清单）
- 全部 `.gs` 通过 `node --check`；重命名后做了静态扫描，无未解析的函数调用
- **未验证**：没有在真实 Apps Script / Gmail 上运行（本机无法登录）。首次 push 后请按下面步骤自检

### 用户操作步骤
1. `cd v4-apps-script` → `clasp push`（`.clasp.json` 指向同一个脚本，会替换远端全部文件）
2. 运行 `setupTriggers()`（清掉旧触发器 → 只剩 2 个）
3. 运行 `testSetup()`，全部 ✅ 再继续
4. 运行 `backfillCategoryLabels()`（一次，补老邮件标签；日志会打印各类数量）
5. 运行 `runDailyDigest()` 看新简报

### 已知限制 / 风险
- `AI_PROVIDER` / `AI_FALLBACK` 若在脚本属性里设成了 gemini / siliconflow：主力会静默回退 deepseek，
  备用会被忽略（不报错）
- Career/Campus 的判断是关键词规则，不是 AI：`CATEGORY_RULES` 漏判/误判时改那一处即可，
  再跑一次 `backfillCategoryLabels()` 只会给**还没有**该标签的邮件补，不会纠正已打错的标签
- 简报"近期邮件"用 Gmail 搜索 `label:"Academic/Career" newer_than:3d`；标签名改了要同步改 `LABEL_*`
- 简报需要至少一次 `runSync` 之后才有 Career/Campus 标签可搜；`backfillCategoryLabels()` 一次最多处理
  约 4.5 分钟的量，超量再跑一次即可（已打标签的会被排除）
