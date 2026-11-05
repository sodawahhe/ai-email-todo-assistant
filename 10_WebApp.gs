// ============================================================
// 10_WebApp.gs — Apps Script Web App（仪表盘 + 一键完成）
// ============================================================
// 部署方式：Apps Script 编辑器 → 部署 → 新部署 → Web 应用
//   - 执行身份：我（you）
//   - 谁可访问：任何人（必须，邮件按钮才能匿名调用）
// 部署后把 Web App URL 存到脚本属性 WEBAPP_URL
// 安全：URL 必须带 token=<WEBAPP_TOKEN 脚本属性值>，否则 403
// ============================================================

function doGet(e) {
  const params = (e && e.parameter) || {};
  const expected = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN');

  // 没设 token 就阻断（强制管理员先初始化）
  if (!expected) {
    return htmlPage_('未初始化', '请先运行 setupTriggers() 生成 token');
  }
  if (params.token !== expected) {
    return htmlPage_('403 Forbidden', '链接无效或已过期。');
  }

  const action = params.action || 'dashboard';

  try {
    if (action === 'done')   return doActionDone_(params.id);
    if (action === 'ignore') return doActionIgnore_(params.id);
    if (action === 'undo')   return doActionUndo_(params.id);
    return renderDashboard_();
  } catch (err) {
    return htmlPage_('错误', String(err.message || err));
  }
}

// ── 确保 token 存在（setupTriggers 调用；没有就生成）──
function ensureWebAppToken_() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('WEBAPP_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('WEBAPP_TOKEN', token);
  }
  return token;
}

// ── 状态同步：写主源 + 同步所有合并源（修复"勾选后另一处仍是 Pending"）──
// 返回该行的标题（中文优先），供轻量确认页显示；找不到时返回空字符串
function applyStatusEverywhere_(todoId, status) {
  writeStatusToSource_(todoId, status);
  // 从 To-Do sheet 读 Merged IDs 列，把同义任务的所有源都更新
  try {
    const sheet = getTodoSheet_();
    if (sheet.getLastRow() <= 1) return '';
    const data = sheet.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0] || '').trim() !== todoId) continue;
      let mergedIds = [];
      try { mergedIds = JSON.parse(String(data[r][14] || '[]')); } catch (e) {}
      mergedIds.forEach(mid => { if (mid && mid !== todoId) writeStatusToSource_(mid, status); });
      // 也把 To-Do sheet 当前行的 Status 列同步更新（仪表盘/简报下次刷新前的中间状态保持一致）
      sheet.getRange(r + 1, 10).setValue(status);
      return String(data[r][3] || data[r][4] || '');  // Task ZH || Task EN
    }
  } catch (e) {
    Logger.log(`[Action] applyStatusEverywhere_ failed: ${e.message}`);
  }
  return '';
}

// ── 完成动作 → 轻量确认页（不再重跑整个 buildTodoList_ / 重写 To-Do sheet）──
// v1.7：之前这里调 renderDashboard_()，点一下要等整个仪表盘管线跑完才出第一个像素。
// 用户反馈"很累赘"——改成只做状态写入 + 一个静态确认页，秒开。
function doActionDone_(todoId) {
  if (!todoId) return htmlPage_('错误', '缺少 id 参数');
  const title = applyStatusEverywhere_(todoId, STATUS_DONE);
  recordTaskDone_();
  return actionResultPage_('done', todoId, title, `✅ 已完成 +${XP_PER_TASK} XP`);
}

function doActionIgnore_(todoId) {
  if (!todoId) return htmlPage_('错误', '缺少 id 参数');
  const title = applyStatusEverywhere_(todoId, STATUS_IGNORED);
  return actionResultPage_('ignore', todoId, title, '⏭️ 已忽略，下次简报不再出现');
}

function doActionUndo_(todoId) {
  if (!todoId) return htmlPage_('错误', '缺少 id 参数');
  const title = applyStatusEverywhere_(todoId, STATUS_PENDING);
  return actionResultPage_('undo', todoId, title, '↩️ 已恢复为待办');
}

// ── 渲染仪表盘（可选 flash：顶部短暂横幅显示动作结果）──
function renderDashboard_(flash) {
  const todo = buildTodoList_();
  const todayStats = getTodayStats_();
  const weekStats = getWeekStats_();
  const tpl = HtmlService.createTemplateFromFile('dashboard');
  tpl.todo = todo;
  tpl.today = todayStats;
  tpl.week = weekStats;
  tpl.token = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN');
  tpl.tz = Session.getScriptTimeZone();
  tpl.flash = flash || '';
  return tpl.evaluate()
    .setTitle('学术仪表盘 / Academic Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── v1.7：极简确认页 —— 不重跑 buildTodoList_，秒开；任务标题带删除线变灰；1.5s 自动关闭标签页 ──
// window.close() 只对脚本自己打开的标签页有效，多数浏览器会拦截对用户点击打开的标签页调用它；
// 拦截时降级显示提示文案，不留一片空白无反馈的页面。
function actionResultPage_(kind, todoId, title, message) {
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
  const token = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN') || '';
  const dashLink = url ? `<a href="${url}?token=${token}" style="color:#1a73e8;text-decoration:none;">📊 打开仪表盘</a>` : '';
  const undoLink = (kind !== 'undo' && todoId && url)
    ? `<a href="${url}?token=${token}&action=undo&id=${encodeURIComponent(todoId)}" style="color:#999;text-decoration:none;margin-left:14px;">↩️ 撤销</a>`
    : '';
  const strikeThrough = kind === 'done' || kind === 'ignore';
  const titleHtml = title
    ? `<p style="${strikeThrough ? 'text-decoration:line-through;color:#999;' : ''}font-size:15px;">${webEscHtml_(title)}</p>`
    : '';

  return HtmlService.createHtmlOutput(`
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:-apple-system,Segoe UI,Arial;background:#f8f9fa;padding:40px 20px;text-align:center;}
      .box{max-width:420px;margin:0 auto;background:white;border-radius:12px;padding:32px 24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
      h1{font-size:22px;margin:0 0 12px 0;color:#1a73e8;}
      p{font-size:15px;line-height:1.6;color:#555;margin:8px 0;}
      .links{margin-top:20px;font-size:14px;}
      .hint{margin-top:16px;font-size:12px;color:#aaa;}
    </style></head><body>
    <div class="box">
      <h1>${webEscHtml_(message)}</h1>
      ${titleHtml}
      <div class="links">${dashLink}${undoLink}</div>
      <div class="hint" id="closeHint" style="display:none;">可以关闭本页返回邮件了</div>
    </div>
    <script>
      setTimeout(function() {
        window.close();
        // window.close() 对非脚本打开的标签页大多会被浏览器拦截且不报错，
        // 短暂延时后页面若仍可见就说明关闭失败，改用文案提示用户手动关闭。
        setTimeout(function() {
          var hint = document.getElementById('closeHint');
          if (hint) hint.style.display = 'block';
        }, 300);
      }, 1500);
    </script>
    </body></html>
  `);
}

function webEscHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 简单结果页（含返回仪表盘链接）──
function htmlPage_(title, body, todoId) {
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
  const token = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN') || '';
  const dashLink = url ? `<a href="${url}?token=${token}" style="color:#1a73e8;">📊 打开仪表盘</a>` : '';
  const undoLink = todoId && url
    ? `<a href="${url}?token=${token}&action=undo&id=${encodeURIComponent(todoId)}" style="color:#999;margin-left:14px;">↩️ 撤销</a>`
    : '';
  return HtmlService.createHtmlOutput(`
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:-apple-system,Segoe UI,Arial;background:#f8f9fa;padding:40px 20px;text-align:center;}
      .box{max-width:420px;margin:0 auto;background:white;border-radius:12px;padding:32px 24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
      h1{font-size:24px;margin:0 0 16px 0;color:#1a73e8;}
      p{font-size:15px;line-height:1.6;color:#555;margin:8px 0;}
      .links{margin-top:20px;font-size:14px;}
    </style></head><body>
    <div class="box">
      <h1>${title}</h1>
      <p>${body}</p>
      <div class="links">${dashLink}${undoLink}</div>
    </div></body></html>
  `);
}

// ── 给简报和仪表盘共用：拼接动作 URL ──
function buildActionUrl_(action, todoId) {
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL');
  const token = PropertiesService.getScriptProperties().getProperty('WEBAPP_TOKEN');
  if (!url || !token) return '#';
  return `${url}?token=${token}&action=${action}&id=${encodeURIComponent(todoId)}`;
}
