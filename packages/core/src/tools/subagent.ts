import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { builtinTools } from './index.js';
import type { Agent } from '../agent.js';
import type { SubagentDef } from '../subagents.js';

/**
 * 子代理工具（对标 ZCode 的 Agent/Task）：
 * - Explore：只读搜索代理（Read/Glob/Grep/Bash），返回调研结论，避免主上下文被文件内容淹没
 * - general-purpose：全能代理（除子代理/计划工具外的全部内置工具），用于独立子任务
 * - 自定义：.bajin/agents/*.md 定义（name/description/tools + 正文指引）
 * 子代理不再嵌套派生（深度 1），避免失控。
 */

const AgentInput = z.object({
  description: z.string().min(3).describe('3-5 词的任务简述'),
  prompt: z.string().min(1).describe('自包含的任务描述（子代理看不到当前对话，背景信息必须写全）'),
  subagent_type: z.string().min(1).default('Explore').describe('Explore=只读调研，general-purpose=可写子任务；或 .bajin/agents 里定义的自定义子代理名'),
});

export const SUBAGENT_COLORS = { Explore: 'cyan', 'general-purpose': 'blue' } as const;

export function createSubagentTool(agent: () => Agent, customDefs: SubagentDef[] = []): ToolDefinition<typeof AgentInput> {
  const customSummary = customDefs.length
    ? ` 自定义：${customDefs.map((d) => `${d.name}（${d.description.slice(0, 40)}）`).join('、')}。`
    : '';
  return {
    name: 'Agent',
    description:
      `Launch a subagent to handle a self-contained subtask and return its final report. 探索/检索用 Explore（只读、快）；可写的独立子任务用 general-purpose。prompt 必须自包含。${customSummary}`,
    inputSchema: AgentInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 300_000 },
    async execute(input, ctx) {
      const parent = agent();
      const type = input.subagent_type;
      const custom = parent.subagentsSnapshot().find((d) => d.name === type);

      let allowedNames: string[];
      let systemNote: string;
      if (custom) {
        allowedNames = custom.tools?.length
          ? custom.tools
          : [...builtinTools.map((t) => t.name), 'Skill'];
        systemNote = `\n\n你是自定义子代理「${custom.name}」（${custom.source === 'project' ? '项目级' : '用户级'}定义）。${custom.description}\n\n${custom.body}`;
      } else if (type === 'Explore') {
        allowedNames = ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'AskUserQuestion'];
        systemNote =
          '\n\nYou are a READ-ONLY search agent. 调查要快而广（medium depth），返回：结论、关键证据的 file:line 位置、以及与任务直接相关的简短摘录。不要给出实施建议以外的长篇内容。';
      } else if (type === 'general-purpose') {
        allowedNames = [...builtinTools.map((t) => t.name), 'Skill'];
        systemNote = '\n\nYou are a general-purpose subagent. 自主完成分配的子任务并返回结果摘要；如需修改文件，直接实施并报告改动。';
      } else {
        return { ok: false, output: `未知子代理类型「${type}」。可用：Explore、general-purpose${parent.subagentsSnapshot().map((d) => `、${d.name}`).join('')}` };
      }

      const childTools = parent.toolset().filter((t) => allowedNames.includes(t.name) || t.name.startsWith('mcp__'));
      if (!childTools.length) return { ok: false, output: '子代理工具集为空' };

      const { Agent: AgentClass } = await import('../agent.js');
      const child = new AgentClass({
        provider: parent.newSubagentProvider(),
        model: parent.model,
        cwd: ctx.cwd,
        mode: 'yolo',
        tools: childTools,
        maxIterations: 15,
        enableSubagent: false,
        inheritSkillsFrom: parent,
        callbacks: {
          onToolCall: (name, args) => parent.subagentForward()?.onToolCall?.(`[${type}] ${name}`, args),
          onToolResult: (name, r) => parent.subagentForward()?.onToolResult?.(`[${type}] ${name}`, r),
        },
        promptSuffix: systemNote,
      });
      const result = await child.run(`${input.description}\n\n${input.prompt}`);
      const report = result.text.trim() || '(子代理未返回文本报告)';
      return { ok: true, output: report.slice(0, 12_000) };
    },
  };
}

export const taskAlias = 'Task';
