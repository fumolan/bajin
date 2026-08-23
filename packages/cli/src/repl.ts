import * as readline from 'node:readline/promises';
import { Agent, PermissionPolicy, listSessions, discoverCommands, findCommand, expandCommand, loadHooksConfig, discoverSkills, type HooksConfig, type AgentCallbacks } from '@bajin/core';
import { promises as fs } from 'node:fs';
import type { PermissionMode, UserAnswer, UserQuestion } from '@bajin/shared';
import { BANNER, bold, cyan, dim, formatToolResult, green, red, summarizeArgs, yellow } from './ui.js';

export interface ReplOptions {
  model: string;
  mode: PermissionMode;
  cwd: string;
  allowedTools: string[];
  disallowedTools: string[];
  persistDir: string;
  rolloutDir: string;
  /** 子代理等场景独立建 provider 实例 */
  providerFactory: () => import('@bajin/shared').ModelProvider;
  /** 恢复会话 */
  sessionId?: string;
  transcriptPath?: string;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  console.log(BANNER);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Tab 补全：/ 前缀补全命令，其余补全文件路径
    completer: (line: string): [string[], string] => {
      // 斜杠命令补全
      if (line.startsWith('/') && !line.includes(' ')) {
        const cmds = [
          '/help', '/exit', '/quit', '/clear', '/compact', '/mode',
          '/model', '/new', '/interrupt', '/git status', '/git diff', '/git log',
        ];
        const hits = cmds.filter((c) => c.startsWith(line));
        return [hits.length ? hits : cmds, line];
      }
      // 文件路径补全
      const lastWord = line.split(/\s+/).pop() ?? '';
      if (!lastWord || lastWord.startsWith('/')) return [[], lastWord];
      try {
        const { readdirSync } = require('node:fs') as typeof import('node:fs');
        const dir = lastWord.includes('/')
          ? require('node:path').dirname(lastWord)
          : '.';
        const prefix = lastWord.includes('/')
          ? require('node:path').basename(lastWord)
          : lastWord;
        const files = readdirSync(require('node:path').resolve(opts.cwd, dir), { withFileTypes: true })
          .map((e: { name: string; isDirectory: () => boolean }) => e.isDirectory() ? e.name + '/' : e.name)
          .filter((f: string) => f.startsWith(prefix));
        return [files.map((f: string) => (dir === '.' ? f : dir + '/' + f)), lastWord];
      } catch { return [[], lastWord]; }
    },
  });

  const callbacks: AgentCallbacks = {
    onText: (delta) => process.stdout.write(delta),
    onReasoning: (delta) => process.stdout.write(dim(delta)),
    onToolCall: (name, args) => process.stdout.write(`\n${green('⏺')} ${bold(name)} ${yellow(summarizeArgs(name, args))}\n`),
    onToolResult: (_name, result) => process.stdout.write(`${formatToolResult(result)}\n`),
    onApproval: async (name, args) => {
      // 计划审批：展示完整计划再询问
      if (name === 'ExitPlanMode' && args && typeof args === 'object' && 'plan' in args) {
        console.log(`\n${cyan('📋 实施计划')}\n${yellow(String((args as { plan: string }).plan))}\n`);
        const answer = await rl.question(yellow('批准该计划并开始实施? [y/N] '));
        return answer.trim().toLowerCase().startsWith('y');
      }
      const answer = await rl.question(yellow(`  批准执行 ${bold(name)} ${summarizeArgs(name, args)} ? [y/N] `));
      return answer.trim().toLowerCase().startsWith('y');
    },
    onUsage: (u) => {
      if (u.totalTokens) process.stdout.write(dim(`\n  [tokens 累计: ${u.totalTokens}]\n`));
    },
  };

  const askUser = async (q: UserQuestion): Promise<UserAnswer | null> => {
    console.log(`\n${cyan('❓')} ${q.question}`);
    q.options?.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.description ? dim(` — ${o.description}`) : ''}`));
    const answer = await rl.question(dim('  输入序号或直接输入内容: '));
    const n = Number(answer.trim());
    if (q.options && Number.isInteger(n) && n >= 1 && n <= q.options.length) {
      return { answer: q.options[n - 1]!.label };
    }
    return answer.trim() ? { answer: answer.trim() } : null;
  };

  let model = opts.model;
  let mode = opts.mode;
  const hooks = await loadHooksConfig(opts.cwd).catch(() => ({}) as HooksConfig);
  if (hooks.enabled) console.log(dim(`hooks 已启用（${Object.keys(hooks.events ?? {}).length} 类事件）`));
  let agent = buildAgent();
  await agent.ready;
  if (opts.transcriptPath && opts.sessionId) {
    const n = await agent.resumeFrom(opts.transcriptPath);
    console.log(dim(`已恢复会话 ${opts.sessionId}（${n} 条历史消息），继续对话。`));
  }

  function buildAgent(): Agent {
    return new Agent({
      provider: opts.providerFactory(),
      providerFactory: opts.providerFactory,
      model,
      cwd: opts.cwd,
      mode,
      policy: new PermissionPolicy({ mode, allowedTools: opts.allowedTools, disallowedTools: opts.disallowedTools }),
      callbacks,
      askUser,
      persistDir: opts.persistDir,
      rolloutDir: opts.rolloutDir,
      ...(hooks.enabled ? { hooks } : {}),
    });
  }

  /** 切模型/模式后重建 Agent，保留对话历史 */
  function rebuildAgent(): void {
    const history = agent.messages.filter((m) => m.role !== 'system');
    agent = buildAgent();
    agent.messages.push(...history);
  }

  while (true) {
    let input: string;
    try {
      input = (await rl.question(cyan('\nbajin> '))).trim();
    } catch {
      break; // EOF / Ctrl-C
    }
    if (!input) continue;

    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      if (['exit', 'quit', 'q'].includes(cmd ?? '')) break;
      switch (cmd) {
        case 'help':
          console.log(`${bold('/model <name>')}   切换模型（保留历史）
${bold('/mode <plan|build|edit|yolo>')}   切换权限模式
${bold('/compact')}   压缩会话历史（超长上下文时也自动触发）
${bold('/sessions')}   列出历史会话（用 bajin --resume <id> 恢复）
${bold('/status')}   当前会话/上下文状态
${bold('/clear')}   清空会话历史
${bold('/exit')}   退出`);
          break;
        case 'model':
          if (!arg) console.log(dim('用法: /model <模型名>，如 /model glm-4.7-flash'));
          else {
            model = arg;
            rebuildAgent();
            console.log(dim(`模型已切换为 ${arg}（会话 ${agent.sessionId}）`));
          }
          break;
        case 'mode': {
          const modes = ['plan', 'build', 'edit', 'yolo'];
          if (!modes.includes(arg)) console.log(dim(`用法: /mode <${modes.join('|')}>`));
          else {
            mode = arg as PermissionMode;
            rebuildAgent();
            console.log(dim(`权限模式已切换为 ${arg}`));
          }
          break;
        }
        case 'compact': {
          console.log(dim('压缩中…'));
          const { before, after } = await agent.compact();
          console.log(dim(`压缩完成：约 ${before} → ${after} tokens（保留最近两轮原文）`));
          break;
        }
        case 'sessions': {
          const sessions = await listSessions(opts.persistDir, 10);
          if (!sessions.length) console.log(dim('暂无历史会话'));
          for (const s of sessions) {
            console.log(dim(`${s.sessionId}  ${new Date(s.modifiedAt).toLocaleString()}  ${s.title}`));
          }
          console.log(dim('恢复: bajin -c（最近）或 bajin --resume <id前缀>'));
          break;
        }
        case 'status':
          console.log(dim(`会话 ${agent.sessionId} · 模型 ${model} · 模式 ${mode}${agent.planMode ? '（计划中）' : ''} · 上下文约 ${agent.contextTokens()} tokens · 工具 ${agent.toolset().length} 个`));
          break;
        case 'clear':
          agent.reset();
          console.log(dim('会话已清空'));
          break;
        default: {
          // 内置命令未命中 → 查自定义 slash 命令（.bajin/commands → ~/.bajin/commands）
          const custom = findCommand(await discoverCommands(opts.cwd), cmd ?? '');
          if (!custom) {
            console.log(dim(`未知命令 /${cmd}，/help 查看帮助`));
            break;
          }
          let expanded: string;
          try {
            expanded = expandCommand(custom, arg);
          } catch (err) {
            console.error(red(`/${custom.name}: ${err instanceof Error ? err.message : String(err)}`));
            break;
          }
          // frontmatter 三效（对标 app-server send()）：model 切换 / allowed-tools 预授权 / skills 挂载
          if (custom.model) {
            console.log(dim(`  [model] ${custom.model}`));
          }
          for (const tool of custom.allowedTools ?? []) {
            agent.allowTool(tool);
          }
          let mounted = '';
          if (custom.skills?.length) {
            const all = await discoverSkills(opts.cwd).catch(() => []);
            for (const name of custom.skills) {
              const hit = all.find((x) => x.name === name);
              if (!hit) continue;
              const body = await fs.readFile(hit.file, 'utf8').catch(() => '');
              if (body) mounted += `[挂载技能 ${name}]\n${body.slice(0, 6000)}\n\n`;
            }
          }
          if (mounted) expanded = `${mounted}---\n${expanded}`;
          console.log(dim(`执行 /${custom.name}${arg ? ` ${arg}` : ''}（展开为 ${expanded.length} 字符 prompt）`));
          try {
            const result = await agent.run(expanded);
            console.log();
            if (!result.text.trim()) console.log(dim('(模型未返回文本)'));
          } catch (err) {
            console.error(red(`\n错误: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
      }
      continue;
    }

    try {
      const result = await agent.run(input);
      console.log();
      if (!result.text.trim()) console.log(dim('(模型未返回文本)'));
    } catch (err) {
      console.error(red(`\n错误: ${err instanceof Error ? err.message : String(err)}`));
      console.log(dim('会话保留，可继续输入；/clear 重置，/exit 退出。'));
    }
  }
  console.log(dim('再见。'));
  rl.close();
}
