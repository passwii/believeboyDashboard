# Go 后端渐进迁移 + MyGo 原生桌面总计划

> **状态：** 进行中
> **日期：** 2026-10-26
> **首周执行计划：** `2026-10-26-mygo-native-go-migration-week1.md`
> **替代关系：** 替代 `2026-09-03-go-fullstack-migration-phase5.md` 的 Wails/WebView 桌面方案；旧计划的 Phase 0-4 后端迁移思路仍可复用，但路由、模型和工期必须以本计划的新快照为准。

**Goal:** 用 Go 渐进接管 FastAPI API，并以 MyGo 原生 `ui` 组件构建不使用 WebView/Next.js 的 macOS 桌面端，最终下线 Python 后端。

**Architecture:** 新建独立的 `backend-go/` 与 `desktop/` 两个 Go module，通过 `go.work` 联合开发。Next.js 和 MyGo 桌面端都请求同一个 `backend-go` 网关；网关先处理已迁移路由，其余请求反向代理给 FastAPI。桌面端是纯 Go 原生 UI，不加载网页、不嵌入 Next.js、不依赖 Bun。

**Tech Stack:** Go 1.27.3 / MyGo v0.6.4 / `net/http` + `chi` / `pgx/v5` / `sqlc` / PostgreSQL / Redis / `httputil.ReverseProxy`

---

## 1. 决策与边界

### 已确定

1. 后端按 URL 组渐进迁移，不做大爆炸重写。
2. Next.js 继续服务 Web 用户，桌面端不复用其页面或组件。
3. 桌面端使用 MyGo 原生 `ui`、`ui/chart` 和 MyGo 桌面 API。
4. PostgreSQL 继续作为唯一数据库；Alembic 在最终切换前仍是迁移真源。
5. 第一周只迁移只读、低风险 API，不碰资金计算、后台任务、AI、Excel/PDF 和 pandas。
6. 所有迁移接口必须保持现有 JSON 字段、状态码和错误体兼容。

### 明确不做

- 不在 MyGo 窗口里加载 `https://dash...`、Next.js 页面或任何 WebView。
- 不把 React/shadcn 组件翻译成 MyGo 组件；桌面端从现有 V3 Terminal 视觉语言重新实现。
- 不在第一周翻译 261 个 Alembic 迁移。
- 不在第一周迁移 Celery、报表、截图、邮件、AI Chat 或 Insight。

## 2. 目标架构

```text
               ┌──────────────────────┐
Next.js Web ──►│ backend-go gateway   │
               │                      │
MyGo Native ──►│ owned Go handlers    │──► PostgreSQL
               │          │           │──► Redis
               │          ▼           │
               │ FastAPI fallback ────┼──► 现有后端能力
               └──────────────────────┘
```

### 网关规则

- 已迁移路径由 Go 处理。
- 未迁移路径原样代理到 `FASTAPI_ORIGIN`。
- 反向代理保留 `Authorization`、`X-API-Key`、`api_key` 查询参数、用户上下文头、SSE、multipart、下载和请求取消。
- 路由所有权先由环境变量 `GO_API_OWNED` 控制，格式为逗号分隔的模块名：
  `health,exchange_rates,notifications,alerts,profile`。
- 每个模块必须可独立关闭并回退 FastAPI。
- 任何响应结构变化都必须先更新契约测试，不允许“顺便优化”接口。

### 鉴权

- 第一周 `/auth/*` 仍代理给 FastAPI。
- 桌面登录继续调用 `POST /api/v1/auth/login`，请求携带稳定的 `X-Client-Id`。
- 桌面端把登录返回的 `api_key` 和 `session_id` 存入 macOS Keychain，不写明文文件。
- Go 自有路由校验主 API key、用户设备 API key、可选的 `?api_key=` 回退参数。
- 用户设备 key 的用户上下文只取 `user_api_keys -> user_accounts` 的数据库身份；客户端提交的 `X-User-Id`、`X-User-Name`、`X-Operator`、`X-Is-Admin` 一律不作为设备直连路径的授权依据。
- master key 保留受信代理语义，但必须同时携带服务端共享密钥头 `X-Trusted-Proxy-Secret`（环境变量 `GO_API_TRUSTED_PROXY_SECRET`）；缺失或不匹配时返回 403。该头只允许由 Next.js 服务端代理注入，不得进入浏览器，且 Go Gateway 转发 FastAPI 前会剥离。
- `GO_API_TRUSTED_PROXY_SECRET` 为空时设备 key 仍可用，但 master key 代理模式关闭。FastAPI 直连行为在 Phase 1 不变，Web 流量仍不切到 Gateway。

## 3. 目录结构

```text
go.work

backend-go/
├── go.mod
├── cmd/
│   └── gateway/
│       └── main.go
├── internal/
│   ├── config/
│   ├── httpserver/
│   │   ├── router.go
│   │   ├── middleware.go
│   │   └── proxy.go
│   ├── auth/
│   │   └── api_key.go
│   ├── store/
│   │   ├── db.go
│   │   └── queries/
│   ├── contract/
│   └── api/
│       ├── health/
│       ├── exchange_rates/
│       ├── notifications/
│       ├── alerts/
│       └── profile/
└── tests/
    ├── contract/
    └── integration/

desktop/
├── go.mod
├── go.sum
├── mygo.json
├── main.go
├── main_test.go
├── resources/
│   └── icon.png
└── internal/
    ├── app/
    ├── api/
    ├── auth/
    ├── config/
    ├── design/
    ├── components/
    └── pages/
```

使用两个独立 module 的原因：

- MyGo CLI 作为 desktop module 的 tool 固定版本，不污染后端依赖。
- 后端可以独立测试、部署和升级。
- 桌面端只通过 HTTP 契约访问后端；未来若需要离线能力，再抽共享契约包。

## 4. API 迁移顺序

### 第一周：只读基础设施与轻量查询

共 14 个操作：

1. `GET /api/v1/health`
2. `GET /api/v1/health/live`
3. `GET /api/v1/health/ready`
4. `GET /api/v1/exchange-rates`
5. `GET /api/v1/exchange-rates/resolve`
6. `GET /api/v1/exchange-rates/options`
7. `GET /api/v1/exchange-rates/{id}`
8. `GET /api/v1/notifications`
9. `GET /api/v1/notifications/unread-count`
10. `GET /api/v1/alerts/metrics`
11. `GET /api/v1/alerts/rules`
12. `GET /api/v1/alerts/events`
13. `GET /api/v1/alerts/stats`
14. `GET /api/v1/system-management/profile`

`projects/*` 第一周继续由 FastAPI 提供。原因是现有 projects GET 接口会写操作审计日志，不属于“纯只读低风险”路径；把它留到第二周与项目权限、审计一起迁移。

### 第二周：认证与项目域

- 迁移 `/auth/login`、`/auth/me`。
- 迁移 `/projects/manage`、`/projects`、`/projects/operator-options`、`/projects/{id}/shops`。
- 复刻登录限流、操作审计、Redis session、设备槽 API key 轮换。
- 桌面端完成项目切换、用户菜单和原生导航持久化。

### 第三周：通知与告警写路径

- 迁移通知已读、全部已读、删除。
- 迁移告警规则 CRUD、事件 acknowledge/resolve、偏好设置。
- 桌面端完成通知中心、告警 Inspector 和 macOS 系统通知。

### 第四周：第一条分析读取链路

- 从 `daily-analysis` 中选一个最小完整链路，先迁移项目/国家/日期筛选和 summary 读取。
- FastAPI 继续承接 detail rows、复杂聚合和未迁移分支。
- 桌面端首页切换为 Go 数据源，完成 KPI、趋势图和明细表。

### 第五周：首个写闭环与内部发布

- 迁移汇率新增/修改/删除，形成第一条完整 CRUD 闭环。
- 完成 Gateway 指标、审计日志、契约回归、回滚演练。
- 产出可签名的 macOS 内部构建和首轮试用说明。

## 5. MyGo 桌面端全局框架

### 视觉语言

沿用当前 V3 Terminal 的高密度工作站语言，但在 MyGo 中重新实现：

- 64 DIP 业务域 Rail。
- 224 DIP 子导航 Sidebar。
- 56 DIP 顶部工具栏。
- 主内容区使用 1px 边框、零圆角、等宽数字和紧凑间距。
- 右侧 Inspector 默认折叠，展开宽度 320-360 DIP。
- 明暗主题跟随系统，支持 MyGo `Theme.OnUpdated`。

### 原生组件映射

| 现有 Web 结构 | MyGo 原生实现 |
|---|---|
| TerminalShell | `ui.Row` + `ui.Column` + `ui.Router` |
| 业务域 Rail | 自绘 `ui.Column` + `ui.ButtonBase`/Icon |
| 子导航 | `ui.Sidebar` + `ui.SidebarSection` |
| 顶部筛选栏 | `ui.Row` + `ui.Select` + `ui.SearchField` + `ui.Button` |
| 数据表 | `ui.Table` + `ListState` |
| KPI 卡 | `ui.Column`/`ui.Grid` + `ui.Text` + `ui.Badge` |
| 图表 | `ui/chart` |
| 通知/告警 | `ui.List` + `ui.Badge` + `ui.Toast` |
| 登录 | `ui.Form` + `ui.Field` + `ui.TextInput` + `ui.PrimaryButton` |
| 未实现页面 | 原生 Placeholder，不打开 WebView |

### 桌面页面优先级

| 优先级 | 页面 | 首周 |
|---|---|---|
| P0 | 登录 | 完成 |
| P0 | 应用外壳与导航 | 完成 |
| P0 | 工作台首页骨架 | 完成 |
| P0 | 用户状态与退出 | 完成 |
| P1 | 项目切换 | 用 FastAPI 数据完成 |
| P1 | 通知中心 | 第二至三周 |
| P1 | 告警 Inspector | 第二至三周 |
| P2 | 订单、库存、定价、报表 | 后续按后端切片迁移 |
| P3 | AI、CRM、复杂报表 | 最后迁移 |

### 状态与线程

- 所有 UI 状态只在主线程读写。
- 网络请求在 goroutine 中执行，完成后通过 `Window.Update` 回写。
- 登录 token、client id、API base URL 通过可替换接口注入，便于测试。
- 不在 `ui.Element` 中保存跨帧状态；需要持久身份时使用 `ui.Handle`。

## 6. 质量门禁

### 后端

- `go test ./...` 全绿。
- 每个迁移接口至少一个契约测试：同参数下 Go 与 FastAPI 的 JSON 语义一致。
- `GET` 路径必须使用 `BLF_test` 或只读生产快照 `BLF`；写测试只允许 `BLF_test`。
- SSE、multipart、下载和取消请求至少有 1 个代理回归测试。
- 每个模块可以单独通过 `GO_API_OWNED` 关闭并回退。

### 桌面端

- `go test ./...` 全绿。
- `go tool mygo vet` 通过。
- `ui.NewTester` 覆盖登录校验、登录成功、导航切换、空态和错误态。
- `go tool mygo build -skip-dmg` 产出可运行的 macOS `.app`。
- 不使用 WebView、不加载 http(s) 页面、不依赖 Bun 或 Next.js 产物。

## 7. 后续大框架

### Milestone A：只读运营域（第 6-9 周）

- 项目域完整迁移。
- 订单信息、SKU、库存、汇率、通知、告警的只读路径。
- 桌面端完成对应原生表格、筛选器和详情面板。

### Milestone B：核心写路径（第 10-14 周）

- 项目、SKU、库存补货、发货计划、定价核算的写接口。
- 权限、操作审计、幂等和事务语义逐项对齐。
- 桌面端形成可日常使用的运营工作台。

### Milestone C：报表与后台任务（第 15-22 周）

- Asynq + gocron 替代 Celery Beat/Worker。
- Excel/PDF、邮件、R2、截图、定时报表。
- AI Chat、Insight、流式协议和 token 统计。

### Milestone D：生产切换与下线 Python（第 23-26 周）

- 影子流量、按域切流、回滚演练。
- Alembic baseline 转 Go migration runner。
- 停用 FastAPI、Celery 和 `autoReportUpload` Python 运行时。

> 上述周数是当前架构下的执行框架，不是承诺工期。每个 Milestone 必须通过上一阶段的对等验证后才能开始。

## 8. 首周出口

- Go Gateway 已接管 14 个只读操作，并透明代理其余 API。
- Next.js Web 只改后端 base URL 即可继续工作。
- MyGo 原生 macOS 应用可登录、持久化凭据、切换页面并展示首页骨架。
- 桌面端完全不使用 WebView/Next.js。
- 契约测试、代理回归、MyGo view tests 和 macOS 构建全部通过。
