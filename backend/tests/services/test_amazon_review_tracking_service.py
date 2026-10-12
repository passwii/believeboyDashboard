from sqlalchemy import Integer

from app.db.session import Base
from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember


def test_review_group_metadata_contract():
    group = AmazonReviewGroup.__table__
    member = AmazonReviewGroupMember.__table__

    assert isinstance(group.c.id.type, Integer)
    assert isinstance(member.c.id.type, Integer)
    assert "project_id" in group.c
    assert "marketplace" in group.c
    assert "sku_record_id" in member.c
    assert "project_id" in member.c
    assert "marketplace" in member.c
    assert "removed_at" in member.c
    assert "is_active" in group.c

    fk_targets = {fk.target_fullname for fk in member.foreign_keys}
    assert "product_costs.id" in fk_targets
    assert "projects.id" in fk_targets

    active_members = [
        index
        for index in member.indexes
        if index.unique and index.dialect_options["postgresql"].get("where") is not None
    ]
    assert active_members
    assert any(
        "sku_record_id" in {column.name for column in index.columns}
        for index in active_members
    )

    assert "created_at" in group.c and "updated_at" in group.c
    assert "created_at" in member.c and "removed_at" in member.c
    assert any(fk.target_fullname == "amazon_review_groups.id" for fk in member.foreign_keys)
