# 第一周执行计划：Go Gateway + MyGo 原生 macOS 壳

> **父计划：** `2026-10-26-mygo-native-go-migration.md`
> **状态：** 实现完成；双端手工联调与合并验收待完成
> **目标周期：** 5 个工作日

**Goal:** 在 5 天内交付一个可通过 Go Gateway 登录并显示原生工作台的 macOS MyGo 应用，同时由 Go 接管 14 个低风险只读 API。

**Architecture:** `backend-go` 提供统一网关，已迁移路径由 Go 处理，其余路径反向代理给 FastAPI；`desktop` 是独立 MyGo module，通过 HTTP 调用网关、用 Keychain 保存登录凭据、用原生 `ui` 构建窗口。

**Tech Stack:** Go 1.27.3、MyGo v0.6.4、chi、pgx、sqlc、PostgreSQL、Redis、macOS Keychain

## Global Constraints

- 桌面端不创建 `ui.WebView`，不加载任何 http(s) 页面。
- 第一周只迁移 GET 接口；不新增数据库迁移。
- 第一周 `/auth/*` 继续由 FastAPI 处理，桌面端通过 Gateway 调用。
- JSON 字段名、状态码和错误体必须与 FastAPI 一致。
- 所有写操作和复杂报表留到后续周。
- 不使用 Bun；桌面端没有 TypeScript 前端产物。
- 每个 Go 自有模块必须能通过 `GO_API_OWNED` 配置单独回退 FastAPI。

---

## Task 1：建立 Go workspace 与 MyGo 原生骨架

**Files:**
- Create: `go.work`
- Create: `backend-go/go.mod`
- Create: `backend-go/cmd/gateway/main.go`
- Create: `desktop/go.mod`
- Create: `desktop/mygo.json`
- Create: `desktop/main.go`
- Create: `desktop/main_test.go`
- Create: `desktop/resources/icon.png`

### Step 1：创建后端 module

```bash
mkdir -p backend-go/cmd/gateway
cd backend-go
go mod init github.com/passwii/believeboyDashboard/backend-go
```

### Step 2：创建 MyGo 原生项目

在仓库根目录执行：

```bash
go run github.com/egoist/mygo/cmd/mygo@v0.6.4 init \
  -template native \
  -name "BelieveBoy" \
  -module "github.com/passwii/believeboyDashboard/desktop" \
  desktop
```

### Step 3：确认桌面端没有 Web 前端

`desktop/mygo.json` 至少包含：

```json
{
  "name": "BelieveBoy",
  "identifier": "com.passwii.dashboard.desktop",
  "macos": {
    "minimumSystemVersion": "13.0"
  }
}
```

### Step 4：创建 go.work

`go.work`：

```go
go 1.27.3

use (
	./backend-go
	./desktop
)
```

### Step 5：验证骨架

```bash
go work sync
cd backend-go && go test ./...
cd ../desktop && go test ./... && go tool mygo vet
```

期望：后端只有占位 main 时测试通过；桌面端模板测试通过。

---

## Task 2：Gateway 配置、日志与反向代理地基

**Files:**
- Create: `backend-go/internal/config/config.go`
- Create: `backend-go/internal/httpserver/router.go`
- Create: `backend-go/internal/httpserver/middleware.go`
- Create: `backend-go/internal/httpserver/proxy.go`
- Test: `backend-go/internal/httpserver/proxy_test.go`

### Step 1：定义必需环境变量

```go
type Config struct {
	Addr          string
	FastAPIOrigin string
	APIKey        string
	DatabaseURL   string
	RedisURL      string
	OwnedModules  map[string]bool
}
```

读取并校验：

- `GO_API_ADDR`，默认 `127.0.0.1:8200`
- `FASTAPI_ORIGIN`，默认 `http://127.0.0.1:8100`
- `API_KEY`
- `DATABASE_URL`
- `REDIS_URL`
- `GO_API_OWNED`，默认 `""`

### Step 2：建立 chi Router

路由注册顺序：

1. 请求 ID、日志、panic recovery。
2. Go 自有路由。
3. 未匹配路径统一交给 `ReverseProxy`。

### Step 3：实现反向代理

使用 `httputil.NewSingleHostReverseProxy`，并设置：

```go
proxy.FlushInterval = -1
```

必须保留：

- 请求方法、路径、query。
- `Authorization`、`X-API-Key`、`X-Client-Id`、用户上下文字头。
- `Content-Type`、`Accept`、`Range`。
- SSE 的即时 flush。
- 客户端取消。

### Step 4：测试“未迁移路由回退 FastAPI”

用 `httptest` 启动假 FastAPI，断言：

- query 不被改写。
- `X-Operator` 和大写 `X-Is-Admin` 原样透传。
- 响应头和 body 原样返回。

```bash
cd backend-go
go test ./internal/httpserver/... -run TestProxyFallback -v
```

---

## Task 3：API Key 鉴权与用户上下文

**Files:**
- Create: `backend-go/internal/auth/api_key.go`
- Create: `backend-go/internal/auth/context.go`
- Test: `backend-go/internal/auth/api_key_test.go`

### Step 1：支持三种 key 来源

优先级与 FastAPI 保持一致：

1. `Authorization: Bearer <key>`
2. `X-API-Key`
3. `?api_key=`

### Step 2：主 key 快速路径

配置中的 `API_KEY` 命中后直接放行，不访问数据库。

### Step 3：用户设备 key 校验

对候选 key 计算 SHA-256，查询：

```sql
select user_id::text, revoked_at
from public.user_api_keys
where key_hash = $1
limit 1
```

规则：

- 未找到：继续尝试下一个候选值。
- `revoked_at is not null`：返回 403。
- 有效：放行。
- 数据库错误：fail closed，返回 403。

### Step 4：测试

覆盖：

- 主 key。
- Bearer key。
- query fallback。
- 无效 key。
- 已吊销 key。

```bash
cd backend-go
go test ./internal/auth/... -v
```

---

## Task 4：迁移 14 个只读 API

**Files:**
- Create: `backend-go/internal/store/db.go`
- Create: `backend-go/internal/store/queries/*.sql`
- Create: `backend-go/internal/api/health/handler.go`
- Create: `backend-go/internal/api/exchange_rates/handler.go`
- Create: `backend-go/internal/api/notifications/handler.go`
- Create: `backend-go/internal/api/alerts/handler.go`
- Create: `backend-go/internal/api/profile/handler.go`
- Test: `backend-go/tests/contract/week1_contract_test.go`

### 路由清单

```text
GET /api/v1/health
GET /api/v1/health/live
GET /api/v1/health/ready
GET /api/v1/exchange-rates
GET /api/v1/exchange-rates/resolve
GET /api/v1/exchange-rates/options
GET /api/v1/exchange-rates/{exchange_rate_id}
GET /api/v1/notifications
GET /api/v1/notifications/unread-count
GET /api/v1/alerts/metrics
GET /api/v1/alerts/rules
GET /api/v1/alerts/events
GET /api/v1/alerts/stats
GET /api/v1/system-management/profile
```

### 实现要求

- 使用 `pgxpool`，读请求默认走主库；读副本在第二周接入。
- 静态排序路径必须优先于 `{id}`。
- `notifications` 必须校验 `X-User-Id`。
- `alerts/rules` 与 `alerts/events` 必须复刻项目可见性过滤。
- `profile` 必须校验 `X-User-Id`。
- 时间字段按现有 ISO-8601 形式输出。
- JSON 字段严格使用 snake_case。

### 契约测试

每个操作至少 2 个样本：

1. 正常数据。
2. 未找到或空数据。

测试流程：

1. 对 FastAPI 发请求并记录状态码 + JSON。
2. 对 Go 发相同请求。
3. 忽略字段顺序，比较语义 JSON。
4. 金额和汇率使用 `1e-9` 相对误差，时间允许 ±1 秒。

```bash
cd backend-go
go test ./tests/contract/... -run TestWeek1 -v
```

---

## Task 5：Desktop 配置、API Client 与 Keychain

**Files:**
- Create: `desktop/internal/config/config.go`
- Create: `desktop/internal/api/client.go`
- Create: `desktop/internal/api/types.go`
- Create: `desktop/internal/auth/session.go`
- Create: `desktop/internal/auth/keychain.go`
- Test: `desktop/internal/api/client_test.go`
- Test: `desktop/internal/auth/session_test.go`

### Step 1：本地配置

首次启动生成并保存：

- `client_id`：UUID，存入 `os.UserConfigDir()/BelieveBoy/config.json`
- `api_base_url`：默认 `http://127.0.0.1:8200`
- `last_route`

### Step 2：Keychain

`mygo.Secrets` 保存：

- `api_key`
- `session_id`
- 用户 id / 邮箱 / 姓名 / 角色

签名后不得因为 app 重建导致 Keychain 身份变化；开发期使用 MyGo 的 `.dev` identifier 隔离。

### Step 3：API Client

登录：

```http
POST /api/v1/auth/login
X-Client-Id: bb-macos-<client_id>
Content-Type: application/json
```

后续请求附带：

```http
X-API-Key: <api_key>
X-Session-Id: <session_id>
X-User-Id: <user_id>
X-User-Email: <email>
X-User-Name: <name>
X-Operator: <name>
X-Is-Admin: true|false
```

### Step 4：测试

- 登录成功保存 session。
- 401/429 返回稳定错误。
- 退出登录清除 Keychain。
- 网络错误不覆盖已有 session。

```bash
cd desktop
go test ./internal/api/... ./internal/auth/... -v
```

---

## Task 6：MyGo 原生登录页

**Files:**
- Create: `desktop/internal/pages/login.go`
- Create: `desktop/internal/components/brand_panel.go`
- Test: `desktop/internal/pages/login_test.go`

### 布局

- 窗口最小 `1000x700`，默认 `1120x760`。
- 左侧 56%：品牌、短说明、状态标识。
- 右侧 44%：登录表单。
- 使用 `ui.Form`、`ui.Field`、`ui.TextInput`、`ui.PrimaryButton`。
- 登录中禁用按钮并显示 `ui.Spinner`。
- 错误显示在字段下方和顶部错误条，不弹系统 alert。

### 交互

- Enter 提交。
- Tab 顺序正确。
- 空邮箱、空密码、网络错误和限流错误分别有稳定文案。
- 成功后 `ui.Router.Replace("/home")`。

### 测试

```bash
cd desktop
go test ./internal/pages/... -run TestLogin -v
```

---

## Task 7：原生应用外壳与设计 token

**Files:**
- Create: `desktop/internal/design/tokens.go`
- Create: `desktop/internal/design/icons.go`
- Create: `desktop/internal/components/shell.go`
- Create: `desktop/internal/components/rail.go`
- Create: `desktop/internal/components/header.go`
- Create: `desktop/internal/components/stat_card.go`
- Create: `desktop/internal/pages/home.go`
- Create: `desktop/internal/pages/placeholder.go`
- Modify: `desktop/main.go`

### 外壳

```text
64px Rail | 224px Sidebar | 56px Header + Main | 320px Inspector
```

### 首页

第一周显示 4 个真实数据卡：

1. API/数据库/Redis 健康状态。
2. 未读通知数。
3. 活跃告警数。
4. 当前用户与角色。

项目选择使用 FastAPI 的 `/api/v1/projects/manage`，通过 Gateway 代理。

### 导航

- 首页、项目、运营、报表、AI、系统。
- 本周只启用首页与系统设置。
- 未实现页面显示原生 Placeholder，不打开网页。

### 快捷键

- `⌘R` 刷新首页数据。
- `⌘,` 打开设置。
- `⌘Q` 退出。

### 测试

- 外壳四栏尺寸与折叠。
- 首页 loading、success、error。
- 导航切换后焦点与页面标题正确。

```bash
cd desktop
go test ./internal/pages/... ./internal/components/... -v
```

---

## Task 8：Web 与 Desktop 双端联调

**Files:**
- Modify: 仅环境变量，不改 Next.js 业务代码

### Next.js

将 `BACKEND_API_BASE_URL` 指向 Go Gateway：

```env
BACKEND_API_BASE_URL=http://127.0.0.1:8200
```

验证：

- 登录仍由 FastAPI 处理。
- 已迁移接口命中 Go。
- 未迁移接口由 Gateway 代理到 FastAPI。
- 上传、SSE 和下载至少各验证一次代理。

### Desktop

- 登录。
- 首页加载。
- 重启 app 后自动恢复 Keychain session。
- 退出登录后回登录页。

---

## Task 9：构建与验收

### 技术验证

```bash
cd backend-go
go test ./...
go vet ./...

cd ../desktop
go test ./...
go tool mygo vet
go tool mygo build -skip-dmg
```

### 手工验收

- `go tool mygo dev` 启动纯原生窗口。
- 登录后显示工作台。
- 断开 FastAPI 后，Go 自有接口仍有稳定错误；代理接口返回 502/503 而不是崩溃。
- 关闭 Go 模块开关后，对应请求回退 FastAPI。
- 全流程不出现 WebView、网页加载或 Bun 产物。

## 出口标准

- [ ] 14 个只读操作由 Go 接管。
- [ ] Gateway 对未迁移 API 的代理回归通过。
- [ ] Next.js Web 不改业务代码即可工作。
- [ ] MyGo 原生登录、Keychain、外壳、首页完成。
- [ ] `ui.NewTester` 测试覆盖登录和导航。
- [ ] macOS `.app` 构建成功。
- [ ] 全仓库没有新增桌面 WebView 或前端依赖。
