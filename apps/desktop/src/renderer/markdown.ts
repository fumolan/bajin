import { createElement, type ReactNode, useState, useCallback } from 'react';

/**
 * 迷你 markdown 渲染器（无第三方依赖，React 节点构造，天然防注入）。
 * 支持：围栏代码块（语言标签+复制）、标题、无序/有序列表、引用、分隔线、
 * 行内 code / **bold** / [text](url)（链接按纯文本展示）。
 */

function CopyButton({ code }: { code: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [code]);
  return createElement(
    'button',
    { className: 'code-copy', onClick: copy },
    copied ? '已复制' : '复制',
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 顺序解析 `code` → **bold** → [t](u)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(createElement('code', { key, className: 'inline-code' }, tok.slice(1, -1)));
    } else if (tok.startsWith('**')) {
      out.push(createElement('strong', { key }, tok.slice(2, -2)));
    } else {
      const label = tok.slice(1, tok.indexOf(']'));
      out.push(createElement('span', { key, className: 'link-text', title: '链接' }, label));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 围栏代码块
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) buf.push(lines[i]!);
      i++; // 跳过结束 ```
      const code = buf.join('\n');
      blocks.push(
        createElement(
          'div',
          { className: 'codeblock', key: key++ },
          createElement('div', { className: 'codeblock-head' }, createElement('span', null, lang || 'text'), createElement(CopyButton, { code })),
          createElement('pre', null, createElement('code', null, code)),
        ),
      );
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const tag = `h${Math.min(h[1]!.length + 1, 5)}` as 'h2' | 'h3' | 'h4' | 'h5';
      blocks.push(createElement(tag, { key: key++ }, inline(h[2]!, `h${key}`)));
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(createElement('hr', { key: key++ }));
      i++;
      continue;
    }

    // 引用
    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        buf.push(lines[i]!.trimStart().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(createElement('blockquote', { key: key++ }, inline(buf.join(' '), `q${key}`)));
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        createElement(
          'ul',
          { key: key++ },
          items.map((t, j) => createElement('li', { key: j }, inline(t, `ul${key}-${j}`))),
        ),
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push(
        createElement(
          'ol',
          { key: key++ },
          items.map((t, j) => createElement('li', { key: j }, inline(t, `ol${key}-${j}`))),
        ),
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落（吃到空行/块级开头）
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith('>')
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(createElement('p', { key: key++ }, inline(buf.join('\n'), `p${key}`)));
  }
  return blocks;
}
