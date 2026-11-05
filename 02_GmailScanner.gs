// ============================================================
// 02_GmailScanner.gs — Gmail 扫描 + 标签管理
// Gmail scanning + label management
// ============================================================
// 安全原则：只加标签，绝不移除 INBOX / 归档 / 删除邮件
// （唯一的摘标签操作是 rolloverSemester，仅限往学期课程标签，需手动触发）
// ============================================================

// ── 主扫描函数：找出未处理的新邮件并处理 ──
function scanAndProcessEmails_() {
  const hoursBack = USER_CONFIG.SCAN_HOURS;
  // Gmail 搜索只支持 d/m/y，不支持 h，用精确时间戳替代
  // Gmail search only supports d/m/y, not h — use exact timestamp instead
  const afterDate = new Date(Date.now() - hoursBack * 3600 * 1000);
  const afterStr = Utilities.formatDate(afterDate, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  const query = `after:${afterStr} -label:"${LABEL_PROCESSED}"`;

  Logger.log(`[Scan] 查询: ${query}`);

  let threads;
  try {
    threads = GmailApp.search(query, 0, 50);
  } catch (e) {
    Logger.log(`Gmail search error: ${e.message}`);
    return { processed: 0, tasks: 0 };
  }

  if (threads.length === 0) {
    Logger.log('No new unprocessed emails found.');
    return { processed: 0, tasks: 0 };
  }

  Logger.log(`Found ${threads.length} unprocessed email threads.`);
  let processedCount = 0;
  let taskCount = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    // Process the most recent message in the thread
    const msg = messages[messages.length - 1];

    try {
      const result = processMessage_(thread, msg);
      taskCount += result.tasks;
      processedCount++;
    } catch (e) {
      Logger.log(`Error processing "${msg.getSubject()}": ${e.message}`);
      // Still mark as processed so we don't retry infinitely
      applyLabel_(thread, LABEL_PROCESSED);
    }
  }

  return { processed: processedCount, tasks: taskCount };
}

// ── 处理单封邮件 ──
function processMessage_(thread, msg) {
  const subject = msg.getSubject() || '(no subject)';
  const sender = msg.getFrom();
  const senderEmail = extractEmail_(sender);
  const date = msg.getDate();
  const body = getPlainBody_(msg);

  Logger.log(`Processing: "${subject}" from ${senderEmail}`);

  // Step 1: 快速本地判断优先级（不消耗 API）
  const quickResult = quickClassify_(subject, sender, body);

  // Step 2: 如果本地无法确定，调用 AI
  let aiResult = null;
  if (quickResult.needsAI) {
    try {
      aiResult = processEmailWithAI_(subject, sender, body, date);
    } catch (e) {
      Logger.log(`Claude processing failed for "${subject}": ${e.message}`);
      // Fall back to quick result
    }
  }

  const finalResult = aiResult || quickResult;

  // Step 3: 在 Gmail 中打标签（不归档）
  applyEmailLabels_(thread, finalResult.course, finalResult.importance, `${subject} ${sender}`);

  // Step 4: 如果有任务，写入 Google Sheet（带真实 Gmail thread 直链）
  let taskCount = 0;
  if (finalResult.tasks && finalResult.tasks.length > 0) {
    let permalink = '';
    try { permalink = thread.getPermalink() || ''; } catch (e) {}
    writeTasks_(finalResult.tasks, finalResult.course, subject, sender, permalink);
    taskCount = finalResult.tasks.length;
    Logger.log(`  → Extracted ${taskCount} tasks`);
  }

  Logger.log(`  → Course: ${finalResult.course || 'Unknown'}, Priority: ${finalResult.importance}`);
  return { tasks: taskCount };
}

// ── 快速本地分类（不调用 AI）──
function quickClassify_(subject, sender, body) {
  const subjectLower = subject.toLowerCase();
  const senderLower = sender.toLowerCase();
  const combined = subjectLower + ' ' + senderLower;

  // Detect Ed Discussion notification emails (other students' posts — not tasks for the user)
  const isEdDiscussion = senderLower.includes('edstem.org') ||
                         senderLower.includes('edstem') ||
                         senderLower.includes('ed discussion') ||
                         subjectLower.includes('[ed]');

  // 检查重要发件人（始终高优先级）
  for (const importantSender of USER_CONFIG.IMPORTANT_SENDERS) {
    if (senderLower.includes(importantSender.toLowerCase())) {
      return { importance: 'high', course: detectCourse_(subject, sender), tasks: [], needsAI: true };
    }
  }

  // 检查低优先级关键词
  for (const kw of USER_CONFIG.LOW_PRIORITY_KEYWORDS) {
    if (combined.includes(kw.toLowerCase())) {
      return { importance: 'low', course: detectCourse_(subject, sender), tasks: [], needsAI: false };
    }
  }

  // Ed Discussion 邮件：不调 AI、不提取任务（讲师公告已由 Ed API 直接同步，不需要重复处理）
  if (isEdDiscussion) {
    Logger.log(`  [QuickClassify] Ed Discussion notification — skip AI, no task extraction`);
    return { importance: 'low', course: detectCourse_(subject, sender), tasks: [], needsAI: false };
  }

  // 检查高优先级关键词（仅对非 Ed Discussion 邮件生效）
  const urgentKeywords = [
    'deadline', 'due', 'submit', 'assignment', 'exam', 'quiz',
    'urgent', 'important', 'reminder', 'overdue', 'required',
    '截止', '作业', '考试', '提醒', '重要',
  ];
  for (const kw of urgentKeywords) {
    if (combined.includes(kw)) {
      return { importance: 'high', course: detectCourse_(subject, sender), tasks: [], needsAI: true };
    }
  }

  // 默认：需要 AI 处理
  return { importance: 'medium', course: detectCourse_(subject, sender), tasks: [], needsAI: true };
}

// ── 基于关键词检测课程 ──
function detectCourse_(subject, sender) {
  const combined = (subject + ' ' + sender).toLowerCase();
  for (const [courseName, keywords] of Object.entries(USER_CONFIG.COURSES)) {
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        return courseName;
      }
    }
  }
  return '';
}

// ── 在 Gmail 中应用标签（只加标签，不归档、不删除）──
// text = 主题 + 发件人，用来判断 Career / Campus
function applyEmailLabels_(thread, courseName, importance, text) {
  try {
    applyLabel_(thread, LABEL_PROCESSED);

    // 分类标签：课程（只给在读课程）/ Career / Campus；和学校无关的杂邮不打分类标签
    const cleanCourse = normalizeCourseCode_(courseName);
    const category = categorize_(cleanCourse, text);
    if (category === 'course') applyLabel_(thread, `${LABEL_PREFIX}/${cleanCourse}`);
    else if (category === 'career') applyLabel_(thread, LABEL_CAREER);
    else if (category === 'campus') applyLabel_(thread, LABEL_CAMPUS);

    if (importance === 'high') applyLabel_(thread, LABEL_IMPORTANT);
    else if (importance === 'low') applyLabel_(thread, LABEL_LOW);
  } catch (e) {
    Logger.log(`Label error: ${e.message}`);
  }
}

// ── 获取或创建 Gmail 标签 ──
function applyLabel_(thread, labelName) {
  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
    Logger.log(`Created Gmail label: ${labelName}`);
  }
  thread.addLabel(label);
}

// ── 给已处理过的老邮件补打 Career / Campus 标签（只加标签，一次性）──
// 范围：带 Processed 标签、近 60 天、还没有 Career/Campus/在读课程标签的邮件。
// 不调 AI，只用 categorize_()；和学校无关的杂邮保持不动。
function backfillCategoryLabels() {
  const startedAt = Date.now();
  const done = [LABEL_CAREER, LABEL_CAMPUS].concat(Object.keys(USER_CONFIG.COURSES).map(c => `${LABEL_PREFIX}/${c}`));
  const q = `label:"${LABEL_PROCESSED}" newer_than:60d ` + done.map(l => `-label:"${l}"`).join(' ');
  const counts = { course: 0, career: 0, campus: 0, none: 0 };
  for (let start = 0; Date.now() - startedAt < 4.5 * 60000; start += 100) {  // 留余量，6 分钟上限
    const threads = GmailApp.search(q, start, 100);
    if (threads.length === 0) break;
    for (const thread of threads) {
      const msgs = thread.getMessages();
      const text = `${thread.getFirstMessageSubject()} ${msgs[msgs.length - 1].getFrom()}`;
      const course = detectCourse_(thread.getFirstMessageSubject(), msgs[msgs.length - 1].getFrom());
      const category = categorize_(course, text);
      if (category === 'course') {
        applyLabel_(thread, `${LABEL_PREFIX}/${course}`);
      } else if (category) {
        applyLabel_(thread, category === 'career' ? LABEL_CAREER : LABEL_CAMPUS);
      }
      counts[category || 'none']++;
    }
  }
  Logger.log(`[Backfill] 课程 ${counts.course} / Career ${counts.career} / Campus ${counts.campus} / 无关 ${counts.none}`);
}

// ── 换学期清理：改完 USER_CONFIG.COURSES 和 MIN_TASK_DATE 后手动运行一次 ──
// 1) 往学期的待办/Ed 帖状态标为忽略（不删行）
// 2) 摘除 "Academic/<课程代码>" 且不在在读课程里的标签。只摘标签，邮件本身不删、不移动，
//    用课程代码搜索随时能找回。⭐Important / Low / Processed / Career / Campus 不动。
function rolloverSemester() {
  cleanupPreviousSemester_();
  const re = new RegExp(`^${LABEL_PREFIX}/[A-Z]{2,4}\\d{3,5}`, 'i');
  const old = GmailApp.getUserLabels().filter(l => re.test(l.getName()) && !isConfiguredCourse_(l.getName()));
  old.forEach(l => { Logger.log(`[Rollover] 摘除标签: ${l.getName()}`); l.deleteLabel(); });
  Logger.log(`[Rollover] 共摘除 ${old.length} 个往学期课程标签；邮件本身未动`);
}

// ── 从 "Name <email>" 格式中提取邮箱 ──
function extractEmail_(from) {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from;
}

// ── 从邮件中提取纯文本正文（去除 HTML）──
function getPlainBody_(msg) {
  // 优先用纯文本，其次去除 HTML 标签
  let body = msg.getPlainBody() || msg.getBody() || '';
  // Remove HTML tags if still present
  body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Cap at 4000 chars to keep API costs low
  return body.substring(0, 4000);
}

