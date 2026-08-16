import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SkillSummary } from './prompt.js';
function stateHome(home?: string): string {
  if (home) return path.join(home, '.bajin');
  return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/') ? process.env.BAJIN_HOME : path.join(os.homedir(), '.bajin');
}

export interface DiscoveredSkill extends SkillSummary {
  /** SKILL.md 绝对路径 */
  file: string;
  /** 所在技能目录（可能带 references/ scripts/） */
  dir: string;
  source: 'project' | 'user';
}

/** 发现顺序（高 → 低）：项目 .bajin/skills → 用户 ~/.bajin/skills；同名先到先得 */
export async function discoverSkills(cwd: string, home?: string): Promise<DiscoveredSkill[]> {
  const roots: Array<{ dir: string; source: 'project' | 'user' }> = [
    { dir: path.join(cwd, '.bajin', 'skills'), source: 'project' },
    { dir: path.join(stateHome(home), 'skills'), source: 'user' },
  ];
  const seen = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seen.has(name)) continue;
      const file = path.join(root.dir, name, 'SKILL.md');
      try {
        const raw = await fs.readFile(file, 'utf8');
        const fm = parseFrontmatter(raw);
        if (!fm.name || !fm.description) continue;
        seen.add(name);
        out.push({ name: fm.name, description: fm.description, file, dir: path.dirname(file), source: root.source });
      } catch {
        // 无 SKILL.md 或不可读，跳过
      }
    }
  }
  return out;
}


/**
 * 内置默认技能（对标 ZCode 官方插件的能力域，净室自写正文）：
 * skill-creator（技能创建）/ docx·pptx·pdf（文档三件套）/ self-check（配置自检）。
 * 首次启动种到用户技能目录，只在缺失时写入——用户改过永不覆盖。
 */
export const BUILTIN_SKILLS: Array<{ name: string; description: string; body: string }> = [
  {
    name: 'skill-creator',
    description: '创建、改进自定义技能。用户想沉淀可复用操作流程为技能时使用',
    body: `# 技能创建指南

## 何时建技能
同类任务反复出现（周报、部署流程、固定分析套路）且步骤可文档化时，沉淀为技能而不是每次重新解释。

## 步骤
1. 定名字：小写字母/数字/连字符，含义明确（如 weekly-report）。
2. 写描述：一句话说清「什么场景用」，这是模型决定是否调用的唯一依据——要写触发场景关键词。
3. 写正文（SKILL.md 正文即执行指南）：
   - 前置条件（依赖、目录约定）
   - 分步操作（可执行命令 + 判断分支）
   - 输出格式要求
   - 常见坑与注意事项
4. 放置：用户级 ~/.bajin/skills/<name>/SKILL.md（全局）或项目 .bajin/skills/<name>/（项目内优先）。
5. frontmatter 只需两行：
   ---
   name: <name>
   description: <一句话场景描述>
   ---

## 正文写作要点
- 步骤写到「照做即可」的粒度，命令给出可直接复制的完整形态。
- 引用文件用相对路径；长参考资料放同目录 references/，正文里指路。
- 技能是被注入的系统指引：不要写对话式客套，直接写操作规程。
`,
  },
  {
    name: 'docx',
    description: '创建与编辑 Word 文档（python-docx）：报告、方案、通知等 .docx 生成任务',
    body: `# Word 文档生成指南

## 工具链
python-docx（pip install python-docx）。生成脚本存到临时目录后执行，不要交互式粘贴。

## 结构模板
1. 标题用 doc.add_heading(文本, level)；正文 doc.add_paragraph。
2. 多级列表：doc.add_paragraph(文本, style='List Bullet' / 'List Number')。
3. 表格：doc.add_table(rows, cols) + Table Grid 样式；逐格填 cell.text。
4. 页眉页脚：section.header / .footer paragraph。
5. 中文字体：run.font.name='宋体' 且 run._element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')。

## 流程
1. 先与内容对齐大纲（章节标题列表）再动笔。
2. 生成 .py 脚本 → python 执行 → 打开校验段落数与表格尺寸。
3. 输出文件放用户指定目录；未指定时放 ./output/。

## 坑
- add_heading 的 level 0 是 Title 样式，1 才是 Heading 1。
- 换行用 add_paragraph，不要在文本里塞 \n（不生效）。
`,
  },
  {
    name: 'pptx',
    description: '生成 PowerPoint 演示文稿（python-pptx）：汇报、方案讲解等 .pptx 任务',
    body: `# PPT 生成指南

## 工具链
python-pptx（pip install python-pptx）。

## 结构模板
1. 版式：slide_layouts[0]=封面 [1]=章节节标题 [5]=标题+正文 [6]=空白。
2. 文本框：slide.shapes.add_textbox( Inches(x), Inches(y), Inches(w), Inches(h) )；tf.word_wrap=True。
3. 列表条目：tf.add_paragraph() 逐条，p.text=…; p.level=0/1。
4. 图表：add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x,y,cx,cy, chart_data)。

## 设计基线（16:9）
- 一页一个论点，标题 ≤12 字，正文条目 ≤5 条、每条 ≤2 行。
- 全篇统一字体两档（标题/正文）与三色（主色/强调/灰）。
- 先写逐页大纲（页题+要点）征求确认，再生成。

## 坑
- 空白版式放文本框必须显式设字号，否则继承母版小字。
- 中文需 run.font.name 同时设 eastAsia（同 docx 的 qn 方案）。
`,
  },
  {
    name: 'pdf',
    description: 'PDF 生成与处理：报告排版、合并拆分、提取文本等 .pdf 任务',
    body: `# PDF 处理指南

## 选型
- 排版生成报告/简历：优先写 LaTeX（中文用 ctex/xeCJK）或 typst，pdflatex/xelatex 编译。
- 由 HTML 转 PDF：playwright/chromium 打印为 PDF（保留样式最省事）。
- 合并/拆分/旋转：pypdf。提取文本：pdfplumber（表格友好）。

## 流程
1. 问清目标：打印（A4 页边距正常）还是屏读（可宽边距、可深色图表）。
2. 生成脚本 → 执行 → 用 pdfinfo/pypdf 校验页数与页尺寸。
3. 输出放用户指定目录。

## 坑
- xelatex 才吃系统中文字体；缺字体报错时改用 fandol 或 Noto CJK。
- pypdf 合并注意 outline 丢失；需要书签时用 PdfWriter.add_outline_item 重建。
- 扫描件（无文本层）先 OCR（tesseract -l chi_sim+eng）再提取。
`,
  },
  {
    name: 'self-check',
    description: 'bajin 配置问题自检：命令/钩子/MCP/技能不生效或行为异常时排查',
    body: `# 配置自检流程

按「现象 → 查什么」排查，全部用只读手段，不要改用户配置。

## 自定义命令不出现
1. 列 ~/.bajin/commands 与 项目 .bajin/commands 下的 *.md。
2. 文件名必须匹配 ^[a-z0-9][a-z0-9_:-]{0,63}$（大写/点/空格会被丢弃）。
3. frontmatter 必须是顶层单行 key: value（缩进的 nested 块不解析）。
4. 嵌套目录是冒号命令：review/code.md → /review:code。
5. 同名冲突先到先得：项目级覆盖用户级。

## 钩子不触发
1. hooks 总开关：~/.bajin/config.json 的 hooks.enabled 必须为 true（默认关）。
2. 事件名核对七个：SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop。
3. matcher 是大小写敏感正则；省略=全匹配；写错=永不匹配。
4. command 型超时单位是秒；退出码 0=过 2=阻止 其他=记错不拦。
5. stdout 必须是严格 JSON（多余键会校验失败）。

## MCP 工具不出现
1. ~/.bajin/config.json mcpServers.<name>.type 必须是 stdio 或 sse。
2. stdio 需要 command 可执行；sse 需要 url 可达（curl 探测）。
3. 工具名前缀 mcp__<server>__<tool>；重启会话后才连接。

## 技能不出现
1. 目录结构 <skills根>/<name>/SKILL.md，frontmatter 缺 name 或 description 会被跳过。
2. 项目级同名覆盖用户级。

## 通用
改动 config.json 后重启会话/应用；BAJIN_HOME 环境变量会整体迁移状态目录。
`,
  },
];

/** 种入内置技能：仅当目标 SKILL.md 不存在时写入（用户编辑过永不覆盖）。返回本次写入数。 */
export async function seedBuiltinSkills(home?: string): Promise<number> {
  const root = path.join(stateHome(home), 'skills');
  let seeded = 0;
  for (const s of BUILTIN_SKILLS) {
    const file = path.join(root, s.name, 'SKILL.md');
    if (await fs.readFile(file, 'utf8').then(() => true, () => false)) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body}`, 'utf8');
    seeded++;
  }
  return seeded;
}

/** 极简 frontmatter 解析：--- 包裹块内的顶层 `key: value` */
export function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^([a-zA-Z_]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'name') out.name = m[2]!.trim();
    if (m[1] === 'description') out.description = m[2]!.trim();
  }
  return out;
}

/** Skill 工具输出时对 SKILL.md 正文做预算截断 */
export function clipSkillBody(body: string, maxChars = 8000): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[... SKILL.md 过长已截断（${body.length} 字符），完整内容可再 Read ${''}]`;
}
