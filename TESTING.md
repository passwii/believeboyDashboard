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
│   · Python (pytest + agent)                                       │
│     → backend/scripts/agent_testing/README.md                    │
│     → 鉴权核心：backend/scripts/agent_testing/auth.py             │
│   · TypeScript (frontend/tests)                                   │
│     → smoke 例：frontend/tests/ai-chat/smoke.spec.ts              │
│     → 该 spec 内联了 NextAuth credentials REST 流（参见 spec      │
│       顶部 JSDoc 的「Auth pattern」段落，与 Python 模式一致）；   │
│       仓库其他前端 spec 也都内联，因为 Playwright 1.59.1 加载    │
│       跨文件 Node built-in 模块时存在 quirk。                    │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1 · pytest 单元 / 集成（FastAPI TestClient + 真实 DB）      │
│   → backend/tests/README.md                                      │
│   → 入口 conftest：backend/tests/conftest.py                     │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Layer 0 · 测试数据与账号基础设施（所有上层共用）                   │
│   → 独立测试库：scripts/setup_test_db.py                          │
│   → 测试账号 seed：scripts/seed_test_accounts.py                 │
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
  `python scripts/setup_test_db.py`（会自动建 `BLF_test` + seed 账号）。
- 仅跑纯 pytest 单元、不涉及后台任务的用例，Redis 可不起；
  一旦用例触发 Celery 任务（定时报告 / AI 摘要 / 鉴权缓存），Redis broker 必须在线，否则任务派发失败。

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
> `TEST_DATABASE_URL` 仍在 `backend/.env.test`（gitignored）→ `BLF_test`，供自动化 pytest 隔离用。
> 连哪个库以 `psql -l` 列出的本地库为准（主库 `BLF`=生产快照，测试库 `BLF_test`）。

---

## 本地生产快照库（BEL-376）— 集成 / 手动读写测试

> **定位：** `BLF` 是从 VPS 生产库 `pg_dump` 下来、恢复到本地的**真实数据快照**（brew PG，
> 端口 5432，常驻）。用途是**通过本地 backend 对真实数据做读写 / 外部 API 集成测试**，
> 不必在 VPS 上操作。**与自动化 pytest 的 `BLF_test` 隔离机制互不影响**——pytest 仍走
> `TEST_DATABASE_URL`→`BLF_test`（见上方架构分层），生产快照只用于手动 / 集成验证。

### 起本地 backend 测外部 API

`backend/.env` 的 `DATABASE_URL` 已指向本地 `BLF`，直接起即可（外部 API 无鉴权，P0 网关隔离）：

```bash
cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8100
# 另开终端调用（示例：项目 1 的美国站广告 + 补货分析）
curl 'http://127.0.0.1:8100/api/v1/external/projects/1/ad-campaigns?period=custom&start_date=2026-07-01&end_date=2026-07-30&country=US&limit=5'
curl 'http://127.0.0.1:8100/api/v1/external/projects/1/replenishment-analysis?country=US&page_size=5'
```

端点目录与参数见 [`backend/docs/external-api.md`](backend/docs/external-api.md)。

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
│ 2. python scripts/setup_test_db.py                        │
│    → 建库（如不存在）+ pg_dump --schema-only 克隆 schema    │
│      + seed admin / operator / businessdev                │
└──────────────────────────────────────────────────────────┘
                          ↓
              独立的 BLF_test 测试库已就绪
                          ↓
   ┌──────────────────────┴──────────────────────┐
   ↓                                             ↓
Layer 1 pytest                          Layer 2 Playwright
   ↓                                             ↓
backend/tests/conftest.py                agent_testing/auth.py
自动加载 .env.test → 走 BLF_test        NextAuth REST 登录 + 缓存
```

### 每次跑测试

```
pytest (Layer 1):
  pytest backend/tests/api/test_profile_endpoints.py -v
  → conftest 自动加载 .env.test → engine 指向 BLF_test
  → 未设 TEST_DATABASE_URL 时 DB 测试 skip（绝不连本地库）

Playwright E2E (Layer 2):
  1. TEST_DATABASE_URL=... uvicorn app.main:app  ← backend 指向测试库
  2. pnpm dev                                       ← frontend 启动
  3. pytest backend/scripts/agent_testing -v
     → login_as(page, "admin") 直接复用缓存的 NextAuth session
```

---

## 关键约定（不可违反，否则破坏隔离）

1. **测试账号只在测试库里 seed**——绝不放进开发/生产库。
2. **密码绝不硬编码、不入 .env.example**——只从 `backend/.env.test`（gitignored）注入。
3. **测试库 schema 用 `pg_dump --schema-only` 同步**（参见 plan D2）——不要尝试 `alembic upgrade head` 从零建（迁移 bootstrap 冲突）。
4. **Playwright 登录走 `login_as`（agent_testing/auth.py）**——不要回退到 UI 选择器 `#email` / `#password`。
5. **新加 E2E 账号时**更新 `agent_testing/conftest.py` 的 `TEST_ACCOUNTS` + `scripts/seed_test_accounts.py` 的 `TEST_ACCOUNTS` 列表；两边必须一致。
6. **新加 pytest DB 测试时**用 `tests/conftest.py` 的 `db_session` / `test_admin` / `*_headers` fixture，不要自己 `SessionLocal()` 直连。

---

## 扩展指南（避免重复制造）

> 每一节都对应 plan §路线图。**先看这里再决定实现**，避免每次从零拼。

### 加一个新角色 / 一类测试账号

1. `backend/app/core/config.py`：增加 `test_<role>_email` / `test_<role>_password` 字段（带默认值；密码必须从 env 注入）。
2. `backend/scripts/seed_test_accounts.py`：在 `TEST_ACCOUNTS` 列表加一项，role_type 写准确值（`admin` / `operator` / `businessdev` / 未来新增）。
3. `backend/scripts/agent_testing/conftest.py`：在 `TEST_ACCOUNTS` dict 加一项（**两边都要，且邮箱、密码、env 变量名一致**）。
4. 重跑 `python scripts/setup_test_db.py --reset-password`。

### 加一个 Playwright E2E 测试

#### Python (backend agent)

```python
# backend/scripts/agent_testing/test_xxx.py
from scripts.agent_testing.auth import login_as

def test_xxx(page):
    login_as(page, "admin")    # 无 UI 登录，复用缓存
    page.goto(f"{FRONTEND_URL}/...")
    # 断言
```

- **复用** `page` / `browser` fixture（agent_testing/conftest.py）。
- **不要**自己写 `page.locator("#email").fill(...)`——用 `login_as`。
- 会话失效？设 `AGENT_TEST_REFRESH_AUTH=1` 重跑一次。

#### TypeScript (frontend)

```ts
// frontend/tests/<area>/<name>.spec.ts
import { expect, test } from '@playwright/test'

// 内联 NextAuth credentials REST 登录（参考 backend/scripts/agent_testing/auth.py）。
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

- **账号来源**：`backend/.env.test`（gitignored）里的 `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`（用户的真实 dev 账号）。也可用 seed 测试账号 `TEST_OPERATOR_EMAIL` 等（需要后端连 test DB）。详细 env var 名称见 `backend/scripts/agent_testing/conftest.py`。
- **mock AI chat APIs** 保持 spec 快、可重现（真 LLM 又慢又费钱又 flaky）。`page.route('**/api/ai-chat/**')` 拦截 + `route.fulfill({ json })` 返 mock。**不要** mock `/api/auth/**`——让 NextAuth 走真流。
- 会话失效？设 `E2E_REFRESH_AUTH=1 pnpm test:ui -- tests/<area>/<name>.spec.ts` 重跑一次。
- 跑：`pnpm test:ui -- tests/<area>/<name>.spec.ts`（前提：后端起 + dev frontend 起，或 `pnpm dev` 由 playwright.config.ts 的 webServer 自启）。

### 加一个 pytest DB 测试

```python
# backend/tests/api/test_xxx.py
def test_xxx(client, operator_headers, db_session):
    resp = client.get("/api/v1/...", headers=operator_headers)
    assert resp.status_code == 200
```

- **复用** `tests/conftest.py` 的 fixtures：`client`（FastAPI TestClient）、`db_session`、`test_admin` / `test_operator` / `*_headers`。
- **不要**写 `from app.db.session import SessionLocal` 然后直连；用 `db_session`。
- 未配 `TEST_DATABASE_URL` 时该测试自动 skip + 给指引。

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

- 在 `backend/scripts/agent_testing/matrices/` 新建数据驱动的矩阵声明。
- 用 `@pytest.mark.parametrize` 遍历。
- 不要把矩阵写进 conftest；conftest 只放"如何登录、如何取数据库"的原语。

---

## 与项目主文档的关系

- `AGENTS.md`：仓库根指针 + 平台 follow-up。
- `CLAUDE.md`：旧权威，已弃用（AGENTS.md 说明了降级原因）。
- `docs/REFERENCE.md`：环境/部署/广告数据/完整测试与反馈模板（旧权威的延伸）。
- `docs/superpowers/plans/`：历史 + 当前的设计 plan。当前测试主题的 plan：[`2026-07-14-test-db-and-playwright-foundation.md`](docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)

读这一份 TESTING.md + 上述 plan + 两个子 README = 测试基建完整知识图。**新加任何测试相关功能前先读它们，避免重新踩坑。**

---

## 子文档索引

- pytest 单元/集成使用指南：[`backend/tests/README.md`](backend/tests/README.md)
- Playwright E2E 使用指南：[`backend/scripts/agent_testing/README.md`](backend/scripts/agent_testing/README.md)
- 当前主题的设计 plan：[`docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md`](docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)

---

## 按功能运行（避免全盘 pytest）

仓库给测试打了**功能 marker**（详见 `backend/tests/README.md` 末尾「按功能运行」一节），支持：

```bash
pytest -m business_report    # 只跑业务报告相关
pytest -m recognition       # 跨 utils/ + ad/upload 的全部识别测试
pytest -m upload            # 报表入库/upload 链
pytest -m "recognition and not ad_report"   # 组合/排除
```

这样改动某功能（如本月修的 `business_report` 英文表头识别）只需跑对应子集，不必每次全盘 ~22s 且被无关失败噪声淹没。Marker 集合与定义在 `pyproject.toml` 的 `[tool.pytest.ini_options].markers`，不要在测试里用未声明的 marker（pytest 会警告）。