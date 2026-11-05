// ============================================================
// 01_Main.gs — 入口函数（编辑器函数下拉里只应该看到这几个）
// ============================================================
//   setupTriggers()          首次 / 改了简报时间后运行：重建全部触发器（只有 2 个）
//   testSetup()              体检：AI / Sheet / Gmail / Ed / 触发器 / Web App
//   runSync()                手动同步：Ed + Gmail（触发器每 2 小时跑一次）
//   runDailyDigest()         手动发送今日简报（触发器每天早上跑一次）
//   backfillCategoryLabels() 一次性：给老邮件补 Career / Campus 标签
//   rolloverSemester()       换学期时运行：旧待办标忽略 + 摘往学期课程标签
//   doGet()                  Web App 入口（见 10_WebApp.gs）
// 其余函数都以下划线结尾（Apps Script 约定：不出现在下拉里），不要直接运行。
// ============================================================

// ── 重建触发器：先删光所有旧的，避免残留重复 ──
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Ed + Gmail 同步：每 2 小时
  ScriptApp.newTrigger('runSync').timeBased().everyHours(2).create();

  // 早间简报：每天一次
  ScriptApp.newTrigger('runDailyDigest').timeBased()
    .atHour(USER_CONFIG.DIGEST_HOUR).nearMinute(USER_CONFIG.DIGEST_MINUTE).everyDays(1).create();

  const token = ensureWebAppToken_();
  Logger.log(`✅ 触发器已重建（2 个）：runSync 每 2 小时；runDailyDigest 每天 ${USER_CONFIG.DIGEST_HOUR}:${String(USER_CONFIG.DIGEST_MINUTE).padStart(2, '0')}`);
  Logger.log(`   Web App token: ${token}（部署后把 URL 填入脚本属性 WEBAPP_URL）`);
}

// ── 定时任务：同步 Ed + Gmail ──
// Ed 放前面：快、量小；Gmail 扫描遇到 AI 限速重试可能很久，放后面避免挤掉 Ed。互不影响。
function runSync() {
  try {
    syncEdDiscussion_();
  } catch (e) {
    Logger.log(`[Sync] Ed 错误: ${e.message}`);  // syncEdDiscussion_ 已把原因落到 ED_LAST_ERROR，简报会告警
  }
  try {
    const r = scanAndProcessEmails_();
    Logger.log(`[Sync] Gmail 完成 — 处理 ${r.processed} 封邮件，提取 ${r.tasks} 个任务`);
  } catch (e) {
    Logger.log(`[Sync] Gmail 错误: ${e.message}`);
  }
}

// ── 定时任务：发送每日简报 ──
function runDailyDigest() {
  try {
    Logger.log(`[Digest] ${generateAndSendDigest_() ? '简报已发送' : '发送失败'}`);
  } catch (e) {
    Logger.log(`[Digest] 错误: ${e.message}`);
  }
}

// ── 体检 ──
function testSetup() {
  const props = PropertiesService.getScriptProperties();
  const out = [];
  const check = (name, fn) => {
    try { out.push(`✅ ${name}: ${fn()}`); } catch (e) { out.push(`❌ ${name}: ${e.message}`); }
  };

  check('AI', () => {
    const p = PROVIDERS[props.getProperty('AI_PROVIDER')] || PROVIDERS.deepseek;
    if (!props.getProperty(p.keyProp)) throw new Error(`未设置 ${p.keyProp}`);
    try {
      callAI_('Reply with exactly: {"status":"OK"}', '', 30);
      return `${p.name} 连通`;
    } catch (e) {
      if (/429|1305|rate/i.test(e.message)) return `${p.name} Key 有效，当前繁忙(429)`;  // 限速不算失败
      throw e;
    }
  });
  check('Google Sheet', () => `"${SpreadsheetApp.openById(getSheetId_()).getName()}"`);
  check('Gmail', () => `${GmailApp.search('is:unread', 0, 1).length} 条未读可读取`);
  check('Ed', () => {
    const n = extractCourses_(edFetch_('/user')).length;
    if (!n) throw new Error('token 有效，但 0 门课程匹配 USER_CONFIG.COURSES');
    const last = props.getProperty('ED_LAST_ERROR');
    return `token 有效，匹配 ${n} 门课程` + (last ? `；最近一次同步失败: ${last}` : '');
  });
  check('触发器', () => {
    const have = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    const missing = ['runSync', 'runDailyDigest'].filter(f => !have.includes(f));
    if (missing.length) throw new Error(`缺少 ${missing.join(', ')}，请运行 setupTriggers()`);
    if (have.length > 2) throw new Error(`有 ${have.length} 个触发器（应为 2 个），请运行 setupTriggers() 清理`);
    return '2 个（runSync + runDailyDigest）';
  });
  out.push(props.getProperty('WEBAPP_URL') && props.getProperty('WEBAPP_TOKEN')
    ? '✅ Web App: 已配置'
    : '⚠️ Web App: 未配置 WEBAPP_URL — 简报没有一键完成按钮（部署 → 新部署 → Web 应用，执行身份"我"，访问权限"任何人"）');

  out.forEach(l => Logger.log(l));
  return !out.some(l => l.startsWith('❌'));
}
