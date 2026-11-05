// ============================================================
// 00_Config.gs — 用户配置 / User Configuration
// ============================================================
// 改了 DIGEST_HOUR / DIGEST_MINUTE 后需重新运行 setupTriggers()；其余改动 push 即生效。
// ============================================================

const USER_CONFIG = {

  // --- 必填 / Required ---
  // 你的 Gmail 邮箱地址（摘要邮件会发送到这里）
  // Your Gmail address (digest will be sent here)
  EMAIL: 'you@university.edu',

  // 每日摘要发送时间（24小时制）
  // Daily digest send time (24h format)
  DIGEST_HOUR: 8,
  DIGEST_MINUTE: 30,

  // 扫描邮件的时间窗口（小时）
  // How many hours back to scan for new emails
  SCAN_HOURS: 24,

  // --- 课程识别关键词 / Course Detection Keywords ---
  // 格式: { 课程代码: [关键词列表] }
  // Format: { courseCode: [keyword list] }
  // 这些关键词会在邮件主题和发件人中匹配（不区分大小写）
  // These keywords are matched in subject and sender (case-insensitive)
  // S2 2026（2026-07-25 起）— 上学期四门课已下线
  // 关键词含课程代码、课程名、教学团队姓名（姓名用于识别不写课号的邮件）
  // ⚠️ 全部小写；姓名一律写全名，避免只写姓氏造成跨课误判
  COURSES: {
    // 课程代码 → [课程代码、课程名、教学团队全名（小写）]；公开版已去掉讲师姓名
    'FIT5196': ['fit5196', 'data wrangling'],
    'FIT5202': ['fit5202', 'data processing for big data', 'big data'],
    'FIT5230': ['fit5230', 'malicious ai'],
    'FIT9137': ['fit9137', 'computer architecture', 'architecture and networks'],
  },

  // 重要发件人列表（含这些关键词的发件人邮件直接标为 High Priority）
  // Senders whose emails are always marked High Priority
  IMPORTANT_SENDERS: [
    // 'professor@university.edu',
    // 'noreply@canvas.edu',
    // 'admin@university.edu',
  ],

  // 低优先级关键词（匹配这些词的邮件标为 Low Priority）
  // Keywords that mark an email as Low Priority
  LOW_PRIORITY_KEYWORDS: [
    'newsletter', 'unsubscribe', 'digest', 'weekly roundup',
    'club meeting', 'social event',  // career fair 不算：实习/求职资源要及时提醒
  ],
};

// 是否本学期在读课程（USER_CONFIG.COURSES 是唯一依据）。
// Ed 同步 / 简报 / To-Do / Gmail 标签共用这一处，别在各处再写一份。
function isConfiguredCourse_(code) {
  const c = String(code || '').toLowerCase();
  return !!c && Object.keys(USER_CONFIG.COURSES).some(k => c.includes(k.toLowerCase()));
}

// 非课程内容的分类（Gmail 标签 / 简报 / 仪表盘共用这一处）。
// career = 实习、求职、校招、行业宣讲；campus = 学校通知/活动（发件人或主题带 Monash 特征）。
const CATEGORY_RULES = {
  career: /intern|career|recruit|interview|graduate program|employer|industry|job |hiring|shopee|at&s|实习|招聘|面试|求职|宣讲|职业/i,
  campus: /monash|\bmum\b|campus|moodle|school of|校园/i,
};

// 返回 'course' | 'career' | 'campus' | ''（''＝和学校无关的营销/杂邮，不打分类标签）
// text 传 主题 + 发件人 (+ 任务标题)；课程优先于 career，career 优先于 campus。
function categorize_(course, text) {
  if (isConfiguredCourse_(course)) return 'course';
  if (CATEGORY_RULES.career.test(text)) return 'career';
  return CATEGORY_RULES.campus.test(text) ? 'campus' : '';
}

// ============================================================
// 敏感配置（存储在 Script Properties，不写在代码里）
// Sensitive config (stored in Script Properties, never in code)
// 设置方式: Apps Script 编辑器 → 项目设置 → 脚本属性
// How to set: Apps Script Editor → Project Settings → Script Properties
// ============================================================
// 需要添加以下属性 / Required properties:
//   SHEET_ID           →  Google Sheet ID from its URL
//   ED_TOKEN           →  Ed 的 x-token（失效时从浏览器 Network 重新抓）
//   DEEPSEEK_API_KEY   →  主 AI；可选 ZHIPU_API_KEY 作为备用（见 03_API.gs 顶部）
//   WEBAPP_URL         →  Web App 部署后的 URL（可选，没有就没有一键完成按钮）
// WEBAPP_TOKEN 由 setupTriggers() 自动生成。

function getSheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('请在脚本属性中设置 SHEET_ID / Set SHEET_ID in Script Properties');
  return id;
}

// Ed Discussion 会话 token（从浏览器 localStorage.authToken:au 抓取）
// 必须用 X-Token header 传递，不是 Bearer
const ED_AUTH_HEADER = 'x-token';

function getEdToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('ED_TOKEN');
  if (!t) throw new Error('请在脚本属性中设置 ED_TOKEN / Set ED_TOKEN in Script Properties');
  return t;
}

function getEdBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('ED_BASE_URL') || 'https://edstem.org/api';
}

// 课程代码别名：把 AI 返回的变体代码归并到 USER_CONFIG.COURSES 里的课程。{ 'FIT5196S2': 'FIT5196' }
const COURSE_ALIASES = {};

// Gmail 标签：全部在 "Academic/" 下。总共只有 课程(在读 4 门) + 下面 5 个。
const LABEL_PREFIX = 'Academic';
const LABEL_IMPORTANT = `${LABEL_PREFIX}/⭐ Important`;
const LABEL_LOW = `${LABEL_PREFIX}/📌 Low Priority`;
const LABEL_PROCESSED = `${LABEL_PREFIX}/✅ Processed`;
const LABEL_CAREER = `${LABEL_PREFIX}/Career`;
const LABEL_CAMPUS = `${LABEL_PREFIX}/Campus`;

// ============================================================
// To-Do / 简报 配置
// ============================================================
const TODO_CONFIG = {
  H48_HOURS: 48,        // 48 小时桶阈值
  WEEK_DAYS: 7,         // 本周桶阈值（天）
  STALE_DAYS: 3,        // 逾期超过这么多天的任务不进任何桶
  AI_FALLBACK: true,    // 启用 AI 兜底解析无法本地解析的 deadline
  MIN_TASK_DATE: '2026-07-25',  // 学期开学硬切线：早于此日期的任务/帖子一律隐藏（旧数据留在表里可追溯）
  HIDE_NO_DEADLINE_IN_DIGEST: true,  // 简报里不显示"无明确截止"桶（仪表盘仍可见）

  // 简报里 Career / Campus 卡片下方"近期邮件"列表：最近几天、最多几封
  // （没有任务的纯通知邮件不会进 To-Do，靠这里 + Gmail 标签不被遗漏）
  MAIL_DAYS: 3,
  MAIL_LIMIT: 8,
};

// ============================================================
// Ed 摘要策略：按帖子重要性分级调用 AI
// ============================================================
const ED_CONFIG = {
  // 这些类型永远调 AI 生成摘要（置顶帖无论作者角色一律进这一档）
  ALWAYS_SUMMARIZE: ['pinned', 'announcement', 'instructor'],

  // 助教帖：先本地扫关键词，命中才调 AI（控制成本）
  TA_SUMMARIZE_IF_DEADLINE: true,
  DEADLINE_KEYWORDS: [
    'due', 'deadline', 'submit', 'submission', 'close', 'closes', 'closing',
    'extension', 'assignment', 'assessment', 'quiz', 'exam', 'test',
    'week ', 'by 11:59', 'no later than', 'last day', 'final',
    '截止', '提交', '作业', '考试', '测验', '最后期限',
  ],

  // 摘要补写：简报生成前，给表里缺摘要的重要帖补调 AI，每次最多这么多条
  // （防止某次同步 AI 报错后帖子永远没有摘要）
  BACKFILL_LIMIT: 8,

  // 简报 Ed 区块只列"最近 N 天发的、没有截止日期的"帖子（含置顶——老师置顶不会自动取消）。
  // 带截止日期的帖子已经在 To-Do 里，不在这里重复。
  RECENT_DAYS: 7,
  DIGEST_LIMIT: 10,
};
