// ============================================================
// 06_EdDiscussion.gs — Ed Discussion 直连读取
// Direct Ed Discussion API integration
// ============================================================
// 认证：浏览器 Network 里抓的 x-token + X-Token header；失效（401）时重新抓取并更新脚本属性 ED_TOKEN
// 诊断：运行 testSetup()（会真实请求 /user 并报告匹配到几门课程）
// ============================================================

// ── 主入口：同步 Ed Discussion 帖子 ──
function syncEdDiscussion_() {
  const startedAt = new Date();
  let totalNew = 0;
  let totalProcessed = 0;

  try {
    const userData = edFetch_('/user');
    const myUserId = (userData.user && userData.user.id) || null;
    Logger.log(`[Ed] 当前用户 ID: ${myUserId}`);

    const courses = extractCourses_(userData);
    Logger.log(`[Ed] 同步 ${courses.length} 门课程开始`);

    // v1.7：匹配到 0 门课程不是"正常的空结果"——多半是 USER_CONFIG.COURSES 与 Ed
    // 课程代码写法不一致（学期切换后高发）。视为异常，简报里会显示告警而不是静默空白。
    if (courses.length === 0) {
      const allCodes = (userData.courses || [])
        .map(c => (c.course || c).code || (c.course || c).name || '')
        .filter(Boolean).join(', ');
      throw new Error(
        `Ed 返回了课程但 0 门匹配 USER_CONFIG.COURSES。Ed 侧课程代码: [${allCodes || '(空)'}]。` +
        `请检查 00_Config.gs 的课程 key 是否与 Ed 代码写法一致（可能带空格/下划线差异）。`
      );
    }

    const existingIds = getExistingEdPostIds_();

    for (const course of courses) {
      try {
        const threadsData = edFetch_(`/courses/${course.id}/threads?limit=30&sort=new`);
        const threads = threadsData.threads || [];
        const newRows = [];

        for (const thread of threads) {
          const tid = String(thread.id);
          if (existingIds.has(tid)) continue;

          const type = classifyEdPost_(thread, myUserId);
          // 学生帖完全跳过：不写表、不调 AI（用户反馈无价值且浪费 token）
          if (type === 'student') {
            existingIds.add(tid);
            continue;
          }
          const row = buildEdPostRow_(thread, course, type);

          // v1.6：按 ED_CONFIG 分级调 AI（置顶/公告/讲师全摘要，助教帖看是否含截止日期）
          if (shouldSummarizeEdPost_(type, row.title, row.content)) {
            try {
              const ai = extractEdTaskWithAI_(thread, course, type);
              row.aiSummary = composeEdSummary_(ai);
              row.aiPriority = (type === 'pinned') ? 'high' : (ai.priority || 'medium');
              row.deadline = ai.deadline_str || '';
              totalProcessed++;
            } catch (e) {
              // 失败不再是永久性的：摘要留空，简报前的 backfillEdSummaries_() 会补
              Logger.log(`[Ed] AI 提取失败 (thread ${thread.id}): ${e.message}`);
            }
          }

          newRows.push(row);
          existingIds.add(String(thread.id));
        }

        if (newRows.length > 0) {
          writeEdPosts_(newRows);
          totalNew += newRows.length;
          Logger.log(`[Ed] ${course.code}: 新增 ${newRows.length} 条（重要）`);
        }
      } catch (e) {
        Logger.log(`[Ed] 课程 ${course.code} (${course.id}) 失败: ${e.message}`);
      }
    }

    const elapsed = Math.round((new Date() - startedAt) / 1000);
    Logger.log(`[Ed] 同步完成: 新增 ${totalNew} 条, AI 处理 ${totalProcessed} 条, 耗时 ${elapsed}s`);
    recordEdSyncResult_(true, `匹配 ${courses.length} 门课程，新增 ${totalNew} 条`);
  } catch (e) {
    Logger.log(`[Ed] 同步错误: ${e.message}`);
    recordEdSyncResult_(false, e.message);
    throw e;
  }
}

// ── v1.7：Ed 同步状态落地到 Script Properties，供简报判断是否要展示告警 ──
// 之前任何一环失败都只 Logger.log，用户在简报里看到的只是"Ed 区块空白"，
// 无法区分是"这几天真没重要帖"还是"同步整个挂了"。
function recordEdSyncResult_(ok, detail) {
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    if (ok) {
      props.setProperty('ED_LAST_OK', now);
      props.setProperty('ED_LAST_OK_DETAIL', String(detail || ''));
      props.deleteProperty('ED_LAST_ERROR');
    } else {
      props.setProperty('ED_LAST_ERROR', `${now} — ${String(detail || '')}`);
    }
  } catch (e) {
    Logger.log(`[Ed] 状态记录失败（不影响同步本身）: ${e.message}`);
  }
}

// ── 通用 GET 请求（关闭重定向，强制 JSON 响应）──
function edFetch_(path) {
  const token = getEdToken_();
  const url = getEdBaseUrl_() + path;
  const r = UrlFetchApp.fetch(url, {
    headers: { [ED_AUTH_HEADER]: token },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const code = r.getResponseCode();

  // 302 = 通常是 token 失效，被踢回登录
  if (code === 302) {
    const loc = r.getAllHeaders()['Location'] || r.getAllHeaders()['location'] || '';
    throw new Error(
      `Ed 返回 302 重定向到 ${loc}，说明 token 没被识别。\n` +
      `检查脚本属性 ED_BASE_URL 是否为 https://edstem.org/api（不是 au.edstem.org）`
    );
  }
  if (code === 401 || code === 403) {
    throw new Error(
      `Ed token 失效 (HTTP ${code})。修复步骤：\n` +
      `1. 浏览器打开 https://edstem.org 并登录\n` +
      `2. F12 → Network → 找一个 /api/ 请求 → 复制 x-token 值\n` +
      `3. Apps Script → 项目设置 → 脚本属性 → 编辑 ED_TOKEN，粘贴覆盖`
    );
  }
  if (code >= 400) {
    throw new Error(`Ed API ${code}: ${r.getContentText().substring(0, 200)}`);
  }

  const text = r.getContentText();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(`Ed API 返回非 JSON (HTTP ${code})。前 100 字: ${text.substring(0, 100)}`);
  }
  return JSON.parse(text);
}

// ── 从 /user 响应中提取课程列表（只保留 USER_CONFIG.COURSES 里配置的本学期课程）──
// v1.7 修复：之前额外放行 COURSE_ALIASES 里的课程代码，导致已下线的旧课程（如
// FIT4005/FIT5125）借着别名死灰复燃，重新拉取新帖。COURSE_ALIASES 的用途是给
// normalizeCourseCode_() 合并 Gmail 标签用的，不是"额外允许同步的课程白名单"——
// 一门课是否还在同步范围内，只应该看它是否在 USER_CONFIG.COURSES 里。
function extractCourses_(userData) {
  const list = userData.courses || [];
  const configuredKeys = Object.keys(USER_CONFIG.COURSES || {}).map(k => k.toLowerCase());

  return list.map(c => {
    const course = c.course || c;
    return {
      id: course.id,
      code: (course.code || course.name || '').trim(),
      name: course.name || '',
    };
  }).filter(c => {
    if (!c.id) return false;
    const codeLower = c.code.toLowerCase();
    return configuredKeys.some(k => codeLower.includes(k));
  });
}

// ── 帖子分类 ──
// v1.6：置顶帖优先级最高（不管作者角色），TA 帖恢复为独立类型不再当学生帖丢弃。
// 顺序很重要：pinned > announcement > instructor > ta > student
function classifyEdPost_(thread, myUserId) {
  // 置顶帖：老师用置顶来标记整学期最重要的信息，必须先于角色判断
  if (thread.is_pinned || thread.pinned) return 'pinned';
  if (thread.is_announcement) return 'announcement';

  const role = String((thread.user && thread.user.course_role) || '').toLowerCase();
  if (role === 'instructor' || role === 'admin' || role === 'staff') return 'instructor';
  if (role === 'ta' || role === 'tutor' || role === 'mentor') return 'ta';

  return 'student';
}

// ── 是否该给这条帖子调 AI 生成摘要 ──
// pinned/announcement/instructor 一律摘要；ta 帖仅在标题或正文命中截止日期关键词时摘要
function shouldSummarizeEdPost_(type, title, content) {
  if (ED_CONFIG.ALWAYS_SUMMARIZE.includes(type)) return true;
  if (type === 'ta' && ED_CONFIG.TA_SUMMARIZE_IF_DEADLINE) {
    const text = `${title || ''} ${content || ''}`.toLowerCase();
    return ED_CONFIG.DEADLINE_KEYWORDS.some(k => text.includes(k.toLowerCase()));
  }
  return false;
}

// ── 构造 Sheet 行对象 ──
function buildEdPostRow_(thread, course, type) {
  const user = thread.user || {};
  const role = String(user.course_role || 'student').toLowerCase();
  const created = thread.created_at
    ? Utilities.formatDate(new Date(thread.created_at), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    : '';
  const content = stripHtml_(thread.document || thread.content || '').substring(0, 1000);
  const url = `https://au.edstem.org/courses/${course.id}/discussion/${thread.id}`;
  // 置顶帖优先级下限设为 high：老师置顶就是在说"这条整学期都重要"
  const priorityFloor = (type === 'pinned') ? 'high' : '';

  return {
    postId: String(thread.id),
    date: created,
    course: course.code,
    type: type,
    authorRole: role,
    title: thread.title || '',
    content: content,
    url: url,
    aiSummary: '',
    aiPriority: priorityFloor,
    deadline: '',
    processed: 'TRUE',
  };
}

// ── HTML 标签清理 ──
function stripHtml_(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 2000);
}

// ── AI 提取讲师/公告帖任务 ──
function extractEdTaskWithAI_(thread, course, typeHint) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd (EEEE)');
  // v1.6：正文给到 3000 字，置顶帖往往是长篇的作业规范/评分标准，截断太早会丢关键信息
  const content = stripHtml_(thread.document || thread.content || '').substring(0, 3000);
  const isPinned = typeHint === 'pinned';

  const systemPrompt = `你是学术助手，为研究生归纳 Ed Discussion 上老师/助教发的帖子。
你的读者没时间点开原帖，所以摘要必须自带信息量：能直接回答"我要做什么、什么时候之前做完、有什么硬性要求"。
只输出合法 JSON，不要 markdown 代码块。`;

  const prompt = `归纳这条 Ed Discussion 帖子的关键内容。

今天 Today: ${today}
课程 Course: ${course.code}
帖子类型: ${typeHint || 'instructor'}${isPinned ? '（置顶帖 — 老师置顶通常意味着整学期都重要，请格外仔细提取）' : ''}
标题 Title: ${thread.title || ''}
正文 Content:
---
${content}
---

返回 JSON:
{
  "summary_zh": "has_action=true 时写 2-4 句中文归纳，必须包含：这条帖子要求做什么、关键时间点、任何硬性要求（字数/格式/提交平台/分组人数/分值占比），不要写'老师发布了一条公告'这类废话。has_action=false 时（纯通知/欢迎/答疑/无实质行动项）只写一句不超过25字的极简概括，不展开细节——读者读标题已经知道是什么类型的帖子，这里不用重复。",
  "key_points": ["has_action=true 时最多4条要点，每条不超过30字，提取正文里的硬信息：日期、分值、人数上限、提交方式、注意事项。has_action=false 时返回空数组 []，不要硬凑要点。"],
  "summary_en": "1-2 sentence English summary（has_action=false 时同样精简为半句话）",
  "priority": "high 或 medium 或 low",
  "deadline_str": "截止日期原文如 'Friday 11:59 PM' 或 'Week 6 Sunday'，没有则填 \\"\\"",
  "has_action": "true 表示读者需要做某件具体的事或记住某个日期；false 表示纯通知性质（欢迎词、平台使用说明、寒暄、无具体行动项的资源发布）"
}

priority 标准：
- high: 含明确截止日期、考试、评估任务、必须操作、置顶的重要规范
- medium: 课程信息更新、资源发布、可选活动
- low: 一般性寒暄或纯答疑

注意：宁可多提取信息也不要漏掉截止日期。如果正文里出现任何形式的时间点（Week N、具体日期、"before the lecture"），一定要写进 deadline_str 或 key_points。`;

  const raw = callAI_(prompt, systemPrompt, 800);
  return safeParseJSON_(raw);
}

// ── 把 AI 返回的摘要 + 要点合成一段存进 Sheet ──
// 格式：摘要正文，后面跟 " ▸ 要点1 ▸ 要点2"，简报渲染时再拆开
// v1.7：has_action=false（纯通知/欢迎/答疑，无实质行动项）时只留一句话摘要，
// 不列要点——之前不管 has_action 是什么都硬凑 4 条要点，导致"Welcome!"这类帖子
// 把标题内容换个说法又展开一遍，啰嗦且浪费 token。
function composeEdSummary_(ai) {
  if (!ai) return '';
  const summary = String(ai.summary_zh || '').trim();
  if (ai.has_action === false) return summary;
  const points = Array.isArray(ai.key_points)
    ? ai.key_points.map(p => String(p || '').trim()).filter(Boolean)
    : [];
  if (!points.length) return summary;
  return summary + points.map(p => ` ▸ ${p}`).join('');
}

// ── 摘要补写：给表里"重要但没摘要"的帖补调 AI ──
// 解决 v1.5.x 的顽疾：某次同步时 AI 报错 → 摘要列永久为空 → 简报里那条帖永远只有标题。
// 每次简报前跑一次，最多补 ED_CONFIG.BACKFILL_LIMIT 条，成本可控。
function backfillEdSummaries_(limit) {
  limit = limit || ED_CONFIG.BACKFILL_LIMIT;
  let filled = 0;

  try {
    const sheet = getEdPostSheet_();
    if (sheet.getLastRow() <= 1) return 0;

    const minDate = TODO_CONFIG.MIN_TASK_DATE ? new Date(TODO_CONFIG.MIN_TASK_DATE) : null;
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length && filled < limit; i++) {
      const row = data[i];
      const type = String(row[3] || '').toLowerCase();
      const title = String(row[5] || '');
      const content = String(row[6] || '');
      const existingSummary = String(row[8] || '').trim();

      if (existingSummary) continue;                        // 已有摘要
      if (!shouldSummarizeEdPost_(type, title, content)) continue;  // 不该摘要的类型
      if (!content) continue;                               // 没正文，AI 也无从归纳

      // 只补本学期的帖，旧学期的空摘要不浪费 token
      const postDate = new Date(String(row[1] || ''));
      if (minDate && (isNaN(postDate) || postDate < minDate)) continue;

      try {
        // 复用同一套提示词：伪造一个 thread 对象喂给 extractEdTaskWithAI_
        const ai = extractEdTaskWithAI_(
          { title: title, document: content },
          { code: String(row[2] || '') },
          type
        );
        const summary = composeEdSummary_(ai);
        if (!summary) continue;

        const rowIndex = i + 1;
        sheet.getRange(rowIndex, 9).setValue(summary);
        if (!String(row[9] || '').trim()) {
          sheet.getRange(rowIndex, 10).setValue(type === 'pinned' ? 'high' : (ai.priority || 'medium'));
        }
        if (!String(row[10] || '').trim() && ai.deadline_str) {
          sheet.getRange(rowIndex, 11).setValue(ai.deadline_str);
        }
        filled++;
      } catch (e) {
        Logger.log(`[Ed] 补摘要失败 (row ${i + 1}): ${e.message}`);
      }
    }

    if (filled > 0) Logger.log(`[Ed] 补写摘要 ${filled} 条`);
  } catch (e) {
    Logger.log(`[Ed] backfillEdSummaries_ 失败: ${e.message}`);
  }
  return filled;
}

// ── Sheet 已存在帖子 ID 集合（去重）──
function getExistingEdPostIds_() {
  const set = new Set();
  try {
    const sheet = getEdPostSheet_();
    if (sheet.getLastRow() <= 1) return set;
    const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    ids.forEach(r => set.add(String(r[0])));
  } catch (e) {
    Logger.log(`[Ed] 读取已有帖子 ID 失败: ${e.message}`);
  }
  return set;
}
