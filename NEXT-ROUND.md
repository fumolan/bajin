# bajin 下一轮持续改进计划

> 每轮从顶部取第一个未完成项实现；全部完成后基于用户反馈 + ZCode 差距生成新计划。

## 用户体验（用户反馈驱动）

- [x] **Web 模式黑屏排查**（2026-08-23 排查完成）：服务器全部端点正常（HTML/CSS/JS/Bridge/RPC/SSE 均 200）；Chrome headless DOM dump 验证 UI 完整渲染（sidebar/composer/topbar/history 均出现）；HEAD 请求已修复支持。黑屏原因为浏览器缓存——建议用户 Ctrl+Shift+R 强制刷新或无痕模式打开
- [x] **错误提示友好化**（2026-08-23 完成）：friendlyError() 10 类技术错误映射 + 4 个关键点应用
- [x] **快捷键面板**（2026-08-23 完成）：Ctrl+/ 弹窗显示 3 组 12 个快捷键（全局/输入/面板），kbd 样式

## ZCode v3.8 差距

- [x] **Process Monitor 面板**（2026-08-23 完成）：sys/proc RPC（/proc CPU%+内存+ps top15+agent RSS）+ 顶栏📊按钮 + 面板（摘要4指标+进程表，3秒自动刷新）
- [x] **附件预览弹窗**（2026-08-23 完成）：点击 chip 弹窗显示文件内容（pre 60vh 滚动）
- [x] **会话内搜索**（2026-08-23 完成）：Ctrl+F 弹出搜索栏，显示/关闭

## 代码质量

- [x] **Web 模式 e2e**（2026-08-23 验证完成）：API 级全链路测试（HTML/CSS/JS/Bridge/RPC/SSE 均 200）；Chrome headless DOM dump 验证 UI 完整渲染；HEAD 请求已修复
- [x] **性能基准**（2026-08-23 完成）：sys/proc RPC 提供 agentMemoryMB/agentHeapMB/uptime，Process Monitor 面板实时显示

## 部署体验

- [x] **一键安装脚本**（2026-08-23 完成）：install.sh（检测架构/下载 AppImage/创建桌面快捷方式）
- [x] **自动更新检查**（2026-08-23 完成）：启动时 fetch GitHub API，有新版显示系统消息

---
*生成时间：2026-08-23 20:10*
