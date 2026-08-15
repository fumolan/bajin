import { Agent, PermissionPolicy, loadHooksConfig, type AgentCallbacks } from '@bajin/core';
import type { ModelProvider, PermissionMode } from '@bajin/shared';
import { dim, summarizeArgs } from './ui.js';

export interface HeadlessOptions {
  model: string;
  mode: PermissionMode;
  cwd: string;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  persistDir: string;
  rolloutDir: string;
  providerFactory: () => ModelProvider;
  sessionId?: string;
  transcriptPath?: string;
}

/** 无人交互运行：工具过程打到 stderr，最终回复打到 stdout */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const log = (s: string) => process.stderr.write(`${dim(s)}\n`);
  const callbacks: AgentCallbacks = {
    onToolCall: (name, args) => log(`⏺ ${name} ${summarizeArgs(name, args)}`),
    onToolResult: (name, r) => log(`  ${r.denied ? '✗ 已拒绝' : r.ok ? '✓' : '✗'} ${(r.output ?? '').split('\n')[0]?.slice(0, 120)}`),
    onApproval: async (name) => {
      log(`  ⚠ headless 模式默认拒绝需审批的工具 ${name}（如需放行：--mode yolo 或 allowedTools 配置）`);
      return false;
    },
  };

  const hooks = await loadHooksConfig(opts.cwd).catch(() => undefined);
  const agent = new Agent({
    provider: opts.providerFactory(),
    providerFactory: opts.providerFactory,
    model: opts.model,
    cwd: opts.cwd,
    mode: opts.mode,
    policy: new PermissionPolicy({ mode: opts.mode, allowedTools: opts.allowedTools, disallowedTools: opts.disallowedTools }),
    callbacks,
    persistDir: opts.persistDir,
    rolloutDir: opts.rolloutDir,
    ...(hooks?.enabled ? { hooks } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  await agent.ready;
  if (opts.transcriptPath && opts.sessionId) await agent.resumeFrom(opts.transcriptPath);

  const result = await agent.run(opts.prompt);
  process.stdout.write(`${result.text.trim()}\n`);
  log(`[统计] 迭代 ${result.iterations} · 工具调用 ${result.toolCalls} · 被拒 ${result.denied} · tokens ${result.usage.totalTokens ?? '-'}`);
  return result.denied > 0 && result.toolCalls > 0 && result.denied === result.toolCalls ? 2 : 0;
}
