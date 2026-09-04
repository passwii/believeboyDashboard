# CRM 公海批量导入客户 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CRM 公海页新增「导入客户」功能（粘贴 TSV + Excel 上传），批量把新客户写入公海（owner_id=NULL），带去重/校验/失败明细下载；并修复单条新建客户静默丢弃联系人的 bug。

**Architecture:** 前端用 exceljs/TSV 解析 + 三步预览 Sheet，POST JSON 行到新后端端点 `POST /crm/customers/import-sea`；后端 service 逐行校验、按「客户名+电话」去重跳过、批量插入（owner_id=None）、连带建主联系人、逐条 create 审计、单次 commit。联系人 bug 修复与导入共享同一条建联系人代码路径。

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic v2（后端）；Next.js + React + TypeScript + exceljs + Vitest + @testing-library/react（前端）；Postgres。

**Spec:** `docs/superpowers/specs/2026-07-31-crm-sea-import-design.md`

## Global Constraints

- 后端测试：`cd backend && pytest`（单个 `pytest tests/path::test_x`）；CRM 相关必须全绿。
- 前端测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`（Vitest, jsdom）。
- Commit：中文 + Conventional Commits（feat/fix/docs/test/chore…），scope 中文，subject 动宾短语 ≤50 字无句号。
- 迁移：本次**预计零迁移**（客户表/联系人表/审计表均不动）；若确需改表，按 AGENTS.md 用纯数字短 rev-id、建前 `git fetch && git rebase origin/main` 取单链。
- 主键统一 `Integer`。
- **CRM 测试共享 BLF_test 库且 truncate 清表**：subagent **不能并行跑 CRM 测试**，本计划所有任务**顺序执行**；每个 subagent 只跑自己任务相关的测试文件。
- 推送：`git deploy`（命中 `backend/` 自动部署 VPS；前端 Vercel 自动）。纯前端/docs 改动直接 `git push`。
- **只 stage 本任务文件**：工作区有其他 WIP（漏斗 redesign），严禁 `git add -A`。

## File Structure

**后端**
- `backend/app/schemas/crm.py` — 改 `CustomerCreate`（+contact）；新增 `CustomerSeaImportRow/Request/FailItem/Result`
- `backend/app/services/crm/customer_service.py` — 改 `create_customer`（建主联系人）；新增 `import_customers_to_sea` + 辅助
- `backend/app/api/v1/endpoints/crm.py` — 新增 `POST /customers/import-sea`（声明在 `/customers/{customer_id}` 之前）
- `backend/tests/services/crm/test_customer_service.py`、`backend/tests/api/crm/test_customers_api.py` — 测试

**前端**
- `frontend/lib/crm/types/customer.ts` — 新增导入类型
- `frontend/lib/crm/api/{crm-client,dto-mappers,http-crm-client,mock-crm-client}.ts` — 接口/映射/实现
- `frontend/lib/crm/constants/import-columns.ts` — 列定义 + 枚举反查
- `frontend/components/crm/crm-import-sea/{types,parse,template,index}.ts(x)` + 测试
- `frontend/app/dashboard/crm/sea/page.tsx` — 入口按钮
- `frontend/components/crm/index.ts` — barrel 导出

---

## Task 1: 后端 — 修复新建客户丢失联系人

**Files:** Modify `backend/app/schemas/crm.py`、`backend/app/services/crm/customer_service.py`；Test `backend/tests/services/crm/test_customer_service.py`、`backend/tests/api/crm/test_customers_api.py`

**Interfaces:** Produces `create_customer(db, payload, *, user_id, commit=True)` 在 `payload.contact_name` 非空时建主联系人（`CrmContact.is_primary=True`）。Task 2 复用同一 `contact_service.create_contact(..., commit=False)` 形态。

- [ ] **Step 1: 写失败的 service 测试**（追加到 `test_customer_service.py`，已有 `_clean_crm_tables` 夹具与 `ALICE`；顶部补 `from sqlalchemy import select`）

```python
class TestCreateWithContact:
    def test_create_with_contact_builds_primary_contact(self, db_session: Session):
        payload = CustomerCreate(name="带联系人公司", contact_name="张三",
                                 contact_phone="13800000000", contact_email="zhang@example.com")
        item = create_customer(db_session, payload, user_id=ALICE)
        assert item["contactName"] == "张三"
        assert item["contactPhone"] == "13800000000"
        ct = db_session.execute(
            select(CrmContact).where(CrmContact.customer_id == int(item["id"]))
        ).scalars().all()
        assert len(ct) == 1 and ct[0].is_primary is True and ct[0].name == "张三"

    def test_create_without_contact_name_creates_no_contact(self, db_session: Session):
        payload = CustomerCreate(name="无联系人", contact_phone="13900000000")
        item = create_customer(db_session, payload, user_id=ALICE)
        ct = db_session.execute(
            select(CrmContact).where(CrmContact.customer_id == int(item["id"]))
        ).scalars().all()
        assert ct == []
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd backend && pytest tests/services/crm/test_customer_service.py::TestCreateWithContact -v` → FAIL（`CustomerCreate` 无 `contact_name`）

- [ ] **Step 3: `CustomerCreate` 加字段**（`backend/app/schemas/crm.py`，`remark` 后追加）

```python
    # 联系人（contact_name 非空 → 建主联系人；phone/email 附带）
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
```

- [ ] **Step 4: 改 `create_customer`**（顶部补 `from app.schemas.crm import ContactCreate`、`from app.services.crm import contact_service`；整体替换）

```python
def create_customer(
    db: Session, payload: CustomerCreate, *, user_id: str | None, commit: bool = True
):
    cur = _current_user_id(user_id)
    data = payload.model_dump(exclude_unset=True)
    # 联系人字段不属于 CrmCustomer 列，先弹出，避免传给模型构造器报错
    contact_name = (data.pop("contact_name", None) or "").strip() or None
    contact_phone = data.pop("contact_phone", None)
    contact_email = data.pop("contact_email", None)
    cust = CrmCustomer(**data, created_by=cur)
    if cust.owner_id is None and cur is not None:
        cust.owner_id = cur  # 默认归创建人
    db.add(cust)
    db.flush()
    if contact_name:
        contact_service.create_contact(
            db, cust.id,
            ContactCreate(name=contact_name, phone=contact_phone or None,
                          email=contact_email or None, is_primary=True),
            commit=False,
        )
    if commit:
        db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)
```

- [ ] **Step 5: 跑 service 测试通过** — Run: `cd backend && pytest tests/services/crm/test_customer_service.py -v` → PASS

- [ ] **Step 6: 写 API 回归测试**（追加到 `test_customers_api.py`）

```python
def test_create_customer_with_contact_returns_contact(client, admin_headers):
    resp = client.post("/api/v1/crm/customers", headers=admin_headers,
                       json={"name": "API 带联系人", "contact_name": "李四", "contact_phone": "13711112222"})
    assert resp.status_code == 201, resp.text
    item = resp.json()
    assert item["contact_name"] == "李四"
    assert item["contact_phone"] == "13711112222"
```

- [ ] **Step 7: 跑 API 测试通过** — Run: `cd backend && pytest tests/api/crm/test_customers_api.py -v` → PASS

- [ ] **Step 8: Commit**

```bash
git add backend/app/schemas/crm.py backend/app/services/crm/customer_service.py \
        backend/tests/services/crm/test_customer_service.py backend/tests/api/crm/test_customers_api.py
git commit -m "fix(crm): 新建客户时保存联系人不再丢失"
```

---

## Task 2: 后端 — 导入 service（import_customers_to_sea）

**Files:** Modify `backend/app/schemas/crm.py`、`backend/app/services/crm/customer_service.py`；Test `backend/tests/services/crm/test_customer_service.py`

**Interfaces:** Consumes Task 1 引入的 `contact_service`/`ContactCreate`。Produces `import_customers_to_sea(db, rows, *, user_id, commit=True) -> {"created": int, "skipped_dupes": int, "failed": [{"row","field","reason"}]}`；schema `CustomerSeaImportRow/Request/FailItem/Result`。

- [ ] **Step 1: 写失败的 service 测试**（顶部补 `from app.schemas.crm import CustomerSeaImportRow`、`from app.services.crm.customer_service import import_customers_to_sea`、`from sqlalchemy import func, select`）

```python
def _row(name="导入客户", **kw):
    return CustomerSeaImportRow(name=name, **kw)


class TestImportToSea:
    def test_happy_path_creates_unowned_customers(self, db_session: Session):
        rows = [_row("客户甲"), _row("客户乙", rating="A", status="signed")]
        result = import_customers_to_sea(db_session, rows, user_id=ALICE)
        assert result["created"] == 2 and result["skipped_dupes"] == 0 and result["failed"] == []
        custs = db_session.execute(
            select(CrmCustomer).where(CrmCustomer.name.in_(["客户甲", "客户乙"]))
        ).scalars().all()
        assert len(custs) == 2
        assert all(c.owner_id is None for c in custs)  # 落公海
        assert all(c.created_by == ALICE for c in custs)

    def test_import_creates_primary_contact(self, db_session: Session):
        result = import_customers_to_sea(db_session,
            [_row("带联系人", contact_name="王五", contact_phone="13600000000")], user_id=ALICE)
        assert result["created"] == 1
        cust = db_session.execute(select(CrmCustomer).where(CrmCustomer.name == "带联系人")).scalar_one()
        ct = db_session.execute(select(CrmContact).where(CrmContact.customer_id == cust.id)).scalar_one()
        assert ct.is_primary is True and ct.name == "王五"

    def test_dedup_against_db_by_name_and_phone(self, db_session: Session):
        existing = _seed_customer(db_session, name="已存在", owner_id=None)
        _seed_contact(db_session, existing.id, name="联系人", phone="13500000000")
        db_session.commit()
        result = import_customers_to_sea(db_session,
            [_row("已存在", contact_phone="135-0000-0000")], user_id=ALICE)  # norm 后相同
        assert result["created"] == 0 and result["skipped_dupes"] == 1

    def test_dedup_within_batch(self, db_session: Session):
        result = import_customers_to_sea(db_session,
            [_row("重复甲"), _row("重复甲"), _row("重复甲")], user_id=ALICE)
        assert result["created"] == 1 and result["skipped_dupes"] == 2

    def test_same_name_different_phone_not_dupe(self, db_session: Session):
        existing = _seed_customer(db_session, name="同名公司", owner_id=None)
        _seed_contact(db_session, existing.id, name="c", phone="111")
        db_session.commit()
        result = import_customers_to_sea(db_session,
            [_row("同名公司", contact_phone="222")], user_id=ALICE)  # 电话不同 → 新客户
        assert result["created"] == 1 and result["skipped_dupes"] == 0

    def test_validation_failures_reported_not_inserted(self, db_session: Session):
        rows = [_row(""), _row("坏等级", rating="X"),
                _row("坏邮箱", contact_name="c", contact_email="not-email"), _row("好客户")]
        result = import_customers_to_sea(db_session, rows, user_id=ALICE)
        assert result["created"] == 1 and result["skipped_dupes"] == 0
        assert len(result["failed"]) == 3
        reasons = {(f["row"], f["field"]) for f in result["failed"]}
        assert (1, "name") in reasons and (2, "rating") in reasons and (3, "contact_email") in reasons

    def test_partial_success_single_commit(self, db_session: Session):
        result = import_customers_to_sea(db_session, [_row("成A"), _row(""), _row("成B")], user_id=ALICE)
        assert result["created"] == 2 and len(result["failed"]) == 1
        cnt = db_session.execute(
            select(func.count(CrmCustomer.id)).where(CrmCustomer.is_deleted.is_(False))
        ).scalar_one()
        assert cnt == 2
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd backend && pytest tests/services/crm/test_customer_service.py::TestImportToSea -v` → FAIL（未定义）

- [ ] **Step 3: 新增导入 schema**（`backend/app/schemas/crm.py`，`CustomerUpdate` 后追加；`ConfigDict` 已 import）

```python
class CustomerSeaImportRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None       # 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 代运营/AI运营/运营服务/其他
    rating: str | None = None              # A/B/C/D；None → 默认 C
    status: str | None = None              # active/lost/signed/on_hold；None → active
    source: str | None = None              # referral/exhibition/online_ad/cold_call/other
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None


class CustomerSeaImportRequest(BaseModel):
    rows: list[CustomerSeaImportRow] = Field(min_length=1, max_length=1000)


class CustomerSeaImportFailItem(BaseModel):
    row: int
    field: str | None = None
    reason: str


class CustomerSeaImportResult(BaseModel):
    created: int
    skipped_dupes: int
    failed: list[CustomerSeaImportFailItem]
```

- [ ] **Step 4: 实现导入 service + 辅助**（顶部补 `import re`、`from sqlalchemy import func`（若缺）、`from app.services.crm import audit_service`；文件末尾追加）

```python
# ── 公海批量导入 ─────────────────────────────────────────────────────────────
_RATINGS = {"A", "B", "C", "D"}
_STATUSES = {"active", "lost", "signed", "on_hold"}
_SOURCES = {"referral", "exhibition", "online_ad", "cold_call", "other"}
_CUSTOMER_TYPES = {"工厂", "贸易商", "同行", "其他"}
_INTERESTED_SERVICES = {"代运营", "AI运营", "运营服务", "其他"}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _norm_name(s: str | None) -> str:
    return (s or "").strip()


def _norm_phone(s: str | None) -> str:
    return "".join(ch for ch in (s or "") if ch not in " -")


def _is_email(s: str) -> bool:
    return bool(_EMAIL_RE.match(s))


def _is_duplicate(db: Session, name: str, phone_key: str) -> bool:
    match_ids = [
        r[0] for r in db.execute(
            select(CrmCustomer.id).where(
                CrmCustomer.is_deleted.is_(False),
                func.lower(func.trim(CrmCustomer.name)) == name.lower(),
            )
        ).all()
    ]
    if not match_ids:
        return False
    if not phone_key:
        return True  # 仅按名字：同名即重复
    phones = (
        db.execute(select(CrmContact.phone).where(CrmContact.customer_id.in_(match_ids)))
        .scalars().all()
    )
    return any(_norm_phone(p) == phone_key for p in phones if p)


def import_customers_to_sea(db: Session, rows: list, *, user_id: str | None, commit: bool = True) -> dict:
    cur = _current_user_id(user_id)
    created = 0
    skipped_dupes = 0
    failed: list[dict] = []
    seen_keys: set[tuple[str, str]] = set()

    for idx, row in enumerate(rows, start=1):
        name = _norm_name(row.name)
        if not name:
            failed.append({"row": idx, "field": "name", "reason": "客户名必填"}); continue
        if row.rating and row.rating not in _RATINGS:
            failed.append({"row": idx, "field": "rating", "reason": f"等级无效：{row.rating}"}); continue
        if row.status and row.status not in _STATUSES:
            failed.append({"row": idx, "field": "status", "reason": f"状态无效：{row.status}"}); continue
        if row.source and row.source not in _SOURCES:
            failed.append({"row": idx, "field": "source", "reason": f"来源无效：{row.source}"}); continue
        if row.customer_type and row.customer_type not in _CUSTOMER_TYPES:
            failed.append({"row": idx, "field": "customer_type", "reason": f"对象类型无效：{row.customer_type}"}); continue
        if row.interested_service and row.interested_service not in _INTERESTED_SERVICES:
            failed.append({"row": idx, "field": "interested_service", "reason": f"意向服务无效：{row.interested_service}"}); continue
        if row.contact_email and not _is_email(row.contact_email):
            failed.append({"row": idx, "field": "contact_email", "reason": "邮箱格式不正确"}); continue

        phone_key = _norm_phone(row.contact_phone)
        key = (name.lower(), phone_key)
        if key in seen_keys:
            skipped_dupes += 1; continue
        if _is_duplicate(db, name, phone_key):
            skipped_dupes += 1; seen_keys.add(key); continue
        seen_keys.add(key)

        cust = CrmCustomer(
            name=name, short_name=row.short_name or None, industry=row.industry or None,
            customer_type=row.customer_type or None, interested_service=row.interested_service or None,
            rating=row.rating or "C", status=row.status or "active", source=row.source or None,
            owner_id=None,  # 公海
            address=row.address or None, website=row.website or None,
            annual_revenue=row.annual_revenue, employee_count=row.employee_count,
            remark=row.remark or None, created_by=cur,
        )
        db.add(cust)
        db.flush()

        contact_name = _norm_name(row.contact_name)
        if contact_name:
            contact_service.create_contact(
                db, cust.id,
                ContactCreate(name=contact_name, phone=row.contact_phone or None,
                              email=row.contact_email or None, is_primary=True),
                commit=False,
            )

        audit_service.record_log(db, entity_type="customer", entity_id=cust.id,
                                 action="create", actor_id=cur, summary="公海导入")
        created += 1

    if commit:
        db.commit()
    return {"created": created, "skipped_dupes": skipped_dupes, "failed": failed}
```

- [ ] **Step 5: 跑 service 测试通过** — Run: `cd backend && pytest tests/services/crm/test_customer_service.py -v` → PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/crm.py backend/app/services/crm/customer_service.py \
        backend/tests/services/crm/test_customer_service.py
git commit -m "feat(crm): 公海批量导入客户服务层"
```


---

## Task 3: 后端 — 导入端点 POST /customers/import-sea

**Files:** Modify `backend/app/api/v1/endpoints/crm.py`；Test `backend/tests/api/crm/test_customers_api.py`

**Interfaces:** Consumes Task 2 的 `customer_service.import_customers_to_sea` 与 `CustomerSeaImportRequest/Result`。Produces `POST /api/v1/crm/customers/import-sea` → 200 `CustomerSeaImportResult`；`rows`>1000 → 422；未鉴权 → 401/403。

- [ ] **Step 1: 写失败的 API 测试**（追加到 `test_customers_api.py`）

```python
# ── 公海批量导入 ─────────────────────────────────────────────────────────────
def test_import_sea_requires_auth(client):
    resp = client.post("/api/v1/crm/customers/import-sea", json={"rows": [{"name": "x"}]})
    assert resp.status_code in (401, 403)


def test_import_sea_happy_path(client, admin_headers, test_admin):
    resp = client.post("/api/v1/crm/customers/import-sea", headers=admin_headers,
        json={"rows": [
            {"name": "导入A", "rating": "A"},
            {"name": "导入B", "contact_name": "联系人B", "contact_phone": "13800001111"},
        ]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] == 2 and body["skipped_dupes"] == 0 and body["failed"] == []
    sea = client.get("/api/v1/crm/customers", headers=admin_headers, params={"scope": "sea"}).json()
    names = {c["name"] for c in sea["items"]}
    assert {"导入A", "导入B"} <= names
    b = next(c for c in sea["items"] if c["name"] == "导入B")
    assert b["contact_name"] == "联系人B"


def test_import_sea_partial_and_dedupe(client, admin_headers):
    client.post("/api/v1/crm/customers/import-sea", headers=admin_headers, json={"rows": [{"name": "重复户"}]})
    resp = client.post("/api/v1/crm/customers/import-sea", headers=admin_headers,
        json={"rows": [{"name": "重复户"}, {"name": ""}, {"name": "新户"}]})
    body = resp.json()
    assert body["created"] == 1 and body["skipped_dupes"] == 1 and len(body["failed"]) == 1
    assert body["failed"][0]["field"] == "name"


def test_import_sea_over_1000_rows_rejected(client, admin_headers):
    rows = [{"name": f"c{i}"} for i in range(1001)]
    resp = client.post("/api/v1/crm/customers/import-sea", headers=admin_headers, json={"rows": rows})
    assert resp.status_code == 422
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd backend && pytest tests/api/crm/test_customers_api.py -k import_sea -v` → FAIL（404，`import-sea` 被当 `{customer_id}`）

- [ ] **Step 3: 加端点**（顶部 schema import 补 `CustomerSeaImportRequest, CustomerSeaImportResult`；插在 `create_customer` 端点之后、`@router.get("/customers/{customer_id}")` 之前——参照现有 `/customers/batch-move-sea` 位置）

```python
@router.post("/customers/import-sea", response_model=CustomerSeaImportResult)
def import_customers_to_sea(
    payload: CustomerSeaImportRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return customer_service.import_customers_to_sea(db, payload.rows, user_id=user_id)
```

> 路由顺序关键：必须在 `/customers/{customer_id}` 之前，否则 `import-sea` 被路径参数吞掉。

- [ ] **Step 4: 跑 API 测试通过** — Run: `cd backend && pytest tests/api/crm/test_customers_api.py -v` → PASS

- [ ] **Step 5: 跑整个 CRM 后端无回归** — Run: `cd backend && pytest tests/api/crm tests/services/crm -q` → 全绿

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/endpoints/crm.py backend/tests/api/crm/test_customers_api.py
git commit -m "feat(crm): 新增公海批量导入端点"
```

---

## Task 4: 前端 — 类型 + API client（http/mock）+ dto-mappers

**Files:** Modify `frontend/lib/crm/types/customer.ts`、`frontend/lib/crm/api/{crm-client,dto-mappers,http-crm-client,mock-crm-client}.ts`；Test `frontend/lib/crm/api/dto-mappers.test.ts`

**Interfaces:** Produces 类型 `CustomerSeaImportRow/FailItem/Result`（经 `export * from './customer'` 导出）；`CrmClient.importCustomersToSea(rows): Promise<CustomerSeaImportResult>`；`toImportRowPayload(row)`、`mapImportResult(dto)`；`toCustomerPayload` 携带 contact 字段。

- [ ] **Step 1: 加前端类型**（`frontend/lib/crm/types/customer.ts` 末尾追加）

```ts
/** 公海批量导入：单行（驼峰，前端态）。 */
export interface CustomerSeaImportRow {
  name: string
  shortName?: string
  industry?: string
  customerType?: string
  interestedService?: string
  rating?: string
  status?: string
  source?: string
  address?: string
  website?: string
  annualRevenue?: number
  employeeCount?: number
  remark?: string
  contactName?: string
  contactPhone?: string
  contactEmail?: string
}

export interface CustomerSeaImportFailItem {
  row: number
  field?: string
  reason: string
}

export interface CustomerSeaImportResult {
  created: number
  skippedDupes: number
  failed: CustomerSeaImportFailItem[]
}
```

- [ ] **Step 2: 接口加方法**（`crm-client.ts` 顶部 type import 补 `CustomerSeaImportRow, CustomerSeaImportResult`；`CrmClient` 接口 `claimFromSea` 后加）

```ts
  importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult>
```

- [ ] **Step 3: 写失败的 dto-mappers 测试**（`dto-mappers.test.ts`：把原「toCustomerPayload 剔除 contact 展示字段」用例替换为携带 contact；顶部 import 补 `toImportRowPayload`）

```ts
  it('toCustomerPayload 携带 contact 字段（修复丢失联系人）', () => {
    const p = toCustomerPayload({ name: 'X', contactName: '张三', contactPhone: '138', contactEmail: 'a@b.com' })
    expect(p.contact_name).toBe('张三')
    expect(p.contact_phone).toBe('138')
    expect(p.contact_email).toBe('a@b.com')
  })

  it('toImportRowPayload 驼峰转下划线并剔除 undefined', () => {
    const p = toImportRowPayload({ name: '导入户', rating: 'A', customerType: '工厂', contactName: '李四', annualRevenue: 1000 })
    expect(p).toEqual({ name: '导入户', rating: 'A', customer_type: '工厂', contact_name: '李四', annual_revenue: 1000 })
    expect(p).not.toHaveProperty('short_name')
  })
```

- [ ] **Step 4: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run lib/crm/api/dto-mappers.test.ts` → FAIL

- [ ] **Step 5: 改 dto-mappers**（顶部 type import 补 `CustomerSeaImportRow, CustomerSeaImportResult`；替换 `toCustomerPayload` 并新增两函数）

```ts
/** 客户创建/更新入参。contact* 入站（后端建主联系人，修复丢失联系人 bug）。 */
export function toCustomerPayload(input: Partial<CustomerInput>): Record<string, unknown> {
  return stripUndefined({
    name: input.name, short_name: input.shortName, industry: input.industry,
    customer_type: input.customerType, interested_service: input.interestedService,
    rating: input.rating, status: input.status, source: input.source, owner_id: input.ownerId,
    address: input.address, website: input.website, annual_revenue: input.annualRevenue,
    employee_count: input.employeeCount, remark: input.remark,
    contact_name: input.contactName, contact_phone: input.contactPhone, contact_email: input.contactEmail,
  })
}

/** 公海导入单行入参（驼峰→下划线，剔 undefined）。 */
export function toImportRowPayload(row: CustomerSeaImportRow): Record<string, unknown> {
  return stripUndefined({
    name: row.name, short_name: row.shortName, industry: row.industry,
    customer_type: row.customerType, interested_service: row.interestedService,
    rating: row.rating, status: row.status, source: row.source, address: row.address,
    website: row.website, annual_revenue: row.annualRevenue, employee_count: row.employeeCount,
    remark: row.remark, contact_name: row.contactName, contact_phone: row.contactPhone,
    contact_email: row.contactEmail,
  })
}

/** 导入结果 DTO（下划线）→ 前端（驼峰）。 */
export function mapImportResult(dto: {
  created: number
  skipped_dupes: number
  failed: Array<{ row: number; field?: string | null; reason: string }>
}): CustomerSeaImportResult {
  return {
    created: dto.created,
    skippedDupes: dto.skipped_dupes,
    failed: dto.failed.map((f) => ({ row: f.row, field: f.field ?? undefined, reason: f.reason })),
  }
}
```

- [ ] **Step 6: 跑测试通过** — Run: `cd frontend && pnpm vitest run lib/crm/api/dto-mappers.test.ts` → PASS

- [ ] **Step 7: 实现 http client**（`http-crm-client.ts` 顶部 type import 补 `CustomerSeaImportRow, CustomerSeaImportResult`；dto-mappers import 补 `toImportRowPayload, mapImportResult`；`claimFromSea` 后加）

```ts
  async importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult> {
    const dto = await request<{
      created: number
      skipped_dupes: number
      failed: Array<{ row: number; field?: string | null; reason: string }>
    }>('/customers/import-sea', {
      method: 'POST',
      body: JSON.stringify({ rows: rows.map(toImportRowPayload) }),
    })
    return mapImportResult(dto)
  }
```

- [ ] **Step 8: 实现 mock client**（`mock-crm-client.ts` 顶部 type import 补 `CustomerSeaImportRow, CustomerSeaImportResult, CustomerSeaImportFailItem`；customer 区块加。id 生成参照文件内 `createCustomer` 现有计数器，下例用 `this.nextCustomerId`，若不同请替换）

```ts
  async importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult> {
    let created = 0
    let skippedDupes = 0
    const failed: CustomerSeaImportFailItem[] = []
    const seen = new Set<string>()
    const normPhone = (s?: string) => (s ?? '').replace(/[ -]/g, '')
    rows.forEach((row, i) => {
      const name = (row.name ?? '').trim()
      if (!name) { failed.push({ row: i + 1, field: 'name', reason: '客户名必填' }); return }
      const key = `${name.toLowerCase()}|${normPhone(row.contactPhone)}`
      const dup = seen.has(key) ||
        this.customers.some((c) => c.name.trim().toLowerCase() === name.toLowerCase() && !c.ownerId)
      if (dup) { skippedDupes += 1; seen.add(key); return }
      seen.add(key)
      const id = String(this.nextCustomerId++)
      const now = new Date().toISOString()
      this.customers.push({
        id, name, shortName: row.shortName, industry: row.industry,
        customerType: row.customerType, interestedService: row.interestedService,
        rating: (row.rating as Customer['rating']) ?? 'C',
        status: (row.status as Customer['status']) ?? 'active',
        source: (row.source as Customer['source']) ?? 'other',
        ownerId: null, contactName: row.contactName, contactPhone: row.contactPhone,
        contactEmail: row.contactEmail, address: row.address, website: row.website,
        annualRevenue: row.annualRevenue, employeeCount: row.employeeCount, remark: row.remark,
        createdBy: 'current-user', createdAt: now, updatedAt: now,
      })
      created += 1
    })
    return { created, skippedDupes, failed }
  }
```

- [ ] **Step 9: 跑前端测试 + 类型检查** — Run: `cd frontend && pnpm vitest run lib/crm/api && pnpm tsc --noEmit` → PASS / 无类型错误

- [ ] **Step 10: Commit**

```bash
git add frontend/lib/crm/types/customer.ts frontend/lib/crm/api/crm-client.ts \
        frontend/lib/crm/api/dto-mappers.ts frontend/lib/crm/api/dto-mappers.test.ts \
        frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/api/mock-crm-client.ts
git commit -m "feat(crm): 公海导入前端类型与 API 客户端"
```


---

## Task 5: 前端 — 列定义 + 解析/校验（parse.ts）

**Files:** Create `frontend/lib/crm/constants/import-columns.ts`、`frontend/components/crm/crm-import-sea/{types.ts,parse.ts,parse.test.ts}`

**Interfaces:** Produces `CRM_IMPORT_COLUMNS: ImportColumnDef[]`（16 列）、枚举反查常量、`parseTsv(text): string[][]`、`rowsFromGrid(grid): {rows, missingName}`、`validateRows(rows): RowIssue[]`；`RowIssue = {row, level:'error'|'warn', field?, message}`。

- [ ] **Step 1: 写列定义常量**（Create `frontend/lib/crm/constants/import-columns.ts`）

```ts
import type { CustomerSeaImportRow } from '@/lib/crm/types'

export interface ImportColumnDef {
  header: string
  field: keyof CustomerSeaImportRow
  required?: boolean
  hint?: string
}

/** 导入模板/解析共用的 16 列（顺序即模板列序）。 */
export const CRM_IMPORT_COLUMNS: ImportColumnDef[] = [
  { header: '客户名', field: 'name', required: true },
  { header: '简称', field: 'shortName' },
  { header: '行业', field: 'industry' },
  { header: '对象类型', field: 'customerType', hint: '工厂/贸易商/同行/其他' },
  { header: '意向服务', field: 'interestedService', hint: '代运营/AI运营/运营服务/其他' },
  { header: '等级', field: 'rating', hint: 'A/B/C/D' },
  { header: '状态', field: 'status', hint: '活跃/已流失/已签约/暂缓' },
  { header: '来源', field: 'source', hint: '转介绍/展会/线上广告/陌拜/其他' },
  { header: '联系人', field: 'contactName' },
  { header: '联系电话', field: 'contactPhone' },
  { header: '联系邮箱', field: 'contactEmail' },
  { header: '地址', field: 'address' },
  { header: '网站', field: 'website' },
  { header: '年营收', field: 'annualRevenue', hint: '数字' },
  { header: '员工数', field: 'employeeCount', hint: '整数' },
  { header: '备注', field: 'remark' },
]

export const STATUS_LABEL_TO_VALUE: Record<string, string> = {
  活跃: 'active', 已流失: 'lost', 已签约: 'signed', 暂缓: 'on_hold',
}
export const SOURCE_LABEL_TO_VALUE: Record<string, string> = {
  转介绍: 'referral', 展会: 'exhibition', 线上广告: 'online_ad', 陌拜: 'cold_call', 其他: 'other',
}
export const RATING_VALUES = new Set(['A', 'B', 'C', 'D'])
export const STATUS_VALUES = new Set(['active', 'lost', 'signed', 'on_hold'])
export const SOURCE_VALUES = new Set(['referral', 'exhibition', 'online_ad', 'cold_call', 'other'])
export const CUSTOMER_TYPE_VALUES = new Set(['工厂', '贸易商', '同行', '其他'])
export const INTERESTED_SERVICE_VALUES = new Set(['代运营', 'AI运营', '运营服务', '其他'])
```

- [ ] **Step 2: 写组件本地类型**（Create `frontend/components/crm/crm-import-sea/types.ts`）

```ts
import type { CustomerSeaImportRow, CustomerSeaImportResult } from '@/lib/crm/types'

export type { CustomerSeaImportRow, CustomerSeaImportResult }

export type RowLevel = 'error' | 'warn'

export interface RowIssue {
  row: number // 1-based
  level: RowLevel
  field?: string
  message: string
}

export type ImportStep = 'input' | 'preview' | 'result'
```

- [ ] **Step 3: 写失败的 parse 测试**（Create `frontend/components/crm/crm-import-sea/parse.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { parseTsv, rowsFromGrid, validateRows } from './parse'

describe('parseTsv', () => {
  it('按 tab 分列、换行分行，去空行', () => {
    expect(parseTsv('客户名\t等级\n甲公司\tA\n乙公司\tB\n')).toEqual([
      ['客户名', '等级'], ['甲公司', 'A'], ['乙公司', 'B'],
    ])
  })
})

describe('rowsFromGrid', () => {
  it('按中文表头映射 + 枚举标签转值', () => {
    const { rows, missingName } = rowsFromGrid([
      ['客户名', '状态', '来源', '等级', '对象类型'],
      ['甲公司', '活跃', '转介绍', 'A 级（高价值）', '工厂'],
    ])
    expect(missingName).toBe(false)
    expect(rows[0]).toMatchObject({ name: '甲公司', status: 'active', source: 'referral', rating: 'A', customerType: '工厂' })
  })
  it('缺客户名列 → missingName=true', () => {
    expect(rowsFromGrid([['简称'], ['x']]).missingName).toBe(true)
  })
  it('数字列转 number', () => {
    const { rows } = rowsFromGrid([['客户名', '年营收', '员工数'], ['甲', '1000', '50']])
    expect(rows[0].annualRevenue).toBe(1000)
    expect(rows[0].employeeCount).toBe(50)
  })
})

describe('validateRows', () => {
  it('缺名/非法枚举 → error；有电话无联系人 → warn', () => {
    const issues = validateRows([{ name: '' }, { name: '坏等级', rating: 'X' }, { name: '好', contactPhone: '138' }])
    expect(issues).toContainEqual({ row: 1, level: 'error', field: 'name', message: '客户名必填' })
    expect(issues.some((i) => i.row === 2 && i.field === 'rating' && i.level === 'error')).toBe(true)
    expect(issues.some((i) => i.row === 3 && i.level === 'warn')).toBe(true)
  })
})
```

- [ ] **Step 4: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/parse.test.ts` → FAIL（`./parse` 不存在）

- [ ] **Step 5: 实现 parse.ts**（Create `frontend/components/crm/crm-import-sea/parse.ts`）

```ts
import type { CustomerSeaImportRow } from '@/lib/crm/types'
import {
  CRM_IMPORT_COLUMNS, CUSTOMER_TYPE_VALUES, INTERESTED_SERVICE_VALUES, RATING_VALUES,
  SOURCE_LABEL_TO_VALUE, SOURCE_VALUES, STATUS_LABEL_TO_VALUE, STATUS_VALUES,
} from '@/lib/crm/constants/import-columns'
import type { RowIssue } from './types'

/** 解析 Excel 复制出的 TSV：\n 分行、\t 分列，丢弃全空行。 */
export function parseTsv(text: string): string[][] {
  return text.replace(/\r\n?/g, '\n').split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((c) => c.trim()))
}

function mapEnum(field: string, raw: string): string | undefined {
  const v = raw.trim()
  if (!v) return undefined
  if (field === 'status') return STATUS_LABEL_TO_VALUE[v] ?? v
  if (field === 'source') return SOURCE_LABEL_TO_VALUE[v] ?? v
  if (field === 'rating') {
    const first = v.slice(0, 1).toUpperCase()
    return RATING_VALUES.has(first) ? first : v
  }
  return v
}

/** 二维网格（首行表头）→ 导入行。按中文表头名匹配，缺列留空，多余列忽略。 */
export function rowsFromGrid(grid: string[][]): { rows: CustomerSeaImportRow[]; missingName: boolean } {
  if (grid.length === 0) return { rows: [], missingName: true }
  const header = grid[0].map((h) => h.trim())
  const colIndex = new Map<string, number>()
  CRM_IMPORT_COLUMNS.forEach((def) => {
    const i = header.indexOf(def.header)
    if (i >= 0) colIndex.set(def.field as string, i)
  })
  const missingName = !colIndex.has('name')
  const rows: CustomerSeaImportRow[] = grid.slice(1).map((cells) => {
    const row: Record<string, unknown> = {}
    CRM_IMPORT_COLUMNS.forEach((def) => {
      const i = colIndex.get(def.field as string)
      if (i === undefined) return
      const raw = (cells[i] ?? '').trim()
      if (!raw) return
      const field = def.field as string
      if (field === 'annualRevenue' || field === 'employeeCount') {
        const n = Number(raw)
        if (Number.isFinite(n)) row[field] = n
      } else if (field === 'status' || field === 'source' || field === 'rating') {
        row[field] = mapEnum(field, raw)
      } else {
        row[field] = raw
      }
    })
    return row as unknown as CustomerSeaImportRow
  })
  return { rows, missingName }
}

/** 逐行校验：error 阻止导入，warn 仅提示。重复由后端判，前端不查。 */
export function validateRows(rows: CustomerSeaImportRow[]): RowIssue[] {
  const issues: RowIssue[] = []
  rows.forEach((row, i) => {
    const rowNo = i + 1
    if (!(row.name ?? '').trim()) issues.push({ row: rowNo, level: 'error', field: 'name', message: '客户名必填' })
    if (row.rating && !RATING_VALUES.has(row.rating)) issues.push({ row: rowNo, level: 'error', field: 'rating', message: `等级无效：${row.rating}` })
    if (row.status && !STATUS_VALUES.has(row.status)) issues.push({ row: rowNo, level: 'error', field: 'status', message: `状态无效：${row.status}` })
    if (row.source && !SOURCE_VALUES.has(row.source)) issues.push({ row: rowNo, level: 'error', field: 'source', message: `来源无效：${row.source}` })
    if (row.customerType && !CUSTOMER_TYPE_VALUES.has(row.customerType)) issues.push({ row: rowNo, level: 'error', field: 'customerType', message: `对象类型无效：${row.customerType}` })
    if (row.interestedService && !INTERESTED_SERVICE_VALUES.has(row.interestedService)) issues.push({ row: rowNo, level: 'error', field: 'interestedService', message: `意向服务无效：${row.interestedService}` })
    if (row.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.contactEmail)) issues.push({ row: rowNo, level: 'error', field: 'contactEmail', message: '邮箱格式不正确' })
    if (!(row.contactName ?? '').trim() && ((row.contactPhone ?? '').trim() || (row.contactEmail ?? '').trim()))
      issues.push({ row: rowNo, level: 'warn', message: '无联系人姓名，电话/邮箱将不保存' })
  })
  return issues
}
```

- [ ] **Step 6: 跑测试通过** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/parse.test.ts` → PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/crm/constants/import-columns.ts frontend/components/crm/crm-import-sea/types.ts \
        frontend/components/crm/crm-import-sea/parse.ts frontend/components/crm/crm-import-sea/parse.test.ts
git commit -m "feat(crm): 公海导入列定义与解析校验"
```

---

## Task 6: 前端 — 模板与失败明细（exceljs）

**Files:** Create `frontend/components/crm/crm-import-sea/{template.ts,template.test.ts}`

**Interfaces:** Produces `buildTemplateWorkbook(): Promise<Workbook>`（表头+灰字提示行+2 行示例）、`downloadImportTemplate()`、`buildFailureWorkbook(failed, rows)`（16 列+错因）、`downloadFailureDetail(failed, rows)`。

- [ ] **Step 1: 写失败的 template 测试**（Create `frontend/components/crm/crm-import-sea/template.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { buildTemplateWorkbook, buildFailureWorkbook } from './template'
import { CRM_IMPORT_COLUMNS } from '@/lib/crm/constants/import-columns'

describe('buildTemplateWorkbook', () => {
  it('首行表头为 16 列中文', async () => {
    const wb = await buildTemplateWorkbook()
    const header = wb.worksheets[0].getRow(1).values as unknown as string[]
    // exceljs row.values 索引 0 为空，表头从索引 1 开始
    CRM_IMPORT_COLUMNS.forEach((def, i) => expect(header[i + 1]).toBe(def.header))
  })
})

describe('buildFailureWorkbook', () => {
  it('含 16 列 + 错因列，按 failed 行号回填', async () => {
    const rows = [{ name: '甲' }, { name: '' }]
    const failed = [{ row: 2, field: 'name', reason: '客户名必填' }]
    const wb = await buildFailureWorkbook(failed, rows)
    const sheet = wb.worksheets[0]
    const header = sheet.getRow(1).values as unknown as string[]
    expect(header[header.length - 1]).toBe('错因')
    const dataRow = sheet.getRow(2).values as unknown as string[]
    expect(dataRow[dataRow.length - 1]).toBe('客户名必填')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/template.test.ts` → FAIL

- [ ] **Step 3: 实现 template.ts**（Create `frontend/components/crm/crm-import-sea/template.ts`；顶部 `import type ExcelJS from 'exceljs'`，运行时动态 `import('exceljs')`，与仓库现有范式一致）

```ts
import type ExcelJS from 'exceljs'
import { CRM_IMPORT_COLUMNS } from '@/lib/crm/constants/import-columns'
import type { CustomerSeaImportFailItem, CustomerSeaImportRow } from '@/lib/crm/types'

const HEADERS = CRM_IMPORT_COLUMNS.map((c) => c.header)

function triggerDownload(buffer: ExcelJS.Buffer, filename: string): void {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 导入模板：表头 + 灰字提示行 + 2 行示例。 */
export async function buildTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const Lib = await import('exceljs')
  const wb = new Lib.Workbook()
  const sheet = wb.addWorksheet('客户导入')
  sheet.addRow(HEADERS)
  const hintRow = sheet.addRow(CRM_IMPORT_COLUMNS.map((c) => c.hint ?? ''))
  hintRow.eachCell((cell) => { cell.font = { color: { argb: 'FF9CA3AF' }, italic: true } })
  sheet.addRow(['示例科技有限公司', '示例', '家居', '工厂', '代运营', 'B', '活跃', '转介绍', '张三', '13800000000', 'zhang@example.com', '深圳市南山区', 'https://example.com', '5000000', '120', '示例备注'])
  sheet.addRow(['另一家公司', '', '美妆', '贸易商', 'AI运营', 'A', '已签约', '展会', '李四', '13900000000', '', '', '', '', '', ''])
  return wb
}

export async function downloadImportTemplate(): Promise<void> {
  const wb = await buildTemplateWorkbook()
  triggerDownload(await wb.xlsx.writeBuffer(), '客户导入模板.xlsx')
}

/** 失败明细：16 列 + 错因，按 failed 行号（1-based）回填原始行。 */
export async function buildFailureWorkbook(
  failed: CustomerSeaImportFailItem[],
  rows: CustomerSeaImportRow[]
): Promise<ExcelJS.Workbook> {
  const Lib = await import('exceljs')
  const wb = new Lib.Workbook()
  const sheet = wb.addWorksheet('导入失败明细')
  sheet.addRow([...HEADERS, '错因'])
  failed.forEach((f) => {
    const src = (rows[f.row - 1] ?? {}) as Record<string, unknown>
    const cells: unknown[] = CRM_IMPORT_COLUMNS.map((c) => src[c.field as string] ?? '')
    cells.push(f.reason)
    sheet.addRow(cells)
  })
  return wb
}

export async function downloadFailureDetail(
  failed: CustomerSeaImportFailItem[],
  rows: CustomerSeaImportRow[]
): Promise<void> {
  const wb = await buildFailureWorkbook(failed, rows)
  triggerDownload(await wb.xlsx.writeBuffer(), '客户导入失败明细.xlsx')
}
```

- [ ] **Step 4: 跑测试通过** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/template.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/components/crm/crm-import-sea/template.ts frontend/components/crm/crm-import-sea/template.test.ts
git commit -m "feat(crm): 公海导入模板与失败明细导出"
```


---

## Task 7: 前端 — CrmImportSea 组件 + 公海页入口 + barrel

**Files:** Create `frontend/components/crm/crm-import-sea/{index.tsx,index.test.tsx}`；Modify `frontend/app/dashboard/crm/sea/page.tsx`、`frontend/components/crm/index.ts`

**Interfaces:** Consumes Task 4 `useCrmClient().importCustomersToSea`、Task 5 `parseTsv/rowsFromGrid/validateRows`、Task 6 `downloadImportTemplate/downloadFailureDetail`。Produces `CrmImportSea({open, onOpenChange, onImported})` 三步 Sheet；公海页「导入客户」按钮。

- [ ] **Step 1: 写失败的组件测试**（Create `frontend/components/crm/crm-import-sea/index.test.tsx`）

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmImportSea } from './index'

const importMock = vi.fn()
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ importCustomersToSea: importMock }),
}))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('./template', () => ({ downloadImportTemplate: vi.fn(), downloadFailureDetail: vi.fn() }))

describe('CrmImportSea', () => {
  it('粘贴 TSV → 预览 → 导入成功显示计数', async () => {
    importMock.mockResolvedValue({ created: 2, skippedDupes: 0, failed: [] })
    render(<CrmImportSea open onOpenChange={() => {}} onImported={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: '粘贴' }))
    fireEvent.change(screen.getByPlaceholderText(/从 Excel 复制/), {
      target: { value: '客户名\t等级\n甲公司\tA\n乙公司\tB' },
    })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByText(/共 2 行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/成功 2/)).toBeTruthy()
  })

  it('缺客户名列 → 提示无法解析', async () => {
    render(<CrmImportSea open onOpenChange={() => {}} onImported={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: '粘贴' }))
    fireEvent.change(screen.getByPlaceholderText(/从 Excel 复制/), { target: { value: '简称\nx' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByText(/缺少「客户名」列/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/index.test.tsx` → FAIL（`./index` 不存在）

- [ ] **Step 3: 实现组件**（Create `frontend/components/crm/crm-import-sea/index.tsx`）

```tsx
'use client'

import { useMemo, useState } from 'react'
import { Download, FileUp, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import type { CustomerSeaImportRow, CustomerSeaImportResult } from '@/lib/crm/types'
import { parseTsv, rowsFromGrid, validateRows } from './parse'
import { downloadFailureDetail, downloadImportTemplate } from './template'
import type { ImportStep, RowIssue } from './types'

export interface CrmImportSeaProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported?: () => void
}

export function CrmImportSea({ open, onOpenChange, onImported }: CrmImportSeaProps) {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const [step, setStep] = useState<ImportStep>('input')
  const [pasteText, setPasteText] = useState('')
  const [rows, setRows] = useState<CustomerSeaImportRow[]>([])
  const [issues, setIssues] = useState<RowIssue[]>([])
  const [missingName, setMissingName] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CustomerSeaImportResult | null>(null)

  const errorRows = useMemo(
    () => new Set(issues.filter((i) => i.level === 'error').map((i) => i.row)),
    [issues]
  )
  const validRows = useMemo(() => rows.filter((_, i) => !errorRows.has(i + 1)), [rows, errorRows])

  function reset() {
    setStep('input'); setPasteText(''); setRows([]); setIssues([]); setMissingName(false); setResult(null)
  }

  function applyGrid(grid: string[][]) {
    const parsed = rowsFromGrid(grid)
    setMissingName(parsed.missingName)
    setRows(parsed.rows)
    setIssues(validateRows(parsed.rows))
    if (!parsed.missingName) setStep('preview')
  }

  async function handleFile(file: File) {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    const sheet = wb.worksheets[0]
    if (!sheet) return
    const grid: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      grid.push((row.values as unknown[]).slice(1).map((v) => String(v ?? '')))
    })
    applyGrid(grid)
  }

  function removeRow(idx: number) {
    const next = rows.filter((_, i) => i !== idx)
    setRows(next); setIssues(validateRows(next))
  }

  async function handleConfirm() {
    setSubmitting(true)
    try {
      const res = await client.importCustomersToSea(validRows)
      setResult(res)
      setStep('result')
      if (res.created > 0) {
        notify({ type: 'success', title: '导入完成', message: `成功导入 ${res.created} 个客户到公海` })
        onImported?.()
      }
    } catch (e) {
      notify({ type: 'error', title: '导入失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset() }}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle>导入客户到公海</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 'input' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">粘贴 Excel 复制的内容，或上传 .xlsx 文件。导入的客户进入公海，全员可领取。</p>
                <Button variant="outline" size="sm" onClick={() => void downloadImportTemplate()}>
                  <Download className="mr-1 h-4 w-4" /> 下载模板
                </Button>
              </div>
              <Tabs defaultValue="paste">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="paste">粘贴</TabsTrigger>
                  <TabsTrigger value="upload">上传 Excel</TabsTrigger>
                </TabsList>
                <TabsContent value="paste" className="space-y-3">
                  <Textarea
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="从 Excel 复制若干行（含表头「客户名」等）粘贴到此处…"
                  />
                  <Button onClick={() => applyGrid(parseTsv(pasteText))} disabled={!pasteText.trim()}>
                    下一步
                  </Button>
                </TabsContent>
                <TabsContent value="upload" className="space-y-3">
                  <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground hover:bg-muted/40">
                    <Upload className="h-6 w-6" />
                    <span>点击选择 .xlsx / .xls 文件</span>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
                    />
                  </label>
                </TabsContent>
              </Tabs>
              {missingName && (
                <p className="text-sm text-rose-600" role="alert">缺少「客户名」列，无法解析，请检查表头。</p>
              )}
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-3">
              <p className="text-sm">
                共 {rows.length} 行 · {errorRows.size} 行有误
                {errorRows.size > 0 && <span className="ml-1 text-muted-foreground">（确认导入将跳过错误行）</span>}
              </p>
              <div className="max-h-80 overflow-auto rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">客户名</th>
                      <th className="px-2 py-1 text-left">等级</th>
                      <th className="px-2 py-1 text-left">联系人</th>
                      <th className="px-2 py-1 text-left">状态</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const rowIssues = issues.filter((x) => x.row === i + 1)
                      const err = rowIssues.find((x) => x.level === 'error')
                      const warn = rowIssues.find((x) => x.level === 'warn')
                      return (
                        <tr key={i} className={err ? 'bg-rose-50 dark:bg-rose-950/30' : undefined}>
                          <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                          <td className="px-2 py-1">{r.name || <span className="text-rose-600">（空）</span>}</td>
                          <td className="px-2 py-1">{r.rating ?? '-'}</td>
                          <td className="px-2 py-1">{r.contactName ?? '-'}</td>
                          <td className="px-2 py-1">
                            {err ? <span className="text-rose-600">{err.message}</span>
                              : warn ? <span className="text-amber-600">{warn.message}</span>
                              : <span className="text-emerald-600">✓</span>}
                          </td>
                          <td className="px-2 py-1">
                            <button type="button" className="text-xs text-muted-foreground hover:text-rose-600" onClick={() => removeRow(i)}>删除</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('input')}>返回</Button>
                <Button onClick={() => void handleConfirm()} disabled={submitting || validRows.length === 0}>
                  {submitting ? '导入中…' : `确认导入（${validRows.length}）`}
                </Button>
              </div>
            </div>
          )}

          {step === 'result' && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FileUp className="h-5 w-5 text-emerald-600" />
                <p className="text-sm">
                  成功 {result.created} · 跳过 {result.skippedDupes}（已存在）· 失败 {result.failed.length}
                </p>
              </div>
              {result.failed.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => void downloadFailureDetail(result.failed, rows)}>
                  <Download className="mr-1 h-4 w-4" /> 下载失败明细
                </Button>
              )}
              <div className="flex justify-end">
                <Button onClick={() => { reset(); onOpenChange(false) }}>完成</Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 4: 跑组件测试通过** — Run: `cd frontend && pnpm vitest run components/crm/crm-import-sea/index.test.tsx` → PASS

- [ ] **Step 5: barrel 导出**（`frontend/components/crm/index.ts` 末尾追加）

```ts
export { CrmImportSea } from './crm-import-sea'
export type { CrmImportSeaProps } from './crm-import-sea'
```

- [ ] **Step 6: 公海页加入口**（`frontend/app/dashboard/crm/sea/page.tsx` 改为 client 组件并加按钮）

```tsx
'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import { CrmSeaTable } from '@/components/crm/sea-table'
import { CrmImportSea } from '@/components/crm'
import { Button } from '@/components/ui/button'

export default function SeaPage() {
  const [importOpen, setImportOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">客户公海</h1>
          <p className="text-sm text-muted-foreground">无人认领的客户，可一键领取或批量导入</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="mr-1 h-4 w-4" /> 导入客户
        </Button>
      </div>
      <CrmSeaTable key={refreshKey} />
      <CrmImportSea open={importOpen} onOpenChange={setImportOpen} onImported={() => setRefreshKey((k) => k + 1)} />
    </div>
  )
}
```

> `CrmSeaTable` 用 `key={refreshKey}` 强制重挂载以刷新（其内部无 refreshKey prop）。若后续给 sea-table 加 refreshKey prop，可改用之。

- [ ] **Step 7: 跑前端全门禁** — Run: `cd frontend && pnpm lint && pnpm build && pnpm test` → 全绿

- [ ] **Step 8: Commit**

```bash
git add frontend/components/crm/crm-import-sea/index.tsx frontend/components/crm/crm-import-sea/index.test.tsx \
        frontend/app/dashboard/crm/sea/page.tsx frontend/components/crm/index.ts
git commit -m "feat(crm): 公海导入客户弹窗与页面入口"
```

---

## 最终验收

- [ ] 后端 CRM 全绿：`cd backend && pytest tests/api/crm tests/services/crm -q`
- [ ] 前端全绿：`cd frontend && pnpm lint && pnpm build && pnpm test`
- [ ] 推送部署：`git deploy`（命中 backend/ 自动部署 VPS；前端 Vercel 自动）
- [ ] 业务验收（交用户手动）：① 公海页「导入客户」→ 粘贴 3 行 → 预览 → 导入成功且公海可见可领取 ② 下载模板、填好上传导入 ③ 重复导入跳过 ④ 坏行下载失败明细 ⑤ 单条新建客户后联系人 Tab 有联系人（bug 修复）

---

## Self-Review

**1. Spec 覆盖**：
- §5.1 端点 → Task 3 ✓；§5.2 schema → Task 2 ✓；§5.3 service（校验/去重/插入/联系人/审计/单 commit）→ Task 2 ✓；§5.4 零迁移 → Global Constraints ✓
- §6.1 列定义/枚举反查 → Task 5 ✓；§6.2 三步组件/模板/预览/结果/失败明细 → Task 6+7 ✓；§6.3 入口 → Task 7 ✓；§6.4 API client（http+mock）→ Task 4 ✓
- §7 联系人 bug 修复 → Task 1（后端）+ Task 4（前端 payload）✓
- §8 测试 → 各 Task 内嵌 ✓；§9 门禁部署 → 最终验收 ✓

**2. 占位符扫描**：无 TBD/TODO；每个 code step 均有完整代码。mock client 的 `this.nextCustomerId` 已注明「参照文件内 createCustomer 现有计数器，若不同请替换」——这是因 mock 内部 id 计数器命名未在本计划中固定，属可接受的实现指引（非占位）。

**3. 类型一致性**：`CustomerSeaImportRow/Result/FailItem`（Task 4 定义）在 Task 5/6/7 一致引用；`importCustomersToSea` 签名前后端一致；`toImportRowPayload/mapImportResult`（Task 4）被 http client（Task 4）使用；`parseTsv/rowsFromGrid/validateRows`（Task 5）被组件（Task 7）使用；`downloadImportTemplate/downloadFailureDetail`（Task 6）被组件（Task 7）使用。后端 `import_customers_to_sea` 返回 dict 键 `created/skipped_dupes/failed` 与 `CustomerSeaImportResult` schema 一致。
