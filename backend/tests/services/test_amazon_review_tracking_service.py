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

    group_fk_constraints = {
        tuple(column.name for column in constraint.columns): tuple(
            element.target_fullname for element in constraint.elements
        )
        for constraint in group.foreign_key_constraints
    }
    assert group_fk_constraints[("representative_sku_record_id", "project_id", "marketplace")] == (
        "product_costs.id", "product_costs.project_id", "product_costs.country"
    )

    member_fk_constraints = {
        tuple(column.name for column in constraint.columns): tuple(
            element.target_fullname for element in constraint.elements
        )
        for constraint in member.foreign_key_constraints
    }
    assert member_fk_constraints[("sku_record_id", "project_id", "marketplace")] == (
        "product_costs.id", "product_costs.project_id", "product_costs.country"
    )
    assert member_fk_constraints[("group_id", "project_id", "marketplace")] == (
        "amazon_review_groups.id", "amazon_review_groups.project_id", "amazon_review_groups.marketplace"
    )
    assert "projects.id" not in {fk.target_fullname for fk in member.foreign_keys}

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
    assert {"product_costs.id", "product_costs.project_id", "product_costs.country"} <= group_fk_targets
    assert {"product_costs.id", "product_costs.project_id", "product_costs.country"} <= member_fk_targets
    assert {"amazon_review_groups.id", "amazon_review_groups.project_id", "amazon_review_groups.marketplace"} <= member_fk_targets
