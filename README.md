# bajin

净室复刻的迷你编码代理（学习项目）——参考 ZCode 桌面端架构设计文档实现，代码全部自写。

## 快速开始

```bash
pnpm install
pnpm build        # 构建 shared → core → web-render → cli
pnpm test         # vitest 全部测试

# 无 key 冒烟
node packages/cli/bin/bajin.js --mock -p "你好"

# 真实模型（默认 glm-5.3）
export BIGMODEL_API_KEY=sk-xxx
node packages/cli/bin/bajin.js            # 交互式 REPL
node packages/cli/bin/bajin.js -p "统计当前目录的 ts 文件数"   # headless
```

## 网页端（主要使用方式）

### 接本地模型（llama.cpp / Ollama 等任意 OpenAI 兼容端点）

设置 → 模型设置 → 添加供应商：
- baseUrl：`http://127.0.0.1:8080/v1`（llama.cpp 默认端口；Ollama 为 `http://127.0.0.1:11434/v1`）
- apiFormat：`openai`；apiKey 随意填（本地无鉴权时）
- models：模型名列表（llama.cpp 为 gguf 文件名）

也可直接编辑 `~/.bajin/config.json` 的 `providers` 块。GLM 官方模型填
`bigmodel.apiKey` 即可（env `BIGMODEL_API_KEY` 同效）。注意：小参数量
gguf 对 function calling 支持有限，工具调用建议用支持工具的模型。


`bajin server` 起本地服务，浏览器访问 `http://localhost:4444`——与原桌面端同一套 React 聊天 UI
（流式输出/工具卡片/内联审批/通知中心/浏览器面板/系统监控），零桌面依赖。

```bash
pnpm build            # 全 workspace 构建（含 @bajin/web-render 渲染层）
node packages/cli/dist/main.js server --port 4444 --mock   # 无 key 降级 mock
```

## 结构

| 包 | 职责 |
|---|---|
| `@bajin/shared` | 消息/工具/权限的类型契约（zod schema → JSON Schema） |
| `@bajin/core` | agent 循环、GLM provider（fetch+SSE 直连 open.bigmodel.cn）、8 个内置工具、权限策略 |
| `@bajin/cli` | REPL + headless `--print` + `app-server --stdio` + `server`（网页端）+ 单文件 bundle |
| `@bajin/web-render` | React 聊天 UI（web 渲染层，IIFE 单 bundle，bajin server 直接 serve） |

## 内置工具

`Read` `Write` `Edit` `Bash` `Glob` `Grep` `TodoWrite` `AskUserQuestion`
＋ `EnterPlanMode` `ExitPlanMode`（计划模式）＋ `Skill`（技能加载）＋ `Agent`（子代理）
＋ `WebSearch` `WebFetch`（DuckDuckGo 搜索 + HTML→文本）
＋ `Bash run_in_background` + `TaskOutput` `TaskStop`（后台任务）
＋ `CronCreate` `CronUpdate` `CronDelete` `CronList`（定时任务）
＋ `EnterWorktree` `ExitWorktree`（git 隔离实验）
＋ `BrowserNavigate` `BrowserContent`（浏览器面板控制）
＋ `Diagnostics`（TypeScript 类型检查）
＋ `Memory`（长期记忆读写）

## Agent 内核特性（对标 ZCode 的精髓）

- **动态 system prompt**：每轮重组装 —— todo 清单实时回注、AGENTS.md 注入（用户级+项目级）、skills 清单预算注入、工具使用教练与沟通风格约束、权限/计划模式说明
- **并行工具执行**：`concurrentSafe` 工具（Read/Glob/Grep 等）连续调用自动分组并发；副作用工具串行 + 审批；结果按调用顺序回注
- **Edit/Write 返回 unified diff**（自研 LCS 行级 diff，含上下文折叠与超大文件降级）
- **Plan 模式**：EnterPlanMode 只读调研 → ExitPlanMode 提交计划 → 审批通过自动切 build 实施
- **子代理**：`Agent` 工具派 Explore（只读搜索）/ general-purpose（可写）子任务，事件带前缀转发，禁止嵌套防失控
- **会话持久化**：`~/.bajin/sessions/<sess_id>/transcript.jsonl` 事件流；`bajin -c` / `--resume <id>` 恢复；桌面端同样开启
- **rollout 模型 IO 日志**：`~/.bajin/rollout/model-io-<sess>.jsonl` 记录每次请求/响应（请求复盘调试）
- **上下文压缩**：`/compact` 手动或超限自动触发（摘要 + 保留最近两轮），压缩标记写入 transcript
- **跨平台 Bash**：Linux/macOS 走 bash -c，Windows 走 cmd /c（BAJIN_SHELL 可覆盖）
- **SQLite 会话库**：node:sqlite 五表（session/message/part/todo/tool_usage），JSONL 双写过渡 + 容灾恢复
- **Hooks 系统**：7 事件（SessionStart/UserPromptSubmit/Pre/PostToolUse/PermissionRequest/Stop），matcher 正则 + 退出码协议 + JSON 决策
- **自定义 slash 命令**：frontmatter（description/model/allowed-tools/skills）三效生效
- **MCP**：stdio + sse 双传输，工具命名 mcp__server__tool
- **插件系统**：~/.bajin/plugins/ 目录，技能/命令自动发现，启停控制
- **`.agents/` 双前缀**：skills/commands/subagents 项目级同时扫 .bajin/ 与 .agents/
- **settings 作用域链**：System < User < Project(到 .git 根) < Env < Cli
- **多 provider**：GLM(openai) + Anthropic(Messages) + 自定义端点 + 供应商目录
- **精确 token 计数**：CJK/ASCII 分类估算 + 15 模型定价表 + 成本估算

## 权限模式

| 模式 | 只读工具 | Write/Edit | Bash |
|---|---|---|---|
| plan | 放行 | 拒绝 | 拒绝 |
| build（默认） | 放行 | 需批准 | 需批准 |
| edit | 放行 | 放行 | 需批准 |
| yolo | 放行 | 放行 | 放行 |

`allowedTools` / `disallowedTools` 显式名单优先于模式。

## 路线图

- [x] Phase 1 内核：agent 循环 + GLM + 8 工具 + 权限 + REPL/headless
- [x] Phase 4a 聊天前端 MVP：app-server（stdio JSON-RPC）+ React UI（原 Electron 壳，2026-08-29 起转型纯网页端，桌面 app 移除）
- [ ] Phase 2 会话持久化（SQLite、--continue/--resume、AGENTS.md 注入）
- [ ] Phase 3 扩展体系（skills / commands / hooks / MCP / plugins）
- [ ] Phase 4b 桌面端增强（终端面板、diff 审批视图、工作区选择、设置页）
- [ ] Phase 5 subagents / worktree / scheduler / 嵌入式浏览器
