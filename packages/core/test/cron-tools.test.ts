import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createCronCreateTool, createCronUpdateTool, createCronDeleteTool, createCronListTool } from '../src/tools/cron.js';
import { loadAutomations } from '../src/automations.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-cron-home-'));
process.env.BAJIN_HOME = home;

beforeEach(async () => { await rm(path.join(home, 'automations.json'), { force: true }).catch(() => undefined); });
afterAll(async () => {
  delete process.env.BAJIN_HOME;
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

const ctx = { cwd: home } as never;

describe('Agent Cron 工具（操作 automations.json）', () => {
  it('CronCreate cron：写盘、nextRunAt 在未来、输出含 id；delayMinutes：一次性标记', async () => {
    const create = createCronCreateTool();
    const r1 = await create.execute({ title: '每晚上8点写一章小说', prompt: '继续写小说：按大纲写下一章，保存到 chapters/。', cron: '0 20 * * *' }, ctx);
    expect(r1.ok).toBe(true);
    let list = await loadAutomations(home);
    expect(list).toHaveLength(1);
    expect(list[0]!.cron).toBe('0 20 * * *');
    expect(list[0]!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(r1.output).toContain(list[0]!.id);

    const r2 = await create.execute({ title: '8分钟后跑一次构建', prompt: '运行 pnpm -r test 并汇总失败项。', delayMinutes: 8 }, ctx);
    expect(r2.ok).toBe(true);
    list = await loadAutomations(home);
    const one = list.find((a) => a.oneShot)!;
    expect(one.cron).toBe('@once');
    expect(one.nextRunAt!).toBeGreaterThan(Date.now() + 7 * 60_000);
  });

  it('CronCreate 非法 cron 报错不写盘', async () => {
    const create = createCronCreateTool();
    const r = await create.execute({ title: 'x', prompt: 'y', cron: '* * * *' }, ctx); // 4 字段
    expect(r.ok).toBe(false);
    expect(r.output).toContain('失败');
    expect(await loadAutomations(home)).toHaveLength(0);
  });

  it('CronList / CronUpdate（改 cron 重算、暂停）/ CronDelete 全链路', async () => {
    const create = createCronCreateTool();
    await create.execute({ title: '每早9点日报', prompt: '生成日报', cron: '0 9 * * *' }, ctx);
    const [a] = await loadAutomations(home);

    const listR = await createCronListTool().execute({}, ctx);
    expect(listR.output).toContain(a!.id);

    const upd = createCronUpdateTool();
    const r2 = await upd.execute({ id: a!.id, cron: '30 21 * * *', enabled: false }, ctx);
    expect(r2.ok).toBe(true);
    const updated = (await loadAutomations(home))[0]!;
    expect(updated.cron).toBe('30 21 * * *');
    expect(updated.enabled).toBe(false);
    const d = new Date(updated.nextRunAt!);
    expect(d.getHours()).toBe(21);
    expect(d.getMinutes()).toBe(30);

    const del = createCronDeleteTool();
    expect((await del.execute({ id: a!.id }, ctx)).ok).toBe(true);
    expect(await loadAutomations(home)).toHaveLength(0);
    expect((await del.execute({ id: 'nope' }, ctx)).ok).toBe(false);
  });
});
