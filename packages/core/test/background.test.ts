import { describe, it, expect } from 'vitest';
import { bashTool } from '../src/tools/exec.js';
import { createTaskOutputTool, createTaskStopTool } from '../src/tools/tasks.js';
import { backgroundTasks } from '../src/background.js';

const ctx = { cwd: process.cwd() } as never;

describe('后台任务（Bash run_in_background + TaskOutput/TaskStop）', () => {
  it('后台启动立即返回 taskId；TaskOutput 阻塞等到退出码并给全量输出', async () => {
    const started = await bashTool.execute({ command: 'echo start; sleep 0.4; echo done', run_in_background: true }, ctx);
    expect(started.ok).toBe(true);
    const id = /task_id="([^"]+)"/.exec(started.output)![1]!;
    expect(backgroundTasks.get(id)).toBeDefined();

    const out = await createTaskOutputTool().execute({ task_id: id }, ctx);
    expect(out.ok).toBe(true);
    expect(out.output).toContain('start');
    expect(out.output).toContain('done');
    expect(out.output).toContain('退出码 0');
  });

  it('TaskOutput block=false 立即返回运行中状态；TaskStop 终止长任务', async () => {
    const started = await bashTool.execute({ command: 'echo tick; sleep 30', run_in_background: true }, ctx);
    const id = /task_id="([^"]+)"/.exec(started.output)![1]!;

    const peek = await createTaskOutputTool().execute({ task_id: id, block: false }, ctx);
    expect(peek.output).toContain('仍在运行');

    const stopped = await createTaskStopTool().execute({ task_id: id }, ctx);
    expect(stopped.ok).toBe(true);
    // 阻塞等待退出（被杀，code 非 0）
    const fin = await createTaskOutputTool().execute({ task_id: id, timeout: 5 }, ctx);
    expect(fin.output).toContain('已结束，退出码');
    expect(fin.output).not.toContain('退出码 0');
  });

  it('未知 id 与已结束任务的 TaskStop 都给出明确提示', async () => {
    const out = await createTaskOutputTool().execute({ task_id: 'task_nope' }, ctx);
    expect(out.ok).toBe(false);
    const s = await bashTool.execute({ command: 'true', run_in_background: true }, ctx);
    const id = /task_id="([^"]+)"/.exec(s.output)![1]!;
    await createTaskOutputTool().execute({ task_id: id }, ctx); // 等结束
    const stopAgain = await createTaskStopTool().execute({ task_id: id }, ctx);
    expect(stopAgain.ok).toBe(false);
    expect(stopAgain.output).toContain('已结束');
  });

  it('输出环形缓冲只保尾部（64KB 上限）', async () => {
    const s = await bashTool.execute({ command: 'for i in $(seq 1 3000); do echo "line-$i-0123456789012345678901234567890123456789"; done', run_in_background: true }, ctx);
    const id = /task_id="([^"]+)"/.exec(s.output)![1]!;
    const out = await createTaskOutputTool().execute({ task_id: id, timeout: 20 }, ctx);
    const t = backgroundTasks.get(id)!;
    expect(t.output.length).toBeLessThanOrEqual(64 * 1024 + 4096); // cap + 单次 chunk 余量
    expect(out.output).toContain('line-3000'); // 尾部保留
  });
});
