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

## 结构

| 包 | 职责 |
|---|---|
| `@bajin/shared` | 消息/工具/权限的类型契约（zod schema → JSON Schema） |
| `@bajin/core` | agent 循环、GLM provider（fetch+SSE 直连 open.bigmodel.cn）、8 个内置工具、权限策略 |
| `@bajin/cli` | REPL + headless `--print`、配置加载（`~/.bajin/config.json` ← `./bajin.json`） |

## 内置工具

`Read` `Write` `Edit` `Bash` `Glob` `Grep` `TodoWrite` `AskUserQuestion`

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
- [ ] Phase 2 会话持久化（SQLite、--continue/--resume、AGENTS.md 注入）
- [ ] Phase 3 扩展体系（skills / commands / hooks / MCP / plugins）
- [ ] Phase 4 app-server（stdio RPC）+ Electron 壳
- [ ] Phase 5 subagents / worktree / scheduler / 嵌入式浏览器
