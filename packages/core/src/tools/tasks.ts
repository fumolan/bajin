/**
 * 后台任务工具（对标 ZCode TaskOutput/TaskStop）：与 Bash run_in_background 配套。
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { backgroundTasks } from '../background.js';

const TaskOutputInput = z.object({
  task_id: z.string().describe('后台任务 id（Bash run_in_background 返回）'),
  block: z.boolean().optional().describe('true=阻塞等待任务结束（默认，最长 timeout）；false=立即返回当前输出'),
  timeout: z.number().optional().describe('block 等待上限秒数，默认 30'),
});

export function createTaskOutputTool(): ToolDefinition<typeof TaskOutputInput> {
  return {
    name: 'TaskOutput',
    description: 'Retrieve output from a background task (started via Bash run_in_background). block=true 等待结束并给退出码；false 立即取当前输出。运行中的任务超时返回提示继续轮询。',
    inputSchema: TaskOutputInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 65_000, concurrentSafe: true },
    async execute(input) {
      const t = await backgroundTasks.waitOutput(input.task_id, input.block !== false, (input.timeout ?? 30) * 1000);
      if (!t) return { ok: false, output: `不存在后台任务 ${input.task_id}` };
      const status = t.endedAt == null
        ? '仍在运行——继续 TaskOutput 轮询，或 TaskStop 终止'
        : `已结束，退出码 ${t.exitCode ?? 'null'}`;
      const out = t.output.trim() || '(暂无输出)';
      return { ok: true, output: `${out}\n\n[状态] ${status}` };
    },
  };
}

const TaskStopInput = z.object({
  task_id: z.string().describe('要终止的后台任务 id'),
});

export function createTaskStopTool(): ToolDefinition<typeof TaskStopInput> {
  return {
    name: 'TaskStop',
    description: 'Stop a running background task by id (SIGTERM，2s 后 SIGKILL 兜底)。已结束的任务返回提示。',
    inputSchema: TaskStopInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 10_000 },
    async execute(input) {
      const t = backgroundTasks.get(input.task_id);
      if (!t) return { ok: false, output: `不存在后台任务 ${input.task_id}` };
      if (t.endedAt != null) return { ok: false, output: `任务已结束（code=${t.exitCode ?? 'null'}），无需终止` };
      backgroundTasks.stop(input.task_id);
      return { ok: true, output: `已发送终止信号：${t.command}` };
    },
  };
}
