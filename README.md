# bajin

净室复刻的迷你编码代理（学习项目）——参考 ZCode 桌面端架构设计文档实现，代码全部自写。

## 快速开始

```bash
pnpm install
pnpm build        # 构建 shared → core → cli
pnpm test         # vitest 全部测试

# 无 key 冒烟
node packages/cli/bin/bajin.js --mock -p "你好"

# 真实模型（默认 glm-5.3）
export BIGMODEL_API_KEY=sk-xxx
node packages/cli/bin/bajin.js            # 交互式 REPL
node packages/cli/bin/bajin.js -p "统计当前目录的 ts 文件数"   # headless
```

## 桌面端（Electron）

架构对标 ZCode：桌面端只是壳，agent 跑在独立的 CLI 子进程（`bajin app-server --stdio`，按行 JSON-RPC + 流事件 + 审批往返），由 Electron 自带 node 运行时以 `ELECTRON_RUN_AS_NODE=1` 拉起单文件 bundle（`dist/bundle/bajin.cjs`，对标 zcode.cjs）。

```bash
pnpm build && pnpm bundle:cli
pnpm desktop:dev      # 本地运行（无 key 自动降级 mock）
pnpm desktop:dist     # electron-builder 打包当前平台
```

多平台打包（Linux AppImage/deb · Windows nsis/portable · macOS dmg/zip）：推 CI 触发
`bajin-v*` tag，或在 GitHub Actions 手动运行 `bajin desktop build` 工作流
（`my-code/.github/workflows/bajin-desktop.yml`，三平台矩阵构建并上传产物）。

## 结构

| 包 | 职责 |
|---|---|
| `@bajin/shared` | 消息/工具/权限的类型契约（zod schema → JSON Schema） |
| `@bajin/core` | agent 循环、GLM provider（fetch+SSE 直连 open.bigmodel.cn）、8 个内置工具、权限策略 |
| `@bajin/cli` | REPL + headless `--print` + `app-server --stdio`（桌面端后端）+ 单文件 bundle |
| `@bajin/desktop` | Electron 壳：main（子进程管理/IPC）+ preload + React 聊天 UI（流式/工具卡片/内联审批） |

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
- [x] Phase 4a 桌面端 MVP：app-server（stdio JSON-RPC）+ Electron 壳 + 单文件 bundle + 三平台打包/CI
- [ ] Phase 2 会话持久化（SQLite、--continue/--resume、AGENTS.md 注入）
- [ ] Phase 3 扩展体系（skills / commands / hooks / MCP / plugins）
- [ ] Phase 4b 桌面端增强（终端面板、diff 审批视图、工作区选择、设置页）
- [ ] Phase 5 subagents / worktree / scheduler / 嵌入式浏览器
