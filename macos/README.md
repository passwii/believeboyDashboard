# macOS 客户端（SwiftUI）

BelieveBoy Dashboard 的原生 macOS 客户端。复用 `backend/`（FastAPI）现有 API，不改后端。

- **技术路线 / stage 计划 / 工具链约束**：见 [PLAN.md](./PLAN.md)（权威）
- **当前进度**：Stage 0/1 —— 最小可运行骨架（能启动、能连后端健康检查）。业务模块未实现。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| macOS | 14.0+ | 基线由 `Package.swift` 的 `platforms` 锁定 |
| Swift | 6.0+ | `swift --version` 校验 |
| Xcode | 可选（本机已装 27.0） | 仅 CLT 即可 `swift build` / `swift run`。完整 Xcode 27.0（27A266a）装在 `/Volumes/Rock/Xcode.app`，用于 `swift test`、签名/公证。⚠️ `/Applications/Xcode.app` 是跳转壳且 `xcode-select` 仍指向 CommandLineTools → 需 `sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer`，或临时 `DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer`（详见 PLAN.md §9） |

## 运行

```bash
cd macos
swift build              # 编译
swift run BelieveBoyMac  # 启动（弹出窗口）

# 指向本地后端而非生产
BELIEVEBOY_BASE_URL=http://127.0.0.1:8100 \
BELIEVEBOY_API_KEY=<backend/.env 里的 API_KEY> \
swift run BelieveBoyMac
```

窗口内操作：选后端地址（生产 / 本地 / 自定义）→ 填 API key →「保存到钥匙串」→「检查连接」（或 `⌘R`）。

## 验证

```bash
swift build                                    # 必须零错误（CLT 或完整 Xcode 均可）
curl -s $BASE/api/v1/health/live               # 后端存活（免鉴权，期望 200 {"status":"ok",...}）

# 用完整 Xcode 工具链复核（可选；测试 target 补齐后可加 swift test）
export DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer
xcodebuild -version                            # 期望 Xcode 27.0 / 27A266a
swift test                                     # Xcode 下 swift-testing 可用
```

鉴权探针（免凭据即可区分三类失败，实测语义见 PLAN.md §4.1）：
`/health` 无 key → `401 Missing API key`；错 key → `403 Invalid API key`；`/health/live` 无 key → `200`。

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
├── Package.swift               # 三层 target，暂无 testTarget
└── Sources/
    ├── BelieveBoyKit/          # 纯逻辑：配置 / 网络 / 凭据 / 健康探针（不 import SwiftUI）
    ├── BelieveBoyUI/           # SwiftUI 视图 + AppModel（可离屏渲染）
    └── BelieveBoyMac/          # 进程引导（NSApplication + 窗口 + 菜单）
```

依赖方向 `BelieveBoyMac → BelieveBoyUI → BelieveBoyKit` 单向。
