# bajin 设计文档

> 净室复刻的迷你编码代理（学习项目）——对标 ZCode 桌面端架构设计文档实现，代码全部自写。

---

## 1. 概述与目标

### 1.1 定位

bajin 是一个本地运行的交互式编码代理，采用 **"CLI 内核 + 桌面壳"** 的分层架构。CLI 提供完整的 agent 能力（REPL / headless / stdio 服务），桌面端（Electron）作为壳把同一套内核以 GUI 暴露给用户。两者通过按行分隔的 JSON-RPC 协议通信，**agent 能力不重复实现**。

### 1.2 设计目标

- **净室实现**：只参考 ZCode 的行为与接口（设计文档 + 参考/ 源码快照），绝不复制其代码文本
- **单文件 bundle**：CLI 可打包为 < 1MB 的 `bajin.cjs`，由 Electron 自带 node 运行时以 `ELECTRON_RUN_AS_NODE=1` 拉起
- **多入口复用**：同一套 agent 内核支撑 REPL、headless、桌面端三种入口
- **可测试**：核心逻辑单测覆盖，mock provider 支持无 key 冒烟

### 1.3 完成标准

1. 功能面：追平 ZCode v3.7.7 的核心能力
2. 测试：≥ 150 项且全绿
3. 内核：单文件 bundle < 1MB，CLI 冒烟通过
4. 桌面：AppImage 打包通过，打包态 app-server 协议冒烟通过
5. 文档：README / 设计文档 / GAP-TRACKER 与实际功能一致

---

## 2. 仓库结构

```
bajin/
├── packages/
│   ├── shared/        # 类型契约（zod schema → JSON Schema）
│   │   └── src/index.ts
│   ├── core/          # agent 内核（循环、provider、工具、权限、hooks、skills、commands）
│   │   └── src/
│   │       ├── agent.ts          # 主循环
│   │       ├── prompt.ts         # 动态 system prompt 组装
│   │       ├── permissions.ts    # 四档权限策略
│   │       ├── diff.ts           # LCS 行级 unified diff
│   │       ├── session.ts        # JSONL 持久化
│   │       ├── hooks.ts          # 7 事件钩子系统
│   │       ├── commands.ts       # 自定义 slash commands
│   │       ├── skills.ts         # 技能发现与加载
│   │       ├── cron.ts           # 5 字段 cron 调度
│   │       ├── models.ts         # 模型目录与供应商管理
│   │       ├── providers/        # GLM / Anthropic / Mock
│   │       └── tools/            # 8 内置工具 + 计划模式 + Skill + 子代理
│   └── cli/           # 命令行入口（REPL / headless / app-server / bundle）
│       └── src/
│           ├── main.ts           # 入口路由
│           ├── repl.ts           # 交互式 REPL
│           ├── headless.ts       # -p 单次执行
│           ├── app-server.ts     # 桌面端后端（多会话 JSON-RPC）
│           ├── automations.ts    # 自动化存储
│           ├── config.ts         # 配置发现
│           └── ui.ts             # 终端 UI 辅助
├── apps/
│   └── desktop/       # Electron 壳
│       └── src/
│           ├── main/             # 主进程（子进程管理 + IPC）
│           │   ├── index.ts
│           │   └── app-server-client.ts
│           ├── preload/          # 上下文隔离桥
│           │   └── index.ts
│           └── renderer/         # React 聊天 UI
│               ├── app.tsx
│               ├── markdown.ts
│               ├── index.html
│               └── styles.css
├── scripts/           # 构建脚本
├── package.json       # pnpm workspace 根
└── pnpm-workspace.yaml
```

构建顺序：`shared → core → cli → desktop`（依赖关系决定）。

---

## 3. 核心架构

### 3.1 Agent 循环（`core/src/agent.ts`）

Agent 是整个系统的心脏，负责：

1. **接收用户输入** → 触发 `UserPromptSubmit` 钩子（可注入上下文或阻止）
2. **组装 system prompt**（动态，每轮回注 todo 状态、skills 清单、AGENTS.md）
3. **调用模型**（流式，事件回调：`text-delta` / `reasoning-delta` / `tool-call-start/end` / `usage`）
4. **处理工具调用**：
   - 按 `concurrentSafe` 分组（连续只读调用并发，副作用调用串行）
   - 每组先过权限门（`gate`）→ 再走钩子（`PreToolUse` → `PermissionRequest`）→ 再走用户审批
   - 结果按调用顺序回注到消息列表
5. **无工具调用时**：触发 `Stop` 钩子（可请求续跑，最多 3 次）→ 返回结果
6. **循环**直到无工具调用或达到 `maxIterations`（默认 40）

关键设计：
- **动态 system prompt**：`refreshSystem()` 每轮重建，保证 todo 状态实时回注
- **并行工具执行**：`groupToolCalls()` 把连续 `concurrentSafe` 调用并入同组并发
- **权限门 + 钩子链**：`gate()` → `PreToolUse` → `PermissionRequest` → 用户审批，层层递进
- **abort 中断**：`cancelRequested` 标志 + `AbortController` 中止模型调用
- **自动压缩**：上下文超 220k 字符时自动触发 `compact()`（摘要 + 保留最近两轮）

### 3.2 工具体系

#### 3.2.1 内置工具（8 个）

| 工具 | 职责 | 元数据 |
|---|---|---|
| `Read` | 读取文件（带行号，支持 offset/limit） | readOnly, concurrentSafe |
| `Write` | 整体覆盖写入 | — |
| `Edit` | 精确字符串替换（返回 unified diff） | — |
| `Bash` | 执行 shell 命令（跨平台） | — |
| `Glob` | 文件模式匹配 | readOnly, concurrentSafe |
| `Grep` | 正则搜索 | readOnly, concurrentSafe |
| `TodoWrite` | 维护会话级 todo 清单 | — |
| `AskUserQuestion` | 向用户提问（选项 + 自由输入） | — |

#### 3.2.2 动态工具

| 工具 | 来源 | 说明 |
|---|---|---|
| `EnterPlanMode` / `ExitPlanMode` | `tools/plan.ts` | 计划模式工作流（只读调研 → 提交计划 → 审批 → 切 build） |
| `Skill` | `tools/skill.ts` | 加载技能（SKILL.md）到上下文 |
| `Agent` | `tools/subagent.ts` | 派发子代理（Explore 只读 / general-purpose 可写） |

#### 3.2.3 工具元数据

```typescript
interface ToolMetadata {
  readOnly: boolean;        // 只读工具任何模式放行
  riskLevel: 'low' | 'medium' | 'high';
  timeoutMs?: number;       // 执行超时（默认 120s）
  concurrentSafe?: boolean; // 可并发（Read/Glob/Grep 等）
}
```

### 3.3 权限模型（四档）

| 模式 | 只读工具 | Write/Edit | Bash |
|---|---|---|---|
| `plan` | 放行 | 拒绝 | 拒绝 |
| `build`（默认） | 放行 | 需批准 | 需批准 |
| `edit` | 放行 | 放行 | 需批准 |
| `yolo` | 放行 | 放行 | 放行 |

**优先级**：`allowedTools` / `disallowedTools` 显式名单优先于模式。

**PermissionPolicy 决策链**：
1. `disallowed` 命中 → 拒绝
2. `allowed` 命中 → 放行
3. `readOnly` 工具 → 放行
4. 按模式判定（见上表）

**动态调整**：`allowTool()` / `disallowTool()` 原地生效，进行中的循环同样感知。

### 3.4 动态 System Prompt（`core/src/prompt.ts`）

每轮重组装，包含以下板块：

1. **身份定义**：`You are bajin, an interactive coding agent...`
2. **环境块**：cwd / platform / 日期 / 模式说明 / 计划模式状态
3. **指令文件**：用户级 `~/.bajin/AGENTS.md` → 项目级 `AGENTS.md`（均存在时项目级优先）
4. **工作流**：6 步方法论（先调研后行动、Read before Edit、小步验证、并行安全、委托深搜、维护 todo）
5. **工具教练**：Read / Edit / Bash / Grep / AskUserQuestion 使用要点
6. **沟通风格**：结论先行、不机械复述、引用 `file:line`、只做被要求的事
7. **动态状态回注**：todo 清单（实时）、skills 清单（预算 2400 字符）

### 3.5 会话持久化（`core/src/session.ts`）

```
~/.bajin/sessions/<sessionId>/
├── meta.json           # 会话元信息（sessionId, model, cwd, createdAt, title, pinned, group）
└── transcript.jsonl    # 消息事件流（含压缩标记 <<<compacted ...>>>）
```

- **写入**：`appendMessage()` 按行追加 JSON
- **加载**：`loadTranscript()` 解析 JSONL，遇到压缩标记清空旧消息
- **列表**：`listSessions()` 按最近修改排序，title 取首条用户消息
- **恢复**：`--continue`（最近） / `--resume <id>`（前缀匹配）

### 3.6 Hooks 系统（`core/src/hooks.ts`）

对标 ZCode/Claude Code 的 7 事件钩子：

| 事件 | 触发点 | 匹配值 |
|---|---|---|
| `SessionStart` | 会话启动/恢复/清空/压缩 | startup / resume / clear / compact |
| `UserPromptSubmit` | 用户提交前 | prompt 文本 |
| `PreToolUse` | 工具执行前 | 工具名（别名 Task↔Agent、ApplyPatch→Write/Edit） |
| `PermissionRequest` | 权限审批前 | 工具名 |
| `PostToolUse` | 工具执行后 | 工具名 |
| `PostToolUseFailure` | 工具失败后 | 工具名 |
| `Stop` | 无工具调用时 | 回复预览 |

**钩子类型**：
- `command`：shell 字符串，timeout 单位秒
- `process`：argv 免 shell，timeoutMs 毫秒

**输出协议**：
- stdin 收 JSON 事件载荷
- stdout 严格 JSON：`decision(allow|ask|deny)` / `reason` / `additionalContext` / `continue` / `stopReason`
- 退出码：0=通过，2=阻止，其他=错误（仅记录）

**配置发现**：用户 `~/.bajin/config.json` + 工作区 `.bajin/config.json`（cwd 向上到 .git 根），`enabled:true` 任一为 true 即启用。

### 3.7 自定义 Slash Commands（`core/src/commands.ts`）

发现顺序（对标 ZCode）：
1. 用户级：`~/.bajin/commands/`
2. 工作区：`.bajin/commands/`（cwd 向上到 .git 根每级扫描，靠近 cwd 优先）

命名规则：
- 文件名即命令名（`^[a-z0-9][a-z0-9_:-]{0,63}$`）
- 嵌套目录冒号命名（`review/code.md` → `/review:code`）

frontmatter（flat，顶层单行）：
- `description` / `argument-hint` / `allowed-tools` / `model` / `skills`

展开：
- `$ARGUMENTS` / `$1..$9`（越界空串）
- 有参数无占位符追加「User arguments:」
- `` !` `` 动态 shell 拒绝

### 3.8 技能系统（`core/src/skills.ts`）

发现顺序同 commands：
- 用户级：`~/.bajin/skills/<name>/SKILL.md`
- 工作区：`.bajin/skills/<name>/SKILL.md`

技能以 `name + description` 摘要注入 system prompt（预算 2400 字符），完整内容通过 `Skill` 工具按名加载。

### 3.9 子代理（`tools/subagent.ts`）

`Agent` 工具可派发两种子代理：
- **Explore**：只读搜索（继承父代理 skills，禁止嵌套）
- **general-purpose**：可写任务（独立 provider 工厂）

事件带前缀转发到父代理的 callbacks，结果按调用顺序回注。

### 3.10 模型 Provider

| Provider | 文件 | 说明 |
|---|---|---|
| GLM | `providers/glm.ts` | open.bigmodel.cn，OpenAI 兼容，fetch+SSE，默认 glm-5.3 |
| Anthropic | `providers/anthropic.ts` | Anthropic Messages API，x-api-key，system 顶层，tool_use/tool_result 内容块 |
| Mock | `providers/mock.ts` | 回显/脚本化，测试用 |

**供应商体系**：
- 配置：`~/.bajin/config.json` 的 `providers[]`（name / baseUrl / apiKey / apiFormat / models）
- 端点解析链：模型自带 > 供应商 > 全局
- 自定义模型：任意 OpenAI 兼容端点，可挂靠供应商

---

## 4. CLI 入口（`packages/cli`）

### 4.1 入口路由（`main.ts`）

```
bajin                       → REPL
bajin -p "任务"             → headless（单次执行后退出）
bajin app-server --stdio    → 桌面端后端进程
```

参数：`--model` / `--mode` / `-c|--continue` / `--resume <id>` / `--mock`

### 4.2 REPL（`repl.ts`）

交互式命令行，支持：
- 内置命令：`/model` / `/mode` / `/compact` / `/sessions` / `/status` / `/clear`
- 自定义命令：未命中内置即查 `commands.ts` 展开执行
- 多会话：`/new` 新建，`/sessions` 切换

### 4.3 Headless（`headless.ts`）

单次执行，执行后退出并返回退出码，适合脚本/CI 调用。

### 4.4 App-Server（`app-server.ts`）

**桌面端后端进程**，按行分隔的 JSON-RPC 协议（stdin/stdout，日志走 stderr）。

#### 协议

```
请求 → {"id":1,"method":"send","params":{"sessionId":"sess_x","text":"..."}}
响应 → {"id":1,"result":{...}} 或 {"id":1,"error":{"code":-32000,"message":"..."}}
事件 → {"event":"text-delta","params":{"sessionId":"sess_x",...}}
```

#### 方法清单

| 类别 | 方法 |
|---|---|
| 生命周期 | `initialize` / `session/new` / `session/open` / `session/close` / `shutdown` |
| 交互 | `send` / `reset` / `interrupt` / `compact` |
| 配置 | `set-mode` / `set-model` / `set-allowed-tools` / `settings/set` |
| 审批 | `approval:respond` / `ask-user:respond` |
| 查询 | `status` / `list-sessions` / `search/sessions` / `projects/list` |
| 模型 | `models/list` / `models/add` / `models/remove` |
| 供应商 | `providers/list` / `providers/add` / `providers/remove` |
| 自动化 | `automations/list` / `automations/create` / `automations/remove` / `automations/toggle` |
| 技能 | `skills/list` / `skills/create` / `skills/read` |
| 命令 | `commands/list` |
| 任务管理 | `session/rename` / `session/pin` / `session/delete` / `session/set-group` |
| 日志 | `logs/list` / `logs/read` |
| 统计 | `usage/stats` |

#### 事件清单

| 事件 | 说明 |
|---|---|
| `text-delta` | 助手文本流 |
| `reasoning-delta` | 思维链流 |
| `tool-call` | 工具调用开始 |
| `tool-result` | 工具调用结果 |
| `todo-updated` | todo 清单更新 |
| `usage` | token 用量 |
| `approval-request` | 工具/计划审批请求 |
| `ask-user` | 提问卡 |
| `done` | 会话完成 |
| `agent-error` | 错误 |
| `session-resumed` | 会话恢复 |
| `automation-ran` | 自动化触发 |

#### 多会话管理

- 一个标签页 = 一个会话（`SessionState`）
- `sessions` Map 维护所有活跃会话
- 每个会话独立 agent 实例，事件全部带 `sessionId`

#### 审批往返

```
agent 需要审批 → emit('approval-request', { requestId, name, args })
                     → 桌面端弹出审批卡
用户操作 → approval:respond { requestId, approved } → resolve Promise
```

#### 自动化调度

- 每分钟 tick（`setInterval`）
- 到点的自动化在自己专属会话里发 prompt
- 存储：`~/.bajin/automations.json`

### 4.5 单文件 Bundle

esbuild 把 CLI 打包为 `dist/bundle/bajin.cjs`（~750KB），Electron 以 `ELECTRON_RUN_AS_NODE=1` 拉起。

---

## 5. 桌面端（`apps/desktop`）

### 5.1 分层架构

```
┌─────────────────────────────────────────┐
│  Renderer (React)                       │
│  - 聊天 UI / 侧边栏 / 设置页 / 模型管理   │
│  - 流式渲染 / 工具卡 / 审批卡 / 提问卡    │
└──────────────┬──────────────────────────┘
               │ IPC (contextBridge)
┌──────────────┴──────────────────────────┐
│  Preload                                │
│  - window.bajin.rpc() / onEvent()       │
│  - bootstrap() / pickDir() / remotes    │
└──────────────┬──────────────────────────┘
               │ IPC (ipcMain.handle)
┌──────────────┴──────────────────────────┐
│  Main (Electron)                        │
│  - 窗口管理 / 子进程管理 / 事件转发       │
│  - 配置读写 / 远程工作区 / 目录选择       │
└──────────────┬──────────────────────────┘
               │ stdio (JSON-RPC)
┌──────────────┴──────────────────────────┐
│  bajin.cjs (agent 子进程)                │
│  - app-server --stdio                   │
└─────────────────────────────────────────┘
```

### 5.2 主进程（`main/index.ts`）

职责：
- 创建 BrowserWindow（1180×800，最小 820×520）
- 启动 agent 子进程（`AppServerClient`）
- 事件转发：`forwardEvent()` 把子进程事件转发到渲染层
- IPC 处理：
  - `bajin:bootstrap`：启动引导（key / 默认模型 / 模式判定）
  - `bajin:rpc`：通用 RPC 透传
  - `bajin:pick-dir`：原生目录选择对话框
  - `bajin:remotes:list/add/remove`：远程工作区管理
  - `bajin:connect-remote`：切到远程 agent（ssh ... node bajin.cjs app-server --stdio）

**Key 判定逻辑**：
- 全局 `BIGMODEL_API_KEY` 或供应商任一配了 Key → 不降级 mock
- 默认模型：用户显式配置 > 第一个配了 Key 且有名下模型的供应商模型 > 内置默认

### 5.3 渲染层（`renderer/app.tsx`）

#### 状态管理

- `tabs: Tab[]`：多标签（每个标签 = 一个会话）
- `history: HistoryItem[]`：侧边栏历史列表
- `view: View`：当前页面（chat / settings / search / automations / skills / knowledge）
- `models / providers / customCommands`：模型与供应商数据

#### 核心组件

| 组件 | 职责 |
|---|---|
| `Composer` | 统一输入框（欢迎页居中卡片 + 会话页底栏，Enter 发送） |
| `WorkspaceChip` | 工作区选择器（最近项目 / 选择文件夹 / 主目录 / SSH 远程） |
| `TaskListItem` | 任务项（点击打开 + 悬浮菜单：置顶/重命名/移动分组/删除） |
| `App` | 主应用（事件路由 / 标签管理 / 页面切换） |

#### 事件路由

```typescript
window.bajin.onEvent(({ event, params }) => {
  switch (event) {
    case 'text-delta':    // 追加到最后一个 assistant 块
    case 'reasoning-delta': // 追加到思考块
    case 'tool-call':     // 新建工具卡占位
    case 'tool-result':   // 回填工具卡输出
    case 'approval-request': // 弹出审批卡
    case 'ask-user':      // 弹出提问卡
    case 'todo-updated':  // 更新右侧面板
    case 'usage':         // 更新 token 指示
    case 'done':          // 标记会话结束
  }
})
```

#### 侧边栏（对标 ZCode）

- 系统区：新建任务 / 搜索 / 自动化 / 技能 / 知识图谱
- 任务视图切换：时间线 / 分组 / 项目（含时间桶：今天/昨天/本周/本月/更早）
- 底部：设置

#### 设置页（对标 ZCode）

左二级导航 + 右详情：
- **基础**：常规（默认模型/模式） / 模型设置（供应商卡片 + 添加弹窗）
- **数据与统计**：使用统计（范围筛选/图表/热力图） / 日志（rollout 列表与尾部查看）
- **关于**：帮助

#### 对话层（对标 ZCode）

- **思考块**：流式中「✻ 思考中...」带旋转动画，结束折叠为「思考过程（持续了 N 秒）」
- **工具卡**：动词化状态（读取中/已读取、执行中/已执行...），六态（等待中/执行中/已执行/执行失败/已拒绝/已停止），运行中实时耗时，点击展开详情，Edit/Write 渲染 diff
- **助手消息**：复制按钮（悬停显示），长消息（>1500 字符）折叠
- **右侧状态面板**：目标 / 计划 / 进程（todo，已完成可折叠）/ 会话（模型·模式·tokens）

### 5.4 远程工作区（SSH）

对标 ZCode `workspaceSidebar.sshConnection*` 的最小切片：

1. 用户在「选择项目」面板添加 SSH 连接（名称/Host/Port/用户/路径）
2. 存储在 `~/.bajin/config.json` 的 `remotes[]`
3. 选中远程 → 主进程 kill 本地 agent → `ssh [port] user@host node <路径>/bajin.cjs app-server --stdio`
4. stdio 协议与本地完全一致，agent 跑在远程主机，文件操作落在远程 fs

前提：远程主机已安装 node，且 `bajin.cjs` 放置在配置路径下。

---

## 6. 打包与分发

### 6.1 构建流程

```bash
pnpm build          # shared → core → cli
pnpm bundle:cli     # esbuild 单文件 bundle（dist/bundle/bajin.cjs）
pnpm desktop:dist   # electron-builder 打包当前平台
```

### 6.2 多平台打包

electron-builder 配置：
- **Linux**：AppImage / deb
- **Windows**：nsis / portable
- **macOS**：dmg / zip

### 6.3 CI/CD

GitHub Actions 三平台矩阵构建（`my-code/.github/workflows/bajin-desktop.yml`）：
- 触发：推 `bajin-v*` tag 或手动运行 `bajin desktop build` 工作流
- 产物：上传到 GitHub Releases

---

## 7. 测试策略

### 7.1 测试分布

| 包 | 测试数 | 覆盖重点 |
|---|---|---|
| `core` | ~95 | agent 循环、权限、diff、hooks、commands、skills、cron、models、providers |
| `cli` | ~17 | app-server e2e（多会话、审批往返、任务管理、工作区） |

### 7.2 测试工具

- **vitest**：单元测试 + e2e
- **mock provider**：无 key 冒烟
- **fetchImpl 注入**：WebSearch/WebFetch 等外部依赖

### 7.3 基线校验

任何时刻 `pnpm -r build && pnpm -r test` 必须通过；一次运行只做 1-2 个可验证增量，宁小勿破。

---

## 8. 路线图

### 已完成（Phase 1 + 部分 Phase 2/4）

- [x] Agent 内核：流式循环、8 内置工具、四档权限、并行工具分组、Edit/Write diff、Plan 模式、子代理、动态 system prompt、abort、compact、rollout 日志、会话持久化、skills、hooks、commands
- [x] Provider：GLM + Anthropic + Mock
- [x] CLI：REPL + headless + app-server + 单文件 bundle
- [x] 桌面端：Electron 壳 + 多标签 + 侧边栏 + markdown 渲染 + diff 着色 + todo 面板 + 审批三选 + AskUserQuestion + 斜杠补全 + token 指示 + 停止 + 分叉 + 远程工作区
- [x] 打包：esbuild bundle + electron-builder + GH Actions

### P0 —— 内核功能还债

- [ ] WebSearch / WebFetch 工具（免 key 源先行）
- [ ] MCP client（stdio transport）
- [ ] SQLite 会话库（替代 JSONL）
- [ ] settings 作用域链（System < User < Project < Session < Env < Cli）
- [ ] 后台任务（Bash `run_in_background` + `TaskOutput`/`TaskStop`）

### P1 —— 体验追平

- [ ] 桌面端终端面板（node-pty + xterm.js）
- [ ] 桌面端文件树
- [ ] 系统通知
- [ ] 图片 Read
- [ ] AskUserQuestion multiSelect 全链路
- [ ] EnterWorktree / ExitWorktree
- [ ] Scheduler（CronCreate 工具 + 独立 `bajin scheduler` 子命令）
- [ ] LSP 工具
- [ ] 自定义命令 frontmatter 生效

### P2 —— 超越 ZCode

- [ ] 多 provider：Anthropic / OpenAI / OpenRouter
- [ ] 会话搜索与导出
- [ ] 精确 token 计数与成本估算
- [ ] 桌面端 e2e（playwright）
- [ ] 中文/英文 UI i18n
- [ ] 并行工具输出流式回传

---

## 9. 设计约束与原则

### 9.1 净室原则

只参考 ZCode 的行为与接口（设计文档 + 参考/ 源码快照），绝不复制其代码文本。

### 9.2 安全默认

- 权限默认 `build`（需批准）
- hooks 默认关闭（`enabled:true` 才启用）
- 未知工具 / 参数错误 → 拒绝
- 计划模式：只读工具外全部拒绝

### 9.3 单文件 bundle

CLI 打包为 < 1MB 的 `bajin.cjs`，Electron 自带 node 运行时拉起，无需用户安装 node。

### 9.4 跨平台

- Bash：Linux/macOS 走 `bash -c`，Windows 走 `cmd /c`（`BAJIN_SHELL` 可覆盖）
- 路径：统一 `node:path`，不硬编码分隔符
- 打包：三平台矩阵构建

### 9.5 可测试性

- 核心逻辑纯函数 + 依赖注入（providerFactory / fetchImpl / askUser）
- mock provider 支持无 key 冒烟
- 一次运行只做 1-2 个可验证增量

---

## 10. 术语表

| 术语 | 说明 |
|---|---|
| agent 循环 | 接收输入 → 调模型 → 执行工具 → 再调模型的循环 |
| concurrentSafe | 工具元数据，标记可并发执行（Read/Glob/Grep） |
| gate | 权限门控（未知工具/参数错误/planMode/policy 判定） |
| hooks | 7 事件钩子系统（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop） |
| matcher | 大小写敏感正则，用于 hooks 事件匹配 |
| plan 模式 | 只读调研模式（EnterPlanMode → ExitPlanMode → 审批 → 切 build） |
| provider | 模型提供者（GLM / Anthropic / Mock） |
| rollout | 模型 IO 日志（`~/.bajin/rollout/model-io-<sess>.jsonl`） |
| session | 一次对话（persistDir/<sessionId>/） |
| skills | 可加载的技能（SKILL.md） |
| slash commands | 自定义命令（~/.bajin/commands/） |
| subagent | 子代理（Explore 只读 / general-purpose 可写） |
| transcript | 会话消息事件流（JSONL） |
| workspace | 工作目录（cwd） |

---

*文档版本：2026-08-15（基于代码实际实现整理）*
