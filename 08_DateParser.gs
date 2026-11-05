// ============================================================
// 08_DateParser.gs — 截止日期解析（本地规则 + AI 兜底）
// Deadline string parser (local rules + AI fallback)
// ============================================================
// 输入示例 / Examples:
//   "Friday 11:59 PM" / "this Friday" / "next Monday"
//   "May 5" / "5 May 2026" / "05/05" / "05-05"
//   "tonight" / "tomorrow 9am" / "今晚" / "明天"
//   ISO: "2026-05-05T23:59"
// 输出 / Output: Date 对象 或 null
// ============================================================

const WEEKDAY_MAP = {
  'sunday': 0, 'sun': 0, '周日': 0, '星期日': 0, '星期天': 0,
  'monday': 1, 'mon': 1, '周一': 1, '星期一': 1,
  'tuesday': 2, 'tue': 2, 'tues': 2, '周二': 2, '星期二': 2,
  'wednesday': 3, 'wed': 3, '周三': 3, '星期三': 3,
  'thursday': 4, 'thu': 4, 'thur': 4, 'thurs': 4, '周四': 4, '星期四': 4,
  'friday': 5, 'fri': 5, '周五': 5, '星期五': 5,
  'saturday': 6, 'sat': 6, '周六': 6, '星期六': 6,
};

const MONTH_MAP = {
  'jan': 0, 'january': 0, 'feb': 1, 'february': 1,
  'mar': 2, 'march': 2, 'apr': 3, 'april': 3,
  'may': 4, 'jun': 5, 'june': 5,
  'jul': 6, 'july': 6, 'aug': 7, 'august': 7,
  'sep': 8, 'sept': 8, 'september': 8, 'oct': 9, 'october': 9,
  'nov': 10, 'november': 10, 'dec': 11, 'december': 11,
};

// 用户填了 raw 但表示"无具体日期"的常见值
const NULL_TOKENS = ['tbd', 'tba', 'see moodle', 'see ed', 'see canvas',
                     '无', '待定', '见公告', 'n/a', 'na', 'none', 'null'];

// ── 主入口：解析单个 deadline 原文 ──
// today 是"这条文字写出来的那天"（帖子发布日 / 邮件入库日），相对日期（Friday / tomorrow）
// 相对它解析，不是相对运行时的今天——否则 8 月帖子里的 "Wednesday" 会被标成下周三。缺省取 new Date()
function parseDeadline_(raw, today) {
  if (raw == null) return null;
  const s = String(raw).trim()
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')  // "10th September" → "10 September"
    .replace(/@/g, ' ');                       // "10 September 2026 @23:55"
  if (!s) return null;

  const lower = s.toLowerCase();
  if (NULL_TOKENS.includes(lower)) return null;

  today = today || new Date();
  // 工作以本地时区（KL）的"今天 00:00"为锚
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // 默认时间：23:59
  let defaultHour = 23, defaultMin = 59;
  const timeMatch = extractTime_(s);
  if (timeMatch) {
    defaultHour = timeMatch.hour;
    defaultMin = timeMatch.min;
  }

  // 0. 原文自带完整日期（如 "Saturday 12:00 AM (2026-08-15)"）：以日期为准，
  //    不再被里面的星期几带偏成"下一个周六"
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], defaultHour, defaultMin, 0, 0);

  // 1. 直接 new Date —— 处理 ISO、"May 5, 2026 11:59 PM" 等浏览器原生支持的格式
  // 必须原文自带 4 位年份才信任：V8 对 "Aug 5" 这类不带年份的串会补成 2001 年，
  // 之前这类日期全被当成"2001 年的过期任务"悄悄丢掉
  const native = new Date(s);
  if (/\b(19|20)\d{2}\b/.test(s) && !isNaN(native.getTime()) && native.getFullYear() > 2000 && native.getFullYear() < 2100) {
    // 如果原文里没显式带时间，强制覆盖为 23:59
    if (!timeMatch && looksDateOnly_(s)) {
      native.setHours(23, 59, 0, 0);
    }
    return native;
  }

  // 2. 关键词：tonight / today / 今晚
  if (/\b(tonight|today)\b/i.test(s) || /今晚|今天/.test(s)) {
    return withTime_(anchor, defaultHour, defaultMin);
  }

  // 3. tomorrow / 明天 / 明日
  if (/\btomorrow\b/i.test(s) || /明天|明日/.test(s)) {
    const d = new Date(anchor);
    d.setDate(d.getDate() + 1);
    return withTime_(d, defaultHour, defaultMin);
  }

  // 4. yesterday（少见但可能在过期任务里出现）
  if (/\byesterday\b/i.test(s) || /昨天/.test(s)) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - 1);
    return withTime_(d, defaultHour, defaultMin);
  }

  // 5. weekday：this Friday / next Monday / Friday
  const wd = matchWeekday_(lower);
  if (wd !== null) {
    const d = resolveWeekday_(anchor, wd.weekday, wd.next);
    return withTime_(d, defaultHour, defaultMin);
  }

  // 6. MM/DD 或 M/D（如 "05/05" / "5/5"）
  const slashMatch = s.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10) - 1;
    const day = parseInt(slashMatch[2], 10);
    let yr = slashMatch[3] ? parseInt(slashMatch[3], 10) : anchor.getFullYear();
    if (yr < 100) yr += 2000;
    if (m >= 0 && m <= 11 && day >= 1 && day <= 31) {
      const d = new Date(yr, m, day, defaultHour, defaultMin, 0, 0);
      return slashMatch[3] ? d : inferYear_(d, anchor);
    }
  }

  // 7. "May 5" / "5 May" / "May 5, 2026"
  const monthDay = matchMonthDay_(s, anchor);
  if (monthDay) {
    return withTime_(monthDay, defaultHour, defaultMin);
  }

  // 8. 中文日期 "5月5日" / "5月5号"
  const cnDate = s.match(/(\d{1,2})月\s*(\d{1,2})[日号]/);
  if (cnDate) {
    const m = parseInt(cnDate[1], 10) - 1;
    const day = parseInt(cnDate[2], 10);
    if (m >= 0 && m <= 11 && day >= 1 && day <= 31) {
      return inferYear_(new Date(anchor.getFullYear(), m, day, defaultHour, defaultMin, 0, 0), anchor);
    }
  }

  return null;
}

// ── 批量解析：本地全跑一遍，失败的那批走 AI 兜底（一次合并调用）──
// refs[i] = rawList[i] 的"写出日期"（见 parseDeadline_），缺失/无效时退回当前时间
// 返回与输入等长的 Date|null 数组
function batchParseDeadlines_(rawList, refs) {
  const now = new Date();
  const refOf = i => (refs && refs[i] instanceof Date && !isNaN(refs[i])) ? refs[i] : now;
  const results = rawList.map((raw, i) => parseDeadline_(raw, refOf(i)));

  if (typeof TODO_CONFIG === 'undefined' || !TODO_CONFIG.AI_FALLBACK) {
    return results;
  }

  // 找出本地解析失败但原文非空且不是 NULL_TOKENS 的索引
  const fallbackIndices = [];
  rawList.forEach((raw, i) => {
    if (results[i] !== null) return;
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return;
    if (NULL_TOKENS.includes(s)) return;
    fallbackIndices.push(i);
  });

  if (fallbackIndices.length === 0) return results;

  try {
    const tz = Session.getScriptTimeZone();
    const aiResults = aiParseBatch_(fallbackIndices.map(i => ({
      text: rawList[i],
      written: Utilities.formatDate(refOf(i), tz, 'yyyy-MM-dd (EEEE)'),
    })));
    fallbackIndices.forEach((origIdx, j) => {
      const iso = aiResults[j];
      if (iso) {
        const d = new Date(iso);
        if (!isNaN(d.getTime())) results[origIdx] = d;
      }
    });
  } catch (e) {
    Logger.log(`[DateParser] AI fallback failed: ${e.message}`);
  }

  return results;
}

// ── AI 兜底：一次调用解析多条 ──
// items = [{text, written}]：written 是该文字的写出日期，相对表述一律以它为基准
function aiParseBatch_(items) {
  const systemPrompt = `你是日期解析助手。把模糊的截止日期描述转换为精确的本地 ISO 日期时间。
You convert vague deadline descriptions into precise local ISO datetimes.
Output VALID JSON only, no markdown.`;

  const prompt = `时区 / Timezone: ${Session.getScriptTimeZone()}

把下列截止日期原文转换为 ISO 8601 格式（YYYY-MM-DDTHH:mm，本地时区）。
Convert the following deadline strings to ISO 8601 (YYYY-MM-DDTHH:mm, local time).
- 每条自带 written（原文写出的日期）：周几、"明天"、"Week N" 等相对表述一律相对 written 解析，不要相对今天
- 原文有明确日期就用它，即使它早于今天也不要推到未来
- 如果含时间，使用该时间；否则默认 23:59
- 解析不出来填 null

输入 / Input:
${JSON.stringify(items)}

返回 / Return JSON:
{"results": ["YYYY-MM-DDTHH:mm" 或 null, ...]} （顺序与输入对应）`;

  const raw = callAI_(prompt, systemPrompt, 600);
  const arr = safeParseJSON_(raw).results || [];
  // 用空数组补齐到原长度
  while (arr.length < items.length) arr.push(null);
  return arr;
}

// ============================================================
// 内部辅助函数 / Internal helpers
// ============================================================

// 从文本中提取时间，返回 {hour, min} 或 null
function extractTime_(s) {
  // "11:59 PM" / "11:59pm" / "23:59"
  const re12 = /(\d{1,2}):(\d{2})\s*(am|pm)/i;
  const m12 = s.match(re12);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    const isPm = m12[3].toLowerCase() === 'pm';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    return { hour: h, min: min };
  }

  const re24 = /(?:^|\s)(\d{1,2}):(\d{2})(?!\s*(am|pm))/i;
  const m24 = s.match(re24);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h <= 23 && min <= 59) return { hour: h, min: min };
  }

  // "9am" / "9 PM"
  const reAmpm = /\b(\d{1,2})\s*(am|pm)\b/i;
  const mAmpm = s.match(reAmpm);
  if (mAmpm) {
    let h = parseInt(mAmpm[1], 10);
    const isPm = mAmpm[2].toLowerCase() === 'pm';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    return { hour: h, min: 0 };
  }

  return null;
}

function looksDateOnly_(s) {
  return !/\d:\d|am|pm/i.test(s);
}

function withTime_(d, hour, min) {
  const out = new Date(d);
  out.setHours(hour, min, 0, 0);
  return out;
}

// 匹配 "this Friday" / "next Monday" / "Friday"
// 返回 {weekday: 0-6, next: bool} 或 null
function matchWeekday_(lower) {
  const nextMatch = lower.match(/\bnext\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
  if (nextMatch) return { weekday: WEEKDAY_MAP[nextMatch[1]], next: true };

  const cnNext = lower.match(/下(?:个)?(周|星期)([一二三四五六日天])/);
  if (cnNext) {
    const cnMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    return { weekday: cnMap[cnNext[2]], next: true };
  }

  const thisMatch = lower.match(/\b(?:this\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
  if (thisMatch) return { weekday: WEEKDAY_MAP[thisMatch[1]], next: false };

  const cnThis = lower.match(/(?:这|本)?(周|星期)([一二三四五六日天])/);
  if (cnThis) {
    const cnMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    return { weekday: cnMap[cnThis[2]], next: false };
  }

  return null;
}

// 从 anchor（今天 00:00）算出指定 weekday 的下一次出现
function resolveWeekday_(anchor, targetWeekday, forceNextWeek) {
  const todayWd = anchor.getDay();
  let diff = targetWeekday - todayWd;
  if (diff < 0) diff += 7;       // 已过 → 推到下周
  else if (diff === 0) diff = 7; // 今天的同名工作日，按"截止"语义推到下周
  if (forceNextWeek && diff < 7) diff += 7;
  const d = new Date(anchor);
  d.setDate(d.getDate() + diff);
  return d;
}

// 原文没写年份：默认取参照日所在年。只有"落后参照日半年以上"才算指向明年（12 月提到 1 月的截止）。
// 之前"已过去就推明年"会把几天前的日期变成明年同日，在"之后"桶里冒充远期任务。
function inferYear_(d, anchor) {
  if (anchor - d > 180 * 86400000) d.setFullYear(d.getFullYear() + 1);
  return d;
}

// 匹配 "May 5" / "5 May" / "May 5, 2026"
function matchMonthDay_(s, anchor) {
  // "May 5" / "May 5, 2026"
  const m1 = s.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:[,\s]+(\d{4}))?\b/i);
  if (m1) {
    const month = MONTH_MAP[m1[1].toLowerCase()];
    const day = parseInt(m1[2], 10);
    const year = m1[3] ? parseInt(m1[3], 10) : anchor.getFullYear();
    if (day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      return m1[3] ? d : inferYear_(d, anchor);
    }
  }

  // "5 May" / "5 May 2026"
  const m2 = s.match(/\b(\d{1,2})\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:[,\s]+(\d{4}))?\b/i);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = MONTH_MAP[m2[2].toLowerCase()];
    const year = m2[3] ? parseInt(m2[3], 10) : anchor.getFullYear();
    if (day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      return m2[3] ? d : inferYear_(d, anchor);
    }
  }

  return null;
}
