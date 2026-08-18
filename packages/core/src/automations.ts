/**
 * 自动化存储与创建（对标 ZCode automations）：~/.bajin/automations.json。
 * 从 cli/automations.js 迁入 core——agent 的 Cron 工具（tools/cron.ts）与
 * app-server 调度器共用同一存储；BAJIN_HOME 可覆盖根目录（与 sessions/memory 一致）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform } from '@bajin/shared';
import { nextCronRun } from './cron.js';

/** 自动化条目 */
export interface Automation {
  id: string;
  title: string;
  /** 5 字段 cron；一次性任务（delayMinutes 创建）固定为 `@once` */
  cron: string;
  prompt: string;
  model?: string;
  mode?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: number;
  nextRunAt?: number;
  /** 一次性任务：触发一次后自动停用 */
  oneShot?: boolean;
  /** 复用的会话（自动化在自己的会话里跑，不污染日常对话） */
  sessionId?: string;
}

export function automationsPath(home?: string): string {
  // home 语义 = 状态根本身；BAJIN_HOME/家目录回退由平台层统一处理
  return path.join(platform.stateRoot({ root: home }, process.env), 'automations.json');
}

export async function loadAutomations(home?: string): Promise<Automation[]> {
  try {
    const raw = JSON.parse(await fs.readFile(automationsPath(home), 'utf8')) as Automation[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function saveAutomations(list: Automation[], home?: string): Promise<void> {
  const file = automationsPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/**
 * 创建即校验并计算首次触发：cron（5 字段，一年内须有触发）或 delayMinutes（一次性）。
 */
export async function createAutomation(input: {
  title: string;
  prompt: string;
  cron?: string;
  /** 相对分钟（一次性任务）：与 cron 二选一 */
  delayMinutes?: number;
  model?: string;
  mode?: string;
}): Promise<Automation> {
  const base = {
    id: `auto_${randomUUID().slice(0, 8)}`,
    title: input.title,
    prompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  if (input.delayMinutes != null) {
    const mins = Math.max(0, Math.floor(input.delayMinutes));
    return { ...base, cron: '@once', oneShot: true, nextRunAt: Date.now() + mins * 60_000 };
  }
  if (!input.cron) throw new Error('需要 cron（5 字段）或 delayMinutes 之一');
  const next = nextCronRun(input.cron);
  if (!next) throw new Error(`cron 表达式一年内无触发时机: ${input.cron}`);
  return { ...base, cron: input.cron, nextRunAt: next.getTime() };
}
