// 本地回归测试：node tests/run.js
// 直接加载真实 .gs 源码（vm 里 stub 掉 Apps Script 全局），不碰 Google 服务。
// 每次改日期解析 / 分桶 / 分类 / 简报渲染后跑一遍，再 clasp push。
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const pad = n => String(n).padStart(2, '0');

const props = { getProperty: () => null, setProperty() {} };
const ctx = {
  console, Logger: { log() {} },
  Session: { getScriptTimeZone: () => 'Asia/Kuala_Lumpur' },
  Utilities: {
    formatDate: (d, tz, f) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}` + (f.includes('HH') ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''),
  },
  PropertiesService: { getScriptProperties: () => props },
  GmailApp: { search: () => [] },
};
vm.createContext(ctx);
for (const f of fs.readdirSync(root).filter(f => f.endsWith('.gs')).sort()) {
  // vm 里顶层 const 不挂在 ctx 上，改成 var 方便取用
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8').replace(/^const (\w+)/gm, 'var $1'), ctx, { filename: f });
}
const ctxDate = (...a) => vm.runInContext(`new Date(${a.join(',')})`, ctx);  // 跨 realm：instanceof Date 需要 ctx 内的 Date
const fmt = d => d && `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const P = (raw, ref) => fmt(ctx.parseDeadline_(raw, ref));
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

// ── 日期解析：相对日期按"写出日"，不是按今天 ──
const aug10 = new Date(2026, 7, 10, 9, 0);  // 周一
eq(P('Wednesday 12:00 PM', aug10), '2026-08-12 12:00');
eq(P('Friday 11:59 PM', aug10), '2026-08-14 23:59');
eq(P('Saturday 12:00 AM (2026-08-15)', new Date(2026, 9, 13)), '2026-08-15 00:00');   // 自带日期以日期为准
eq(P('10th September 2026 @23:55', new Date(2026, 9, 13)), '2026-09-10 23:55');
eq(P('Aug 5', new Date(2026, 9, 13)), '2026-08-05 23:59');                          // 不能是 2001 年
eq(P('Jan 5', new Date(2026, 11, 20)), '2027-01-05 23:59');                          // 跨年仍成立
eq(P('2026-05-05T09:00', new Date(2026, 9, 13)), '2026-05-05 09:00');
eq(P('tomorrow 9am', new Date(2026, 9, 13)), '2026-10-14 09:00');
eq(P('TBD', new Date()), null);

ctx.TODO_CONFIG.AI_FALLBACK = false;
eq(ctx.batchParseDeadlines_(['Friday', 'Friday'], [ctxDate(2026, 7, 10, 9, 0), ctxDate(2026, 9, 12)]).map(fmt),
   ['2026-08-14 23:59', '2026-10-16 23:59'], 'per-item ref');

// ── 分桶：8 月帖子不再混进 10 月的 48h ──
const now = new Date(2026, 9, 13, 8, 30);
const b = ctx.bucketize_([
  { deadline: new Date(2026, 7, 14, 23, 59), todoId: 'old', confidence: 'high', priority: 'high' },
  { deadline: new Date(2026, 9, 14, 12, 0), todoId: 'new', confidence: 'high', priority: 'high' },
  { deadline: new Date(2026, 9, 12, 0, 0), todoId: 'overdue', confidence: 'high', priority: 'high' },
], now);
eq([b.h48.length, b.overdue.length, b.week.length, b.later.length, b.noDate.length], [1, 1, 0, 0, 0]);
eq(b.overdue[0].overdueDays, 2);

// ── 分类（Gmail 标签 / 简报 / 仪表盘共用）──
eq(ctx.categorize_('FIT5196', 'whatever'), 'course');
eq(ctx.categorize_('', 'Register for On-Campus Interviews Monash Careers'), 'career');
eq(ctx.categorize_('', 'Shopee Career Talk'), 'career');
eq(ctx.categorize_('FIT5197', 'Attend AT&S Industry Talk'), 'career');   // 往学期课程不算课程
eq(ctx.categorize_('', 'Vote in Academic Board election  Monash University R.'), 'campus');
eq(ctx.categorize_('', 'MUM School of IT - General Student Hub - Announcements'), 'campus');
eq(ctx.categorize_('', 'HubSpot can get you started. Salesforce can help  Agentforce Marketing'), '');  // 营销杂邮：不打分类标签
ok(ctx.isConfiguredCourse_('FIT5196 - MUM S2 2026') && !ctx.isConfiguredCourse_('FIT5197') && !ctx.isConfiguredCourse_(''));
ok(!/career fair/i.test(ctx.USER_CONFIG.LOW_PRIORITY_KEYWORDS.join(' ')), 'career fair 不应是低优先级');

// ── 简报渲染冒烟 ──
ctx.getTodayStats_ = () => ({ done: 0, total: 3, xp: 0, streak: 0 });
ctx.getWeekStats_ = () => ({ done: 0 });
const mk = o => Object.assign({
  todoId: 'x', titleZh: '中', titleEn: 'En', deadlineRaw: 'Friday', confidence: 'high', source: 'Gmail',
  sourceLink: 'http://m', refDate: new Date(2026, 9, 12), deadline: new Date(2026, 9, 14), sourceTitle: 's',
}, o);
const todo = {
  byBucket: {
    overdue: [mk({ category: 'course', course: 'FIT5202', overdueDays: 2 })],
    h48: [mk({ category: 'course', course: 'FIT5196' })], week: [], later: [], noDate: [],
  },
  extras: {
    career: [mk({ category: 'career', bucket: ctx.BUCKET_48H, titleZh: 'Shopee 职业讲座' }),
             mk({ category: 'career', bucket: ctx.BUCKET_LATER, titleZh: '远期招聘' }),
             mk({ category: 'career', bucket: ctx.BUCKET_NODATE, titleZh: '无截止的实习提醒', deadline: null })],
    campus: Array.from({ length: 7 }, (_, i) => mk({ category: 'campus', bucket: ctx.BUCKET_WEEK, titleZh: 'Event ' + i })),
  },
  total: 2, urgentCount: 2,
};
const html = ctx.buildDigestHtml_('2026年10月13日', [{
  type: 'pinned', course: 'FIT5196 - MUM S2 2026', title: 'Wk 11 info <b>', url: 'http://ed', date: '2026-10-12 09:00', aiSummary: '概要 ▸ 要点1',
}], todo, '');
ok(html.includes('课程待办') && html.includes('实习 / 求职') && html.includes('校园活动'));
ok(html.includes('Shopee 职业讲座') && html.includes('远期招聘') && html.includes('无截止的实习提醒'), 'career 全部列出，含远期和无截止');
ok(html.includes('Event 6'), 'campus 不再限量');
ok(html.indexOf('实习 / 求职') < html.indexOf('校园活动'), 'career 在 campus 前');
ok(html.includes('FIT5196]') && !html.includes('MUM S2'), 'Ed 课程名归一');
ok(html.includes('Wk 11 info &lt;b&gt;'), 'HTML 转义');
ok(!html.includes('Urgent Tasks') && !html.includes("Today's Updates"), '冗余 AI 卡片已删');
ok(html.includes('原文 “Friday”') && html.includes('发布 10/12'), '日期溯源');
const err = ctx.buildDigestHtml_('d', [], null, 'boom');
ok(err.includes('待办生成失败') && err.includes('boom'));

// ── 对外可见的函数（编辑器下拉里的）只能是这几个 ──
const exposed = fs.readdirSync(root).filter(f => f.endsWith('.gs'))
  .flatMap(f => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/^function (\w+)\(/gm)].map(m => m[1]))
  .filter(fn => !fn.endsWith('_')).sort();
eq(exposed, ['backfillCategoryLabels', 'doGet', 'rolloverSemester', 'runDailyDigest', 'runSync', 'setupTriggers', 'testSetup']);

console.log(`ALL PASS (${n} assertions)`);
