# Academic Assistant — V3.1 智能 To-Do 版

> 版本：v3.1（基于 v1.3 增量）
> 完成日期：2026-04-28
> 试用日：2026-04-29 早 8:00（用户自测）

---

## 1. V3.1 解决了什么

期末周快到了，原 v1.3 简报把"邮件流"和"Ed 帖"分开列出，用户每天得**手动**辨认哪些是"今晚必须做"、哪些是"本周做就行"。

V3.1 新增了一个统一的**今日待办**视图：把 Gmail 任务 + Ed 讲师公告任务**合并去重**，按截止时间分桶 → **48h 内 / 本周 / 之后 / 无明确截止** → 直接放在简报最顶部。

每条待办都带：
- 课程徽章（FIT5125 等）
- 截止日期（解析成本地时间）
- 置信度徽章（H/M/L）
- 一键跳转源邮件 / 源 Ed 帖

---

## 2. 数据流

```
┌────────────────┐    ┌──────────────────┐
│ Gmail 扫描     │    │ Ed Discussion 拉取 │
│ (v1.3 已有)    │    │ (v1.3 已有)        │
└───────┬────────┘    └────────┬───────────┘
        │ 写入                 │ 写入
        ▼                      ▼
┌────────────────┐    ┌──────────────────┐
│ Tasks/任务 sheet│    │ Ed Posts sheet   │
│ (邮件提取的任务) │    │ (帖子 + 截止日期) │
└───────┬────────┘    └────────┬───────────┘
        │                      │
        └─────────┬────────────┘
                  ▼
        ┌──────────────────────┐
        │ 07_TodoList.gs        │
        │ 1. 收集 Pending 任务  │
        │ 2. 解析 deadline      │
        │ 3. 去重               │
        │ 4. 分桶（48h/周/后） │
        │ 5. 双向同步状态       │
        └─────────┬─────────────┘
                  ▼
        ┌──────────────────────┐    ┌──────────────────────┐
        │ To-Do/待办 sheet     │    │ 简报邮件顶部 To-Do    │
        │ （手动可改 Status）  │    │ section（折叠卡片）   │
        └──────────────────────┘    └──────────────────────┘
```

---

## 3. To-Do / 待办 Sheet 列说明

| 列 | 含义 | 用户能改吗？ |
|----|------|------------|
| Todo ID | 内部去重 key（形如 `gmail_42_0` / `ed_18c5a..._0`）| ❌ 不要改，改了会破坏同步 |
| 紧急度 Bucket | `48h` / `本周 ThisWeek` / `之后 Later` / `无期限 NoDate` | ❌ 自动计算 |
| 课程 Course | FIT5125 等 | ⚠️ 改了下次刷新会被覆盖 |
| 任务（中文）| 中文任务名 | ⚠️ 改了下次刷新会被覆盖 |
| Task (EN) | 英文任务名 | ⚠️ 改了下次刷新会被覆盖 |
| 截止日期 Deadline | 解析后的本地时间 | ❌ 自动计算 |
| 截止原文 Deadline Raw | AI 提取的原始字符串 | ❌ 来自源 sheet |
| 优先级 Priority | high/medium/low | ⚠️ |
| 置信度 Confidence | high/medium/low | ⚠️ |
| **状态 Status** | **待办 Pending / 已完成 Done / 忽略 Ignored** | **✅ 改这一列！下次刷新会回写源 sheet** |
| 来源 Source | Gmail / Ed | ❌ |
| 来源链接 Source Link | 邮件或 Ed 帖子 URL | ❌ |
| 来源标题 Source Title | 邮件主题 / Ed 帖子标题 | ❌ |
| 上次刷新 Last Refreshed | 本视图最近重建时间 | ❌ |

**状态列有下拉菜单**，只能选三个值（避免拼写错误把同步搞坏）。

---

## 4. 双向同步是怎么工作的

每次 `buildTodoList()` 跑（每天 8:30 AM 和 18:00 简报触发时各跑一次）：

1. 读 To-Do sheet 现有所有行的 `(Todo ID, Status)`
2. 把 Status 不是"待办 Pending"的，**回写到源 sheet**：
   - Gmail 任务 → `Tasks / 任务` sheet 第 8 列改成"已完成 Done"
   - Ed 任务 → `Ed Posts` sheet 第 13 列（首次会自动加列）改成"已完成 Done"
3. 重新收集所有 Pending 任务 → 排重 → 分桶 → 写入 To-Do sheet
4. 用户标记过完成的不再出现在简报里

**冲突规则**：如果你同时在 To-Do 和源 sheet 改了同一条，以 To-Do 为准。

---

## 5. 邮件主题怎么读

| 主题模式 | 含义 |
|---------|------|
| `[48h:N] 学术简报 MM/dd — M 条待办 / M To-Do` | 48 小时内有 N 条紧急；总待办 M 条 |
| `学术简报 MM/dd — M 条待办` | 没紧急的，总待办 M 条 |
| `学术简报 MM/dd — N 个紧急任务`（旧格式）| To-Do 模块构建失败，回退到 v1.3 简报 |

---

## 6. 截止日期解析支持的格式

`08_DateParser.gs` 的本地规则覆盖：

- ISO：`2026-05-05T23:59` / `2026-05-05`
- 标准日期：`May 5` / `May 5, 2026` / `5 May` / `5 May 2026`
- 数字：`05/05` / `5/5` / `05-05-2026`
- 相对：`tonight` / `today` / `tomorrow` / `今晚` / `明天`
- 工作日：`Friday` / `this Friday` / `next Monday` / `周五` / `下周一`
- 中文：`5月5日` / `5月5号 23:59`
- 时间提取：`11:59 PM` / `9am` / `23:59`（自动覆盖默认 23:59）
- 默认：未指定时间则用 23:59

**本地解析失败的会进 AI 兜底**（一次 DeepSeek 调用解析多条），AI 也失败则进入"无明确截止"桶。

把 `TODO_CONFIG.AI_FALLBACK = false` 关掉 AI 兜底（节省配额）。

---

## 7. 验证清单（明早 8 AM 用户自测用）

按这个顺序在 Apps Script 编辑器里跑：

1. **`clasp push`**（在本地 v1-apps-script 目录里）→ 推上去
2. **`testParseDeadline`** → 看 logs：所有"应解析成功"的用例都返回非 null
3. **`testBuildTodo`** → 看 logs：打印分桶统计，例如 `48h: 2, 本周: 3, 之后: 2`
4. 打开 Google Sheet → 应看到新增 `To-Do / 待办` tab，48h 行红底，本周行黄底，Status 列有下拉
5. 在 To-Do sheet 把某条 Status 改为 `已完成 Done` → 再跑一次 `buildTodoList`：
   - ① 该条不再出现在 To-Do sheet
   - ② 打开 `Tasks / 任务` 或 `Ed Posts` sheet 确认源行也被标记成 "已完成 Done"
6. **`generateAndSendDigest`** → 收到邮件，最顶部出现"📋 今日待办"section，链接能点开 Gmail/Ed 原帖
7. **回归测试**：原 v1.3 的"Ed Discussion 重要帖"section、邮件流 section 仍然出现

**降级测试**（可选）：临时给 `buildTodoList` 头部加 `throw new Error('test')` → 跑 `generateAndSendDigest` → 应仍能发出旧版简报，只是顶部缺 To-Do section。

---

## 8. 配额警告

**Apps Script 仍在限额状态**（截至 2026-04-28 晚）。
- `testParseDeadline` 不调外部 API，可以跑
- `testBuildTodo` 如果所有 deadline 都能本地解析也能跑
- `generateAndSendDigest` 仍然调 v1.3 的 `generateDigestContent`（那是 v1.3 的 AI 调用，可能仍会受限）—— 这不是 V3 引入的回归

---

## 9. 配置项（00_Config.gs 中的 `TODO_CONFIG`）

```javascript
const TODO_CONFIG = {
  H48_HOURS: 48,         // 48 小时桶阈值
  WEEK_DAYS: 7,          // 本周桶阈值（天）
  MIN_CONFIDENCE: 'low', // 低于此置信度的任务不进 To-Do（默认 low = 全收）
  HIDE_IGNORED: true,    // 简报中不显示 Status='忽略'
  AI_FALLBACK: true,     // 启用 AI 兜底解析
};
```

---

## 10. V3.2 路线图占位（推迟）

V3.1 用满 1 周稳定后再启动：

- Flask 本地 dashboard
- SQLite 持久化
- Web UI（手动确认归档、错误日志面板）
- Windows 启动项 / 后台 daemon
- Moodle 集成

V3.2 详细 spec 等真实使用痛点出来再写——避免对没用过的工具做过度设计。

---

## 11. 关键文件

**新增**：
- [v1-apps-script/07_TodoList.gs](v1-apps-script/07_TodoList.gs) — To-Do 视图主逻辑
- [v1-apps-script/08_DateParser.gs](v1-apps-script/08_DateParser.gs) — 截止日期解析

**修改**：
- [v1-apps-script/00_Config.gs](v1-apps-script/00_Config.gs) — 加 `TODO_CONFIG`
- [v1-apps-script/05_DigestEmail.gs](v1-apps-script/05_DigestEmail.gs) — 简报顶部加 To-Do section、调主题

**侵入**（首次运行自动）：
- `Ed Posts` sheet 第 13 列加 `Todo Status / 待办状态`
- `Tasks / 任务` sheet 第 8 列接受第三个值"忽略 Ignored"

**不修改**：v1.3 的 Gmail 扫描、AI 提取、Ed API 拉取三块逻辑全部保留。
