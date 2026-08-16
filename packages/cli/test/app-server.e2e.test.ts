import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = path.resolve(fileURLToPath(new URL('../dist/main.js', import.meta.url)));

interface RpcMessage {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  event?: string;
  params?: Record<string, unknown>;
}

class ServerHandle {
  private seq = 0;
  private buffer = '';
  private waiters: Array<{ test: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }> = [];
  readonly messages: RpcMessage[] = [];

  constructor(readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buffer += d;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as RpcMessage;
        this.messages.push(msg);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i]!.test(msg)) {
            const w = this.waiters.splice(i, 1)[0]!;
            w.resolve(msg);
          }
        }
      }
    });
  }

  request(method: string, params?: unknown, id?: number): Promise<RpcMessage> {
    const reqId = id ?? ++this.seq;
    this.child.stdin!.write(`${JSON.stringify({ id: reqId, method, params })}\n`);
    return this.waitFor((m) => m.id === reqId && (m.result !== undefined || m.error !== undefined), 20_000);
  }

  waitFor(test: (m: RpcMessage) => boolean, timeoutMs = 10_000): Promise<RpcMessage> {
    const existing = this.messages.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待消息超时（${timeoutMs}ms）；已收到: ${JSON.stringify(this.messages.slice(-8))}`)), timeoutMs);
      this.waiters.push({
        test: (m) => {
          clearTimeout(timer);
          return test(m);
        },
        resolve,
      });
    });
  }

  waitForEvent(event: string, timeoutMs = 10_000): Promise<RpcMessage> {
    return this.waitFor((m) => m.event === event, timeoutMs);
  }

  waitForEventIn(sessionId: string, event: string, timeoutMs = 10_000): Promise<RpcMessage> {
    return this.waitFor((m) => m.event === event && m.params?.['sessionId'] === sessionId, timeoutMs);
  }

  close(): void {
    this.child.kill('SIGKILL');
  }
}

let dir: string;
let server: ServerHandle | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-appserver-'));
});
afterEach(() => {
  server?.close();
  server = null;
});

function startServer(): ServerHandle {
  // BAJIN_HOME 指向临时目录：e2e 不读写真实 ~/.bajin（用户数据绝不触碰）
  const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BAJIN_HOME: path.join(dir, 'state-home') },
  });
  server = new ServerHandle(child);
  return server;
}

async function init(s: ServerHandle, params: Record<string, unknown> = {}): Promise<string> {
  const res = await s.request('initialize', { cwd: dir, mock: true, ...params });
  return String(res.result!['sessionId']);
}

describe('bajin app-server（多会话）', () => {
  it('initialize 返回会话 id 与工具清单', async () => {
    const s = startServer();
    const res = await s.request('initialize', { cwd: dir, mock: true });
    expect(res.result!['protocol'] ?? true).toBeTruthy();
    expect(typeof res.result!['sessionId']).toBe('string');
    const tools = res.result!['tools'] as string[];
    for (const t of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'Agent']) {
      expect(tools).toContain(t);
    }
  });

  it('send 全链路：事件带 sessionId，todo-updated 推送', async () => {
    const s = startServer();
    const sid = await init(s, {
      mode: 'yolo',
      steps: [
        { toolCalls: [{ name: 'Write', args: { file_path: 'hello.txt', content: 'hello bajin' } }] },
        { toolCalls: [{ name: 'TodoWrite', args: { todos: [{ content: '第一步', status: 'completed', priority: 'high' }] } }] },
        { text: '文件已创建。' },
      ],
    });
    const sendRes = await s.request('send', { sessionId: sid, text: '创建 hello.txt' });
    expect(sendRes.result!['text']).toBe('文件已创建。');
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hello bajin');
    expect(await s.waitForEventIn(sid, 'text-delta')).toBeTruthy();
    expect(await s.waitForEventIn(sid, 'tool-result')).toBeTruthy();
    const todoEvt = await s.waitForEventIn(sid, 'todo-updated');
    expect((todoEvt.params!['todos'] as Array<{ content: string }>)[0]!.content).toBe('第一步');
    const done = await s.waitForEventIn(sid, 'done');
    expect(done.params!['toolCalls']).toBe(2);
  });

  it('多会话：session/new 各自独立收发与事件路由', async () => {
    const s = startServer();
    const s1 = await init(s);
    const res2 = await s.request('session/new', {});
    const s2 = String(res2.result!['sessionId']);
    expect(s2).not.toEqual(s1);

    const p1 = s.request('send', { sessionId: s1, text: 'tab1' });
    const p2 = s.request('send', { sessionId: s2, text: 'tab2' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result!['text']).toContain('tab1');
    expect(r2.result!['text']).toContain('tab2');
    // 事件路由不串台
    expect(await s.waitForEventIn(s1, 'done')).toMatchObject({ params: { text: expect.stringContaining('tab1') } });
    expect(await s.waitForEventIn(s2, 'done')).toMatchObject({ params: { text: expect.stringContaining('tab2') } });

    // status 与 close
    const st = await s.request('status', { sessionId: s1 });
    expect(typeof st.result!['tokens']).toBe('number');
    expect(await s.request('session/close', { sessionId: s2 })).toMatchObject({ result: { closed: true } });
  });

  it('ask-user 往返：AskUserQuestion 事件 → 回答注入工具结果', async () => {
    const s = startServer();
    const sid = await init(s, {
      mode: 'yolo',
      steps: [
        { toolCalls: [{ name: 'AskUserQuestion', args: { question: '用哪个方案?', options: [{ label: 'A 方案' }, { label: 'B 方案' }] } }] },
        { text: '已选 A。' },
      ],
    });
    const sendPromise = s.request('send', { sessionId: sid, text: '问我' });
    const ask = await s.waitForEventIn(sid, 'ask-user');
    expect((ask.params!['question'] as { question: string }).question).toContain('方案');
    const requestId = ask.params!['requestId'] as string;
    const ack = await s.request('ask-user:respond', { requestId, answer: { answer: 'A 方案' } });
    expect(ack.result!['resolved']).toBe(true);
    const done = await sendPromise;
    expect(done.result!['text']).toBe('已选 A。');
    const toolMsg = await s.waitForEventIn(sid, 'tool-result');
    expect(toolMsg.params!['output']).toContain('A 方案');
  });

  it('审批 + always allow：加入白名单后同类调用不再询问', async () => {
    const s = startServer();
    const sid = await init(s, {
      mode: 'build',
      steps: [
        { toolCalls: [{ name: 'Write', args: { file_path: 'a.txt', content: '1' } }] },
        { toolCalls: [{ name: 'Write', args: { file_path: 'b.txt', content: '2' } }] },
        { text: '两个文件都写好了' },
      ],
    });
    const sendPromise = s.request('send', { sessionId: sid, text: '写两个文件' });
    // 第一次审批：选择「始终允许」
    const ap1 = await s.waitForEventIn(sid, 'approval-request');
    expect(ap1.params!['name']).toBe('Write');
    await s.request('set-allowed-tools', { sessionId: sid, add: 'Write' });
    await s.request('approval:respond', { requestId: ap1.params!['requestId'], approved: true });
    // 第二次 Write 不再询问，直接执行
    const done = await sendPromise;
    expect(done.result!['text']).toContain('两个文件');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('2');
    const approvals = s.messages.filter((m) => m.event === 'approval-request' && m.params?.['sessionId'] === sid);
    expect(approvals).toHaveLength(1);
  });

  it('拒绝审批后工具被跳过，流程不中断', async () => {
    const s = startServer();
    const sid = await init(s, {
      mode: 'build',
      steps: [
        { toolCalls: [{ name: 'Write', args: { file_path: 'deny.txt', content: 'x' } }] },
        { text: '好的，已放弃写文件。' },
      ],
    });
    const sendPromise = s.request('send', { sessionId: sid, text: '写文件' });
    const approval = await s.waitForEventIn(sid, 'approval-request');
    await s.request('approval:respond', { requestId: approval.params!['requestId'], approved: false });
    const done = await sendPromise;
    expect(done.result!['denied']).toBe(1);
    expect(fs.existsSync(path.join(dir, 'deny.txt'))).toBe(false);
  });

  it('未 initialize 直接 send 返回错误', async () => {
    const s = startServer();
    const res = await s.request('send', { sessionId: 'sess_none', text: 'hi' });
    expect(res.error).toBeDefined();
  });

  it('set-mode / set-model / interrupt / status', async () => {
    const s = startServer();
    const sid = await init(s);
    await s.request('send', { sessionId: sid, text: '第一句' });
    const mode = await s.request('set-mode', { sessionId: sid, mode: 'yolo' });
    expect(mode.result!['mode']).toBe('yolo');
    const model = await s.request('set-model', { sessionId: sid, model: 'glm-4.7' });
    expect(model.result!['model']).toBe('glm-4.7');
    const st = await s.request('status', { sessionId: sid });
    expect(st.result!['mode']).toBe('yolo');
    expect(st.result!['planMode']).toBe(false);
    const intr = await s.request('interrupt', { sessionId: sid });
    expect(intr.result!['interrupted']).toBe(true);
    const again = await s.request('send', { sessionId: sid, text: '第二句' });
    expect(again.result!['text']).toContain('第二句');
  });

  it('模型管理：add/list/remove 全链路，自定义模型可切换使用', async () => {
    const s = startServer();
    const sid = await init(s, { mode: 'yolo' });
    // 内置清单
    const list1 = await s.request('models/list');
    const ids1 = (list1.result!['models'] as Array<{ id: string; source: string }>).map((m) => m.id);
    expect(ids1).toContain('glm-5.3');
    expect(ids1).toContain('glm-4.7-flash');
    // 添加自定义模型（openai 兼容端点）
    const added = await s.request('models/add', { id: 'test-custom-model', label: '测试端点', baseUrl: 'https://llm.example.com/v1' });
    const custom = (added.result!['models'] as Array<{ id: string; source: string }>).filter((m) => m.source === 'custom');
    expect(custom.map((m) => m.id)).toContain('test-custom-model');
    // 持久化到 BAJIN_HOME（子进程沙箱）；测试进程读同一沙箱
    const { readCustomModels } = await import('@bajin/core');
    const prevHome = process.env.BAJIN_HOME;
    process.env.BAJIN_HOME = path.join(dir, 'state-home');
    try {
      const persisted = await readCustomModels();
      expect(persisted.some((m) => m.id === 'test-custom-model')).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.BAJIN_HOME;
      else process.env.BAJIN_HOME = prevHome;
    }
    // 切到自定义模型仍可正常收发（mock provider）
    const switched = await s.request('set-model', { sessionId: sid, model: 'test-custom-model' });
    expect(switched.result!['model']).toBe('test-custom-model');
    const sent = await s.request('send', { sessionId: sid, text: '自定义模型冒烟' });
    expect(sent.result!['text']).toContain('自定义模型冒烟');
    // 删除
    const removed = await s.request('models/remove', { id: 'test-custom-model' });
    expect((removed.result!['models'] as Array<{ id: string }>).some((m) => m.id === 'test-custom-model')).toBe(false);
    // 配置写入沙箱 BAJIN_HOME（临时目录随测试回收），无需再清理真实 ~/.bajin
  });

  it('供应商管理 + 模型挂供应商（端点解析链）', async () => {
    const s = startServer();
    const sid = await init(s, { mode: 'yolo' });
    // 预清理历史残留（断言失败中断时可能没走到尾部清理），使测试对全局配置幂等
    await s.request('models/remove', { id: 'e2e-model' }).catch(() => undefined);
    await s.request('providers/remove', { name: 'e2e-provider' }).catch(() => undefined);
    const list0 = await s.request('providers/list');
    const before = (list0.result!['providers'] as Array<{ name: string }>).map((p) => p.name);
    // 添加供应商（断言成员而非精确数量——真实环境可能有用户自己的供应商）
    const added = await s.request('providers/add', { name: 'e2e-provider', baseUrl: 'https://llm.e2e.test/v1', apiKey: 'sk-e2e', models: ['e2e-model'] });
    const after = (added.result!['providers'] as Array<{ name: string }>).map((p) => p.name);
    expect(after).toContain('e2e-provider');
    expect(after.filter((n) => !before.includes(n))).toEqual(['e2e-provider']);
    // 挂供应商的模型（不填 baseUrl，走供应商端点）
    const m = await s.request('models/add', { id: 'e2e-model', provider: 'e2e-provider' });
    expect((m.result!['models'] as Array<{ id: string; provider?: string }>).find((x) => x.id === 'e2e-model')?.provider).toBe('e2e-provider');
    // 未注册的供应商报错
    const bad = await s.request('models/add', { id: 'x', provider: 'nope' });
    expect(bad.error).toBeDefined();
    // mock 下切换到挂供应商的模型仍可收发
    await s.request('set-model', { sessionId: sid, model: 'e2e-model' });
    const sent = await s.request('send', { sessionId: sid, text: 'provider smoke' });
    expect(sent.result!['text']).toContain('provider smoke');
    // 清理：删除测试产物后，供应商名单恢复原样
    await s.request('models/remove', { id: 'e2e-model' });
    const rm = await s.request('providers/remove', { name: 'e2e-provider' });
    const names = (rm.result!['providers'] as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain('e2e-provider');
    expect(names).toEqual(before);
  });

  it('自动化：创建（校验 cron 并算下次）/列表/暂停/删除', async () => {
    const s = startServer();
    await init(s);
    const created = await s.request('automations/create', {
      title: 'e2e 每日任务',
      cron: '30 9 * * *',
      prompt: '检查项目状态并汇报',
    });
    const a = created.result!['automation'] as { id: string; nextRunAt: number; enabled: boolean };
    expect(a.enabled).toBe(true);
    expect(a.nextRunAt).toBeGreaterThan(Date.now());
    const bad = await s.request('automations/create', { title: 'x', cron: 'bad cron', prompt: 'y' });
    expect(bad.error).toBeDefined();
    const paused = await s.request('automations/toggle', { id: a.id, enabled: false });
    expect((paused.result!['automation'] as { enabled: boolean }).enabled).toBe(false);
    const removed = await s.request('automations/remove', { id: a.id });
    expect((removed.result!['automations'] as unknown[])).toHaveLength(0);
  });

  it('搜索/技能/分组/项目 RPC', async () => {
    const s = startServer();
    const sid = await init(s, { persist: true, steps: [{ text: '唯一标记词 bayjine2e 出现在回复里' }] });
    try {
      await s.request('send', { sessionId: sid, text: '说点带标记词的话' });
      // 搜索能命中
      const search = await s.request('search/sessions', { query: 'bayjine2e' });
      const results = search.result!['results'] as Array<{ sessionId: string }>;
      expect(results.some((r) => r.sessionId === sid)).toBe(true);
      // 技能：创建（校验命名）→ 列表 → 读取
      const badSkill = await s.request('skills/create', { name: 'Bad Name!' });
      expect(badSkill.error).toBeDefined();
      await s.request('skills/create', { name: 'e2e-skill', description: '测试技能' });
      const skills = await s.request('skills/list');
      expect((skills.result!['skills'] as Array<{ name: string }>).some((x) => x.name === 'e2e-skill')).toBe(true);
      const read = await s.request('skills/read', { name: 'e2e-skill' });
      expect(String(read.result!['content'])).toContain('e2e-skill');
      // 分组：设置 → 列表带分组
      const g = await s.request('session/set-group', { sessionId: sid, group: '测试组' });
      expect(g.result!['group']).toBe('测试组');
      const listed = await s.request('list-sessions');
      const item = (listed.result!['sessions'] as Array<{ sessionId: string; group: string | null }>).find((x) => x.sessionId === sid);
      expect(item?.group).toBe('测试组');
      // 项目：按 cwd 聚合
      const projects = await s.request('projects/list');
      expect((projects.result!['projects'] as Array<{ cwd: string; count: number }>).some((p) => p.count >= 1)).toBe(true);
      // 取消分组
      await s.request('session/set-group', { sessionId: sid, group: '' });
    } finally {
      // 清理写入真实 ~/.bajin 的测试产物
      const fsMod = await import('node:fs');
      const osMod = await import('node:os');
      const pathMod = await import('node:path');
      fsMod.rmSync(pathMod.join(osMod.homedir(), '.bajin', 'sessions', sid), { recursive: true, force: true });
      fsMod.rmSync(pathMod.join(osMod.homedir(), '.bajin', 'skills', 'e2e-skill'), { recursive: true, force: true });
    }
  });

  it('设置持久化：settings/set 写入 config.json', async () => {
    const s = startServer();
    await init(s);
    const res = await s.request('settings/set', { mode: 'edit' });
    expect(res.result!['saved']).toBe(true);
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const cfgPath = path.join(os.homedir(), '.bajin', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { mode?: string };
    expect(cfg['mode']).toBe('edit');
    // 还原默认，避免影响其他用例
    cfg['mode'] = 'build';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  });

  it('自定义 slash 命令：commands/list 发现 + send 内展开执行', async () => {
    // 在临时 cwd 放一个项目级命令（嵌套目录 → 冒号命名）
    const cmdDir = path.join(dir, '.bajin', 'commands', 'review');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, 'code.md'),
      '---\ndescription: 审查指定文件\nargument-hint: <文件>\n---\n请审查 $ARGUMENTS 的代码质量',
      'utf8',
    );
    const s = startServer();
    const sid = await init(s);

    // 发现：名字、描述、参数提示、来源
    const listed = await s.request('commands/list', {});
    const cmds = listed.result!['commands'] as Array<{ name: string; description: string; argumentHint?: string; source: string }>;
    const hit = cmds.find((c) => c.name === 'review:code');
    expect(hit).toBeTruthy();
    expect(hit!.description).toBe('审查指定文件');
    expect(hit!.argumentHint).toBe('<文件>');
    expect(hit!.source).toBe('project');

    // 执行：/review:code src/a.ts → mock echo 回显展开后的 prompt
    const res = await s.request('send', { sessionId: sid, text: '/review:code src/a.ts' });
    const text = String(res.result!['text'] ?? '');
    expect(text).toContain('请审查 src/a.ts 的代码质量');
    expect(text).not.toContain('$ARGUMENTS');
  });

  it('hooks：工作区 .bajin/config.json 的 UserPromptSubmit 钩子经 app-server 生效', async () => {
    // 工作区启用 hooks：注入附加上下文（mock echo 会回显最后一条用户消息）
    const cfgDir = path.join(dir, '.bajin');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            UserPromptSubmit: [
              { matcher: '规范', hooks: [{ command: `echo '{"additionalContext":"命名规范：camelCase"}'` }] },
              { matcher: '禁词', hooks: [{ command: 'exit 2' }] },
            ],
          },
        },
      }),
      'utf8',
    );
    const s = startServer();
    const sid = await init(s);

    // 命中注入：展开后的 prompt 带附加上下文
    const r1 = await s.request('send', { sessionId: sid, text: '查一下 规范' });
    expect(String(r1.result!['text'])).toContain('命名规范：camelCase');

    // 命中阻止：返回被钩子阻止的说明
    const r2 = await s.request('send', { sessionId: sid, text: '包含 禁词 的提问' });
    expect(String(r2.result!['text'])).toContain('UserPromptSubmit 钩子阻止');
  });

  it('任务管理：rename/pin/delete 全链路（meta.json 持久化 + list 优先级）', async () => {
    const s = startServer();
    const sid = await init(s, { persist: true });
    try {
      await s.request('send', { sessionId: sid, text: '任务管理测试消息' });
      await s.waitForEventIn(sid, 'done', 10_000);

      // 重命名：list-sessions 里 meta.title 优先于首条用户消息
      const rn = await s.request('session/rename', { sessionId: sid, title: '我的重要任务' });
      expect(rn.result!['title']).toBe('我的重要任务');
      let listed = (await s.request('list-sessions')).result!['sessions'] as Array<{ sessionId: string; title: string; pinned: boolean }>;
      expect(listed.find((x) => x.sessionId === sid)?.title).toBe('我的重要任务');

      // 置顶 / 取消置顶
      await s.request('session/pin', { sessionId: sid, pinned: true });
      listed = (await s.request('list-sessions')).result!['sessions'] as typeof listed;
      expect(listed.find((x) => x.sessionId === sid)?.pinned).toBe(true);
      await s.request('session/pin', { sessionId: sid, pinned: false });
      listed = (await s.request('list-sessions')).result!['sessions'] as typeof listed;
      expect(listed.find((x) => x.sessionId === sid)?.pinned).toBe(false);

      // 删除：目录移除，list 不再出现；删除不存在的报错
      const del = await s.request('session/delete', { sessionId: sid });
      expect(del.result!['deleted']).toBe(true);
      listed = (await s.request('list-sessions')).result!['sessions'] as typeof listed;
      expect(listed.find((x) => x.sessionId === sid)).toBeUndefined();
      const bad = await s.request('session/delete', { sessionId: 'sess_notexist' });
      expect(bad.error).toBeDefined();
    } finally {
      const fsMod = await import('node:fs');
      const osMod = await import('node:os');
      const pathMod = await import('node:path');
      fsMod.rmSync(pathMod.join(osMod.homedir(), '.bajin', 'sessions', sid), { recursive: true, force: true });
    }
  });

  it('使用统计：usage/stats 返回聚合指标', async () => {
    const s = startServer();
    const sid = await init(s, { persist: true });
    // 发一条消息，产生一条会话记录
    await s.request('send', { sessionId: sid, text: '你好世界，这是一段用于统计的测试消息' });
    await s.waitForEventIn(sid, 'done', 10_000);

    const res = await s.request('usage/stats', {});
    const st = res.result!;
    expect(typeof st['totalTokens']).toBe('number');
    expect(st['sessions']).toBeGreaterThanOrEqual(1);
    expect(st['messages']).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(st['days'])).toBe(true);
    expect(Array.isArray(st['models'])).toBe(true);
    expect(typeof st['currentStreak']).toBe('number');
    // 按范围筛选不报错
    const r7 = await s.request('usage/stats', { range: '7d' });
    expect(r7.result!['range']).toBe('7d');

    // 清理
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');
    fsMod.rmSync(pathMod.join(osMod.homedir(), '.bajin', 'sessions', sid), { recursive: true, force: true });
  });
});
