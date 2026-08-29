import { describe, it, expect } from 'vitest';
import { taskIcon } from '../src/task-icon.js';

describe('任务图标推断（R9-1）', () => {
  it('命中关键词映射', () => {
    expect(taskIcon('修复登录 bug')).toBe('🐛');
    expect(taskIcon('帮我写个ppt 介绍产品')).toBe('📊');
    expect(taskIcon('股票大盘分析')).toBe('📈');
    expect(taskIcon('部署到 k8s 集群')).toBe('🚀');
    expect(taskIcon('写小说第三章')).toBe('✍️');
  });

  it('未命中给稳定默认：同标题恒定、不同标题可能不同', () => {
    const a = taskIcon('随便做点什么甲');
    expect(taskIcon('随便做点什么甲')).toBe(a); // 稳定
    expect(['💬', '🗂️', '📌', '🧩', '🛠️', '📦', '🔭', '🪄']).toContain(a);
  });

  it('空标题安全', () => {
    expect(taskIcon('')).toBe('💬');
    expect(taskIcon('   ')).toBe('💬');
  });
});
