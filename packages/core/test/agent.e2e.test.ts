import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Agent } from '../src/agent.js';
import { createMockProvider, type MockStep } from '../src/providers/mock.js';
import type { AgentCallbacks } from '../src/agent.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-e2e-'));
});

function makeAgent(steps: MockStep[], callbacks?: AgentCallbacks, mode: 'build' | 'yolo' = 'yolo') {
  const provider = createMockProvider(steps);
  const agent = new Agent({
    provider,
    model: 'mock-1',
    cwd: dir,
    mode,
    callbacks: { onApproval: async () => false, ...callbacks },
  });
  return { agent, provider };
}

describe('Agent 端到端（mock 驱动真实工具）', () => {
  it('完整任务：TodoWrite → Write → Edit → Grep → 总结', async () => {
    const { agent } = makeAgent([
      { toolCalls: [{ name: 'TodoWrite', args: { todos: [
        { content: '创建配置文件', status: 'in_progress', priority: 'high' },
        { content: '修改端口', status: 'pending', priority: 'medium' },
      ] } }] },
      { toolCalls: [{ name: 'Write', args: { file_path: 'config/app.conf', content: 'port=8080\nhost=localhost\n' } }] },
      { toolCalls: [{ name: 'Edit', args: { file_path: 'config/app.conf', old_string: 'port=8080', new_string: 'port=9090' } }] },
      { toolCalls: [{ name: 'Grep', args: { pattern: 'port', glob: '*.conf' } }] },
      { text: '已完成：配置文件已创建并把端口从 8080 改为 9090。' },
    ]);

    const result = await agent.run('请创建配置并修改端口');

    // 文件系统真实副作用
    const content = await fs.readFile(path.join(dir, 'config/app.conf'), 'utf8');
    expect(content).toBe('port=9090\nhost=localhost\n');

    // 会话历史完整：system + user + 4 组 (assistant+tool) + 最终 assistant
    const roles = agent.messages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(5);
    expect(roles.filter((r) => r === 'tool')).toHaveLength(4);

    expect(result.text).toContain('9090');
    expect(result.toolCalls).toBe(4);
    expect(result.denied).toBe(0);
    expect(result.iterations).toBe(5);
  });

  it('未知工具返回错误说明且不中断循环', async () => {
    const { agent } = makeAgent([
      { toolCalls: [{ name: 'NotATool', args: {} }] },
      { text: '好的，改用其他方式。' },
    ]);
    const result = await agent.run('试试不存在的工具');
    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain('其他方式');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg && toolMsg.role === 'tool' && toolMsg.content).toContain('未知工具');
  });

  it('参数校验失败反馈给模型', async () => {
    const { agent } = makeAgent([
      { toolCalls: [{ name: 'Write', args: { wrong_field: true } }] },
      { text: '参数写错了，重来。' },
    ]);
    const result = await agent.run('bad args');
    expect(result.text).toContain('重来');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg && toolMsg.role === 'tool' && toolMsg.content).toContain('参数校验失败');
  });

  it('build 模式 + 用户拒绝 → 工具被拒且循环继续', async () => {
    const { agent } = makeAgent(
      [
        { toolCalls: [{ name: 'Write', args: { file_path: 'x.txt', content: 'x' } }] },
        { text: '被拒了，我不再尝试写文件。' },
      ],
      { onApproval: async () => false },
      'build',
    );
    const result = await agent.run('写个文件');
    expect(result.denied).toBe(1);
    await expect(fs.stat(path.join(dir, 'x.txt'))).rejects.toThrow();
    expect(result.text).toContain('被拒');
  });

  it('会话延续：第二轮能拿到第一轮的上下文', async () => {
    const provider = createMockProvider([
      { toolCalls: [{ name: 'Write', args: { file_path: 'a.md', content: '# 标题' } }] },
      { text: '第一轮完成。' },
    ]);
    const agent = new Agent({ provider, model: 'mock-1', cwd: dir, mode: 'yolo' });
    await agent.run('创建 a.md');
    // 第二轮：脚本耗尽后 mock 停在最后一步，只返回文本
    const r2 = await agent.run('继续');
    expect(r2.text).toBeTruthy();
    // provider 收到的第二轮请求包含第一轮的完整历史
    const secondReq = provider.calls[1]!;
    expect(secondReq.messages.some((m) => m.role === 'user' && m.content === '创建 a.md')).toBe(true);
    expect(secondReq.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('达到最大迭代次数时安全停止', async () => {
    // 每步都要求调工具，永不收敛
    const loop = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'Glob', args: { pattern: '*.ts' } }] }));
    const { agent } = makeAgent(loop);
    const result = await agent.run('无限循环', undefined, 'yolo');
    // maxIterations 默认 40，但 mock 脚本 10 步耗尽后停在第 10 步（脚本耗尽后停在最后一步继续返回工具调用）
    expect(result.iterations).toBeLessThanOrEqual(40);
  });
});
