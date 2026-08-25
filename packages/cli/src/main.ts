import { promisify } from 'node:util';
import { execFile as ef } from 'node:child_process';
const execFileAsync = promisify(ef);
import { createGlmProvider, createAnthropicProvider, listSessions, rewindTranscript, openSessionStore, migrateJsonlToStore, readCustomModels, readProviders, resolveModelEndpoint } from '@bajin/core';
import { platform, type ModelProvider, type PermissionMode } from '@bajin/shared';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { runRepl } from './repl.js';
import { runHeadless } from './headless.js';
import { runAppServer } from './app-server.js';

/** 状态目录：BAJIN_HOME 环境变量可覆盖（桌面端「数据目录迁移」用），缺省 ~/.bajin——解析统一在平台适配层 */
const HOME_STATE = platform.stateRoot(undefined, process.env);
const PERSIST_DIR = path.join(HOME_STATE, 'sessions');
const ROLLOUT_DIR = path.join(HOME_STATE, 'rollout');

const USAGE = `bajin — 交互式编码代理

用法:
  bajin                      进入交互式 REPL
  bajin -p "任务描述"         headless 模式：执行单个任务后退出（别名 --print）
  bajin app-server --stdio   作为桌面端后端进程运行（JSON-RPC over stdio）

选项:
  --model <name>   覆盖模型（默认 glm-5.3；也可在配置文件里设 model）
  --mode <mode>    权限模式 plan|build|edit|yolo（默认 build）
  -c, --continue   恢复最近一次会话继续
  --resume <id>    恢复指定会话（sessionId 前缀匹配）
  --rewind <n>     回退最近 N 轮对话后进入会话（配合 --resume/-c；仅裁 transcript）
  --mock           使用内置 mock provider（无需 API key，冒烟测试用）
  -h, --help       本帮助

子命令:
  migrate [--db <file>]  存量 JSONL 会话迁入 SQLite（幂等；默认 ~/.bajin/sessions.db，遵循 BAJIN_HOME）
  export <id> [--out f]  导出会话为 Markdown（id 支持前缀匹配；默认 <sessionId>.md）
  server [--port N]      浏览器完整 bajin UI（默认端口 4444）
  app-server --stdio     作为桌面端后端进程运行

配置（作用域链，近的覆盖远的）:
  System 默认 < ~/.bajin/config.json（用户级）
  < 项目级 bajin.json / .bajin/config.json（自 cwd 向上到 .git 根，近的覆盖远的）
  < BAJIN_MODEL/BAJIN_MODE/BAJIN_BASE_URL/BAJIN_ALLOWED_TOOLS 等环境变量 < 命令行旗标
  API key 优先级: BIGMODEL_API_KEY 环境变量 > 配置 bigmodel.apiKey
  会话与 rollout 日志: ~/.bajin/sessions/ 与 ~/.bajin/rollout/
`;

interface CliArgs {
  print: boolean;
  model?: string;
  mode?: PermissionMode;
  mock: boolean;
  help: boolean;
  continueLast: boolean;
  resume?: string;
  rewind?: number;
  prompt: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { print: false, mock: false, help: false, continueLast: false, prompt: [] };
  const modes = ['plan', 'build', 'edit', 'yolo'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-p' || a === '--print') args.print = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--mode' && modes.includes(argv[i + 1] ?? '')) args.mode = argv[++i] as PermissionMode;
    else if (a === '--mock') args.mock = true;
    else if (a === '-c' || a === '--continue') args.continueLast = true;
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--rewind') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('--rewind 需要正整数（回退最近 N 轮对话）');
        process.exit(1);
      }
      args.rewind = n;
    }
    else if (a === '-h' || a === '--help') args.help = true;
    else args.prompt.push(a);
  }
  return args;
}

function main(): void {
  void (async () => {
    // 子命令：bajin app-server --stdio [--mock]
    if (process.argv[2] === 'app-server') {
      if (!process.argv.includes('--stdio')) {
        console.error('app-server 需要 --stdio（当前仅支持 stdio 传输）');
        process.exit(1);
      }
      runAppServer();
      return;
    }

    // 子命令：bajin export <sessionId> [--format md|html] [--out file] —— 导出会话
    if (process.argv[2] === 'export') {
      const sid = process.argv[3];
      if (!sid) {
        console.error('用法: bajin export <sessionId> [--format md|html] [--out <file>]');
        process.exit(1);
      }
      const flagVal = (name: string): string | undefined => {
        const i = process.argv.indexOf(name);
        return i >= 0 ? process.argv[i + 1] : undefined;
      };
      const format = flagVal('--format') === 'html' ? 'html' : 'md';
      const outFlag = flagVal('--out');
      const { loadTranscript, exportSessionMarkdown, exportSessionHtml } = await import('@bajin/core');
      const sessions = await listSessions(PERSIST_DIR, 200);
      const hit = sessions.find((s) => s.sessionId.startsWith(sid));
      if (!hit) {
        console.error(`未找到会话 ${sid}`);
        process.exit(1);
      }
      const { messages, meta } = await loadTranscript(hit.transcriptPath);
      const text = format === 'html'
        ? exportSessionHtml(messages, { ...meta, sessionId: hit.sessionId })
        : exportSessionMarkdown(messages, { ...meta, sessionId: hit.sessionId });
      const out = outFlag ?? `${hit.sessionId}.${format}`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, text, 'utf8');
      console.log(`已导出 ${messages.length} 条消息到 ${out}（${format.toUpperCase()}）`);
      return;
    }

    // 子命令：bajin migrate —— 存量 JSONL 会话迁入 SQLite（幂等，可重复执行）
    if (process.argv[2] === 'migrate') {
      const dbFlag = process.argv[3] === '--db' ? process.argv[4] : undefined;
      const db = dbFlag ?? path.join(HOME_STATE, 'sessions.db');
      const store = openSessionStore(db);
      try {
        const r = await migrateJsonlToStore(PERSIST_DIR, store);
        console.log(`迁移完成：新迁入 ${r.migrated} 个会话 / ${r.messages} 条消息；跳过已入库 ${r.skipped} 个。库文件：${db}`);
      } catch (err) {
        console.error(`迁移失败: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      } finally {
        store.close();
      }
      return;
    }
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return;
    }
    const config = await loadConfig(process.cwd());

    // 子命令：bajin batch <file> [--interval ms] —— 批量执行（每行一个 prompt）
    if (process.argv[2] === 'batch') {
      const batchFile = process.argv[3];
      if (!batchFile) {
        console.error('用法: bajin batch <file.txt>（每行一个 prompt，# 开头跳过）');
        process.exit(1);
      }
      const { readFileSync } = await import('node:fs');
      const lines = readFileSync(batchFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      if (!lines.length) { console.error('文件为空或全是注释'); process.exit(1); }
      console.log(`批量执行 ${lines.length} 个任务：`);
      const intervalFlag = process.argv.indexOf('--interval');
      const interval = intervalFlag > 0 ? Number(process.argv[intervalFlag + 1]) || 1000 : 1000;
      for (let i = 0; i < lines.length; i++) {
        console.log(`\n[${i + 1}/${lines.length}] ${lines[i]}`);
        try {
          await execFileAsync(process.execPath, [
            path.resolve(__dirname, 'main.js'), '-p', lines[i]!,
            ...(args.mock ? ['--mock'] : []),
          ], { env: process.env, timeout: 120_000 });
        } catch (err) {
          console.error(`  ✗ 失败: ${err instanceof Error ? err.message : err}`);
        }
        if (i < lines.length - 1) await new Promise((r) => setTimeout(r, interval));
      }
      console.log('\n✓ 批量执行完成');
      return;
    }

    // 子命令：bajin server [--port N] —— 浏览器完整 bajin UI（与桌面端一致）
    if (process.argv[2] === 'server') {
      const portFlag = process.argv.indexOf('--port');
      const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 4444;
      const { startWebServer } = await import('./web-server.js');
      startWebServer({
        port,
        cwd: process.cwd(),
        model: config.model ?? 'glm-4.7',
        mock: args.mock,
        apiKey: process.env['BIGMODEL_API_KEY'] ?? config.bigmodel.apiKey,
        baseUrl: config.bigmodel.baseUrl,
      });
      return; // server 常驻不返回
    }

    const mode = args.mode ?? config.mode;
    const model = args.model ?? config.model;

    let providerFactory: () => ModelProvider;
    if (args.mock) {
      providerFactory = () => createEchoMock();
    } else {
      const apiKey = process.env['BIGMODEL_API_KEY'] ?? config.bigmodel.apiKey;
      // 与 app-server 同一条端点解析链：模型自带 > 供应商（openai/anthropic 格式）> 全局 key
      const customModels = await readCustomModels().catch(() => []);
      const providers = await readProviders().catch(() => []);
      const ep = resolveModelEndpoint(model, customModels, providers);
      const chainKey = ep.apiKey ?? apiKey;
      if (!chainKey) {
        console.error('缺少 API key。请设置环境变量 BIGMODEL_API_KEY，或为模型/供应商配置 key；冒烟测试可用 --mock。');
        process.exit(1);
      }
      providerFactory =
        ep.apiFormat === 'anthropic'
          ? () => createAnthropicProvider({ apiKey: chainKey, baseUrl: ep.baseUrl ?? config.bigmodel.baseUrl, model })
          : () => createGlmProvider({ apiKey: chainKey, baseUrl: ep.baseUrl ?? config.bigmodel.baseUrl, model });
    }

    // 恢复会话：--continue 取最近，--resume 前缀匹配
    let resume: { sessionId: string; transcriptPath: string } | undefined;
    if (args.continueLast || args.resume || args.rewind) {
      const sessions = await listSessions(PERSIST_DIR);
      const hit = args.resume
        ? sessions.find((s) => s.sessionId.startsWith(args.resume!))
        : sessions[0];
      if (!hit) {
        console.error(args.resume ? `未找到会话 ${args.resume}` : '没有可恢复的历史会话');
        process.exit(1);
      }
      resume = { sessionId: hit.sessionId, transcriptPath: hit.transcriptPath };
    }

    // 回退 N 轮后进入会话（对标 ZCode rewind）：只裁 transcript，meta 不动
    if (args.rewind && resume) {
      const r = await rewindTranscript(resume.transcriptPath, args.rewind);
      console.log(`已回退 ${r.removedTurns} 轮（删 ${r.removedLines} 行，剩 ${r.remainingTurns} 轮）：${resume.sessionId}`);
    } else if (args.rewind && !resume) {
      console.error('--rewind 需要有可回退的历史会话（配合 --resume <id> 或 -c）');
      process.exit(1);
    }

    const common = {
      providerFactory,
      model,
      mode,
      cwd: process.cwd(),
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
      persistDir: PERSIST_DIR,
      rolloutDir: ROLLOUT_DIR,
      ...(resume ?? {}),
    };

    if (args.print) {
      const prompt = args.prompt.join(' ').trim();
      if (!prompt) {
        console.error('--print 需要跟一个任务描述，如: bajin -p "列出当前目录的 ts 文件"');
        process.exit(1);
      }
      const code = await runHeadless({ ...common, prompt });
      process.exit(code);
    }
    await runRepl(common);
  })().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}

/** --mock 用的回显 provider：把用户输入原样返回，验证 CLI 全链路 */
export function createEchoMock(): ModelProvider {
  let seq = 0;
  return {
    id: 'echo-mock',
    defaultModel: 'echo-1',
    async chat(req) {
      seq++;
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = `[mock] 模型=${req.model}，收到: ${lastUser && lastUser.role === 'user' ? lastUser.content.slice(0, 200) : ''}`;
      return {
        message: { role: 'assistant', content: text },
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 + seq },
        finishReason: 'stop',
      };
    },
  };
}

main();
