# bajin 下一轮持续改进计划

> 每轮从顶部取第一个未完成项实现；全部完成后基于用户反馈 + ZCode 差距生成新计划。

## 用户体验（用户反馈驱动）

- [ ] **Web 模式黑屏排查**：启动 `bajin server --port 4444` 后浏览器打开 localhost:4444，检查 DevTools Console 错误，定位 JS 运行时问题并修复
- [ ] **错误提示友好化**：技术错误（如 "fetch failed", "ECONNREFUSED"）转为用户可理解的中文提示 + 建议操作
- [ ] **快捷键面板**：按 `?` 或 `Ctrl+/` 弹出所有快捷键列表（对标 ZCode shortcut help）

## ZCode v3.8 差距

- [ ] **Process Monitor 面板**：系统进程监控（CPU/内存排行，对标 ZCode process-monitor）
- [ ] **附件预览弹窗**：点击附件 chip 弹窗显示文件内容（文本全文/图片信息）
- [ ] **会话内搜索**：Ctrl+F 在当前会话消息中高亮搜索（对标 ZCode conversationFind）

## 代码质量

- [ ] **Web 模式 e2e 测试**：Chrome headless 验证 UI 渲染 + RPC 交互 + SSE 事件流
- [ ] **性能基准**：启动时间 / 内存占用 / 首屏渲染时间测量与优化

## 部署体验

- [ ] **一键安装脚本**：`curl -fsSL https://raw.githubusercontent.com/fumolan/bajin/main/install.sh | sh`
- [ ] **自动更新检查**：AppImage 启动时检查 GitHub Releases 新版本并提示

---
*生成时间：2026-08-23 20:10*
