# bajin 第七轮改进计划

> 前六轮 66/66 全部完成（R6 六项全部源自 ZCode 3.9.1 实机差异盘点）。
> 本轮聚焦：**web 模式能力对齐 + 3.9.1 差异复查 + 内在质量**。每轮从顶部取第一个未完成项实现。
> 2026-08-28 复查：运行中 ZCode 仍为 3.9.1（无更新）。

## 浏览器能力对齐（web 模式补课）

- [x] **内容回读服务端补偿**（2026-08-28 完成）：web 模式 iframe 跨域读不到文本（只报 URL）时，
  app-server 用 fetchPageText 代抓回填（仅当面板仍停在同一 URL，换页即丢弃）；新 browser/state-get
  RPC 观察回读状态；browser-backfill.e2e.test.ts 2 例（本地 http server 回填回路/自带 content 优先）
- [x] **CUA 跨域执行补偿**（2026-08-28 完成）：core ActionResultHub（结果先到暂存/超时失败/幂等回填，
  action-hub.test 4 例）；app-server bridge click/type 发事件带 seq→等面板真实结果（10s 超时按失败），
  browser/action-result RPC 回填；渲染层执行后上报成功/跨域受限（提示改桌面端）/未命中——工具不再盲报成功

## ZCode 3.9.1 差异复查

- [x] **host 进程用途考证**（2026-08-28 完成，结论入 GAP-TRACKER）：host 是**每桌面窗口一个的后端宿主进程**
  ——主进程按 windowId 维护 windowHostProcessMap，Electron MessageChannelMain 双 port 直连渲染层；
  内含会话/子代理/agent 配置管理、node-pty 真终端、ssh2 远程执行、bundled-agents/tools 平台原生二进制
  （${platform}-${arch} 目录，asar.unpacked 里的 node-pty/ssh2 即为其依赖）。scheduler 为独立自动化进程
  （automation/cron/tick）。bajin 对照：等价物是 CLI app-server 子进程（stdio JSON-RPC）——架构同构，
  差异为「每窗口独立 vs 全局共享」与「真 pty vs 管道」（后者已按 bundle<1MB 标准明确不做）。
  **每窗口 host 独立进程不立项**：bajin 多标签共享一个 app-server，进程级崩溃隔离已具备，
  按窗口拆分徒增进程与状态复杂度。**衍生立项**：app-server 崩溃自动恢复（见下）
- [x] **UI 串二次扫描**（2026-08-28 完成）：2671 候选按特征词聚类（导入51/搜索49/更新34/额度33/复制32/
  编辑26/删除25/同步19/标签11/撤销9…）；逐簇判定——额度/订阅/日志上传为 ZCode 账户体系不适用，
  复制/删除/搜索基础 bajin 已有，导入外部 Agent 与标签页管理留作后续；**真差距=撤销本轮文件改动 → 已实现**
  （core planFileRevert 分级计划器 + app-server touched 追踪与 revert RPC + GitPanel 预览/确认 UI，
  revert-plan 5 例 + session-revert e2e 2 例）

## 崩溃韧性（host 考证衍生的真差距）

- [x] **app-server 崩溃自动恢复**（2026-08-28 完成）：core RestartSupervisor（指数退避 1s→30s 封顶/
  最多 5 次/稳定 60s 清零，restart-supervisor.test 4 例）；AppServerClient 退出复位引用（start 可重拉）+
  stopped 区分主动关停；主进程崩溃→server-exit 携带 willRestart/attempt/delayMs→延迟重拉→server-restarted；
  渲染层分级提示（安抚/放弃/普通）+ server-restarted 后 re-initialize 并对全部标签 openHistory 恢复

## 外部生态导入（R7-5 二扫的最大遗留簇：导入 51 条）

- [x] **导入 Claude Code 设置**（2026-08-28 完成）：core importClaudeSettings（命令 md/技能目录
  SKILL.md/子代理 md 复制入用户级目录；~/.claude.json mcpServers 合并入 config.json 同名不覆盖；
  dry-run 只清点；源目录可注入）+ `bajin import claude [--dry-run]` 子命令；import-external.test 4 例
- [x] **导入 Codex/Cursor 设置**（2026-08-28 完成）：importCodexSettings（prompts/*.md→命令；config.toml
  手写最小 TOML 解析 [mcp_servers.*] 字符串/数组/内联表，不引依赖）+ importCursorSettings（rules/*.mdc→
  技能，mdcToSkillMd 转写 description/globs；mcp.json 合并）；CLI `bajin import <claude|codex|cursor>`；
  import-more.test 4 例；实机 dry-run：codex 空结果正确（真实 config 无 mcp_servers/prompts）、cursor 源缺失安全

## 界面打磨（R7-5 二扫标签簇）

- [x] **标签页管理增强**（2026-08-28 完成）：shared/tab-ops 纯函数（closeOthers/closeAll/closeOne/
  reopenTab，7 例）；标签右键菜单（关闭标签/关闭其他/关闭所有/恢复最近关闭 N）+ ＋ 旁 ↺ 恢复按钮 +
  Ctrl+Shift+T；Tab 增 id（创建序号，reopen 按原 index 插回夹末尾）；恢复栈上限 20；关闭不重开会话
  ——历史列表仍在可找回

## 打磨（R10，截图驱动）

- [x] **动画细节**（2026-08-30 完成）：消息淡入上浮、下行面板展开过渡、
  通知/弹层过渡、行 hover 平滑、按钮统一微过渡；prefers-reduced-motion 全部禁用
- [x] **快捷键扩充+面板同步**（2026-08-30 完成）：Ctrl+E 文件树、Ctrl+G Git 面板、
  Ctrl+Shift+T 恢复标签、Ctrl+M 语音、Ctrl+S 编辑器保存入面板列表
- [x] **浅色主题修复**（2026-08-30 完成）：`:root` 后置覆盖 `[data-theme=light]`
  同 specificity——浅色主题自写出起从未生效；改 `:root[data-theme=light]` 提级；
  双向切换实测；🔔 悬浮钮上移避开 Composer 发送按钮重叠

## 内在质量

- [x] **面板状态时效显示**（2026-08-28 完成）：BrowserStateStore 增 contentAt（换 URL 不重置内容时钟——
  旧内容继续变旧）；bridge 可选 getContentMeta；BrowserContent 输出标注「内容更新于 N 秒前」（>2 分钟提示
  建议 BrowserNavigate 刷新）；面板头 5s 轮询 state-get 显示时效 chip（>5 分钟黄字警示）；browser-age 3 例
- [x] **回读去重**（2026-08-28 完成，R7 收官）：shouldBackfill（同 URL 30s TTL 防抖，换 URL/过期放行）+
  setContentIfChanged（内容相同不动 contentAt——页面没变不伪造「刚更新」，不同才重置时钟）；app-server 代抓
  走双闸；backfill-dedup 3 例 + e2e 1 例（请求计数器实证两次上报只抓一次、换页立即放行）

---
*生成时间：2026-08-28 03:30 | 目标：5 项（5/5 全部完成） | 依据：R6 收官后遗留（web 跨域两处）+ 3.9.1 未考证差异 + 回读质量*
