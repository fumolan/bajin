import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';

/**
 * Plan 模式工作流（对标 ZCode 的 EnterPlanMode/ExitPlanMode）：
 * 复杂任务先进计划模式做只读调研 → ExitPlanMode 提交计划 →
 * 用户批准后自动切回 build 模式开始实施。
 *
 * 两个工具通过 getter 拿到宿主 Agent 的状态（避免循环引用）。
 */
export interface PlanModeHost {
  readonly planMode: boolean;
  enterPlan(): void;
  /** @returns approved */
  submitPlan(plan: string): Promise<boolean>;
}

const EnterPlanModeInput = z.object({});

export function createEnterPlanModeTool(host: () => PlanModeHost): ToolDefinition<typeof EnterPlanModeInput> {
  return {
    name: 'EnterPlanMode',
    description:
      '进入计划模式：之后你只能使用只读工具做调研（写入会被拒绝），调研完成后必须用 ExitPlanMode 提交实施计划。适合需求不明确、影响面大、或多方案需要取舍的任务。',
    inputSchema: EnterPlanModeInput,
    metadata: { readOnly: true, riskLevel: 'low' },
    async execute() {
      const h = host();
      if (h.planMode) return { ok: true, output: '已处于计划模式，继续调研即可。' };
      h.enterPlan();
      return {
        ok: true,
        output: '已进入计划模式。接下来：1) 只读调研（Read/Glob/Grep/Bash 只读命令）；2) 必要时用 AskUserQuestion 澄清关键决策；3) 用 ExitPlanMode 提交计划。',
      };
    },
  };
}

const ExitPlanModeInput = z.object({
  plan: z.string().min(1).describe('完整实施计划：目标、步骤、涉及文件、风险与验证方式'),
});

export function createExitPlanModeTool(host: () => PlanModeHost): ToolDefinition<typeof ExitPlanModeInput> {
  return {
    name: 'ExitPlanMode',
    description:
      '提交实施计划并请求用户批准。批准后自动切回 build 模式开始实施；被拒绝则留在计划模式，根据反馈修改计划后重新提交。',
    inputSchema: ExitPlanModeInput,
    metadata: { readOnly: true, riskLevel: 'low' },
    async execute(input) {
      const h = host();
      if (!h.planMode) {
        return { ok: false, output: '当前不在计划模式。需要先 EnterPlanMode。' };
      }
      const approved = await h.submitPlan(input.plan);
      return approved
        ? { ok: true, output: '计划已批准，已切换到 build 模式。开始按计划实施，并用 TodoWrite 建任务清单。' }
        : { ok: false, output: '用户未批准该计划。请阅读用户反馈，调整方案后重新 ExitPlanMode 提交。' };
    },
  };
}
