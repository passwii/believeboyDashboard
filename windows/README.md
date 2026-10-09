# Windows 客户端 — MyGo 后续阶段

**状态：尚无实现代码。** 桌面技术路线已选 MyGo；当前先替换 macOS 客户端，Windows（以及其他平台）留待 macOS 版跑通后再启动。

## 启动条件

1. macOS MyGo 版完成首批真实业务流程和分发验证。
2. 明确 Windows 用户场景、目标范围和验收标准。
3. 配备 Windows CI/验证环境；当前开发机为 macOS，不能把未验证的 Windows 构建当作已交付。

跨平台阶段应优先复用同一套 MyGo + Web 前端实现，并逐项验证 Windows WebView2 与 macOS WKWebView 的认证、流式响应、文件读写和打包差异。
