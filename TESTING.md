# 测试总览

> **入口文档。** 本文件描述项目里"测试"这件事的整体架构与流程；具体使用细节见各子 README。读这一份应该能在 5 分钟内搞清楚"测试有几层、各层干什么、怎么搭起来、想加东西在哪里加"。

## 架构分层

测试基建按"层次"组织，每层职责互斥：

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3 · 权限矩阵 / 场景预设（路线图，未来追加）                  │
│   → docs/superpowers/plans/2026-07-14-test-db-and-playwright-    │
│     foundation.md §路线图 R1 / R2                                │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2 · Playwright E2E（端到端真实浏览器鉴权 + UI 流程）         │
│   · Python agent E2E 已随 FastAPI 退役删除                        │
│   · TypeScript (frontend/tests)                                   │
│     → smoke 例：frontend/tests/ai-chat/smoke.spec.ts              │
│     → 该 spec 内联了 NextAuth credentials REST 流（参见 spec      │
│       顶部 JSDoc 的「Auth pattern」段落，与 Python 模式一致）；   │
│       仓库其他前端 spec 也都内联，因为 Playwright 1.59.1 加载    │
│       跨文件 Node built-in 模块时存在 quirk。                    │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1 · Go 单元 / 契约测试（go test + 真实 DB）                 │
│   → backend-go/internal/**/*_test.go                             │
│   → 契约：backend-go/tests/contract（623 operation 覆盖）         │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Layer 0 · 测试数据与账号基础设施（所有上层共用）                   │
│   → 独立测试库：backend-go/cmd/setuptestdb                          │
│   → 测试账号 seed：backend-go/cmd/seedtestaccounts                 │
│   → 开关：app/core/config.py 的 TEST_DATABASE_URL                │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计：** Layer 0 是底层契约——一旦 Layer 0 搭好，Layer 1/2/3 都建立在它之上，不需要各自维护一份"测试数据从哪来"。**追加任何测试类型**先回到 Layer 0 看是否需要扩展数据/账号，再决定上层怎么写。

---

## 本地服务（mac / brew）

> **当前状态（BEL-376 起）：** 本地 Postgres（brew `postgresql@18`）**常驻运行**——主库
> `BLF` 是一份**生产数据快照**，用于通过本地 backend 做真实的读写 / 外部 API 集成测试
> （见下方「本地生产快照库」一节）。因此旧的「跑测试前启动、测完关闭」省资源原则
> **不再适用于 DB**；Redis 仍可按需启停（仅 Celery 定时报告 / AI 摘要等后台任务需要）。

### 1. 启动（若 DB 未在跑）

```bash
# PostgreSQL（主库 BLF=生产快照 + 测试库 BLF_test 都建在本地 PG 上；BEL-376 起常驻）
brew services start postgresql@18     # 版本按本机 brew 装的实际大版本号调整（当前 @18）
# 确认在监听
pg_isready                          # 期望 → /tmp:5432 - accepting connections

# Redis（Celery broker：定时报告 / AI 摘要等后台任务依赖；纯读写测试可不起）
brew services start redis
# 确认在监听
redis-cli ping                      # 期望 → PONG
```

- 首次跑测试还需先初始化独立测试库（见下方「一次性搭建」）：
  `cd backend-go && go run ./cmd/setuptestdb`（会自动建 `BLF_test` + seed 账号）。
- 纯单元测试（不碰队列）Redis 可不起；
  一旦用例触发后台任务（定时报告 / AI 摘要 / 鉴权缓存），Redis 必须在线，否则任务派发失败。

### 2. 关闭（测完释放资源）

```bash
brew services stop redis            # Redis 可停
brew services stop postgresql@18    # BEL-376 起 DB 常驻，一般不再停（停了本地 backend 连不上）
# 想看当前在跑哪些 brew 服务
brew services list
```

### 3. 忘记是否已启动？先查再决定

```bash
pg_isready && redis-cli ping        # 两者都通 → 直接跑测试即可
```

> 注意（BEL-376 更新）：`backend/.env` 现已**直接写入** `DATABASE_URL`，指向本地生产快照
> `postgresql+psycopg://damon:<pw>@localhost:5432/BLF`（旧值曾误指向死端口 `55432`，已修正为 `5432`）。
> `TEST_DATABASE_URL` / `GO_API_TEST_DATABASE_URL` 仍在 `backend/.env.test`（gitignored）→ `BLF_test`，供 Go 测试隔离用。
> 连哪个库以 `psql -l` 列出的本地库为准（主库 `BLF`=生产快照，测试库 `BLF_test`）。

---

## 本地生产快照库（BEL-376）— 集成 / 手动读写测试

> **定位：** `BLF` 是从 VPS 生产库 `pg_dump` 下来、恢复到本地的**真实数据快照**（brew PG，
> 端口 5432，常驻）。用途是**通过本地 backend 对真实数据做读写 / 外部 API 集成测试**，
> 不必在 VPS 上操作。**与自动化测试的 `BLF_test` 隔离机制互不影响**——Go 测试仍走
> `TEST_DATABASE_URL`→`BLF_test`（见上方架构分层），生产快照只用于手动 / 集成验证。

### 起本地 backend 测外部 API

`backend/.env` 的 `DATABASE_URL` 已指向本地 `BLF`，直接起 Go 网关即可：

```bash
cd backend-go && go run ./cmd/gateway   # 监听 127.0.0.1:8200
# 另开终端调用（示例：项目 1 的美国站广告 + 补货分析）
curl 'http://127.0.0.1:8200/api/v1/external/projects/1/ad-campaigns?period=custom&start_date=2026-07-01&end_date=2026-07-30&country=US&limit=5'
curl 'http://127.0.0.1:8200/api/v1/external/projects/1/replenishment-analysis?country=US&page_size=5'
```

### 刷新快照（拉最新生产数据）

VPS 磁盘紧张，用**流式** `pg_dump` 经 SSH 直写本地（不落 VPS 盘），再 `pg_restore` 覆盖本地 `BLF`：

```bash
# 1. 流式备份到本地（密码从 VPS 的 backend/.env 取）
ssh root@145.79.143.98 'export PGPASSWORD=$(grep -E "^DATABASE_URL=" /root/believeboyDashboard/backend/.env | sed -E "s#.*://damon:([^@]+)@.*#\1#"); pg_dump -U damon -h localhost -Fc --no-owner --no-privileges BLF' > ~/db_backups/BLF_prod_$(date +%Y%m%d).dump
# 2. 旧库改名留底 → 重建 → 恢复
psql -d postgres -c 'ALTER DATABASE "BLF" RENAME TO "BLF_prev_'$(date +%Y%m%d)'";'
psql -d postgres -c 'CREATE DATABASE "BLF" OWNER damon ENCODING '"'"'UTF8'"'"';'
pg_restore -U damon -d BLF -j 4 --no-owner --no-privileges ~/db_backups/BLF_prod_$(date +%Y%m%d).dump
```

> 恢复后的库比生产 `pg_database_size` 小很多属正常——生产含多年表膨胀（bloat），新恢复的库是紧凑的，数据一致。
> 首次切换留下的旧本地 dev 库名为 `BLF_local_prev_*`，确认无用后可 `DROP DATABASE` 清理。

---

## 流程总图

### 一次性搭建（每个开发者首次或库 schema 变了时）

```
┌──────────────────────────────────────────────────────────┐
│ 1. 在 backend/.env.test 里配置：                          │
│      TEST_DATABASE_URL=postgresql+psycopg://...:5432/BLF_test │
│      TEST_ADMIN_PASSWORD=...                              │
│      TEST_OPERATOR_PASSWORD=...                           │
│      TEST_BUSINESSDEV_PASSWORD=...                        │
│ 2. cd backend-go && go run ./cmd/setuptestdb                │
│    → 建库（如不存在）+ pg_dump --schema-only 克隆 schema    │
│      + seed admin / operator / businessdev                │
│                                                          │
│ 若 BLF 快照落后 Alembic 285（crm_intent_meta 等表缺失），   │
│ 克隆后 seed 迁移会失败：改用空库 + go run ./cmd/migrate up │
│ （baseline 自带 285 全量 schema），再跑 seedtestreference   │
│ 与 seedtestaccounts。                                     │
└──────────────────────────────────────────────────────────┘
                          ↓
              独立的 BLF_test 测试库已就绪
                          ↓
   ┌──────────────────────┴──────────────────────┐
   ↓                                             ↓
Layer 1 go test                          Layer 2 Playwright
   ↓                                             ↓
BLF_test + 隔离 fixture                  frontend/tests/*.spec.ts
```

### 每次跑测试

```
Go 测试 (Layer 1)：
  cd backend-go && go test ./internal/api/profile -count=1
  cd backend-go && go run ./cmd/migrate up   # 首次准备 BLF_test

Playwright E2E (Layer 2)：
  1. backend-go 网关指向 BLF_test（cmd/localcutover up）
  2. pnpm dev
  3. pnpm test:ui -- tests/<area>/<name>.spec.ts
```

> **本地测试是标准流程**：本地 PG 常驻两个库——`BLF`（生产快照，每日自动同步远程 VPS）与 `BLF_test`（自动化测试隔离专用，`backend-go/cmd/setuptestdb` 创建）。所有测试一律走 `BLF_test`，绝不写 `BLF`。

---

## Go Gateway 测试与 golden 契约

`backend-go/` 与 `desktop/` 由 `.github/workflows/test-ci.yml` 独立跑
`go test ./...` + `go vet ./...`；`backend-go` 额外跑 `go test -race ./...`。

Week 1 的 14 条 GET 语义对账以**已录制的 FastAPI golden** 为基准
（`backend-go/tests/contract/testdata/week1_live_golden.json`），CI 只起 Postgres
与 Redis、强制 `LIVE_CONTRACT_REQUIRED=1`，**不再启动 FastAPI**。缺环境、服务不可用、
fixture 缺失、status 或 JSON 任一差异都会失败。

本地一键复现（只写 `BLF_test`，不会碰 `BLF`，不需要 Python）：

```bash
cd backend-go
BELIEVEBOY_ENV_FILE=../backend/.env.test ./scripts/run-live-contract.sh
```

需要重新录制 golden（仅在 FastAPI 行为有意变更时）才需要 Python，步骤见该 README。

覆盖清单、归一化规则、已知差异和失败排查见
[`backend-go/tests/contract/README.md`](backend-go/tests/contract/README.md)。

---

## 前端单测（Vitest）— 全量耗时口径与「卡住」排查

> 前端单测是 `frontend/` 下的 `*.test.ts(x)`（Vitest + jsdom，配置 `frontend/vitest.config.ts`），
> 与上面 Layer 2 的 Playwright E2E 是两件事。命令一律在 `frontend/` 下跑。

### 全量耗时口径（BLF-1238，2026-10-06 实测）

```bash
cd frontend && pnpm test          # = vitest run，全量 235 个测试文件
```

| 口径 | 数值 |
| --- | --- |
| 文件 / 用例 | 235 文件 / 1660 例 |
| 全量 wall clock | **~43s**（本机较空闲，macOS 10 核 / 默认 jsdom + forks / 10 workers）～**~2 分钟**（同机其他 agent 满载，实测 59s / 79s / 124s） |
| 判据（不看绝对秒数，看是否在推进） | 60s 时 `Test Files` 计数**已在增长** = 只是慢；**仍为 0** = 挂住 |
| 异常阈值 | **> 5 分钟**仍无 `Test Files` 汇总 → 按下面三步排查，不要干等 |

### 「卡住」三步排查（先判类型，再二分）

1. **看输出**：跑到 60s 时输出里仍只有各 worker 的 `ExperimentalWarning`、`Test Files` 计数为 0
   → 可疑（正常情况 43s 已经跑完）。
2. **看 CPU（关键：区分「无限循环」和「单纯慢」）**：

   ```bash
   ps -Ao pcpu,pid,etime,args | grep vitest
   ```

   - 有 worker 长时间 **100%+ CPU** → **无限循环**（某文件在渲染 / 微任务里空转）；
   - CPU 接近 **0%** → 死锁或等外部资源（未关闭的 handle / 真定时器 / 网络等待）。
3. **二分定位**（按目录往下切，最后单文件确认）：

   ```bash
   cd frontend
   # 目录级（--maxWorkers=1 --reporter=verbose 才能看到逐文件进度；默认 reporter 收尾才打印）
   vitest run components/terminal --maxWorkers=1 --reporter=verbose
   # 单文件确认（挂住的文件用 30s 超时就够——正常单文件 1-3s）
   vitest run components/terminal/<file>.test.tsx
   ```

   目录级命令建议套一层超时（macOS 无 `timeout` 时用后台 + `kill`），否则它会一直挂着。

> ⚠️ **vitest 的 `--testTimeout` / `--hookTimeout` / `vi.waitFor` 救不了这类挂起。**
> 无限渲染循环跑在**微任务链**上，会饿死计时器 —— 超时回调根本不会被调度，
> 表现是「永久挂起」而不是「超时失败」（BLF-1238 实测：`--testTimeout=3000` 仍挂 ≥60s）。
> 所以只能靠上面的**症状判型 + 二分**，不要指望配置超时兜底。

### 已定位的根因类型与防回归规则（BLF-1238 / BLF-1246）

**根因**：测试里 `vi.mock('next-auth/react')` 的 `useSession` 每次调用都返回**新的对象字面量**，
于是 `data` 每次渲染都是新引用 → 组件里 `useEffect(..., [session, status])` 每次渲染后重跑 →
effect 内无条件 `setState` → 再渲染 → 无限循环。

**规则**：mock `useSession` / `useNotifications` 必须返回**稳定引用**——这与真实实现一致
（next-auth v5 的 `SessionProvider` 用 `React.useMemo` 缓存 value，`data` 身份在 session 未变时恒定；
`NotificationsProvider` 的 `notify` 是 `useCallback(..., [])`，身份恒定）。
内联 `useSession: () => ({ data: {...} })` / `useNotifications: () => ({ notify: vi.fn() })`
是**潜伏地雷**：只有「组件里 `[session]` / `[notify]` 依赖的 effect 无条件 setState」时才引爆。

#### 新测试直接调 helper，不要自己拼稳定引用

helper 路径：`frontend/test-utils/stable-mocks.ts`（`@/test-utils/stable-mocks`；文件名不带 `.test.`，
不会被 vitest 的 `include` 收集，自测在同目录 `stable-mocks.test.ts`）：

```ts
import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ❌ 反例：data / notify 每次渲染都是新引用（无限渲染挂死的原料）
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: vi.fn() }),
}))

// ✅ 正确：直接用 helper（mock 工厂里直接调，不需要 vi.hoisted）
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: true } }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))
```

- **不变式**：同一入参下 `stableSession()` 返回**同一个对象**（含 `data`），
  `stableNotifications()` 返回同一个 `notify`——helper 只缓存、不新建（自测钉住这条，别改坏）。
  入参不同（如用例切换 `sessionRef.roleType`）才换引用，正好对应「session 真的变了」。
  缓存 key 按**值**归一（对象键序不敏感，BLF-1247 修）：`{ user: { a, b } }` 与 `{ user: { b, a } }`
  拿到同一个对象，所以同一份 session 在文件里换写法也不会换引用。
- **返回值视为只读**：缓存对象在同一测试文件内跨用例共享，就地改写会污染其它用例——要改就传新入参。
  缓存不做淘汰是有意的（key 基数 = 一个文件里的 session 变体数，天然个位数）。
- **`notify` 是模块级共享单例**：同一测试文件内所有用例共享，断言 `expect(notify).toHaveBeenCalledWith(...)`
  前请在 `beforeEach` 里 `vi.clearAllMocks()`（`vi.clearAllMocks` 只清调用记录、不拆实现，安全）。
  需要直接引用时 `import { notify } from '@/test-utils/stable-mocks'`。
- 仍需自己写模块级常量的场景（如 `vi.hoisted` 里已有别的 mock 对象）也 OK，
  关键只有一条：**别在 mock 工厂里内联新建对象 / `vi.fn()`**。

> **为什么值得单独写一条**：BLF-1246 复查存量时发现 18 个测试文件仍是这种写法，其中 3 个
> （`order-info`、`inventory-analysis`、`generate-client`）**当时就已经在无限渲染**——
> 表现为该文件耗时数秒、CPU 空转，而不是整轮挂死（循环被 250ms debounce 节流或
> 被用例结束时卸载切断），所以一直没人发现。

#### 机械拦截：`pnpm check:mocks`（BLF-1247）

「必须用稳定引用」靠人记就会漏（存量 18 处就是这么留下来的），所以加了一道机器拦截——
`frontend/scripts/check-unstable-mocks.mjs`（屋风对齐后端 `cmd/checkmigrations`：
**只用标准库**、失败 `exit 1`、输出含 `file:line` + 修法提示）：

| 问题 | 答案 |
| --- | --- |
| 在哪跑 | `cd frontend && pnpm check:mocks`；已接进 `pnpm test` 入口（命中则 vitest 根本不启动）与 `.github/workflows/motion-system-ci.yml` 的显式 step |
| 查什么 | `frontend/**/*.test.{ts,tsx}` 里 mock 工厂**内联新建**关键引用：`useSession: () => ({ data: {…} / […] })`、`useNotifications: () => ({ notify: vi.fn() })` |
| 怎么算过 | `扫描 N 个测试文件，0 命中` → exit 0；命中 → exit 1，逐条给 `file:line:col` + 源码行 + 修法 |
| 失败了怎么修 | 按提示把内联字面量换成 `@/test-utils/stable-mocks` 的 `stableSession({…})` / `stableNotifications()`；或模块级 `vi.hoisted` 常量。关键只有一条：**别在工厂里内联新建** |
| 什么**不算**命中 | `data: null` / `data: SOME_CONST` / `data: mockUseSession()`（复用同一对象）/ `notify: mockNotify` / `notify` 简写 / 注释与字符串里的样例 —— 判据刻意收窄，**误报会逼人绕过检查** |
| 判据自身怎么防回归 | `frontend/scripts/check-unstable-mocks.test.mjs`（`node --test`，正例 + 反例各若干；`pnpm test` 与 `pnpm check:mocks:test` 都会跑） |
| 机读输出 | `node scripts/check-unstable-mocks.mjs --json` → `{ ok, filesScanned, hitCount, hits[] }` |
| 为什么不能只靠「全量已绿」 | 3 处循环被 debounce / 用例结束卸载切断，只表现为单文件变慢 + CPU 空转，**不挂死**（BLF-1246 实证），所以肉眼很难发现 |

> ⚠️ **机器层当前未生效（2026-10-06 核对）**：`motion-system-ci` 与 `lighthouse-ci` 都是
> `disabled_manually`，workflow 里的 step 已接好但**不会真的被触发**。在它被重新启用前，
> `pnpm test` 入口（含 `check:mocks`）是唯一实际执行点——PR 作者与 review 必须自己跑。
>
> 脚本本身**不依赖 node_modules**，所以也可以在任何 CI / 本地钩子里裸跑：
> `node frontend/scripts/check-unstable-mocks.mjs`。
>
> **不要在脚本里加白名单「放过」存量**：stage 1（BLF-1246）已把存量清零，脚本应当在 main 上直接全绿；
> 白名单会让规则重新变成靠人记。

---

## 关键约定（不可违反，否则破坏隔离）

1. **测试账号只在测试库里 seed**——绝不放进开发/生产库。
2. **密码绝不硬编码、不入 .env.example**——只从 `backend/.env.test`（gitignored）注入。
3. **测试库 schema 用 `pg_dump --schema-only` 同步**（`cmd/setuptestdb` 已内置）——不要用 Goose 从零重放 baseline 建测试库。
4. **Playwright 登录走 `loginAsUser`（真 NextAuth credentials 流）**——不要回退到 UI 选择器 `#email` / `#password`。
5. **新加 E2E 账号时**只改 `backend-go/cmd/seedtestaccounts` 的 `TEST_ACCOUNTS` 列表 + `backend/.env.test` 的密码变量。
6. **新加 Go DB 测试时**用 `GO_API_TEST_DATABASE_URL` 显式开启 + 每条用例 `t.Cleanup` 清理写入，绝不连生产库 `BLF`。

---

## 扩展指南（避免重复制造）

> 每一节都对应 plan §路线图。**先看这里再决定实现**，避免每次从零拼。

### 加一个新角色 / 一类测试账号

1. `backend-go/cmd/seedtestaccounts`：在 `TEST_ACCOUNTS` 列表加一项，role_type 写准确值（`admin` / `operator` / `businessdev` / 未来新增）。
2. `backend/.env.test`：补对应的 `TEST_<ROLE>_PASSWORD`（gitignored，绝不入库）。
3. 重跑 `cd backend-go && go run ./cmd/setuptestdb --reset-password`。

### Playwright motion/a11y CI 覆盖边界（BLF-1253）

`motion-system-ci` grep 涵盖的 motion/a11y spec 必须明确验证实际页面，而不是把未认证的 `/dashboard` 登录重定向当作通过：

- `tests/setup/blf611-fixture.ts` 的 `addBLF611FixtureAuth(context)` 通过测试专用 JWE 建立本地 session；使用它的 spec 仍应断言目标 URL 落在 `/dashboard`，并等待主内容挂载。
- `reduced-motion.spec.ts` 检查已认证 dashboard 路由切换后的 transition transform；`motion-system.spec.ts` 对已认证 dashboard 与 AI chat 页面运行 axe；`motion-budget.spec.ts` 也以相同 fixture 执行路由性能巡检。
- `reduced-transparency.spec.ts` 在已认证 dashboard 上检查 spotlight strength。当前 dashboard 没有 spotlight 卡片时，该场景仍以显式 skip 报告，不视为真实覆盖；需在有卡片页面下再补充验证。
- 该 fixture 仅为前端 UI 测试签发，不验证后端会话撤销、真实用户权限或生产认证；自包含页面需继续 mock 数据接口。

### 加一个 Playwright E2E 测试

#### TypeScript (frontend)

```ts
// frontend/tests/<area>/<name>.spec.ts
import { expect, test } from '@playwright/test'

// 内联 NextAuth credentials REST 登录。
// 复制粘贴很常见——每个 spec 都内联是因为 Playwright 1.59.1 加载跨文件 Node
// built-in 模块时存在 quirk。读取 backend/.env.test 的 TEST_USER_EMAIL/
// TEST_USER_PASSWORD（gitignored）来跑真实登录。

test('AI chat sends a message and renders token footer', async ({ page }) => {
  await loginAsUser(page)                         // 真 NextAuth 走 backend 账号
  await page.route('**/api/ai-chat/config', (r) => // 干掉 LLM 网关，用确定性 mock
    r.fulfill({ json: aiChatConfigFixture })
  )
  await page.goto('/dashboard/ai/chat')
  // ... 断言
})
```

- **账号来源**：`backend/.env.test`（gitignored）里的 `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`（用户的真实 dev 账号），或用 `cmd/seedtestaccounts` 灌的测试账号（需后端连 `BLF_test`）。
- **mock AI chat APIs** 保持 spec 快、可重现（真 LLM 又慢又费钱又 flaky）。`page.route('**/api/ai-chat/**')` 拦截 + `route.fulfill({ json })` 返 mock。**不要** mock `/api/auth/**`——让 NextAuth 走真流。
- 会话失效？设 `E2E_REFRESH_AUTH=1 pnpm test:ui -- tests/<area>/<name>.spec.ts` 重跑一次。
- 跑：`pnpm test:ui -- tests/<area>/<name>.spec.ts`（前提：后端起 + dev frontend 起，或 `pnpm dev` 由 playwright.config.ts 的 webServer 自启）。

### 加一个 Go DB 测试

集成测试用 `GO_API_TEST_DATABASE_URL` 显式开启，未设置时 `t.Skip`（默认不碰库）：

```go
// internal/store/xxx_integration_test.go
func TestXxxIntegration(t *testing.T) {
    databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
    if databaseURL == "" {
        t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
    }
    db, err := store.OpenPool(context.Background(), databaseURL)
    if err != nil { t.Fatal(err) }
    t.Cleanup(db.Close)
    // ... 断言；每条用例自己 t.Cleanup 清理写入
}
```

- 纯逻辑测试优先：store 接口是接口类型，可以传假的 `Rows` / `QueryRow` 实现（见 `internal/store/crm_test.go`），不需要真库。
- 需要固定数据时用 `cmd/seedtestreference` / `cmd/seedtestaccounts` 的 fixture，不要依赖生产快照行。
- 外部依赖（Redis / 邮件 / LLM）用接口注入假实现，不要起真服务。

### 加一个权限矩阵 / 场景预设

参见 plan §路线图 **R1 / R2**：

### Discovery Crawl（全页面体检）

```bash
# 跑全量 78 页体检（真登录 + 采集 console/network errors + 截图 + 报告）
pnpm test:ui -- tests/crawl/discovery.spec.ts --project=chromium

# 报告输出：
#   test-results/crawl-report.md   ← 人读（按 ❌/⚠️/✅ 分组 + 加载耗时排序）
#   test-results/crawl-report.json ← 程序读
#   test-results/crawl/*.png       ← 每页截图
```

- **用途**：拿到陌生系统 / 大版本更新后第一步跑，快速发现“哪些页面打不开 / 报错 / 接口 4xx-5xx / 加载慢”。
- **报告解读**：❌ = 有 console error / pageerror / 5xx（前端 bug 或后端契约问题）；⚠️ = 有 warning / 4xx / 空白页（可能是权限问题或数据缺失）；✅ = 干净。
- **后续**：报告里的 ❌ 列表 = 写 functional test 的优先级输入。按“高风险页面优先”原则，让 agent 或人工针对具体页面写 functional smoke。
- **路由列表**：硬编码在 `tests/crawl/discovery.spec.ts` 的 `ROUTES` 数组里。新增页面后手动加一行（或重跑 `find app/dashboard -name page.tsx | sed ...` 重新生成）。

- 在 `backend-go/tests/` 下用表驱动测试（`[]struct{...}` + `t.Run`）声明矩阵。
- 不要复制多份 setup；把「建请求 / 断言形状」抽成 helper。

---

## 与项目主文档的关系

- `AGENTS.md`：仓库根指针 + 平台 follow-up。
- `CLAUDE.md`：旧权威，已弃用（AGENTS.md 说明了降级原因）。
- `docs/REFERENCE.md`：环境/部署/广告数据/完整测试与反馈模板（旧权威的延伸）。
- `docs/superpowers/plans/`：历史 + 当前的设计 plan。当前测试主题的 plan：[`2026-07-14-test-db-and-playwright-foundation.md`](docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)

读这一份 TESTING.md + 上述 plan + 两个子 README = 测试基建完整知识图。**新加任何测试相关功能前先读它们，避免重新踩坑。**

---

## 子文档索引

- 契约测试（golden 对账）使用指南：[`backend-go/tests/contract/README.md`](backend-go/tests/contract/README.md)
- Playwright E2E：`frontend/tests/`（`pnpm test:ui`）
- 当前主题的设计 plan：[`docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md`](docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)

---

## 按包运行（避免全盘 go test）

```bash
cd backend-go
go test ./internal/api/ad_upload -count=1     # 只跑某个模块
go test ./internal/store -count=1             # 数据访问层
go test ./... -run TestSalesUpsert -count=1   # 按测试名跨包筛选
```

改动某个模块时先跑该包的测试，T3（跨模块 / 迁移 / 权限）才跑全量 `go test ./...`。
