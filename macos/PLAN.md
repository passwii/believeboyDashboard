# macOS 原生客户端（SwiftUI）— 选型与分 Stage 计划

> 状态：v1.1（2026-09-13 起草；同日随「Xcode 27.0 安装完成 + 生产直连实测 + key 轮换契约确认」修订 —— v1.0 的「本机无 Xcode」前提作废，见 §9，BLF-1041）
> 前身：`gui/`（Rust + GPUI，2026-08 方案，已在本 issue 整体删除）
> 权威来源：后端契约 = `backend/app/api/v1/`；导航权威 = `frontend/lib/sidebar-config.ts`

---

## 1. 结论摘要（决策一览）

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| App 形态 | 原生 macOS app，SwiftUI + AppKit 兜底（仅必要时） | 用户指定；Apple 平台一等公民，无跨平台抽象税 |
| 工程载体 | **Swift Package Manager**（`macos/Package.swift`），**不建 `.xcodeproj`** | SPM 可 `swift build` / `swift run` / `swift test`，Xcode 也能直接打开 `Package.swift`；`.xcodeproj` 的二进制 diff 与合并冲突对多分支协作是纯负债。**两条工具链（CLT / 完整 Xcode）都能构建**，见 §9 |
| 引导方式 | AppKit 引导（`NSApplication` + `NSHostingView`），**不用 `@main struct …: App`** | 属性包装器宏（`@State`/`@Bindable`/`@Environment`）只在完整 Xcode 的 `SwiftUIMacros` 插件里；AppKit 引导让这份代码在 CLT 下也能构建，顺带解决「SPM 可执行文件默认不是前台 App」。Xcode 装好后此约束可解除，但改写无功能收益（§9） |
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
- S1 用 AppKit 建单窗口（`NSWindow` + `NSHostingView`）；装 Xcode 后可切到 `WindowGroup` scene，**视图层不变**（见 §9 工具链约束）。目标形态是单窗口多栏，不是多窗口。
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
| --- | --- |
| UI 状态 | `@MainActor @Observable final class …Store`；视图只读 store，不直接发请求 |
| 网络层 | `struct APIClient: Sendable`（持 `URLSession` + `baseURL` + 凭据提供者），值语义无共享可变状态 |
| 凭据 | `CredentialStore` 协议 + `KeychainCredentialStore` 实现；API key 只经它读写 |
| 长任务 | 复用后端 Job 模型（`/api/v1/jobs`）轮询；桌面端用 `Task` + 退避，不用 Timer |
| 取消 | 视图 `task {}` 绑定生命周期；切换模块即取消上一模块的未完成请求 |
| 错误 | 统一 `APIError`（transport / http(status, body) / decoding / unauthorized），只在一处映射文案 |
| 超时 | 沿用 Web 代理的**分层超时表**（`frontend/lib/server/backend-proxy-timeout-policy.ts`）：流式=`RequestTier.unboundedTimeout`（见下）、报表=60s、AI=30s、统计=15s、详情=10s、列表=5s |

> **流式档「无超时」的实现口径**：`URLRequest` 没有"禁用超时"开关，**不写** `timeoutInterval` 只会拿到 Foundation 默认的 60s（SSE / NDJSON 数据间隙超 60s 即被掐断）。因此流式档显式写入 `RequestTier.unboundedTimeout`（365 天）作为「极大有限值」；真正的无限等待需靠会话级 `URLSessionConfiguration.timeoutIntervalForResource`（默认 7 天）兜底。

> 严格并发下 `URLSession`、`Decodable` 模型一律 `Sendable`；跨 actor 传递的响应模型全部 `struct` + `Sendable`。

---

## 4. 如何复用 `backend/` 现有 API（零后端改动）

### 4.1 连接与鉴权

| 项 | 值 |
| --- | --- |
| Base URL（生产） | `https://dash-api.believeboy.com` |
| Base URL（本地） | `http://127.0.0.1:8100`（`backend/run_api.sh`） |
| 路径前缀 | `/api/v1/...`（`app.include_router(api_router, prefix="/api/v1")`） |
| 鉴权头 | `X-API-Key: blf_…`（账号专属 key）或 `X-API-Key: <主 key>` |
| 用户上下文 | `X-Operator` / `X-User-Id` / `X-User-Name` / `X-Is-Admin` — 按账号可见性过滤（`/api/v1/projects/manage` 依赖 `X-Operator`） |
| 登录 | `POST /api/v1/auth/login`（email + password）→ `LoginResponse.api_key`（**每次登录轮换**，hash-only 存储） |
| 健康检查 | `GET /api/v1/health/live`（免鉴权，进程存活）/ `GET /api/v1/health/ready`（免鉴权）/ `GET /api/v1/health`（需鉴权，含 DB / 只读副本 / Redis / 环境名） |
| 鉴权失败语义 | 缺 key → **401** `{"detail":"Missing API key"}`；key 无效或已被轮换 → **403** `{"detail":"Invalid API key"}`（`backend/app/core/security.py:45-71`）—— 桌面端把 401/403 一律导向「重新登录」（见 §4.1.1） |

**为什么直连而不走 Web 代理**：`frontend/app/api/backend/[...path]/route.ts` 存在的原因是 Vercel 边缘不允许 Web 端持有主 key，且需要 NextAuth 会话。桌面端是可信本地进程，账号专属 key（BLF-711）就是为它准备的 —— 直连可去掉一跳代理与一层超时，同时保持同一套后端契约。

**代价（已确认）**：后端 CORS 白名单只放行 `settings.frontend_url`；桌面端是原生 URLSession 请求，**不受 CORS 约束**（CORS 是浏览器策略），因此无需后端改配置。

> ⚠️ **可用面边界**：`/api/v1/agent/*` 与 `/api/v1/internal/*` **不属这套鉴权** —— 该域要求 `Authorization` + `X-Agent-Id` 配对（给外部 Agent 用），带 `X-API-Key` 会得到 `401 AGENT_AUTH_FAILED`。桌面端只消费账号级业务路由：生产 `/api/v1/` 共 54 个一级路由家族，排除 `agent` 与 `internal` 后即为桌面端可用面（`ad-analysis` / `complaints` / `crm` / `inspections` / `inventory-*` 等）。**Stage 4+ 搬模块时不要把 agent 域端点接进来。**

#### 4.1.1 单设备 key：Web 登录会使桌面端 key 失效（S2 的硬约束）

`blf_` 账号 key 是**覆盖式轮换**，不是「每次登录追加一把」：

- `ensure_user_api_key`（`backend/app/services/user_api_key_service.py:69`）对每个账号**只维护一行** `user_api_keys`，命中已有行就覆写 `key_hash`，**旧 key 立即失效**；全仓库仅一个业务调用点：`POST /api/v1/auth/login`（`backend/app/api/v1/endpoints/auth.py:189`）。
- **桌面端不是唯一调用方** —— 这是问题所在：

| 触发路径 | 位置 | 对桌面端的影响 |
| --- | --- | --- |
| Web 端登录 | `frontend/lib/auth/options.ts:47` → `/api/v1/auth/login` | 覆写同一行 → 桌面端 Keychain 里的 key 立即失效 |
| Web 端改密码后的重认证 | `frontend/app/api/user/password/route.ts:36` → 同一端点 | 同上 |

- 失效后的表现：`resolve_user_key` 按 SHA-256 反查落空（`not_found`）→ `require_api_key` 落到末尾统一返回 **403 `Invalid API key`**（`revoked` 与 `not_found` 同语义）。

**桌面端必须按此设计（四条推论）**：

- 推论一：**App 绝不能内置/打包 key**，只能「登录换取 → 存 Keychain」（S2）。任何「预置 key」的方案都会在别人登录一次后失效。
- 推论二：**「401/403 一律导向重新登录」是 S2 的硬约束，不是体验优化** —— 只判 401 会漏掉最常发生的那条路径（用户当天在 Web 上登录过），用户会看到「无权限」却不知道要重新登录。`APIError.unauthorized` + `requiresCredentialFix` 就是这条契约的落点（`RootView` 对该信号给出重填/重登提示）。
- 推论三：同一账号在多台设备/多端同时使用会**互相顶掉**。「一账号多设备多把 key」是唯一可能需要动后端的点，**待 Yawei 拍板**（后端已声明：拍板前不改）。
- 推论四：S2 的「登录态保持」实际语义是「key 未被别处登录顶掉」——启动后第一次鉴权请求若 403，直接回登录页，不做无谓重试。

**本轮不改后端**：单设备轮换是 BLF-711 的有意设计（hash-only 存储 + 泄露面最小），客户端按「403 → 重新登录」即可完整覆盖。若运营侧实测反馈「Web 与桌面端来回登录过于频繁」，再**另开后端 issue** 评估多设备 key（同账号多行，或按 `client_id` 分区）；不夹带进本 issue。

**生产直连实测（2026-09-13，本机 → `https://dash-api.believeboy.com`）**：

| 场景 | 结果 |
| --- | --- |
| `GET /api/v1/health/live`（免鉴权，直接 curl） | 200 `{"status":"ok","timestamp":…}` |
| `GET /api/v1/health/ready`（免鉴权，直接 curl） | 200 `{"status":"ok","timestamp":…}` |
| `GET /api/v1/health`（不带 key，直接 curl） | 401 `{"detail":"Missing API key"}` |
| Kit 层 `HealthProbe.live` 无凭据 | 200，`liveError = nil` |
| Kit 层 `snapshot` 无凭据 | `live` ok → `healthError = .missingCredential`（**请求发出前拦截**，未产生 401 往返） |
| Kit 层 `snapshot` 持无效 key | `healthError = .unauthorized(status: 403, body: {"detail":"Invalid API key"})`，`requiresCredentialFix = true` → 文案「API key 被拒绝（HTTP 403）…」 |

即：**Stage 1 的连通性链路已在生产后端跑通**，无需本地起后端、无需 Next.js 代理、无需后端改动；带凭据的「全绿」路径要等 S2 登录拿到真实 `blf_` key 才能端到端复现。

### 4.2 端点面（Stage 4+ 逐模块启用）

模块清单以 `frontend/lib/sidebar-config.ts` 为唯一权威（8 组，二级项以该文件为准，此处不复制数量以免漂移）。当前端点全集见 `backend/app/api/v1/endpoints/`。

### 4.3 与旧 `gui/` 方案的知识继承

删除 `gui/` 但保留其**结论**（不保留代码）：Rust 侧 52 项侧栏收编 → 迁移为 `NavigationCatalog`；`gui-domain` 的 serde 模型 → 迁移为 Swift `Decodable` 模型，字段名与后端 Pydantic 模型 1:1（`snake_case` 用 `keyDecodingStrategy = .convertFromSnakeCase` 统一处理）。

---

## 5. 打包 / 签名 / 分发路线

| 阶段 | 产物 | 门槛 |
| --- | --- | --- |
| S1（已完成） | `swift run BelieveBoyMac` | `swift build` 即可，**无需 Xcode**（CLT 与完整 Xcode 均已实测通过）；`swift test` 需完整 Xcode（§9） |
| S2（已完成，BLF-1044） | 同上（登录后使用） | 同上；新增真后端轮换/账号上下文用例（默认 skip，配 `BELIEVEBOY_E2E_*` 启用） |
| S7a | `macos/scripts/make-app.sh` → `BelieveBoy.app`（ad-hoc 签名） | 本机 `codesign -s -`（工具链已随 Xcode 27.0 就绪） |
| S7b | Developer ID 签名 + `notarytool` 公证 + `.dmg` | **外部依赖：Apple Developer 账号（$99/年），当前缺失**。签名/公证工具链本身已就绪（`xcrun notarytool` 可解析，§9），缺的只是证书与账号 |
| S7c | Sparkle 2 自动更新（appcast） | 依赖 S7b |
| CI | GitHub Actions `macos-15` runner：`swift build` + `swift test`（runner 自带完整 Xcode，无需 `DEVELOPER_DIR`） | 仓库 secrets 无要求 |

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
├── Package.swift              # SPM 清单（Swift 6 / macOS 14）：3 个 target + 1 个 testTarget（需完整 Xcode，见 §9）
├── .gitignore                 # .build / .swiftpm / Package.resolved / dist
├── Tests/
│   └── BelieveBoyTests/       # XCTest：Kit 逻辑 + UI 状态机（离线，打桩 URLProtocol）
│                              #   S2 起同时覆盖 BelieveBoyUI（登录态状态机），故不再叫 *KitTests
└── Sources/
    ├── BelieveBoyKit/         # 纯逻辑层，不 import SwiftUI
    │   ├── AppConfig.swift        # baseURL / key / 环境（生产·本地）+ 环境变量覆盖
    │   ├── APIClient.swift        # 泛型 GET/POST + 分层超时表 + X-API-Key 与账号上下文注入
    │   ├── APIError.swift         # 错误分类 + 中文文案 + 是否需修凭据
    │   ├── AuthService.swift      # POST /auth/login → AuthSession（HTTP 语义→登录语义）
    │   ├── AuthError.swift        # 登录失败的分类与文案
    │   ├── CredentialStore.swift  # key 协议 + 只读环境变量实现 + 凭据三态判定
    │   ├── KeychainItem.swift     # kSecClassGenericPassword 条目 CRUD（key / 档案 / 「记住密码」三个条目共用）
    │   ├── KeychainCredentialStore.swift  # 账号专属 key（blf_）
    │   ├── SessionStore.swift     # 会话持久化协议（key + 账号档案）
    │   ├── KeychainSessionStore.swift     # 钥匙串实现：key + 档案（先档案后 key）
    │   ├── RememberedLogin.swift  # 「记住密码」协议 + 钥匙串实现（opt-in，与 key / 档案分槽）
    │   ├── HealthProbe.swift      # live / full / snapshot（两步语义）
    │   └── Models/
    │       ├── HealthModels.swift # /health 与 /health/live 响应
    │       └── AuthModels.swift   # LoginRequest/Response、AuthenticatedUser、AuthSession、UserContext
    ├── BelieveBoyUI/          # SwiftUI 视图 + 视图状态（可离屏渲染，不需启动 GUI）
    │   ├── AppModel.swift         # @MainActor @Observable：登录态 + 连接配置 + 健康检查
    │   ├── RootView.swift         # 按会话状态选页（restoring / 登录 / 主界面）+ 窗口尺寸切换
    │   ├── LoginView.swift        # 登录表单（窄栏居中，服务器选择默认折叠）
    │   ├── HealthView.swift       # 登录后的主界面（账号 + 后端地址 + 连接检查）
    │   └── ViewSupport.swift      # 显式 Binding 助手 + 共用小组件 + 窗口尺寸探针
    └── BelieveBoyMac/         # 进程引导（薄壳）
        ├── main.swift             # NSApplication + setActivationPolicy(.regular)
        └── BelieveBoyAppDelegate.swift  # 窗口 + 主菜单（⌘R / ⌘⇧L 退出登录 / ⌘Q / 编辑菜单）
```

分层铁律：`BelieveBoyMac → BelieveBoyUI → BelieveBoyKit`，**单向**；Kit 不 import SwiftUI（纯逻辑，可在 CLI/CI 复用）；UI 不依赖进程引导（可离屏渲染验证）。

> **旧计划项的当前状态**：`Tests/BelieveBoyTests/`（原 `BelieveBoyKitTests`，S2 起兼收 UI 状态机用例）当前 **77 个用例**（其中 2 个真后端用例默认 skip），`swift test` 需完整 Xcode，见 §9；`scripts/make-app.sh` 仍属 S7a。

---

## 8. Stage 计划

> 归属列写明「本 issue」或「后续单独开 issue」。本 issue（BLF-1041）只做 S0 + S1。

| Stage | 目标 | 可交付物 | 验收标准 | 依赖 | 归属 |
| --- | --- | --- | --- | --- | --- |
| **S0** | 仓库清场 | 删除 `gui/`、`docs/gui-mvp-plan.md`、`.github/workflows/gui-windows-build.yml`；新建 `macos/`、`windows/` | `git ls-files \| grep '^gui/'` 为空；无残留 CI 引用 | — | **本 issue** |
| S1 | 最小可运行骨架 | `macos/` SPM 工程（Kit + UI + 引导三层）：`AppConfig` + `APIClient` + Keychain 凭据 + 健康检查视图 + AppKit 引导与主菜单 + Kit 层 XCTest；`windows/README.md` 占位 | ① `swift build` 零错误（CLT 与完整 Xcode 两条工具链分别实测）；② Kit 层对真实后端端到端跑通（存活探针 / 鉴权探针 / snake_case 解码 / 缺凭据拦截 / 错误 key → 403 / 不可达 → transport / snapshot 短路）；③ App 启动建出窗口；④ 视图渲染出 `/health` 的 DB·副本·Redis·内存·环境名真实数据，失败态显示对应中文错误；⑤ `swift test` 11 用例全绿（需完整 Xcode，见 §9）；⑥ 生产直连验证见 §4.1 实测表 | S0 | 已完成（BLF-1041） |
| **S2** | 登录与会话 | 登录表单 → `POST /api/v1/auth/login` → `api_key` 入 Keychain；登录态保持、`X-Operator`/`X-User-Id`/`X-Is-Admin` 注入；401/403 自动回登录页；「记住密码」（钥匙串，opt-in） | 冷启动凭据有效直进主界面；**401/403（含被网页端/其他设备登录顶掉导致 key 失效）→ 明确再登录路径，不做无谓重试**；App 不内置任何 key；密码不落盘（仅勾选「记住密码」时入钥匙串，且从不进 `UserDefaults`/账号档案/日志）；登录页精简（无说明性段落，服务器选择默认折叠） | S1 | 已完成（BLF-1044） |
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
| --- | --- | --- |
| **两条工具链能力不同**（已实测，2026-09-13） | **Command Line Tools**（`xcode-select -p` = `/Library/Developer/CommandLineTools`）：① SwiftUI 属性包装器宏（`@State`/`@Bindable`/`@Environment`）不可用 —— 实现在 `SwiftUIMacros` 插件里，仅完整 Xcode 提供；② XCTest 与 swift-testing 均无法构建（缺 `XCTest` 模块 / `TestingMacros` 插件）。**完整 Xcode 27.0 (27A266a)**：宏与测试框架均可用。 | 不切 `xcode-select`（需 sudo，且改动全局默认工具链），改用 `DEVELOPER_DIR=<Xcode>/Contents/Developer` 按命令指定。**代码刻意选在两条工具链的交集**：引导用 AppKit、视图不用属性包装器 → `swift build` 在两条工具链下都通过（CLT 已实测），装了 Xcode 的人也不受影响。测试则明确**要求完整 Xcode**（`Tests/BelieveBoyTests/`，见 §8 S1/S2）；`swift build` 不编译 testTarget，故 CLT 用户无感。若日后要切 `@main App` + `@State`/`@Bindable`，属独立 issue 的可选简化（当前无功能收益）。**一并就绪的还有打包链路**：`xcrun notarytool` / `swift-format` / `simctl` 在完整 Xcode 下均可解析（license、first-launch 已通过），S7a/S7b 不再卡工具链。 |
| **Xcode 安装位置非标准**（外置卷） | 真身 `/Volumes/Rock/Xcode.app` = **Xcode 27.0（build `27A266a`，即 27.0 RC）**，macOS 27.0 SDK（`macosx27.0`）+ Swift 6.4；`/Applications/Xcode.app` 只是 **416K 转发壳**（`Contents/Resources/real_app_path.txt` → 真实路径），**不含 toolchain**。本机 `xcode-select -p` **仍指向 `/Library/Developer/CommandLineTools`**，纯净 shell 下 `xcodebuild` 依旧报 "requires Xcode" | 两条等价写法：① 一次性（需密码，**留给用户执行**）`sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer` —— **不能**指向 `/Applications/Xcode.app`（壳，无 `Contents/Developer`）；② 免 sudo、按命令生效（本仓库 CI/文档采用）：`DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer`。**外置卷未挂载时完整工具链不可用**（`swift test` 挂），CLT 路径仍可 `swift build`，代码不受影响。 |
| **桌面端 key 与网页端互踢**（覆盖式轮换，一账号同时只有一把） | 覆写同一行 `user_api_keys.key_hash`（`user_api_key_service.py:69`）→ 桌面端已存 key **立即失效**；调用方不止桌面端：Web 登录（`frontend/lib/auth/options.ts:47`）与改密码重认证（`frontend/app/api/user/password/route.ts:36`）都打 `POST /api/v1/auth/login`。失效表现为 **403 `Invalid API key`**（`security.py:45-71`），**不是 401** | 已定契约（详见 §4.1.1）：**App 不打包/不内置 key**；**401/403 一律走「请重新登录」而非静默失败**（`APIError.requiresCredentialFix`，已实测生产 403 → 该信号）—— 只判 401 会漏掉最常发生的路径。「一账号多设备多把 key」是**唯一**可能需要改后端的点，**待 Yawei 拍板**；在拍板前不改后端 |
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
