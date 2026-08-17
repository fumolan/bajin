# bajin 设计文档

> 净室复刻 ZCode v3.7.7 的编码代理——本文档描述系统架构、模块设计、数据流与扩展点。

## 目录

1. [系统概览](#1-系统概览)
2. [Monorepo 结构](#2-monorepo-结构)
3. [Agent 内核](#3-agent-内核)
4. [模型 Provider 层](#4-模型-provider-层)
5. [工具系统](#5-工具系统)
6. [会话持久化](#6-会话持久化)
7. [配置体系](#7-配置体系)
8. [扩展机制](#8-扩展机制)
9. [桌面端架构](#9-桌面端架构)
10. [CLI 入口](#10-cli-入口)

---

## 1. 系统概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron 桌面端                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ 侧栏     │  │ 对话区   │  │ 设置页   │  │ 终端/浏览器/  │  │
│  │ 任务列表 │  │ 消息流   │  │ 8 分区   │  │ 文件树面板    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │             │                 │           │
│  ─────┴──────────────┴───── IPC ───┴─────────────────┴─────   │
│                           │                                     │
│  ┌────────────────────────┴────────────────────────────────┐  │
│  │              Main Process (主进程)                       │  │
│  │  BrowserWindow · IPC Handlers · 系统通知 · Shell        │  │
│  │  AppServerClient (spawn CLI 子进程)                     │  │
│  └────────────────────────┬────────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────────┘
                            │ stdio (JSON-RPC)
┌───────────────────────────┼─────────────────────────────────────┐
│              CLI 子进程    │                                     │
│  ┌────────────────────────┴────────────────────────────────┐  │
│  │              AppServer (app-server --stdio)              │  │
│  │  会话管理 · RPC 路由 · 调度器 · SQLite                    │  │
│  └────────────────────────┬────────────────────────────────┘  │
│                           │                                     │
│  ┌────────────────────────┴────────────────────────────────┐  │
│  │                    Agent 内核                            │  │
│  │  消息循环 · 工具执行 · 权限策略 · Hooks · System Prompt   │  │
│  └────────────────────────┬────────────────────────────────┘  │
│                           │                                     │
│  ┌────────────┐  ┌───────┴────┐  ┌──────────┐  ┌──────────┐ │
│  │ GLM        │  │ Anthropic  │  │ 内置工具 │  │ MCP      │ │
│  │ Provider   │  │ Provider   │  │ (23 个)  │  │ Servers  │ │
│  └────────────┘  └────────────┘  └──────────┘  └──────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 核心分层

| 层 | 包 | 职责 |
|---|---|---|
| 共享类型 | `@bajin/shared` | ToolDefinition/ChatMessage/ToolCall 等接口 |
| Agent 内核 | `@bajin/core` | 消息循环/工具/持久化/Hooks/MCP/技能/子代理 |
| CLI | `@bajin/cli` | REPL/headless/app-server 三入口 + RPC 路由 |
| 桌面端 | `apps/desktop` | Electron 主进程 + 渲染层 UI |

---

## 2. Monorepo 结构

```
bajin/
├── packages/
│   ├── shared/           # 共享类型定义（零依赖）
│   │   └── src/index.ts  # ToolDefinition · ChatMessage · ToolResult · ...
│   │
│   ├── core/             # Agent 内核（依赖 shared）
│   │   └── src/
│   │       ├── agent.ts          # Agent 类：消息循环/工具编排/上下文管理
│   │       ├── permissions.ts    # PermissionPolicy：四级权限模式 + 白名单
│   │       ├── prompt.ts         # buildSystemPrompt：动态系统提示组装
│   │       ├── diff.ts           # unifiedDiff：LCS 行级 diff
│   │       ├── session.ts        # JSONL transcript 持久化 + rewind
│   │       ├── session-store.ts  # SQLite 五表存储（node:sqlite）
│   │       ├── session-export.ts # 会话导出 Markdown
│   │       ├── hooks.ts          # HookRunner：7 事件生命周期钩子
│   │       ├── commands.ts       # 自定义 slash 命令发现与展开
│   │       ├── skills.ts         # 技能发现（SKILL.md frontmatter）
│   │       ├── subagents.ts      # 自定义子代理定义（.bajin/agents/*.md）
│   │       ├── memory.ts         # 长期记忆（两级 MEMORY.md）
│   │       ├── plugins.ts        # 插件发现/启停/安装
│   │       ├── mcp.ts            # MCP 客户端（stdio + sse）
│   │       ├── automations.ts    # 定时任务存储与创建
│   │       ├── background.ts     # 后台任务管理器
│   │       ├── settings.ts       # 设置作用域链合并
│   │       ├── models.ts         # 模型/供应商配置管理
│   │       ├── cron.ts           # cron 表达式解析（5 字段）
│   │       ├── providers/
│   │       │   ├── glm.ts        # OpenAI 兼容 chat/completions + SSE
│   │       │   ├── anthropic.ts  # Anthropic Messages 协议 + SSE
│   │       │   └── mock.ts       # 测试用 mock provider
│   │       └── tools/
│   │           ├── index.ts      # builtinTools 注册表
│   │           ├── fs.ts         # Read / Write / Edit
│   │           ├── exec.ts       # Bash（含 run_in_background）
│   │           ├── search.ts     # Glob / Grep
│   │           ├── interaction.ts# TodoWrite / AskUserQuestion
│   │           ├── plan.ts       # EnterPlanMode / ExitPlanMode
│   │           ├── skill.ts      # Skill 加载
│   │           ├── subagent.ts   # Agent 子代理派生
│   │           ├── web.ts        # WebSearch / WebFetch
│   │           ├── tasks.ts      # TaskOutput / TaskStop
│   │           ├── cron.ts       # CronCreate/Update/Delete/List
│   │           ├── worktree.ts   # EnterWorktree / ExitWorktree
│   │           ├── browser.ts    # BrowserNavigate / BrowserContent
│   │           ├── image.ts      # 图片头解析（PNG/GIF/JPEG/WEBP）
│   │           └── diagnostics.ts# TypeScript 类型检查
│   │
│   └── cli/              # CLI 入口（依赖 core）
│       └── src/
│           ├── main.ts          # 入口：参数解析 + 子命令路由
│           ├── repl.ts          # 交互式 REPL
│           ├── headless.ts      # -p 单次执行
│           ├── app-server.ts    # JSON-RPC over stdio（桌面端后端）
│           ├── config.ts        # 配置加载（settings 作用域链）
│           └── automations.ts   # re-export from core
│
├── apps/
│   └── desktop/          # Electron 桌面端
│       └── src/
│           ├── main/            # 主进程
│           │   ├── index.ts     # BrowserWindow + IPC + agent 子进程
│           │   └── app-server-client.ts  # JSON-RPC 客户端
│           ├── preload/index.ts # contextBridge API
│           └── renderer/
│               ├── app.tsx      # React 主组件（~3500 行）
│               └── styles.css   # 主题 CSS（暗色/浅色）
│
├── scripts/
│   └── package.sh        # 一键打包（测试 → bundle → AppImage → 冒烟）
│
└── docs/
    ├── DESIGN.md         # 本文档
    └── DEVELOPMENT.md    # 开发指南
```

---

## 3. Agent 内核

### 3.1 消息循环

```typescript
// agent.ts 核心循环（简化）
async run(userInput: string): Promise<AgentResult> {
  this.messages.push({ role: 'user', content: userInput });
  this.persist({ role: 'user', content: userInput });

  for (let i = 0; i < this.maxIterations; i++) {
    // 1. 组装动态 system prompt
    this.refreshSystem();

    // 2. 调用模型
    const res = await this.provider.chat({ messages, tools: this.toolset() });
    this.rollout(res); // 记录模型 IO

    // 3. 无工具调用 → 返回最终文本
    if (!res.toolCalls?.length) {
      this.messages.push(res.message);
      return { text: res.message.content };
    }

    // 4. 有工具调用 → 执行
    this.messages.push(res.message); // assistant with toolCalls

    // 并行安全工具分组并发执行
    const groups = groupToolCalls(res.toolCalls, lookup);
    for (const group of groups) {
      if (group.length > 1 && group.every(t => t.metadata.concurrentSafe)) {
        await Promise.all(group.map(c => this.runTool(c)));  // 并行
      } else {
        for (const c of group) await this.runTool(c);          // 串行
      }
    }

    // 5. 自动压缩检查
    this.maybeAutoCompact();
  }
}
```

### 3.2 权限策略

```
PermissionPolicy
├── mode: 'plan' | 'build' | 'edit' | 'yolo'
│   ├── plan  → 只读工具放行，Write/Edit/Bash 拒绝
│   ├── build → 只读放行，Write/Edit/Bash 需审批（默认）
│   ├── edit  → 只读+Write/Edit 放行，Bash 需审批
│   └── yolo  → 全部放行
├── allowedTools: Set<string>    # 白名单（优先于模式）
├── disallowedTools: Set<string> # 黑名单（最高优先）
└── decide(tool): 'allow' | 'deny' | 'ask'
```

### 3.3 动态 System Prompt

每轮重组装（`refreshSystem()`），包含：

1. 角色定义 + 工具使用教练 + 沟通风格
2. 环境（cwd/platform/date/mode）
3. 当前 Todo 清单
4. Skills 清单（名称+描述）
5. AGENTS.md 注入（用户级 ~/.bajin/AGENTS.md + 项目级 .bajin/AGENTS.md）
6. 长期记忆（用户级 + 项目级 MEMORY.md）
7. 计划模式说明（进入 plan 模式时）

---

## 4. 模型 Provider 层

### 接口

```typescript
interface ModelProvider {
  id: string;
  defaultModel: string;
  chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse>;
}
```

### 双协议支持

| Provider | 协议 | 端点 | 认证 | 流式 |
|---|---|---|---|---|
| GLM | OpenAI chat/completions | `{baseUrl}/chat/completions` | `Bearer {key}` | SSE |
| Anthropic | Anthropic Messages | `{baseUrl}/v1/messages` | `x-api-key` | SSE |
| Mock | 本地 | — | — | 同步 |

### Provider 选择链

```
resolveModelEndpoint(modelId, customModels, providers)
├── 1. 模型自带 baseUrl/apiKey（自定义模型）
├── 2. 挂靠供应商的 baseUrl/apiKey/apiFormat
└── 3. 内置 GLM（返回空 → 用全局 key + 默认端点）
```

---

## 5. 工具系统

### ToolDefinition 接口

```typescript
interface ToolDefinition {
  name: string;                    // 工具名（如 "Read"、"mcp__server__tool"）
  description: string;             // 给模型看的说明
  inputSchema: z.ZodType;          // zod schema（自动转 JSON Schema 给模型）
  metadata: {
    readOnly: boolean;             // 只读工具免审批
    riskLevel: 'low' | 'medium' | 'high';
    timeoutMs?: number;            // 执行超时
    concurrentSafe?: boolean;      // 可与其他工具并行
  };
  execute(input, ctx): Promise<ToolResult>;
}
```

### 工具目录（23 个内置）

| 类别 | 工具 | 说明 |
|---|---|---|
| 文件 | Read, Write, Edit | 读/写/编辑（Edit 返回 diff） |
| 执行 | Bash | shell 命令（支持 run_in_background） |
| 搜索 | Glob, Grep | 文件名 glob / 内容正则 |
| 交互 | TodoWrite, AskUserQuestion | 任务清单 / 用户提问（multiSelect） |
| 计划 | EnterPlanMode, ExitPlanMode | 只读调研→提交计划→审批 |
| 代理 | Agent, Skill | 子代理派生 / 技能加载 |
| Web | WebSearch, WebFetch | DuckDuckGo 搜索 / URL 抓取 |
| 后台 | TaskOutput, TaskStop | 后台任务输出/终止 |
| 定时 | CronCreate/Update/Delete/List | 定时任务 CRUD |
| Git | EnterWorktree, ExitWorktree | git worktree 隔离实验 |
| 浏览器 | BrowserNavigate, BrowserContent | 浏览器面板控制 |
| 诊断 | Diagnostics | TypeScript 类型检查 |
| 记忆 | Memory | 长期偏好/事实读写 |

### MCP 工具

MCP 服务器的工具以 `mcp__<server>__<tool>` 命名，与内置工具统一进权限/审批体系。

---

## 6. 会话持久化

### 双写架构（JSONL + SQLite 过渡期）

```
Agent.persist(message)
├── JSONL: ~/.bajin/sessions/<id>/transcript.jsonl  （主读路径）
└── SQLite: ~/.bajin/sessions.db                     （双写 + 容灾）
```

### SQLite 五表

```sql
session    (id, model, cwd, created_at, title, "group", pinned, modified_at)
message    (id, session_id, ts, role, content)  -- content = JSON
part       (id, message_id, kind, name, text)   -- toolCall / toolResult 拆分
todo       (id, session_id, content, created_at) -- todo 快照全量替换
tool_usage (id, session_id, name, ok, created_at) -- 工具调用统计
```

### 恢复链路

```
session/open → storeLoadTranscript (SQLite)
             → 有消息？→ resumeFromMessages
             → 无/损坏？→ loadTranscript (JSONL) → resumeFrom
```

---

## 7. 配置体系

### Settings 作用域链

```
System（内置默认）
  < User（~/.bajin/config.json）
  < Project（bajin.json / .bajin/config.json，自 cwd 向上到 .git 根）
  < Env（BAJIN_MODEL / BAJIN_MODE / ...）
  < CLI 旗标（--model / --mode）
```

### config.json 结构

```json
{
  "model": "glm-4.7",
  "mode": "build",
  "bigmodel": { "apiKey": "...", "baseUrl": "..." },
  "providers": [
    { "name": "智谱", "baseUrl": "...", "apiKey": "...", "apiFormat": "openai", "models": [...] }
  ],
  "hooks": { "enabled": true, "events": { "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }] } },
  "mcpServers": { "weather": { "type": "stdio", "command": "npx", "args": [...] } },
  "skillsDisabled": ["skill-name"],
  "settings": { "theme": "dark", "notificationEnabled": true, ... }
}
```

---

## 8. 扩展机制

### 8.1 自定义 Slash 命令

```
~/.bajin/commands/deploy.md       （用户级）
<cwd>/.bajin/commands/deploy.md   （项目级，优先）
<cwd>/.agents/commands/deploy.md  （双前缀兼容）
```

```markdown
---
description: 部署到生产环境
model: glm-4.7-flash
allowed-tools: Bash, Read
skills: deploy-guide
---
执行部署：按以下步骤...
$ARGUMENTS
```

### 8.2 技能（Skills）

```
~/.bajin/skills/<name>/SKILL.md   （用户级）
<cwd>/.bajin/skills/<name>/SKILL.md（项目级，优先）
```

```markdown
---
name: code-review
description: 代码评审专用技能
---
评审要点：正确性、边界...
```

### 8.3 子代理（Subagents）

```
~/.bajin/agents/<name>.md
```

```markdown
---
name: reviewer
description: 代码评审
tools: Read, Grep, Glob
---
评审规则...
```

### 8.4 插件（Plugins）

```
~/.bajin/plugins/<name>/
├── plugin.json       # { name, description, version, enabled }
├── skills/           # 提供技能
└── commands/         # 提供命令
```

### 8.5 Hooks（生命周期钩子）

7 个事件：`SessionStart` `UserPromptSubmit` `PreToolUse` `PermissionRequest` `PostToolUse` `PostToolUseFailure` `Stop`

### 8.6 MCP 服务器

```json
{ "mcpServers": { "weather": { "type": "stdio", "command": "npx", "args": ["-y", "weather-server"] } } }
```

---

## 9. 桌面端架构

### 9.1 IPC 通信

```
渲染层 ←→ preload (contextBridge) ←→ 主进程 ←→ CLI 子进程 (stdio)
```

### 9.2 渲染层组件树

```
App
├── Sidebar
│   ├── TaskFilter（搜索框）
│   ├── SideMenu（新建/搜索/自动化/技能/知识图谱）
│   ├── TaskViewOptions（分组/项目 tab + ▾ 菜单）
│   ├── TaskList（项目卡片 or 分组列表）
│   │   └── TaskListItem（⋯ 菜单 14 项）
│   └── SideFoot（tokens + build tag + ⚙）
│
├── Main
│   ├── Topbar（工作区 chip + 标签 + ⌗终端 ▤面板 🗂文件树 🌐浏览器）
│   ├── ChatRow
│   │   ├── Log（消息流：用户/助手/工具卡/思考块）
│   │   └── StatusPanel（目标/计划/进程/会话）
│   ├── FileTreePanel / BrowserPanel / TerminalPanel
│   └── Composer（输入卡：工作区 chip + textarea + 模式菜单 + 模型 + ↑）
│
└── SettingsView（侧栏替换模式：← 返回 + 8 分区）
    ├── 基础：常规 / 外观（暗浅主题）/ 模型设置 / 浏览器
    ├── Agent：记忆 / 插件 / 技能 / 子代理 / 自动化 / MCP / 命令 / 钩子
    └── 数据：使用统计 / 日志 / 帮助
```

### 9.3 主题系统

CSS 变量双主题（`[data-theme='dark']` / `[data-theme='light']`），22 个变量覆盖全站。标题栏 overlay 颜色随主题联动。

---

## 10. CLI 入口

| 入口 | 命令 | 用途 |
|---|---|---|
| REPL | `bajin` | 交互式终端 |
| Headless | `bajin -p "任务"` | 单次执行后退出 |
| App Server | `bajin app-server --stdio` | 桌面端后端（JSON-RPC） |
| Migrate | `bajin migrate [--db f]` | JSONL→SQLite 迁移 |
| Export | `bajin export <id> [--out f]` | 会话导出 Markdown |
| Rewind | `bajin --rewind <n> -c` | 回退最近 N 轮 |
