# Windows 客户端 — 占位（技术路线待定）

**状态：占位目录，无实现代码。** 本目录在 BLF-1041 中仅建立，用于承载后续 Windows 桌面端决策。

## 为什么现在不写实现

1. 用户明确要求「第一步只做 macOS」，Windows 不进入本阶段交付。
2. 技术路线尚未决策 —— 见下方候选，选型前动手就是返工。
3. **当前开发机为 macOS，无 Windows 环境**，无法本地构建/运行验证；任何 Windows 实现都会是「未验证代码」，不符合交付标准。

## 候选路线（待评估，非结论）

| 路线 | 优势 | 代价 | 复用 macOS 端代码 |
|---|---|---|---|
| WinUI 3 / .NET (C#) | 微软官方原生栈，系统集成最好 | 与 macOS 端完全两套代码；需 Windows 开发环境 | 否（仅共享后端契约） |
| Tauri 2（Rust + WebView） | 可复用 `frontend/` 的 Web 资产；体积小 | 引入 WebView 渲染差异；仍依赖 Rust 工具链 | 否 |
| Flutter (desktop) | 一套代码覆盖 macOS/Windows | 放弃原生外观（与用户「原生 app」诉求冲突） | 否 |
| Electron | 生态成熟、复用 Web 最快 | 体积/内存开销最大，非原生 | 否 |

## 决策前置条件（满足后再开 issue）

- [ ] macOS 端至少推进到 S4（首个真实业务模块跑通），验证契约复用方式可行；
- [ ] 明确 Windows 端的目标用户与优先级（是否真有 Windows 用户诉求）；
- [ ] 一台可用的 Windows 开发/CI 环境（本机虚拟机或 GitHub Actions `windows-latest`）。

在此之前，本目录**不新增任何文件**。
