# Phase 0 — 工程骨架与工具链

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始

**Goal:** 建好 `go/` 工程骨架、统一规范（lint/错误处理/日志/配置）、CI 门禁和契约测试 harness，让后续 5 个 Phase 的多 agent 并行开发不漂移。

**Architecture:** 单 Go module（`believeboy-go`），`services/api` 与 `services/worker` 共享 `pkg/`；配置文件与 Python 共用同一 `.env` 变量名，保证双栈运行时配置一致。

## 0.0 参照源（只读，勿改）

| 参照 | 路径 | 用途 |
|------|------|------|
| FastAPI 入口 | `backend/app/main.py` | 中间件装配顺序、 lifespan 事件 |
| 配置定义 | `backend/app/core/config.py`（329 行） | 环境变量清单（逐个搬） |
| 路由装配 | `backend/app/api/v1/router.py` + `lazy_router.py` + `router_groups/`（9 组） | Phase 2 路由分组依据 |
| DB 会话 | `backend/app/db/session.py`、`replica.py`、`redis.py` | 连接池参数（pool size、超时） |
| Celery 工厂 | `backend/app/tasks/celery_app.py`、`script_registry.py` | Phase 3 任务清单 |
| systemd | `backend/deploy/systemd/`（4 个 unit） | Phase 6 替换模板 |
| 依赖锁 | `backend/requirements.txt` | 外部服务 SDK 对照（boto3→aws-sdk-go-v2 等） |

## 0.1 目标目录布局（锁定）

```
go/
├── go.mod                          # module believeboy-go, go 1.26
├── Makefile                        # lint/test/build/migrate 统一入口
├── .golangci.yml                   # lint 规则（见 0.3）
├── pkg/
│   ├── config/                     # 环境变量 struct（对齐 backend/app/core/config.py）
│   ├── logging/                    # slog 封装（JSON，字段名对齐 Python 日志）
│   ├── httpx/                      # 统一 HTTP 客户端（超时/重试，对齐 backend 用 httpx 的参数）
│   ├── errors/                     # 统一错误码（对齐 Python HTTPException status/message 风格）
│   └── testutil/                   # 契约测试 harness（seed、diff、record/replay）
├── services/
│   ├── api/                        # Phase 2（本 Phase 只建 main.go + 健康检查）
│   └── worker/                     # Phase 3（本 Phase 只建 main.go 占位）
├── internal/                       # 各服务私有代码（按 Phase 2/3 填充）
├── migrations/                     # 空目录占位；Phase 4 前禁止写入
└── desktop/                        # 空目录占位；Phase 5 使用
```

## 任务

### Task 0.1：初始化 module + Makefile + golangci-lint

- [ ] **Step 1: 建目录并初始化 module**

```bash
mkdir -p go/{pkg/{config,logging,httpx,errors,testutil},services/{api,worker},internal,migrations,desktop}
cd go && go mod init believeboy-go && go mod tidy
```

- [ ] **Step 2: 写 `.golangci.yml`**（锁死，后续 agent 不得放宽）：`gofmt`、`goimports`、`govet`、`staticcheck`、`revive`、`errcheck`（必须处理 error）、`gosec`（G101 除外：SQL 拼接全部走 sqlc，见 Phase 2）、`lll`（行宽 140）、`godot`（注释句号）。

- [ ] **Step 3: 写 `Makefile` 目标**：`lint` / `test`（`go test ./...`）/ `build-api` / `build-worker` / `sqlc-generate`（Phase 2 用，先占位报错提示）。

- [ ] **Step 4: 验证**

```bash
cd go && make lint && make test && make build-api && make build-worker
```

Expected：全部通过（空 main 仅打印版本）。

- [ ] **Step 5: Commit**

```bash
git config --show-origin --get user.email   # 必须 jr.way123@gmail.com
git add go/
git commit -m "chore(go): 初始化 go 工程骨架与 lint 门禁"
```

### Task 0.2：`pkg/config` —— 与 Python 同名环境变量

- [ ] **Step 1: 从 `backend/app/core/config.py` 提取全部字段**，逐个建 Go struct（用 `github.com/caarlos0/env/v11` 解析）。规则：变量名**一字不改**（双栈共用 `.env`），类型按 Python 语义映射（`SecretStr→string`、`PostgresDsn→string` 做连接串校验）。
- [ ] **Step 2: 写单元测试**：每个变量给缺省值/必填断言各一个；跑 `go test ./pkg/config/ -v` 通过。
- [ ] **Step 3: 写 `pkg/config/README.md` 对照表**：Python 字段名 → Go 字段名 → 说明（后续 Phase 查表用）。
- [ ] **Step 4: Commit**：`chore(go): pkg/config 对齐 Python 环境变量`。

### Task 0.3：`pkg/logging` + `pkg/errors` + `pkg/httpx` 规范三件套

- [ ] **Step 1: `pkg/logging`**：基于 `log/slog` 的 JSON handler，字段固定 `ts/level/msg/trace_id`；`trace_id` 从 Gin middleware 注入（Phase 2 用，先留 `FromContext` 接口）。
- [ ] **Step 2: `pkg/errors`**：`E(code int, msg string, cause error)` + `HTTPStatus()` 映射；code 段与现有前端 `lib/error-utils.ts` 解析的后端错误体字段对齐（先读该文件再定 struct）。
- [ ] **Step 3: `pkg/httpx`**：默认超时 30s、可配置重试（对齐 `backend/app/services/ai/llm.py` 的 429/5xx 重试语义：指数退避 + `Retry-After` 尊重）。
- [ ] **Step 4: 各包单测通过 + Commit**：`chore(go): 日志/错误/HTTP 客户端规范三件套`。

### Task 0.4：契约测试 harness 骨架（`pkg/testutil`）

这是 Phase 4 全量 diff 的地基，本 Phase 只做骨架 + 一个示例。

- [ ] **Step 1: 实现 `testutil.Seed(t, dsn)`**：连 `BLF_test` 库，跑最小 seed（1 project + 1 user + 1 sku），返回清理函数。**禁止连 `BLF` 库**：函数内硬编码拒绝非 `*_test` 库名。
- [ ] **Step 2: 实现 `testutil.DiffJSON(t, want, got []byte)`**：语义化 JSON 比较（忽略字段顺序；时间字段允许 ±1s；浮点用 1e-9 相对误差——pandas→Go 的 Decimal 边界在此统一）。
- [ ] **Step 3: 示例契约测试**：`services/api` 的 `/health`（对齐 `backend/app/api/v1/endpoints/health.py` 的 3 个路由：health/liveness/readiness），断言 Go 与 Python 返回体 `DiffJSON` 通过。
- [ ] **Step 4: 跑通 `go test ./...` + Commit**：`test(go): 契约测试 harness 骨架与 health 示例`。

### Task 0.5：CI 门禁

- [ ] **Step 1: GitHub Actions（或现有 CI 配置位置）加 `go-lint-test` job**：`make lint && make test`，Go 版本 pin `1.26.x`。
- [ ] **Step 2: 空跑验证通过 + Commit**：`chore(ci): Go lint+test 门禁`。

## Exit Criteria

- [ ] `cd go && make lint && make test && make build-api && make build-worker` 全绿
- [ ] `pkg/config/README.md` 对照表覆盖 `config.py` 全部字段（逐个打勾）
- [ ] 契约 harness 示例测试通过（含 `BLF_test`-only 硬保护）
- [ ] CI 门禁生效
