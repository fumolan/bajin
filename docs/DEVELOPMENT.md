# bajin 开发文档

> 如何搭建环境、构建、测试、扩展和部署 bajin。

## 目录

1. [环境要求](#1-环境要求)
2. [快速开始](#2-快速开始)
3. [构建与测试](#3-构建与测试)
4. [项目结构](#4-项目结构)
5. [添加新工具](#5-添加新工具)
6. [添加新 Provider](#6-添加新-provider)
7. [配置参考](#7-配置参考)
8. [打包与发布](#8-打包与发布)
9. [调试技巧](#9-调试技巧)
10. [FAQ](#10-faq)

---

## 1. 环境要求

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Node.js | 22.5+ | 需 `node:sqlite`（推荐 24.x） |
| pnpm | 9+ | 包管理器 |
| API Key | — | BigModel / 任意 OpenAI 兼容端点 |

## 2. 快速开始

```bash
# 克隆
git clone <repo-url>
cd bajin

# 安装依赖
pnpm install

# 构建全部包
pnpm -r build

# 配置 API Key（二选一）
export BIGMODEL_API_KEY=your-key
# 或写入 ~/.bajin/config.json:
# { "bigmodel": { "apiKey": "your-key" } }

# CLI 交互模式
node packages/cli/dist/main.js

# 冒烟测试（不需要 key）
node packages/cli/dist/main.js -p "hello" --mock
```

## 3. 构建与测试

### 构建

```bash
# 全量构建（shared → core → web-render → cli）
pnpm -r build

# 单包构建
pnpm --filter @bajin/core build
pnpm --filter @bajin/cli build

# CLI 单文件 bundle（<1MB）
pnpm --filter @bajin/cli bundle
# 产出: packages/cli/dist/bundle/bajin.cjs
```

### 测试

```bash
# 全量测试
pnpm -r test

# 单包测试
pnpm --filter @bajin/core test
pnpm --filter @bajin/cli test

# 单文件测试
cd packages/core && npx vitest run test/hooks.test.ts
```

当前测试覆盖：**203 项**（core 179 + cli 24），涵盖单元/集成/e2e 三层。

### 一键打包

```bash
bash scripts/package.sh
# 执行: pnpm -r build → test → bundle → web-render 产物校验 → app-server RPC 冒烟
# 产出: packages/cli/dist/bundle/bajin.cjs + packages/web-render/dist/renderer/app.js
```

---

## 4. 项目结构

```
bajin/
├── packages/shared/   # 类型定义（~100 行）
├── packages/core/     # Agent 内核（~8000 行）
│   ├── src/agent.ts   # 核心：消息循环/工具编排
│   ├── src/tools/     # 23 个内置工具
│   └── src/providers/ # 模型接入层
├── packages/cli/      # CLI 入口（~3000 行）
│   └── src/app-server.ts  # 网页端/REPL 共用后端 RPC

│   └── src/renderer/app.tsx  # 主 UI 组件
├── scripts/package.sh # 打包脚本
├── docs/              # 文档
└── GAP-TRACKER.md     # 进度账本
```

---

## 5. 添加新工具

### 步骤 1：创建工具文件

```typescript
// packages/core/src/tools/mytool.ts
import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';

const MyToolInput = z.object({
  target: z.string().describe('目标参数'),
});

export function createMyTool(): ToolDefinition<typeof MyToolInput> {
  return {
    name: 'MyTool',
    description: 'Describe what this tool does for the model.',
    inputSchema: MyToolInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 10_000 },
    async execute(input, ctx) {
      // ctx.cwd = 当前工作目录
      // ctx.env = 环境变量
      return { ok: true, output: `结果: ${input.target}` };
    },
  };
}
```

### 步骤 2：注册

```typescript
// packages/core/src/tools/index.ts
import { createMyTool } from './mytool.js';

export const builtinTools: ToolDefinition[] = [
  // ... 现有工具
  createMyTool(),  // 添加
];
```

### 步骤 3：测试

```typescript
// packages/core/test/mytool.test.ts
import { describe, it, expect } from 'vitest';
import { createMyTool } from '../src/tools/mytool.js';

describe('MyTool', () => {
  it('基本功能', async () => {
    const tool = createMyTool();
    const r = await tool.execute({ target: 'test' }, { cwd: '/tmp' } as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('test');
  });
});
```

### Metadata 字段说明

| 字段 | 值 | 效果 |
|---|---|---|
| `readOnly` | `true` | 任何模式下免审批 |
| `riskLevel` | `'low'`/`'medium'`/`'high'` | 影响审批提示 |
| `concurrentSafe` | `true` | 可与其他安全工具并行执行 |
| `timeoutMs` | 毫秒 | 超时后工具被终止 |

---

## 6. 添加新 Provider

### 实现 ModelProvider 接口

```typescript
// packages/core/src/providers/myprovider.ts
import type { ModelProvider, ChatRequest, ChatResponse, StreamEvent } from '@bajin/shared';

export function createMyProvider(opts: { apiKey: string; baseUrl?: string }): ModelProvider {
  return {
    id: 'myprovider',
    defaultModel: 'my-model-v1',
    async chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
      // 1. 发 HTTP 请求到你的 API
      // 2. 解析 SSE 流（如果支持），逐 token 调 onEvent
      // 3. 返回最终 ChatResponse
      const res = await fetch(`${opts.baseUrl}/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
      });
      const data = await res.json();
      return {
        message: { role: 'assistant', content: data.text },
        usage: { inputTokens: data.input_tokens, outputTokens: data.output_tokens },
        finishReason: 'stop',
      };
    },
  };
}
```

### 在 app-server 接入

```typescript
// packages/cli/src/app-server.ts → buildProviderFactory()
// 添加新的 apiFormat 分支
if (ep.apiFormat === 'myformat') {
  return createMyProvider({ apiKey, baseUrl });
}
```

---

## 7. 配置参考

### ~/.bajin/config.json 完整结构

```jsonc
{
  // 默认模型/模式
  "model": "glm-4.7",
  "mode": "build",

  // 全局 BigModel 配置
  "bigmodel": {
    "apiKey": "your-key",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4"
  },

  // 供应商列表（多格式接入）
  "providers": [
    {
      "name": "智谱 GLM",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "key",
      "apiFormat": "openai",
      "models": ["glm-4.7", "glm-4.7-flash"]
    },
    {
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "key",
      "apiFormat": "anthropic",
      "models": ["claude-sonnet-4-5"]
    }
  ],

  // 自定义模型（任意端点）
  "models": [
    { "id": "my-model", "baseUrl": "https://api.example.com/v1", "apiKey": "key" }
  ],

  // Hooks（7 事件）
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [{ "type": "command", "command": "echo '{\"decision\":\"approve\"}'", "timeout": 5 }]
        }
      ]
    }
  },

  // MCP 服务器
  "mcpServers": {
    "weather": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@weather/server"]
    }
  },

  // 禁用的技能
  "skillsDisabled": ["skill-name"],

  // 界面设置
  "settings": {
    "theme": "dark",
    "locale": "zh-CN",
    "notificationEnabled": true,
    "notificationSoundEnabled": false,
    "terminalShell": "auto",
    "terminalFontFamily": "",
    "showArchivedTasks": false,
    "taskSortBy": "updated"
  },

  // 数据目录（迁移后）
  "dataDir": "/path/to/custom/dir"
}
```

### 项目级配置

```
<project>/bajin.json           # 或
<project>/.bajin/config.json   # 或
<project>/.agents/config.json  # 双前缀兼容
```

项目级覆盖用户级（同名键）。

---

## 8. 打包与发布

### CLI 单文件

```bash
pnpm --filter @bajin/cli bundle
# 产出: packages/cli/dist/bundle/bajin.cjs (~860KB)
# 可直接 node bajin.cjs 运行
```

### 网页端起服

```bash
bash scripts/package.sh   # 构建+测试+bundle+web-render 产物校验+RPC 冒烟
node packages/cli/dist/bundle/bajin.cjs server --port 4444
# 浏览器访问 http://localhost:4444（渲染层由 web-server 直接 serve）
```

### SSH 远程部署

```bash
# 把 CLI bundle 传到远程
scp packages/cli/dist/bundle/bajin.cjs remote:/opt/bajin/

# SSH 远程工作区配置（设置 → Agent → 项目 → SSH；当前 web 模式为 stub）
# 主进程会 ssh user@host node /opt/bajin/bajin.cjs app-server --stdio
```

---

## 9. 调试技巧

### 查看模型 IO 日志

```bash
# 每次请求/响应的完整 JSON
cat ~/.bajin/rollout/model-io-<sessionId>.jsonl | jq .
```

### 查看 Agent 事件流

```bash
# 浏览器 DevTools console（F12）
# 或 CLI REPL 中观察 stderr 输出
```

### 测试单个工具

```bash
cd packages/core
npx vitest run test/tools.test.ts -t "Read"
```

### MCP 连接问题

```bash
# 检查 MCP 服务器是否可达
npx -y your-mcp-server --help

# 查看 bajin 启动日志（MCP 连接告警）
node packages/cli/dist/main.js app-server --stdio 2>&1 | head -20
```

---

## 10. FAQ

**Q: 如何切换模型？**
A: 对话中 `/model glm-4.7-flash`，或设置 → 模型设置 → 供应商管理。

**Q: 如何禁用某个技能？**
A: 设置 → Agent → 技能 → 关闭对应 Switch。

**Q: 如何添加自定义命令？**
A: 在 `~/.bajin/commands/` 放 `.md` 文件，frontmatter 写 description/model/allowed-tools/skills。

**Q: 如何用外部 LLM？**
A: 设置 → 模型设置 → 添加供应商（选目录预设或自定义端点）→ 配 API Key → 模型切到该供应商名下的模型。

**Q: 数据存在哪里？**
A: 全部在 `~/.bajin/`（可用 `BAJIN_HOME` 环境变量或设置→数据目录迁移）。

**Q: 如何导出对话？**
A: CLI `bajin export <sessionId>`，或任务菜单 → 查看调用轨迹。
