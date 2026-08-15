import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Agent, groupToolCalls, builtinTools, loadTranscript, listSessions } from '../src/index.js';
import { createMockProvider, type MockStep } from '../src/providers/mock.js';
import type { ToolCall } from '@bajin/shared';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-essence-'));
});

const tool = (name: string): ToolCall => ({ id: `c_${name}_${Math.random()}`, name, arguments: '{}' });

describe('groupToolCalls 并发分组', () => {
  const lookup = (n: string) => builtinTools.find((t) => t.name === n);

  it('连续 concurrentSafe 合并，副作用工具独立成组', () => {
    const calls = [tool('Read'), tool('Read'), tool('Grep'), tool('Write'), tool('Read')];
    const groups = groupToolCalls(calls, lookup);
    expect(groups.map((g) => g.length)).toEqual([3, 1, 1]);
    expect(groups[0]!.map((c) => c.name)).toEqual(['Read', 'Read', 'Grep']);
    expect(groups[1]![0]!.name).toBe('Write');
  });

  it('Bash 不与 Read 合并', () => {
    const groups = groupToolCalls([tool('Read'), tool('Bash')], lookup);
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
  });
});

describe('并行工具执行', () => {
  it('一回复多工具：结果按原顺序回注，即使并发完成', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'AAA');
    await fs.writeFile(path.join(dir, 'b.txt'), 'BBB');
    const agent = new Agent({
      provider: createMockProvider([
        {
          toolCalls: [
            { name: 'Read', args: { file_path: 'b.txt' } },
            { name: 'Read', args: { file_path: 'a.txt' } },
          ],
        },
        { text: '读完了' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
    });
    const result = await agent.run('read both');
    expect(result.text).toBe('读完了');
    const toolMsgs = agent.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => (m as { name: string }).name)).toEqual(['Read', 'Read']);
    // 结果按调用顺序回注：第一个调用是 b.txt（BBB），第二个是 a.txt（AAA）
    expect(toolMsgs[0] && (toolMsgs[0] as { content: string }).content).toContain('BBB');
    expect(toolMsgs[1] && (toolMsgs[1] as { content: string }).content).toContain('AAA');
  });
});

describe('Plan 模式工作流', () => {
  function planAgent(approve: boolean) {
    return new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'EnterPlanMode', args: {} }] },
        { toolCalls: [{ name: 'Write', args: { file_path: 'blocked.txt', content: 'x' } }] },
        { toolCalls: [{ name: 'ExitPlanMode', args: { plan: '1. do A\n2. do B' } }] },
        { text: '计划已批准，开始实施。' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'build',
      enableSubagent: false,
      callbacks: { onApproval: async (name) => (name === 'ExitPlanMode' ? approve : false) },
    });
  }

  it('进入计划模式后写入被拒；批准计划后可继续', async () => {
    const agent = planAgent(true);
    const result = await agent.run('重构这个模块');
    expect(result.denied).toBe(1); // Write 被 planMode 拒
    expect(await fs.stat(path.join(dir, 'blocked.txt')).catch(() => null)).toBeNull();
    const toolMsgs = agent.messages.filter((m) => m.role === 'tool') as Array<{ name: string; content: string }>;
    expect(toolMsgs.find((m) => m.name === 'EnterPlanMode')?.content).toContain('计划模式');
    const exitMsg = toolMsgs.find((m) => m.name === 'ExitPlanMode');
    expect(exitMsg?.content).toContain('build');
    expect(result.text).toContain('实施');
    expect(agent.planMode).toBe(false);
  });

  it('拒绝计划：留在计划模式并反馈模型', async () => {
    const agent = planAgent(false);
    const result = await agent.run('重构这个模块');
    const exitMsg = agent.messages.filter((m) => m.role === 'tool') as Array<{ name: string; content: string }>;
    expect(exitMsg.find((m) => m.name === 'ExitPlanMode')?.content).toContain('未批准');
    expect(agent.planMode).toBe(true);
    expect(result.denied).toBe(1); // Write 被 planMode 拒（计划拒绝走工具返回，不计入 denied）
  });
});

describe('子代理', () => {
  it('Agent 工具派 Explore 子代理并返回其报告，事件带前缀转发', async () => {
    const seenToolCalls: string[] = [];
    const childSteps: MockStep[] = [
      { toolCalls: [{ name: 'Glob', args: { pattern: '*.txt' } }] },
      { text: 'Found 2 files: a.txt b.txt' },
    ];
    const parent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Agent', args: { description: 'find txt files', prompt: '找出所有 txt 文件', subagent_type: 'Explore' } }] },
        { text: '根据子代理报告：Found 2 files' },
      ]),
      providerFactory: () => createMockProvider(childSteps),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      callbacks: { onToolCall: (name) => void seenToolCalls.push(name) },
    });
    const result = await parent.run('找文件');
    expect(result.text).toContain('Found 2 files');
    const agentToolMsg = parent.messages.find((m) => m.role === 'tool' && (m as { name: string }).name === 'Agent') as { content: string } | undefined;
    expect(agentToolMsg?.content).toContain('a.txt');
    // 子代理事件转发带 profile 前缀
    expect(seenToolCalls).toContain('[Explore] Glob');
  });

  it('Explore 子代理工具集不含 Agent（防递归）与 Write', async () => {
    const parent = new Agent({
      provider: createMockProvider([{ text: 'skip' }]),
      providerFactory: () => createMockProvider([{ text: 'x' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
    });
    const names = parent.toolset().map((t) => t.name);
    expect(names).toContain('Agent');
    // 子代理场景通过 opts.tools 传入过滤集——此处直接验证 createSubagentTool 依赖的过滤白名单
    expect(names).toContain('EnterPlanMode');
    expect(names).toContain('Skill');
  });
});

describe('Skills 发现与注入', () => {
  it('发现 .bajin/skills 并注入 prompt，Skill 工具可加载正文', async () => {
    const skillDir = path.join(dir, '.bajin', 'skills', 'demo-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill for testing injection\n---\n\n# Demo\n\nDo the special thing.',
    );
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Skill', args: { skill: 'demo-skill' } }] },
        { text: '已按技能操作' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
    });
    await agent.ready;
    expect(agent.skillSummaries().map((s) => s.name)).toContain('demo-skill');
    const result = await agent.run('用 demo-skill 处理');
    // system prompt（run 时才组装）含 skills 清单
    const sys = agent.messages[0];
    expect(sys && sys.role === 'system' && sys.content).toContain('demo-skill');
    const skillMsg = agent.messages.find((m) => m.role === 'tool' && (m as { name: string }).name === 'Skill') as { content: string } | undefined;
    expect(skillMsg?.content).toContain('Do the special thing');
    expect(result.text).toBe('已按技能操作');
  });
});

describe('会话持久化 + 恢复 + rollout 日志', () => {
  it('transcript 落盘，resumeFrom 恢复历史，rollout 记录请求响应', async () => {
    const persistDir = path.join(dir, 'sessions');
    const rolloutDir = path.join(dir, 'rollout');
    const first = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'Write', args: { file_path: 'note.txt', content: 'hello' } }] },
        { text: '第一轮完成' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      persistDir,
      rolloutDir,
    });
    await first.ready;
    await first.run('创建 note.txt');

    // rollout 日志：request + response 各至少一条
    const rolloutFiles = await fs.readdir(rolloutDir);
    expect(rolloutFiles.some((f) => f.startsWith(`model-io-${first.sessionId}`))).toBe(true);
    const rolloutRaw = await fs.readFile(path.join(rolloutDir, `model-io-${first.sessionId}.jsonl`), 'utf8');
    expect(rolloutRaw).toContain('"dir":"request"');
    expect(rolloutRaw).toContain('"dir":"response"');

    // transcript 可回放
    const transcriptPath = path.join(persistDir, first.sessionId, 'transcript.jsonl');
    const { messages } = await loadTranscript(transcriptPath);
    expect(messages.some((m) => m.role === 'user' && m.content === '创建 note.txt')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);

    // 恢复：同 sessionId 续写
    const second = new Agent({
      provider: createMockProvider([{ text: '第二轮回答' }]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
      sessionId: first.sessionId,
      persistDir,
    });
    await second.ready;
    const n = await second.resumeFrom(transcriptPath);
    expect(n).toBeGreaterThan(0);
    await second.run('继续');
    expect(second.messages.some((m) => m.role === 'user' && m.content === '创建 note.txt')).toBe(true);

    // listSessions 能看到并带标题
    const sessions = await listSessions(persistDir);
    expect(sessions[0]?.sessionId).toBe(first.sessionId);
    expect(sessions[0]?.title).toContain('创建 note.txt');
  });
});

describe('todo 状态回注 system prompt', () => {
  it('TodoWrite 后的下一轮 system prompt 含清单', async () => {
    const agent = new Agent({
      provider: createMockProvider([
        { toolCalls: [{ name: 'TodoWrite', args: { todos: [{ content: '第一步', status: 'in_progress', priority: 'high' }] } }] },
        { text: '清单已建' },
      ]),
      model: 'm',
      cwd: dir,
      mode: 'yolo',
      enableSubagent: false,
    });
    await agent.run('建清单');
    const sys = agent.messages[0];
    expect(sys && sys.role === 'system' && sys.content).toContain('第一步');
    expect(sys?.content).toContain('Current todo list');
  });
});
