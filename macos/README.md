# macOS 客户端（SwiftUI）

BelieveBoy Dashboard 的原生 macOS 客户端。**直连生产后端**（`https://dash-api.believeboy.com`），复用 `backend/` 现有 API，不改后端、不经 Next.js 代理。

- **技术路线 / stage 计划 / 工具链约束**：见 [PLAN.md](./PLAN.md)（权威）
- **当前进度**：Stage 0/1 —— 最小可运行骨架（能启动、能连后端健康检查）。业务模块未实现。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| macOS | 14.0+ | 基线由 `Package.swift` 的 `platforms` 锁定 |
| Swift | 6.0+ | `swift --version` 校验 |
| Xcode（构建/运行） | **不需要** | 仅 CLT 即可 `swift build` / `swift run`。本包刻意把代码定在「CLT 与完整 Xcode 的交集」上：视图不用 `@State` 等属性包装器（其宏实现在仅 Xcode 提供的 `SwiftUIMacros` 插件里），引导层用 AppKit |
| Xcode（跑测试） | **需要完整 Xcode** | `swift test` 需 XCTest，CLT 不含。本机真实安装在 `/Volumes/Rock/Xcode.app`（`/Applications/Xcode.app` 是转发壳），故：`DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test`。装了标准路径 Xcode 的机器直接 `swift test` 即可 |

## 运行

```bash
cd macos
swift build              # 编译（CLT 或 Xcode 工具链均可）
swift run BelieveBoyMac  # 启动（弹出窗口），默认连生产后端
```

窗口内操作：选后端地址（生产 / 本地 / 自定义）→ 填 API key →「保存到钥匙串」→「检查连接」（或 `⌘R`）。

需要指向本地后端时（本地调试后端用，非必需）：

```bash
BELIEVEBOY_BASE_URL=http://127.0.0.1:8100 \
BELIEVEBOY_API_KEY=<backend/.env 里的 API_KEY> \
swift run BelieveBoyMac
```

> 生产 API key **不在仓库里**：`blf_` key 由 `POST /api/v1/auth/login` 登录下发，**每次登录轮换、旧 key 立即失效、一个账号同时只有一把**。所以 App 不内置 key（S2 做登录），且 401/403 一律按「重新登录」处理 —— 网页端登录一次会让桌面端已存的 key 失效（详见 PLAN.md §4.1）。

## 验证

```bash
swift build      # 必须零错误（CLT / Xcode 两条工具链都过）
swift test       # 11 个用例；需完整 Xcode，用上面的 DEVELOPER_DIR 形式
curl -s https://dash-api.believeboy.com/api/v1/health/live   # 生产存活探针（免鉴权）
```

测试是**离线**的（`URLProtocol` 打桩，不碰真实网络）：健康探针两步语义、鉴权头只加在需鉴权请求上、缺凭据请求前拦截、403 → 「重新登录」信号、不可达 → 传输错误、配置解析与健康值判定边界。

浏览器/窗口截图之外的验证路径：`BelieveBoyUI` 是独立 target，可直接离屏渲染 ——
`NSHostingView(rootView: RootView(model:))` + `bitmapImageRepForCachingDisplay`，
无需启动 GUI 进程即可确认视图真实渲染结果。

## 配置项

| 环境变量 | 作用 |
|---|---|
| `BELIEVEBOY_BASE_URL` | 覆盖后端地址（默认 `https://dash-api.believeboy.com`） |
| `BELIEVEBOY_API_KEY` | 覆盖 API key 来源（默认读 macOS 钥匙串） |

## 目录

```
macos/
├── PLAN.md                     # 选型 + 架构 + stage 计划（权威文档）
├── Package.swift               # 三层 target + BelieveBoyKitTests
├── Tests/BelieveBoyKitTests/   # XCTest（离线打桩；需完整 Xcode）
└── Sources/
    ├── BelieveBoyKit/          # 纯逻辑：配置 / 网络 / 凭据 / 健康探针（不 import SwiftUI）
    ├── BelieveBoyUI/           # SwiftUI 视图 + AppModel（可离屏渲染）
    └── BelieveBoyMac/          # 进程引导（NSApplication + 窗口 + 菜单）
```

依赖方向 `BelieveBoyMac → BelieveBoyUI → BelieveBoyKit` 单向。
