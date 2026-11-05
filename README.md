# AI Email To-Do Assistant · AI 邮件待办助手

A Google Apps Script tool that reads my university inbox and the Ed Discussion forum, uses an LLM (DeepSeek, Zhipu as fallback) to pull out tasks and deadlines, and sends me one bilingual digest every morning with a one-click "done" dashboard. I have used it daily since April 2026 and shipped 13 releases (v1.1 → v4.0) driven by my own usage feedback.

一个扫描学校邮箱和 Ed 论坛、用大模型提取任务与截止日期、每天早上推送一封中英双语待办简报的小工具。2026 年 4 月起每天在用，按真实使用反馈迭代了 13 个版本。

## 解决什么问题

课程通知分散在学校邮箱和 Ed 论坛：讲师公告、助教提醒、同学提问混在一起，截止日期要自己翻、自己记。这个工具把它们合并成一张按紧急程度排好的待办清单。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 邮件 + 论坛扫描 | 每 2 小时同步一次；论坛帖区分公告 / 置顶 / 讲师 / 助教 / 学生 |
| 大模型提取 | 课程、任务（中英双语）、截止日期、优先级、置信度 |
| 待办分桶 | 已逾期 / 48 小时 / 本周 / 之后 / 无截止，跨来源去重 |
| 每日简报 | 进度卡（完成率、连胜、XP）+ 待办 + 讲师公告要点 + 实习 / 校园邮件 |
| 一键完成 | 简报里点「完成 / 忽略 / 撤销」，状态回写 Google Sheets |
| 学生热帖 FAQ | 每天 1 次模型调用，聚类 24 小时内的学生提问，输出 3–5 个共性问题 |

## 关键设计决定

- **分级调用控制成本**：只对公告、讲师、助教帖调用大模型；论坛通知邮件不再调用；学生帖只存标题、每天批量聚类一次。月成本约 1.5 元。
- **出错不阻塞**：截止日期先用规则解析，失败再交给模型，仍失败归入「无截止」；论坛 token 过期时简报显示红色告警，而不是静默空白。
- **邮件安全红线**：脚本只加标签、归档，从不删除邮件；清理函数只改 Sheet 的状态列，不删任何数据行。
- **v4 做减法**：编辑器里可见的函数从 108 个精简到 7 个，触发器从 3 个减到 2 个，行为以 v1.8 为基线不变。

## 版本历史（节选）

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v4.0 | 2026-10-13 | 精简重构；新增实习 / 校园邮件分类 |
| v1.7 | 2026-08-12 | 修复 4 个使用反馈：上学期任务泄漏、同步静默失败、逾期无标记、按钮卡顿 |
| v1.6 | 2026-08-10 | 新学期切换；置顶帖识别与分级摘要 |
| v1.5 | 2026-05-05 | 仪表盘 + 一键完成 + 游戏化激励 + 学生 FAQ 聚类 |
| v1.4 | 2026-04-28 | 智能待办：分桶、去重、双向同步 |
| v1.1 | 2026-04 | 初版：Gmail 扫描 + AI 提取 + 每日简报 |

完整记录见 [CHANGELOG.md](CHANGELOG.md) 和 [docs/CHANGELOG_v1.md](docs/CHANGELOG_v1.md)；需求说明见 [docs/V2_SPEC.md](docs/V2_SPEC.md)、[docs/V3_SPEC.md](docs/V3_SPEC.md)，版本报告见 [docs/RELEASE_v1.5.md](docs/RELEASE_v1.5.md)。

## 文件

`00_Config` 配置与分类规则 · `01_Main` 入口 / 触发器 / 体检 · `02_GmailScanner` 扫描与标签 · `03_API` 大模型调用 · `04_SheetsWriter` 表读写 · `05_DigestEmail` 简报 · `06_EdDiscussion` 论坛同步 · `07_TodoList` 待办合并 / 去重 / 分桶 · `08_DateParser` 截止日期解析 · `10_WebApp` + `dashboard.html` 仪表盘

## 部署

1. 用 [clasp](https://github.com/google/clasp) 把本目录推到一个新的 Apps Script 项目
2. 在「项目设置 → 脚本属性」里填 `SHEET_ID`、`ED_TOKEN`、`DEEPSEEK_API_KEY`（可选 `ZHIPU_API_KEY`）
3. 修改 `00_Config.gs` 里的邮箱和课程关键词
4. 在编辑器里依次运行 `setupTriggers()` → `testSetup()`

本地测试：`node tests/run.js`（31 项断言）。

## 关于开发方式

需求、版本规划、验收标准和取舍由我决定，代码在 Claude Code 的辅助下完成。公开版已去掉我的邮箱、脚本 ID 和讲师姓名。
