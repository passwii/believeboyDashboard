# BelieveBoy Mac

macOS 原生客户端（SwiftUI），复用现有 FastAPI 后端。

> **进度**：BEL-147 阶段 0 — 仅工程骨架与导航占位。所有路由暂以 `RouteHost` 占位页显示；阶段 1 起会按 BEL-147 §三 阶段 3 顺序逐页替换。

## 环境要求

| 工具 | 最低版本 | 用途 |
|------|----------|------|
| macOS | 14 (Sonoma) | 最低部署目标 |
| Xcode | 15.4+ | 编译 / 调试 |
| Swift | 5.10 | `macos/.swift-version` 锁定 |
| [XcodeGen](https://github.com/yonaskolb/XcodeGen) | 2.42+ | 由 `project.yml` 生成 `xcodeproj` |
| [Homebrew](https://brew.sh/) | latest | 安装 XcodeGen |

## 首次拉仓库 → 跑起来

```bash
# 1) 安装 XcodeGen（如尚未安装）
brew install xcodegen

# 2) 生成 Xcode 工程
cd macos
xcodegen generate
# 产物：macos/BelieveBoyMac.xcodeproj（已在 .gitignore 中）

# 3) 打开 Xcode
open BelieveBoyMac.xcodeproj

# 4) 在 Xcode 里选 scheme "BelieveBoyMac" + target "My Mac"，⌘R 跑起来
```

> **不要**手动 commit `.xcodeproj` 文件——`.gitignore` 已忽略，CI/同事都靠 `xcodegen generate` 重建。

## 配置后端地址

默认后端地址是 `http://127.0.0.1:8000`（参见 `BelieveBoyMac/Networking/APIClient.swift`）。
切到 staging 或生产环境：

1. 编辑 `BelieveBoyMac/Networking/APIClient.swift` 的 `APIClient.defaultBaseURL`，或
2. 后续 stage 会加进 `Config/*.xcconfig`，按编译配置切换。

后端**必须**在 macOS 能访问到的网络（本地或 VPS），并在 CORS/网络层允许该客户端。
当前后端的 `BACKEND_API_KEY` 与前端共用，macOS 端暂未启用 API Key 校验（开发阶段足够）。

## 目录约定

```
macos/
├── project.yml                          # XcodeGen 工程描述
├── README.md                            # 本文件
├── .swift-version                       # 锁 Swift 版本
├── BelieveBoyMac.xcodeproj/             # ⚠️ 由 xcodegen 生成，不入 Git
└── BelieveBoyMac/
    ├── App/                             # @main + 根视图
    ├── Auth/                            # AppSession / Keychain / LoginView
    ├── Networking/                      # APIClient
    ├── Models/                          # Codable DTO（最终由 OpenAPI 生成）
    ├── Components/                      # 通用 SwiftUI 组件
    ├── Routes/                          # 页面 + 侧栏
    │   ├── RouteConfig.swift            # 镜像 frontend/lib/sidebar-config.ts
    │   └── Sidebar.swift                # NavigationSplitView sidebar
    └── Resources/
        ├── Info.plist                   # 由 project.yml 生成
        ├── BelieveBoyMac.entitlements   # 沙盒/网络权限
        ├── Assets.xcassets/             # AppIcon + AccentColor
        └── Localizable/                 # 多语言（占位）
```

## 与现有仓库的关系

| 目录 | 角色 | 是否改动 |
|---|---|---|
| `frontend/` | 现有 Next.js web 端 | **不动**（macOS 端是平行入口） |
| `backend/`  | 现有 FastAPI 后端 | **不动**（macOS 端只调 `/api/v1/*`） |
| `autoReportUpload/` | 独立服务 | 不动 |
| `productEnvAgent/` | 部署脚本 | 不动 |
| `macos/` | 🆕 本目录 | 新增 |

## 侧栏与路由同步

侧栏配置（`BelieveBoyMac/Routes/RouteConfig.swift`）是
`frontend/lib/sidebar-config.ts` 的**镜像**——两份代码，两份维护，**不共享**。
修改 web 侧栏时，请同步修改 Swift 端，反之亦然。
后续如需自动化，建议改用 OpenAPI / 单一 YAML 源生成两边（见 [BEL-147 评论](https://multica/issues/BEL-147)）。

## 调试建议

- **断点**：直接 Xcode 断点即可。
- **网络请求**：`APIClient` 使用 `URLSession.shared`，可在 Xcode → Window → Devices and Simulators → Console 看日志。
- **Keychain**：`KeychainStore` 把 token 存在服务 `com.passwii.believeboy.macos.auth` 下，可在 Keychain Access.app 搜该 service 名调试。
- **角色预览**：`AppSession.preview` 静态属性用于 `#Preview`，强制以 `admin` 登录。

## 打包与公证（暂不实现，stage 4 再做）

```bash
# 出 Release 包
xcodebuild -project BelieveBoyMac.xcodeproj \
           -scheme BelieveBoyMac \
           -configuration Release \
           -derivedDataPath ./build \
           build

# 打成 DMG（用 create-dmg）
brew install create-dmg
create-dmg --volname "BelieveBoy Mac" \
           --window-size 540 380 \
           --icon-size 96 \
           ./dist/BelieveBoyMac.dmg \
           ./build/Build/Products/Release/BelieveBoyMac.app

# 公证
xcrun notarytool submit ./dist/BelieveBoyMac.dmg \
                       --keychain-profile "AC_PASSWORD" \
                       --wait
```

## 已知未做事项

- ❌ 实际登录鉴权流程（占位 LoginView）
- ❌ Token 自动刷新（401 retry）
- ❌ 真实页面实现（45 个侧栏项都是 `RouteHost` 占位）
- ❌ SwiftUI Charts 图表封装
- ❌ PDF / Excel 导入导出
- ❌ SSE 流式 AI Chat
- ❌ OpenAPI → Swift 自动生成
- ❌ XCTest 单测 + XCUITest UI 测试
- ❌ 打包 / 公证 CI

按 BEL-147 阶段 1–4 逐项填入。

## 参考资料

- [Apple — SwiftUI 教程](https://developer.apple.com/tutorials/swiftui-concepts)
- [Apple — NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview)
- [Apple — Keychain Services](https://developer.apple.com/documentation/security/keychain_services)
- [Apple — Swift Charts](https://developer.apple.com/charts/)
- [XcodeGen — 文档](https://github.com/yonaskolb/XcodeGen)
- 项目评估与路线图：[BEL-147](https://multica/issues/BEL-147)