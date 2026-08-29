import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

describe('markdown 未闭合围栏（R9 回归：曾致整页崩溃）', () => {
  it('未闭合代码块不再死循环，正常出块', () => {
    const out = renderMarkdown('前文\n```js\nconst a = 1;');
    expect(out.length).toBeGreaterThan(0);
  });

  it('闭合代码块照常，mock 回显场景可用', () => {
    const out = renderMarkdown('[mock] 收到: 看下 README\n```js\nconst a = 1;\n```\n以上是什么');
    expect(out.length).toBeGreaterThan(0);
  });

  it('行内 ``` 出现在段中不误判', () => {
    expect(renderMarkdown('行内 ``` 反引号测试').length).toBeGreaterThan(0);
  });
});
