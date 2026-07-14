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
│   → backend/scripts/agent_testing/README.md                      │
│   → 鉴权核心：backend/scripts/agent_testing/auth.py               │
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