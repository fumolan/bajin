import { describe, it, expect } from 'vitest';
import { exportSessionMarkdown, exportSessionHtml } from '../src/session-export.js';
import type { ChatMessage } from '@bajin/shared';

const msgs: ChatMessage[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '帮我创建一个文件' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Write', arguments: '{"file_path":"a.txt","content":"hello"}' }] },
  { role: 'tool', toolCallId: 'c1', name: 'Write', content: '写入成功' },
  { role: 'assistant', content: '文件 a.txt 已创建。' },
  { role: 'user', content: '再读一下' },
  { role: 'assistant', content: '内容是 hello。' },
];

describe('会话导出 Markdown', () => {
  it('基本结构：标题/元信息/用户/助手/工具折叠/系统省略', () => {
    const md = exportSessionMarkdown(msgs, { title: '测试会话', model: 'glm-4.7', sessionId: 'sess_test', cwd: '/tmp/x', tokens: 1234 });
    expect(md).toContain('# 测试会话');
    expect(md).toContain('glm-4.7');
    expect(md).toContain('sess_test');
    expect(md).toContain('/tmp/x');
    expect(md).toContain('## 👤 用户');
    expect(md).toContain('帮我创建一个文件');
    expect(md).toContain('## 🤖 助手');
    expect(md).toContain('文件 a.txt 已创建');
    expect(md).toContain('内容是 hello');
    // 工具调用折叠
    expect(md).toContain('<details>');
    expect(md).toContain('**Write**');
    // 系统消息不出现
    expect(md).not.toContain('系统提示');
    // tokens 尾注
    expect(md).toContain('1234 tokens');
  });

  it('空消息列表：仍输出标题与元信息', () => {
    const md = exportSessionMarkdown([], { title: '空' });
    expect(md).toContain('# 空');
    expect(md).toContain('导出时间');
  });

  it('无工具调用：不输出 details 块', () => {
    const simple: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const md = exportSessionMarkdown(simple);
    expect(md).not.toContain('<details>');
    expect(md).toContain('hi');
    expect(md).toContain('hello');
  });
});

describe('会话导出 HTML', () => {
  it('独立页面：DOCTYPE/内嵌样式/消息块/工具折叠/XSS 转义', () => {
    const html = exportSessionHtml(msgs, { title: '测试会话<script>', model: 'glm-4.7', sessionId: 'sess_test', tokens: 1234 });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');           // 样式内嵌，独立可打开
    expect(html).toContain('class="msg user"');
    expect(html).toContain('class="msg assistant"');
    expect(html).toContain('🔧 工具调用（1）');   // 工具调用折叠
    expect(html).toContain('Write');
    expect(html).not.toContain('<script>');       // 标题中的脚本被转义
    expect(html).toContain('&lt;script&gt;');
  });

  it('空会话只出页头页脚', () => {
    const html = exportSessionHtml([], { title: '空' });
    expect(html).toContain('<h1>空</h1>');
    expect(html).not.toContain('class="msg');
  });
});
