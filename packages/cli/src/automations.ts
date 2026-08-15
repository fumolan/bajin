import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { nextCronRun } from '@bajin/core';

/** 自动化条目（对标 ZCode 的 automations 表的文件版） */
export interface Automation {
  id: string;
  title: string;
  cron: string;
  prompt: string;
  model?: string;
  mode?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: number;
  nextRunAt?: number;
  /** 复用的会话（自动化在自己的会话里跑，不污染日常对话） */
  sessionId?: string;
}

export function automationsPath(home = os.homedir()): string {
  return path.join(home, '.bajin', 'automations.json');
}

export async function loadAutomations(home = os.homedir()): Promise<Automation[]> {
  try {
    const raw = JSON.parse(await fs.readFile(automationsPath(home), 'utf8')) as Automation[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function saveAutomations(list: Automation[], home = os.homedir()): Promise<void> {
  const file = automationsPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/** 创建即校验 cron 并计算首次触发时间 */
export async function createAutomation(input: {
  title: string;
  cron: string;
  prompt: string;
  model?: string;
  mode?: string;
}): Promise<Automation> {
  const next = nextCronRun(input.cron);
  if (!next) throw new Error(`cron 表达式一年内无触发时机: ${input.cron}`);
  return {
    id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: input.title,
    cron: input.cron,
    prompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: next.getTime(),
  };
}
