import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';

const TodoItem = z.object({
  content: z.string().min(1).describe('任务描述（简短动宾短语）'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('当前状态'),
  priority: z.enum(['high', 'medium', 'low']).describe('优先级'),
});

const TodoWriteInput = z.object({
  todos: z.array(TodoItem).describe('完整任务清单（全量替换，不是增量更新）'),
});

export const TODO_STATE_KEY = 'todoList';

type TodoList = Array<z.infer<typeof TodoItem>>;

function render(todos: TodoList): string {
  const icon = { pending: '○', in_progress: '◉', completed: '●' } as const;
  return todos.map((t) => `${icon[t.status]} [${t.priority}] ${t.content}`).join('\n') || '(空)';
}

export const todoWriteTool: ToolDefinition<typeof TodoWriteInput> = {
  name: 'TodoWrite',
  description:
    '更新会话任务清单（全量替换）。多步骤任务开始时创建清单、推进时更新状态，让用户随时了解进度。同一时间最多一项 in_progress。',
  inputSchema: TodoWriteInput,
  metadata: { readOnly: false, riskLevel: 'low', concurrentSafe: true },
  async execute(input, ctx) {
    const inProgress = input.todos.filter((t) => t.status === 'in_progress').length;
    if (inProgress > 1) {
      return { ok: false, output: `同时有 ${inProgress} 项 in_progress，最多只允许 1 项` };
    }
    ctx.state.set(TODO_STATE_KEY, input.todos);
    return { ok: true, output: `清单已更新：\n${render(input.todos)}` };
  },
};

export function currentTodos(ctx: { state: Map<string, unknown> }): TodoList {
  return (ctx.state.get(TODO_STATE_KEY) as TodoList | undefined) ?? [];
}

const AskInput = z.object({
  question: z.string().describe('要问用户的完整问题'),
  header: z.string().max(12).optional().describe('问题简短标签'),
  options: z
    .array(
      z.object({
        label: z.string().describe('选项文案（1-5 个词）'),
        description: z.string().optional().describe('选项说明'),
      }),
    )
    .min(2)
    .max(4)
    .optional()
    .describe('2-4 个互斥选项'),
  multiSelect: z.boolean().optional().describe('允许多选'),
});

export const askUserQuestionTool: ToolDefinition<typeof AskInput> = {
  name: 'AskUserQuestion',
  description:
    '当遇到只有用户能定的决策（需求歧义、方案取舍、破坏性操作确认）时向用户提问。提供 2-4 个选项，用户也可自由输入。非交互环境会自动返回"无法提问"。',
  inputSchema: AskInput,
  metadata: { readOnly: true, riskLevel: 'low' },
  async execute(input, ctx) {
    const answer = await ctx.askUser({
      question: input.question,
      header: input.header,
      options: input.options,
      multiSelect: input.multiSelect,
    });
    if (!answer) {
      return { ok: false, output: '当前为无人交互环境，无法提问。请基于现有信息选择最合理的默认方案继续。' };
    }
    return { ok: true, output: `用户回答：${answer.answer}${answer.notes ? `\n补充说明：${answer.notes}` : ''}` };
  },
};
