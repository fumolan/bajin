/**
 * 任务图标推断（R9-1，对标 ZCode 任务列表彩色 emoji）：从任务标题/首条消息
 * 按关键词映射 emoji。纯函数无状态；未命中给轮换默认（按 title 哈希稳定取色，
 * 同一任务每次刷新图标一致）。
 */

const RULES: Array<[RegExp, string]> = [
  [/bug|修复|fix|报错|错误|失败/i, '🐛'],
  [/测试|test|用例/i, '🧪'],
  [/ppt|幻灯|slide|演示/i, '📊'],
  [/小说|写作|章节|大纲|文\//i, '✍️'],
  [/股票|股|行情|k线|k线|交易|量化/i, '📈'],
  [/部署|发布|deploy|上线|docker|k8s|集群/i, '🚀'],
  [/数据库|mysql|postgres|sql|mongo|redis/i, '🗄️'],
  [/前端|页面|ui|css|react|vue/i, '🎨'],
  [/后端|接口|api|服务端/i, '⚙️'],
  [/文档|说明|readme|手册|指南/i, '📝'],
  [/爬|抓取|crawl|scrape/i, '🕷️'],
  [/机器学习|模型|训练|llm|ai\b|智能/i, '🤖'],
  [/视频|剪|字幕|youtube|b站/i, '🎬'],
  [/telegram|tg机器人|tg/i, '✈️'],
  [/邮件|email|smtp/i, '📧'],
  [/聊天|对话|chat|助手/i, '💬'],
  [/翻译|translate/i, '🌐'],
  [/数据|分析|统计|报表/i, '📊'],
  [/安全|漏洞|渗透|加密/i, '🔒'],
  [/重构|优化|性能|refactor/i, '⚡'],
];

/** 稳定默认集（title 哈希选取——同一任务恒定） */
const DEFAULTS = ['💬', '🗂️', '📌', '🧩', '🛠️', '📦', '🔭', '🪄'];

export function taskIcon(text: string): string {
  const t = (text || '').trim();
  if (!t) return '💬';
  for (const [re, emoji] of RULES) {
    if (re.test(t)) return emoji;
  }
  // 稳定哈希（djb2）
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return DEFAULTS[h % DEFAULTS.length] ?? '💬';
}
