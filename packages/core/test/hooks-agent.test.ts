import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Agent } from '../src/index.js';
import { createMockProvider } from '../src/providers/mock.js';
import type { HooksConfig } from '../src/hooks.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-hookagent-'));
});

const hooksWith = (events: HooksConfig['events']): HooksConfig => ({ enabled: true, events });

describe('Agent × hooks 集成', () => {
  it('UserPromptSubmit 注入附加上下文：模型收到拼接后的 prompt', async () => {
    const agent = new Agent({
      provider: createMockProvider([{ text: '收到' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        UserPromptSubmit: [{ hooks: [{ command: `echo '{"additionalContext":"仓库规范见 docs/CONVENTIONS.md"}'` }] }],
      }),
    });
    await agent.ready;
    await agent.run('帮我改代码');
    const userMsg = agent.messages.find((m) => m.role === 'user');
    expect((userMsg as { content: string }).content).toContain('帮我改代码');
    expect((userMsg as { content: string }).content).toContain('docs/CONVENTIONS.md');
  });

  it('UserPromptSubmit 阻止提交：run 提前返回，不调用模型', async () => {
    const agent = new Agent({
      provider: createMockProvider([{ text: '不应出现' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        UserPromptSubmit: [{ matcher: '敏感', hooks: [{ command: 'exit 2' }] }],
      }),
    });
    await agent.ready;
    const result = await agent.run('这是 敏感 内容');
    expect(result.text).toContain('UserPromptSubmit 钩子阻止');
    expect(result.iterations).toBe(0);
    // matcher 不命中的提问正常通过
    const ok = await agent.run('正常问题');
    expect(ok.text).toBe('不应出现');
  });

  it('PreToolUse deny：工具被钩子拒绝，模型拿到拒绝原因', async () => {
    await fs.writeFile(path.join(dir, 'x.txt'), 'X');
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Write', args: { file_path: 'x.txt', content: '黑客' } }] },
        { text: '写入被拒，改用其他方式' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        PreToolUse: [{ matcher: 'Write', hooks: [{ command: `echo '{"decision":"deny","reason":"只读演练"}'` }] }],
      }),
    });
    await agent.ready;
    const result = await agent.run('写入 x.txt');
    expect(result.denied).toBe(1);
    const toolMsg = agent.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('只读演练');
    // 文件未被写入
    expect(await fs.readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('X');
  });

  it('PreToolUse allow：跳过用户审批（build 模式下 Write 不再询问）', async () => {
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Write', args: { file_path: 'ok.txt', content: '内容' } }] },
        { text: '写好了' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'build', // Write 在 build 下默认要审批；未提供 onApproval 会被视为拒绝
      enableSubagent: false,
      hooks: hooksWith({
        PreToolUse: [{ matcher: 'Write', hooks: [{ command: `echo '{"decision":"allow"}'` }] }],
      }),
    });
    await agent.ready;
    const result = await agent.run('写 ok.txt');
    expect(result.denied).toBe(0);
    expect(await fs.readFile(path.join(dir, 'ok.txt'), 'utf8')).toBe('内容');
  });

  it('PermissionRequest allow 免审批、deny 拒绝（build 模式）', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'A');
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Bash', args: { command: 'echo hi' } }] },
        { text: 'ok' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'build',
      enableSubagent: false,
      hooks: hooksWith({
        PermissionRequest: [{ matcher: 'Bash', hooks: [{ command: `echo '{"decision":"allow"}'` }] }],
      }),
    });
    await agent.ready;
    const r1 = await agent.run('跑个命令');
    expect(r1.denied).toBe(0);
    // 换 deny 的钩子
    const agent2 = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Bash', args: { command: 'echo hi' } }] },
        { text: '被拒了' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'build',
      enableSubagent: false,
      hooks: hooksWith({
        PermissionRequest: [{ matcher: 'Bash', hooks: [{ command: 'exit 2' }] }],
      }),
    });
    await agent2.ready;
    const r2 = await agent2.run('再跑一个');
    expect(r2.denied).toBe(1);
  });

  it('PostToolUse 注入上下文追加到工具输出', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'AAA');
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Read', args: { file_path: 'a.txt' } }] },
        { text: 'done' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        PostToolUse: [{ matcher: 'Read', hooks: [{ command: `echo '{"additionalContext":"此文件是配置样例"}'` }] }],
      }),
    });
    await agent.ready;
    await agent.run('读 a.txt');
    const toolMsg = agent.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('AAA');
    expect(toolMsg.content).toContain('此文件是配置样例');
  });

  it('Stop 续跑：钩子请求 continue 后模型被再次调用（注入继续消息），最多 3 次', async () => {
    let stops = 0;
    const agent = new Agent({
      provider: createMockProvider([{ text: '第一次回答' }, { text: '第二次回答' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        // 第一次 Stop 请求续跑，之后放行（用计数文件控制）
        Stop: [{ hooks: [{ command: `n=$(cat ${JSON.stringify(path.join(dir, 'stops'))} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(path.join(dir, 'stops'))}; if [ "$n" -lt 2 ]; then echo '{"continue":true,"stopReason":"请继续总结"}'; fi` }] }],
      }),
    });
    void stops;
    await agent.ready;
    const result = await agent.run('做个总结');
    expect(result.text).toBe('第二次回答');
    // 第二次模型调用前注入了「继续任务」消息
    expect(agent.messages.some((m) => m.role === 'user' && (m as { content: string }).content.includes('继续任务'))).toBe(true);
  });

  it('SessionStart(startup) 注入的上下文随第一条用户消息生效', async () => {
    const agent = new Agent({
      provider: createMockProvider([{ text: 'ok' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      hooks: hooksWith({
        SessionStart: [{ matcher: 'startup', hooks: [{ command: `echo '{"additionalContext":"本次会话目标：重构登录模块"}'` }] }],
      }),
    });
    await agent.ready; // SessionStart 在 initContext 里触发
    await agent.run('开始吧');
    const userMsg = agent.messages.find((m) => m.role === 'user') as { content: string };
    expect(userMsg.content).toContain('重构登录模块');
    // 只对第一条消息生效，后续消息不再带
    await agent.run('第二条');
    const users = agent.messages.filter((m) => m.role === 'user');
    expect((users[1] as { content: string }).content).not.toContain('重构登录模块');
  });
});
