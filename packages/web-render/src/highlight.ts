/**
 * 轻量语法着色（编辑器 overlay 用，零依赖，不引 CodeMirror）。
 * 输出安全 HTML：先整体 escape，再按 token 包 span。
 * 支持 TypeScript/JavaScript、JSON、Markdown；其余语言按 TS 近似处理。
 */

const TS_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'new', 'null', 'number', 'object',
  'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static',
  'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'unique', 'unknown', 'var', 'void', 'while', 'yield',
]);

export type HighlightLang = 'ts' | 'json' | 'md' | 'text';

/** 按扩展名猜语言 */
export function langFromPath(path: string): HighlightLang {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cts', 'mts'].includes(ext)) return 'ts';
  return 'text';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls: string, s: string): string {
  return `<span class="hl-${cls}">${esc(s)}</span>`;
}

/** TS/JS：注释 / 字符串 / 关键字 / 数字，一遍正则扫描 */
function highlightTs(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const rest = code.slice(i);
    // 行注释 / 块注释
    let m = /^\/\/[^\n]*/.exec(rest) ?? /^\/\*[\s\S]*?(\*\/|$)/.exec(rest);
    if (m) { out += span('comment', m[0]); i += m[0].length; continue; }
    // 三种字符串 + 模板串（模板内表达式不再递归，够用）
    m = /^"(?:[^"\\\n]|\\.)*"?/.exec(rest) ?? /^'(?:[^'\\\n]|\\.)*'?/.exec(rest) ?? /^`(?:[^`\\]|\\.)*`?/.exec(rest);
    if (m) { out += span('string', m[0]); i += m[0].length; continue; }
    // 数字
    m = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (m) { out += span('num', m[0]); i += m[0].length; continue; }
    // 标识符（关键字 vs 普通词）
    m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (m) {
      out += TS_KEYWORDS.has(m[0]) ? span('kw', m[0]) : esc(m[0]);
      i += m[0].length; continue;
    }
    out += esc(code[i] ?? '');
    i += 1;
  }
  return out;
}

/** JSON：行内只有 字符串(键/值) / 数字 / 字面量 / 标点，键着色靠"后面紧跟冒号"判定 */
function highlightJson(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const rest = code.slice(i);
    let m = /^"(?:[^"\\\n]|\\.)*"?/.exec(rest);
    if (m) {
      const after = rest.slice(m[0].length).match(/^\s*:/);
      out += span(after ? 'key' : 'string', m[0]);
      i += m[0].length; continue;
    }
    m = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (m) { out += span('num', m[0]); i += m[0].length; continue; }
    m = /^(true|false|null)/.exec(rest);
    if (m) { out += span('kw', m[0]); i += m[0].length; continue; }
    out += esc(code[i] ?? '');
    i += 1;
  }
  return out;
}

/** Markdown：行级规则（标题/引用/代码块/列表）+ 行内（粗体/行内码/链接） */
function highlightMd(code: string): string {
  const inFence: Array<string> = [];
  return code.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inFence.length) { inFence.pop(); return span('comment', line); }
      inFence.push('```'); return span('comment', line);
    }
    if (inFence.length) return span('string', line);
    if (/^#{1,6}\s/.test(line)) return span('kw', line);
    if (/^\s*>/.test(line)) return span('comment', line);
    // 行内：`code`、**bold**、[text](url)
    let out = '';
    let rest = line;
    for (;;) {
      const m = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/.exec(rest);
      if (!m || m.index === undefined) break;
      out += esc(rest.slice(0, m.index));
      const t = m[0];
      out += t.startsWith('`') ? span('string', t) : span('key', t);
      rest = rest.slice(m.index + t.length);
    }
    return out + esc(rest);
  }).join('\n');
}

/** 入口：转安全高亮 HTML（编辑器 overlay 直接 innerHTML） */
export function highlightCode(code: string, lang: HighlightLang): string {
  switch (lang) {
    case 'json': return highlightJson(code);
    case 'md': return highlightMd(code);
    case 'ts': return highlightTs(code);
    default: return esc(code);
  }
}
