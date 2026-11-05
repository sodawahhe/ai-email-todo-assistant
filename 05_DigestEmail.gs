// ============================================================
// 05_DigestEmail.gs — 每日摘要邮件生成 + 发送
// Daily digest email generation + sending
// ============================================================

// ── 主函数：生成并发送每日摘要 ──
// v1.8：简报只保留 To-Do（课程分桶 + 非课程分类）和 Ed 近期通知。
// 去掉了"紧急/本周"AI 卡片（和 To-Do 重复，且喂的是未过滤的任务）、"今日邮件更新"
// （缓存从未被写入，永远显示"暂无新邮件"）、问候和提示语（白烧一次 AI 调用）。
function generateAndSendDigest_() {
  // v1.6：先给"重要但缺摘要"的 Ed 帖补调 AI，避免简报里只有光秃秃的标题
  try {
    backfillEdSummaries_();
  } catch (e) {
    Logger.log(`[Ed] 摘要补写跳过: ${e.message}`);
  }

  let todo = null, todoError = '';
  try {
    todo = buildTodoList_();
  } catch (e) {
    todoError = e.message;
    Logger.log(`[Digest] buildTodoList_ failed: ${e.message}`);
  }

  const tz = Session.getScriptTimeZone();
  const today = new Date();
  const html = buildDigestHtml_(
    Utilities.formatDate(today, tz, 'yyyy年MM月dd日 / MMMM d, yyyy'),
    getRecentEdPosts_(), todo, todoError);

  const shortDate = Utilities.formatDate(today, tz, 'MM/dd');
  // 实习/求职一周内有动作的条数放进主题：优先级不高，但不能错过
  const careerSoon = todo ? todo.extras.career.filter(t => [BUCKET_OVERDUE, BUCKET_48H, BUCKET_WEEK].includes(t.bucket)).length : 0;
  const subject = !todo
    ? `[待办生成失败] 学术简报 ${shortDate}`
    : (todo.urgentCount > 0 ? `[48h:${todo.urgentCount}] ` : '')
      + (careerSoon > 0 ? `[实习:${careerSoon}] ` : '')
      + `学术简报 ${shortDate} — ${todo.total} 条待办 / ${todo.total} To-Do`;

  // 发送邮件（发给自己），强制 UTF-8
  try {
    MailApp.sendEmail({
      to: USER_CONFIG.EMAIL,
      subject: subject,
      body: '请使用支持 HTML 的邮件客户端查看 / Please view in an HTML-compatible email client.',
      htmlBody: html,
      name: '学术助手 Academic Assistant',
      noReply: false,
    });
    Logger.log(`Digest email sent to ${USER_CONFIG.EMAIL}`);
    return true;
  } catch (e) {
    Logger.log(`Failed to send digest email: ${e.message}`);
    return false;
  }
}

// ── 构建仪表盘卡片（进度条 + 连胜 + XP）──
function buildDashboardCard_() {
  let stats = { done: 0, total: 0, xp: 0, streak: 0 };
  let week = { done: 0 };
  try { stats = getTodayStats_(); week = getWeekStats_(); } catch (e) {}

  const pct = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0;
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
  const token = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN') || '';
  const dashLink = (url && token)
    ? `<a href="${url}?token=${token}" style="display:inline-block;background:white;color:#1a73e8;font-size:13px;font-weight:600;padding:8px 16px;border-radius:20px;text-decoration:none;margin-top:14px;">📊 打开实时仪表盘 →</a>`
    : `<div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:10px;">提示：部署 Web App 后可解锁一键完成 + 实时仪表盘</div>`;

  return `<div class="card">
    <div class="card-header" style="background:linear-gradient(135deg,#34a853,#1e8e3e);color:white;padding:16px 20px;font-weight:600;font-size:15px;display:block;">
      &#127942; 今日进度 / Today's Progress
      <div style="background:rgba(255,255,255,0.2);border-radius:8px;height:10px;margin-top:10px;overflow:hidden;">
        <div style="background:white;height:100%;width:${pct}%;border-radius:8px;"></div>
      </div>
      <table style="width:100%;margin-top:12px;color:white;border-collapse:collapse;">
        <tr>
          <td style="text-align:center;padding:6px;"><div style="font-size:20px;font-weight:700;">${stats.done}/${stats.total}</div><div style="font-size:11px;opacity:0.85;">完成 / 总数</div></td>
          <td style="text-align:center;padding:6px;border-left:1px solid rgba(255,255,255,0.2);"><div style="font-size:20px;font-weight:700;">🔥${stats.streak}</div><div style="font-size:11px;opacity:0.85;">连胜天</div></td>
          <td style="text-align:center;padding:6px;border-left:1px solid rgba(255,255,255,0.2);"><div style="font-size:20px;font-weight:700;">⭐${stats.xp}</div><div style="font-size:11px;opacity:0.85;">今日 XP</div></td>
          <td style="text-align:center;padding:6px;border-left:1px solid rgba(255,255,255,0.2);"><div style="font-size:20px;font-weight:700;">${week.done}</div><div style="font-size:11px;opacity:0.85;">本周完成</div></td>
        </tr>
      </table>
      <div style="text-align:center;">${dashLink}</div>
    </div>
  </div>`;
}

// ── v1.7：Ed 区块为空时，判断是"真没帖子"还是"同步故障"，故障时显示红色告警条 ──
// 之前空字符串会让简报看起来"结构完整"，用户完全看不出 Ed 同步已经挂了多久。
function buildEdEmptyStateHtml_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const lastError = props.getProperty('ED_LAST_ERROR');
    const lastOk = props.getProperty('ED_LAST_OK');

    let staleOk = false;
    if (lastOk) {
      const okDate = new Date(lastOk.replace(' ', 'T'));
      if (!isNaN(okDate) && (Date.now() - okDate.getTime()) > 24 * 3600 * 1000) staleOk = true;
    }

    if (!lastError && !staleOk) return '';  // 从未报过错，且最近同步成功过 → 大概率真没重要帖

    const reason = lastError
      ? escHtml_(lastError)
      : `上次成功同步是 ${escHtml_(lastOk)}，已超过 24 小时`;

    return `
  <div class="card">
    <div class="card-header" style="background:#fce8e6;color:#c5221f;border-left:4px solid #d93025;padding:12px 18px;font-weight:600;font-size:15px;">
      &#9888;&#65039; Ed Discussion 同步异常 / Ed Sync Issue
    </div>
    <div class="card-body" style="padding:10px 18px;font-size:13px;color:#555;line-height:1.6;">
      Ed 区块本次为空，原因：${reason}<br>
      请在 Apps Script 编辑器跑一次 <code>testSetup()</code> 排查（多为 ED_TOKEN 失效或课程代码不匹配）。
    </div>
  </div>`;
  } catch (e) {
    return '';
  }
}

// ── 构建 HTML 邮件正文 ──
function buildDigestHtml_(dateStr, edPosts, todo, todoError) {
  const tz = Session.getScriptTimeZone();
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || '';
  const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : '#';
  const now = Utilities.formatDate(new Date(), tz, 'HH:mm z');

  // Ed 区块：只列最近 RECENT_DAYS 天、没有截止日期的帖子（见 getRecentEdPosts_）。
  // 区块为空时用 ED_LAST_ERROR / ED_LAST_OK 判断是"真没新帖"还是"同步挂了"（v1.7）。
  const edHtml = edPosts.length === 0
    ? buildEdEmptyStateHtml_()
    : `
  <div class="card">
    <div class="card-header" style="background:#f3e8fd;color:#6a1b9a;border-left:4px solid #8e24aa;padding:12px 18px;font-weight:600;font-size:15px;">
      &#128172; Ed Discussion — 近 ${ED_CONFIG.RECENT_DAYS} 天通知 / Recent Posts
      <span class="badge" style="background:#8e24aa;color:white;">${edPosts.length} 条</span>
    </div>
    <div class="card-body">
      ${edPosts.map(p => {
        const type = String(p.type || '').toLowerCase();
        const tag = type === 'pinned'       ? '📌 置顶'
                  : type === 'announcement' ? '📢 公告'
                  : type === 'instructor'   ? '👤 讲师'
                  : '🧑‍🏫 助教';
        // 发帖日期显式写出来：一眼能核对"这是不是最近的帖子"
        const posted = Utilities.formatDate(new Date(p.date), tz, 'MM/dd');

        // aiSummary 里 " ▸ " 分隔的是 AI 提取的要点，拆成列表渲染
        const parts = String(p.aiSummary || '').split('▸').map(s => s.trim()).filter(Boolean);
        const body = parts[0] || '';
        const points = parts.slice(1);

        const summaryHtml = body
          ? `<div style="font-size:13px;color:#444;margin-top:5px;line-height:1.6;">${escHtml_(body)}</div>`
          : '';
        const pointsHtml = points.length
          ? `<ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;color:#5f6368;line-height:1.7;">
               ${points.map(pt => `<li>${escHtml_(pt)}</li>`).join('')}
             </ul>`
          : '';

        // 置顶帖加左侧强调条，让它在简报里一眼可辨
        const accent = type === 'pinned'
          ? 'border-left:3px solid #f9ab00;padding-left:10px;background:#fffdf5;'
          : '';

        return `<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;${accent}">
          <div style="font-size:14px;"><strong>[${escHtml_(normalizeCourseCode_(p.course) || p.course)}]</strong> ${tag} <a href="${p.url}" style="color:#1a73e8;text-decoration:none;">${escHtml_(p.title)}</a> <span style="color:#999;font-size:12px;">${posted}</span></div>
          ${summaryHtml}
          ${pointsHtml}
        </div>`;
      }).join('')}
    </div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    background: #f8f9fa; color: #333; padding: 16px;
  }
  .container { max-width: 680px; margin: 0 auto; }
  .header {
    background: linear-gradient(135deg, #1a73e8, #0d47a1);
    color: white; padding: 24px; border-radius: 12px; margin-bottom: 16px;
  }
  .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .header .meta { font-size: 13px; opacity: 0.85; }
  .card {
    background: white; border-radius: 10px; margin-bottom: 14px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08); overflow: hidden;
  }
  .card-header {
    padding: 12px 18px; font-weight: 600; font-size: 15px;
    display: flex; align-items: center; gap: 8px;
  }
  .card-body { padding: 14px 18px; }
  .footer {
    text-align: center; color: #999; font-size: 12px; padding: 10px 0;
  }
  .footer a { color: #1a73e8; text-decoration: none; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 12px; font-weight: 600; margin-left: 6px; vertical-align: middle;
  }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <h1>&#128218; 每日学术简报</h1>
    <h1 style="font-size:17px;font-weight:400;margin-top:2px;">Daily Academic Digest</h1>
    <div class="meta" style="margin-top:8px;">
      ${dateStr} &nbsp;·&nbsp; 生成于 ${now}
    </div>
  </div>

  ${buildDashboardCard_()}

  ${buildTodoSectionHtml_(todo, todoError)}

  ${edHtml}

  <!-- Footer -->
  <div class="footer">
    <a href="${sheetUrl}">&#128203; 打开任务表格 / Open Task Sheet</a>
    &nbsp;·&nbsp;
    <a href="https://mail.google.com">&#128231; 查看 Gmail</a>
    &nbsp;·&nbsp;
    学术助手 v4
  </div>

</div>
</body>
</html>`;
}

// ============================================================
// To-Do 区块：课程（逾期 / 48h / 本周 / 之后）+ Career + Campus
// ============================================================

// HTML 转义：防止任务标题里的 <>&" 破坏邮件结构
function escHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildTodoSectionHtml_(todo, todoError) {
  if (!todo) {
    return `<div class="card">
      <div class="card-header" style="background:#fce8e6;color:#c5221f;border-left:4px solid #d93025;padding:12px 18px;font-weight:600;font-size:15px;">
        &#9888;&#65039; 待办生成失败 / To-Do build failed
      </div>
      <div class="card-body" style="font-size:13px;color:#555;">${escHtml_(todoError)}</div>
    </div>`;
  }

  const tz = Session.getScriptTimeZone();
  const fmt = (d, f) => Utilities.formatDate(d, tz, f);

  const sourceLink = (t) => {
    const icon = t.source === 'Ed' ? '&#128172;' : '&#128231;';
    const label = t.source === 'Ed' ? '打开 Ed' : '打开邮件';
    if (!t.sourceLink) return '';
    return `<a href="${t.sourceLink}" style="color:#1a73e8;text-decoration:none;font-size:12px;margin-left:6px;">${icon} ${label}</a>`;
  };

  // 一键操作按钮（仅当 Web App 已部署且 token 已设置时显示）
  const actionButtons = (t) => {
    let doneUrl = '#', ignoreUrl = '#';
    try {
      doneUrl = buildActionUrl_('done', t.todoId);
      ignoreUrl = buildActionUrl_('ignore', t.todoId);
    } catch (e) {}
    if (doneUrl === '#') return '';
    return `<span style="margin-left:8px;">
      <a href="${doneUrl}" style="display:inline-block;background:#34a853;color:white;font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;text-decoration:none;margin-right:4px;">&#9989; 完成</a>
      <a href="${ignoreUrl}" style="display:inline-block;background:#9aa0a6;color:white;font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;text-decoration:none;">&#9197; 忽略</a>
    </span>`;
  };

  // v1.7：标题中英双语——中文为主行（粗体），英文为次行（灰色小字）；两者相同或缺一时只渲染一行
  const renderTitle = (t) => {
    const zh = escHtml_(t.titleZh || '').trim();
    const en = escHtml_(t.titleEn || '').trim();
    if (zh && en && zh !== en) {
      return `<strong>${zh}</strong><div style="font-size:12.5px;color:#888;margin-top:1px;">${en}</div>`;
    }
    return `<strong>${zh || en || '(no title)'}</strong>`;
  };

  const overdueBadge = (t) => t.overdueDays
    ? `<span style="display:inline-block;background:#d93025;color:white;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-left:4px;">&#9888;&#65039; 已逾期${t.overdueDays}天 / ${t.overdueDays}d overdue</span>`
    : '';

  // v1.8：日期旁边写出"发布日 + 原文"——解析出的日期是否可信，一眼就能核对
  const provenance = (t) => {
    const posted = t.refDate && !isNaN(t.refDate) ? ` · 发布 ${fmt(t.refDate, 'MM/dd')}` : '';
    const raw = t.deadlineRaw ? ` · 原文 “${escHtml_(String(t.deadlineRaw).substring(0, 40))}”` : '';
    return `<span style="color:#aaa;font-size:11px;">${posted}${raw}</span>`;
  };

  const renderItem = (t) => {
    const deadline = t.deadline ? fmt(t.deadline, 'MM/dd HH:mm') : '';
    // 课程待办标课程代码；非课程待办不标（它们在各自的分类卡片里）
    const courseTag = t.category === 'course'
      ? `<span style="display:inline-block;background:#e8f0fe;color:#1a73e8;font-size:11px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:6px;">${escHtml_(t.course)}</span>`
      : '';
    return `<div style="padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:14px;line-height:1.5;">
      ${courseTag}${renderTitle(t)}${overdueBadge(t)}
      <div style="font-size:12px;color:#666;margin-top:2px;">
        &#128197; ${deadline || '无截止 / No deadline'}${provenance(t)}${sourceLink(t)}${actionButtons(t)}
      </div>
    </div>`;
  };

  const renderBucket = (todos, headerBg, headerColor, borderColor, emoji, labelZh, labelEn) => {
    if (todos.length === 0) return '';
    return `<div class="card">
      <div class="card-header" style="background:${headerBg};color:${headerColor};border-left:4px solid ${borderColor};padding:12px 18px;font-weight:600;font-size:15px;">
        ${emoji} ${labelZh} / ${labelEn}
        <span class="badge" style="background:${borderColor};color:white;">${todos.length}</span>
      </div>
      <div class="card-body" style="padding:6px 18px;">
        ${todos.map(renderItem).join('')}
      </div>
    </div>`;
  };

  const b = todo.byBucket;
  const courseTotal = b.overdue.length + b.h48.length + b.week.length + b.later.length;
  const courseHtml = courseTotal === 0 ? '' : `<div class="card">
    <div class="card-header" style="background:linear-gradient(135deg,#1a73e8,#0d47a1);color:white;padding:14px 18px;font-weight:600;font-size:15px;">
      &#128203; 课程待办 / Course To-Do
      <span class="badge" style="background:white;color:#1a73e8;">${courseTotal} 条</span>
      ${todo.urgentCount > 0 ? `<span class="badge" style="background:#ea4335;color:white;">${todo.urgentCount} 紧急</span>` : ''}
    </div>
  </div>`
    + renderBucket(b.overdue, '#fce8e6', '#c5221f', '#d93025', '&#9888;&#65039;', '已逾期', 'Overdue')
    + renderBucket(b.h48, '#fce8e6', '#c5221f', '#ea4335', '&#9200;', '48 小时内', 'Next 48h')
    + renderBucket(b.week, '#fff8e1', '#b06000', '#fbbc04', '&#128204;', '本周', 'This Week')
    + renderBucket(b.later, '#e8eaed', '#5f6368', '#9aa0a6', '&#128197;', '之后', 'Later')
    // 简报里完全不显示"无明确截止"（噪音多；仪表盘仍可见）
    + (TODO_CONFIG.HIDE_NO_DEADLINE_IN_DIGEST ? ''
       : renderBucket(b.noDate, '#f3e8fd', '#6a1b9a', '#8e24aa', '&#10067;', '无明确截止', 'No Deadline'));

  // 非课程待办：Career（实习/求职资源，要及时看到）在前，Campus 在后。紧凑单行，不限量、不砍桶：
  //  - 有截止日期的全部列出，逾期/48h 内的红色标记
  //  - Career 的无截止项也列（可能是"报名开放"之类的提醒）；Campus 的无截止项只给计数
  //  - 另附近 MAIL_DAYS 天打了该 Gmail 标签、但没生成待办的邮件（纯通知也不会被遗漏）
  const renderCompact = (t) => {
    const urgent = t.bucket === BUCKET_OVERDUE || t.bucket === BUCKET_48H;
    const when = t.deadline ? fmt(t.deadline, 'MM/dd HH:mm') : '无截止';
    const overdue = t.overdueDays ? ` · 已逾期${t.overdueDays}天` : '';
    return `<div style="padding:5px 0;border-bottom:1px solid #f0f0f0;font-size:13.5px;line-height:1.5;">
      ${urgent ? '&#9200; ' : ''}${escHtml_(t.titleZh || t.titleEn || '(no title)')}
      <span style="color:${urgent ? '#c5221f' : '#777'};font-size:12px;">&#128197; ${when}${overdue}</span>${sourceLink(t)}${actionButtons(t)}
    </div>`;
  };

  const extraCard = (cat, label, bg, color, border, emoji, zh, en, showNoDate) => {
    const list = todo.extras[cat];
    const dated = list.filter(t => t.bucket !== BUCKET_NODATE);
    const undated = list.filter(t => t.bucket === BUCKET_NODATE);
    const covered = new Set(list.map(t => t.sourceTitle));
    let mail = [];
    try {
      mail = GmailApp.search(`label:"${label}" newer_than:${TODO_CONFIG.MAIL_DAYS}d`, 0, 20)
        .map(th => ({ subject: th.getFirstMessageSubject(), link: gmailDirectLink_(th.getPermalink(), USER_CONFIG.EMAIL) }))
        .filter(m => !covered.has(m.subject)).slice(0, TODO_CONFIG.MAIL_LIMIT);
    } catch (e) {
      Logger.log(`[Digest] ${label} 近期邮件读取失败: ${e.message}`);
    }
    const rows = dated.concat(showNoDate ? undated : []);
    if (rows.length === 0 && mail.length === 0 && (showNoDate || undated.length === 0)) return '';

    const mailHtml = mail.length
      ? `<div style="font-size:11px;color:#999;margin-top:8px;">近 ${TODO_CONFIG.MAIL_DAYS} 天邮件（无待办）/ Recent mail</div>`
        + mail.map(m => `<div style="padding:3px 0;font-size:13px;"><a href="${m.link}" style="color:#1a73e8;text-decoration:none;">${escHtml_(m.subject)}</a></div>`).join('')
      : '';
    const undatedHtml = !showNoDate && undated.length
      ? `<div style="padding:6px 0;font-size:12px;color:#999;">另有 ${undated.length} 条无明确截止，见仪表盘 / ${undated.length} undated on dashboard</div>`
      : '';
    return `<div class="card">
      <div class="card-header" style="background:${bg};color:${color};border-left:4px solid ${border};padding:10px 18px;font-weight:600;font-size:14px;">
        ${emoji} ${zh} / ${en}
        <span class="badge" style="background:${border};color:white;">${rows.length + mail.length}</span>
      </div>
      <div class="card-body" style="padding:4px 18px 8px;">${rows.map(renderCompact).join('')}${undatedHtml}${mailHtml}</div>
    </div>`;
  };

  return courseHtml
    + extraCard('career', LABEL_CAREER, '#e6f4ea', '#1e8e3e', '#34a853', '&#128188;', '实习 / 求职', 'Career', true)
    + extraCard('campus', LABEL_CAMPUS, '#f1f3f4', '#5f6368', '#9aa0a6', '&#127979;', '校园活动', 'Campus', false);
}
