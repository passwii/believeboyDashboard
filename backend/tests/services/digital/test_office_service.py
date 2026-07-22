from datetime import datetime, timedelta, UTC


def _seed_employee_with_task(db_session):
    from app.models.digital_employee import DigitalEmployee, DigitalEmployeeTask, EmployeeType, TaskStatus

    emp = DigitalEmployee(name="报表快递员", employee_type=EmployeeType.AUTO_REPORT_UPLOAD, api_secret="s3cret")
    db_session.add(emp)
    db_session.commit()
    db_session.refresh(emp)
    now = datetime.now(UTC)
    task = DigitalEmployeeTask(
        employee_id=emp.id, task_id="aru-1", task_name="润茗/payment_report",
        task_type="payment_report", status=TaskStatus.SUCCEEDED, progress_percent=100,
        started_at=now - timedelta(seconds=300), ended_at=now,
        metadata_json='{"project_name": "润茗", "report_label": "Payment Report"}',
    )
    db_session.add(task)
    db_session.commit()
    return emp


def test_advance_employee_returns_snapshot_and_persists_cursor(db_session):
    from app.services.digital.office_service import advance_employee

    emp = _seed_employee_with_task(db_session)
    snap = advance_employee(db_session, emp, datetime.now(UTC))
    assert snap["employee_id"] == emp.id
    assert snap["display_status"] in ("WORKING", "PAUSING")
    assert snap["work_item"]["project_name"] == "润茗"
    snap2 = advance_employee(db_session, emp, datetime.now(UTC))
    assert snap2["virtual_progress"] >= snap["virtual_progress"]


def test_build_wall_snapshot_lists_all_active_employees(db_session):
    from app.services.digital.office_service import build_wall_snapshot

    _seed_employee_with_task(db_session)
    wall = build_wall_snapshot(db_session, datetime.now(UTC))
    assert isinstance(wall, list)
    assert len(wall) >= 1
    assert "persona" in wall[0]
