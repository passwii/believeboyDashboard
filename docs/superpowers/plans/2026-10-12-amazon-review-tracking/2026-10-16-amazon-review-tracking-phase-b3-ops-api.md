# 阶段 B3：运营 API 与整合

> 父计划：[阶段 B 总览](./2026-10-16-amazon-review-tracking-phase-b.md) · 设计：[B 规格](../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md) §5、§6
> 依赖：B1（表）、B2（写入服务不用于本册，但整合验证会引用）。

**Files（本册涉及）：**
- Modify: `backend/app/schemas/amazon_review_tracking.py`（追加响应/请求 schema）
- Create: `backend/app/services/amazon_review_external_service.py`
- Modify: `backend/app/api/v1/endpoints/amazon_review_tracking.py`（追加路由 + 拆分会话/管理员依赖）
- Test: `backend/tests/api/test_amazon_review_ops.py`（新建）
- Test: `backend/tests/api/test_amazon_review_external.py`（新建）

---

## Task 4：运营只读查询 API

- [ ] **步骤 1：写失败测试**

创建 `backend/tests/api/test_amazon_review_ops.py`：

```python
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import AmazonReviewTarget
from app.services.amazon_review_ingestion_service import RatingCapture, ReviewCapture, record_crawl_result
from app.services.amazon_review_tracking_service import create_group


def _seed_target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(project_id=project.id, project_name=project.project_name,
        sku=f"ops-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=930000, is_active=True)
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US",
        name=f"Ops-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = db_session.execute(select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)).scalar_one()
    record_crawl_result(db_session, target_id=target.id, captured_at=datetime(2026, 10, 21, tzinfo=timezone.utc),
        status="success", rating=RatingCapture(average_rating=4.1, rating_count=9),
        reviews=[ReviewCapture(review_key="R1", id_confidence="original", rating=4, title="t")],
        is_complete_list=True)
    db_session.flush()
    return target


def test_list_targets_filters_by_group_and_kind(client, admin_headers, db_session):
    target = _seed_target(db_session)
    resp = client.get("/api/v1/amazon-review-tracking/targets", params={"kind": "internal_group"}, headers=admin_headers)
    assert resp.status_code == 200
    assert any(item["id"] == target.id for item in resp.json())


def test_rating_snapshots_and_reviews_and_runs(client, admin_headers, db_session):
    target = _seed_target(db_session)
    snaps = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/rating-snapshots",
                       params={"from": "2026-10-01", "to": "2026-10-31"}, headers=admin_headers)
    assert snaps.status_code == 200 and len(snaps.json()) == 1
    assert snaps.json()[0]["average_rating"] == 4.1

    reviews = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/reviews", headers=admin_headers)
    assert reviews.status_code == 200 and reviews.json()[0]["review_key"] == "R1"

    runs = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/runs", headers=admin_headers)
    assert runs.status_code == 200 and runs.json()[0]["status"] == "success"


def test_unknown_target_returns_404_and_requires_session(client, admin_headers):
    assert client.get("/api/v1/amazon-review-tracking/targets/999999999/reviews", headers=admin_headers).status_code == 404
    assert client.get("/api/v1/amazon-review-tracking/targets").status_code == 401
```

> 说明：`client` / `admin_headers` / `db_session` 沿用 `backend/tests/conftest.py` 既有 fixture（同阶段 A API 测试）。

- [ ] **步骤 2：运行确认失败**

运行：`cd backend && pytest tests/api/test_amazon_review_ops.py -q`
预期：FAIL——`404`（路由未注册）。

- [ ] **步骤 3：实现 schema**

在 `backend/app/schemas/amazon_review_tracking.py` 顶部补 `from datetime import date, datetime`，末尾追加：

```python
class TargetItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    kind: str
    group_id: int | None
    project_id: int | None
    marketplace: str
    asin: str | None
    display_name: str | None
    is_active: bool


class RatingSnapshotItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    capture_date: date
    captured_at: datetime
    average_rating: float | None
    rating_count: int | None
    review_count: int | None
    star_1_percentage: float | None
    star_2_percentage: float | None
    star_3_percentage: float | None
    star_4_percentage: float | None
    star_5_percentage: float | None
    star_1_count: int | None
    star_2_count: int | None
    star_3_count: int | None
    star_4_count: int | None
    star_5_count: int | None
    star_count_quality: str
    capture_status: str


class ReviewItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    review_key: str
    id_confidence: str
    reviewer_id: str | None
    reviewer_name: str | None
    rating: int | None
    title: str | None
    body: str | None
    review_date: date | None
    verified_purchase: bool | None
    helpful_count: int | None
    first_seen_at: datetime
    last_seen_at: datetime
    visibility_status: str


class CrawlRunItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    started_at: datetime
    finished_at: datetime | None
    status: str
    is_complete_list: bool
    reviews_seen: int | None
    ratings_captured: bool
    asin_scraped: str | None
    error_message: str | None


class ExternalLinkItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    target_id: int
    shop_id: int
    is_active: bool


class ExternalTargetItem(TargetItem):
    links: list[ExternalLinkItem]


class ExternalTargetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    marketplace: str = Field(min_length=2, max_length=20)
    asin: str = Field(min_length=1, max_length=20)
    shop_id: int | None = Field(default=None, gt=0)
    display_name: str | None = Field(default=None, max_length=255)

    @field_validator("marketplace")
    @classmethod
    def marketplace_valid(cls, value: str) -> str:
        return validate_marketplace(value)

    @field_validator("asin")
    @classmethod
    def asin_normalized(cls, value: str) -> str:
        value = value.strip().upper()
        if not value:
            raise ValueError("asin must not be blank")
        return value


class ExternalLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shop_id: int = Field(gt=0)
```

- [ ] **步骤 4：实现路由**

修改 `backend/app/api/v1/endpoints/amazon_review_tracking.py`：

（a）把权限拆成「会话」与「管理员」两级——替换既有 `_require_admin` 定义：

```python
def _require_session(
    _: None = Depends(require_api_key),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> str:
    if not x_user_id or not x_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        if not validate_session(x_user_id, x_session_id):
            raise HTTPException(status_code=401, detail="Session revoked")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Not authenticated") from None
    return x_user_id


def _require_admin(user_id: str = Depends(_require_session)) -> bool:
    db = SessionLocal()
    try:
        row = db.execute(
            text("""
                SELECT is_admin, is_active FROM public.user_accounts
                WHERE id::text = :user_id LIMIT 1
            """),
            {"user_id": user_id},
        ).mappings().first()
    finally:
        db.close()
    if row is None or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not row["is_admin"]:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


def _ensure_target(db: Session, target_id: int) -> AmazonReviewTarget:
    target = db.get(AmazonReviewTarget, target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="review target not found")
    return target
```

导入补充：`from datetime import date`、`from app.models.amazon_review_tracking import AmazonReviewTarget, AmazonReviewRatingSnapshot, AmazonReviewReview, AmazonReviewCrawlRun`、以及新增 schema 名。

（b）追加只读路由：

```python
@router.get("/targets", response_model=list[TargetItem], dependencies=[Depends(_require_session)])
def list_targets(
    project_id: int | None = Query(default=None, gt=0),
    marketplace: str | None = None,
    kind: str | None = None,
    is_active: bool | None = None,
    db: Session = Depends(get_read_db_session),
) -> list[TargetItem]:
    stmt = select(AmazonReviewTarget)
    if project_id is not None:
        stmt = stmt.where(AmazonReviewTarget.project_id == project_id)
    if marketplace is not None:
        stmt = stmt.where(AmazonReviewTarget.marketplace == marketplace.strip().upper())
    if kind is not None:
        stmt = stmt.where(AmazonReviewTarget.kind == kind)
    if is_active is not None:
        stmt = stmt.where(AmazonReviewTarget.is_active.is_(is_active))
    rows = db.execute(stmt.order_by(AmazonReviewTarget.id)).scalars().all()
    return [TargetItem.model_validate(row) for row in rows]


@router.get(
    "/targets/{target_id}/rating-snapshots",
    response_model=list[RatingSnapshotItem],
    dependencies=[Depends(_require_session)],
)
def list_rating_snapshots(
    target_id: int,
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_read_db_session),
) -> list[RatingSnapshotItem]:
    _ensure_target(db, target_id)
    stmt = select(AmazonReviewRatingSnapshot).where(AmazonReviewRatingSnapshot.target_id == target_id)
    if date_from is not None:
        stmt = stmt.where(AmazonReviewRatingSnapshot.capture_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(AmazonReviewRatingSnapshot.capture_date <= date_to)
    rows = db.execute(stmt.order_by(AmazonReviewRatingSnapshot.capture_date)).scalars().all()
    return [RatingSnapshotItem.model_validate(row) for row in rows]


@router.get("/targets/{target_id}/reviews", response_model=list[ReviewItem], dependencies=[Depends(_require_session)])
def list_reviews(
    target_id: int,
    visibility_status: str | None = None,
    review_date_from: date | None = None,
    review_date_to: date | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> list[ReviewItem]:
    _ensure_target(db, target_id)
    stmt = select(AmazonReviewReview).where(AmazonReviewReview.target_id == target_id)
    if visibility_status is not None:
        stmt = stmt.where(AmazonReviewReview.visibility_status == visibility_status)
    if review_date_from is not None:
        stmt = stmt.where(AmazonReviewReview.review_date >= review_date_from)
    if review_date_to is not None:
        stmt = stmt.where(AmazonReviewReview.review_date <= review_date_to)
    rows = db.execute(
        stmt.order_by(AmazonReviewReview.review_date.desc().nullslast(), AmazonReviewReview.id)
        .limit(limit).offset(offset)
    ).scalars().all()
    return [ReviewItem.model_validate(row) for row in rows]


@router.get("/targets/{target_id}/runs", response_model=list[CrawlRunItem], dependencies=[Depends(_require_session)])
def list_runs(
    target_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> list[CrawlRunItem]:
    _ensure_target(db, target_id)
    rows = db.execute(
        select(AmazonReviewCrawlRun)
        .where(AmazonReviewCrawlRun.target_id == target_id)
        .order_by(AmazonReviewCrawlRun.started_at.desc(), AmazonReviewCrawlRun.id.desc())
        .limit(limit).offset(offset)
    ).scalars().all()
    return [CrawlRunItem.model_validate(row) for row in rows]
```

- [ ] **步骤 5：运行确认通过**

运行：`cd backend && pytest tests/api/test_amazon_review_ops.py -q`
预期：全部 PASS。

- [ ] **步骤 6：commit**

```bash
git add backend/app/schemas/amazon_review_tracking.py backend/app/api/v1/endpoints/amazon_review_tracking.py backend/tests/api/test_amazon_review_ops.py
git commit -m "feat(评论追踪): 暴露运营查询接口"
```

---

## Task 5：外部竞品登记与店铺关联 API

- [ ] **步骤 1：写失败测试**

创建 `backend/tests/api/test_amazon_review_external.py`：

```python
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.models import Project
from app.models.project_shop import ProjectShop


def _shop(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    shop = ProjectShop(project_id=project.id, country="US", shop_id=f"ext-{uuid.uuid4().hex[:8]}",
                       shop_name=f"ext-{uuid.uuid4().hex[:8]}")
    db_session.add(shop)
    db_session.flush()
    return shop


def test_register_external_target_and_relink_restores_history(client, admin_headers, db_session):
    shop = _shop(db_session)
    asin = f"B0{uuid.uuid4().hex[:8].upper()}"
    created = client.post("/api/v1/amazon-review-tracking/external-targets",
        json={"marketplace": "US", "asin": asin, "shop_id": shop.id}, headers=admin_headers)
    assert created.status_code == 201
    body = created.json()
    assert body["kind"] == "external_asin" and [l["shop_id"] for l in body["links"]] == [shop.id]
    target_id = body["id"]

    removed = client.delete(
        f"/api/v1/amazon-review-tracking/targets/{target_id}/external-links/{body['links'][0]['id']}",
        headers=admin_headers)
    assert removed.status_code == 200 and removed.json()["is_active"] is False

    again = client.post("/api/v1/amazon-review-tracking/external-targets",
        json={"marketplace": "US", "asin": asin, "shop_id": shop.id}, headers=admin_headers)
    assert again.status_code == 201 and again.json()["id"] == target_id
    assert [l["shop_id"] for l in again.json()["links"] if l["is_active"]] == [shop.id]


def test_external_requires_admin_and_rejects_bad_shop(client, admin_headers):
    assert client.post("/api/v1/amazon-review-tracking/external-targets",
                       json={"marketplace": "US", "asin": "B0X"}).status_code == 401
    bad = client.post("/api/v1/amazon-review-tracking/external-targets",
                      json={"marketplace": "US", "asin": f"B0{uuid.uuid4().hex[:8].upper()}", "shop_id": 999999999},
                      headers=admin_headers)
    assert bad.status_code == 422
```

- [ ] **步骤 2：运行确认失败**

运行：`cd backend && pytest tests/api/test_amazon_review_external.py -q`
预期：FAIL——`404`。

- [ ] **步骤 3：实现外部服务**

创建 `backend/app/services/amazon_review_external_service.py`：

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.amazon_review_tracking import AmazonReviewExternalLink, AmazonReviewTarget
from app.models.project_shop import ProjectShop
from app.schemas.amazon_review_tracking import validate_marketplace


class ExternalLinkError(ValueError):
    """Invalid external competitor operation."""


def _require_shop(db: Session, shop_id: int) -> ProjectShop:
    shop = db.get(ProjectShop, shop_id)
    if shop is None:
        raise ExternalLinkError("shop not found")
    return shop


def _upsert_link(db: Session, target_id: int, shop_id: int) -> AmazonReviewExternalLink:
    now = datetime.now(timezone.utc)
    link = db.execute(
        select(AmazonReviewExternalLink).where(
            AmazonReviewExternalLink.target_id == target_id,
            AmazonReviewExternalLink.shop_id == shop_id,
        )
    ).scalar_one_or_none()
    if link is None:
        link = AmazonReviewExternalLink(target_id=target_id, shop_id=shop_id, is_active=True, added_at=now)
        db.add(link)
    else:
        link.is_active = True
        link.removed_at = None
        link.added_at = now
    db.flush()
    return link


def register_external_target(db: Session, *, marketplace: str, asin: str, shop_id: int | None = None,
                             display_name: str | None = None) -> AmazonReviewTarget:
    try:
        marketplace = validate_marketplace(marketplace)
    except ValueError as exc:
        raise ExternalLinkError("invalid Marketplace") from exc
    asin = asin.strip().upper()
    if not asin:
        raise ExternalLinkError("asin must not be blank")
    target = db.execute(
        select(AmazonReviewTarget).where(
            AmazonReviewTarget.kind == "external_asin",
            AmazonReviewTarget.marketplace == marketplace,
            AmazonReviewTarget.asin == asin,
        )
    ).scalar_one_or_none()
    if target is None:
        target = AmazonReviewTarget(kind="external_asin", marketplace=marketplace, asin=asin,
                                    display_name=display_name or asin, is_active=True)
        db.add(target)
        db.flush()
    elif display_name is not None:
        target.display_name = display_name
    if shop_id is not None:
        _require_shop(db, shop_id)
        _upsert_link(db, target.id, shop_id)
    return target


def add_external_link(db: Session, *, target_id: int, shop_id: int) -> AmazonReviewExternalLink:
    target = db.get(AmazonReviewTarget, target_id)
    if target is None or target.kind != "external_asin":
        raise ExternalLinkError("external target not found")
    _require_shop(db, shop_id)
    return _upsert_link(db, target_id, shop_id)


def remove_external_link(db: Session, *, target_id: int, link_id: int) -> AmazonReviewExternalLink:
    link = db.get(AmazonReviewExternalLink, link_id)
    if link is None or link.target_id != target_id:
        raise ExternalLinkError("external link not found")
    link.is_active = False
    link.removed_at = datetime.now(timezone.utc)
    db.flush()
    return link


def links_for_target(db: Session, target_id: int) -> list[AmazonReviewExternalLink]:
    return db.execute(
        select(AmazonReviewExternalLink)
        .where(AmazonReviewExternalLink.target_id == target_id)
        .order_by(AmazonReviewExternalLink.id)
    ).scalars().all()
```

- [ ] **步骤 4：实现路由**

在 `backend/app/api/v1/endpoints/amazon_review_tracking.py` 追加：

```python
def _external_item(db: Session, target: AmazonReviewTarget) -> ExternalTargetItem:
    links = [ExternalLinkItem.model_validate(link) for link in links_for_target(db, target.id)]
    base = TargetItem.model_validate(target)
    return ExternalTargetItem(**base.model_dump(), links=links)


@router.get("/external-targets", response_model=list[ExternalTargetItem], dependencies=[Depends(_require_session)])
def list_external_targets(db: Session = Depends(get_read_db_session)) -> list[ExternalTargetItem]:
    targets = db.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.kind == "external_asin").order_by(AmazonReviewTarget.id)
    ).scalars().all()
    return [_external_item(db, target) for target in targets]


@router.post("/external-targets", response_model=ExternalTargetItem, status_code=201, dependencies=[Depends(_require_admin)])
def create_external_target(
    payload: ExternalTargetCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ExternalTargetItem:
    try:
        target = register_external_target(
            db, marketplace=payload.marketplace, asin=payload.asin,
            shop_id=payload.shop_id, display_name=payload.display_name,
        )
        result = _external_item(db, target)
        append_operation_audit_log(db, action="amazon_review_tracking.external_target.create",
            target_type="amazon_review_target", target_id=target.id, operator=operator,
            after=result.model_dump(mode="json"), request=request)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.post("/targets/{target_id}/external-links", response_model=ExternalLinkItem, status_code=201,
             dependencies=[Depends(_require_admin)])
def create_external_link(
    target_id: int,
    payload: ExternalLinkCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ExternalLinkItem:
    try:
        link = add_external_link(db, target_id=target_id, shop_id=payload.shop_id)
        result = ExternalLinkItem.model_validate(link)
        append_operation_audit_log(db, action="amazon_review_tracking.external_link.add",
            target_type="amazon_review_external_link", target_id=link.id, operator=operator,
            after=result.model_dump(mode="json"), request=request)
        db.commit()
        return result
    except ExternalLinkError as exc:
        db.rollback()
        raise HTTPException(status_code=404 if "not found" in str(exc) else 422, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        raise


@router.delete("/targets/{target_id}/external-links/{link_id}", response_model=ExternalLinkItem,
               dependencies=[Depends(_require_admin)])
def delete_external_link(
    target_id: int,
    link_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ExternalLinkItem:
    try:
        link = remove_external_link(db, target_id=target_id, link_id=link_id)
        result = ExternalLinkItem.model_validate(link)
        append_operation_audit_log(db, action="amazon_review_tracking.external_link.remove",
            target_type="amazon_review_external_link", target_id=link.id, operator=operator,
            after=result.model_dump(mode="json"), request=request)
        db.commit()
        return result
    except ExternalLinkError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        raise
```

导入补充：`from app.services.amazon_review_external_service import (ExternalLinkError, add_external_link, links_for_target, register_external_target, remove_external_link)`；schema 名 `ExternalTargetCreate, ExternalTargetItem, ExternalLinkCreate, ExternalLinkItem`。

- [ ] **步骤 5：运行确认通过**

运行：`cd backend && pytest tests/api/test_amazon_review_external.py tests/api/test_amazon_review_ops.py -q`
预期：全部 PASS。

- [ ] **步骤 6：commit**

```bash
git add backend/app/services/amazon_review_external_service.py backend/app/api/v1/endpoints/amazon_review_tracking.py backend/tests/api/test_amazon_review_external.py
git commit -m "feat(评论追踪): 暴露外部竞品登记与店铺关联接口"
```

---

## Task 6：整合验证（T3）

- [ ] **步骤 1：目标集 + 迁移检查**

```bash
cd backend && python scripts/check_alembic.py
cd backend && pytest tests/services/test_amazon_review_targets_model.py \
    tests/services/test_amazon_review_tracking_service.py \
    tests/services/test_amazon_review_ingestion_service.py \
    tests/api/test_amazon_review_ops.py tests/api/test_amazon_review_external.py -q
```
预期：迁移检查通过；目标集全绿。

- [ ] **步骤 2：重生成 OpenAPI 契约并提交**

```bash
cd backend && make openapi-export VENV=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python
cd .. && node /Users/damon/DamonProjects/believeboyDashboard/frontend/node_modules/openapi-typescript/bin/cli.js \
    frontend/types/api-generated/openapi.json --output frontend/types/api-generated/api.d.ts
cd backend && pytest tests/scripts/test_openapi_export.py -q
```
预期：新增路由/ schema 反映到契约，测试 PASS（吸收阶段 A 契约教训）。

- [ ] **步骤 3：全量一次 + 失败集对账**

```bash
cd backend
main_venv=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python
$main_venv - <<'PY'
import os, runpy, sys
envfile = "/Users/damon/DamonProjects/believeboyDashboard/backend/.env.test"
with open(envfile, encoding="utf-8") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ[k] = v
from sqlalchemy.engine.url import make_url
assert make_url(os.environ["TEST_DATABASE_URL"]).database == "BLF_test"
sys.argv = ["pytest", "-q", "--tb=no", "-rf", "--junitxml=/tmp/pytest-phaseb-full.xml"]
runpy.run_module("pytest", run_name="__main__")
PY
```
按 [`task-5-failure-reconciliation.md`](./task-5-failure-reconciliation.md) 的方法，对失败集在基线 `3d7b7b84`（或当时最新 `origin/main`）同环境定向重跑对账；**不跑第二遍全量**。预期：除既有基线失败外无新增；若有新增立即修复。

- [ ] **步骤 4：diff 检查 + commit**

```bash
git diff --check
git add frontend/types/api-generated/openapi.json frontend/types/api-generated/api.d.ts
git commit -m "chore(评论追踪): 同步阶段B OpenAPI 契约"
```
