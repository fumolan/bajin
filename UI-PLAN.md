# bajin UI 对齐计划 —— ZCode 可交互元素清单与迭代批次

> 来源：`参考/` 渲染层 i18n 键位与命令注册表逐项核对（workspaceSidebar/taskList/taskGroup/chat.*/settings.*/titleBar.*/quickPick.*）。
> 用法：每轮迭代从「批次」顺序取项实施，完成后把状态列 ✅ 并在 GAP-TRACKER 记账。
> 图例：✅ 已对齐｜🟡 部分｜❌ 缺失｜⏸ 暂缓（依赖未就绪）

## A. 侧边栏

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| A1 | 新建任务 | 顶部，Ctrl+N，taskList.newTask | ✅ | — |
| A2 | 搜索 | Ctrl+K 唤起（quickPick 含任务搜索） | ✅ Ctrl+K 直达搜索页（quickPick 面板在批次4） | 1 |
| A3 | 自动化 | 一级菜单 | ✅ | — |
| A4 | 技能 | 一级菜单 | ✅ | — |
| A5 | 知识图谱 | 一级菜单（repo 知识库） | ✅ 占位（后端 P1） | — |
| A6 | 视图切换 时间线/分组/项目 | workspaceSidebar.organize | ✅ | — |
| A7 | 任务列表过滤框 | searchTasks 搜索任务... | ✅ 标题/会话id 过滤 | 1 |
| A8 | 任务项点击打开 | taskList | ✅ | — |
| A9 | 任务项悬浮菜单·置顶 | taskList.pin/unpin，置顶区 | ✅ 置顶桶+📌 | 2 |
| A10 | 任务项悬浮菜单·重命名 | taskList.rename | ✅ 内联输入 | 2 |
| A11 | 任务项悬浮菜单·删除 | taskList.delete | ✅ 确认后删目录 | 2 |
| A12 | 任务项悬浮菜单·移动到分组 | taskGroup.moveToGroup | ✅ 内联输入（留空取消分组） | 2 |
| A13 | 归档/取消归档 | toggleArchivedTasks + archive/unarchive | ❌ | 3 |
| A14 | 显示更多/收起 | taskList.showMore/showLess | ❌ | 3 |
| A15 | 设置 | 底部唯一系统入口 | ✅ | — |
| A16 | 侧栏折叠/展开 | showSidebar/hideSidebar | ✅ | — |

## B. 欢迎页 / 输入框（composer）

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| B1 | 模板卡片 | chat.empty 首页（站会摘要/CI 报告/自定义） | ✅ | — |
| B2 | 切换模式 | composer 底栏（默认模式/计划/接受编辑/完全访问） | ✅ | — |
| B3 | 选择模型 | composer 底栏弹窗（搜索+管理模型） | ✅ | — |
| B4 | 发送 ↑ | composer 右下 | ✅ | — |
| B5 | 停止 | 运行中 | ✅ | — |
| B6 | 推理强度 | chat.toolbar.thoughtLevel（关/低/中/高/最高） | ❌ 需 agent 接 thinking 参数 | 6 |
| B6c | SSH 远程工作区 | 选择项目面板：远程列表/添加 SSH 连接（名称/Host/Port/用户/路径），选中后 agent 经 ssh 在远程主机运行 | ✅ 最小切片（自动部署远程待做） | 2b |
| B6b | 工作区选择器（选择项目） | composer 左侧 + 欢迎页：选择项目面板（搜索工作区/最近项目/选择文件夹/主目录/不在项目中工作），选定文件夹决定新任务 cwd | ✅ | 2b |
| B7 | ＋添加上下文（@ 引用文件） | chat.composer.actionMenu | ❌ | 5 |
| B8 | 排队后续输入 | chat.placeholder.followUpQueue | ❌ | 5 |

## C. 对话层

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| C1 | 思考块（思考中.../折叠/持续 N 秒） | chat.reasoning.* | ✅ | — |
| C2 | 工具卡（动词状态六态+耗时） | chat.toolCall.* | ✅ | — |
| C3 | 工具卡·展开/收起详情 | expandDetails/collapseDetails | ✅ | — |
| C4 | 工具卡·复制结果 | chat.toolCall.mcp.copyResult / nodeRepl.copyResult | ✅ | 1 |
| C5 | 助手消息·复制 | chat.message.copy | ✅ | — |
| C6 | 助手消息·展开/收起（长消息） | chat.message.expand/collapse | ✅ >1500 字符折叠 | 1 |
| C7 | 助手消息·编辑/恢复 | chat.message.edit/restore | ❌ 需会话回滚 | 6 |
| C8 | 助手消息·重试 | chat.message.retry | ❌ | 4 |
| C9 | 消息级分叉 | chat.message.fork | 🟡 会话级分叉已有 | 6 |
| C10 | 权限卡：允许/始终允许/拒绝 | chat.permission.* | ✅ | — |
| C11 | 权限卡：允许本会话/本项目/始终拒绝 | allowForSession/allowForProject/denyAlways | 🟡 单会话=始终允许；项目级/始终拒绝缓 | 6 |
| C12 | 提问卡（AskUserQuestion） | 选项+自由输入 | ✅ | — |

## D. 右侧状态面板

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| D1 | 目标/计划/进程/会话 四区 | chat.statusPanel.* | ✅ | — |
| D2 | 进程·已完成折叠 | todoCompletedFold | ✅ | — |
| D3 | 计划·打开完整计划 | statusPanel.openPlan | 🟡 计划已在面板+审批卡 | — |
| D4 | 终端/智能体 区 | statusPanel.terminals/agents + 停止 | ⏸ 依赖后台任务（P0 后台任务就绪后） | — |

## E. 设置页

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| E1 | 二级导航（基础/数据与统计/关于） | settings.nav 三分组 | ✅ | — |
| E2 | 供应商卡片：编辑/删除/模型 chips | modelProvider.customTitle | ✅ | — |
| E3 | 添加供应商弹窗：目录/自定义/保存/取消 | addFromCatalog/addPureCustom | ✅ | — |
| E4 | API 格式下拉（OpenAI/Anthropic） | apiFormat.* | ✅ | — |
| E5 | 获取 API Key 外链 | modelProvider.getApiKey | ✅ 按 baseUrl 映射 7 家 | 1 |
| E6 | 常规（默认模型/模式/运行状态） | settings.nav.general | ✅ | — |
| E7 | 使用统计（范围筛选/图表/热力图） | settings.usage.* | ✅ | — |
| E8 | 日志 / 帮助 | settings.nav | ✅ | — |

## F. 全局

| # | 元素 | ZCode 位置/行为 | bajin 状态 | 批次 |
|---|---|---|---|---|
| F1 | Ctrl+N 新建任务 | 快捷键 | ✅ | 1 |
| F2 | Ctrl+K 快速命令面板 | quickPick：新建任务/打开工作区/设置/切换侧栏/切换终端（分区 suggested/panels/configure） | ❌ | 4 |
| F3 | Ctrl+W 关闭当前标签 | 标签页行为 | ✅ | 1 |
| F4 | 会话标签页（多开/关闭/新建） | ZCode 为单任务多窗；bajin 保留多标签特色 | ✅ | — |
| F5 | 标题栏菜单（文件/视图/帮助） | titleBar.menu.* | ⏸ Electron 默认菜单已可用 | — |

## 迭代批次（顺序执行，每批全绿+打包+记账）

- **批次 1（渲染层速赢）**：F1 Ctrl+N、F3 Ctrl+W、A2 Ctrl+K→搜索页、A7 任务过滤框、C4 工具卡复制结果、C6 长消息展开/收起、E5 获取 API Key 外链
- **批次 2（任务管理）**：A9 置顶、A10 重命名、A11 删除、A12 移动到分组 —— 新增 RPC `session/rename|delete|pin`（meta.json 存 pinned/title）+ 任务项悬浮菜单
- **批次 3（列表治理）**：A13 归档、A14 显示更多/收起（列表分页）
- **批次 4（命令面板+重试）**：F2 Ctrl+K quickPick（新建任务/设置/切换侧栏/视图切换/模型切换）、C8 消息重试
- **批次 5（composer 进阶）**：B7 @ 文件引用、B8 排队后续输入
- **批次 6（深度能力）**：B6 推理强度（thinking 参数）、C7 编辑/恢复（会话回滚）、C9 消息级分叉、C11 权限作用域细化
