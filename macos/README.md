# macOS 客户端（SwiftUI）

BelieveBoy Dashboard 的原生 macOS 客户端。**直连生产后端**（`https://dash-api.believeboy.com`），复用 `backend/` 现有 API，不改后端、不经 Next.js 代理。

- **技术路线 / stage 计划 / 工具链约束**：见 [PLAN.md](./PLAN.md)（权威）
- **当前进度**：Stage 0/1/2/3 —— 骨架 + 登录与会话 + **应用外壳与导航**（三栏：8 个分组 → 56 个二级项 → 模块占位视图）。业务模块本身未实现（S4 起逐个搬）。

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| macOS | 14.0+ | 基线由 `Package.swift` 的 `platforms` 锁定 |
| Swift | 6.0+ | `swift --version` 校验 |
| Xcode（构建/运行） | **不需要** | 仅 CLT 即可 `swift build` / `swift run`。本包刻意把代码定在「CLT 与完整 Xcode 的交集」上：视图不用 `@State` 等属性包装器（其宏实现在仅 Xcode 提供的 `SwiftUIMacros` 插件里），引导层用 AppKit |
| Xcode（跑测试 / 签名公证） | **需要完整 Xcode** | `swift test` 需 XCTest，CLT 不含。本机装的是 **Xcode 27.0（27A266a）**，真身在 `/Volumes/Rock/Xcode.app`（`/Applications/Xcode.app` 只是 416K 转发壳且不含 toolchain，`xcode-select` **不能**指向它），故：`DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test`；或一次性 `sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer`（需密码）。装了标准路径 Xcode 的机器直接 `swift test` 即可。`notarytool` / `codesign` 随该 Xcode 就绪，S7 打包不再卡工具链 |

## 运行

```bash
cd macos
swift build              # 编译（CLT 或 Xcode 工具链均可）
swift run BelieveBoyMac  # 启动（弹出窗口），默认连生产后端
```

窗口内操作：填邮箱 + 密码 →「登录」→ 进主界面，自动跑一次连接检查（或 `⌘R` 手动重跑，`⌘⇧L` 退出登录）。

登录后是三栏外壳（与 Web 端侧栏同构）：

- **侧栏**：8 个分组（运营 / 报表中心 / 财务资金 / 广告 / AI 智能 / CRM / 工具箱 / 系统管理）——条目与顺序以 `frontend/lib/sidebar-config.ts` 为准；
- **内容栏**：所选分组下的二级项（共 56 项）；
- **详情栏**：选中项的**占位视图**（分组 + 标题 + 对应 Web 路由 + 「未实现」）。占位视图**不发任何请求**，也**不列后端端点** —— 端点映射逐模块核对，S4 起随模块落地；CRM「待跟进」在 Web 上有动态徽标，占位期只保留语义位、不显示编造的数字；
- **未选分组时**详情栏是「连接与身份」概览（账号 + 连接检查），工具栏「连接与身份」可随时回来；
- **偏好设置**（工具栏齿轮 或 `⌘,`）：后端地址 生产 / 本地 + 自定义地址（与登录页页脚同一块 UI，只是收编到外壳里）；
- 侧栏折叠（`⌘⌥S` 或拖分栏线）与**窗口尺寸**在下次启动时恢复：落盘的选中项、折叠态、窗口 frame 存在 `UserDefaults` 的 `shell.preferences.v1`（一条 JSON；**不含任何凭据**）。落盘内容会被清洗：条目已不在 catalog、尺寸不合理、窗口坐标跑到屏幕外（拔显示器）都会退回默认，不会“启动了但看不见”。

登录页默认只有表单与一个「记住密码」勾选框：

- **服务器选择默认折叠**在页脚（`服务器：生产 ⌄`），本地调试才需要展开 —— 常态就是生产地址，不该与主操作抢层级（HIG《Disclosure controls》：高级项默认隐藏）。
- **「记住密码」默认关**。勾上后，邮箱与密码在**登录成功时**写入钥匙串（`remembered-login` 条目，与 key、账号档案分槽），下次回到登录页自动回填，**但不会自动提交** —— 理由见下。取消勾选即删掉已存凭据。
- 页面上不再有说明性段落：解释性内容收进折叠区、脚注或本文档；页面只留「为什么回到登录页」与「登录为什么失败」两类必需的提示。

登录下发的 `blf_` key 存入 macOS 钥匙串，下次启动直接进主界面（不闪登录页）。
不需登录的无人值守场景（开发 / CI / 无 GUI 排查）可以给环境变量凭据绕过登录页
（只有 key、没有账号档案，因此**不发** `X-Operator` 一族请求头）：

```bash
BELIEVEBOY_BASE_URL=http://127.0.0.1:8100 \
BELIEVEBOY_API_KEY=<backend/.env 里的 API_KEY> \
swift run BelieveBoyMac
```

> 注：环境变量凭据的优先级**高于**钥匙串会话（保持 S1 的「进程级只读覆盖」语义）。
> 要用登录态就把 `BELIEVEBOY_API_KEY` 去掉。

### 登录态为什么会失效（不是 bug）

`blf_` 账号 key 是**覆盖式轮换**：一个账号同时只有一把。**网页端登录**
（`frontend/lib/auth/options.ts:47`）与**改密码后的重认证**
（`frontend/app/api/user/password/route.ts:36`）打的是同一个 `POST /api/v1/auth/login`，
一旦发生就会覆写 `user_api_keys.key_hash`（`backend/app/services/user_api_key_service.py`），
**桌面端手里那把立刻失效**。

失效的表现是 **403 `{"detail":"Invalid API key"}`**（`backend/app/core/security.py`），
**不是 401** —— 所以只判 401 会漏掉最常见的这条路径。桌面端的处理：

- 401/403 一律回到登录页，并说明「可能已在网页端或其他设备重新登录」；
- **不做重试**（重试只会再拿一个 403），并把已失效的 key 从钥匙串清掉；
- 传输失败（后端不可达）**不算**凭据问题，留在主界面显示连接错误。

「一账号多设备多把 key」需后端改动，是独立决策（详见 PLAN.md §4.1.1），本轮不改后端。

**「记住密码」只回填、不自动登录**：桌面端登录会轮换同一账号的 key，自动提交等于把用户
刚在网页端建立的会话顶掉 —— 那就成了「桌面端踢网页端 → 用户网页端重登 → 又踢回桌面端」
的互踢循环（PLAN §4.1.1 推论三）。所以记住的凭据只用于预填表单，是否承担这个代价由用户
点一下「登录」决定。真正的解法是「一账号多设备多把 key」（后端决策，见上）。

> 生产 API key **不在仓库里**，App 也**不内置任何 key**：`blf_` key 只能由
> `POST /api/v1/auth/login` 登录换取，**每次登录轮换、旧 key 立即失效、一个账号同时只有一把**。
> 密码只随登录请求发一次（不进日志）；key 与账号档案存 macOS 钥匙串；
> **密码只有勾上「记住密码」时才进钥匙串**，且从不进 `UserDefaults`、账号档案或日志。

## 验证

```bash
swift build      # 必须零错误（CLT / Xcode 两条工具链都过）
swift test       # 128 个用例（2 个真后端用例默认 skip）；需完整 Xcode，用上面的 DEVELOPER_DIR 形式
curl -s https://dash-api.believeboy.com/api/v1/health/live   # 生产存活探针（免鉴权，200）
curl -s https://dash-api.believeboy.com/api/v1/health/ready  # 就绪探针（免鉴权，200）
curl -s -i https://dash-api.believeboy.com/api/v1/health     # 无 key → 401 Missing API key
```

### 导航条目数对照（人工，不做代码生成）

`NavigationCatalog` 是 `frontend/lib/sidebar-config.ts` 的 Swift 等价物，跨仓库一致性按
PLAN §2.2 仍是**人工对照** —— 改那边就顺手跑这两条命令，并对照 Swift 侧快照用例
（`NavigationCatalogTests`：8 组 / 56 项 / 各组条目数 / 18 处 `matchPrefixes`）：

```bash
grep -c "^    id: '" frontend/lib/sidebar-config.ts                  # 8 个分组
grep -c "matchPrefixes: \[" frontend/lib/sidebar-config.ts         # 18 处前缀匹配
```

### 真后端端到端（轮换 / 账号上下文）

`Tests/BelieveBoyTests/LiveRotationTests.swift` 里有两条**默认 skip** 的用例，用来钉住
服务端事实（打桩只能证明客户端行为，证明不了「同账号二次登录真的会让第一把 key 变 403」）。
**不要用生产真人账号跑**——登录会轮换该账号的 key，把同事的网页端会话踢掉。用本地后端 + 测试库：

```bash
# 1) 后端指向测试库（账号见 backend/scripts/agent_testing/README.md）
cd backend
TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env.test | cut -d= -f2-)" \
  uvicorn app.main:app --port 8000

# 2) 另开终端跑真后端用例（含非管理员账号，验证 X-Operator 注入）
cd macos
BELIEVEBOY_E2E_BASE_URL=http://127.0.0.1:8000 \
BELIEVEBOY_E2E_EMAIL=test_admin@believeboy.com \
BELIEVEBOY_E2E_PASSWORD="$(grep '^TEST_ADMIN_PASSWORD=' ../backend/.env.test | cut -d= -f2-)" \
BELIEVEBOY_E2E_OPERATOR_EMAIL=test_operator@believeboy.com \
BELIEVEBOY_E2E_OPERATOR_PASSWORD="$(grep '^TEST_OPERATOR_PASSWORD=' ../backend/.env.test | cut -d= -f2-)" \
DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test --filter LiveRotationTests
```

> 后端登录有限流（IP 10 次 / 15 分钟）。反复手测撞到 **429** 时，清一下计数器即可：
> `redis-cli DEL "bb:ratelimit:login_ip:127.0.0.1"`。

鉴权失败语义（`backend/app/core/security.py`）：缺 key → **401** `{"detail":"Missing API key"}`；key 无效或已被轮换 → **403** `{"detail":"Invalid API key"}`。桌面端把两者**都**导向「重新登录」。

> `/api/v1/agent/*` 与 `/api/v1/internal/*` **不属 `X-API-Key` 鉴权**（要求 `Authorization` + `X-Agent-Id`），桌面端不要用。

测试是**离线**的（`URLProtocol` 打桩，不碰真实网络）：健康探针两步语义、鉴权头只加在需鉴权请求上、缺凭据请求前拦截、403 → 「重新登录」信号、不可达 → 传输错误、配置解析、**总体/分项健康判定**（`degraded` 明细、Redis 内存 `unavailable`/`unknown`/未配置）、**超时分档真实落到请求上**、**base URL 根地址校验**、**凭据三态**（有 / 没配 / 读失败）。

S2 新增用例：**登录请求形状**（POST / 无凭据头 / JSON 体 / 邮箱 trim 而密码原样）、**响应解码**（snake_case、`role_type` 兜底）、**失败分类**（401 密码错 / 401 账号停用 / 429 限流 / 200 但 `api_key` 为空）、**账号上下文注入**（`X-Operator` 中文 percent-encoding、非管理员显式 `false`、无档案时不发）、**登录态状态机**（冷启动直进主界面且零网络往返、登录成功入库、401/403 回登录页且不重试、轮换后重新登录即自愈、传输失败不登出、并发点登录只发一次）、**密码不落盘**、**真钥匙串往返**。

S2 UI 精简新增用例：**「记住密码」默认关**（未勾选时一个字节都不写）、**登录成功才写**（勾选当下不写、失败不写）、**取消勾选即删**、**403 被顶掉后凭据仍预填**（一次点击即可重登）、**登出不删「记住密码」**、**密码不进 `UserDefaults` 与账号档案**、**「记住密码」读写失败只提示、不挡登录**、**服务器选择默认折叠**，以及 `RememberedLoginTests` 的真钥匙串往返与「条目写坏 → 当没记住」。

S3 新增用例：**导航快照**（8 组 / 56 项 / 各组条目数 / 18 处 `matchPrefixes` / route id 唯一 / 分组归属看条目位置而非路由前缀）、**高亮语义**（`/dashboard` 精确匹配特例、前缀匹配点亮子路径、无前缀条目不被兄弟子路径误亮）、**动态徽标语义位**（只有 CRM「待跟进」带 `requiresLiveData`）、**外壳状态恢复**（选中项 / 折叠态 / 窗口尺寸落盘往返；旧条目被删则退回概览；尺寸不合理或坐标在屏幕外则丢弃并居中）、**切换模块不残留任务**（`ModuleTaskScope` 取消上一个 route 的任务、同 key 重跑先取消、概览任务也会被收掉）、**离屏渲染**（三栏外壳真画出内容，且占位视图**零请求**）。

浏览器/窗口截图之外的验证路径：`BelieveBoyUI` 是独立 target，可离屏渲染 ——
`NSHostingView(rootView: RootView(model:))` + `bitmapImageRepForCachingDisplay`，
无需启动 GUI 进程即可确认视图真实渲染结果。

> **注意**：离屏缓存出来的 PNG 背景是**透明**的，浅色外观下黑色文字会「不可见」；
> 需要把视图放进 `NSWindow` 并（用 `PIL` / `NSImage` 之类）先铺白底再叠绘制，
> 或直接把缓存结果按 alpha 合成到白底上，才能读文字。

## 配置项

| 环境变量 | 作用 |
| --- | --- |
| `BELIEVEBOY_BASE_URL` | 覆盖后端地址（默认 `https://dash-api.believeboy.com`）；**必须是根地址** —— 带路径 / 查询 / fragment 会被 `APIError.invalidBaseURL` 拒绝，而不是拼出 `/api/api/v1/...` 这类必然 404 的地址 |
| `BELIEVEBOY_API_KEY` | 环境变量凭据（**可选**，绕过登录页）：只有 key、没有账号档案，因此不发 `X-Operator` 一族请求头。优先级高于钥匙串会话；要用登录态就去掉它 |

## 目录

```
macos/
├── PLAN.md                     # 选型 + 架构 + stage 计划（权威文档）
├── Package.swift               # 三层 target + BelieveBoyTests
├── Tests/BelieveBoyTests/      # XCTest（离线打桩 + 离屏渲染；需完整 Xcode）
└── Sources/
    ├── BelieveBoyKit/          # 纯逻辑：配置 / 网络 / 凭据 / 会话 / 健康探针 / 导航目录与外壳状态（不 import SwiftUI）
    ├── BelieveBoyUI/           # SwiftUI 视图 + store（可离屏渲染）
    └── BelieveBoyMac/          # 进程引导（NSApplication + 窗口尺寸恢复 + 菜单）
```

依赖方向 `BelieveBoyMac → BelieveBoyUI → BelieveBoyKit` 单向。
