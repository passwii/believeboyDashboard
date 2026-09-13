# macOS 原生客户端（SwiftUI）— 选型与分 Stage 计划

> 状态：v1.1（2026-09-13 起草；同日工具链复核更新：Xcode 27.0 已安装，v1.0 的「无 Xcode」前提作废，见 §9）
> 前身：`gui/`（Rust + GPUI，2026-08 方案，已在本 issue 整体删除）
> 权威来源：后端契约 = `backend/app/api/v1/`；导航权威 = `frontend/lib/sidebar-config.ts`

---

## 1. 结论摘要（决策一览）

| 议题 | 决策 | 理由 |
|---|---|---|
| App 形态 | 原生 macOS app，SwiftUI + AppKit 兜底（仅必要时） | 用户指定；Apple 平台一等公民，无跨平台抽象税 |
| 工程载体 | **Swift Package Manager**（`macos/Package.swift`），**不建 `.xcodeproj`** | SPM 工程 `swift build` / `swift run` 即可，Xcode 也能直接打开 `Package.swift`，本地与 CI 都省掉 `.xcodeproj` 的合并成本。此决策**不再受工具链限制**（Xcode 27.0 已装，`xcodebuild` 可用，见 §9）；`.xcodeproj` 只在 S7 确实需要 asset catalog / Interface Builder 时再评估 |
| 引导方式 | AppKit 引导（`NSApplication` + `NSHostingView`），**不用 `@main struct …: App`** | 定型于「仅 CLT」时期（当时 `@State` 等属性包装器宏不可用）。**该前提已于 2026-09-13 作废**：装 Xcode 27.0 后 `@main App` + `@State` 实测可编译（§9）。保留 AppKit 引导仍有独立价值 —— SPM 可执行文件默认不是前台 App，`setActivationPolicy(.regular)` 本就需显式设置；是否切回 `@main App` 列为 S2/S3 顺带项 |
| Swift 版本 | Swift 6 语言模式（`swift-tools-version: 6.0`），严格并发 | 新代码零历史包袱，一开始就吃并发检查；避免后期 `@unchecked Sendable` 蔓延 |
| macOS 基线 | **macOS 14 Sonoma** | `@Observable`（Observation 框架）与 `NavigationSplitView` 成熟形态的最低门槛；覆盖 2020 年后绝大多数在役 Mac |
| 窗口/导航 | 单窗口 `WindowGroup` + `NavigationSplitView` 三栏（侧栏 / 内容 / 详情） | 与 Web 端「8 大分组 → 二级页」两层结构同构，搬运成本最低 |
| 状态管理 | Observation（`@Observable` + `@MainActor` store），不引 TCA / Redux | 系统原生、零依赖；模块级 store 各自持有 loading/error，读写路径短 |
| 并发 | Swift 结构化并发：`async/await` + `Task` + actor 隔离；UI store 一律 `@MainActor` | 与后端「请求-响应 + 长任务轮询」模型对齐；取消语义天然可用 |
| 后端复用 | 直连 FastAPI，走 `X-API-Key`（登录下发的 `blf_` 账号专属 key），**不经 Next.js 代理** | BLF-711 就是为桌面端直连设计的（hash-only 存储、每次登录轮换）；代理层是 Web 的部署约束，不是协议约束 |
| 凭据存储 | macOS Keychain（Security framework），AccessGroup 默认 | 明文 token 落 `UserDefaults` 不可接受 |
| 分发 | 阶段化：本地 `swift run` → ad-hoc `.app` → Developer ID 签名 + 公证 → 自动更新 | 公证需要 Apple Developer 账号（当前无），是外部依赖而非技术选择 |
| 与 Web 端关系 | 第三形态客户端，**功能集以 Web 为超集**，桌面端按模块增量追赶 | Web 仍是唯一全功能端；桌面端不发明新能力，只做等价复用 |

---

## 2. App 形态与窗口 / 导航结构

### 2.1 形态

- **单窗口文档型应用**，不是菜单栏常驻工具，也不是多窗口 IDE。
- S1 用 AppKit 建单窗口（`NSWindow` + `NSHostingView`）。**Xcode 27.0 已装，`@main App` + `WindowGroup` scene 现已可用**（§9），切换时**视图层不变**；目标形态是单窗口多栏，不是多窗口。
- 后续可选加菜单栏常驻项（长任务/告警角标）与偏好设置窗口（`⌘,`），但**不作为 Stage 3 的必需项**。
- 原生窗口语义全部交给系统：`NavigationSplitView` 自动处理侧栏折叠、工具栏、`⌘⌥S`、全屏；不手写窗口 chrome。

### 2.2 导航（两层，与 `frontend/lib/sidebar-config.ts` 同构）

```
NavigationSplitView
├── sidebar    : 8 大分组（运营 / 报表中心 / 财务资金 / 广告 / AI 智能 / CRM / 工具箱 / 系统管理）
├── content    : 分组内的二级页列表（= SidebarSubItem）
└── detail     : 选中页面的内容区（模块视图）
```

- **权威对齐**：Swift 侧维护一份 `NavigationCatalog`（分组 + 二级项 + route id + 权限位），字段与 `frontend/lib/sidebar-config.ts` 一一对应；新增模块时两侧同步，**由 stage 验收清单检查条目数一致性**（不做代码生成，避免构建期耦合前端工具链）。
- 二级页首期全部渲染 `ModulePlaceholderView`（标题 + 对应后端端点 + 「未实现」状态），保证「可见即可见」：导航先立起来，模块逐个填。
- 命令面板（`⌘K`）与全局搜索属后续 stage；Web 端 `search-command` 的语义（跳转 + 最近访问）桌面端对齐。

### 2.3 状态机（每个模块视图统一三态）

```
idle → loading → (loaded | failed(APIError))
                     ↑____________ retry ____________|
```

`ModuleStore` 基类提供 `state` + `load()` + `Task` 取消；分页/筛选属于具体模块 store 的扩展点。

---

## 3. 状态管理与并发

| 关注点 | 约定 |
|---|---|
| UI 状态 | `@MainActor @Observable final class …Store`；视图只读 store，不直接发请求 |
| 网络层 | `struct APIClient: Sendable`（持 `URLSession` + `baseURL` + 凭据提供者），值语义无共享可变状态 |
| 凭据 | `CredentialStore` 协议 + `KeychainCredentialStore` 实现；API key 只经它读写 |
| 长任务 | 复用后端 Job 模型（`/api/v1/jobs`）轮询；桌面端用 `Task` + 退避，不用 Timer |
| 取消 | 视图 `task {}` 绑定生命周期；切换模块即取消上一模块的未完成请求 |
| 错误 | 统一 `APIError`（transport / http(status, body) / decoding / unauthorized），只在一处映射文案 |
| 超时 | 沿用 Web 代理的**分层超时表**（`frontend/lib/server/backend-proxy-timeout-policy.ts`）：流式=无限、报表=60s、AI=30s、统计=15s、详情=10s、列表=5s |

> 严格并发下 `URLSession`、`Decodable` 模型一律 `Sendable`；跨 actor 传递的响应模型全部 `struct` + `Sendable`。

---

## 4. 如何复用 `backend/` 现有 API（零后端改动）

### 4.1 连接与鉴权

| 项 | 值 |
|---|---|
| Base URL（生产） | `https://dash-api.believeboy.com` |
| Base URL（本地） | `http://127.0.0.1:8100`（`backend/run_api.sh`） |
| 路径前缀 | `/api/v1/...`（`app.include_router(api_router, prefix="/api/v1")`） |
| 鉴权头 | `X-API-Key: blf_…`（账号专属 key）或 `X-API-Key: <主 key>` |
| 用户上下文 | `X-Operator` / `X-User-Id` / `X-User-Name` / `X-Is-Admin` — 按账号可见性过滤（`/api/v1/projects/manage` 依赖 `X-Operator`） |
| 登录 | `POST /api/v1/auth/login`（email + password）→ `LoginResponse.api_key`（**每次登录轮换**，hash-only 存储） |
| 健康检查 | `GET /api/v1/health/live`（免鉴权，进程存活）/ `GET /api/v1/health/ready`（免鉴权）/ `GET /api/v1/health`（需鉴权，含 DB / 只读副本 / Redis / 环境名） |
| 鉴权失败语义 | 缺 key → **401** `{"detail":"Missing API key"}`；key 无效或已被轮换 → **403** `{"detail":"Invalid API key"}` —— 桌面端把 401/403 一律导向「重新登录」（S2） |

**为什么直连而不走 Web 代理**：`frontend/app/api/backend/[...path]/route.ts` 存在的原因是 Vercel 边缘不允许 Web 端持有主 key，且需要 NextAuth 会话。桌面端是可信本地进程，账号专属 key（BLF-711）就是为它准备的 —— 直连可去掉一跳代理与一层超时，同时保持同一套后端契约。

**代价（已确认）**：后端 CORS 白名单只放行 `settings.frontend_url`；桌面端是原生 URLSession 请求，**不受 CORS 约束**（CORS 是浏览器策略），因此无需后端改配置。

**生产直连实测（2026-09-13）**：`GET /api/v1/health/live` → `200 {"status":"ok",…}`（免鉴权）；`/health` 无 key → `401 Missing API key`；错 key → `403 Invalid API key`；`/api/v1/exchange-rates`、`/api/v1/digital-employees` 同为 401/403。账号级业务路由统一走 `X-API-Key`，「零后端改动直连生产」成立。

> ⚠️ **`/api/v1/agent/*` 与 `/api/v1/internal/*` 不属这套鉴权**：`/api/v1/agent/projects` 即使带 `X-API-Key` 也返回 `401 AGENT_AUTH_FAILED`（该域要求 `Authorization` + `X-Agent-Id` 配对，是给外部 Agent 用的）。桌面端只消费账号级业务路由 —— 生产 `/api/v1/` 共 54 个一级路由家族，排除 `agent` 与 `internal` 后即为桌面端可用面（`ad-analysis` / `complaints` / `crm` / `inspections` / `inventory-*` 等）。

#### 4.1.1 单设备 key：Web 登录会使桌面端 key 失效（S2 的硬约束）

`blf_` 账号 key 是**覆盖式轮换**，不是"每次登录追加一把"：

- `ensure_user_api_key`（`backend/app/services/user_api_key_service.py:69`）对每个账号**只维护一行** `user_api_keys`，命中已有行就覆写 `key_hash`，**旧 key 立即失效**；全仓库仅一个业务调用点：`POST /api/v1/auth/login`（`backend/app/api/v1/endpoints/auth.py:189`）。
- **桌面端不是唯一调用方** —— 这是问题所在：

| 触发路径 | 位置 | 对桌面端的影响 |
|---|---|---|
| Web 端登录 | `frontend/lib/auth/options.ts:47` → `/api/v1/auth/login` | 覆写同一行 → 桌面端 Keychain 里的 key 立即失效 |
| Web 端改密码后的重认证 | `frontend/app/api/user/password/route.ts:36` → 同一端点 | 同上 |

- 失效后的表现：`resolve_user_key` 按 SHA-256 反查落空（`not_found`）→ `require_api_key` 落到末尾统一返回 **403 `Invalid API key`**（`backend/app/core/security.py:45-71`；`revoked` 与 `not_found` 同语义）。

**因此"401/403 一律导向重新登录"是 S2 的硬约束，不是体验优化**：只在 401 时跳登录页会漏掉最常发生的那条路径（用户在 Web 上登录过），用户会看到"无权限"却不知道需要重新登录。

**本轮不改后端**（用户要求零后端改动）：单设备轮换是 BLF-711 的有意设计（hash-only 存储 + 泄露面最小），客户端按「403 → 重新登录」即可完整覆盖。若后续运营侧实测反馈"Web 与桌面端来回登录过于频繁"，再**另开后端 issue** 评估多设备 key（同账号多行，或按 `client_id` 分区）；该改动不属本 issue 范围，不得顺手夹带。

### 4.2 端点面（Stage 4+ 逐模块启用）

模块清单以 `frontend/lib/sidebar-config.ts` 为唯一权威（8 组，二级项以该文件为准，此处不复制数量以免漂移）。当前端点全集见 `backend/app/api/v1/endpoints/`。

### 4.3 与旧 `gui/` 方案的知识继承

删除 `gui/` 但保留其**结论**（不保留代码）：Rust 侧 52 项侧栏收编 → 迁移为 `NavigationCatalog`；`gui-domain` 的 serde 模型 → 迁移为 Swift `Decodable` 模型，字段名与后端 Pydantic 模型 1:1（`snake_case` 用 `keyDecodingStrategy = .convertFromSnakeCase` 统一处理）。

---

## 5. 打包 / 签名 / 分发路线

| 阶段 | 产物 | 门槛 |
|---|---|---|
| S1（当前） | `swift run BelieveBoyMac` | `swift build` 即可，**无需 Xcode**；Xcode 27.0 已装后 `swift test` 同样可用（§9） |
| S7a | `macos/scripts/make-app.sh` → `BelieveBoy.app`（ad-hoc 签名） | 本机 `codesign -s -`（工具链已随 Xcode 27.0 就绪） |
| S7b | Developer ID 签名 + `notarytool` 公证 + `.dmg` | **外部依赖：Apple Developer 账号（$99/年），当前缺失**。签名/公证工具链本身已就绪（`xcrun notarytool` 可解析，§9），缺的只是证书与账号 |
| S7c | Sparkle 2 自动更新（appcast） | 依赖 S7b |
| CI | GitHub Actions `macos-15` runner：`swift build`；补测试 target 后加 `swift test`（runner 自带 Xcode） | 仓库 secrets 无要求 |

> S7b 之前的分发形态是「ad-hoc `.app` + 手动分发」，其他 Mac 首次打开需右键打开绕过 Gatekeeper。这是可接受的过渡态，不是缺陷。

---

## 6. 与 Web 端（`frontend/`）的关系

- **不共享代码**（语言不同），共享**契约**：后端 API + `sidebar-config.ts` 导航语义。
- Web 端继续承担：全功能覆盖、浏览器可达、运营侧高频迭代。桌面端价值定位：常驻、原生交互（键盘优先、系统集成通知/菜单栏）、长任务后台化。
- 冲突处理规则：新增业务模块 → **先 Web 落地**（契约稳定）→ 再桌面端等价搬运。
- 桌面端**不修改** `frontend/`、`backend/`；缺后端能力时开子 issue 交后端。

---

## 7. 仓库布局

```
macos/
├── PLAN.md                    # 本文件
├── README.md                  # 开发/运行/验证速查
├── Package.swift              # SPM 清单（Swift 6 / macOS 14），暂无 testTarget（Xcode 27.0 已装，可补，见 §9）
├── .gitignore                 # .build / .swiftpm / Package.resolved / dist
└── Sources/
    ├── BelieveBoyKit/         # 纯逻辑层，不 import SwiftUI
    │   ├── AppConfig.swift        # baseURL / key / 环境（生产·本地）+ 环境变量覆盖
    │   ├── APIClient.swift        # 泛型 GET + 分层超时表 + X-API-Key 注入
    │   ├── APIError.swift         # 错误分类 + 中文文案 + 是否需修凭据
    │   ├── CredentialStore.swift  # 协议 + 只读环境变量实现
    │   ├── KeychainCredentialStore.swift
    │   ├── HealthProbe.swift      # live / full / snapshot（两步语义）
    │   └── Models/HealthModels.swift
    ├── BelieveBoyUI/          # SwiftUI 视图 + 视图状态（可离屏渲染，不需启动 GUI）
    │   ├── AppModel.swift         # @MainActor @Observable
    │   └── RootView.swift
    └── BelieveBoyMac/         # 进程引导（薄壳）
        ├── main.swift             # NSApplication + setActivationPolicy(.regular)
        └── BelieveBoyAppDelegate.swift  # 窗口 + 主菜单（⌘R / ⌘Q / 编辑菜单）
```

分层铁律：`BelieveBoyMac → BelieveBoyUI → BelieveBoyKit`，**单向**；Kit 不 import SwiftUI（纯逻辑，可在 CLI/CI 复用）；UI 不依赖进程引导（可离屏渲染验证）。

> **暂缓的计划项**：`Tests/BelieveBoyKitTests/` 在「仅 CLT」时期无法构建（XCTest / swift-testing 均缺宏插件）；**Xcode 27.0 已装且 `swift test` 实测可跑通（§9），该 testTarget 可原样补回**，列入 S2/S3 顺带项。`scripts/make-app.sh` 属 S7a，本 issue 不做。

---

## 8. Stage 计划

> 归属列写明「本 issue」或「后续单独开 issue」。本 issue（BLF-1041）只做 S0 + S1。

| Stage | 目标 | 可交付物 | 验收标准 | 依赖 | 归属 |
|---|---|---|---|---|---|
| **S0** | 仓库清场 | 删除 `gui/`、`docs/gui-mvp-plan.md`、`.github/workflows/gui-windows-build.yml`；新建 `macos/`、`windows/` | `git ls-files \| grep '^gui/'` 为空；无残留 CI 引用 | — | **本 issue** |
| **S1** | 最小可运行骨架 | `macos/` SPM 工程（Kit + UI + 引导三层）：`AppConfig` + `APIClient` + Keychain 凭据 + 健康检查视图 + AppKit 引导与主菜单；`windows/README.md` 占位 | ① `swift build` 零错误；② Kit 层对真实后端端到端跑通（存活探针 / 鉴权探针 / snake_case 解码 / 缺凭据拦截 / 错误 key → 403 / 不可达 → transport / snapshot 短路）；③ App 启动建出窗口；④ 视图渲染出 `/health` 的 DB·副本·Redis·内存·环境名真实数据，失败态显示对应中文错误。**v1.0 起草时因本机无 Xcode 而不含 `swift test`；Xcode 27.0 已装，测试 target 现可补（见 §9）** | S0 | **本 issue** |
| **S2** | 登录与会话 | 登录表单 → `POST /api/v1/auth/login` → `api_key` 入 Keychain；登录态保持、`X-Operator`/`X-User-Id`/`X-Is-Admin` 注入；401/403 自动回登录页 | 冷启动凭据有效直进主界面；key 失效有明确再登录路径；密码不落盘 | S1 | 后续 issue |
| **S3** | 应用外壳与导航 | `NavigationCatalog`（对齐 `sidebar-config.ts`）+ `NavigationSplitView` 三栏 + 模块占位视图 + 偏好设置（base URL 切 生产/本地） | 8 分组与二级项条目数与 `sidebar-config.ts` 一致；切换模块无泄漏 Task；窗口尺寸/侧栏折叠状态恢复 | S2 | 后续 issue |
| **S4** | 首个真实业务模块 | 「运营 → 数据流总览」只读页（对齐 Web dashboard 首页信息密度） | 数据与 Web 同源同值（抽样比对）；加载/空/错误三态齐备；列表超时 5s / 统计 15s 分层生效 | S3 | 后续 issue |
| **S5** | 业务模块分批搬运 | 按分组切片，每批 1 组（运营 → 报表中心 → 财务 → 广告 → AI → CRM → 工具箱 → 系统） | 每组：端点覆盖对照表 + 抽样数值与 Web 一致 + 该组内只读能力 100% 可达 | S4 | 后续多个 issue（每组一个） |
| **S6** | 写操作与确认流程 | 写端点接入 + 二次确认 UI + 操作审计提示（对齐 Web confirm 语义） | 写操作有确认、有失败回滚提示、有审计可查；破坏性操作默认不可一键完成 | S5 | 后续 issue（按需） |
| **S7** | 打包 / 签名 / 公证 / 分发 | `make-app.sh`（.app）→ Developer ID 签名 + 公证 + `.dmg` → GitHub Actions 构建流水线 | 干净 Mac 上双击可开（无 Gatekeeper 警告）；`spctl -a` 通过；公证 ticket 可 staple | **Apple Developer 账号（外部阻塞）**；S3 | 后续 issue |
| **S8** | 自动更新与系统集成 | Sparkle appcast；菜单栏角标（告警/长任务）；系统通知 | 旧版本可收到新版本提示并完成升级；通知点击可深链到对应模块 | S7 | 后续 issue（可选） |

### 8.1 依赖顺序（关键路径）

```
S0 → S1 → S2 → S3 → S4 → S5(×8) → S6
                              ↘ S7 → S8
```

- S7 的**代码**部分（打包脚本、CI）不依赖 S3 之后的业务进度，可以提前；但**签名/公证**卡在 Apple Developer 账号上。
- S5 的 8 个分组互相独立，可并行开 issue（注意：同一 `Package.swift` 与 `NavigationCatalog` 是共享编辑点，并行时由人工串行合并）。

### 8.2 本 issue 明确不做

- 登录流程（S2）、三栏导航外壳（S3）、任何真实业务数据模块（S4+）。
- Windows 实现（`windows/` 仅占位 + 路线待定）。
- 对 `frontend/`、`backend/` 的任何修改。

---

## 9. 风险与未决事项

| 项 | 影响 | 处置 |
|---|---|---|
| **工具链现状（2026-09-13 复核：Xcode 已装，v1.0「无 Xcode」前提作废）** | Xcode **27.0（build `27A266a`，即 27.0 RC）** 已装于 **`/Volumes/Rock/Xcode.app`** —— macOS 27.0 SDK（`macosx27.0`）、Swift 6.4。`/Applications/Xcode.app` 是 **416K 跳转壳**（`Contents/Resources/real_app_path.txt` → `/Volumes/Rock/Xcode.app`），**不含 toolchain**，所以 `xcode-select` 不能指向它。<br>⚠️ 该机 `xcode-select -p` **仍指向 `/Library/Developer/CommandLineTools`**，纯净 shell 下 `xcodebuild` 依旧报 `requires Xcode`；需一条要密码的 sudo：<br>`sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer`<br>免 sudo 等价写法：`export DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer` | **已实测解锁**：① `@main struct …: App` + `@State` 可编译；② `swift test` + swift-testing 可跑通（`✔ Test sanity() passed`）；③ `notarytool` / `swift-format` / `simctl` 可解析，license 与 first-launch 检查已通过。现有 `Sources/` 在 Xcode 工具链下 `swift build` 同样零错误 —— **属兼容，不是过期**，故不阻塞交付。<br>**顺带项（不阻塞 S1 验收）**：视图加回 `@State`/`@Bindable`、引导切回 `@main App`、补 `Tests/BelieveBoyKitTests/`。<br>**新约束**：安装落在 `/Volumes/Rock`（内盘仅约 26G 空闲，装不下），**Rock 未挂载即失效**；脚本与 CI 不得硬编码该路径，需能回退 CLT |
| Apple Developer 账号缺失 | S7b/S7c 无法推进 | 需用户决策（是否购买）；在此之前以 ad-hoc `.app` 分发 |
| 后端 CORS 白名单不含桌面端 | 无影响（原生请求无 CORS） | 记录结论，不申请后端改动 |
| 无 WebSocket / 推送 | 桌面端实时性只能轮询 | 轮询 + 退避即可满足当前需求；若需推送，另开后端 issue |
| Windows 路线未定 | 无法给出工期 | 见 `windows/README.md`，等 macOS 端跑通后再决策 |
| 旧 `gui/` 文档遗留引用 | 读者可能误以为桌面端仍是 Rust 方案 | 已在 `docs/terminal-design/design-review.md`、`docs/terminal-design/master-prompt.md`、`docs/superpowers/specs/2026-09-02-agent-platform-inspection-api.md` 三处加废弃标注；`backend/`（模型 docstring、迁移注释）与 `frontend/lib/server/changelog.ts` 的历史条目属历史记录、**按约束不改**，见交付报告 |

---

## 10. 文档与约束

- 提交 author email 固定 `jr.way123@gmail.com`（BEL-153，Vercel 部署校验）。
- 迁移命名/单 head 规则与 `AGENTS.md` 一致；本目录不产生数据库迁移。
- 本 issue 不改 `frontend/` 与 `backend/`。
