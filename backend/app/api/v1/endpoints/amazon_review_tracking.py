from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
)
from app.core.security import require_api_key
from app.services.infra import validate_session
from app.db.session import SessionLocal
from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember
from app.schemas.amazon_review_tracking import (
    ReviewGroupCreate,
    ReviewGroupMemberReplace,
    ReviewGroupRepresentativeUpdate,
)
from app.services.amazon_review_tracking_service import (
    ReviewGroupError,
    create_group,
    deactivate_group,
    replace_group_members,
    set_representative,
)
from app.services.audit_log_service import append_operation_audit_log

router = APIRouter(prefix="/amazon-review-tracking", tags=["Amazon 评论追踪"])


def _require_admin(
    _: None = Depends(require_api_key),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> bool:
    if not x_user_id or not x_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        if not validate_session(x_user_id, x_session_id):
            raise HTTPException(status_code=401, detail="Session revoked")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Not authenticated") from None

    db = SessionLocal()
    try:
        row = db.execute(
            text("""
                SELECT is_admin, is_active FROM public.user_accounts
                WHERE id::text = :user_id LIMIT 1
            """),
            {"user_id": x_user_id},
        ).mappings().first()
    finally:
        db.close()
    if row is None or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not row["is_admin"]:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


class ReviewGroupPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    member_ids: list[int] | None = Field(default=None, validate_default=False)
    representative_id: int | None = Field(default=None, gt=0, validate_default=False)

    @model_validator(mode="before")
    @classmethod
    def reject_null_updates(cls, value):
        if isinstance(value, dict) and any(
            key in value and value[key] is None
            for key in ("name", "member_ids", "representative_id")
        ):
            raise ValueError("name, member_ids and representative_id cannot be null")
        return value


class ReviewGroupItem(BaseModel):
    id: int
    project_id: int
    marketplace: str
    name: str
    description: str | None
    representative_id: int | None
    member_ids: list[int]
    is_active: bool


def _item(
    db: Session, group: AmazonReviewGroup, member_ids: list[int] | None = None
) -> ReviewGroupItem:
    members = member_ids
    if members is None:
        members = db.execute(
            select(AmazonReviewGroupMember.sku_record_id).where(
                AmazonReviewGroupMember.group_id == group.id,
                AmazonReviewGroupMember.removed_at.is_(None),
            ).order_by(AmazonReviewGroupMember.sku_record_id)
        ).scalars().all()
    return ReviewGroupItem(
        id=group.id, project_id=group.project_id, marketplace=group.marketplace,
        name=group.name, description=group.description,
        representative_id=group.representative_sku_record_id,
        member_ids=members, is_active=group.is_active,
    )


def _call_service(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ReviewGroupError as exc:
        status_code = (
            404 if "not found" in str(exc)
            else 409 if "already exists" in str(exc) or "already belongs" in str(exc)
            else 422
        )
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc


@router.get(
    "/groups", response_model=list[ReviewGroupItem], dependencies=[Depends(_require_admin)]
)
def list_groups(
    project_id: int | None = Query(default=None, gt=0),
    marketplace: str | None = None,
    is_active: bool | None = None,
    db: Session = Depends(get_read_db_session),
) -> list[ReviewGroupItem]:
    stmt = select(AmazonReviewGroup)
    if project_id is not None:
        stmt = stmt.where(AmazonReviewGroup.project_id == project_id)
    if marketplace is not None:
        stmt = stmt.where(AmazonReviewGroup.marketplace == marketplace.strip().upper())
    if is_active is not None:
        stmt = stmt.where(AmazonReviewGroup.is_active.is_(is_active))
    groups = db.execute(
        stmt.order_by(
            AmazonReviewGroup.project_id,
            AmazonReviewGroup.marketplace,
            AmazonReviewGroup.id,
        )
    ).scalars().all()
    group_ids = [group.id for group in groups]
    members_by_group: dict[int, list[int]] = {group_id: [] for group_id in group_ids}
    if group_ids:
        rows = db.execute(
            select(AmazonReviewGroupMember.group_id, AmazonReviewGroupMember.sku_record_id)
            .where(
                AmazonReviewGroupMember.group_id.in_(group_ids),
                AmazonReviewGroupMember.removed_at.is_(None),
            )
            .order_by(
                AmazonReviewGroupMember.group_id,
                AmazonReviewGroupMember.sku_record_id,
            )
        ).all()
        for group_id, sku_id in rows:
            members_by_group[group_id].append(sku_id)
    return [_item(db, group, members_by_group[group.id]) for group in groups]


@router.post(
    "/groups", response_model=ReviewGroupItem, status_code=201,
    dependencies=[Depends(_require_admin)],
)
def create_review_group(
    payload: ReviewGroupCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ReviewGroupItem:
    try:
        group = _call_service(
            create_group, db, project_id=payload.project_id,
            marketplace=payload.marketplace, name=payload.name,
            description=payload.description, member_ids=payload.member_ids,
            representative_id=payload.representative_id,
        )
        result = _item(db, group)
        append_operation_audit_log(
            db, action="amazon_review_tracking.group.create",
            target_type="amazon_review_group", target_id=group.id,
            operator=operator, after=result.model_dump(), request=request,
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.patch(
    "/groups/{group_id}", response_model=ReviewGroupItem,
    dependencies=[Depends(_require_admin)],
)
def patch_review_group(
    group_id: int,
    payload: ReviewGroupPatch,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ReviewGroupItem:
    try:
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            raise HTTPException(status_code=422, detail="至少提供一个有效更新字段")
        group = db.execute(
            select(AmazonReviewGroup)
            .where(AmazonReviewGroup.id == group_id)
            .with_for_update()
        ).scalar_one_or_none()
        if group is None:
            raise HTTPException(status_code=404, detail="review group not found")
        before = _item(db, group).model_dump()
        if "name" in changes:
            name = changes["name"]
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 255:
                raise HTTPException(status_code=422, detail="invalid name")
            group.name = name.strip()
        if "description" in changes:
            group.description = changes["description"]
        if "member_ids" in changes:
            members = ReviewGroupMemberReplace(member_ids=changes["member_ids"])
            _call_service(
                replace_group_members, db, group_id=group_id,
                member_ids=members.member_ids,
            )
        if "representative_id" in changes:
            representative = ReviewGroupRepresentativeUpdate(
                sku_record_id=changes["representative_id"]
            )
            _call_service(
                set_representative, db, group_id=group_id,
                sku_record_id=representative.sku_record_id,
            )
        db.flush()
        updated = db.get(AmazonReviewGroup, group_id)
        result = _item(db, updated)
        append_operation_audit_log(
            db, action="amazon_review_tracking.group.update",
            target_type="amazon_review_group", target_id=group_id,
            operator=operator, before=before, after=result.model_dump(), request=request,
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.post(
    "/groups/{group_id}/deactivate", response_model=ReviewGroupItem,
    dependencies=[Depends(_require_admin)],
)
def deactivate_review_group(
    group_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ReviewGroupItem:
    try:
        group = db.execute(
            select(AmazonReviewGroup)
            .where(AmazonReviewGroup.id == group_id)
            .with_for_update()
        ).scalar_one_or_none()
        if group is None:
            raise HTTPException(status_code=404, detail="review group not found")
        before = _item(db, group).model_dump()
        group = _call_service(deactivate_group, db, group_id=group_id)
        result = _item(db, group)
        append_operation_audit_log(
            db, action="amazon_review_tracking.group.deactivate",
            target_type="amazon_review_group", target_id=group_id,
            operator=operator, before=before, after=result.model_dump(), request=request,
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
