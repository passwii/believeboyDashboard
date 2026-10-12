from sqlalchemy import BigInteger, Integer, String

from app.db.session import Base
from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember


def test_review_group_metadata_contract():
    group = AmazonReviewGroup.__table__
    member = AmazonReviewGroupMember.__table__

    assert isinstance(group.c.id.type, Integer)
    assert isinstance(member.c.id.type, Integer)
    assert "project_id" in group.c
    assert isinstance(group.c.project_id.type, BigInteger)
    assert isinstance(group.c.representative_sku_record_id.type, BigInteger)
    assert isinstance(member.c.project_id.type, BigInteger)
    assert isinstance(member.c.sku_record_id.type, BigInteger)
    assert isinstance(member.c.group_id.type, Integer)
    assert "marketplace" in group.c
    assert "sku_record_id" in member.c
    assert "project_id" in member.c
    assert isinstance(member.c.project_id.type, BigInteger)
    assert isinstance(member.c.sku_record_id.type, BigInteger)
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



def test_foreign_key_types_match_referenced_primary_keys():
    group = AmazonReviewGroup.__table__
    member = AmazonReviewGroupMember.__table__

    assert isinstance(group.c.project_id.type, BigInteger)
    assert isinstance(group.c.representative_sku_record_id.type, BigInteger)
    assert isinstance(member.c.project_id.type, BigInteger)
    assert isinstance(member.c.sku_record_id.type, BigInteger)
    assert isinstance(member.c.group_id.type, Integer)

    group_fk_targets = {fk.target_fullname for fk in group.foreign_keys}
    member_fk_targets = {fk.target_fullname for fk in member.foreign_keys}
    assert {"projects.id", "product_costs.id"} <= group_fk_targets
    assert {"projects.id", "product_costs.id", "amazon_review_groups.id"} <= member_fk_targets
