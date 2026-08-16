/**
 * Cron 工具（对标 ZCode CronCreate/CronUpdate/CronDelete/CronList）：
 * 让 agent 自己创建/管理定时任务，操作 ~/.bajin/automations.json（与设置页·自动化
 * 及 app-server 调度器共用存储）。prompt 必须是自包含的最终工作指令。
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { loadAutomations, saveAutomations, createAutomation, type Automation } from '../automations.js';
import { nextCronRun } from '../cron.js';

const CreateInput = z.object({
  title: z.string().min(1).describe('任务标题；保留用户的自然语言时间描述，如「每20分钟写一章」'),
  prompt: z.string().min(1).describe('到点执行的完整指令（自包含，不要引用对话上下文）'),
  cron: z.string().optional().describe('5 字段 cron（分 时 日 月 周，本地时区）。相对时间（如 8分钟后）不要换算成 cron，改用 delayMinutes'),
  delayMinutes: z.number().int().min(0).optional().describe('相对分钟数（一次性任务），如 「8分钟后」=8；与 cron 二选一'),
});

export function createCronCreateTool(): ToolDefinition<typeof CreateInput> {
  return {
    name: 'CronCreate',
    description:
      'Create a persistent scheduled automation in the current workspace. 用户要求定时/周期做事（如每晚写一章小说）时用本工具，不要只口头答应。cron 表达 5 字段本地时区；相对时间用 delayMinutes（一次性）。创建后每轮在设置→自动化可见。',
    inputSchema: CreateInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 10_000, concurrentSafe: false },
    async execute(input) {
      try {
        const entry = await createAutomation(input);
        const list = await loadAutomations();
        await saveAutomations([...list, entry]);
        const when = entry.oneShot
          ? `一次性，${new Date(entry.nextRunAt ?? 0).toLocaleString('zh-CN')} 触发`
          : `cron「${entry.cron}」，下次 ${new Date(entry.nextRunAt ?? 0).toLocaleString('zh-CN')}`;
        return { ok: true, output: `已创建自动化 ${entry.id}「${entry.title}」：${when}` };
      } catch (err) {
        return { ok: false, output: `创建失败: ${err instanceof Error ? err.message : err}` };
      }
    },
  };
}

const UpdateInput = z.object({
  id: z.string().min(1).describe('automation id（CronList 可查）'),
  title: z.string().optional(),
  prompt: z.string().optional(),
  cron: z.string().optional().describe('新 5 字段 cron；提供时会重算 nextRunAt'),
  enabled: z.boolean().optional(),
});

export function createCronUpdateTool(): ToolDefinition<typeof UpdateInput> {
  return {
    name: 'CronUpdate',
    description: 'Update an existing automation (title/prompt/cron/enabled) by id. 改 cron 后自动重算下次触发；暂停用 enabled:false。',
    inputSchema: UpdateInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 10_000, concurrentSafe: false },
    async execute(input) {
      const list = await loadAutomations();
      const idx = list.findIndex((a) => a.id === input.id);
      if (idx < 0) return { ok: false, output: `不存在自动化 ${input.id}（CronList 查现有 id）` };
      const cur: Automation = list[idx]!;
      const next: Automation = {
        ...cur,
        ...(input.title ? { title: input.title } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
      if (input.cron) {
        const nr = nextCronRun(input.cron);
        if (!nr) return { ok: false, output: `cron 一年内无触发时机: ${input.cron}` };
        next.cron = input.cron;
        next.oneShot = false;
        next.nextRunAt = nr.getTime();
      }
      list[idx] = next;
      await saveAutomations(list);
      return { ok: true, output: `已更新 ${input.id}：enabled=${next.enabled}，cron=${next.cron}` };
    },
  };
}

const DeleteInput = z.object({ id: z.string().min(1).describe('要删除的 automation id') });

export function createCronDeleteTool(): ToolDefinition<typeof DeleteInput> {
  return {
    name: 'CronDelete',
    description: 'Delete a scheduled automation by id.',
    inputSchema: DeleteInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 10_000, concurrentSafe: false },
    async execute(input) {
      const list = await loadAutomations();
      const rest = list.filter((a) => a.id !== input.id);
      if (rest.length === list.length) return { ok: false, output: `不存在自动化 ${input.id}` };
      await saveAutomations(rest);
      return { ok: true, output: `已删除自动化 ${input.id}` };
    },
  };
}

const ListInput = z.object({});

export function createCronListTool(): ToolDefinition<typeof ListInput> {
  return {
    name: 'CronList',
    description: 'List scheduled automations in the current workspace (id/title/cron/enabled/nextRun).',
    inputSchema: ListInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 10_000, concurrentSafe: true },
    async execute() {
      const list = await loadAutomations();
      if (!list.length) return { ok: true, output: '（暂无自动化任务）' };
      return {
        ok: true,
        output: list
          .map((a) => `${a.enabled ? '●' : '○'} ${a.id}「${a.title}」cron=${a.oneShot ? '一次性' : a.cron} 下次=${a.nextRunAt ? new Date(a.nextRunAt).toLocaleString('zh-CN') : '—'}`)
          .join('\n'),
      };
    },
  };
}
