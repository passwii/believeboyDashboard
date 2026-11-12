# E2E 测试（Playwright）与测试数据库流程

> **Layer 2 · 入口文档。** 测试基建总览见根 [`TESTING.md`](../../../TESTING.md)；pytest 单元/集成层见 [`backend/tests/README.md`](../../tests/README.md)；设计决策见 [`docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md`](../../../docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)。

本目录下的 Playwright 测试用于验证后端鉴权、角色隔离与前端权限 UI。
它们**始终指向独立的测试数据库**（不碰本地 / 生产库），并使用仓库内置的
**测试账号**自动登录——无需再手动处理 NextAuth 登录。

## 1. 一次性搭建测试库 + 测试账号

```bash
cd backend && source .venv/bin/activate

# 在 backend/.env.test 里配置：
#   TEST_DATABASE_URL=postgresql+psycopg://<user>:<pass>@<host>:5432/BLF_test
#   TEST_ADMIN_PASSWORD=...   TEST_OPERATOR_PASSWORD=...   TEST_BUSINESSDEV_PASSWORD=...
# （测试账号邮箱默认值：test_admin@ / test_operator@ / test_businessdev@believeboy.com）

cd backend-go && go run ./cmd/setuptestdb            # 建库 + 克隆 schema + seed 测试账号
# 重设密码时： cd backend-go && go run ./cmd/setuptestdb --reset-password
```

测试账号（写入测试库的 `user_accounts`）：

| 角色        | 邮箱                              | is_admin |
| ----------- | --------------------------------- | -------- |
| admin       | `test_admin@believeboy.com`       | true     |
| operator    | `test_operator@believeboy.com`    | false    |
| businessdev | `test_businessdev@believeboy.com` | false    |

## 2. 启动指向测试库的 backend + frontend

```bash
# backend（关键：用 TEST_DATABASE_URL 覆盖 database_url）
TEST_DATABASE_URL='postgresql+psycopg://<user>:<pass>@<host>:5432/BLF_test' \
  uvicorn app.main:app --port 8000

# frontend（默认代理到上面的 backend）
pnpm dev
```

pytest 单元 / 集成测试（`backend/tests`）会自动读取 `backend/.env.test` 里的
`TEST_DATABASE_URL`，把整套测试指向测试库；未配置时相关测试自动 skip，绝不误连本地库。

## 3. 写 E2E 测试

直接复用 `login_as`，无需任何 UI 选择器：

```python
from scripts.agent_testing.auth import login_as

def test_admin_sees_accounts(page):
    login_as(page, "admin")                 # 无 UI 登录，复用缓存会话
    page.goto(f"{FRONTEND_URL}/dashboard/system-management/account-management")
    # ... 断言 ...
```

`login_as(page, role)` 做了什么（`auth.py`）：

- 走标准 **NextAuth v4 credentials REST 流程**（CSRF → callback），不点击
  `#email` / `#password` 等易碎选择器；
- 登录成功后把会话缓存为 Playwright `storage_state`
  （`scripts/agent_testing/.auth/<role>.json`，已 gitignore）；
- 后续测试复用缓存会话，**每个角色只登录一次**；
- 会话失效时自动重新登录。

强制重新登录：`AGENT_TEST_REFRESH_AUTH=1 pytest ...`

## 运行

```bash
cd backend && source .venv/bin/activate
pytest scripts/agent_testing/test_permissions_api.py -v
pytest scripts/agent_testing/test_ui_permissions.py -v
```

## 常见问题

- **还是连到了本地库？** backend 启动时没设 `TEST_DATABASE_URL`——配置
  `backend/.env.test` 并在启动命令里导出它。
- **登录 401？** 测试库里没有对应测试账号，重跑 `cd backend-go && go run ./cmd/setuptestdb`。
- **会话过期？** 设 `AGENT_TEST_REFRESH_AUTH=1` 强制刷新缓存。
