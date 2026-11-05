// ============================================================
// 03_API.gs — AI 接口封装（DeepSeek 主 + 智谱备用，指数退避重试）
// ============================================================
// 脚本属性：DEEPSEEK_API_KEY（必填）、ZHIPU_API_KEY（备用，可选）
//          AI_PROVIDER / AI_FALLBACK 可改主/备（只认下面 PROVIDERS 里的名字，其余回退 deepseek）
// ============================================================

const PROVIDERS = {
  // 主力：DeepSeek v4-flash（稳定，~1.3元/月，deepseek-chat 映射到 v4-flash）
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    models: ['deepseek-chat'],
    keyProp: 'DEEPSEEK_API_KEY',
    name: 'DeepSeek',
  },
  // 备用：智谱 Zhipu（免费但限速，DeepSeek 失败时自动切换）
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    models: ['glm-4-flash', 'glm-4.7-flash', 'glm-4-flash-250414'],
    keyProp: 'ZHIPU_API_KEY',
    name: '智谱 Zhipu',
  },
};

// ── 主调用函数（外部调用这个）──
function callAI_(userPrompt, systemPrompt, maxTokens) {
  maxTokens = maxTokens || 1000;
  const props = PropertiesService.getScriptProperties();
  const primary = PROVIDERS[props.getProperty('AI_PROVIDER')] ? props.getProperty('AI_PROVIDER') : 'deepseek';
  const fallback = props.getProperty('AI_FALLBACK') || 'zhipu';

  try {
    return callProvider_(primary, userPrompt, systemPrompt, maxTokens);
  } catch (e) {
    if (fallback !== primary && PROVIDERS[fallback]) {
      Logger.log(`[AI] ${primary} 失败: ${e.message}，切换备用: ${fallback}`);
      return callProvider_(fallback, userPrompt, systemPrompt, maxTokens);
    }
    throw e;
  }
}

// ── 调用某个提供商（含模型遍历 + 限速时指数退避）──
function callProvider_(providerName, userPrompt, systemPrompt, maxTokens) {
  const provider = PROVIDERS[providerName];
  const apiKey = PropertiesService.getScriptProperties().getProperty(provider.keyProp);
  if (!apiKey) throw new Error(`请在脚本属性中设置 ${provider.keyProp} / Set ${provider.keyProp} in Script Properties`);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  let lastError = null;
  for (const model of provider.models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = UrlFetchApp.fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        payload: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
        muteHttpExceptions: true,
      });
      const code = resp.getResponseCode();
      const text = resp.getContentText();

      if (code === 200) {
        const content = (JSON.parse(text).choices || [{}])[0].message?.content;
        if (!content) throw new Error(`Empty response from ${provider.name}/${model}`);
        return content;
      }
      lastError = new Error(`${provider.name} API error ${code} with model ${model}: ${text}`);
      if (!/429|1305|rate|过大|quota|RESOURCE_EXHAUSTED/i.test(lastError.message)) throw lastError;
      const waitMs = Math.pow(2, attempt) * 4000;
      Logger.log(`[AI] ${provider.name}/${model} 限速，等待 ${waitMs / 1000}s（第${attempt + 1}次）`);
      Utilities.sleep(waitMs);
    }
    Logger.log(`[AI] 模型 ${model} 3次重试均失败，尝试下一个...`);
  }
  throw lastError || new Error(`${provider.name} 所有模型均不可用`);
}

// ── 安全 JSON 解析（去除模型可能加的 markdown 代码块）──
function safeParseJSON_(raw) {
  const cleaned = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// ============================================================
// 以下函数供 02_GmailScanner.gs 调用
// Called by the GmailScanner module
// ============================================================

function processEmailWithAI_(subject, sender, body, date) {
  const today = Utilities.formatDate(date || new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd (EEEE)');

  const systemPrompt = `你是一个学术助手，帮助研究生追踪截止日期和学习任务。
You are an academic assistant helping a graduate student track deadlines.
宁可多提取任务，不要漏掉。Be inclusive — missing a task is worse than a false positive.
EXCEPTION: Ed Discussion notification emails (sender contains edstem.org or "Ed Discussion") about OTHER STUDENTS' posts or questions are NOT tasks for the user. Unless the post is from an instructor/staff, treat these as medium or low priority with no tasks extracted.
只输出合法 JSON，不要任何解释或 markdown 代码块。Output valid JSON only, no markdown.`;

  const prompt = `分析这封学术邮件，提取关键信息。

今天 Today: ${today}
主题 Subject: ${subject}
发件人 From: ${sender}
正文 Body:
---
${body.substring(0, 3000)}
---

返回以下 JSON（字段名完全一致）:
{
  "summary_en": "2-sentence English summary",
  "summary_zh": "2句中文摘要（学术风格）",
  "course_hint": "ONLY the course code in format like FIT5197, CS229, MBA501 (uppercase letters + digits, no spaces, no semester info, no campus suffix). If you cannot identify a course code, return exactly an empty string \"\". DO NOT translate this field. DO NOT write 空字符串 / empty / unknown / none / N/A.",
  "importance": "high 或 medium 或 low",
  "tasks": [
    {
      "title": "英文任务名（最多12个词）",
      "title_zh": "中文任务名（简洁）",
      "deadline_str": "截止日期原文，如 'Friday 11:59 PM'，没有填 null",
      "priority": "high 或 medium 或 low",
      "note": "one sentence context in English",
      "note_zh": "一句中文背景说明",
      "confidence": "high 或 medium 或 low"
    }
  ]
}

importance 判断标准:
- high: 教师公告、作业/考试截止日期、必须操作的事项（含 Ed Discussion 中来自 instructor/staff 的公告）
- medium: 课程信息、可选活动、Ed Discussion 中其他学生的提问或讨论通知
- low: 邮件列表、社交活动、广告、与用户无直接关系的 Ed Discussion 学生帖

如果没有可操作任务（纯通知、广告等），tasks 填 []。`;

  const raw = callAI_(prompt, systemPrompt, 900);
  const result = safeParseJSON_(raw);

  return {
    summary_en: result.summary_en || '',
    summary_zh: result.summary_zh || '',
    course: normalizeCourseCode_(result.course_hint) || detectCourse_(subject, sender),
    importance: result.importance || 'medium',
    tasks: result.tasks || [],
  };
}

// ── 规范化课程代码：避免 AI 返回杂乱字符串造成标签泛滥 ──
// FIT5197 S1 2026 / FIT5197-MUM / fit5197 → 全部归一化为 FIT5197
// 空字符串 / Empty / None / Unknown → 空
function normalizeCourseCode_(raw) {
  if (!raw) return '';
  const cleaned = String(raw).trim();

  // 黑名单：AI 误把 prompt 里的中文/英文指令当成值返回的常见情况
  const blacklist = [
    '空字符串', 'empty string', 'empty', 'none', 'null',
    'unknown', 'n/a', 'na', 'not identifiable', '不明', '未知',
  ];
  if (blacklist.includes(cleaned.toLowerCase())) return '';

  // 提取标准课程代码：2-4 个字母 + 3-5 位数字（如 FIT5197, CS229, MBA501）
  const match = cleaned.match(/[A-Z]{2,4}\s?\d{3,5}/i);
  let code = match ? match[0].toUpperCase().replace(/\s/g, '') : '';

  // 没匹配上但又不是黑名单里的，就截断保守处理
  if (!code) {
    code = cleaned.length > 12 ? '' : cleaned;
  }

  // 检查别名映射（如 FIT4005 → FIT5125），防止因 AI 返回变体代码而产生重复标签
  if (code && typeof COURSE_ALIASES !== 'undefined' && COURSE_ALIASES[code]) {
    Logger.log(`  [normalizeCourseCode_] Alias: ${code} → ${COURSE_ALIASES[code]}`);
    return COURSE_ALIASES[code];
  }

  return code;
}
