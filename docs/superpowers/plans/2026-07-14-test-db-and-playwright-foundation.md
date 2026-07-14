# 测试基建（独立测试库 + 测试账号 + Playwright 鉴权）设计方案

> **定位：** 本文件是**现状定档 + 路线图**，不是实现计划。当前阶段已经完成"独立测试库 + 测试账号 + Playwright 鉴权"三件套；本文记录设计决策与边界，并列出未来追加（如权限矩阵、场景预设）的扩展路径，避免重复制造。

## 目标

把项目里"测试一直跑在本地库、Playwright 登录靠 UI 选择器易碎、账号散落在脚本里"的状态，升级为：

- **独立、持久、手动维护的 Postgres 测试库**，与开发/生产库完全隔离。
- **代码化的测试账号**（admin / operator / businessdev），一键 seed，零硬编码。
- **Playwright 鉴权可复用**，登录走 NextAuth REST 流程，缓存会话，无 UI 选择器依赖。
- **可扩展**：未来追加角色、用户、项目绑定关系、权限矩阵测试时，有清晰的"在哪里加"而不是"从零拼"。

## 设计决策（ADR）

### D1. 测试库是独立 Postgres，不是 SQLite 内存库

- 项目代码大量使用 PG 专属 SQL（`public.` 前缀、`::text` 类型转换、`on conflict ((lower(email)))`、`pg_last_xact_replay_timestamp()` 等）。SQLite 不能直接用。
- 选定：独立 Postgres 库（如 `BLF_test`），**持久 + 手动维护**（即：建库 + 迁移 + seed 一次，长期复用，不每次跑测试都重建）。

### D2. schema 用 `pg_dump --schema-only` 克隆，不用 `alembic upgrade head`

- 仓库现状：`projects` / `user_accounts` 表由脚本创建，迁移只 `ALTER`；且存在迁移 `20260419_097_user_accounts_add_password_changed_at` 对 bootstrap 已创建的列做**无条件** `ADD COLUMN`，导致全新库 `alembic upgrade head` 必失败（DuplicateColumn）。
- 选定：`pg_dump -d <source> --schema-only --clean --if-exists | psql -d <test>`。零侵入生产代码；schema 与源库一致；失败可重入。
- 副作用：测试库 schema 不自动跟迁移同步——这是"手动维护"的代价，重跑 `setup_test_db.py` 即可重拉。符合用户选定的"持久手动维护"。

### D3. 开关用 `TEST_DATABASE_URL` 环境变量（覆盖式），而不是新代码路径

- 在 `app/core/config.py` 的 Settings 加 `TEST_DATABASE_URL` 字段，`model_validator` 覆盖 `database_url`。
- 优点：app、alembic、pytest 共用同一份 engine 解析逻辑，零分支，零重复代码。
- 缺点：要求 `TEST_DATABASE_URL` 在 `get_settings()` 第一次被调用前（即任何 `app.*` 模块被 import 前）就进入 `os.environ`。pytest 根 conftest 通过加载 `backend/.env.test` 满足这一点；脚本通过启动时加载 `.env.test` 满足。
- 已落地：`backend/app/core/config.py:_apply_test_database_override`。

### D4. 测试账号字段收口在 Settings，不散落

- 账号邮箱默认值、密码来源都在 `app/core/config.py` 的 `test_admin_email` / `test_admin_password` 等字段。
- `scripts/seed_test_accounts.py` / pytest conftest / agent_testing conftest 三处都从同一处读，避免"改一处忘另一处"。
- 密码绝不硬编码、不入 `.env.example`、可从 `backend/.env.test`（gitignored）注入。

### D5. Playwright 登录走 NextAuth REST，不走 UI

- 旧实现的 `login_as(page, email, password)` 通过 `#email` / `#password` / "立即登录" 等选择器，是"经常遇到登录问题"的根因（脆、易碎）。
- 改用 NextAuth v4 credentials 的标准 REST 流程：`GET /api/auth/csrf` → `POST /api/auth/callback/credentials`（form: csrfToken + email + password + json=true）。`context.request` 与页面共享 cookie，会话建立后页面自动登录。
- 选定：`backend/scripts/agent_testing/auth.py`。

### D6. 登录会话缓存为 Playwright `storage_state`，每个角色只登录一次

- 每次测试都走 CSRF + callback 流程也能跑（API 流程稳），但浪费时间和网络。缓存 `.auth/<role>.json`（gitignored），每次复用 cookie。
- 失效检测：加载缓存后 `GET /api/auth/session` 验证 `user.id`，失效则自动重登。
- 强制刷新：`AGENT_TEST_REFRESH_AUTH=1`。
- 已落地：`backend/scripts/agent_testing/auth.py:get_authed_context` / `login_as`。

### D7. `login_as` 签名向后兼容

- 新签名 `login_as(page, "admin")`，但识别 `(page, email, password)` 三参旧形式并按邮箱反查角色。
- 优点：历史 E2E 测试调用点 `login_as(page, cfg["email"], cfg["password"])` **无需改动**，迁移零成本。
- 已落地：`auth.py:login_as` + `_role_by_email`。

### D8. pytest DB-依赖测试在没有 TEST_DATABASE_URL 时 skip，不报错

- 用户配错了（忘了 `TEST_DATABASE_URL`），绝不能让它偷偷连本地库。
- 行为：`db_session` fixture 调 `_require_test_database()`，缺环境变量就 `pytest.skip`，给出指引消息。
- 已落地：`backend/tests/conftest.py`。

### D9. 物理目录保持不变，靠文档"编织"

- pytest (`backend/tests/`) 与 Playwright E2E (`backend/scripts/agent_testing/`) 物理分开，不合并。
- 原因：pytest `testpaths=["backend/tests"]` 是仓库约定；E2E 有独立运行方式与 Playwright 依赖。
- 靠根 `TESTING.md` 总览 + 两个子 README 反向链接，在概念上把它们组织为"测试基建"。

---

## 当前文件地图

| 路径 | 作用 | 状态 |
|---|---|---|
| `backend/app/core/config.py` | 加 `TEST_DATABASE_URL` / `TEST_*_EMAIL` / `TEST_*_PASSWORD` 字段 + `model_validator` 覆盖 | 已落地 |
| `backend/scripts/setup_test_db.py` | 一键：建库 + pg_dump 克隆 schema + seed | 已落地 |
| `backend/scripts/seed_test_accounts.py` | seed admin / operator / businessdev，密码从 config | 已落地 |
| `backend/tests/conftest.py` | 加载 `.env.test`，断言 `TEST_DATABASE_URL`，提供 `db_session` / `test_admin` / `*_headers` fixtures；缺测试库则 skip | 已落地 |
| `backend/tests/api/test_profile_endpoints.py` | 改用 seed 测试 operator 账号（不再改第一个真实用户） | 已落地 |
| `backend/scripts/agent_testing/auth.py` | NextAuth REST 登录 + 会话缓存 + 角色矩阵原语 | 已落地 |
| `backend/scripts/agent_testing/conftest.py` | Playwright `browser` / `page` fixture；`TEST_ACCOUNTS` 收口 | 已落地 |
| `backend/scripts/agent_testing/test_permissions_api.py` | 接入新 `login_as`（签名兼容） | 已落地 |
| `backend/scripts/agent_testing/test_ui_permissions.py` | 接入新 `login_as`（签名兼容） | 已落地 |
| `backend/scripts/agent_testing/README.md` | E2E 使用指南 | 已落地 |
| `backend/tests/README.md` | pytest 层使用指南 | **本计划新建** |
| `TESTING.md`（仓库根） | 总览：架构、流程、扩展指南 | **本计划新建** |
| `.gitignore` | 忽略 `backend/.env.test` 与 `backend/scripts/agent_testing/.auth/` | 已落地 |

---

## 路线图（未来追加点）

> 每一项都有**在哪改**的指引，避免未来"从零拼"。新增项目请用新文件，不改本文件。

### R1. 权限矩阵扩展（用户说的"多角色 × 多功能"交叉验证）

- **目标**：以参数化形式覆盖"角色 × 资源"的访问矩阵。
- **在哪改**：
  - `backend/scripts/seed_test_accounts.py`：扩展 `TEST_ACCOUNTS` 为包含 `expected_role` / `expected_projects` 的 schema；seed 时构造项目-用户绑定（如 `ProjectOperator(project_id, operator_name)`）。
  - 新建 `backend/scripts/agent_testing/matrices/access_matrix.py`（或类似）：以数据驱动形式声明 `{role: {endpoint: expected_status}}`，提供 `iter_role_endpoint_tests()` 给测试遍历。
  - `backend/scripts/agent_testing/test_permissions_api.py`：增加 `@pytest.mark.parametrize` 用例遍历矩阵。
- **不**做：把矩阵硬编码进 conftest；避免 Settings 字段膨胀。

### R2. 场景化预设（特殊状态账号）

- **目标**：定义"测试 Profile"，如 `test_disabled_user`、`test_readonly_operator`、`test_expired_password_user`。
- **在哪改**：
  - `backend/scripts/seed_test_accounts.py`：增加 `seed_profiles(profile_name)` 函数，按 profile 调整账号的 `is_active` / `password_changed_at` 等字段。
  - `backend/scripts/agent_testing/auth.py`：扩展 `login_as(page, "admin")` 接受 `profile` 参数；profile 对应一组账号变体。
  - `TESTING.md`：在"扩展指南"加一节"新增测试 Profile 的步骤"。

### R3. 测试库 schema 自动随迁移同步

- **现状**：测试库 schema 是 setup 时一次克隆，不会自动跟迁移。
- **目标（可选）**：setup 时先克隆，再 `alembic upgrade head`，若 alembic 已有"修复 bootstrap 冲突"的修复（参见 D2），可切到 alembic 路径。
- **在哪改**：先修迁移 `20260419_097_user_accounts_add_password_changed_at` 等无条件 `ADD COLUMN` 为"列不存在才加"；再切换 `setup_test_db.py` 从 pg_dump 路径改为 alembic 路径。
- **注意**：动迁移前评估影响；这是仓库层面的修复，不应在本主题内顺带做。

### R4. CI 接入

- **目标**：GitHub Actions / GitLab CI 等跑 E2E。
- **在哪改**：
  - 新建 `.github/workflows/e2e.yml`（或仓库对应 CI 配置）。
  - 步骤：起 Postgres service → 跑 `setup_test_db.py` → 起 backend（带 `TEST_DATABASE_URL`） → 起 frontend → 跑 `pytest scripts/agent_testing`。
  - secrets: `TEST_ADMIN_PASSWORD` 等从 CI secrets 注入。
- **注意**：CI 上 pg_dump 克隆目标用 CI Postgres 自身；不能用开发库。

### R5. pytest 端的数据 fixture 库

- **现状**：DB-touching 测试只共享 `db_session`，没有"已知数据集"概念。
- **目标（可选）**：抽出 `backend/tests/factories.py`，提供 `make_project(name, operator=...)` / `make_sku_record(...)` 等工厂，测试用它构造确定性数据集，避免依赖 dev 库的实际内容。
- **在哪改**：新建 `backend/tests/factories.py`；在 `backend/tests/conftest.py` 注册 fixture。

---

## 边界与不在范围内

- **不**自动删除/重建测试库每次跑（用户已选"持久手动维护"）。
- **不**修复迁移 bootstrap 冲突（R3 单独跟踪，不在本主题顺带做）。
- **不**实现具体的权限矩阵/场景预设（按用户选择"仅现状定档 + 路线图"）。
- **不**为单元测试写 README 单独长篇大论（pytest 用法已经简单，`backend/tests/README.md` 只放"如何接进测试库 + 何时 skip + 何时不应 skip"几个关键点）。

---

## 验证（已做）

- `python scripts/setup_test_db.py` 在本地 Postgres 上一键建出 `BLF_test` + seed 三个账号（admin 密码正确来自 `.env.test`，不再被 dev `.env` 覆盖——已修 `_load_env_files` 的 override 语义）。
- `pytest tests/api/test_profile_endpoints.py` 10 passed，全部走 `BLF_test`。
- 不设 `TEST_DATABASE_URL` 时 DB 测试 **skip**（本地库零污染）。
- `auth.py` / `conftest` / `agent_testing` 三个模块互相 import 正常，`login_as` 签名兼容旧调用点。
- E2E 全栈验证（登录走真实 NextAuth callback）依赖前端 + backend 同时运行，本次未在 CI 跑；用户在本地启动栈后执行 `pytest scripts/agent_testing` 即可。

---

## 关联

- 根总览：[`TESTING.md`](../../TESTING.md)（本次新建）
- pytest 层使用：[`backend/tests/README.md`](../../backend/tests/README.md)（本次新建）
- E2E 层使用：[`backend/scripts/agent_testing/README.md`](../../backend/scripts/agent_testing/README.md)（已存在）
- 旧权威：`CLAUDE.md`（已弃用，见 `AGENTS.md`）
- 仓库根指针：`AGENTS.md`