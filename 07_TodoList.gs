// ============================================================
// 07_TodoList.gs — 智能 To-Do 视图（V3.1 核心）
// Smart To-Do dashboard combining Gmail + Ed Discussion tasks
// ============================================================
// 职责 / Responsibilities:
//   - 把 Tasks/任务 sheet（Gmail 邮件提取的任务）和 Ed Posts sheet
//     （含 deadline 的讲师/公告帖）合并成一个统一 To-Do 视图
//   - 解析 deadline（本地规则 + AI 兜底）→ 按 48h / 本周 / 之后 / 无期限分桶
//   - 双向同步：用户在 To-Do sheet 改 Status 后，回写到源 sheet
//   - 输出供 05_DigestEmail.gs 渲染的数据结构
// ============================================================

const TODO_SHEET_NAME = 'To-Do / 待办';

const TODO_HEADERS = [
  'Todo ID',
  '紧急度\nBucket',
  '课程\nCourse',
  '任务（中文）\nTask ZH',
  'Task (EN)',
  '截止日期\nDeadline',
  '截止原文\nDeadline Raw',
  '优先级\nPriority',
  '置信度\nConfidence',
  '状态\nStatus',
  '来源\nSource',
  '来源链接\nSource Link',
  '来源标题\nSource Title',
  '上次刷新\nLast Refreshed',
  '合并来源\nMerged IDs',  // dedup 时合并掉的 todoId 列表（JSON），用于状态联动
];

// 无截止 + 添加超过这么多天的任务自动从 Todo 列表过滤掉
const STALE_NO_DEADLINE_DAYS = 7;

const STATUS_PENDING = '待办 Pending';
const STATUS_DONE = '已完成 Done';
const STATUS_IGNORED = '忽略 Ignored';

const BUCKET_OVERDUE = '已逾期 Overdue';
const BUCKET_48H = '48h';
const BUCKET_WEEK = '本周 ThisWeek';
const BUCKET_LATER = '之后 Later';
const BUCKET_NODATE = '无期限 NoDate';

// ============================================================
// 主入口
// ============================================================
function buildTodoList_() {
  const now = new Date();
  Logger.log(`[Todo] buildTodoList_ start @ ${now}`);

  // 第 1 步：把已有 To-Do sheet 中用户改过的状态同步回源 sheet
  const existingStatus = syncStatusToSourceSheets_();

  // 第 2 步：从两个源 sheet 收集候选任务
  const gmailTodos = collectGmailTasks_();
  const edTodos = collectEdTasks_();
  const allTodos = gmailTodos.concat(edTodos);
  Logger.log(`[Todo] collected: gmail=${gmailTodos.length} ed=${edTodos.length} total=${allTodos.length}`);

  // 第 3 步：批量解析 deadline（本地优先，失败的进 AI 兜底）
  // 相对日期（Friday / Week 6）必须相对"帖子/邮件的写出日期"解析，不能相对今天——
  // 否则 8 月帖子里的 "Wednesday" 会被标成这周三（v1.8 修复）
  const parsedDates = batchParseDeadlines_(allTodos.map(t => t.deadlineRaw), allTodos.map(t => t.refDate));
  allTodos.forEach((t, i) => { t.deadline = parsedDates[i]; });

  // 第 4 步：去重（同课程 + 接近 deadline + 标题相似）
  const dedupedTodos = dedupTodos_(allTodos);
  Logger.log(`[Todo] after dedup: ${dedupedTodos.length}`);

  // 第 5 步：把已有 sheet 中的 status 应用到当前结果上（让用户已标记完成/忽略的不重新出现）
  // 同时分类：课程 → 'course'；其余 → 'career'（实习求职）/ 'campus'（校园活动，含无法归类的）
  dedupedTodos.forEach(t => {
    const prevStatus = existingStatus[t.todoId];
    t.status = (prevStatus && prevStatus !== STATUS_PENDING) ? prevStatus : STATUS_PENDING;
    t.category = categorize_(t.course, `${t.titleEn} ${t.titleZh} ${t.sourceTitle} ${t.sender || ''}`) || 'campus';
  });

  // 第 6 步：分桶
  const byBucket = bucketize_(dedupedTodos, now);

  // 第 7 步：写入 To-Do sheet（包括 Done/Ignored 行，方便用户看到历史）
  writeTodoSheet_(dedupedTodos, now);

  // 第 8 步：返回供简报使用的数据。课程待办按桶返回（total / urgentCount 只算课程），
  // 非课程待办进 extras，不挤占课程的桶和计数。
  const visibleByBucket = {};
  const extras = { career: [], campus: [] };
  for (const k of Object.keys(byBucket)) {
    visibleByBucket[k] = [];
    byBucket[k].filter(t => t.status === STATUS_PENDING)
      .forEach(t => (t.category === 'course' ? visibleByBucket[k] : extras[t.category]).push(t));
  }
  const totalPending = Object.keys(visibleByBucket).reduce((n, k) => n + visibleByBucket[k].length, 0);

  Logger.log(`[Todo] 课程: 逾期=${visibleByBucket.overdue.length} 48h=${visibleByBucket.h48.length} 本周=${visibleByBucket.week.length} 之后=${visibleByBucket.later.length} 无期限=${visibleByBucket.noDate.length} | 非课程: 实习=${extras.career.length} 校园=${extras.campus.length}`);

  // 把今日总待办（含已完成）写入 Stats，供进度条计算
  try {
    const todayDone = getTodayStats_().done;
    setTodayTotal_(totalPending + todayDone);
  } catch (e) {
    Logger.log(`[Todo] setTodayTotal_ failed: ${e.message}`);
  }

  return {
    byBucket: visibleByBucket,
    extras: extras,
    total: totalPending,
    urgentCount: visibleByBucket.overdue.length + visibleByBucket.h48.length,
  };
}

// ============================================================
// 数据收集
// ============================================================

// 从 Tasks / 任务 sheet 读取 Pending 行
function collectGmailTasks_() {
  const sheet = getTaskSheet_();
  if (sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx = findCols_(headers, {
    dateAdded: ['Date Added', '添加时间'],
    course: ['Course', '课程'],
    titleZh: ['Task (ZH)', '任务（中文）'],
    titleEn: ['Task (EN)'],
    deadline: ['Deadline', '截止日期'],
    priority: ['Priority', '优先级'],
    confidence: ['Confidence', '置信度'],
    status: ['Status', '状态'],
    subject: ['Source Subject', '来源邮件主题'],
    sender: ['From', '发件人'],
    link: ['Gmail Link', '链接'],
  });

  const staleCutoff = Date.now() - STALE_NO_DEADLINE_DAYS * 86400000;
  const minTaskDate = TODO_CONFIG.MIN_TASK_DATE ? new Date(TODO_CONFIG.MIN_TASK_DATE) : null;
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const status = String(row[idx.status] || '').trim();
    if (status !== STATUS_PENDING && !status.toLowerCase().includes('pending') && !status.includes('待')) continue;

    const added = idx.dateAdded >= 0 ? new Date(String(row[idx.dateAdded] || '')) : null;

    // 学期开学硬切线：早于 MIN_TASK_DATE 的旧任务一律隐藏；日期缺失/无法解析同样隐藏（fail-closed）
    if (minTaskDate && added && (isNaN(added) || added < minTaskDate)) continue;

    const courseRaw = String(row[idx.course] || '').trim();
    const titleEn = String(row[idx.titleEn] || '').trim();
    const titleZh = String(row[idx.titleZh] || '').trim();
    if (!titleEn && !titleZh) continue;

    const deadlineRaw = String(row[idx.deadline] || '').trim();
    // 无截止 + 添加超过 7 天 → 过期噪音，自动隐藏
    if (!deadlineRaw && added && !isNaN(added) && added.getTime() < staleCutoff) continue;

    out.push({
      todoId: `gmail_${r + 1}_0`,  // r+1 = sheet 行号（1-indexed）
      source: 'Gmail',
      sourceRow: r + 1,
      refDate: added,  // 相对日期（Friday）的解析基准：任务入库日≈邮件日
      course: typeof normalizeCourseCode_ === 'function' ? (normalizeCourseCode_(courseRaw) || courseRaw) : courseRaw,
      titleZh: titleZh,
      titleEn: titleEn,
      deadlineRaw: deadlineRaw,
      priority: String(row[idx.priority] || 'medium').toLowerCase(),
      confidence: String(row[idx.confidence] || 'medium').toLowerCase(),
      sourceLink: String(row[idx.link] || ''),
      sourceTitle: String(row[idx.subject] || ''),
      sender: String(row[idx.sender] || ''),
    });
  }
  return out;
}

// 从 Ed Posts sheet 读取 instructor / announcement 类型且有 deadline 的帖
function collectEdTasks_() {
  const sheet = getEdPostSheet_();
  ensureEdTodoStatusColumn_(sheet);  // 自动加第 13 列
  if (sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const todoStatusCol = headers.findIndex(h => String(h).includes('Todo Status') || String(h).includes('待办状态'));

  const minTaskDate = TODO_CONFIG.MIN_TASK_DATE ? new Date(TODO_CONFIG.MIN_TASK_DATE) : null;

  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const type = String(row[3] || '').toLowerCase();
    // v1.6：置顶帖和助教帖只要带 deadline 也应进 To-Do
    if (!['pinned', 'announcement', 'instructor', 'ta'].includes(type)) continue;

    if (!isConfiguredCourse_(row[2])) continue;

    // 学期开学硬切线：早于 MIN_TASK_DATE 的旧帖一律隐藏；日期缺失/无法解析同样隐藏（fail-closed）
    const postDate = new Date(String(row[1] || ''));
    if (isNaN(postDate) || (minTaskDate && postDate < minTaskDate)) continue;

    const deadlineRaw = String(row[10] || '').trim();
    if (!deadlineRaw) continue;  // Ed 任务必须有 deadline 才进 To-Do

    const todoStatus = todoStatusCol >= 0 ? String(row[todoStatusCol] || '').trim() : '';
    if (todoStatus === STATUS_DONE || todoStatus === STATUS_IGNORED) continue;

    const postId = String(row[0] || '');
    const courseRaw = String(row[2] || '');

    out.push({
      todoId: `ed_${postId}_0`,
      source: 'Ed',
      sourcePostId: postId,
      refDate: postDate,  // 帖子里的 "Friday" 指发帖那周的周五，不是今天之后的周五
      course: typeof normalizeCourseCode_ === 'function' ? (normalizeCourseCode_(courseRaw) || courseRaw) : courseRaw,
      // 用 AI summary 当中文标题；v1.6 摘要里含 " ▸ 要点" 后缀，这里只取正文部分
      titleZh: String(row[8] || '').split('▸')[0].trim().substring(0, 80),
      titleEn: String(row[5] || ''),                   // 帖子标题
      deadlineRaw: deadlineRaw,
      priority: String(row[9] || 'medium').toLowerCase(),
      confidence: 'medium',  // Ed 任务统一 medium（v1.3 没存 confidence）
      sourceLink: String(row[7] || ''),
      sourceTitle: String(row[5] || ''),
    });
  }
  return out;
}

// ============================================================
// 双向同步
// ============================================================

// 读取已有 To-Do sheet 的 (todoId, status) 并把非 Pending 的写回源 sheet
// 返回 { todoId: status } 映射，供后续构建时使用
function syncStatusToSourceSheets_() {
  const map = {};
  let sheet;
  try {
    sheet = getTodoSheet_();
  } catch (e) {
    Logger.log(`[Todo] no existing To-Do sheet: ${e.message}`);
    return map;
  }
  if (sheet.getLastRow() <= 1) return map;

  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    const todoId = String(data[r][0] || '').trim();
    const status = String(data[r][9] || '').trim();
    if (!todoId) continue;
    map[todoId] = status || STATUS_PENDING;

    // 只把 非 Pending 的状态回写到源（含被合并掉的同义来源，避免"标记一个另一个又冒出来"）
    if (status === STATUS_DONE || status === STATUS_IGNORED) {
      writeStatusToSource_(todoId, status);
      let mergedIds = [];
      try { mergedIds = JSON.parse(String(data[r][14] || '[]')); } catch (e) {}
      mergedIds.forEach(mid => { if (mid && mid !== todoId) writeStatusToSource_(mid, status); });
    }
  }
  return map;
}

// 解析 todoId → 找到源 sheet 的位置 → 写状态
function writeStatusToSource_(todoId, status) {
  try {
    const parts = todoId.split('_');
    const source = parts[0];

    if (source === 'gmail') {
      const rowNum = parseInt(parts[1], 10);
      if (!rowNum || rowNum < 2) return;
      const sheet = getTaskSheet_();
      // Status 是第 8 列
      sheet.getRange(rowNum, 8).setValue(status);
    } else if (source === 'ed') {
      // ed_{postId}_0 → postId 可能含下划线，取中间所有部分
      const postId = parts.slice(1, parts.length - 1).join('_');
      const sheet = getEdPostSheet_();
      ensureEdTodoStatusColumn_(sheet);
      const data = sheet.getDataRange().getValues();
      for (let r = 1; r < data.length; r++) {
        if (String(data[r][0]) === postId) {
          // Todo Status 是第 13 列（index 12）
          sheet.getRange(r + 1, 13).setValue(status);
          return;
        }
      }
    }
  } catch (e) {
    Logger.log(`[Todo] sync ${todoId} failed: ${e.message}`);
  }
}

// 给 Ed Posts sheet 加第 13 列（如果还没有）
function ensureEdTodoStatusColumn_(sheet) {
  if (sheet.getLastColumn() >= 13) {
    const header = sheet.getRange(1, 13).getValue();
    if (String(header).includes('Todo Status') || String(header).includes('待办状态')) return;
  }
  sheet.getRange(1, 13).setValue('Todo Status\n待办状态')
       .setBackground('#1a73e8')
       .setFontColor('#ffffff')
       .setFontWeight('bold')
       .setWrap(true);
  sheet.setColumnWidth(13, 110);
}

// ============================================================
// 去重 / 分桶
// ============================================================

function dedupTodos_(todos) {
  const out = [];
  for (const t of todos) {
    t._mergedIds = t._mergedIds || [];  // 同一逻辑任务的其他来源 todoId
    let dup = null;
    for (const existing of out) {
      if (isDuplicate_(t, existing)) { dup = existing; break; }
    }
    if (!dup) {
      out.push(t);
      continue;
    }
    // 决定保留哪个：先比置信度，再优先 Gmail（信息更完整），再优先有解析出的 deadline
    const tConf = confRank_(t.confidence);
    const dConf = confRank_(dup.confidence);
    let keepNew = false;
    if (tConf > dConf) keepNew = true;
    else if (tConf === dConf) {
      if (t.source === 'Gmail' && dup.source !== 'Gmail') keepNew = true;
      else if (t.deadline && !dup.deadline) keepNew = true;
    }
    if (keepNew) {
      const i = out.indexOf(dup);
      t._mergedIds = (t._mergedIds || []).concat(dup._mergedIds || [], [dup.todoId]);
      out[i] = t;
    } else {
      dup._mergedIds = (dup._mergedIds || []).concat(t._mergedIds || [], [t.todoId]);
    }
  }
  return out;
}

// 标题归一化：去课程代码前缀、停用词、标点、大小写
function normTitle_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^\s*(fit\d{4}[\s\-_:|/]*)+/g, '')        // 去 "FIT5197 " 前缀（含连接符）
    .replace(/\b(fit\d{4})\b/g, '')                     // 去散落的课程代码
    .replace(/\b(the|a|an|of|use|to|for|in|on|with|and|or|is|are|be|by)\b/g, ' ')
    .replace(/[\s\-_,.;:()\[\]{}!?'"|/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate_(a, b) {
  if (a.course && b.course && a.course !== b.course) return false;

  const ta = normTitle_(a.titleEn || a.titleZh || '');
  const tb = normTitle_(b.titleEn || b.titleZh || '');
  if (!ta || !tb) return false;

  const sim = titleSimilarity_(ta, tb);

  // 标题极相似（≥0.85）：跨桶合并，无视 deadline 是否一致
  // —— 这是修复"48h 和本周显示同一任务"的关键
  if (sim >= 0.85) return true;

  // 标题中等相似（≥0.55）：必须 deadline 同一天
  if (sim >= 0.55) {
    const ad = a.deadline, bd = b.deadline;
    if (!ad || !bd) return false;
    return ad.getFullYear() === bd.getFullYear()
        && ad.getMonth() === bd.getMonth()
        && ad.getDate() === bd.getDate();
  }
  return false;
}

function titleSimilarity_(a, b) {
  const tokenize = s => s.split(/\s+/).filter(Boolean);
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  setA.forEach(x => { if (setB.has(x)) inter++; });
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function confRank_(c) {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

function bucketize_(todos, now) {
  const buckets = { overdue: [], h48: [], week: [], later: [], noDate: [] };
  const h48Threshold = TODO_CONFIG.H48_HOURS * 3600 * 1000;
  const weekThreshold = TODO_CONFIG.WEEK_DAYS * 24 * 3600 * 1000;
  // 超过 STALE_DAYS 天前的过期任务不进任何桶（太旧，应手动清理）
  const staleCutoff = -(TODO_CONFIG.STALE_DAYS * 24 * 3600 * 1000);
  for (const t of todos) {
    if (!t.deadline) {
      buckets.noDate.push(t);
      continue;
    }
    const diff = t.deadline.getTime() - now.getTime();
    if (diff < staleCutoff) continue;  // 太旧，跳过
    if (diff < 0) {
      // v1.7：已过 deadline 但仍在 STALE_DAYS 窗口内 —— 独立置顶桶，
      // 不再混进 h48（之前 diff 为负数时 diff < h48Threshold 恒真，逾期和未到期长得一样）
      t.overdueDays = Math.ceil(-diff / (24 * 3600 * 1000));
      buckets.overdue.push(t);
    } else if (diff < h48Threshold) {
      buckets.h48.push(t);
    } else if (diff < weekThreshold) {
      buckets.week.push(t);
    } else {
      buckets.later.push(t);
    }
  }
  // 桶内按 deadline 升序（noDate 桶按优先级降序；overdue 也升序，逾期最久的排最上）
  const byDate = (a, b) => a.deadline - b.deadline;
  buckets.overdue.sort(byDate);
  buckets.h48.sort(byDate);
  buckets.week.sort(byDate);
  buckets.later.sort(byDate);
  buckets.noDate.sort((a, b) => confRank_(b.priority) - confRank_(a.priority));
  // 把桶名挂到每条 todo 上（写表用）
  buckets.overdue.forEach(t => t.bucket = BUCKET_OVERDUE);
  buckets.h48.forEach(t => t.bucket = BUCKET_48H);
  buckets.week.forEach(t => t.bucket = BUCKET_WEEK);
  buckets.later.forEach(t => t.bucket = BUCKET_LATER);
  buckets.noDate.forEach(t => t.bucket = BUCKET_NODATE);
  return buckets;
}

// ============================================================
// To-Do Sheet 写入
// ============================================================

function getTodoSheet_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  let sheet = ss.getSheetByName(TODO_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TODO_SHEET_NAME);
    initTodoHeaders_(sheet);
    Logger.log(`Created "${TODO_SHEET_NAME}" sheet.`);
  }
  if (sheet.getLastRow() === 0) initTodoHeaders_(sheet);
  return sheet;
}

function initTodoHeaders_(sheet) {
  sheet.appendRow(TODO_HEADERS);
  sheet.setFrozenRows(1);
  const widths = [120, 100, 90, 200, 200, 130, 130, 80, 80, 110, 70, 110, 220, 130];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  const headerRange = sheet.getRange(1, 1, 1, TODO_HEADERS.length);
  headerRange.setBackground('#1a73e8')
             .setFontColor('#ffffff')
             .setFontWeight('bold')
             .setWrap(true);
  sheet.setRowHeight(1, 50);

  // Status 列下拉
  const statusValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS_PENDING, STATUS_DONE, STATUS_IGNORED], true)
    .setAllowInvalid(false)
    .build();
  // 应用到大量行（应付未来增长）
  sheet.getRange(2, 10, 1000, 1).setDataValidation(statusValidation);
}

function writeTodoSheet_(todos, now) {
  let sheet;
  try {
    sheet = getTodoSheet_();
  } catch (e) {
    Logger.log(`[Todo] cannot get To-Do sheet: ${e.message}`);
    return;
  }

  // 清空数据行（保留表头）
  // 用变量固定行数，防止 clearContent 后 getLastRow() 被重算为 1
  const existingRows = sheet.getLastRow() - 1;
  if (existingRows > 0) {
    const clearRange = sheet.getRange(2, 1, existingRows, TODO_HEADERS.length);
    clearRange.clearContent();
    clearRange.setBackground(null).setFontLine('none').setFontColor(null);
  }

  if (todos.length === 0) return;

  const tz = Session.getScriptTimeZone();
  const nowStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');

  const rows = todos.map(t => [
    t.todoId,
    t.bucket || BUCKET_NODATE,
    t.course || '',
    t.titleZh || '',
    t.titleEn || '',
    t.deadline ? Utilities.formatDate(t.deadline, tz, 'yyyy-MM-dd HH:mm') : '',
    t.deadlineRaw || '',
    t.priority || 'medium',
    t.confidence || 'medium',
    t.status || STATUS_PENDING,
    t.source || '',
    t.sourceLink || '',
    t.sourceTitle || '',
    nowStr,
    JSON.stringify(t._mergedIds || []),  // 第 15 列：合并掉的同义任务 todoId
  ]);

  sheet.getRange(2, 1, rows.length, TODO_HEADERS.length).setValues(rows);

  // 着色
  for (let i = 0; i < todos.length; i++) {
    const range = sheet.getRange(i + 2, 1, 1, TODO_HEADERS.length);
    const t = todos[i];
    if (t.status === STATUS_DONE) {
      range.setBackground('#e8eaed').setFontLine('line-through');
    } else if (t.status === STATUS_IGNORED) {
      range.setBackground('#f1f3f4').setFontColor('#999');
    } else if (t.bucket === BUCKET_OVERDUE) {
      range.setBackground('#f6c7c2').setFontColor('#c5221f');
    } else if (t.bucket === BUCKET_48H) {
      range.setBackground('#fce8e6');
    } else if (t.bucket === BUCKET_WEEK) {
      range.setBackground('#fff8e1');
    }
  }

  // 重新应用 Status 下拉（清空后会丢失）
  const statusValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS_PENDING, STATUS_DONE, STATUS_IGNORED], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 10, Math.max(rows.length, 100), 1).setDataValidation(statusValidation);
}

// ============================================================
// 工具
// ============================================================

// 在 headers 数组中按候选关键字找到列下标
function findCols_(headers, mapping) {
  const out = {};
  for (const key in mapping) {
    const candidates = mapping[key];
    const i = headers.findIndex(h => candidates.some(c => String(h).includes(c)));
    out[key] = i;
  }
  return out;
}

// ============================================================
// 学期切换清理（由 rolloverSemester() 调用）
// ============================================================
// 把 MIN_TASK_DATE 之前的旧学期遗留任务统一标为"忽略 Ignored"，
// 让它们不再出现在 To-Do / 简报 / 仪表盘里。
// ⚠️ 只改 Status 列，不删除任何行、不动任何邮件。
function cleanupPreviousSemester_() {
  const minDate = TODO_CONFIG.MIN_TASK_DATE ? new Date(TODO_CONFIG.MIN_TASK_DATE) : null;
  if (!minDate || isNaN(minDate)) {
    Logger.log('[Rollover] TODO_CONFIG.MIN_TASK_DATE 未设置或无效，已中止');
    return 0;
  }
  const cutoffStr = Utilities.formatDate(minDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  Logger.log(`[Rollover] 硬切线 = ${cutoffStr}，早于该日期的待办将被标为"忽略"`);

  let tasksCleaned = 0;
  let edCleaned = 0;

  // ── 1. Tasks 表：按 Date Added 判断 ──
  try {
    const sheet = getTaskSheet_();
    if (sheet.getLastRow() > 1) {
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idx = findCols_(headers, {
        status: ['Status', '状态'],
        added: ['Date Added', '添加日期', '日期'],
      });

      // findCols_ 找不到会返回 -1，直接用会写错列，这里必须挡住
      if (idx.status < 0 || idx.added < 0) {
        throw new Error(`Tasks 表缺少必要列（status=${idx.status}, added=${idx.added}）`);
      }

      for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const status = String(row[idx.status] || '').trim();
        const isPending = status === STATUS_PENDING
          || status.toLowerCase().includes('pending')
          || status.includes('待');
        if (!isPending) continue;

        // 日期缺失/无法解析视为陈旧噪音，同样标为忽略（fail-closed，与 collectGmailTasks_ 的隐藏逻辑保持一致）
        const added = new Date(String(row[idx.added] || ''));
        if (!isNaN(added) && added >= minDate) continue;

        sheet.getRange(r + 1, idx.status + 1).setValue(STATUS_IGNORED);
        tasksCleaned++;
      }
    }
  } catch (e) {
    Logger.log(`[Rollover] Tasks 表处理失败: ${e.message}`);
  }

  // ── 2. Ed Posts 表：把旧学期帖的 Todo Status 标为忽略 ──
  try {
    const sheet = getEdPostSheet_();
    ensureEdTodoStatusColumn_(sheet);
    if (sheet.getLastRow() > 1) {
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const todoStatusCol = headers.findIndex(
        h => String(h).includes('Todo Status') || String(h).includes('待办状态')
      );

      if (todoStatusCol >= 0) {
        for (let r = 1; r < data.length; r++) {
          const row = data[r];
          const cur = String(row[todoStatusCol] || '').trim();
          if (cur === STATUS_DONE || cur === STATUS_IGNORED) continue;

          // 日期缺失/无法解析视为陈旧噪音，同样标为忽略（fail-closed）
          const postDate = new Date(String(row[1] || ''));
          if (!isNaN(postDate) && postDate >= minDate) continue;

          sheet.getRange(r + 1, todoStatusCol + 1).setValue(STATUS_IGNORED);
          edCleaned++;
        }
      }
    }
  } catch (e) {
    Logger.log(`[Rollover] Ed Posts 表处理失败: ${e.message}`);
  }

  Logger.log(`[Rollover] Tasks 表 ${tasksCleaned} 条旧任务、Ed Posts ${edCleaned} 条旧帖标为忽略（没删任何行）`);
  return tasksCleaned + edCleaned;
}
