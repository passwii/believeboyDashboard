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
- 后续可选加菜单栏常驻项（长任务/告警角标），但**不作为 Stage 3 的必需项**；**偏好设置做成外壳内的浮层**（§8 S3 的「偏好设置（base URL 切 生产/本地）」，快捷键 `⌘,` 是它的第二入口），**不单独开偏好设置窗口** —— 那块 UI 自 S1 起就存在（登录页页脚 / 主界面），S3 只是把它**收编**进外壳，不新增能力、不因此扩期。
- 原生窗口语义全部交给系统：`NavigationSplitView` 自动处理侧栏折叠、工具栏、`⌘⌥S`、全屏；不手写窗口 chrome。

### 2.2 导航（两层，与 `frontend/lib/sidebar-config.ts` 同构）

```
NavigationSplitView
├── sidebar    : 8 大分组（运营 / 报表中心 / 财务资金 / 广告 / AI 智能 / CRM / 工具箱 / 系统管理）
├── content    : 分组内的二级页列表（= SidebarSubItem）
└── detail     : 选中页面的内容区（模块视图）
```

- **权威对齐**：Swift 侧维护一份 `NavigationCatalog`（分组 + 二级项 + route id + 高亮语义；**不含权限位**，见下），字段与 `frontend/lib/sidebar-config.ts` 一一对应；新增模块时两侧同步 —— 由 stage 验收清单 + `NavigationCatalogTests` 的快照用例（8 组 / 56 项 / 各组条目数 / 18 处 `matchPrefixes`）检查一致性（**不做代码生成**，避免把前端工具链拉进构建期依赖）。
- **不做 role 过滤**：`sidebar-config.ts` 的 `roles` / `groupRoles` 已全部移除（该文件头写明「可见性改由单页权限（per-page）接管」，`filterByRole` / `getVisibleGroups` 仅保留接口），**实测 0 处标记**。桌面端 catalog 因此只做 分组 / 二级项 / route id；照旧口径做 role 过滤反而会与 Web 端可见性不一致。
- **高亮不能只比 `url` 相等**：Web 的 `isLinkActive` 有一条 `/dashboard` 特例（仅精确相等）加 `matchPrefixes` 前缀匹配（实测 18 处），否则子路径页面会丢高亮。Swift 侧 `NavigationCatalog.isActive(path:item:)` 复刻这条语义。
- **CRM「待跟进」的动态徽标只留语义位**：Web 端那条挂 `CrmFollowUpBadge`（需要拉数据才有数字）。catalog 用 `requiresLiveData` 记下这条语义，占位期不显示编造的数字，实现在 S4+。
- 二级页首期全部渲染 `ModulePlaceholderView`（分组 + 标题 + **对应 Web 路由** + 「未实现」状态），保证「可见即可见」：导航先立起来，模块逐个填。**占位视图不发任何请求**，也**不列「对应后端端点」** —— 端点映射要逐模块核对（同一个 Web 页可能打多个端点），先写进去就是把猜出来的映射当契约传播；S4 起随模块一起落地（S4 已把「数据流总览」换成真模块，其余仍走占位；命中表在 `ModuleRegistry`）。
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
| 取消 | 视图 `task {}` 绑定生命周期；切换模块即取消上一模块的未完成请求（**显式登记**：`ModuleTaskScope` 按 route id 收拢非结构化 `Task`，切换时由外壳统一取消 —— 只靠视图 `.task` 覆盖不到模块自己的轮询与手动刷新） |
| 错误 | 统一 `APIError`（transport / http(status, body) / decoding / unauthorized），只在一处映射文案 |
| 超时 | 沿用 Web 代理的**分层超时表**（`frontend/lib/server/backend-proxy-timeout-policy.ts`）：流式=`RequestTier.unboundedTimeout`（见下）、报表=60s、AI=30s、统计=15s、详情=10s、列表=5s |

> **流式档「无超时」的实现口径**：`URLRequest` 没有"禁用超时"开关，**不写** `timeoutInterval` 只会拿到 Foundation 默认的 60s（SSE / NDJSON 数据间隙超 60s 即被掐断）。因此流式档显式写入 `RequestTier.unboundedTimeout`（365 天）作为「极大有限值」；真正的无限等待需靠会话级 `URLSessionConfiguration.timeoutIntervalForResource`（默认 7 天）兜底。

> 严格并发下 `URLSession`、`Decodable` 模型一律 `Sendable`；跨 actor 传递的响应模型全部 `struct` + `Sendable`。
>
> **S3 探针结论（2026-09-14，BLF-1051）**：把选择态（分组 / 二级项）与侧栏折叠态放进
> `@MainActor @Observable` store（`NavigationStore`）、视图用显式 `Binding` 回调命令式
> setter，`NavigationSplitView` 三栏选择与折叠都成立，且 **CLT 下 `swift build` 仍通过**
> ——「CLT 也能 build」的承诺没有被打破（`@State` / `@Bindable` 依旧不使用）。视图与
> store 之间只经 `NavigationBindings` 一处对接。查这条结论的用例：`NavigationStoreTests`
>
> - `ShellRenderingTests`（离屏渲染三栏外壳）。
>
> **S4 探针结论（2026-09-14，BLF-1052）**：
> ① **模块状态必须由外壳持有**（`NavigationStore.agentOverview`）—— 视图是值类型、重绘即
> 重建，状态放视图里等于「切走再回来 = 重新加载 + 丢选中行」；S5 搬新模块照此往外壳加。
> ② 模块自己的加载要经 `ModuleTaskScope.run(key: 当前 route id)` 登记（不是裸 `Task`），
> 切换模块时由外壳统一取消；**取消不能落成错误态**（否则每次切回来都看到一条「已取消」
> 红条），故状态机在写入前判 `loadToken` + `Task.isCancelled`，取消就把还在 loading 的源
> 退回 idle。
> ③ 离屏渲染**真模块**时宿主必须一直活着：`NSHostingView` 一释放，视图的 `.task` 就被取消，
> 加载永远到不了「已就绪」（S3 的占位视图零请求，所以没踩到这个坑）。
> ④ `convertFromSnakeCase` 对数字段的行为反直觉：`calls_24h → calls24H`（不是 `calls24h`），
> 字段名必须照实写，否则编译通过、运行时整条响应报「缺少字段」。
> 查这些结论的用例：`AgentOverviewStoreTests`、`AgentOpsClientTests`、`ShellRenderingTests`。
>
> **S5.1 探针结论（2026-09-14，BLF-1056，广告分析页）**：
> ① **动态 `list[dict]` 行的键名不会被 `convertFromSnakeCase` 变换** —— 策略只作用于
> 结构体属性对应的键，`[String: T]` 这种字典型解码保留后端原样（`sales_7d` 不会变成
> `sales7D`）。这决定了广告分析的列键照抄后端字段名，而不是猜 CamelCase；
> 反过来说信封字段（`project_id` → `projectId`）**必须**按变换后的名字写 `CodingKeys`，
> 两边的坑方向相反。查：`AdAnalysisDecodingTests.testRowKeysKeepSnakeCaseInDictionaryDecoding`。
> ② **「进页自动选中第一个项目」会让视图的 `.task(id:)` 重跑一次**（筛选值变了 → id 变了）。
> 若第二次照样走 `ModuleTaskScope.run(key:)`，它会把第一次**还在飞**的请求取消掉 ——
> 同一个端点发两次、还白等一轮。处置：store 记在飞请求（Tab → 签名 + 票号），
> 同一组筛选在飞时直接返回（与 Web `ad-client-cache.ts` 的 `INFLIGHT` map 同义）。
> 查：`AdAnalysisStoreTests.testDuplicateLoadWhileInFlightIsNotRefetched`。
> ③ **离屏渲染用例必须自己收尾**：`NSHostingView` 释放只取消视图 `.task`，已登记进
> `ModuleTaskScope` 的非结构化任务不会跟着死 —— 它们会跑到**下一个用例**的打桩日志里。
> 同时「零请求」类断言要用日志**增量**（基线 + dropFirst），不要依赖全局日志从头干净。
> 查：`AdAnalysisRenderingTests` 的 `tearDown` 与 `loggedPaths(since:)`。
> ④ 与 Web 的数值对齐要先对齐**格式化**：Web 表格用 `x.toFixed(2)`（无千分位），
> 而「总览」明细用 `toLocaleString('zh-CN')`（有千分位）—— 两端同一列口径不同，
> 照抄错一处就会「看起来差不多但数值不一致」。桌面端因此不走 `NumberFormatter`
> （它跟随系统区域），改为手写分组。

> **S5.2 探针结论（2026-09-14，BLF-1057，广告数据页）**：
> ① **同一个后端，日期契约可以按页面而不同**：`ad-analysis/*` 不传日期 = 聚合全量历史，而
> `internal/ad-data/*` 的 `period` 是**必填**的，不传直接 `400 period is required`。所以
> 「不限定日期」在广告数据页必须落成**哨兵窗口**（Web 的 `start_date: dateFrom || '2000-01-01'`）。
> 照搬上一页的「日期为空就不传参数」会 400。查：`AdDataFormattingTests.testEndpointPathsAndQueryShape`。
> ② **`summary.total_rows` 是本页返回行数，不是窗口内总数**（后端就是 `len(rows)`）——
> 拿它当总数会算错总页数，也会让「可能被截断」这件事看不出来。判据只能是「`data.count` 顶到
> `limit`」。查：`AdDataDecodingTests.testSummaryTotalRowsIsThisPageOnly`。
> ③ **服务端 offset 翻页不可用**：`_run_raw_query` 只按单个列排序、没有 tiebreaker，实测同一组
> 参数两次取数**顺序并不稳定**（`limit=200` 的切片不总是 `limit=10000` 响应的前缀，10 个端点里
> 8 个不是）—— 于是「翻页会重复/漏行」不是理论风险。故本批单发 `limit=10000` + 客户端翻页。
> 查：`AdDataTableTests.testPagingSlicesIntoSortedRows` 与夹具 README 的实测记录。
> ④ **`/api/v1/internal/*` 不是一种鉴权**（修正 §4.1 的笼统说法）：`internal/ad-data/*` 挂的是
> `protected`（`require_api_key`，支持 `blf_` 账号 key），而 `internal/api_keys` /
> `internal/user_api_keys` 挂 `_require_admin`。`agent/*` 才是要求 Bearer + `X-Agent-Id` 的那一域。
> 桌面端消费 `internal/ad-data/*` 因此是正当的（BLF-1057 实测可达）。
> ⑤ **不要把「有数据」的判定交给附属端点**：`ad-upload-files` 按 `updated_at desc` 截断
> （实测该项目该站点 current 文件 1405 份、端点上限 500），照抄 Web 的「不在列表里就置灰」会把
> 已有 1321 行数据的「搜索词」显示成「暂无数据」。桌面端改成「全部类型可选 + 可用性看 raw 响应
> 是否为空」，附属端点只用来显示「最近一次入库」。查：`AdDataDecodingTests.testUploadFilesSnapshotDocumentsTruncation`。
>
> **S5.3 探针结论（2026-09-14，BLF-1062，AI 洞察三页）**：
> ① **同一个「SSE」在三页里是两种传输**：旧链路（`/ai-insights/{id}/stream`）**不发 `id:`**、
> 后端**不认 `Last-Event-ID`**（只 `insight_runs.py` / `ai_chat_v2.py` 读这个头），每 2s 轮询 DB、
> 只在状态变化时发 `status`、正文只随终态帧回来；canonical（`/insight/runs/{id}/stream`）
> 每帧带 `id: {run_id}:{attempt}:{seq}`、认游标、按 `(attempt, seq)` 续传。于是「断线恢复」
> 在旧链路上**只能**落成「重连 + 回读 detail 权威快照」，在 canonical 上才是真游标续传 ——
> 这条差异写成 `InsightCatalog` 的两个显式布尔量，不让它藏在实现里。查：`InsightDecodingTests`
> 的 `testLegacyStreamCarriesNoCursor` / `testResumeResponseOnlyCarriesTheTerminalFrame`。
> ② **canonical 侧没有 run 列表端点**（`insight_runs.py` 全量路由 = 建/读/流/取消/重试），
> 而本批不做写链路 → 桌面端「canonical run 明细 + 流式」的可达入口只能是**按 run id 观察**
> （Web 的 run id 来自台账行 `insight_run_id`，桌面端台账页还没搬）。写成显式输入框 + 一句
> 「为什么不给列表」，而不是把不可达藏起来。查：`CanonicalRunStoreTests`。
> ③ **`content.delta` 累积 + 快照覆盖**：`done` / `snapshot` 帧带的是**全量** outputs，
> 直接覆盖而不是追加 —— 断线续传时重放帧会把半截增量留在正文里。配合按 `id` 去重
> （`InsightCursorTracker`）才闭环。查：`CanonicalRunStoreTests.testReconnectSendsLastEventIDAndDedupesReplay`。
> ④ **进页自动选中第一个项目会让「生效签名」变一次**：若用闸门**之前**的签名记账，视图
> `.task(id:)` 重跑时会认定「筛选变了」再发一次同参数请求（S5.1 踩过的坑）。S5.3 的做法是
> **在项目闸门之后取 `filters.signature`** 并用它记账。查：`AIInsightsStoreTests.testDuplicateLoadIsNotRefetched`。
> ⑤ **回读权威 detail 不能无条件回写 `error_message`**：运行中那一栏可能已经写着「生成流已断开」
> 的传输提示，用 detail 的 `null` 覆盖会把「流断了但 run 还在跑」这句话抹掉。故只在终态回写。
> 查：`AIInsightsStoreTests.testStreamDisconnectReconnectsWithBoundedAttempts`。
> ⑥ **`strategy_metadata` 是 JSON 字符串，解析必须用 `convertFromSnakeCase`**：里面的键名是
> 后端原样写进去的 `evolution_metadata` / `dimensions_analyzed`，默认策略下全部取不到 ——
> 维度面板会**静默消失**而不是报错。查：`InsightPanelMappingTests.testDimensionCoverageParsesEvolutionMetadata`。
> **S5.4 探针结论（2026-09-15，BLF-1065，AI 会话片）**：
> ① **`message_stop` 不是终态，`done` 才是** —— 项目的 `done` 扩展**跟在 `message_stop`
> 后面**（`ai_chat_v2.py:206`，`_encode_done_sse`）。累加器若把 `message_stop` 当终态，
> `done` 连同里面的用量 / 消息 id / 会话标题会被**整个丢掉**，而现象只是「标题没自动改、
> token 不显示」——不像报错，最难发现。查：`AIChatTurnAccumulator.hasReachedTerminalState`
> 与 `AIChatDecodingTests.testFramesAfterTerminalAreIgnored`。
> ② **续传的 `message_stop` 没有 `done`，而这是合法的**（`_resume_stream` 只转发 Redis 原始帧、
> 不合成 `done`）。Web 把它当错误（它从不主动续传），桌面端会真发续传请求，因此必须落成
> 「已完成但没有持久化载荷」。查：`AIChatDecodingTests.testResumeFramesWithoutDoneAreLegitimate`。
> ③ **续传在同一个 POST 上**：`Last-Event-ID` 只决定「从哪之后续传」，`payload: MessageCreate`
> 仍是必填 —— 少了游标会从头重放，少了 body 直接 422。「重连重拉全量」不是可选方案。
> 查：`AIChatClientTests.testResumeRequestKeepsBodyAndAddsLastEventIDHeader`。
> ④ **空态有两种成因，后端响应一模一样**：缺 `X-User-Id` 时 `list_conversations` **静默返回空表**
> （`services/ai/chat.py:35`），与「这个账号真的没有会话」无法从响应上区分。桌面端因此把
> 归属判定单独做成一类空态（`AIChatInboxState.undeclaredAccount`），并在界面上给出「重新登录」
> 而不是「暂无会话」。查：`AIChatStoreTests.testUndeclaredAccountIsDistinctFromNoConversations`
> 与 `AIChatRenderingTests.testUndeclaredAccountEmptyStateIsPainted`。
> ⑤ **一个模块可以有多条互不相干的在跑任务，且必须既能各自取消又能整体取消**：AI Chat 同时有
> 会话列表、消息历史、用量、上传、一条可能活很久的 SSE。`ModuleTaskScope` 因此补了
> `cancelTree(key:)`（子 key 写法 `"<route id>:<用途>"`）—— 原来只按 route id 精确取消，
> 多条任务要么互相取消（同一 key）要么都收不掉（不同 key）。对 S5.1~S5.3 那些只用 route id
> 单 key 的模块，行为与原先完全一致。查：`AIChatStoreTests.testCancelTreeOnlyAffectsItsOwnSubtree`。
> ⑥ **取消存在一条竞态：内层流可能先以「正常结束」收尾**，于是 `for try await` 平静退出、
> `catch CancellationError` 根本不会被触发，状态机接着按「连接提前结束」落成错误态。
> 处置：循环之后补一道 `if Task.isCancelled { return }`。查：
> `AIChatStoreTests.testStopGenerationTearsDownStreamAndCallsCancel`。
> ⑦ **回复落地后要回读历史，而不是本地插入**：`done` 只给两条消息，而 `regenerate` 会删掉旧的
> assistant 行；同时「回读失败 / 返回空表时**保留草稿**」——否则刚生成的回答会从界面上凭空
> 消失（用户看到的比库里少，比多一条更糟）。查：`AIChatStore.finalizeTurn`。
> ⑧ 夹具口径：快照库 `BLF` 里「归属账号」与「有消息」**互不相容**（有消息的会话
> `user_id IS NULL`，后端对任何调用方都 404），所以会话 + 消息要经隔离库 `BLF_test` 复制出来；
> SSE 三份由**后端自己的编码器**产出（线格式才是要钉的东西，AI 正文不逐字断言）。
> 见 `Tests/BelieveBoyTests/Fixtures/AIChat/README.md`。
> ⑨ **「取消」有两条异步回写路径，拆掉本地 SSE 只处理了其中一条**：另一条是后端
> `POST .../cancel` 的**回包**，它可能落在「已经发了下一轮」甚至「下一轮已正常结束」之后 ——
> 那一刻流的归属（`streamLease` / `generationToken`）本来就是 `nil`，按「当前这一轮」判定
> 就会把新一轮的游标 / 载荷 / 错误提示当成自己的清理对象，且**四种收尾场景里没有一种会报错**。
> 处置：游标与载荷改为**停止时同步作废**（不等回包），cancel 回包另持一份轮次 token
> （`cancelToken`；新一轮发送、切会话 / 新建会话、清空产物都会换掉它）。查：
> `AIChatStoreTests.testStopThenImmediateSendKeepsTheNewTurnsState`、
> `AIChatStoreTests.testLateCancelFailureDoesNotLeakIntoAnotherConversation`、
> `CustomerServiceStoreTests.testLateCancelFailureDoesNotComeBackAfterClearingOutput`。

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
| 登录 | `POST /api/v1/auth/login`（email + password，可选头 `X-Client-Id` 选设备槽）→ `LoginResponse.api_key`（**同槽内轮换**，hash-only 存储） |
| 健康检查 | `GET /api/v1/health/live`（免鉴权，进程存活）/ `GET /api/v1/health/ready`（免鉴权）/ `GET /api/v1/health`（需鉴权，含 DB / 只读副本 / Redis / 环境名） |
| 鉴权失败语义 | 缺 key → **401** `{"detail":"Missing API key"}`；key 无效或已被轮换 → **403** `{"detail":"Invalid API key"}`（`backend/app/core/security.py:45-71`）—— 桌面端把 401/403 一律导向「重新登录」（见 §4.1.1） |

**为什么直连而不走 Web 代理**：`frontend/app/api/backend/[...path]/route.ts` 存在的原因是 Vercel 边缘不允许 Web 端持有主 key，且需要 NextAuth 会话。桌面端是可信本地进程，账号专属 key（BLF-711）就是为它准备的 —— 直连可去掉一跳代理与一层超时，同时保持同一套后端契约。

**代价（已确认）**：后端 CORS 白名单只放行 `settings.frontend_url`；桌面端是原生 URLSession 请求，**不受 CORS 约束**（CORS 是浏览器策略），因此无需后端改配置。

> ⚠️ **可用面边界**：`/api/v1/agent/*` 与 `/api/v1/internal/*` **不属这套鉴权** —— 该域要求 `Authorization` + `X-Agent-Id` 配对（给外部 Agent 用），带 `X-API-Key` 会得到 `401 AGENT_AUTH_FAILED`。桌面端只消费账号级业务路由：生产 `/api/v1/` 共 54 个一级路由家族，排除 `agent` 与 `internal` 后即为桌面端可用面（`ad-analysis` / `complaints` / `crm` / `inspections` / `inventory-*` 等）。**Stage 4+ 搬模块时不要把 agent 域端点接进来。**

#### 4.1.1 单设备 key：Web 登录会使桌面端 key 失效（S2 的硬约束）

> **📌 已由 BLF-1059（后端）+ BLF-1060（桌面端）取代，见 §4.1.2** —— key 已按设备槽分区，
> 本节保留为**历史依据**：它解释了 S2 为何把「401/403 一律导向重新登录」定为硬约束，
> 以及推论一/二/四为何至今仍成立（只有推论三已被解除）。

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

> 后续：该后端 issue 就是 **BLF-1059**（“按 `client_id` 分区”这条被选中），客户端那半是
> **BLF-1060**；当时的两个前置条件（「实测反馈」与「Yawei 拍板」）都已满足。

#### 4.1.2 多设备槽 key：一个账号多把 key（BLF-1059 + BLF-1060，现行契约）

`user_api_keys` 的「一账号一行」已被拆成**按设备槽分区**：同一个槽内仍只有一把有效 key
（同槽重登 = 轮换），**槽与槽互不影响** —— 桌面端登录不再顶掉网页端那把 key（反之亦然）。

| 侧 | 落点 | 内容 |
| --- | --- | --- |
| 后端（BLF-1059） | `backend/app/services/user_api_key_service.py`（迁移 272） | `user_api_keys` 增 `client_id`（`String(64)`，默认 `'default'`），唯一约束改为 `(user_id, client_id)`；登录读头 `X-Client-Id`（`auth.py`，`Header(alias="X-Client-Id")`），**不动 `/auth/login` 的 schema** |
| 客户端（BLF-1060） | `Sources/BelieveBoyKit/ClientIdentifier.swift` | 首次启动生成 UUID → 钥匙串条目 `client-id`（与 key / 档案 / 「记住密码」分槽）→ 每次登录作为 `X-Client-Id` 发出 |

契约细节（两端必须一致，改一端就得改另一端）：

- **合法性**：`None` 与 `""` = 没带该标识 → 落 `default` 槽（网页端与拆分前的旧构建的行为，故网页端零改动）；其余值必须整体匹配 `[A-Za-z0-9._:-]` 且 ≤64 字符，含空白 / 控制字符 / 非 ASCII 一律 **400**（`fullmatch`，**不 strip** —— strip 会把非法标识悄悄别名到另一台设备的槽）。Swift 侧同口径实现在 `ClientIdentifier.isValid`，存量值非法时**重新生成**而不是原样发出去。
- **槽上限**：每账号 5 个有效槽，超限回收**最旧**一把（不拒绝登录）。推论：设备标识必须跨进程稳定，否则每次启动新开一槽，很快把别的设备挤出去。
- **改密码**：撤销该账号**全部设备**的 key（自助 + 管理员重置同一落点）→ 桌面端收到 403，走既有「重新登录」路径。
- **不变的部分**：鉴权路径（`resolve_user_key` → `require_api_key`）与 401/403 语义零改动；推论一（不内置 key）、推论二（401/403 一律导向重新登录）、推论四（不做无谓重试）依旧成立。
- **失败退化的取向**：设备标识的钥匙串条目读写失败时，客户端**不退化成「不带标识」**（那会落 `default` 槽，把网页端顶掉 = 把本 stage 要修的问题请回来），而是本次进程用一个临时标识、并给出可见提示。

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
│       ├── Fixtures/AdAnalysis/  # 广告分析 10 个端点的真实响应快照 + manifest（sha256 / 抓取时点）
│       ├── Fixtures/AdData/      # 广告数据 11 个端点的真实响应快照 + manifest（同上；抓取脚本见 macos/scripts/）
│       └── Fixtures/AIChat/      # AI 会话片 4 条读端点 + 3 份 SSE 帧快照（同上；账号与消息来自生产快照的复制）
│                              #   S2 起同时覆盖 BelieveBoyUI（登录态状态机），故不再叫 *KitTests
└── Sources/
    ├── BelieveBoyKit/         # 纯逻辑层，不 import SwiftUI
    │   ├── AppConfig.swift        # baseURL / key / 环境（生产·本地）+ 环境变量覆盖
    │   ├── APIClient.swift        # 泛型 GET/POST + 分层超时表 + X-API-Key 与账号上下文注入
    │   ├── APIError.swift         # 错误分类 + 中文文案 + 是否需修凭据
    │   ├── AuthService.swift      # POST /auth/login → AuthSession（HTTP 语义→登录语义）
    │   ├── AuthError.swift        # 登录失败的分类与文案
    │   ├── CredentialStore.swift  # key 协议 + 只读环境变量实现 + 凭据三态判定
    │   ├── KeychainItem.swift     # kSecClassGenericPassword 条目 CRUD（key / 档案 / 「记住密码」/ 设备标识四个条目共用）
    │   ├── KeychainCredentialStore.swift  # 账号专属 key（blf_）
    │   ├── ClientIdentifier.swift  # 设备标识（X-Client-Id）协议 + 钥匙串实现 + 与后端同口径的合法性判定
    │   ├── SessionStore.swift     # 会话持久化协议（key + 账号档案）
    │   ├── KeychainSessionStore.swift     # 钥匙串实现：key + 档案（先档案后 key）
    │   ├── RememberedLogin.swift  # 「记住密码」协议 + 钥匙串实现（opt-in，与 key / 档案分槽）
    │   ├── HealthProbe.swift      # live / full / snapshot（两步语义）
    │   ├── Navigation/            # 导航与外壳状态的**纯逻辑**（不 import SwiftUI）
    │   │   ├── NavigationCatalog.swift   # 8 分组 / 56 二级项 / 高亮语义（对齐 sidebar-config.ts）
    │   │   └── ShellPreferences.swift    # 选中项 / 侧栏折叠态 / 窗口尺寸 + 不可信落盘的清洗规则
    │   ├── AgentOps/              # 业务模块的领域逻辑（S4 起按模块增，不 import SwiftUI）
    │   │   ├── AgentDomains.swift        # 业务域注册表（复刻 agent-domains.ts：17 域 / 16 live / 行序）
    │   │   ├── AgentOpsModels.swift      # domain-summary / 客诉 / 巡检 / 报表的响应模型 + 矩阵装配
    │   │   ├── AgentOpsFormatting.swift  # 美西今天 / 新鲜度 / 相对时间 / 错误率（纯函数，显式吃 now）
    │   │   └── AgentOpsClient.swift      # 四端点客户端（分层超时：矩阵 15s、三源 5s）
    │   ├── Networking/           # 通用 HTTP 能力（S5.0：后续每批都要用，故先补齐）
    │   │   ├── APIClient+Write.swift      # POST/PUT/PATCH/DELETE + 「忽略响应体」一组（204 空体）
    │   │   ├── APIClient+Upload.swift     # multipart 上传（显式 Content-Length + httpBodyStream）
    │   │   ├── MultipartFormData.swift    # 表单组装 + 按块读磁盘文件的 InputStream（不整份进内存）
    │   │   ├── ServerSentEvent.swift      # SSE 帧模型 + 纯逻辑解析器（可离线钉规则）
    │   │   ├── APIClient+Stream.swift     # SSE 消费：.stream 档 / 逐帧 yield / 取消即拆连接
    │   │   ├── APIClient+Download.swift   # 文件下载：流式落盘 + 临时文件原子替换 + 进度回调
    │   │   └── PollingPolicy.swift        # 轮询退避 + 上限 + 可注入 sleeper（测试不等真时间）
    │   ├── Jobs/                 # 长任务（S5.0）
    │   │   ├── JobModels.swift   # JobStatus（未知状态安全降级）+ JobSummary/JobDetail/JobRun
    │   │   └── JobClient.swift   # /jobs 三端点 + waitForCompletion / waitForSuccess
    │   ├── AdAnalysis/            # 「广告分析」的领域逻辑（S5.1，不 import SwiftUI）
    │   │   ├── AdAnalysisCatalog.swift    # 10 个子 Tab / 端点目录（对齐 config.ts）
    │   │   ├── AdAnalysisModels.swift     # 动态行（list[dict]）+ 卡片模型 + 查询参数（日期可空）
    │   │   ├── AdAnalysisFormatting.swift # 金额 / 百分比 / 占位「—」/ 纯日期串（不走 locale）
    │   │   ├── AdAnalysisColumns.swift    # 逐 Tab 列定义 + 「总览」五源合并网格
    │   │   └── AdAnalysisClient.swift     # 项目列表 5s + 10 端点 15s
    │   ├── Ads/                   # 广告两页**共用**的领域逻辑（S5.2 起）
    │   │   ├── AdFilters.swift            # 筛选条取值 + 查询签名（两页同一份，日期语义差异留在各自 Query）
    │   │   ├── AdPageState.swift          # 加载档（idle/loading/loaded/failed）+ 项目闸门
    │   │   ├── AdSharedCatalog.swift      # 站点三选一 + 项目列表端点
    │   │   ├── AdDataCatalog.swift        # 10 种报表类型 / 列定义 / 哨兵窗口 / limit=10000 / pageSize=100
    │   │   ├── AdDataModels.swift         # 原始行信封 + 入库文件 + 查询（period 必填 → 哨兵窗口）
    │   │   ├── AdDataFormatting.swift     # 单元格口径（对齐 Web formatAdDataValue，占位「-」）
    │   │   ├── AdDataTablePipeline.swift  # 客户端「搜索 → 排序 → 翻页」纯函数流水线
    │   │   └── AdDataClient.swift         # 项目 5s + 入库文件 5s + 10 个原始行端点 15s
    │   ├── AIChat/                # 「AI 会话片」两个页面的共用底座（S5.4，不 import SwiftUI）
    │   │   ├── AIChatCatalog.swift        # 12 条端点目录 + prompt / 场景预设（复刻 lib/server/ai-chat.ts）
    │   │   ├── AIChatModels.swift         # 配置 / 会话 / 消息 / 搜索来源 / 发送体 / 用量 / 上传响应
    │   │   ├── AIChatStream.swift         # Anthropic 风格 SSE 事件模型 + 宽容解码（未知事件不报错）
    │   │   ├── AIChatTurn.swift           # 流事件 → 草稿的纯逻辑累加器（终态是 done，不是 message_stop）
    │   │   ├── AIChatMarkdown.swift       # 复用 S5.3 的 `InsightMarkdown`（解析复用、呈现分叉）
    │   │   ├── AIChatPageState.swift      # 加载档 / 空态两种成因 / 归属 / 附件 / 输入区 / 二次确认
    │   │   └── AIChatClient.swift         # 10 条元数据（5s）+ 上传（60s）+ 用量（15s）+ POST-SSE 流
    │   └── Models/
    │       ├── HealthModels.swift # /health 与 /health/live 响应
    │       ├── JSONValue.swift    # 任意 JSON 值（长任务 params / payload_json / 广告两页的动态行值）
    │       ├── DynamicJSONRow.swift # 形状由后端决定的一行（广告分析明细行 + 广告数据原始行）
    │       ├── NumberText.swift   # 数字 → 文本的原语（分组 / 两位小数 / 百分比；不走 locale）
    │       └── AuthModels.swift   # LoginRequest/Response、AuthenticatedUser、AuthSession、UserContext
    ├── BelieveBoyUI/          # SwiftUI 视图 + 视图状态（可离屏渲染，不需启动 GUI）
    │   ├── AppModel.swift         # @MainActor @Observable：登录态 + 连接配置 + 健康检查
    │   ├── NavigationStore.swift  # @MainActor @Observable：选中项 / 折叠态 / 持久化 + 模块任务作用域
    │   ├── NavigationBindings.swift  # 视图→store 的显式 Binding + SplitViewVisibility 映射（无属性包装器）
    │   ├── ModuleTaskScope.swift  # 按 route id 收拢模块后台任务，切换时统一取消（不泄漏 Task）
    │   ├── RootView.swift         # 按会话状态选页（restoring / 登录 / 外壳）+ 窗口尺寸切换
    │   ├── LoginView.swift        # 登录表单（窄栏居中，服务器选择默认折叠）
    │   ├── ShellView.swift        # 三栏外壳（8 分组 / 二级项 / 模块内容）+ 工具栏
    │   ├── ModulePlaceholderView.swift  # 二级页占位（分组 + 标题 + Web 路由 + 未实现，不发请求）
    │   ├── ModuleRegistry.swift          # 模块视图路由表（route id → 真模块；未命中则走占位）
    │   ├── AgentOverviewStore.swift      # 「数据流总览」状态机（四源并发各自降级 + 三态 + 选中行）
    │   ├── AgentOverviewView.swift       # 「数据流总览」只读页（7 列矩阵 + 详情面板 + hover）
    │   ├── AdAnalysisStore.swift         # 「广告分析」状态机（共享筛选条 + 10 个 Tab 各自三态 + 在飞去重）
    │   ├── AdAnalysisView.swift          # 「广告分析」只读页（筛选条 + Tab 栏 + 明细网格 + 图表）
    │   ├── AdAnalysisComponents.swift    # 广告分析共用件（磁贴 / 叙述 / 风险卡 / 网格 / 图表）
    │   ├── AdFilterBar.swift             # 两页**共用**的筛选条（协议 AdFilterDriving 驱动，文案差异由 store 提供）
    │   ├── AdDataStore.swift             # 「广告数据」状态机（10 种类型三态 + 客户端搜索/排序/翻页/展开）
    │   ├── AdDataView.swift              # 「广告数据」只读页（筛选条 + 类型选择 + 搜索 + 原始行表 + 翻页）
    │   ├── AdDataComponents.swift        # 广告数据共用件（类型选择 / 搜索 / 原始行表 / raw_row 详情 / 翻页条）
    │   ├── AIChatStore.swift             # 「AI Chat」状态机（会话 / 消息 / POST-SSE 草稿 / 续传 / 取消 / 用量）
    │   ├── AIChatView.swift              # 「AI Chat」页（会话列表 + 消息流 + 输入区 + 用量面板）
    │   ├── AIChatComponents.swift        # AI 会话片共用件（Markdown 正文 / 消息行 / 来源卡 / 草稿 / 用量）
    │   ├── CustomerServiceStore.swift    # 「客服交流」状态机（场景 / 语气 / 引导字段 → 一次生成）
    │   ├── CustomerServiceView.swift     # 「客服交流」页（场景标签 + 输入栏 + 产物区 + 导出 .md）
    │   ├── PreferencesPanel.swift # 偏好设置浮层：后端地址（生产 / 本地）+ 自定义地址
    │   ├── HealthView.swift       # 概览：账号 + 连接检查（外壳详情栏的空选中态）
    │   ├── WindowFrames.swift     # NSRect ↔ WindowFrame 桥接 + 屏幕可见区域取值
    │   └── ViewSupport.swift      # 显式 Binding 助手 + 共用小组件 + 窗口尺寸口径/探针
    └── BelieveBoyMac/         # 进程引导（薄壳）
        ├── main.swift             # NSApplication + setActivationPolicy(.regular)
        └── BelieveBoyAppDelegate.swift  # 窗口（尺寸恢复/记录）+ 主菜单（⌘R / ⌘, / ⌘⇧L / ⌘Q / 编辑菜单）
```

分层铁律：`BelieveBoyMac → BelieveBoyUI → BelieveBoyKit`，**单向**；Kit 不 import SwiftUI（纯逻辑，可在 CLI/CI 复用）；UI 不依赖进程引导（可离屏渲染验证）。

> **旧计划项的当前状态**：`Tests/BelieveBoyTests/`（原 `BelieveBoyKitTests`，S2 起兼收 UI 状态机与离屏渲染用例）当前 **592 个用例**（其中 4 个真后端用例默认 skip：key 轮换 2 + 数据同源同值 2），`swift test` 需完整 Xcode，见 §9。
>
> **计数口径（S5.3 实测，2026-09-14）**：本批开工基线 = `origin/main`（`a2b2c593`，S5.2 交付侧）
> **428 executed / 4 skipped / 0 failures**；AI 洞察三页 **+75** → **503 executed / 4 skipped /
> 0 failures**。
>
> **计数口径（S5.4 实测，2026-09-15）**：本批开工基线 = `origin/main`（`564867fc`，含 S5.3 交付侧）
> **503 executed / 4 skipped / 0 failures**；AI 会话片 **+82** → **585 executed**，Tia 复核两轮
> 的回归用例再 **+7**（+4 / +3）→ **592 executed / 4 skipped / 0 failures**；跑法
> `DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test --scratch-path .build/xcode-check`。
> 历史：S5.1 基线 186 → 256（+70），PR #614 再 +75 → 331，PR #615 审查修复 +8 → 339，
> S5.2 广告数据页 +89 → 428，S5.3 AI 洞察三页 +75 → 503。`scripts/make-app.sh` 仍属 S7a。

---

## 8. Stage 计划

> 归属列的「已完成（BLF-xxxx）」就是该 stage 的交付 issue；未完成的写明后续单独开 issue。

| Stage | 目标 | 可交付物 | 验收标准 | 依赖 | 归属 |
| --- | --- | --- | --- | --- | --- |
| **S0** | 仓库清场 | 删除 `gui/`、`docs/gui-mvp-plan.md`、`.github/workflows/gui-windows-build.yml`；新建 `macos/`、`windows/` | `git ls-files \| grep '^gui/'` 为空；无残留 CI 引用 | — | **本 issue** |
| S1 | 最小可运行骨架 | `macos/` SPM 工程（Kit + UI + 引导三层）：`AppConfig` + `APIClient` + Keychain 凭据 + 健康检查视图 + AppKit 引导与主菜单 + Kit 层 XCTest；`windows/README.md` 占位 | ① `swift build` 零错误（CLT 与完整 Xcode 两条工具链分别实测）；② Kit 层对真实后端端到端跑通（存活探针 / 鉴权探针 / snake_case 解码 / 缺凭据拦截 / 错误 key → 403 / 不可达 → transport / snapshot 短路）；③ App 启动建出窗口；④ 视图渲染出 `/health` 的 DB·副本·Redis·内存·环境名真实数据，失败态显示对应中文错误；⑤ `swift test` 11 用例全绿（需完整 Xcode，见 §9）；⑥ 生产直连验证见 §4.1 实测表 | S0 | 已完成（BLF-1041） |
| **S2** | 登录与会话 | 登录表单 → `POST /api/v1/auth/login` → `api_key` 入 Keychain；登录态保持、`X-Operator`/`X-User-Id`/`X-Is-Admin` 注入；401/403 自动回登录页；「记住密码」（钥匙串，opt-in） | 冷启动凭据有效直进主界面；**401/403（含被网页端/其他设备登录顶掉导致 key 失效）→ 明确再登录路径，不做无谓重试**；App 不内置任何 key；密码不落盘（仅勾选「记住密码」时入钥匙串，且从不进 `UserDefaults`/账号档案/日志）；登录页精简（无说明性段落，服务器选择默认折叠） | S1 | 已完成（BLF-1044） |
| **S3** | 应用外壳与导航 | `NavigationCatalog`（对齐 `sidebar-config.ts`）+ `NavigationSplitView` 三栏 + 模块占位视图 + 偏好设置（base URL 切 生产/本地，**收编**已存在的选择 UI，不新增能力） | 8 分组与二级项条目数与 `sidebar-config.ts` 一致（快照用例钉在 Swift 侧）；切换模块无泄漏 Task（`ModuleTaskScope` 按 route id 取消，占位视图零请求）；窗口尺寸 / 侧栏折叠状态可恢复（`ShellPreferences` + 落盘清洗与夹回可见屏幕的规则） | S2 | 已完成（BLF-1051） |
| **S4** | 首个真实业务模块 | 「运营 → 数据流总览」只读页（对齐 Web dashboard 首页信息密度） | 数据与 Web 同源同值（抽样比对）；加载/空/错误三态齐备；列表超时 5s / 统计 15s 分层生效 | S3 | 已完成（BLF-1052） |
| **S5.0** | 客户端能力补齐（S5 的前置批次，不加页面） | Kit 层四类能力：**JSON 写入**（PUT/PATCH/DELETE + 文档无体的「忽略响应体」一组）、**multipart 上传**（显式 `Content-Length` + `httpBodyStream`，文件按块读、中文文件名双形态）、**SSE 流式**（逐帧 yield、`.stream` 档、取消即拆连接）、**长任务轮询 + 文件下载**（退避 + 上限、流式落盘 + 原子替换）；`JobClient` 收编 `/jobs` 三端点 | 四类能力各有打桩用例（断言真实请求属性，而非常量表）；multipart 边界 / 中文文件名正确且上传体不整份进内存；SSE 走 `.stream` 档且取消不留 Task；轮询有退避与上限（不无限打后端）；错误分类沿用 `APIError`（401/403 → `requiresCredentialFix`；传输失败不算凭据问题）；`swift test` 256 用例全绿（4 个真后端用例默认 skip） | S4 | 已完成（BLF-1053） |
| **S5** | 业务模块分批搬运 | 按分组切片，每批 1 组（运营 → 报表中心 → 财务 → 广告 → AI → CRM → 工具箱 → 系统） | 每组：端点覆盖对照表 + 抽样数值与 Web 一致 + 该组内只读能力 100% 可达 | S5.0 | 后续多个 issue（每组一个） |
| **S5.2** | S5 广告分组第二批 | 「广告 → 广告数据」只读页：报表类型选择 + 共享筛选条 + 原始行表格（搜索 / 排序 / 客户端翻页 / 行内 `raw_row` 中文列详情） | 11 个端点全部接通、固定参数下数值与 Web 一致（切片与全量响应同 id 逐字段一致）；加载/空/错误三态齐备，刷新失败保留旧表；切类型 / 改筛选 / 切模块取消在跑请求且不落错误态；单发 `limit=10000` + `pageSize=100` 客户端翻页并给「可能截断」提示（不做 offset 翻页）；11 个端点各有真实响应快照（sha256 + 抓取时点入 manifest）；`swift build`（CLT）+ `swift test` 428 用例全绿 | S5.1 | 已完成（BLF-1057） |
| **S5.3** | S5 AI 分组（AI 洞察三页） | 「AI → AI 洞察 / AI 广告分析 / AI 库存健康」三页只读 + 流式观察：6 个端点（含 2 条 SSE）、Markdown + 图表围栏降级、流式草稿切分、维度面板、canonical run 观察 | 6 个端点全部接通、可达（给「端点 → macos 消费点」对照表）；AI 文本按「同源同结构」（状态机 + 事件序列 + 数值字段）；三态齐备（空态显式画出「暂无洞察/暂无运行记录」）；切页/改筛选/切模块取消在跑请求（含拆 SSE 连接）且不落错误态；run detail + 事件序列各一份真实快照入 `Fixtures/Insight/`（sha256 + 抓取时点入 manifest）；`swift build`（CLT）+ `swift test` 503 用例全绿 | S5.2 | 已完成（BLF-1062） |
| **S5.4** | S5 AI 分组第二批（会话片） | 「AI 智能 → AI Chat」+「客服交流」两页：12 条端点（读 4 + 写 8，含 1 条 **POST-SSE**）+ 会话 CRUD + 消息编辑/删除 + 附件解析 + token 用量；两页共用同一份底座（`AIChatClient` / `AIChatTurnAccumulator` / 预设目录） | 12 条端点全部接通、可达（端点 → macos 消费点对照表在 PR）；POST-SSE 用例断言**真实请求属性**（方法 = POST、JSON body、`Accept: text/event-stream`、续传带 `Last-Event-ID` **且带 body**）；跨端可见性：同账号的会话可见可续聊，「未声明账号」与「无会话」两种空态可区分；三态齐备 + 取消（含拆 SSE）不落错误态；会话列表 / 消息列表 / 事件序列各一份真实快照（sha256 + 抓取时点入 manifest）；`swift build`（CLT）+ `swift test` 585 用例全绿 | S5.0 | 已完成（BLF-1065） |
| **S6** | 写操作与确认流程 | 写端点接入 + 二次确认 UI + 操作审计提示（对齐 Web confirm 语义） | 写操作有确认、有失败回滚提示、有审计可查；破坏性操作默认不可一键完成 | S5 | 后续 issue（按需） |
| **S7** | 打包 / 签名 / 公证 / 分发 | `make-app.sh`（.app）→ Developer ID 签名 + 公证 + `.dmg` → GitHub Actions 构建流水线 | 干净 Mac 上双击可开（无 Gatekeeper 警告）；`spctl -a` 通过；公证 ticket 可 staple | **Apple Developer 账号（外部阻塞）**；S3 | 后续 issue |
| **S8** | 自动更新与系统集成 | Sparkle appcast；菜单栏角标（告警/长任务）；系统通知 | 旧版本可收到新版本提示并完成升级；通知点击可深链到对应模块 | S7 | 后续 issue（可选） |

### 8.1 依赖顺序（关键路径）

```text
S0 → S1 → S2 → S3 → S4 → S5.0 → S5(×8) → S6
                              ↘ S7 → S8
```

- S7 的**代码**部分（打包脚本、CI）不依赖 S3 之后的业务进度，可以提前；但**签名/公证**卡在 Apple Developer 账号上。
- S5.0（BLF-1053）是 S5 的**能力前置**：它不加页面，只把「写 / 上传 / 流式 / 轮询 + 下载」四类客户端底座补齐 —— 底座不齐时，每批都要自己现搓一遍 multipart 与轮询。
- S5 的 8 个分组互相独立，可并行开 issue（注意：同一 `Package.swift` 与 `NavigationCatalog` 是共享编辑点，并行时由人工串行合并）。

### 8.2 本 issue 明确不做

- 登录流程（S2）、三栏导航外壳（S3）、任何真实业务数据模块（S4+）。
- Windows 实现（`windows/` 仅占位 + 路线待定）。
- 对 `frontend/`、`backend/` 的任何修改。

---

## 9. 风险与未决事项

| 项 | 影响 | 处置 |
| --- | --- | --- |
| **两条工具链能力不同**（已实测，2026-09-13） | **Command Line Tools**（`xcode-select -p` = `/Library/Developer/CommandLineTools`）：① SwiftUI 属性包装器宏（`@State`/`@Bindable`/`@Environment`）不可用 —— 实现在 `SwiftUIMacros` 插件里，仅完整 Xcode 提供；② XCTest 与 swift-testing 均无法构建（缺 `XCTest` 模块 / `TestingMacros` 插件）。**完整 Xcode 27.0 (27A266a)**：宏与测试框架均可用。 | 不切 `xcode-select`（需 sudo，且改动全局默认工具链），改用 `DEVELOPER_DIR=<Xcode>/Contents/Developer` 按命令指定。**代码刻意选在两条工具链的交集**：引导用 AppKit、视图不用属性包装器 → `swift build` 在两条工具链下都通过（CLT 已实测），装了 Xcode 的人也不受影响。测试则明确**要求完整 Xcode**（`Tests/BelieveBoyTests/`，见 §8 S1/S2）；`swift build` 不编译 testTarget，故 CLT 用户无感。若日后要切 `@main App` + `@State`/`@Bindable`，属独立 issue 的可选简化（当前无功能收益）。**一并就绪的还有打包链路**：`xcrun notarytool` / `swift-format` / `simctl` 在完整 Xcode 下均可解析（license、first-launch 已通过），S7a/S7b 不再卡工具链。**附带坑（S4 实测）**：两条工具链共用 `.build/` 时，索引产物会互相覆盖，sourcekit 报 `Compiled module was created by a different version of the compiler` 而后退回 `No such module`；另外 CLT 构建不了 testTarget，故 Editor 侧索引在 CLT 下必然残缺。处置：跑完 `swift test`（Xcode 工具链）后删 `.build/index-build`，需要索引时用 CLT 重建（`swift build`）；或给 `swift test` 单独指定 `--scratch-path .build/xcode-check` 与索引目录互不干扰。这条只影响本机编辑器体验，不影响构建与测试。**另一类同源假阳性（BLF-1060 实测）**：新建源文件后，索引侧的 SwiftPM 文件列表可能仍是旧的，于是**新文件里的类型在引用方报 `Cannot find 'X' in scope`**，而 `swift build` / `swift test` 全绿 —— 以构建为准，不要为一个只存在于索引侧的报错去改代码。 |
| **Xcode 安装位置非标准**（外置卷） | 真身 `/Volumes/Rock/Xcode.app` = **Xcode 27.0（build `27A266a`，即 27.0 RC）**，macOS 27.0 SDK（`macosx27.0`）+ Swift 6.4；`/Applications/Xcode.app` 只是 **416K 转发壳**（`Contents/Resources/real_app_path.txt` → 真实路径），**不含 toolchain**。本机 `xcode-select -p` **仍指向 `/Library/Developer/CommandLineTools`**，纯净 shell 下 `xcodebuild` 依旧报 "requires Xcode" | 两条等价写法：① 一次性（需密码，**留给用户执行**）`sudo xcode-select -s /Volumes/Rock/Xcode.app/Contents/Developer` —— **不能**指向 `/Applications/Xcode.app`（壳，无 `Contents/Developer`）；② 免 sudo、按命令生效（本仓库 CI/文档采用）：`DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer`。**外置卷未挂载时完整工具链不可用**（`swift test` 挂），CLT 路径仍可 `swift build`，代码不受影响。 |
| **桌面端 key 与网页端互踢**（曾是覆盖式轮换，一账号同时只有一把） | 拆分前：覆写同一行 `user_api_keys.key_hash`（`user_api_key_service.py:69`）→ 桌面端已存 key **立即失效**；调用方不止桌面端：Web 登录（`frontend/lib/auth/options.ts:47`）与改密码重认证（`frontend/app/api/user/password/route.ts:36`）都打 `POST /api/v1/auth/login`。失效表现为 **403 `Invalid API key`**（`security.py:45-71`），**不是 401** | **已解决**：后端 BLF-1059 把 key 按设备槽分区（迁移 272 + `X-Client-Id`），客户端 BLF-1060 每次登录都带上本机标识（`ClientIdentifier`，钥匙串 `client-id` 条目）→ 网页端与桌面端各持一把、互不顶（详见 §4.1.2）。仍保留的契约：**App 不打包/不内置 key**；**401/403 一律走「请重新登录」而非静默失败**（`APIError.requiresCredentialFix`）—— 现在的成因是同槽被顶 / 改密码撤销全部设备 / 槽超限回收最旧一把 |
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
