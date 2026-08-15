import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BUILTIN_MODEL_IDS, configFilePath, mergeModelOptions, readCustomModels, writeCustomModels,
  resolveModelEndpoint } from '../src/models.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-models-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('模型目录', () => {
  it('内置目录为 GLM 全系且去重', () => {
    expect(BUILTIN_MODEL_IDS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BUILTIN_MODEL_IDS).size).toBe(BUILTIN_MODEL_IDS.length);
    expect(BUILTIN_MODEL_IDS).toContain('glm-5.3');
  });

  it('无配置文件时自定义为空', async () => {
    await expect(readCustomModels(home)).resolves.toEqual([]);
  });

  it('写入自定义模型并保留 config.json 其他键', async () => {
    const file = configFilePath(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ model: 'glm-5.3', mode: 'build' }));
    await writeCustomModels([{ id: 'qwen3.5-plus', baseUrl: 'https://dashscope.example/v1', apiKey: 'sk-x' }], home);
    const after = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(after['model']).toBe('glm-5.3'); // 其他键保留
    expect(after['mode']).toBe('build');
    const models = await readCustomModels(home);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'qwen3.5-plus', baseUrl: 'https://dashscope.example/v1' });
  });

  it('合并：自定义优先，同名覆盖内置', () => {
    const merged = mergeModelOptions([{ id: 'glm-5.3', label: '我的定制 5.3' }, { id: 'deepseek-v4-pro' }]);
    expect(merged.find((m) => m.id === 'glm-5.3')?.source).toBe('custom');
    expect(merged.find((m) => m.id === 'deepseek-v4-pro')?.source).toBe('custom');
    // 内置里不再重复出现 glm-5.3
    expect(merged.filter((m) => m.id === 'glm-5.3')).toHaveLength(1);
    expect(merged.some((m) => m.id === 'glm-4.7' && m.source === 'builtin')).toBe(true);
  });
});

describe('供应商名下模型直接选用（apiFormat + 回退解析）', () => {
  it('模型未注册进 models[] 时，按供应商 models 名单解析端点与格式', () => {
    const providers = [
      { name: '美团', baseUrl: 'https://llm.meituan.com/v1', apiKey: 'sk-mt', apiFormat: 'openai' as const, models: ['longcat-v1'] },
      { name: '智谱A', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'sk-z', apiFormat: 'anthropic' as const, models: ['glm-x'] },
    ];
    expect(resolveModelEndpoint('longcat-v1', [], providers)).toEqual({
      baseUrl: 'https://llm.meituan.com/v1', apiKey: 'sk-mt', provider: '美团', apiFormat: 'openai',
    });
    expect(resolveModelEndpoint('glm-x', [], providers)?.apiFormat).toBe('anthropic');
    expect(resolveModelEndpoint('不存在的', [], providers)).toEqual({});
  });

  it('mergeModelOptions 把供应商名下模型并入可选项（去重、不与内置冲突）', () => {
    const providers = [{ name: '美团', models: ['longcat-v1'] }];
    const opts = mergeModelOptions([], providers);
    const hit = opts.find((o) => o.id === 'longcat-v1');
    expect(hit?.source).toBe('custom');
    expect(hit?.provider).toBe('美团');
    expect(opts.filter((o) => o.id === 'glm-5.3')).toHaveLength(1); // 内置仍在
  });
});
