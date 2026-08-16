/**
 * MCP（Model Context Protocol）运行时 —— stdio 传输（对标 ZCode mcp__server__tool）。
 * 净室实现：按 MCP 公开协议（newline-delimited JSON-RPC 2.0 over stdio）编写，
 * 配置来源 ~/.bajin/config.json 的 mcpServers 块（与桌面端「Agent 设置 → MCP」一致）。
 *
 *   mcpServers: {
 *     weather: { type: "stdio", command: "npx", args: ["-y", "weather-server"] }
 *   }
 *
 * 工具命名：mcp__<server>__<tool>（与 ZCode 约定一致，进入审批与 hooks 的 matcher 体系）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '@bajin/shared';
function stateHome(home?: string): string {
  if (home) return path.join(home, '.bajin');
  return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/') ? process.env.BAJIN_HOME : path.join(os.homedir(), '.bajin');
}

export interface McpStdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerConfigs {
  [name: string]: { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
}

const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

/** 读取用户级 config.json 的 mcpServers（缺省空对象；桌面端写入同一路径） */
export async function loadMcpServerConfigs(home?: string): Promise<McpServerConfigs> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stateHome(home), 'config.json'), 'utf8')) as { mcpServers?: McpServerConfigs };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 单个 stdio MCP server 的客户端：spawn 子进程 + 按行 JSON-RPC */
class McpStdioClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private buffer = '';
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly cfg: McpStdioServerConfig,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (err) => this.failAll(new Error(`MCP server "${this.name}" 启动失败: ${err.message}`)));
    child.on('exit', () => {
      this.closed = true;
      this.failAll(new Error(`MCP server "${this.name}" 已退出`));
    });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => this.onChunk(d));
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bajin', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined) {
          const p = this.pending.get(Number(msg.id));
          if (p) {
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new Error(msg.error.message ?? `MCP 错误 ${msg.error.code ?? ''}`));
            else p.resolve(msg.result);
          }
        }
      } catch {
        /* 忽略无法解析的行（server 日志等） */
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private request(method: string, params: unknown, timeoutMs = INIT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.child?.stdin) return Promise.reject(new Error(`MCP server "${this.name}" 不可用`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.name}" ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const res = (await this.request('tools/list', {}, CALL_TIMEOUT_MS)) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return res?.tools ?? [];
  }

  async callTool(tool: string, args: unknown): Promise<ToolResult> {
    const res = (await this.request('tools/call', { name: tool, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res?.content ?? [])
      .map((c) => (c.type === 'text' && c.text) || '')
      .filter(Boolean)
      .join('\n') || JSON.stringify(res ?? {});
    return { ok: !res?.isError, output: text };
  }

  kill(): void {
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.name}" 已关闭`));
    this.child?.kill();
  }
}

/** JSON Schema → zod 的宽松包装：MCP 工具参数按 schema 校验交给 server 端，这里只做透传 */
function passthroughSchema(): z.ZodType {
  return z.record(z.string(), z.unknown());
}

/** 两种传输共用的客户端接口 */
interface McpClientLike {
  start(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(tool: string, args: unknown): Promise<ToolResult>;
  kill(): void;
}

export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/**
 * SSE 传输（legacy HTTP+SSE 协议，ZCode settings.mcp.form.type.sse 同款）：
 * GET {url} 订阅事件流（server 先推 endpoint 事件告知消息回传地址），
 * 请求以 POST 发到该地址，响应经事件流以 message 事件返回。
 */
class McpSseClient implements McpClientLike {
  private seq = 0;
  private closed = false;
  private postUrl = '';
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private abort: AbortController | null = null;

  constructor(
    private readonly name: string,
    private readonly cfg: McpSseServerConfig,
  ) {}

  async start(): Promise<void> {
    this.abort = new AbortController();
    const res = await fetch(this.cfg.url, {
      headers: { Accept: 'text/event-stream', ...(this.cfg.headers ?? {}) },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败 HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // 后台持续读事件流（start 只等 endpoint 到位）
    const endpointReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE 等待 endpoint 超时`)), INIT_TIMEOUT_MS);
      this.onEndpoint = () => { clearTimeout(timer); resolve(); };
      this.onEndpointFail = (e) => { clearTimeout(timer); reject(e); };
    });
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this.handleEvent(raw);
          }
        }
      } catch {
        /* 流中断 */
      }
      this.failAll(new Error(`MCP server "${this.name}" 事件流已断开`));
    })();
    await endpointReady;
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bajin', version: '0.1.0' },
    });
    void this.notify('notifications/initialized');
  }

  private onEndpoint: () => void = () => undefined;
  private onEndpointFail: (e: Error) => void = () => undefined;

  private handleEvent(raw: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (event === 'endpoint' && data) {
      this.postUrl = new URL(data, this.cfg.url).toString();
      this.onEndpoint();
      return;
    }
    if (event !== 'message' || !data) return;
    try {
      const msg = JSON.parse(data) as JsonRpcResponse;
      if (msg.id === undefined) return;
      const p = this.pending.get(Number(msg.id));
      if (p) {
        this.pending.delete(Number(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message ?? `MCP 错误 ${msg.error.code ?? ''}`));
        else p.resolve(msg.result);
      }
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.closed) return;
    this.closed = true;
    this.onEndpointFail(err);
  }

  private request(method: string, params: unknown, timeoutMs = INIT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.postUrl) return Promise.reject(new Error(`MCP server "${this.name}" 不可用`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.name}" ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      void fetch(this.postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.cfg.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }).catch((e: unknown) => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); clearTimeout(timer); p.reject(new Error(`POST 失败: ${e instanceof Error ? e.message : e}`)); }
      });
    });
  }

  private async notify(method: string): Promise<void> {
    if (!this.postUrl) return;
    await fetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).catch(() => undefined);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const res = (await this.request('tools/list', {}, CALL_TIMEOUT_MS)) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return res?.tools ?? [];
  }

  async callTool(tool: string, args: unknown): Promise<ToolResult> {
    const res = (await this.request('tools/call', { name: tool, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res?.content ?? [])
      .map((c) => (c.type === 'text' && c.text) || '')
      .filter(Boolean)
      .join('\n') || JSON.stringify(res ?? {});
    return { ok: !res?.isError, output: text };
  }

  kill(): void {
    this.failAll(new Error(`MCP server "${this.name}" 已关闭`));
    this.abort?.abort();
  }
}

export interface McpRuntime {
  tools: ToolDefinition[];
  dispose(): void;
}

/**
 * 连接配置里的全部 MCP server（stdio + sse），把工具包装成 mcp__<server>__<tool>。
 * 单个 server 失败不影响其他（记入 log）。
 */
export async function connectMcpServers(configs: McpServerConfigs, log: (msg: string) => void = console.warn): Promise<McpRuntime> {
  const clients: McpClientLike[] = [];
  const tools: ToolDefinition[] = [];
  for (const [name, cfg] of Object.entries(configs)) {
    let client: McpClientLike | null = null;
    try {
      if (cfg?.type === 'stdio' && cfg.command) {
        client = new McpStdioClient(name, cfg as McpStdioServerConfig);
      } else if (cfg?.type === 'sse' && cfg.url) {
        client = new McpSseClient(name, cfg as McpSseServerConfig);
      } else {
        continue;
      }
      await client.start();
      const list = await client.listTools();
      clients.push(client);
      for (const t of list) {
        if (!t?.name) continue;
        const fullName = `mcp__${name}__${t.name}`;
        tools.push({
          name: fullName,
          description: t.description ? `[MCP:${name}] ${t.description}`.slice(0, 1024) : `[MCP:${name}] 工具 ${t.name}`,
          inputSchema: passthroughSchema(),
          metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: CALL_TIMEOUT_MS, concurrentSafe: false },
          execute: async (input) => client!.callTool(t.name, input),
        });
      }
      log(`MCP "${name}" 已连接（${list.length} 个工具）`);
    } catch (err) {
      client?.kill();
      log(`MCP "${name}" 连接失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return {
    tools,
    dispose: () => clients.forEach((c) => c.kill()),
  };
}

/** 供测试/工具生成的稳定 id */
export function mcpRequestId(): string {
  return randomUUID();
}
