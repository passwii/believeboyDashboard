"""Agent 货件域测试 fixture（P2）。

shipment_env：临时项目 + 2 个 SKU（X-001/X-002，US，装箱率 10）+ 一张 agent 凭据。
测试后按 items → schedules → skus → project 顺序清理（key 由 make_api_key 自清）。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import Project
from app.models.sku_info import SkuRecord
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import ShipmentScheduleCreate
from app.services import shipment as shipment_service
from app.services.shipment.item import replace_shipment_schedule_items


def seed_schedule(project_id: int, shipment_no: str) -> int:
    """建一张 draft 货件 + 2 行明细（X-001×100、X-002×50），返回 schedule id。

    放在 conftest 里供同目录测试文件 `from conftest import seed_schedule`
    （tests 目录非 package，不能跨模块 `from tests....` 导入）。
    """
    db = SessionLocal()
    try:
        payload = ShipmentScheduleCreate(
            project_id=project_id,
            country="US",
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            logistics_unit_price=13.5,
        )
        row = shipment_service.create_shipment_schedule(db, payload, operator="pytest")
        items = [
            {
                "row_no": 1,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-001",
                "quantity": 100,
                "carton_count": 10,
                "remark": None,
            },
            {
                "row_no": 2,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-002",
                "quantity": 50,
                "carton_count": 5,
                "remark": None,
            },
        ]
        replace_shipment_schedule_items(db, row, items, source_type="manual")
        db.commit()
        return row.id
    finally:
        db.close()


@pytest.fixture
def shipment_env(make_api_key):
    agent_id = f"p2-agent-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id)
    suffix = uuid.uuid4().hex[:8]
    project_name = f"agent-p2-{suffix}"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        for sku in ("X-001", "X-002"):
            db.add(
                SkuRecord(
                    project_id=project.id,
                    project_name=project_name,
                    sku=sku,
                    asin=f"ASIN-{sku}",
                    country="US",
                    fob_unit_cost=10,
                    first_leg_cost_rmb=1,
                    package_length_cm=10,
                    package_width_cm=10,
                    package_height_cm=10,
                    weight_kg=0.5,
                    carton_length_cm=20,
                    carton_width_cm=20,
                    carton_height_cm=20,
                    carton_weight_kg=5,
                    units_per_carton=10,
                    currency="USD",
                    sort_order=0,
                    is_active=True,
                )
            )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "headers": {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        },
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(ShipmentScheduleItem).where(
                ShipmentScheduleItem.project_id == project_id
            )
        )
        db.execute(
            delete(ShipmentSchedule).where(ShipmentSchedule.project_id == project_id)
        )
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()
