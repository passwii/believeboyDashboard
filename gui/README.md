# GUI — believeboyDashboard 桌面客户端（macOS 优先）

Rust + GPUI 桌面应用，复用现有 FastAPI 后端。Web 端（Next.js）继续保留，桌面端作为新的客户端形态并存。

## 目标

- 第一期只做 **macOS**（Apple Silicon 优先；Intel 兼容）
- 复用 `believeboyDashboard/backend` 现有 API，**零后端改动**
- 按 frontend sidebar 顺序逐个搬运：先 Dashboard 首页，再「运营 → 站点导航」

## 仓库布局

```
gui/
├── Cargo.toml              # workspace 根
├── rust-toolchain.toml     # 锁 Rust 版本
├── crates/
│   ├── gui-domain/         # 纯领域类型（serde 模型），无 IO 依赖
│   ├── gui-api-client/     # reqwest 封装，调后端 HTTP，依赖 gui-domain
│   └── gui-app/            # GPUI 应用入口、视图、状态、main
└── docs/
    └── mvp-plan.md         # 阶段计划（与根 docs/gui-mvp-plan.md 同步）
```

依赖方向：`gui-app` → `gui-api-client` → `gui-domain`（单向，不允许反向）。

## 开发

```bash
# 进入 gui/ 目录（不是仓库根）
cd gui

# 检查
cargo check

# 跑测试
cargo test

# 本地启动（macOS）
cargo run -p gui-app

# 打包 release
cargo build --release -p gui-app
```

## 打包 .app / .dmg（GUI-10）

```bash
cd gui

# 1) 打 .app（ad-hoc 签名，本机可运行）
./scripts/bundle.sh
# 2) 加 .dmg
./scripts/bundle.sh --dmg
# 3) 有 Apple Developer ID 时正式签名（--options runtime，供公证）
APPLE_SIGN_IDENTITY="Developer ID Application: 公司名 (TEAMID)" ./scripts/bundle.sh --dmg
```

产物在 `gui/dist/`：`BelieveBoy GUI.app` / `BelieveBoy GUI.dmg`。

- 应用图标：`python3 scripts/make-icon.py` 重新生成 `assets/AppIcon.icns`（Pillow，仅生成时需要）
- 正式分发（Gatekeeper 放行）需要 Developer ID 签名 + 公证：

```bash
# 一次：存公证凭据（Apple ID + App-Specific Password + Team ID）
xcrun notarytool store-credentials believeboy-gui \
  --apple-id 你的AppleID --team-id TEAMID \
  --password "App专用密码"

# 之后：公证 + staple（会等 Apple 服务器数分钟）
./scripts/notarize.sh            # 公证 dist/BelieveBoy GUI.app
./scripts/notarize.sh dist/xxx.dmg
```

> 说明：未用 cargo-bundle —— 它是 `cargo install` 的 subcommand，作为 dev-dependency 不提供
> `cargo bundle` 命令且 0.6 已停更；bundle.sh 手写组装 .app 零外部依赖、离线可用。
> CI 出 .dmg：`.github/workflows/release-macos.yml`（workflow_dispatch / tag `gui-v*`）。

## 配置文件

`gui-app` 启动时按以下顺序读取（当前仅实现环境变量；`config.toml` 为预留）：

1. 环境变量：`BELIEVEBOY_API_BASE`（API 地址，默认 `https://dash-api.believeboy.com`）、
   `BELIEVEBOY_TOKEN`（API key，可选——生产后端 dashboard 路由要求，同 Web 端 Vercel 代理
   `?api_key=` 的 key；桌面端直连后端，请求带 `Authorization: Bearer <key>`）
2. `~/.config/believeboy-gui/config.toml`（macOS 实际路径 `~/Library/Application Support/believeboy-gui/config.toml`，未实现，预留）

预留配置项：

```toml
api_base = "https://dash-api.believeboy.com"
api_key = ""
# 会话优先从 macOS Keychain 读取（service=believeboy-gui, account=default，存 LoginResponse JSON）
# 不建议把密码/会话写在配置文件里
```

## 鉴权模型（与 Web 端共用同一组 FastAPI 端点）

- `POST /api/v1/auth/login`：`{ email, password }` → `LoginResponse`（含 `session_id`）
- 后续请求带 `X-User-Id` / `X-User-Email` / `X-Session-Id` 三个 header（非 JWT）
- 会话由后端 Redis 滑动窗口续期，`GET /api/v1/auth/me` 每次调用即续期；**无 refresh token 端点**
- 登录成功后把 `LoginResponse` JSON 存入 macOS Keychain（service=`believeboy-gui`, account=`default`），
  重启自动恢复会话跳过登录；退出登录 / 会话失效时清除 Keychain 条目

## 与 Web 端的关系

- Web 端（Vercel 上的 Next.js）和桌面端**共用同一个 FastAPI 后端**
- 后端不感知客户端形态
- 桌面端不复制 Web 端的 `frontend/` 代码——只调后端 API、自己实现 UI
- 任何新加 API 必须同时考虑 Web 端兼容性

## 状态

- [x] 0.1 workspace 骨架（2026-08-14）
- [x] 0.2 鉴权（login → Keychain 存会话）（2026-08-14，BLF-674）
- [x] 0.3 sidebar 数据权威收编（GUI-3，2026-08-14）
- [ ] 1.0 Dashboard 首页（只读 MVP）
- [ ] 2.0 运营 → 站点导航
- [ ] 3.0 销售数据（日 / 周 / 复购等）
- [ ] ...  按 sidebar 顺序推进
