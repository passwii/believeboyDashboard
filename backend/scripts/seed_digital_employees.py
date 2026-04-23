"""
初始化数字员工种子数据。
运行一次即可，或每次启动时检查是否已注册。

Usage:
    cd backend
    python scripts/seed_digital_employees.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.session import SessionLocal
from app.models.digital_employee import DigitalEmployee, EmployeeType, EmployeeStatus
import secrets


EMPLOYEES = [
    {
        "name": "产品和评论专家",
        "employee_type": EmployeeType.MONITORING,
        "description": "监控产品和评论数据变动，及时发现异常和新增评论反馈",
        "emoji": "📦",
    },
    {
        "name": "数据库监控专家",
        "employee_type": EmployeeType.DATABASE,
        "description": "监控数据库表健康状态、数据更新频率和 stale 表预警",
        "emoji": "🗄️",
    },
    {
        "name": "RPA专家",
        "employee_type": EmployeeType.RPA_BOT,
        "description": "监控 autoReportUpload 报表自动上传状态，处理 RPA 流程状态反馈",
        "emoji": "🤖",
    },
    {
        "name": "AI洞察报告员工",
        "employee_type": EmployeeType.AI_AGENT,
        "description": "监控手动/自动生成的 AI 洞察报告生成状态和进度",
        "emoji": "💬",
    },
]


def get_or_create_employee(db, name, employee_type, description, emoji):
    existing = db.execute(
        db.query(DigitalEmployee).filter(
            DigitalEmployee.name == name,
            DigitalEmployee.is_deleted == 0,
        )
    ).scalar_one_or_none()

    if existing:
        print(f"  Found existing: {name} (id={existing.id})")
        return existing

    employee = DigitalEmployee(
        name=name,
        employee_type=employee_type,
        description=description,
        avatar_url=emoji,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
        is_silent_alert_threshold_minutes=30,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    print(f"  Created: {name} (id={employee.id}, secret={employee.api_secret[:16]}...)")
    return employee


def main():
    db = SessionLocal()
    try:
        print("Seeding digital employees...")
        for emp_def in EMPLOYEES:
            emp = get_or_create_employee(
                db,
                name=emp_def["name"],
                employee_type=emp_def["employee_type"],
                description=emp_def["description"],
                emoji=emp_def["emoji"],
            )
            print(f"  [{emp_def['employee_type'].value}] {emp.name}: id={emp.id}")
        print("Done.")
    finally:
        db.close()


if __name__ == "__main__":
    main()