import { createGlmProvider, listSessions } from '@bajin/core';
import type { ModelProvider, PermissionMode } from '@bajin/shared';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from './config.js';
import { runRepl } from './repl.js';
import { runHeadless } from './headless.js';
import { runAppServer } from './app-server.js';

/** 状态目录：BAJIN_HOME 环境变量可覆盖（桌面端「数据目录迁移」用），缺省 ~/.bajin */
const HOME_STATE = process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/')
  ? process.env.BAJIN_HOME
  : path.join(os.homedir(), '.bajin');
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
  --mock           使用内置 mock provider（无需 API key，冒烟测试用）
  -h, --help       本帮助

配置:
  ~/.bajin/config.json（用户级）与 ./bajin.json（项目级，覆盖用户级）
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
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return;
    }
    const config = await loadConfig(process.cwd());
    const mode = args.mode ?? config.mode;
    const model = args.model ?? config.model;

    let providerFactory: () => ModelProvider;
    if (args.mock) {
      providerFactory = () => createEchoMock();
    } else {
      const apiKey = process.env['BIGMODEL_API_KEY'] ?? config.bigmodel.apiKey;
      if (!apiKey) {
        console.error('缺少 BigModel API key。请设置环境变量 BIGMODEL_API_KEY，或在 ~/.bajin/config.json 写入 {"bigmodel":{"apiKey":"..."}}；冒烟测试可用 --mock。');
        process.exit(1);
      }
      providerFactory = () => createGlmProvider({ apiKey, baseUrl: config.bigmodel.baseUrl, model });
    }

    // 恢复会话：--continue 取最近，--resume 前缀匹配
    let resume: { sessionId: string; transcriptPath: string } | undefined;
    if (args.continueLast || args.resume) {
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
