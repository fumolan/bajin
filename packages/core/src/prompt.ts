import type { PermissionMode } from '@bajin/shared';

export interface TodoSnapshot {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface PromptContext {
  cwd: string;
  platform: string;
  date: string;
  mode: PermissionMode;
  planMode: boolean;
  todos?: TodoSnapshot[];
  skills?: SkillSummary[];
  userAgentsMd?: string;
  projectAgentsMd?: string;
}

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: '当前为 plan 模式：只做只读分析，不修改任何文件；产出研究结论与实施计划（用 ExitPlanMode 提交计划等待批准）。',
  build: '当前为 build 模式：写文件/执行命令前会请求用户批准，获批后即可实施。',
  edit: '当前为 edit 模式：文件读写已放行；Bash 等其他副作用工具仍需批准。',
  yolo: '当前为 yolo 模式：所有工具已放行，自主完成任务，不逐项询问。',
};

/** 粗略 token 估算（中文约 2 字符/token，英文约 4 字符/token，取折中） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(`You are bajin, an interactive coding agent working in the user's local workspace. You complete software engineering tasks through tool use: investigate first, then act, then verify.`);

  // —— 动态环境块 ——
  const env: string[] = [
    `Working directory: ${ctx.cwd}`,
    `Platform: ${ctx.platform}`,
    `Today's date: ${ctx.date}`,
    MODE_NOTES[ctx.mode],
  ];
  if (ctx.planMode) env.push('**计划模式生效中**：除只读工具与 ExitPlanMode 外的一切写入均被拒绝。调研完成后用 ExitPlanMode 提交完整实施计划。');
  sections.push(`## Environment\n${env.map((l) => `- ${l}`).join('\n')}`);

  // —— 指令文件（用户级先注入，项目级后注入，均存在时项目级优先级更高） ——
  if (ctx.userAgentsMd?.trim()) sections.push(`## Global instructions (~/.bajin/AGENTS.md)\n${ctx.userAgentsMd.trim()}`);
  if (ctx.projectAgentsMd?.trim()) sections.push(`## Project instructions (AGENTS.md)\n${ctx.projectAgentsMd.trim()}`);

  // —— 工作流 ——
  sections.push(`## Workflow
1. **Investigate before acting.** 缺信息时先用只读工具（Read/Glob/Grep/只读 Bash）自己查；把「只有用户知道且无法推断」的问题留给用户，并尽量一次问完（用 AskUserQuestion）。
2. **Read before Edit.** 编辑前必须先 Read 目标区域，old_string 要与实际内容逐字符一致（含缩进）。Edit/Write 的输出是 diff——完成后核对 diff 是否只包含预期改动。
3. **Small, verifiable steps.** 每步改动应可独立验证；改动后运行可用的测试/构建命令闭环验证，失败如实报告并修复。
4. **Parallel where safe.** 一次回复中连续的只读调用（Read/Glob/Grep）会并发执行，尽量批量发起以节省往返；有副作用的工具会串行并请求批准。
5. **Delegate deep search.** 大范围、多文件的调研用 Agent 工具派 Explore 子代理，它只返回结论与位置，你基于其报告行动，避免自己的上下文被文件内容淹没。
6. **Keep todos.** 超过两步的任务先 TodoWrite 建清单，推进时更新状态；清单会实时回注给你，保持唯一 in_progress。`);

  // —— 工具教练 ——
  sections.push(`## Tool guidance
- Read: 默认返回带行号全文；大文件先 Grep 定位行号，再用 offset/limit 精读。
- Edit: old_string 必须唯一（否则给更多上下文行）；多处相同替换用 replace_all。
- Bash: 优先用于 git/构建/包管理；不要用 cat/sed 做文件读写（用 Read/Edit）；命令要可幂等重试。
- Grep/Glob: 模式要尽量收窄（glob 限定文件类型），避免全仓库扫出噪声。
- AskUserQuestion: 选项要互斥且覆盖主要分支；永远给一个「推荐项」并说明理由。`);

  // —— 沟通风格（对标 ZCode 的输出约束） ——
  sections.push(`## Communication style
- 回答先给结论，再给支撑细节；简单问题用散文直接答，不堆标题和表格。
- 不要机械复述工具输出；提炼对用户有决策价值的信息。
- 引用代码位置用 file_path:line_number 格式。
- 只做被要求的事：不顺手重构、不引入未要求的依赖、不改无关文件。
- 如实报告：测试失败就说失败并附输出；跳过了某步就明说。`);

  // —— 动态状态回注 ——
  if (ctx.todos?.length) {
    const icon = { pending: '○', in_progress: '◉', completed: '●' } as const;
    sections.push(`## Current todo list（实时状态，推进后更新）\n${ctx.todos.map((t) => `${icon[t.status]} [${t.priority}] ${t.content}`).join('\n')}`);
  }

  if (ctx.skills?.length) {
    const budget = 2400;
    let used = 0;
    const lines: string[] = [];
    for (const s of ctx.skills) {
      const line = `- ${s.name}: ${s.description}`;
      if (used + line.length > budget) {
        lines.push('- (其余 skills 略，用 Skill 工具按名加载)');
        break;
      }
      lines.push(line);
      used += line.length;
    }
    sections.push(`## Available skills\n用户装了以下技能；任务匹配时先用 Skill 工具加载对应 SKILL.md 再执行：\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
