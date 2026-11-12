# pytest 单元 / 集成测试

> **Layer 1 · 入口文档。** 测试基建总览见根 [`TESTING.md`](../../../TESTING.md)；测试库 / 测试账号 / Playwright 鉴权的设计决策见 [`docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md`](../../../docs/superpowers/plans/2026-07-14-test-db-and-playwright-foundation.md)。

## 跑测试

```bash
cd backend && source .venv/bin/activate
pytest tests/api/test_profile_endpoints.py -v      # 跑某个文件
pytest tests/services/inventory -v                  # 跑某个子目录
pytest -v                                            # 跑全部（DB 测试需要 TEST_DATABASE_URL）
```

跑测试**之前**先确保独立测试库已经建好（详见 [§测试库与测试账号](#测试库与测试账号)）。

---

## 测试库与测试账号

整套 pytest 测试**默认走独立测试库**，绝不碰本地开发库。

### 一次性搭建

```bash
# 1. backend/.env.test 里配置：
#    TEST_DATABASE_URL=postgresql+psycopg://<user>:<pass>@<host>:5432/BLF_test
#    TEST_ADMIN_PASSWORD=...
#    TEST_OPERATOR_PASSWORD=...
#    TEST_BUSINESSDEV_PASSWORD=...
#
# 2. 一键建库 + seed：
cd backend-go && go run ./cmd/setuptestdb
```

详见根 `TESTING.md` 的"流程总图"。

### 行为：未配 TEST_DATABASE_URL

`tests/conftest.py` 的 `db_session` fixture 会 `pytest.skip`（带指引消息），**绝不让测试偷偷连本地库**。这意味着：刚 clone 仓库还没建测试库的开发者跑 `pytest` 不会污染数据，但所有 DB-依赖测试会 skip。

如果你的测试**不应该** skip（比如纯单元测试），那就**不要让它的 fixture 链最终触达** `db_session` / `test_admin` / `*_headers`——这些 fixture 都会调 `_require_test_database()`。

---

## 可用 fixtures（来自 `tests/conftest.py`）

| Fixture | 返回 | 何时需要它 |
|---|---|---|
| `db_session` | 一个 `Session`，测试结束自动 rollback | 直接查 / 改 DB |
| `settings` | `get_settings()` 单例 | 读 `api_key` / `test_admin_email` 等 |
| `test_admin` | seeded test admin 账号 dict（id/email/name/role_type） | 需要 admin 身份 |
| `test_operator` | seeded test operator 账号 dict | 需要 operator 身份 |
| `test_businessdev` | seeded test businessdev 账号 dict | 需要 businessdev 身份 |
| `admin_headers` | 已构造好的 X-API-Key / X-User-Id / X-Is-Admin / X-Role-Type 头 | 调 backend 端点的"鉴权" |
| `operator_headers` | 同上，operator 身份 | 同上 |
| `businessdev_headers` | 同上，businessdev 身份 | 同上 |

⚠️ **非 ASCII 字段**（中文姓名 `operator_name_zh` 等）已在 `*_headers` fixture 里 base64 编码过——`app/api/deps.py` 的 `_decode_header_value` 会自动 base64 解回中文，匹配前端代理的行为。**不需要**自己再编码。

---

## 写测试的正确姿势

### ✅ 推荐：复用 fixtures

```python
def test_patch_profile(client, operator_headers, test_operator):
    resp = client.patch(
        "/api/v1/system-management/profile",
        headers={**operator_headers, "Content-Type": "application/json"},
        json={"name": "new-name"},
    )
    assert resp.status_code == 200
```

### ❌ 反模式：直连本地库

```python
# 不要这样做：
def test_xxx():
    from app.db.session import SessionLocal
    session = SessionLocal()  # ← 哪个库？看 DATABASE_URL，可能连本地
    ...
```

### ❌ 反模式：复用"第一个真实用户"作为测试对象

```python
# 旧 test_profile_endpoints.py 之前的写法：
@pytest.fixture
def existing_user(db_session):
    return db_session.execute(
        text("select * from public.user_accounts order by created_at asc limit 1")
    ).first()
    # ← 这是测试库的第一个用户（admin），但语义上是"哪个都行"
    # ← 改它会污染 admin 账号
```

应该用 `test_operator` / `test_admin` fixture 锁定到 seed 好的测试账号。

### 鉴权头 + TestClient

`client` 用 `from app.main import app` 的 FastAPI `TestClient`。鉴权通过 `*_headers`（即 `X-API-Key` + `X-User-Id` + `X-Is-Admin` + `X-Role-Type`）。**不要**走 NextAuth/前端——这是 pytest 层，不起前端。

---

## 跳过 / 标记

- `pytest.skip`：由 `_require_test_database()` 自动管理（缺 `TEST_DATABASE_URL`）。
- `pytest.mark.skip`：纯手动跳过，加 `reason` 参数。
- `pytest.mark.xfail`：预期失败。少用——真出错就修，别让它"长期失败"。

---

## 按功能运行（避免每次全盘跑）

仓库按"功能领域"打了 **pytest markers**，支持只跑相关子集——不用每次 `pytest` 全盘（22+ 秒且含一些预存在失败，详见根 `TESTING.md`）。

Marker 集合见 `pyproject.toml` 的 `[tool.pytest.ini_options].markers`，已应用的第一波：

| Marker | 含义 | 覆盖 |
|---|---|---|
| `recognition` | 报表类型识别（A 表 business/payment + B 表 ad） | `tests/utils/recognition/` + `tests/services/ad/upload/test_recognition.py` |
| `business_report` | 业务报告识别/解析 | `tests/utils/recognition/test_recognizers.py::TestBusinessReportRecognition` |
| `payment_report` | 付款报告识别 | `tests/utils/recognition/test_recognizers.py::TestPaymentRecognitionSignals` |
| `ad_report` | 广告报表（B 表）识别/上传/解析 | `tests/utils/recognition/test_xlsx_recognizers.py` + `tests/services/ad/upload/` |
| `upload` | 报表入库/commit/dedup | `tests/services/data/upload/test_dedup.py` + `tests/services/ad/upload/` |

其余 marker（`inventory` / `scheduled_report` / `external_api` / `ad_agent` / `analysis` / `data` / `api`）已声明待用，后续按需补标。

### 用法

```bash
# 只跑业务报告相关（不碰全盘）
pytest -m business_report

# 跑所有识别测试（跨 utils/recognition + ad/upload）
pytest -m recognition

# 跑广告报表上传链
pytest -m upload

# 组合：报表识别（business + payment + ad）
pytest -m "business_report or payment_report or ad_report"

# 排除某类
pytest -m "recognition and not ad_report"
```

> ⚠️ **已知：全量 `pytest` 收集目前会撞到一个预存在的模块导入期 `sys.exit`**（`backend/scripts/test_schedule_remote.py` 在 import 时机硬性要求 `PROD_DATABASE_URL`，被某些 services 测试间接拉入）。这与 marker 无关，是独立的导入链脏问题。如果 `pytest -m X`（无路径）突然崩在 `PROD_DATABASE_URL`，那就是这个老问题；用 path 限定或先修那个 import chain。

---

## 与 Playwright E2E 的边界

| | pytest（这一层） | Playwright（agent_testing） |
|---|---|---|
| 鉴权 | `*_headers` fixture（header 直传） | `login_as(page, role)` 走 NextAuth REST |
| 起前端？ | 不起 | 必起（前端是登录链路的一部分） |
| 起后端？ | TestClient 内嵌，不需要单独起 | 必起（前端代理过去） |
| 数据库 | 测试库（通过 TEST_DATABASE_URL） | 测试库（后端指向 TEST_DATABASE_URL） |
| 浏览器？ | 不需要 | Playwright Chromium |
| 速度 | 快（无浏览器、无前端） | 慢（真实浏览器） |
| 适用场景 | 单元 / API 集成 / 业务逻辑 | 权限 UI / 跨服务链路 / 真实用户视角 |

写测试前**先想清楚在哪一层写**——能用 pytest 单元验的别上 Playwright。

---

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `pytest.skip: TEST_DATABASE_URL is not set...` | 未配置测试库 | 跑 `backend-go/cmd/setuptestdb` + 配 `backend/.env.test` |
| 测试连到了本地库，污染了开发数据 | 直接用了 `SessionLocal` 或没配 `TEST_DATABASE_URL` | 检查 fixture 链 + conftest 的 `db_session` |
| 鉴权 401 | header 缺 `X-API-Key` 或 `X-User-Id` | 用 `*_headers` fixture |
| 鉴权 403 | 用了错的角色 fixture（如 operator 调 admin-only 端点） | 检查 `*_headers` 与端点要求是否匹配 |
| 中文用户名报 UnicodeEncodeError | header 直接传中文，未 base64 | 用 `*_headers` fixture（已处理）；或自己 `base64.b64encode(...)` |