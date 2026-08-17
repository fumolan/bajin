import { describe, it, expect } from 'vitest';
import { preciseTokenCount, estimateCost, MODEL_PRICING, estimateTokens } from '../src/prompt.js';

describe('精确 token 计数', () => {
  it('纯中文：~1.5 token/字', () => {
    const text = '你好世界这是测试文本'; // 10 个汉字
    const tokens = preciseTokenCount(text);
    expect(tokens).toBeGreaterThanOrEqual(13); // 10 * 1.3
    expect(tokens).toBeLessThanOrEqual(18);   // 10 * 1.8
  });

  it('纯英文：~1.3 token/词', () => {
    const text = 'hello world this is a test'; // 6 词
    const tokens = preciseTokenCount(text);
    expect(tokens).toBeGreaterThanOrEqual(5);  // 6 * 0.8 (词 + 空格)
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it('中英混排：合理范围内', () => {
    const text = '请 read this 文件 and 返回结果'; // 6 汉字 + 4 英文词 + 空格
    const tokens = preciseTokenCount(text);
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(25);
  });

  it('空串/纯标点', () => {
    expect(preciseTokenCount('')).toBe(0);
    expect(preciseTokenCount('！？。')).toBeGreaterThan(0);
  });

  it('estimateTokens 委托到 preciseTokenCount', () => {
    expect(estimateTokens('你好')).toBe(preciseTokenCount('你好'));
  });

  it('JSON 代码文本不炸', () => {
    const json = '{"name":"test","value":123,"nested":{"a":[1,2,3]}}';
    expect(preciseTokenCount(json)).toBeGreaterThan(5);
  });
});

describe('成本估算', () => {
  it('已知模型有定价', () => {
    expect(MODEL_PRICING['glm-4.7']).toEqual({ input: 2, output: 8 });
    expect(MODEL_PRICING['glm-4.7-flash']).toEqual({ input: 0.5, output: 2 });
  });

  it('成本计算', () => {
    // 100k input + 10k output @ glm-4.7 ($2/M in, $8/M out)
    expect(estimateCost(100_000, 10_000, 'glm-4.7')).toBeCloseTo(0.2 + 0.08, 4);
  });

  it('未知模型用默认价', () => {
    expect(estimateCost(1000, 1000, 'unknown-model')).toBeGreaterThan(0);
  });
});
