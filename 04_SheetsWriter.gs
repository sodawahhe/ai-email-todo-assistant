// ============================================================
// 04_SheetsWriter.gs — Google Sheets 任务管理
// Google Sheets task management
// ============================================================

const SHEET_HEADERS = [
  '添加时间\nDate Added',
  '课程\nCourse',
  '任务（中文）\nTask (ZH)',
  'Task (EN)',
  '截止日期\nDeadline',
  '优先级\nPriority',
  '置信度\nConfidence',
  '状态\nStatus',
  '备注（中文）\nNote (ZH)',
  'Note (EN)',
  '来源邮件主题\nSource Subject',
  '发件人\nFrom',
  '链接\nGmail Link',
];

// ── 获取或初始化 Tasks 工作表 ──
function getTaskSheet_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  let sheet = ss.getSheetByName('Tasks / 任务');
  if (!sheet) {
    sheet = ss.insertSheet('Tasks / 任务');
    initSheetHeaders_(sheet);
    Logger.log('Created "Tasks / 任务" sheet with headers.');
  }
  // 确保表头存在
  if (sheet.getLastRow() === 0) {
    initSheetHeaders_(sheet);
  }
  return sheet;
}

function initSheetHeaders_(sheet) {
  sheet.appendRow(SHEET_HEADERS);
  // 冻结第一行
  sheet.setFrozenRows(1);
  // 设置列宽
  sheet.setColumnWidth(1, 130);  // Date
  sheet.setColumnWidth(2, 90);   // Course
  sheet.setColumnWidth(3, 180);  // Task ZH
  sheet.setColumnWidth(4, 180);  // Task EN
  sheet.setColumnWidth(5, 140);  // Deadline
  sheet.setColumnWidth(6, 80);   // Priority
  sheet.setColumnWidth(7, 80);   // Confidence
  sheet.setColumnWidth(8, 100);  // Status
  sheet.setColumnWidth(9, 200);  // Note ZH
  sheet.setColumnWidth(10, 200); // Note EN
  sheet.setColumnWidth(11, 200); // Source Subject
  sheet.setColumnWidth(12, 160); // From
  sheet.setColumnWidth(13, 120); // Gmail Link

  // 设置表头样式
  const headerRange = sheet.getRange(1, 1, 1, SHEET_HEADERS.length);
  headerRange.setBackground('#1a73e8')
             .setFontColor('#ffffff')
             .setFontWeight('bold')
             .setWrap(true);
  sheet.setRowHeight(1, 50);
}

// thread.getPermalink() 默认返回 /u/0/，多账号浏览器会跳错号导致 Gmail 落到搜索页
// 改为 ?authuser=<email> 形式，强制路由到学校账号
function gmailDirectLink_(permalink, email) {
  if (!permalink) return '';
  const m = permalink.match(/#(\w+)\/([\w]+)/);
  if (!m) return permalink;
  const folder = m[1], threadId = m[2];
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email || USER_CONFIG.EMAIL)}#${folder}/${threadId}`;
}

// ── 写入任务列表到 Sheets ──
function writeTasks_(tasks, courseName, emailSubject, sender, threadUrl) {
  if (!tasks || tasks.length === 0) return;

  let sheet;
  try {
    sheet = getTaskSheet_();
  } catch (e) {
    Logger.log(`Cannot access Google Sheet: ${e.message}`);
    return;
  }

  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const rows = [];

  for (const task of tasks) {
    // 跳过低置信度的学生讨论类任务
    // Skip low-confidence items to reduce noise
    if (task.confidence === 'low' && task.priority === 'low') continue;

    const priority = task.priority || 'medium';
    const row = [
      now,
      courseName || task.course_hint || '',
      task.title_zh || '',
      task.title || '',
      task.deadline_str || '',
      priority,
      task.confidence || 'medium',
      '待完成 Pending',
      task.note_zh || '',
      task.note || '',
      emailSubject || '',
      sender || '',
      threadUrl ? gmailDirectLink_(threadUrl, USER_CONFIG.EMAIL)
                : `https://mail.google.com/mail/?authuser=${encodeURIComponent(USER_CONFIG.EMAIL)}#search/${encodeURIComponent(emailSubject || '')}`,
    ];
    rows.push(row);
  }

  if (rows.length === 0) return;

  try {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.length)
         .setValues(rows);

    // 根据优先级设置行颜色
    const startRow = sheet.getLastRow() - rows.length + 1;
    for (let i = 0; i < rows.length; i++) {
      const priority = rows[i][5]; // priority column
      const range = sheet.getRange(startRow + i, 1, 1, SHEET_HEADERS.length);
      if (priority === 'high') {
        range.setBackground('#fce8e6');  // light red
      } else if (priority === 'medium') {
        range.setBackground('#fff8e1');  // light yellow
      }
    }

    Logger.log(`Wrote ${rows.length} tasks to Google Sheet.`);
  } catch (e) {
    Logger.log(`Sheet write error: ${e.message}`);
  }
}

// ============================================================
// Ed Discussion 帖子表
// ============================================================

const ED_POST_HEADERS = [
  'Post ID',
  '发帖时间\nDate',
  '课程\nCourse',
  '类型\nType',
  '作者角色\nAuthor Role',
  '标题\nTitle',
  '正文\nContent',
  '链接\nURL',
  'AI 摘要\nAI Summary',
  'AI 优先级\nAI Priority',
  '截止日期\nDeadline',
  '已处理\nProcessed',
];

function getEdPostSheet_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  let sheet = ss.getSheetByName('Ed Posts');
  if (!sheet) {
    sheet = ss.insertSheet('Ed Posts');
    initEdPostHeaders_(sheet);
    Logger.log('Created "Ed Posts" sheet.');
  }
  if (sheet.getLastRow() === 0) initEdPostHeaders_(sheet);
  return sheet;
}

function initEdPostHeaders_(sheet) {
  sheet.appendRow(ED_POST_HEADERS);
  sheet.setFrozenRows(1);
  const widths = [100, 120, 80, 110, 90, 220, 280, 200, 240, 80, 120, 80];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  const headerRange = sheet.getRange(1, 1, 1, ED_POST_HEADERS.length);
  headerRange.setBackground('#1a73e8')
             .setFontColor('#ffffff')
             .setFontWeight('bold')
             .setWrap(true);
  sheet.setRowHeight(1, 50);
}

function writeEdPosts_(rows) {
  if (!rows || rows.length === 0) return;
  let sheet;
  try {
    sheet = getEdPostSheet_();
  } catch (e) {
    Logger.log(`Cannot access Ed Posts sheet: ${e.message}`);
    return;
  }

  const data = rows.map(r => [
    r.postId, r.date, r.course, r.type, r.authorRole,
    r.title, r.content, r.url, r.aiSummary, r.aiPriority,
    r.deadline, r.processed,
  ]);

  try {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, data.length, ED_POST_HEADERS.length).setValues(data);

    // 按类型着色
    for (let i = 0; i < rows.length; i++) {
      const range = sheet.getRange(startRow + i, 1, 1, ED_POST_HEADERS.length);
      const t = rows[i].type;
      if (t === 'pinned') range.setBackground('#fef7e0');        // 置顶：琥珀色
      else if (t === 'announcement') range.setBackground('#fce8e6');
      else if (t === 'instructor') range.setBackground('#fff8e1');
      else if (t === 'ta') range.setBackground('#f1f8f4');       // 助教：淡绿
      else if (t === 'my_reply') range.setBackground('#e8f0fe');
    }
  } catch (e) {
    Logger.log(`Ed Posts write error: ${e.message}`);
  }
}

// 简报 Ed 区块：最近 ED_CONFIG.RECENT_DAYS 天内、本学期课程、没有可解析截止日期的讲师/公告/置顶/助教帖。
// - 有截止日期的帖子已经在 To-Do 里（带完成/忽略按钮），这里不重复列
// - 在 To-Do 里点过完成/忽略的帖子（Todo Status 列）也不再出现
// - 最新的在最前，不再按"置顶优先"排序——老置顶帖不该压住新通知
function getRecentEdPosts_() {
  try {
    const sheet = getEdPostSheet_();
    if (sheet.getLastRow() <= 1) return [];

    const cutoff = Date.now() - ED_CONFIG.RECENT_DAYS * 86400000;
    const minDate = TODO_CONFIG.MIN_TASK_DATE ? new Date(TODO_CONFIG.MIN_TASK_DATE) : null;

    return sheet.getDataRange().getValues().slice(1)
      .filter(row => {
        if (!['pinned', 'announcement', 'instructor', 'ta'].includes(String(row[3] || '').toLowerCase())) return false;
        if (!isConfiguredCourse_(row[2])) return false;
        const posted = new Date(String(row[1] || ''));
        if (isNaN(posted) || posted < cutoff || (minDate && posted < minDate)) return false;
        const status = String(row[12] || '').trim();  // Todo Status（第 13 列）
        if (status === STATUS_DONE || status === STATUS_IGNORED) return false;
        return !parseDeadline_(row[10], posted);
      })
      .map(row => ({
        postId: row[0], date: row[1], course: row[2], type: row[3],
        title: row[5], url: row[7], aiSummary: row[8],
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, ED_CONFIG.DIGEST_LIMIT);
  } catch (e) {
    Logger.log(`Cannot read Ed Posts: ${e.message}`);
    return [];
  }
}

// ============================================================
// Stats 表 — 每日进度 / XP / 连胜
// ============================================================

const STATS_HEADERS = ['日期\nDate', '已完成\nDone', '今日总数\nTotal', 'XP', '连胜\nStreak'];
const XP_PER_TASK = 10;

function getStatsSheet_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  let sheet = ss.getSheetByName('Stats');
  if (!sheet) {
    sheet = ss.insertSheet('Stats');
    sheet.appendRow(STATS_HEADERS);
    sheet.setFrozenRows(1);
    [110, 80, 80, 80, 80].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    sheet.getRange(1, 1, 1, STATS_HEADERS.length)
         .setBackground('#1a73e8').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(STATS_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function findStatsRow_(sheet, dateKey) {
  if (sheet.getLastRow() <= 1) return -1;
  const dates = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i][0]).startsWith(dateKey)) return i + 2;  // 1-indexed sheet row
  }
  return -1;
}

// 完成一个任务：done+1, XP+10, 更新连胜
function recordTaskDone_() {
  try {
    const sheet = getStatsSheet_();
    const today = todayKey_();
    let row = findStatsRow_(sheet, today);

    if (row < 0) {
      // 今日首次：计算连胜（昨天 done≥1 则 +1，否则置 1）
      const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const yRow = findStatsRow_(sheet, yesterday);
      let prevStreak = 0;
      if (yRow > 0) {
        const yDone = Number(sheet.getRange(yRow, 2).getValue()) || 0;
        prevStreak = yDone > 0 ? (Number(sheet.getRange(yRow, 5).getValue()) || 0) : 0;
      }
      sheet.appendRow([today, 1, 0, XP_PER_TASK, prevStreak + 1]);
    } else {
      const done = (Number(sheet.getRange(row, 2).getValue()) || 0) + 1;
      const xp = (Number(sheet.getRange(row, 4).getValue()) || 0) + XP_PER_TASK;
      sheet.getRange(row, 2).setValue(done);
      sheet.getRange(row, 4).setValue(xp);
      // 第一次完成时更新连胜
      if (done === 1) {
        const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        const yRow = findStatsRow_(sheet, yesterday);
        let prevStreak = 0;
        if (yRow > 0) {
          const yDone = Number(sheet.getRange(yRow, 2).getValue()) || 0;
          prevStreak = yDone > 0 ? (Number(sheet.getRange(yRow, 5).getValue()) || 0) : 0;
        }
        sheet.getRange(row, 5).setValue(prevStreak + 1);
      }
    }
  } catch (e) {
    Logger.log(`[Stats] recordTaskDone_ error: ${e.message}`);
  }
}

// 记录今日总数（每次 buildTodoList_ 调用更新）
function setTodayTotal_(total) {
  try {
    const sheet = getStatsSheet_();
    const today = todayKey_();
    let row = findStatsRow_(sheet, today);
    if (row < 0) {
      sheet.appendRow([today, 0, total, 0, 0]);
    } else {
      sheet.getRange(row, 3).setValue(total);
    }
  } catch (e) {
    Logger.log(`[Stats] setTodayTotal_ error: ${e.message}`);
  }
}

function getTodayStats_() {
  try {
    const sheet = getStatsSheet_();
    const row = findStatsRow_(sheet, todayKey_());
    if (row < 0) return { done: 0, total: 0, xp: 0, streak: 0 };
    const v = sheet.getRange(row, 1, 1, 5).getValues()[0];
    return {
      done: Number(v[1]) || 0,
      total: Number(v[2]) || 0,
      xp: Number(v[3]) || 0,
      streak: Number(v[4]) || 0,
    };
  } catch (e) {
    return { done: 0, total: 0, xp: 0, streak: 0 };
  }
}

function getWeekStats_() {
  try {
    const sheet = getStatsSheet_();
    if (sheet.getLastRow() <= 1) return { done: 0, totalXp: 0, days: 0 };
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    const cutoff = new Date(Date.now() - 7 * 86400000);
    let done = 0, totalXp = 0, days = 0;
    data.forEach(r => {
      const d = new Date(String(r[0]));
      if (!isNaN(d) && d >= cutoff) {
        done += Number(r[1]) || 0;
        totalXp += Number(r[3]) || 0;
        if ((Number(r[1]) || 0) > 0) days++;
      }
    });
    return { done, totalXp, days };
  } catch (e) {
    return { done: 0, totalXp: 0, days: 0 };
  }
}
