/**
 * 后台任务管理（对标 ZCode backgroundTasks：Bash run_in_background + TaskOutput/TaskStop）：
 * 长命令（构建/测试/dev server）后台执行，输出进环形缓冲（保尾部 64KB），
 * 模型经 TaskOutput 轮询/阻塞等待，TaskStop 终止。任务表进程内单例。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from '@bajin/shared';

const BUFFER_CAP = 64 * 1024;
const MAX_TASKS = 32;

export interface BackgroundTask {
  taskId: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** 尾部环形缓冲（stdout+stderr 交织，按到达顺序） */
  output: string;
  proc?: ChildProcess;
}

class BackgroundTaskManagerImpl {
  private readonly tasks = new Map<string, BackgroundTask>();
  private seq = 0;

  start(command: string, cwd: string, env?: Record<string, string>): BackgroundTask {
    // 容量上限：挤掉最老的已结束任务
    if (this.tasks.size >= MAX_TASKS) {
      const oldestDone = [...this.tasks.values()]
        .filter((t) => t.endedAt != null)
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0];
      if (oldestDone) this.tasks.delete(oldestDone.taskId);
      else this.tasks.delete(this.tasks.keys().next().value!);
    }
    // shell 选择与 -c / /c 语义由平台适配层统一处理（BAJIN_SHELL 显式优先）
    const sh = platform.commandShell(env?.['BAJIN_SHELL'] ?? process.env['BAJIN_SHELL'], process.env);
    const task: BackgroundTask = {
      taskId: `task_${++this.seq}_${Date.now().toString(36)}`,
      command,
      cwd,
      startedAt: Date.now(),
      output: '',
    };
    try {
      task.proc = spawn(sh.file, [sh.flag, command], {
        cwd,
        shell: false,
        env: { ...process.env, ...(env ?? {}), pwd: cwd },
      });
    } catch (err) {
      task.endedAt = Date.now();
      task.exitCode = null;
      task.output = `启动失败: ${err instanceof Error ? err.message : err}\n`;
      this.tasks.set(task.taskId, task);
      return task;
    }
    const append = (d: Buffer): void => {
      task.output += d.toString('utf8');
      if (task.output.length > BUFFER_CAP) task.output = task.output.slice(-BUFFER_CAP);
    };
    task.proc.stdout?.on('data', append);
    task.proc.stderr?.on('data', append);
    task.proc.on('error', (err) => {
      task.output += `\n[进程错误] ${err.message}\n`;
    });
    task.proc.on('close', (code) => {
      task.endedAt = Date.now();
      task.exitCode = code;
    });
    this.tasks.set(task.taskId, task);
    return task;
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  stop(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.endedAt != null) return false;
    t.proc?.kill('SIGTERM');
    // 2s 后强杀兜底
    setTimeout(() => { if (t.endedAt == null) t.proc?.kill('SIGKILL'); }, 2000).unref();
    return true;
  }

  /** 阻塞等待结束（timeoutMs 上限）后返回快照；block=false 立即返回当前输出 */
  async waitOutput(taskId: string, block: boolean, timeoutMs = 30_000): Promise<BackgroundTask | undefined> {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    if (!block || t.endedAt != null) return t;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.tasks.get(taskId)), Math.min(timeoutMs, 60_000));
      const poll = setInterval(() => {
        const cur = this.tasks.get(taskId);
        if (!cur || cur.endedAt != null) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(cur);
        }
      }, 100);
      // 也随 timer 一起清 poll
      const origTimer = timer;
      void origTimer;
      setTimeout(() => clearInterval(poll), Math.min(timeoutMs, 60_000) + 50).unref();
    });
  }
}

export const backgroundTasks = new BackgroundTaskManagerImpl();

export function describeTask(t: BackgroundTask): string {
  const status = t.endedAt == null ? '运行中' : `已退出（code=${t.exitCode ?? 'null'}）`;
  const dur = t.endedAt != null ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
  return `taskId=${t.taskId}「${t.command}」${status}，已运行 ${Math.round(dur / 100) / 10}s`;
}
