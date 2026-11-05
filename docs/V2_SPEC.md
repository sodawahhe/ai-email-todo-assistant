# Academic Assistant — V2 产品开发说明书

> 版本: draft-2026-04-28  
> 目标: Ed Discussion 直连读取 + 讲师帖子识别

---

## 1. 背景与目标

### 当前 v1 的核心限制

v1（Apps Script）依赖 Ed Discussion 的邮件转发通知。邮件里只有"某人在某个帖子下有动态"，没有帖子正文——AI 无法判断是讲师公告、截止日期提醒，还是其他同学的问题。

### v2 解决什么

- **直接读取 Ed Discussion 帖子内容**，无需依赖邮件转发
- **区分讲师/助教/学生发帖**，只对讲师 + 公告帖提取任务
- **纳入每日摘要**：摘要包含 Ed 上的讲师公告，不再只有邮件

---

## 2. 技术路线决策

### 两条路

| | 路线 A：扩展 Apps Script | 路线 B：完善 Python Flask 骨架 |
|--|--------------------------|-------------------------------|
| Ed Discussion 集成 | UrlFetchApp + Bearer token | 已有代码，改 URL + 加配置 |
| Gmail 读取 | 原 v1 已有，无风险 | ⚠️ OAuth 需测 Monash 是否拦截 |
| 本地 Dashboard | 无 | 有（骨架已写到 ~70%）|
| 上手时间 | 1–2天 | 3–5天（含测试 OAuth）|
| 最大风险 | 无重大风险 | Monash IT 拦 Gmail OAuth |

### 推荐方案

**第一步：先做路线 A（Apps Script 加 Ed Discussion），1–2 天，风险为零。**  
Ed Discussion 读取和识别讲师帖的核心需求立即满足。

**第二步：测 Gmail OAuth（1 小时）。** 用你的 Monash 账号跑 Python OAuth 流程，如果通了就继续做路线 B；如果被拦就 Python 路不通，保持 Apps Script。

---

## 3. V2 核心功能（Apps Script 路线）

### 3.1 Ed Discussion 直连（新）

- 每 20 分钟轮询最新帖子（`GET /courses/{id}/threads?sort=new&limit=30`）
- 识别帖子类型：`announcement`（公告）/ `instructor_post`（讲师帖）/ `ta_reply`（助教回复）/ `student_question`（学生提问）
- 仅对前两类调用 AI 提取任务 + 截止日期
- 帖子内容（去掉 HTML 标签后前 2000 字符）写入 Google Sheets "Ed Posts" sheet
- 避免重复：用 `ed_post_id` 作去重 key

### 3.2 每日摘要升级（改）

- 现有邮件摘要部分保留
- 新增"Ed Discussion 要点"section：仅含讲师公告和公告帖，附帖子 URL

### 3.3 重要标记逻辑优化（改）

当前 Gmail 扫描遇到 Ed 转发邮件会跳过 AI。v2 可以：
- Gmail 侧继续 skip（防止分析无意义的转发通知）
- 改为由 Ed API 侧补上完整内容

---

## 4. 新增 / 修改文件

### 新增：`06_EdDiscussion.gs`

```
syncEdDiscussion()          — 主入口，轮询 + 处理 + 写 Sheet
_fetchEdCourses()           — GET /user 获取当前用户的课程列表
_fetchEdThreads(courseId)   — GET /courses/{id}/threads
_classifyEdPost(thread)     — 判断 announcement / instructor / ta / student
_processEdPost(post)        — AI 提取任务，写入 Sheet
testEdConnection()          — 快速测试：打印课程列表
```

### 修改：`00_Config.gs`

新增脚本属性：
```
ED_TOKEN          — Bearer token，从 au.edstem.org/settings/api-tokens 获取
ED_BASE_URL       — 硬编码 https://au.edstem.org/api
```

新增配置项（可选，用于课程 ID 映射）：
```javascript
const ED_COURSE_MAPPING = {
  // 如果 auto-discover 能工作则不需要，否则手动填
  // 'FIT5125': 12345,
};
```

### 修改：`05_DigestEmail.gs`

`getRecentEdPosts()` — 从 Sheet 取过去 24 小时的讲师帖/公告  
`buildDigestHtml()` — 新增 Ed Discussion section

### 修改：`01_Main.gs`

新增 Ed Discussion 定时触发器（每 20 分钟，独立于 Gmail 扫描）

---

## 5. Google Sheets 新增 Tab："Ed Posts"

| 列 | 内容 |
|----|------|
| A: Post ID | Ed 帖子 ID（去重 key）|
| B: Date | 发帖时间 |
| C: Course | 课程代码 |
| D: Type | announcement / instructor / ta / student |
| E: Author Role | instructor / ta / student |
| F: Title | 帖子标题 |
| G: Content | 正文前 1000 字 |
| H: URL | https://au.edstem.org/courses/{id}/discussion/{postId} |
| I: AI Summary | AI 生成摘要（仅讲师/公告帖）|
| J: AI Priority | high / medium / low |
| K: Deadline | AI 提取的截止日期（如无则空）|
| L: Processed | TRUE / FALSE |

---

## 6. Ed Discussion API 技术细节

### 认证

```
GET https://au.edstem.org/api/courses
Authorization: Bearer {ED_TOKEN}
```

> **注意**：如果 Bearer 格式返回 401，改试 `X-Token: {ED_TOKEN}` —— 两种格式 Ed 都接受，具体看你的 token 类型。用浏览器 DevTools → Network 抓一个 au.edstem.org 的 API 请求，看实际用的是哪个 header。

### 获取 Token

1. 登录 `https://au.edstem.org`
2. 右上角头像 → Settings → API Tokens → 生成一个
3. 复制后存入 Apps Script 脚本属性 `ED_TOKEN`

### 主要 Endpoints（全部 GET）

```
GET /user                              — 当前用户信息，含 courses 列表
GET /courses/{course_id}/threads       — 课程帖子列表
  params: limit=30, sort=new
GET /threads/{thread_id}               — 单帖完整内容（含所有回复）
```

### 讲师/公告识别逻辑

```javascript
function _classifyEdPost(thread) {
  if (thread.is_announcement) return 'announcement';
  const role = (thread.user?.course_role || '').toLowerCase();
  if (role === 'instructor') return 'instructor';
  if (role === 'ta' || role === 'tutor') return 'ta';
  return 'student';
}
```

---

## 7. 不在此版本范围内

- 本地 Dashboard（留给 Python Flask 路线，待 OAuth 验证后）
- 自动归档邮件
- Moodle 集成
- 手动标记任务完成（Google Sheets 手动操作代替）
- Ed Discussion 回复/发帖
- 多用户支持

---

## 8. Gmail OAuth 验证步骤（路线 B 的前提）

如果要做 Python Flask 版，先做这个测试（约 1 小时）：

1. 在 Google Cloud Console 创建一个 OAuth 2.0 客户端（桌面应用类型）
2. 开启 Gmail API（`gmail.readonly` scope）
3. 用 `学校邮箱` 账号完成 OAuth 授权流程
4. 如果成功读到邮件 → 路线 B 可行
5. 如果提示"该应用未经 Google 验证"且 Monash 管理员拒绝 → 路线 B 阻断，继续用 Apps Script

---

## 9. 验证清单

- [ ] `testEdConnection()` 打印课程列表，显示 FIT5125/5145/5147/5197
- [ ] `syncEdDiscussion()` 首次运行，Ed Posts sheet 有数据
- [ ] 至少一条讲师帖被标记为 `instructor` 或 `announcement`
- [ ] 每日摘要邮件中出现 "Ed Discussion" section
- [ ] 重复运行不产生重复行（去重 key 有效）

---

## 10. 预计工时

| 任务 | 估计 |
|------|------|
| `06_EdDiscussion.gs` 写 + 测试 | 3–5 小时 |
| 摘要集成 | 1–2 小时 |
| 触发器配置 | 30 分钟 |
| 调试 + 验证 | 2–3 小时 |
| **合计** | **约 1–2 天** |
