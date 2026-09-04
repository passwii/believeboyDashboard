# CRM P6a 价值分档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **基线**：main = 5d7eb58e；prod alembic = 222。**新迁移 rev id = 223**（执行前 `git fetch && rebase origin/main` + `alembic heads` 确认单链）。
> **设计文档**：`docs/superpowers/specs/2026-07-29-crm-p6-data-modeling-design.md`（必读）。
> **范围**：仅 P6a 价值分档。P6b 产品类目独立 plan。

**Goal:** CRM 客户实体落地主观综合价值分档（4 维 ABCD 打分 → 等权汇总自动计算综合档接管 rating），支撑销售分优先级。

**Architecture:** 后端 `crm_customers` 加 4 个可空 score 列 + 新 `value_score_service`（纯 `compute_rating` + 持久化 `update_scores`，沿用 P5-6a `commit=` 原子模式）+ 单端点 `PATCH /value-scores`；前端共享常量 `value-score.ts`（含 TS `computeRating` 实时预览）+ `CrmValueProfileCard` 嵌入抽屉详情 tab 顶部 + rating 改彩色 badge。

**Tech Stack:** Python 3.14 + FastAPI + SQLAlchemy 2 + Alembic + pytest；Next.js + TypeScript + Vitest + shadcn/ui（Tooltip, ToggleGroup, Badge）。

## Global Constraints

- **测试 DB**：`BLF_test` 共享；CRM `truncate ... restart identity cascade` 隔离。**DB 测试主 agent 串行跑**；subagent 只跑 lint/build/非 DB 单测/`pnpm test`。
- **后端**：`cd backend && .venv/bin/python -m pytest <path> -q`。
- **前端门禁**：`cd frontend && pnpm lint && pnpm build && pnpm test`。
- **WIP 保护**：工作区有另一 agent WIP（≥10 backend 文件 + pyproject.toml）。**`git add` 只加本任务文件**，严禁 `-A/-u/commit -a`；操作前 `git status -sb` 核对。
- **部署**：`git deploy`（含 backend 触发 VPS）。
- **迁移命名**：`YYYYMMDD_NNN_description.py`，纯数字短 ID（**223**），从最新递增。建前 rebase + `alembic heads` 单链。**严禁**裸 `alembic revision -m`。prod 已部署迁移禁改 id。
- **主键**：`Integer`。
- **权限**：经 `permissions.py` 的 `require_admin` / `require_owner_or_admin`。
- **审计**：写操作走 `audit_service.record_log`；**P5-6a 强一致**（service `commit=False` flush + 端点统一 `db.commit()`）。
- **Commit**：中文 + Conventional Commits，scope 中文，subject 动宾短语 ≤50 字无句号。
- **TDD**：失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。**绝不**先实现后补测试。
- **范围**：仅 P6a，不动 P6b。

## File Structure

**新文件**
- `backend/app/services/crm/value_score_service.py` — `compute_rating` + `update_scores`。
- `backend/tests/services/crm/test_value_score_service.py` — 15 单测（9 compute + 6 update）。
- `backend/alembic/versions/20260729_223_crm_value_scores.py` — 4 可空 score 列。
- `backend/tests/api/crm/test_value_scores_api.py` — 8 集成测试（端点 5 + 列表/筛选 3）。
- `frontend/lib/crm/constants/value-score.ts` — 4 维定义 + 档位 + TS `computeRating`。
- `frontend/lib/crm/constants/value-score.test.ts` — TS 8 单测。
- `frontend/components/crm/crm-value-profile-card/index.tsx` — 抽屉价值画像卡。
- `frontend/components/crm/crm-value-profile-card/index.test.tsx` — 4 组件测试。

**修改**
- `backend/app/models/crm.py` — CrmCustomer +4 score 字段。
- `backend/app/schemas/crm.py` — CustomerItem +4 score；新增 `ValueScoresUpdate`。
- `backend/app/api/v1/endpoints/crm.py` — 新端点 `PATCH /customers/{id}/value-scores` + helper。
- `backend/app/services/crm/customer_service.py` — `_to_item` 读 4 score。
- `backend/app/services/crm/filter_engine.py` — `CUSTOMER_FILTER_FIELDS` +5。
- `frontend/lib/crm/types/customer.ts` — Customer +4 score；`ValueScoresInput`。
- `frontend/lib/crm/api/crm-client.ts` — `updateValueScores`。
- `frontend/lib/crm/api/http-crm-client.ts` — 实现。
- `frontend/lib/crm/api/mock-crm-client.ts` — mock。
- `frontend/lib/crm/api/dto-mappers.ts` — `mapCustomer` +4 score。
- `frontend/lib/crm/api/http-crm-client.test.ts` — +2。
- `frontend/components/crm/crm-overview-drawer/index.tsx` — 详情 tab 顶部嵌入卡片。
- `frontend/components/crm/customer-table.tsx` — rating 彩色 badge。

---

### Task 1: 迁移 — crm_customers 加 4 score 列

**Files:** Create `backend/alembic/versions/20260729_223_crm_value_scores.py`

**前置**：`cd backend && git fetch && rebase origin/main && .venv/bin/alembic heads`（单 head）。

- [ ] **Step 1**: 建迁移（**严禁裸 `alembic revision -m`**）：
```bash
cd backend && .venv/bin/alembic revision --rev-id 223 -m "crm 价值分档 4 维 score 列"
```
- [ ] **Step 2**: 写迁移内容（替换 `upgrade()` / `downgrade()`，`revision='223'`, `down_revision='222'`）：
```python
"""crm 价值分档 4 维 score 列（P6a）。"""
from alembic import op
import sqlalchemy as sa

revision = '223'
down_revision = '222'
branch_labels = None
depends_on = None

def upgrade() -> None:
    for col in ('score_scale', 'score_pay', 'score_fit', 'score_coop'):
        op.add_column('crm_customers', sa.Column(col, sa.String(length=1), nullable=True))

def downgrade() -> None:
    for col in ('score_coop', 'score_fit', 'score_pay', 'score_scale'):
        op.drop_column('crm_customers', col)
```
- [ ] **Step 3**: 跑 + 验证：
```bash
cd backend && .venv/bin/alembic upgrade head
.venv/bin/python -c "from app.db.session import SessionLocal; from sqlalchemy import text; s=SessionLocal(); print([r[0] for r in s.execute(text(\"select column_name from information_schema.columns where table_name='crm_customers' and column_name like 'score_%' order by column_name\")).all()]); s.close()"
```
预期：`['score_coop','score_fit','score_pay','score_scale']`。
- [ ] **Step 4**: 回归：`cd backend && .venv/bin/python -m pytest tests/api/crm tests/services/crm -q` → 238 通过。
- [ ] **Step 5**: 提交：`git add backend/alembic/versions/20260729_223_crm_value_scores.py` + `git commit -m "feat(crm): 加 4 维价值评分 score 列（P6a Task 1）"`。

---

### Task 2: Model + Schema 加 4 score 字段

**Files:** Modify `backend/app/models/crm.py`（CrmCustomer）+ `backend/app/schemas/crm.py`（CustomerItem + ValueScoresUpdate）。

- [ ] **Step 1**: CrmCustomer 类内（`rating` 字段附近）追加：
```python
score_scale: Mapped[Optional[str]] = mapped_column(String(1), nullable=True)
score_pay: Mapped[Optional[str]] = mapped_column(String(1), nullable=True)
score_fit: Mapped[Optional[str]] = mapped_column(String(1), nullable=True)
score_coop: Mapped[Optional[str]] = mapped_column(String(1), nullable=True)
```
- [ ] **Step 2**: `CustomerItem` 加 4 字段（`rating` 附近）：
```python
score_scale: Optional[str] = None
score_pay: Optional[str] = None
score_fit: Optional[str] = None
score_coop: Optional[str] = None
```
- [ ] **Step 3**: 新增 schema（`CustomerUpdate` 之后）：
```python
class ValueScoresUpdate(BaseModel):
    """P6a 价值评分更新（部分更新：仅写入提供的维度）。"""
    model_config = ConfigDict(extra='forbid')
    score_scale: Optional[Literal['A','B','C','D']] = None
    score_pay:   Optional[Literal['A','B','C','D']] = None
    score_fit:   Optional[Literal['A','B','C','D']] = None
    score_coop:  Optional[Literal['A','B','C','D']] = None
```
确认 `Literal` 已导入（若未 `from typing import Literal`）。
- [ ] **Step 4**: 验证 + 回归：
```bash
cd backend && .venv/bin/python -c "from app.models.crm import CrmCustomer; from app.schemas.crm import ValueScoresUpdate, CustomerItem; print(CrmCustomer.score_scale, CustomerItem.model_fields['score_scale'])"
.venv/bin/python -m pytest tests/api/crm tests/services/crm -q
```
预期：导入无错；238 通过。
- [ ] **Step 5**: 提交：`git add backend/app/models/crm.py backend/app/schemas/crm.py` + `git commit -m "feat(crm): 模型与 DTO 加 4 维 score 字段（P6a Task 2）"`。

---

### Task 3: value_score_service.compute_rating + 9 单测（TDD）

**Files:** Create `backend/app/services/crm/value_score_service.py` + `backend/tests/services/crm/test_value_score_service.py`。

- [ ] **Step 1**: 写测试 `test_value_score_service.py`：
```python
from app.services.crm.value_score_service import (
    GRADE_POINTS, DEFAULT_WEIGHTS, SCORE_FIELDS, compute_rating,
)

def test_all_a_returns_a():
    assert compute_rating({f: "A" for f in SCORE_FIELDS}) == "A"

def test_all_d_returns_d():
    assert compute_rating({f: "D" for f in SCORE_FIELDS}) == "D"

def test_any_none_returns_none():
    s = {**{f: "A" for f in SCORE_FIELDS}, "score_coop": None}
    assert compute_rating(s) is None

def test_incomplete_one_dim_returns_none():
    s = {"score_scale": "A", "score_pay": "B", "score_fit": None, "score_coop": "A"}
    assert compute_rating(s) is None

def test_mixed_boundaries():
    # 2A+2B = 3.5 → A
    assert compute_rating({"score_scale":"A","score_pay":"A","score_fit":"B","score_coop":"B"}) == "A"
    # 1A+2B+1C = 3.0 → B
    assert compute_rating({"score_scale":"A","score_pay":"B","score_fit":"B","score_coop":"C"}) == "B"

def test_below_3_5_is_b():
    # A+A+A+D = 3.25 → B
    assert compute_rating({"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"D"}) == "B"

def test_b_and_c_boundaries():
    # B+B+B+C = 2.75 → B
    assert compute_rating({"score_scale":"B","score_pay":"B","score_fit":"B","score_coop":"C"}) == "B"
    # C+C+C+D = 1.75 → C
    assert compute_rating({"score_scale":"C","score_pay":"C","score_fit":"C","score_coop":"D"}) == "C"

def test_weights_param_changes_result():
    s = {"score_scale":"D","score_pay":"A","score_fit":"D","score_coop":"D"}
    assert compute_rating(s) == "C"  # 等权 (1+4+1+1)/4 = 1.75
    w = {"score_scale":0,"score_pay":1,"score_fit":0,"score_coop":0}
    assert compute_rating(s, weights=w) == "A"  # 仅看 pay=4 → A

def test_extra_keys_ignored():
    s = {**{f:"A" for f in SCORE_FIELDS}, "unknown":"X"}
    assert compute_rating(s) == "A"

def test_constants():
    assert GRADE_POINTS == {"A":4,"B":3,"C":2,"D":1}
    assert DEFAULT_WEINTS := DEFAULT_WEIGHTS
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9
    assert SCORE_FIELDS == ("score_scale","score_pay","score_fit","score_coop")
```
（注：test_constants 删 `:=` 写法 — 修正为：）
```python
def test_constants():
    assert GRADE_POINTS == {"A":4,"B":3,"C":2,"D":1}
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9
    assert SCORE_FIELDS == ("score_scale","score_pay","score_fit","score_coop")
```
- [ ] **Step 2**: 跑确认红：`cd backend && .venv/bin/python -m pytest tests/services/crm/test_value_score_service.py -q` → ImportError 红。
- [ ] **Step 3**: 实现 `value_score_service.py`：
```python
"""P6a 价值评分服务：4 维 ABCD → 等权汇总 A/B/C/D（纯函数 + 持久化）。"""
from __future__ import annotations

GRADE_POINTS: dict[str, int] = {"A": 4, "B": 3, "C": 2, "D": 1}
DEFAULT_WEIGHTS: dict[str, float] = {
    "score_scale": 0.25, "score_pay": 0.25, "score_fit": 0.25, "score_coop": 0.25,
}
SCORE_FIELDS: tuple[str, ...] = ("score_scale", "score_pay", "score_fit", "score_coop")


def compute_rating(
    scores: dict[str, str | None],
    weights: dict[str, float] | None = None,
) -> str | None:
    """4 维全非空 → A/B/C/D；任一空 → None。仅识别 SCORE_FIELDS keys。"""
    if any(scores.get(k) is None for k in SCORE_FIELDS):
        return None
    w = weights if weights is not None else DEFAULT_WEIGHTS
    total = sum(GRADE_POINTS[scores[k]] * w[k] for k in SCORE_FIELDS)  # type: ignore[index]
    if total >= 3.5: return "A"
    if total >= 2.5: return "B"
    if total >= 1.5: return "C"
    return "D"
```
- [ ] **Step 4**: 跑绿 → 9 全过。
- [ ] **Step 5**: 回归 `pytest tests/api/crm tests/services/crm -q` → 238。
- [ ] **Step 6**: 提交。

---

### Task 4: update_scores + 6 单测（TDD）

**Files:** Modify 同上两个文件（追加 `update_scores` + 测试）。

- [ ] **Step 1**: 追加 6 测试到 `test_value_score_service.py`：
```python
import pytest
from sqlalchemy import text, select
from app.db.session import SessionLocal
from app.models.crm import CrmCustomer
from app.services.crm.value_score_service import update_scores

@pytest.fixture
def customer(db_session):
    row = db_session.execute(
        text("insert into crm_customers (name, created_by) values ('P6A', 't') returning id")
    ).first()
    db_session.commit()
    return int(row[0])

def test_update_scores_full_set_recomputes(db_session, customer):
    cust, old, changed = update_scores(
        db_session, customer,
        {"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"},
        user_id="t",
    )
    assert cust is not None and changed is True and cust.rating == "A" and old is None

def test_update_scores_partial_keeps_rating(db_session, customer):
    cust, _old, changed = update_scores(db_session, customer, {"score_scale":"A","score_pay":"A"}, user_id="t")
    assert cust is not None and changed is False and cust.rating is None

def test_update_scores_legacy_rating_overwritten(db_session, customer):
    db_session.execute(text("update crm_customers set rating='B' where id=:i"), {"i": customer})
    db_session.commit()
    update_scores(db_session, customer, {"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, user_id="t")
    s = SessionLocal()
    try:
        assert s.execute(text("select rating from crm_customers where id=:i"), {"i": customer}).scalar_one() == "A"
    finally: s.close()

def test_update_scores_invalid_grade_raises(db_session, customer):
    with pytest.raises(ValueError, match="非法档位"):
        update_scores(db_session, customer, {"score_scale":"E"}, user_id="t")

def test_update_scores_customer_not_found(db_session):
    cust, _, changed = update_scores(db_session, 999999, {"score_scale":"A"}, user_id="t")
    assert cust is None and changed is False

def test_update_scores_commit_false_no_autocommit(db_session, customer):
    update_scores(db_session, customer, {"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, user_id="t", commit=False)
    s = SessionLocal()
    try:
        assert s.execute(text("select rating from crm_customers where id=:i"), {"i": customer}).scalar_one() is None
    finally: s.close()
```
- [ ] **Step 2**: 跑红 → 6 红（update_scores 未定义）。
- [ ] **Step 3**: 追加 `value_score_service.py`：
```python
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.models.crm import CrmCustomer

_VALID_GRADES = frozenset(GRADE_POINTS.keys())


def _validate_scores(scores: dict) -> None:
    for k, v in scores.items():
        if k not in SCORE_FIELDS:
            continue
        if v is None:
            continue
        if v not in _VALID_GRADES:
            raise ValueError(f"非法档位 {k}={v!r}（须为 A/B/C/D 或 null）")


def update_scores(
    db: Session, customer_id: int, scores: dict, *, user_id: str | None, commit: bool = True,
) -> tuple[CrmCustomer | None, str | None, bool]:
    """部分更新 4 维；写入后 4 维全非空 → 重算 rating；否则不动。

    返回 (customer, old_rating, rating_changed)。客户不存在 → (None, None, False)。
    非法档位抛 ValueError。commit=False 仅 flush（端点统一 commit）。
    """
    _validate_scores(scores)
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return None, None, False
    old_rating = cust.rating
    for k, v in scores.items():
        if k in SCORE_FIELDS and v is not None:
            setattr(cust, k, v)
    db.flush()
    current = {
        "score_scale": cust.score_scale, "score_pay": cust.score_pay,
        "score_fit": cust.score_fit, "score_coop": cust.score_coop,
    }
    new_rating = compute_rating(current)
    rating_changed = False
    if new_rating is not None and new_rating != cust.rating:
        cust.rating = new_rating
        rating_changed = True
        db.flush()
    if commit:
        db.commit()
    db.refresh(cust)
    return cust, old_rating, rating_changed
```
- [ ] **Step 4**: 跑绿 → 15 全过。
- [ ] **Step 5**: 回归 → 238。
- [ ] **Step 6**: 提交。

---

### Task 5: PATCH /value-scores 端点 + 5 集成测试（TDD）

**Files:** Modify `backend/app/api/v1/endpoints/crm.py`（+ 端点 + helper + import）。Create `backend/tests/api/crm/test_value_scores_api.py`。

- [ ] **Step 1**: 写测试（5 个）：
```python
"""P6a 价值评分端点集成测试。"""
import json
import pytest
from sqlalchemy import text

@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal
    s = SessionLocal()
    try:
        s.execute(text("truncate crm_audit_logs, crm_follows, crm_opportunities, crm_contacts, crm_leads, crm_customers restart identity cascade"))
        s.commit()
    finally: s.close()
    yield

def _mk(client, admin_headers, name="P6A", owner="u-admin"):
    return client.post("/api/v1/crm/customers", json={"name": name, "owner_id": owner}, headers=admin_headers).json()["id"]


def test_full_set_recomputes_and_audits(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rating"] == "A" and body["score_scale"] == "A"
    logs = client.get("/api/v1/crm/audit-logs",
        params={"entity_type":"customer","entity_id":cid,"action":"update"}, headers=admin_headers).json()
    assert logs["total"] == 1 and "价值评分" in logs["items"][0]["summary"] and "综合A" in logs["items"][0]["summary"]


def test_partial_keeps_rating_and_audits_unrated(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale":"A","score_pay":"B"}, headers=admin_headers)
    assert r.status_code == 200 and r.json()["rating"] is None
    logs = client.get("/api/v1/crm/audit-logs",
        params={"entity_type":"customer","entity_id":cid,"action":"update"}, headers=admin_headers).json()
    assert logs["total"] == 1 and ("待完善" in logs["items"][0]["summary"] or "未" in logs["items"][0]["summary"])


def test_invalid_grade_400(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(f"/api/v1/crm/customers/{cid}/value-scores", json={"score_scale":"E"}, headers=admin_headers)
    assert r.status_code == 400


def test_audit_failure_rolls_back_business(client, admin_headers, monkeypatch):
    from app.services.crm import audit_service
    cid = _mk(client, admin_headers)
    def _boom(*a, **k): raise RuntimeError("audit boom")
    monkeypatch.setattr(audit_service, "record_log", _boom)
    with pytest.raises(RuntimeError, match="audit boom"):
        client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
            json={"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, headers=admin_headers)
    s = SessionLocal()
    try:
        n = s.execute(text("select count(*) from crm_customers where score_scale='A' and id=:i"), {"i": cid}).scalar_one()
    finally: s.close()
    assert n == 0
    from app.db.session import SessionLocal  # noqa 已在上面


def test_404_when_customer_missing(client, admin_headers):
    r = client.patch("/api/v1/crm/customers/999999/value-scores", json={"score_scale":"A"}, headers=admin_headers)
    assert r.status_code == 404
```
（修正：第 4 测试里 `from app.db.session import SessionLocal` 重复 import — 删第二行，已在 `try` 块内用。）
- [ ] **Step 2**: 跑红 → 404 全红（路由未注册）。
- [ ] **Step 3**: 实现端点。`crm.py`：
  - import 加：`ValueScoresUpdate`（从 schemas）；`value_score_service`（从 services.crm）。
  - helper（紧邻 `update_contact` 后）：
```python
def _summarize_value_scores(payload: dict, rating_changed: bool, new_rating: str | None) -> str:
    labels = {"score_scale":"体量","score_pay":"付费","score_fit":"匹配","score_coop":"合作"}
    parts = [f"{labels[k]}{v}" for k, v in payload.items() if v is not None]
    head = "价值评分：" + " ".join(parts)
    if rating_changed and new_rating is not None:
        return f"{head} → 综合{new_rating}"
    return f"{head}（评分待完善）"
```
  - 端点（`update_customer` 之后）：
```python
@router.patch("/customers/{customer_id}/value-scores", response_model=CustomerItem)
def update_value_scores(
    customer_id: int, payload: ValueScoresUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = customer_service.get_customer(db, customer_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    try:
        cust, _old, rating_changed = value_score_service.update_scores(
            db, customer_id, payload.model_dump(exclude_unset=True), user_id=user_id, commit=False,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if cust is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    summary = _summarize_value_scores(payload.model_dump(exclude_unset=True), rating_changed, cust.rating)
    audit_service.record_log(
        db, entity_type="customer", entity_id=customer_id, action="update",
        actor_id=user_id, summary=summary,
    )
    db.commit()
    return customer_service.get_customer(db, customer_id)
```
- [ ] **Step 4**: 跑绿 → 5 全过。
- [ ] **Step 5**: 回归 → **243**（238 + 5）。
- [ ] **Step 6**: 提交。

---

### Task 6: filter_engine 白名单 + 列表返回 score + 3 集成测试

**Files:** Modify `backend/app/services/crm/filter_engine.py`（`CUSTOMER_FILTER_FIELDS` +5）+ `backend/app/services/crm/customer_service.py`（`_to_item` 读 4 score）。Append tests to `test_value_scores_api.py`.

- [ ] **Step 1**: Append 3 tests to `test_value_scores_api.py`:
```python
def test_list_customers_includes_scores(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale":"A","score_pay":"B","score_fit":"C","score_coop":"D"}, headers=admin_headers)
    body = client.get("/api/v1/crm/customers", headers=admin_headers).json()
    item = next(i for i in body["items"] if i["id"] == cid)
    assert item["score_scale"] == "A" and item["score_pay"] == "B" and item["score_fit"] == "C" and item["score_coop"] == "D"
    # A B C D → (4+3+2+1)/4 = 2.5 → B
    assert item["rating"] == "B"


def test_filter_by_rating(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, headers=admin_headers)
    r = client.get("/api/v1/crm/customers",
        params={"filters": json.dumps([{"field":"rating","op":"eq","value":"A"}])}, headers=admin_headers)
    assert r.status_code == 200 and cid in [i["id"] for i in r.json()["items"]]


def test_filter_by_score_pay(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale":"A","score_pay":"A","score_fit":"A","score_coop":"A"}, headers=admin_headers)
    r = client.get("/api/v1/crm/customers",
        params={"filters": json.dumps([{"field":"score_pay","op":"eq","value":"A"}])}, headers=admin_headers)
    assert r.status_code == 200 and cid in [i["id"] for i in r.json()["items"]]
```
- [ ] **Step 2**: 跑红（rating/score_pay 不在白名单 → 400；列表 score=None）。
- [ ] **Step 3**: `filter_engine.py` 的 `CUSTOMER_FILTER_FIELDS` tuple 追加 5 项：`"score_scale", "score_pay", "score_fit", "score_coop", "rating"`。
- [ ] **Step 4**: `customer_service.py` 的 `_to_item` 构造 `CustomerItem` 处追加：`score_scale=cust.score_scale, score_pay=cust.score_pay, score_fit=cust.score_fit, score_coop=cust.score_coop`。
- [ ] **Step 5**: 跑绿 → 8 全过（5 端点 + 3 列表）。
- [ ] **Step 6**: 回归 → **246**（238 + 8）。
- [ ] **Step 7**: 提交：`git add backend/app/services/crm/filter_engine.py backend/app/services/crm/customer_service.py backend/tests/api/crm/test_value_scores_api.py` + `git commit -m "feat(crm): filter_engine 加 4 维+rating 白名单，列表返回 score（P6a Task 6）"`。

---

### Task 7: 前端常量 value-score.ts + TS computeRating（TDD）

**Files:** Create `frontend/lib/crm/constants/value-score.ts` + `value-score.test.ts`.

- [ ] **Step 1**: 写测试 `value-score.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SCORE_FIELDS, GRADE_OPTIONS, GRADE_COLOR, computeRating, DEFAULT_WEIGHTS } from './value-score'

describe('constants', () => {
  it('4 维定义', () => {
    expect(SCORE_FIELDS).toHaveLength(4)
    expect(SCORE_FIELDS.map(f => f.key)).toEqual(['score_scale','score_pay','score_fit','score_coop'])
    expect(SCORE_FIELDS.every(f => f.label && f.tooltip.length > 5)).toBe(true)
  })
  it('档位与配色', () => {
    expect(GRADE_OPTIONS).toEqual(['A','B','C','D'])
    expect(Object.keys(GRADE_COLOR)).toEqual(['A','B','C','D'])
  })
  it('等权向量', () => {
    expect(Math.abs(Object.values(DEFAULT_WEIGHTS).reduce((a,b)=>a+b,0) - 1)).toBeLessThan(1e-9)
  })
})

describe('computeRating', () => {
  it('4A→A / 4D→D', () => {
    expect(computeRating({score_scale:'A',score_pay:'A',score_fit:'A',score_coop:'A'})).toBe('A')
    expect(computeRating({score_scale:'D',score_pay:'D',score_fit:'D',score_coop:'D'})).toBe('D')
  })
  it('任一空→null', () => {
    expect(computeRating({score_scale:'A',score_pay:'B',score_fit:'C',score_coop:null})).toBeNull()
  })
  it('A A A D = 3.25 → B', () => {
    expect(computeRating({score_scale:'A',score_pay:'A',score_fit:'A',score_coop:'D'})).toBe('B')
  })
  it('权重生效', () => {
    const s = {score_scale:'D',score_pay:'A',score_fit:'D',score_coop:'D'}
    expect(computeRating(s)).toBe('C')
    expect(computeRating(s, {score_scale:0,score_pay:1,score_fit:0,score_coop:0})).toBe('A')
  })
})
```
- [ ] **Step 2**: 跑红 → 模块未找到。
- [ ] **Step 3**: 实现 `value-score.ts`:
```ts
export type Grade = 'A'|'B'|'C'|'D'
export const GRADE_OPTIONS: Grade[] = ['A','B','C','D']
export const GRADE_POINTS: Record<Grade, number> = {A:4,B:3,C:2,D:1}
export type ScoreKey = 'score_scale'|'score_pay'|'score_fit'|'score_coop'
export const SCORE_FIELDS: { key: ScoreKey; label: string; tooltip: string }[] = [
  {key:'score_scale', label:'体量与潜力', tooltip:'客户自身业务规模、所在产品类目的跨境销售体量、增长空间。盘子越大、品类越适合跨境、增长越快 → 评得越高。'},
  {key:'score_pay', label:'付费能力与意愿', tooltip:'客户有没有预算、愿不愿意为运营服务持续付费。既有支付能力又有长期付费意愿 → 高；只谈价、预算紧、付费犹豫 → 低。'},
  {key:'score_fit', label:'跨境匹配度', tooltip:'客户对跨境电商的认知、投入决心、产品与团队适配度。懂跨境、舍得投入、产品适合出海 → 高；完全外行、观望试探 → 低。'},
  {key:'score_coop', label:'合作性', tooltip:'对接是否顺畅、决策链是否清晰、配合度与沟通成本。对接人稳定、决策快、配合好 → 高；需求反复、决策混乱、难沟通 → 低。'},
]
export const GRADE_COLOR: Record<Grade, string> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  B: 'bg-sky-100 text-sky-800 dark:bg-sky-800/40 dark:text-sky-200',
  C: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  D: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
}
export const DEFAULT_WEIGHTS: Record<ScoreKey, number> = {score_scale:.25, score_pay:.25, score_fit:.25, score_coop:.25}
export type ScoreMap = Partial<Record<ScoreKey, Grade | null>>
export function computeRating(scores: ScoreMap, weights?: Record<ScoreKey, number>): Grade | null {
  const w = weights ?? DEFAULT_WEIGHTS
  for (const f of SCORE_FIELDS) if (scores[f.key] == null) return null
  const sum = SCORE_FIELDS.reduce((acc, f) => acc + GRADE_POINTS[scores[f.key] as Grade] * w[f.key], 0)
  if (sum >= 3.5) return 'A'
  if (sum >= 2.5) return 'B'
  if (sum >= 1.5) return 'C'
  return 'D'
}
```
- [ ] **Step 4**: 跑绿 → 8 全过。
- [ ] **Step 5**: `cd frontend && pnpm test` → **240**（232 + 8）。
- [ ] **Step 6**: 提交：`git add frontend/lib/crm/constants/value-score.ts frontend/lib/crm/constants/value-score.test.ts` + `git commit -m "feat(crm): 价值评分共享常量+TS computeRating（P6a Task 7）"`。

---

### Task 8: API client updateValueScores（TDD）

**Files:** Modify `customer.ts` (+4 score + ValueScoresInput), `crm-client.ts` (+method), `http-crm-client.ts` (impl), `mock-crm-client.ts` (impl), `dto-mappers.ts` (+4 score), `http-crm-client.test.ts` (+2).

- [ ] **Step 1**: 在 `http-crm-client.test.ts` 追加:
```ts
describe('HttpCrmClient.updateValueScores (P6a)', () => {
  let fetchMock: any
  let client: HttpCrmClient
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok:true, status:200, json: async () => ({
      id:7, name:'X', rating:'A', score_scale:'A', score_pay:'A', score_fit:'A', score_coop:'A',
      owner_id:'u1', owner_name:null, contact_name:null, contact_phone:null, contact_email:null,
      contact_wechat:null, address:null, website:null, annual_revenue:null, employee_count:null,
      remark:null, last_follow_at:null, next_follow_at:null, created_by:'u1', created_at:'', updated_at:'',
    })})
    vi.stubGlobal('fetch', fetchMock); client = new HttpCrmClient()
  })
  it('PATCH /customers/{id}/value-scores with body', async () => {
    await client.updateValueScores(7, {score_scale:'A',score_pay:'A',score_fit:'A',score_coop:'A'})
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/customers/7/value-scores')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({score_scale:'A',score_pay:'A',score_fit:'A',score_coop:'A'})
  })
  it('partial body sends only provided', async () => {
    await client.updateValueScores(7, {score_scale:'A',score_pay:'B'})
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({score_scale:'A',score_pay:'B'})
  })
})
```
- [ ] **Step 2**: 跑红（TS 错/未实现）。
- [ ] **Step 3**: `customer.ts` 加 4 score 字段（`scoreScale/Pay/Fit/Coop: Grade | null`）+ `ValueScoresInput = Partial<Record<ScoreKey, Grade | null>>`。
- [ ] **Step 4**: `dto-mappers.ts` `mapCustomer` 末尾 +4 score。
- [ ] **Step 5**: `crm-client.ts` 接口 +`updateValueScores(customerId: string, input: ValueScoresInput): Promise<Customer>`。
- [ ] **Step 6**: `http-crm-client.ts`:
```ts
async updateValueScores(customerId: string, input: ValueScoresInput): Promise<Customer> {
  return mapCustomer(await request<CustomerDto>(`/customers/${customerId}/value-scores`, {method:'PATCH', body: JSON.stringify(input)}))
}
```
确认 `request` 已支持 method/body（参考既有 PATCH `updateCustomer` 写法复用）。
- [ ] **Step 7**: `mock-crm-client.ts`: 加载 `customers` 内存态，对 provided keys setattr，调 `computeRating` 重算 `c.rating`，返回 spread。
- [ ] **Step 8**: 跑绿 → 2 新测试过；既有 http-crm-client.test 全过。
- [ ] **Step 9**: `pnpm test` → **242**；`pnpm lint && pnpm build` → 0 错 + 成功。
- [ ] **Step 10**: 提交。

---

### Task 9: CrmValueProfileCard + 抽屉集成 + 4 组件测试（TDD）

**Files:** Create `frontend/components/crm/crm-value-profile-card/index.tsx` + `index.test.tsx`. Modify `crm-overview-drawer/index.tsx` (详情 tab 顶部嵌入) + `customer-table.tsx` (rating badge 颜色).

- [ ] **Step 1**: 写 4 组件测试（`vi.hoisted` + `vi.mock` 稳定 client，与 P5-9 审计时间线同模式）:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmValueProfileCard } from './index'
import type { Customer } from '@/lib/crm/types/customer'

const { mockClient, mockUpdateValueScores } = vi.hoisted(() => {
  const fn = vi.fn()
  return { mockClient: { updateValueScores: fn }, mockUpdateValueScores: fn }
})
vi.mock('@/lib/crm/api/crm-client-provider', async (i) => {
  const a = await i<typeof import('@/lib/crm/api/crm-client-provider')>()
  return { ...a, useCrmClient: () => mockClient }
})

const now = new Date().toISOString()
const mk = (o: Partial<Customer> = {}): Customer => ({
  id:'7', name:'X', rating:'B', scoreScale:'A', scorePay:'A', scoreFit:'B', scoreCoop:'A',
  ownerId:'u1', ownerName:'小王', status:'active', source:'referral',
  contactName:null, contactPhone:null, contactEmail:null, contactWechat:null,
  address:null, website:null, annualRevenue:null, employeeCount:null, remark:null,
  lastFollowAt:null, nextFollowAt:null, createdBy:'u1', createdAt:now, updatedAt:now,
  ...o,
}) as any

describe('CrmValueProfileCard (P6a)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('展示 4 维度 + 综合档 badge + ?', () => {
    render(<CrmValueProfileCard customer={mk()} />)
    expect(screen.getByText('体量与潜力')).toBeTruthy()
    expect(screen.getByText('付费能力与意愿')).toBeTruthy()
    expect(screen.getByText('跨境匹配度')).toBeTruthy()
    expect(screen.getByText('合作性')).toBeTruthy()
    expect(screen.getByText('综合档 B')).toBeTruthy()
  })

  it('未评分显示待完善', () => {
    render(<CrmValueProfileCard customer={mk({rating:null, scoreScale:null, scorePay:null, scoreFit:null, scoreCoop:null})} />)
    expect(screen.getByText(/评分待完善|未评分/)).toBeTruthy()
  })

  it('编辑 → 选 A → 保存调 updateValueScores', async () => {
    mockUpdateValueScores.mockResolvedValue(mk({scoreScale:'A',scorePay:'A',scoreFit:'A',scoreCoop:'A',rating:'A'}))
    render(<CrmValueProfileCard customer={mk()} />)
    fireEvent.click(screen.getByRole('button', {name:'编辑评分'}))
    const aBtns = await screen.findAllByRole('radio', {name:'A'})
    expect(aBtns.length).toBe(4)
    aBtns.forEach(b => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', {name:'保存评分'}))
    await waitFor(() => expect(mockUpdateValueScores).toHaveBeenCalledWith('7', {score_scale:'A',score_pay:'A',score_fit:'A',score_coop:'A'}))
  })

  it('ToggleGroup 仅 A/B/C/D 四档', async () => {
    render(<CrmValueProfileCard customer={mk()} />)
    fireEvent.click(screen.getByRole('button', {name:'编辑评分'}))
    expect(screen.getAllByRole('radio', {name:'A'}).length).toBe(4)
    expect(screen.getAllByRole('radio', {name:'D'}).length).toBe(4)
  })
})
```
- [ ] **Step 2**: 跑红 → 组件未存在。
- [ ] **Step 3**: 实现 `index.tsx`（`useCrmClient` + `useState` draft + Tooltip/ToggleGroup; editing 切换; `handleSave` 比较 draft vs current 算 input 仅变更项，调 `updateValueScores`，`onSaved` 回写; `liveRating` 用 `computeRating(draft)` 预览; 编辑模式 4 行 ToggleGroup 仅 A/B/C/D）:
```tsx
'use client'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { HelpCircle } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { SCORE_FIELDS, GRADE_OPTIONS, GRADE_COLOR, computeRating, type Grade, type ScoreKey } from '@/lib/crm/constants/value-score'
import type { Customer, ValueScoresInput } from '@/lib/crm/types/customer'

const KEY_TO_CUST: Record<ScoreKey, keyof Customer> = {
  score_scale:'scoreScale', score_pay:'scorePay', score_fit:'scoreFit', score_coop:'scoreCoop',
}

export function CrmValueProfileCard({ customer, onSaved }: { customer: Customer; onSaved?: (c: Customer) => void }) {
  const client = useCrmClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<ScoreKey, Grade | null>>({
    score_scale: customer.scoreScale ?? null, score_pay: customer.scorePay ?? null,
    score_fit: customer.scoreFit ?? null, score_coop: customer.scoreCoop ?? null,
  })
  const [saving, setSaving] = useState(false)
  const liveRating = computeRating(draft)

  async function handleSave() {
    setSaving(true)
    try {
      const input: ValueScoresInput = {}
      for (const f of SCORE_FIELDS) {
        if (draft[f.key] !== customer[KEY_TO_CUST[f.key]]) input[f.key] = draft[f.key]
      }
      const updated = await client.updateValueScores(customer.id, input)
      onSaved?.(updated); setEditing(false)
    } finally { setSaving(false) }
  }

  return (
    <div className="rounded-lg border border-border/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          价值画像
          {customer.rating
            ? <Badge className={GRADE_COLOR[customer.rating as Grade]} variant="secondary">综合档 {customer.rating}</Badge>
            : <span className="text-xs text-muted-foreground">评分待完善</span>}
          {editing && liveRating && liveRating !== customer.rating && (
            <Badge variant="outline" className="text-xs">预览 {liveRating}</Badge>
          )}
        </div>
        {!editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>编辑评分</Button>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {SCORE_FIELDS.map(f => {
          const cur = editing ? draft[f.key] : (customer[KEY_TO_CUST[f.key]] as Grade | null)
          return (
            <div key={f.key} className="flex items-center gap-2 text-sm">
              <span>{f.label}</span>
              <TooltipProvider><Tooltip><TooltipTrigger asChild><HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" /></TooltipTrigger>
                <TooltipContent className="max-w-xs"><p>{f.tooltip}</p></TooltipContent></Tooltip></TooltipProvider>
              {editing ? (
                <ToggleGroup type="single" value={cur ?? ''} onValueChange={v => v && setDraft(d => ({...d, [f.key]: v as Grade}))} className="ml-auto">
                  {GRADE_OPTIONS.map(g => <ToggleGroupItem key={g} value={g} aria-label={g} size="sm">{g}</ToggleGroupItem>)}
                </ToggleGroup>
              ) : cur ? <Badge variant="secondary" className={GRADE_COLOR[cur]}>{cur}</Badge> : <span className="ml-auto text-xs text-muted-foreground">—</span>}
            </div>
          )
        })}
      </div>
      {editing && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft({
            score_scale: customer.scoreScale ?? null, score_pay: customer.scorePay ?? null,
            score_fit: customer.scoreFit ?? null, score_coop: customer.scoreCoop ?? null,
          }) }}>取消</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? '保存中…' : '保存评分'}</Button>
        </div>
      )}
    </div>
  )
}
```
- [ ] **Step 4**: 跑绿 → 4 全过。
- [ ] **Step 5**: 抽屉集成：`crm-overview-drawer/index.tsx` 详情 tab content 顶部（`<CrmDetailCard>` 之前）插入 `<CrmValueProfileCard customer={data as Customer} />`（import `Customer` + `CrmValueProfileCard`）。
- [ ] **Step 6**: `customer-table.tsx` rating 单元格：若纯文本则包裹 `<Badge variant="secondary" className={GRADE_COLOR[rating as Grade]}>{rating}</Badge>`；无 rating 显示 `—`。
- [ ] **Step 7**: 全套前端门禁：`pnpm lint && pnpm build && pnpm test` → lint 0 错，build 成功，**246**（232 + 8 + 2 + 4）。
- [ ] **Step 8**: 提交。

---

## Self-Review

1. **Spec 覆盖**：§3 价值分档 → Task 2/3/4/5/6；§5 score 列 → Task 1/2；§6 服务/端点/审计 → Task 4/5/6；§7 前端/常量/客户端/抽屉/badge → Task 7/8/9。§3.2 权重预留 → Task 3 显式测试。健康度明确不做 ✓。
2. **Placeholder 扫描**：无 TBD/TODO。所有代码块为可粘贴实现。
3. **类型一致**：`SCORE_FIELDS` keys 后端 tuple 与前端 type 一致；DTO `score_scale/...` → mapper → `scoreScale/...` → 组件 `KEY_TO_CUST` 映射一致。`updateValueScores` 签名 task 8/9 一致。`GRADE_POINTS`/`DEFAULT_WEIGHTS` 后端 task 3 + 前端 task 7 值一致。
4. **范围**：仅 P6a，未触 P6b；health 明确不做。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-crm-p6a-value-tier.md`.

**Two execution options:**
1. **Subagent-Driven (recommended)** — 每 task 派 fresh subagent + 两阶段 review，repo 既有 P1–P5 惯例。
2. **Inline Execution** — 当前会话顺序跑 + 批检查点。

你已说"开始实施"，按 repo 惯例（AGENTS.md 提的 pi subagent 可靠性 + 历次 P1–P5 走的 subagent-driven）+ 本 plan header 推荐，**我以 subagent-driven 启动 Task 1**（如需改走 inline 随时打断）。
