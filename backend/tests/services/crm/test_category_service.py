"""P6b 产品类目服务单元测试 — CRUD + 客户类目整体替换 + 级联。

注意：所有测试用独立临时类目（不碰 9 个种子），名称带随机后缀，
避免共享 BLF_test 库跨运行残留。
"""

import uuid

import pytest
from sqlalchemy import select, text

from app.models.crm import CrmCategory, CrmCustomerCategory
from app.services.crm.category_service import (
    create_category,
    delete_category,
    list_categories,
    list_customer_categories,
    set_customer_categories,
    update_category,
)


def _suffix() -> str:
    return uuid.uuid4().hex[:6]


@pytest.fixture
def customer(db_session):
    row = db_session.execute(
        text(
            "insert into crm_customers (name, created_by) values ('P6B', 't') returning id"
        )
    ).first()
    db_session.commit()
    return int(row[0])


def test_list_categories_seeded(db_session):
    cats = list_categories(db_session)
    assert len(cats) >= 9
    assert any(c.name == "家居" for c in cats)
    # 按 sort_order 排序
    orders = [c.sort_order for c in cats]
    assert orders == sorted(orders)


def test_create_category(db_session):
    cat = create_category(db_session, f"宠物用品-{_suffix()}", sort_order=9)
    assert cat.id is not None
    got = db_session.get(CrmCategory, cat.id)
    assert got.name == cat.name
    assert got.sort_order == 9


def test_create_category_duplicate_raises(db_session):
    name = f"家居-{_suffix()}"
    create_category(db_session, name)
    with pytest.raises(ValueError):
        create_category(db_session, name)


def test_create_category_strips_whitespace(db_session):
    name = f"宠物用品b-{_suffix()}"
    cat = create_category(db_session, f"  {name}  ")
    assert cat.name == name


def test_update_category_rename(db_session):
    name = f"临时-{_suffix()}"
    cat = create_category(db_session, name)
    new_name = f"改名-{_suffix()}"
    updated = update_category(db_session, cat.id, name=new_name)
    assert updated is not None
    assert db_session.get(CrmCategory, cat.id).name == new_name


def test_update_category_rename_duplicate_raises(db_session):
    a = create_category(db_session, f"A-{_suffix()}")
    b = create_category(db_session, f"B-{_suffix()}")
    with pytest.raises(ValueError):
        update_category(db_session, b.id, name=a.name)


def test_update_category_missing_returns_none(db_session):
    assert update_category(db_session, 999999, name="x") is None


def test_delete_category_removes_and_cascades(db_session, customer):
    cat = create_category(db_session, f"临时-{_suffix()}", sort_order=99)
    set_customer_categories(db_session, customer, [cat.id], commit=True)
    assert [c.id for c in list_customer_categories(db_session, customer)] == [cat.id]

    deleted = delete_category(db_session, cat.id, commit=True)
    assert deleted is not None
    assert db_session.get(CrmCategory, cat.id) is None
    # 级联解除客户挂接
    assert list_customer_categories(db_session, customer) == []


def test_delete_category_missing_returns_none(db_session):
    assert delete_category(db_session, 999999) is None


def test_set_customer_categories_replace_idempotent(db_session, customer):
    a = create_category(db_session, f"甲-{_suffix()}")
    b = create_category(db_session, f"乙-{_suffix()}")
    ids = [a.id, b.id]

    _, diff, after = set_customer_categories(db_session, customer, ids, commit=True)
    assert diff["added"] == [a.name, b.name]
    assert diff["removed"] == []
    assert [c.id for c in after] == ids
    # 再次设置相同集合 → 无变化
    _, diff2, after2 = set_customer_categories(db_session, customer, ids, commit=True)
    assert diff2["added"] == []
    assert diff2["removed"] == []
    assert [c.id for c in after2] == ids


def test_set_customer_categories_dedup_keeps_order(db_session, customer):
    a = create_category(db_session, f"丙-{_suffix()}")
    b = create_category(db_session, f"丁-{_suffix()}")
    _, _, after = set_customer_categories(
        db_session, customer, [a.id, a.id, b.id], commit=True
    )
    assert [c.id for c in after] == [a.id, b.id]


def test_set_customer_categories_remove_some(db_session, customer):
    a = create_category(db_session, f"戊-{_suffix()}")
    b = create_category(db_session, f"己-{_suffix()}")
    set_customer_categories(db_session, customer, [a.id, b.id], commit=True)
    _, diff, after = set_customer_categories(db_session, customer, [a.id], commit=True)
    assert diff["added"] == []
    assert diff["removed"] == [b.name]
    assert [c.id for c in after] == [a.id]


def test_set_customer_categories_unknown_id_raises(db_session, customer):
    with pytest.raises(ValueError):
        set_customer_categories(db_session, customer, [999999])


def test_set_customer_categories_missing_customer(db_session):
    customer, diff, after = set_customer_categories(db_session, 999999, [1])
    assert customer is None
    assert diff == {}
    assert after == []


def test_customer_categories_persist_rows(db_session, customer):
    cat = create_category(db_session, f"持久-{_suffix()}")
    set_customer_categories(db_session, customer, [cat.id], commit=True)
    rows = (
        db_session.execute(
            select(CrmCustomerCategory).where(
                CrmCustomerCategory.customer_id == customer
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].category_id == cat.id
