# BelieveBoy Mac

macOS 原生客户端（SwiftUI），复用现有 FastAPI 后端。

> **进度**：BEL-147 阶段 2 — 链路验证。已完成：
>
> - ✅ **S0** 工程骨架（`project.yml` + XcodeGen + Swift 5.10）
> - ✅ **S0.5** 设计雏形 v1（6 个关键屏幕 HTML 原型）
> - ✅ **S1** 登录 + 主导航接通 FastAPI（Keychain + `APIClient` + 45 个 `RouteHost` 占位）
> - ✅ **S2** 链路验证：抽出 `PageTemplate` 共用脚手架 + 两个示例页面（`SiteNavigationView`、`ExchangeRateView`）端到端走通
> - ⏳ **S3** 页面 fan-out（按 BEL-147 §三 顺序逐页替换 `RouteHost`）
> - ⏳ **S4** 打包 / 公证 CI / 分发
>
> 阶段 2 涉及的两个示例页面（站点导航、汇率信息）已在侧栏接通，路由 ID 与 web 端一一对应。S2 之后所有新增页面统一基于 `PageScaffold` 写，先填 `viewModel` / `title` / `state` / `content`，剩下的 loading / empty / error 状态机共用。

## 阶段 1 鉴权契约

后端没有用 JWT，也没有 `/api/v1/auth/refresh`。它用 Redis 滑动窗口的 session（`backend/app/services/infra/redis.py::write_session`），登录拿到 `session_id`，后续每次请求都发 `X-Session-Id` + `X-User-Id` + `X-User-Email` + ... 这组 header。具体看 `backend/app/api/v1/endpoints/auth.py::get_current_user`。

macOS 端的请求头镜像：

| Header | 取值 | 用途 |
|---|---|---|
| `X-API-Key` | `APIClient.defaultAPIKey`（dev 默认） | 后端 `require_api_key` 校验 |
| `X-User-Id` | `SessionContext.userId` | 后端 `get_request_user_id` |
| `X-User-Email` | URL-encoded `SessionContext.email` | 后端 user lookup |
| `X-User-Name` | URL-encoded `SessionContext.userName` | 日志/审计 |
| `X-Operator` | URL-encoded `SessionContext.operatorName` | 日志/审计 |
| `X-Role-Type` | `SessionContext.roleType` (`admin` / `operator` / `businessdev` / `factory`) | 后端角色判断 |
| `X-Is-Admin` | `"true"` if `SessionContext.isAdmin` | 后端 admin 短路 |
| `X-Session-Id` | `SessionContext.sessionId` | Redis 滑动窗口校验 |

详见 `Networking/APIClient.swift::applySessionContext` 和 `Auth/KeychainStore.swift`。

## 阶段 2 验证清单

阶段 2 的产物是「**共用脚手架 + 两个端到端示例页面**」：

| 文件 | 角色 | 端点 / 数据源 |
|---|---|---|
| `Routes/PageTemplate.swift` | 共用 `PageScaffold<Header,Content>` + `LoadingState` 枚举（loading / empty / error / loaded） | — |
| `Routes/SiteNavigationView.swift` | 最轻量页面：硬编码 7 个平台书签，验证 SwiftUI 卡片布局 + `NSWorkspace.open` 外链 | 静态数据，无后端调用 |
| `Routes/ExchangeRateView.swift` | 完整 CRUD + 分页 + 筛选 + sheet + multipart 上传，验证 `APIClient` 全链路 | `GET/POST/PUT/DELETE /api/v1/exchange-rates` + `POST /api/v1/exchange-rates/upload-image` |
| `Routes/ExchangeRateViewModel.swift` | 视图模型：`@MainActor`、分页状态机、`Sendable` DTO 边界 | — |

这两个页面在侧栏的 ID：

- `operations/site-navigation` → `运营导航 / 跨境平台书签导航`
- `data-management/exchange-rate` → `数据管理 / 汇率信息`

### 验证层级（从轻到重）

#### 验证层 A — 代码静态自检（任何机器 ✅）

```bash
# 1) S2 文件齐全
ls macos/BelieveBoyMac/Routes/{PageTemplate,SiteNavigationView,ExchangeRateView,ExchangeRateViewModel}.swift

# 2) 路由 ID 已注册到 SidebarGroup
grep -nE "site-navigation|exchange-rate" macos/BelieveBoyMac/Routes/RouteConfig.swift

# 3) 端点路径与后端真实路由一致
grep -nE "/api/v1/exchange-rates" macos/BelieveBoyMac/Routes/ExchangeRateViewModel.swift
grep -rnE "exchange-rates|exchange_rates" backend/app/api/v1/endpoints/ | head
```

#### 验证层 B — 后端先通（Linux / Mac ✅）

```bash
# 1) 健康检查（带约定的 X-API-Key）
curl -sS -H "X-API-Key: dev-shared-secret" \
     -o /dev/null -w "health=%{http_code}\n" \
     http://127.0.0.1:8000/api/v1/health

# 2) 登录拿 session_id
curl -sS -H "X-API-Key: dev-shared-secret" -H "Content-Type: application/json" \
     -d '{"username":"<账号>","password":"<密码>"}' \
     http://127.0.0.1:8000/api/v1/auth/login

# 3) 用拿到的 session_id 直接打汇率接口
curl -sS -H "X-API-Key: dev-shared-secret" \
     -H "X-User-Id: 1" -H "X-User-Email: <邮箱>" \
     -H "X-Role-Type: admin" -H "X-Is-Admin: true" \
     -H "X-Session-Id: <session_id>" \
     "http://127.0.0.1:8000/api/v1/exchange-rates?page=1&page_size=5"
```

若 B-3 直接返回 JSON，`ExchangeRateView` 用同样 header 调同样 URL 就**必然通**（这正是 S2 "链路验证" 想证明的事）。

#### 验证层 C — 在 macOS 上首次编译（必须 Mac 🛑）

```bash
brew install xcodegen          # 一次性
cd macos
xcodegen generate              # 产物：BelieveBoyMac.xcodeproj（不入 Git）

# 编译（比 ⌘R 更严格）
xcodebuild -project BelieveBoyMac.xcodeproj \
           -scheme BelieveBoyMac \
           -configuration Debug \
           -destination 'platform=macOS' \
           clean build | tail -50
```

> `project.yml` 启用了 `SWIFT_STRICT_CONCURRENCY: complete`，重点看 `Sendable` / `@MainActor` 警告 —— S2 新加的页面如果跨 actor 访问会在这里爆。

#### 验证层 D — 跑起来手测（必须 Mac + 眼睛 🛑）

1. 登录窗口 → admin 账号 → 跳到主窗口。
2. **站点导航**：7 张卡片渲染 → hover 放大阴影 → 点击任一卡片应**调起系统浏览器**（验 `NSWorkspace.open`，沙盒在 `entitlements` 里关掉）。
3. **汇率信息**：列表加载 → 分页 → 货币/年份/月份筛选触发重载 → 「新增汇率」→ 提交 → toast 成功；admin 可见编辑/删除，非 admin 隐藏。
4. **文件上传**：`FileImporter` 选 PNG → multipart 上传 → 行尾出现图片角标。
5. **错误态**：关掉后端 → 列表显示 `ContentUnavailableView` + 重试按钮（验 `PageScaffold.error` 分支）。
6. **401 短路**：等 session 过期 → 自动清 Keychain → 回登录页（验 `AppSession`）。

#### 验证层 E — 与 web 端做镜像回归

S2 两个页面是 `frontend/app/dashboard/operations/site-navigation` 与 `.../data-management/exchange-rate` 的**镜像（不共享）**。开 web 端放在旁边，按以下顺序逐屏对照：

| 对照项 | 关注点 |
|---|---|
| 卡片布局 | 平台卡片：渐变叠加、地区 pill、category 脚注、hover 抬升 |
| 字段顺序 | 汇率列表：货币徽章 → 货币名 → 时间 → 汇率 → 备注图片 → admin 操作 |
| 空态文案 | "暂无汇率数据" / "稍后再来或检查筛选条件" |
| 筛选器位置 | 货币 / 年份 / 月份三个 picker + 「重置」按钮 |
| 同一筛选下的数据条数 | 两边必须一致（这是 endpoint 漂移最容易暴露的地方） |

### S2 已知未做

- ❌ 截图自测（`screenshots/full-page-dark.png` 仅 S0.5 设计雏形，不覆盖 S2 实装页面）
- ❌ XCTest 单测（`ExchangeRateViewModel` 的分页状态机尤其值得加）
- ❌ XCUITest UI 测试
- ❌ Strict concurrency 警告清零

按 BEL-147 阶段 3+ 逐步填入。

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

- ❌ 真实业务页面（45 个侧栏项都是 `RouteHost` 占位）
- ❌ SwiftUI Charts 图表封装
- ❌ PDF / Excel 导入导出
- ❌ SSE 流式 AI Chat
- ❌ OpenAPI → Swift 自动生成
- ❌ XCTest 单测 + XCUITest UI 测试
- ❌ 打包 / 公证 CI

按 BEL-147 阶段 2–4 逐项填入。

## 参考资料

- [Apple — SwiftUI 教程](https://developer.apple.com/tutorials/swiftui-concepts)
- [Apple — NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview)
- [Apple — Keychain Services](https://developer.apple.com/documentation/security/keychain_services)
- [Apple — Swift Charts](https://developer.apple.com/charts/)
- [XcodeGen — 文档](https://github.com/yonaskolb/XcodeGen)
- 项目评估与路线图：[BEL-147](https://multica/issues/BEL-147)