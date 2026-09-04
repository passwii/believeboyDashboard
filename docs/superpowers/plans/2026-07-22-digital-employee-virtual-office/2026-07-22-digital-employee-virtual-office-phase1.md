# Phase 1 — 端到端骨架（数字员工虚拟办公室）

> **状态：** ✅ Phase 1 完成（2026-07-23 更新）— 9 个原始 commit + 3 个质量修复 commit 落地。24 后端测试 PASS（11 引擎 + 5 office_service 纯逻辑 + 8 SSE 端点），前端 lint/build/test 全绿（208 tests）。端到端模拟器验证通过：3 员工 8 任务（含 FAILED/并发排队/真实 metadata），SSE 推送正常，伸展引擎拉伸生效。
>
> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **父 plan：** [`2026-07-22-digital-employee-virtual-office.md`](./2026-07-22-digital-employee-virtual-office.md)

**目标：** 跑通"1 个真实/模拟 Agent 上报 → 后端伸展引擎拉伸 → SSE 推送 → 前端单张工牌实时渲染"，验证"1 分钟真实任务被拉伸成约 1 小时慢播、进度平滑不跳变"。

**架构：** 复用心跳 API 与三张表；新增 `playback_engine.py`（纯逻辑）+ `digital_employee_playback` 表 + `office_service.py` + SSE 端点；前端 `useOfficeStream` + `OfficeBadge` + `/office` 页面。

**技术栈：** FastAPI `StreamingResponse`（SSE）、SQLAlchemy + Alembic、pytest（TDD）；Next.js + `EventSource` + Vitest。

**验证基线命令：**
- 后端：`cd backend && pytest tests/services/digital/test_playback_engine.py -v`（纯逻辑，无需测试 DB）；DB/端点测试需 `TEST_DATABASE_URL`（见 `tests/conftest.py`）。
- 前端：`cd frontend && pnpm lint && pnpm build && pnpm test`。

---

## 文件结构

### 新增
| 路径 | 职责 |
|------|------|
| `backend/app/services/digital/playback_engine.py` | **核心**：伸展引擎纯逻辑（`advance`/`stretch_duration_s`/`compute_pace`/`classify_busy`） |
| `backend/tests/services/digital/__init__.py` | 测试包标记 |
| `backend/tests/services/digital/test_playback_engine.py` | 引擎单测 |
| `backend/app/models/digital_employee_playback.py` | `DigitalEmployeePlayback` 表模型 |
| `backend/alembic/versions/xxxx_add_digital_employee_playback.py` | 迁移（`op.create_table`） |
| `backend/app/services/digital/office_service.py` | DB 编排：`advance_employee`/`build_wall_snapshot` + persona/战绩富化 |
| `backend/tests/services/digital/test_office_service.py` | service 测试（需测试 DB） |
| `backend/app/api/v1/endpoints/digital_office.py` | SSE 端点 router |
| `backend/tests/api/test_digital_office_stream.py` | SSE 端点测试 |
| `backend/scripts/simulate_agent.py` | 模拟器：通过心跳 API 喂一个假 Agent，供端到端验证 |
| `frontend/lib/digital-employee/office-stream-types.ts` | SSE payload 类型 |
| `frontend/lib/digital-employee/use-office-stream.ts` | `useOfficeStream` hook（EventSource） |
| `frontend/lib/digital-employee/__tests__/office-stream.test.ts` | hook 解析逻辑单测 |
| `frontend/components/digital-employee/office/office-badge.tsx` | 工牌组件 |
| `frontend/app/dashboard/ai/digital-employees/office/page.tsx` | 工牌墙页面（Phase 1 单张） |

### 修改
| 路径 | 修改点 |
|------|--------|
| `backend/app/models/__init__.py`（或模型注册处） | import `DigitalEmployeePlayback` 使其挂到 metadata |
| v1 路由聚合处（`grep -rn "include_router" backend/app/api`） | 注册 `digital_office.router` |
| `frontend/lib/sidebar-config.ts`（可选） | 加"虚拟办公室"入口 |

---

## 任务 0：引擎纯函数（TDD）

**文件：**
- 创建：`backend/tests/services/digital/__init__.py`（空文件）
- 创建：`backend/tests/services/digital/test_playback_engine.py`
- 创建：`backend/app/services/digital/playback_engine.py`

- [ ] **步骤 1：写失败测试（纯函数部分）**

创建 `backend/tests/services/digital/test_playback_engine.py`：

```python
from datetime import datetime, timedelta, UTC

from app.services.digital.playback_engine import (
    PlaybackConfig,
    classify_busy,
    compute_pace,
    stretch_duration_s,
)

T0 = datetime(2026, 7, 22, 9, 0, 0, tzinfo=UTC)
CFG = PlaybackConfig()


def test_stretch_short_task_into_30min_to_2h():
    # 5 分钟真实 → 5*60*12=3600s=1h，落在 [1800, 7200]
    assert stretch_duration_s(300.0, 1.0, CFG) == 3600.0
    # 极短任务被抬到下限 30min
    assert stretch_duration_s(10.0, 1.0, CFG) == 1800.0
    # 极长任务被压到上限 2h
    assert stretch_duration_s(10_000.0, 1.0, CFG) == 7200.0


def test_stretch_busy_pace_shortens_display():
    base = stretch_duration_s(300.0, 1.0, CFG)
    busy = stretch_duration_s(300.0, 3.0, CFG)
    assert busy == base / 3.0


def test_compute_pace_calm_then_accelerate():
    assert compute_pace(0, CFG) == 1.0
    assert compute_pace(1, CFG) == 1.0          # calm_queue=1
    assert compute_pace(5, CFG) == 3.0          # 1 + (5-1)*0.5
    assert compute_pace(100, CFG) == CFG.max_pace  # 钳制上限


def test_classify_busy_levels():
    assert classify_busy(0, 1.0) == "IDLE"
    assert classify_busy(2, 1.0) == "NORMAL"
    assert classify_busy(4, 2.0) == "BUSY"
    assert classify_busy(10, 5.0) == "SWAMPED"
```

- [ ] **步骤 2：运行验证失败**

```bash
cd backend && pytest tests/services/digital/test_playback_engine.py -v
```
预期：FAIL，`ModuleNotFoundError: app.services.digital.playback_engine`

- [ ] **步骤 3：实现纯函数**

创建 `backend/app/services/digital/playback_engine.py`：

```python
"""数字员工拟人化伸展引擎（纯逻辑，无 DB）。

把"脉冲式"真实任务流拉伸成平滑的"虚拟当前状态"：短任务拉伸到
[min_display, max_display] 慢慢演、任务间插入拟人化停顿、排队越多 pace
越大（加速消化）、据 pace/排队判定 busy_level。节奏常量集中在 PlaybackConfig。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta


@dataclass(frozen=True)
class RealTask:
    task_id: str
    task_name: str
    task_type: str
    status: str
    progress_percent: int
    current_step: str | None
    started_at: datetime
    ended_at: datetime | None
    metadata: dict | None = None


@dataclass
class PlaybackState:
    employee_id: int
    virtual_index: int = 0
    current_task_id: str | None = None
    virtual_progress: float = 0.0
    display_started_at: datetime | None = None
    display_duration_s: float = 0.0
    pause_until: datetime | None = None
    pace: float = 1.0
    busy_level: str = "IDLE"
    last_advanced_at: datetime | None = None


@dataclass(frozen=True)
class VirtualSnapshot:
    employee_id: int
    display_status: str
    current_task: RealTask | None
    virtual_progress: float
    step_label: str
    pace: float
    busy_level: str
    queued_count: int


@dataclass(frozen=True)
class PlaybackConfig:
    stretch_factor: float = 12.0
    min_display_s: float = 1800.0
    max_display_s: float = 7200.0
    calm_queue: int = 1
    pace_per_extra: float = 0.5
    max_pace: float = 6.0
    pause_min_s: float = 90.0
    pause_max_s: float = 300.0
    offline_after_s: float = 1800.0


DEFAULT_CONFIG = PlaybackConfig()


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def stretch_duration_s(real_dur_s: float, pace: float, cfg: PlaybackConfig = DEFAULT_CONFIG) -> float:
    base = clamp(real_dur_s * cfg.stretch_factor, cfg.min_display_s, cfg.max_display_s)
    return base / max(pace, 1.0)


def compute_pace(queued: int, cfg: PlaybackConfig = DEFAULT_CONFIG) -> float:
    if queued <= cfg.calm_queue:
        return 1.0
    return clamp(1.0 + (queued - cfg.calm_queue) * cfg.pace_per_extra, 1.0, cfg.max_pace)


def classify_busy(total_pending: int, pace: float) -> str:
    if total_pending == 0:
        return "IDLE"
    if pace < 1.5:
        return "NORMAL"
    if pace < 3.0:
        return "BUSY"
    return "SWAMPED"
```

- [ ] **步骤 4：运行验证通过**

```bash
cd backend && pytest tests/services/digital/test_playback_engine.py -v
```
预期：4 个 PASS

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/digital/playback_engine.py backend/tests/services/digital/
git commit -m "feat(数字员工): 伸展引擎纯函数 stretch/pace/busy + 单测"
```

---

## 任务 1：advance() 状态机（TDD）

**文件：**
- 修改：`backend/tests/services/digital/test_playback_engine.py`
- 修改：`backend/app/services/digital/playback_engine.py`

- [ ] **步骤 1：追加 advance 测试**

在 `test_playback_engine.py` 末尾追加：

```python
from app.services.digital.playback_engine import (
    PlaybackState,
    RealTask,
    advance,
)


def _task(task_id="t1", status="RUNNING", started=T0, ended=None, step=None, meta=None):
    return RealTask(
        task_id=task_id, task_name="润茗/payment_report", task_type="payment_report",
        status=status, progress_percent=0, current_step=step,
        started_at=started, ended_at=ended, metadata=meta or {"project_name": "润茗", "report_label": "Payment Report"},
    )


def test_empty_tasks_idle():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [], T0, CFG)
    assert snap.display_status == "IDLE"


def test_stale_heartbeat_offline():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [], T0, CFG, last_heartbeat_at=T0 - timedelta(seconds=3600))
    assert snap.display_status == "OFFLINE"


def test_first_task_starts_working_with_stretched_duration():
    state = PlaybackState(employee_id=1)
    new, snap = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0, CFG)
    assert snap.display_status == "WORKING"
    assert new.current_task_id == "t1"
    assert new.display_duration_s == 3600.0  # 5min 真实 → 1h 展示


def test_progress_smooth_and_monotonic():
    state = PlaybackState(
        employee_id=1, current_task_id="t1",
        display_started_at=T0, display_duration_s=3600.0,
    )
    _, snap_a = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=1800), CFG)
    _, snap_b = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=1801), CFG)
    assert snap_a.virtual_progress == 50.0
    assert snap_b.virtual_progress > snap_a.virtual_progress
    assert snap_b.virtual_progress < 100.0


def test_completion_inserts_pause():
    state = PlaybackState(
        employee_id=1, current_task_id="t1",
        display_started_at=T0, display_duration_s=3600.0,
    )
    new, snap = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=3600), CFG)
    assert snap.virtual_progress == 100.0
    assert new.virtual_index == 1
    assert new.pause_until is not None
    # 停顿窗口内再次 advance → PAUSING
    _, snap2 = advance(new, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=3601), CFG)
    assert snap2.display_status == "PAUSING"


def test_queue_builds_up_pace():
    tasks = [
        _task(task_id=f"t{i}", started=T0 + timedelta(seconds=i), ended=T0 + timedelta(seconds=60 + i))
        for i in range(6)
    ]
    state = PlaybackState(employee_id=1)
    new, snap = advance(state, tasks, T0, CFG)
    # 当前 1 个 + 排队 5 个 → pace = 1 + (5-1)*0.5 = 3.0
    assert snap.pace == 3.0
    assert snap.queued_count == 5
    assert snap.busy_level in ("BUSY", "SWAMPED")


def test_failed_task_label_has_warning_prefix():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [_task(status="FAILED", ended=T0 + timedelta(seconds=300))], T0, CFG)
    assert "⚠️" in snap.step_label
```

- [ ] **步骤 2：运行验证失败**

```bash
cd backend && pytest tests/services/digital/test_playback_engine.py -v
```
预期：新增 7 个 FAIL（`cannot import name 'advance'`）

- [ ] **步骤 3：实现 advance 与辅助函数**

在 `playback_engine.py` 末尾追加：

```python
def _real_duration_s(task: RealTask, now: datetime) -> float:
    end = task.ended_at or now
    return max((end - task.started_at).total_seconds(), 1.0)


def _pause_seconds(employee_id: int, virtual_index: int, pace: float, cfg: PlaybackConfig) -> float:
    seed = hashlib.md5(f"{employee_id}:{virtual_index}".encode()).hexdigest()
    frac = int(seed[:8], 16) / 0xFFFFFFFF
    base = cfg.pause_min_s + (cfg.pause_max_s - cfg.pause_min_s) * frac
    return base / max(pace, 1.0)


def _step_label(task: RealTask) -> str:
    meta = task.metadata or {}
    project = meta.get("project_name") or ""
    report = meta.get("report_label") or task.task_name
    prefix = "⚠️ " if task.status.upper() == "FAILED" else ""
    if task.current_step:
        return f"{prefix}{task.current_step}"
    if project:
        return f"{prefix}正在处理【{project}】的 {report}…"
    return f"{prefix}正在处理 {report}…"


def advance(
    state: PlaybackState,
    real_tasks: list[RealTask],
    now: datetime,
    cfg: PlaybackConfig = DEFAULT_CONFIG,
    last_heartbeat_at: datetime | None = None,
) -> tuple[PlaybackState, VirtualSnapshot]:
    ordered = sorted(real_tasks, key=lambda t: t.started_at)
    pending = ordered[state.virtual_index:]
    current = next((t for t in pending if t.task_id == state.current_task_id), None)
    queued = len(pending) - (1 if current else 0)
    pace = compute_pace(queued, cfg)
    busy = classify_busy(len(pending), pace)

    def snap(status: str, task: RealTask | None, progress: float, label: str) -> VirtualSnapshot:
        return VirtualSnapshot(
            employee_id=state.employee_id, display_status=status, current_task=task,
            virtual_progress=round(progress, 1), step_label=label,
            pace=pace, busy_level=busy, queued_count=queued,
        )

    new = replace(state, pace=pace, busy_level=busy, last_advanced_at=now)

    if new.pause_until and now < new.pause_until:
        return new, snap("PAUSING", current, new.virtual_progress, "🍵 稍作整理…")

    if current is None:
        if pending:
            nxt = pending[0]
            new.current_task_id = nxt.task_id
            new.display_started_at = now
            new.display_duration_s = stretch_duration_s(_real_duration_s(nxt, now), pace, cfg)
            new.virtual_progress = 0.0
            new.pause_until = None
            return new, snap("WORKING", nxt, 0.0, _step_label(nxt))
        new.current_task_id = None
        new.virtual_progress = 0.0
        if last_heartbeat_at and (now - last_heartbeat_at).total_seconds() > cfg.offline_after_s:
            return new, snap("OFFLINE", None, 0.0, "🌙 今日工作告一段落")
        return new, snap("IDLE", None, 0.0, "🍵 静候下一批任务…")

    elapsed = (now - (new.display_started_at or now)).total_seconds()
    progress = clamp(elapsed / max(new.display_duration_s, 1.0) * 100.0, 0.0, 100.0)
    new.virtual_progress = progress

    if progress >= 100.0:
        new.virtual_index = state.virtual_index + 1
        new.current_task_id = None
        new.pause_until = now + timedelta(
            seconds=_pause_seconds(state.employee_id, new.virtual_index, pace, cfg)
        )
        label = "✅ 处理完成，整理中…" if current.status.upper() != "FAILED" else "⚠️ 处理失败，正在排查…"
        return new, snap("PAUSING", current, 100.0, label)

    return new, snap("WORKING", current, progress, _step_label(current))
```

- [ ] **步骤 4：运行验证通过**

```bash
cd backend && pytest tests/services/digital/test_playback_engine.py -v
```
预期：全部 11 个 PASS

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/digital/playback_engine.py backend/tests/services/digital/test_playback_engine.py
git commit -m "feat(数字员工): 伸展引擎 advance 状态机 + 7 个单测"
```

---

## 任务 2：playback 持久化模型 + 迁移

**文件：**
- 创建：`backend/app/models/digital_employee_playback.py`
- 修改：模型注册处（`grep -rn "DigitalEmployee" backend/app/models/__init__.py`，若无则查 alembic env 如何 import models）
- 创建：`backend/alembic/versions/xxxx_add_digital_employee_playback.py`

- [ ] **步骤 1：创建模型**

```python
# backend/app/models/digital_employee_playback.py
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class DigitalEmployeePlayback(Base):
    """每员工一行的虚拟播放游标（拟人化伸展引擎状态）。"""
    __tablename__ = "digital_employee_playback"

    employee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("digital_employees.id", ondelete="CASCADE"), primary_key=True
    )
    virtual_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    virtual_progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    display_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    display_duration_s: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    pause_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pace: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    busy_level: Mapped[str] = mapped_column(String(16), nullable=False, default="IDLE")
    last_advanced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
```

- [ ] **步骤 2：注册到 metadata**

在模型聚合 import 处（与 `DigitalEmployee` 同处）追加 `from app.models.digital_employee_playback import DigitalEmployeePlayback  # noqa: F401`。用 `grep -rn "import DigitalEmployee\b" backend/app` 定位。

- [ ] **步骤 3：生成迁移骨架**

```bash
cd backend && alembic revision -m "add digital_employee_playback"
```
预期：在 `alembic/versions/` 生成新文件，`down_revision` 自动指向当前 head。

- [ ] **步骤 4：填写 upgrade/downgrade（显式建表，不依赖 autogenerate）**

```python
def upgrade() -> None:
    op.create_table(
        "digital_employee_playback",
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("digital_employees.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("virtual_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("current_task_id", sa.String(length=64), nullable=True),
        sa.Column("virtual_progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("display_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("display_duration_s", sa.Float(), nullable=False, server_default="0"),
        sa.Column("pause_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pace", sa.Float(), nullable=False, server_default="1"),
        sa.Column("busy_level", sa.String(length=16), nullable=False, server_default="IDLE"),
        sa.Column("last_advanced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("digital_employee_playback")
```
（文件顶部确保 `import sqlalchemy as sa`。）

- [ ] **步骤 5：在测试库执行迁移并验证**

```bash
cd backend && alembic upgrade head
```
预期：无报错，`digital_employee_playback` 建表成功。

- [ ] **步骤 6：Commit**

```bash
git add backend/app/models/ backend/alembic/versions/
git commit -m "feat(数字员工): 新增 digital_employee_playback 表与迁移"
```

---

## 任务 3：office_service（DB 编排 + 富化，TDD）

**文件：**
- 创建：`backend/app/services/digital/office_service.py`
- 创建：`backend/tests/services/digital/test_office_service.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/services/digital/test_office_service.py
from datetime import datetime, timedelta, UTC

from app.models.digital_employee import DigitalEmployee, DigitalEmployeeTask, EmployeeType, TaskStatus
from app.services.digital.office_service import advance_employee, build_wall_snapshot


def _seed_employee_with_task(db_session):
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
    emp = _seed_employee_with_task(db_session)
    snap = advance_employee(db_session, emp, datetime.now(UTC))
    assert snap["employee_id"] == emp.id
    assert snap["display_status"] in ("WORKING", "PAUSING")
    assert snap["work_item"]["project_name"] == "润茗"
    # 再调一次：游标已持久化，virtual_progress 不回退
    snap2 = advance_employee(db_session, emp, datetime.now(UTC))
    assert snap2["virtual_progress"] >= snap["virtual_progress"]


def test_build_wall_snapshot_lists_all_active_employees(db_session):
    _seed_employee_with_task(db_session)
    wall = build_wall_snapshot(db_session, datetime.now(UTC))
    assert isinstance(wall, list)
    assert len(wall) >= 1
    assert "persona" in wall[0]
```

- [ ] **步骤 2：运行验证失败**

```bash
cd backend && pytest tests/services/digital/test_office_service.py -v
```
预期：FAIL（`ModuleNotFoundError: office_service`）。注：需 `TEST_DATABASE_URL`，否则 skip。

- [ ] **步骤 3：实现 office_service**

```python
# backend/app/services/digital/office_service.py
"""虚拟办公室编排：读真实任务 → 伸展引擎 advance → 持久化游标 → 富化展示字段。"""
from __future__ import annotations

import json
from datetime import datetime, UTC

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.digital_employee import DigitalEmployee, DigitalEmployeeTask
from app.models.digital_employee_playback import DigitalEmployeePlayback
from app.services.digital.playback_engine import (
    DEFAULT_CONFIG,
    PlaybackState,
    RealTask,
    advance,
)

# persona 与前端 PERSONA_MAP 对齐（emoji/color_key/tagline）
PERSONA_BY_TYPE = {
    "AUTO_REPORT_UPLOAD": {"emoji": "📤", "color_key": "blue", "tagline": "报表快递员"},
    "SCHEDULED_JOB": {"emoji": "⏰", "color_key": "orange", "tagline": "定时指挥官"},
    "RPA_BOT": {"emoji": "🤖", "color_key": "violet", "tagline": "流程机器人"},
    "AI_AGENT": {"emoji": "💬", "color_key": "emerald", "tagline": "洞察分析师"},
    "MONITORING": {"emoji": "📊", "color_key": "pink", "tagline": "数据观察员"},
    "DATABASE": {"emoji": "🗄️", "color_key": "slate", "tagline": "数据库守护者"},
    "CUSTOM": {"emoji": "⚙️", "color_key": "gray", "tagline": "自定义任务"},
}


def _load_state(db: Session, employee_id: int) -> tuple[PlaybackState, DigitalEmployeePlayback]:
    row = db.get(DigitalEmployeePlayback, employee_id)
    if row is None:
        row = DigitalEmployeePlayback(employee_id=employee_id)
        db.add(row)
        db.flush()
    state = PlaybackState(
        employee_id=row.employee_id, virtual_index=row.virtual_index,
        current_task_id=row.current_task_id, virtual_progress=row.virtual_progress,
        display_started_at=row.display_started_at, display_duration_s=row.display_duration_s,
        pause_until=row.pause_until, pace=row.pace, busy_level=row.busy_level,
        last_advanced_at=row.last_advanced_at,
    )
    return state, row


def _persist(row: DigitalEmployeePlayback, state: PlaybackState) -> None:
    row.virtual_index = state.virtual_index
    row.current_task_id = state.current_task_id
    row.virtual_progress = state.virtual_progress
    row.display_started_at = state.display_started_at
    row.display_duration_s = state.display_duration_s
    row.pause_until = state.pause_until
    row.pace = state.pace
    row.busy_level = state.busy_level
    row.last_advanced_at = state.last_advanced_at


def _to_real_tasks(rows: list[DigitalEmployeeTask]) -> list[RealTask]:
    out = []
    for t in rows:
        meta = None
        if t.metadata_json:
            try:
                meta = json.loads(t.metadata_json)
            except (ValueError, TypeError):
                meta = None
        out.append(RealTask(
            task_id=t.task_id, task_name=t.task_name, task_type=t.task_type,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            progress_percent=t.progress_percent, current_step=t.current_step,
            started_at=t.started_at or t.created_at, ended_at=t.ended_at, metadata=meta,
        ))
    return out


def advance_employee(db: Session, employee: DigitalEmployee, now: datetime) -> dict:
    state, row = _load_state(db, employee.id)
    task_rows = list(db.execute(
        select(DigitalEmployeeTask)
        .where(DigitalEmployeeTask.employee_id == employee.id)
        .order_by(DigitalEmployeeTask.started_at.asc())
    ).scalars().all())
    new_state, snap = advance(state, _to_real_tasks(task_rows), now, DEFAULT_CONFIG, employee.last_heartbeat_at)
    _persist(row, new_state)
    db.commit()
    return _enrich(employee, snap, task_rows)


def _enrich(employee: DigitalEmployee, snap, task_rows: list[DigitalEmployeeTask]) -> dict:
    persona = dict(PERSONA_BY_TYPE.get(employee.employee_type.value, PERSONA_BY_TYPE["CUSTOM"]))
    meta = snap.current_task.metadata if snap.current_task else None
    today_done = sum(1 for t in task_rows if (t.status.value if hasattr(t.status, "value") else t.status) == "succeeded")
    total = len(task_rows) or 1
    succeeded = today_done
    return {
        "employee_id": employee.id,
        "name": employee.name,
        "persona": persona,
        "display_status": snap.display_status,
        "busy_level": snap.busy_level,
        "queued_count": snap.queued_count,
        "pace": snap.pace,
        "current_task": (
            {"task_id": snap.current_task.task_id, "task_name": snap.current_task.task_name, "status": snap.current_task.status}
            if snap.current_task else None
        ),
        "work_item": {"project_name": (meta or {}).get("project_name"), "report_label": (meta or {}).get("report_label")},
        "virtual_progress": snap.virtual_progress,
        "step_label": snap.step_label,
        "today_done": today_done,
        "success_rate": round(succeeded / total, 2),
        "last_heartbeat_at": employee.last_heartbeat_at.isoformat() if employee.last_heartbeat_at else None,
    }


def build_wall_snapshot(db: Session, now: datetime) -> list[dict]:
    employees = list(db.execute(
        select(DigitalEmployee).where(DigitalEmployee.is_deleted == 0)
    ).scalars().all())
    return [advance_employee(db, e, now) for e in employees]
```

- [ ] **步骤 4：运行验证通过**

```bash
cd backend && pytest tests/services/digital/test_office_service.py -v
```
预期：2 个 PASS

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/digital/office_service.py backend/tests/services/digital/test_office_service.py
git commit -m "feat(数字员工): office_service 编排伸展引擎并富化工牌快照"
```

---

## 任务 4：SSE 端点（TDD）

**文件：**
- 创建：`backend/app/api/v1/endpoints/digital_office.py`
- 修改：v1 路由聚合处（`grep -rn "include_router" backend/app/api`）
- 创建：`backend/tests/api/test_digital_office_stream.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/api/test_digital_office_stream.py
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app() -> FastAPI:
    from app.api.v1.endpoints.digital_office import router
    from app.api.deps import protected

    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.include_router(router, prefix="/api/v1")
    return app


def test_office_stream_is_sse(db_session):
    client = TestClient(_app())
    with client.stream("GET", "/api/v1/digital-employees/office/stream") as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        # 读到第一个 snapshot 事件即断开
        for line in resp.iter_lines():
            if line.startswith("data:"):
                assert "employees" in line
                break
```

- [ ] **步骤 2：运行验证失败**

```bash
cd backend && pytest tests/api/test_digital_office_stream.py -v
```
预期：FAIL（`ModuleNotFoundError: digital_office`）

- [ ] **步骤 3：实现 SSE 端点**

```python
# backend/app/api/v1/endpoints/digital_office.py
import asyncio
import json
from datetime import datetime, UTC

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.deps import get_primary_db_session, protected
from app.services.digital.office_service import build_wall_snapshot

router = APIRouter(prefix="/digital-employees", tags=["digital-employees"])

TICK_SECONDS = 3.0


async def _event_stream(db):
    while True:
        now = datetime.now(UTC)
        employees = build_wall_snapshot(db, now)
        payload = json.dumps({"server_time": now.isoformat(), "employees": employees}, ensure_ascii=False)
        yield f"event: snapshot\ndata: {payload}\n\n"
        await asyncio.sleep(TICK_SECONDS)


@router.get("/office/stream")
def office_stream(db=Depends(get_primary_db_session), _=Depends(protected)):
    return StreamingResponse(_event_stream(db), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # 关掉 nginx 缓冲
    })
```

- [ ] **步骤 4：注册路由**

在 v1 路由聚合处（`grep -rn "include_router" backend/app/api`）追加 `from app.api.v1.endpoints.digital_office import router as digital_office_router` + `api_router.include_router(digital_office_router)`（仿照 digital_employees 的注册方式）。

- [ ] **步骤 5：运行验证通过**

```bash
cd backend && pytest tests/api/test_digital_office_stream.py -v
```
预期：PASS（含 `text/event-stream` 断言）

- [ ] **步骤 6：Commit**

```bash
git add backend/app/api/v1/endpoints/digital_office.py backend/tests/api/test_digital_office_stream.py backend/app/api/
git commit -m "feat(数字员工): 新增 /office/stream SSE 端点推送工牌墙快照"
```

---

## 任务 5：Agent 模拟器（端到端验证用）

**文件：**
- 创建：`backend/scripts/simulate_agent.py`

- [ ] **步骤 1：实现模拟器**

```python
# backend/scripts/simulate_agent.py
"""通过心跳 API 喂一个假 Agent，用于本地端到端验证伸展引擎。

用法：
  python scripts/simulate_agent.py --base http://localhost:8000 --count 3
会注册一个员工并上报 count 个短任务（每个真实约 5 秒完成）。
"""
import argparse
import time
import uuid

import requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://localhost:8000")
    p.add_argument("--count", type=int, default=3)
    args = p.parse_args()
    api = f"{args.base}/api/v1/digital-employees"

    r = requests.post(f"{api}/register", json={
        "name": "模拟快递员", "employee_type": "auto_report_upload",
        "description": "端到端验证用", "is_silent_alert_threshold_minutes": 30,
    })
    r.raise_for_status()
    emp_id, secret = r.json()["id"], r.json()["api_secret"]
    print(f"registered employee_id={emp_id}")

    for i in range(args.count):
        task_id = f"sim-{uuid.uuid4().hex[:8]}"
        requests.post(f"{api}/{emp_id}/heartbeat", params={"api_secret": secret}, json={
            "task_id": task_id, "status": "RUNNING", "progress_percent": 10,
            "current_step": "数据识别完成", "message": f"开始处理 sim-{i}",
        })
        time.sleep(5)  # 真实 5 秒"做完"
        requests.post(f"{api}/{emp_id}/heartbeat", params={"api_secret": secret}, json={
            "task_id": task_id, "status": "SUCCEEDED", "progress_percent": 100,
            "current_step": "完成", "message": f"完成 sim-{i}",
        })
        print(f"task {i} reported")
    print("done — 打开前端 /office 观察是否被拉伸成慢播")


if __name__ == "__main__":
    main()
```

> 注：`heartbeat` 端点当前不创建 task（只更新已存在的 task）。若模拟器跑不通，需在 `employee_service.heartbeat` 里对"未知 task_id 且 status=RUNNING"自动 `start_task`——作为本任务的一个子步骤验证并补上（参考 `digital_employee_reporter.start_task` 的幂等实现）。

- [ ] **步骤 2：手动验证**

```bash
cd backend && python scripts/simulate_agent.py --count 3
# 查库确认 task 落库
```
预期：3 个 task 写入 `digital_employee_tasks`。

- [ ] **步骤 3：Commit**

```bash
git add backend/scripts/simulate_agent.py backend/app/services/digital/employee_service.py
git commit -m "feat(数字员工): Agent 模拟器脚本 + heartbeat 自动建 task"
```

---

## 任务 6：前端 SSE 类型 + useOfficeStream hook（含 Vitest）

**文件：**
- 创建：`frontend/lib/digital-employee/office-stream-types.ts`
- 创建：`frontend/lib/digital-employee/use-office-stream.ts`
- 创建：`frontend/lib/digital-employee/__tests__/office-stream.test.ts`

- [ ] **步骤 1：定义类型**

```typescript
// frontend/lib/digital-employee/office-stream-types.ts
export type DisplayStatus = 'WORKING' | 'PAUSING' | 'IDLE' | 'OFFLINE' | 'FAILED'
export type BusyLevel = 'IDLE' | 'NORMAL' | 'BUSY' | 'SWAMPED'

export interface OfficePersona {
  emoji: string
  color_key: string
  tagline: string
}

export interface OfficeEmployee {
  employee_id: number
  name: string
  persona: OfficePersona
  display_status: DisplayStatus
  busy_level: BusyLevel
  queued_count: number
  pace: number
  current_task: { task_id: string; task_name: string; status: string } | null
  work_item: { project_name: string | null; report_label: string | null }
  virtual_progress: number
  step_label: string
  today_done: number
  success_rate: number
  last_heartbeat_at: string | null
}

export interface OfficeSnapshot {
  server_time: string
  employees: OfficeEmployee[]
}

export function parseSnapshot(raw: string): OfficeSnapshot | null {
  try {
    const data = JSON.parse(raw) as OfficeSnapshot
    if (!Array.isArray(data.employees)) return null
    return data
  } catch {
    return null
  }
}
```

- [ ] **步骤 2：写解析逻辑单测**

```typescript
// frontend/lib/digital-employee/__tests__/office-stream.test.ts
import { describe, it, expect } from 'vitest'
import { parseSnapshot } from '../office-stream-types'

describe('parseSnapshot', () => {
  it('解析合法快照', () => {
    const snap = parseSnapshot('{"server_time":"x","employees":[]}')
    expect(snap?.employees).toEqual([])
  })
  it('非法 JSON 返回 null', () => {
    expect(parseSnapshot('not-json')).toBeNull()
  })
  it('缺 employees 返回 null', () => {
    expect(parseSnapshot('{"server_time":"x"}')).toBeNull()
  })
})
```

- [ ] **步骤 3：运行验证失败 → 实现 hook → 通过**

```bash
cd frontend && pnpm test office-stream
```
预期：先 FAIL（模块缺失），实现 `office-stream-types.ts` 后 3 个 PASS。

实现 hook：

```typescript
// frontend/lib/digital-employee/use-office-stream.ts
'use client'
import { useEffect, useRef, useState } from 'react'
import { parseSnapshot, type OfficeEmployee } from './office-stream-types'

const STREAM_URL = '/api/backend/api/v1/digital-employees/office/stream'

export function useOfficeStream() {
  const [employees, setEmployees] = useState<OfficeEmployee[]>([])
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource(STREAM_URL)
    sourceRef.current = es
    es.addEventListener('snapshot', (e) => {
      const snap = parseSnapshot((e as MessageEvent).data)
      if (snap) setEmployees(snap.employees)
    })
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)  // EventSource 自动重连
    return () => es.close()
  }, [])

  return { employees, connected }
}
```

- [ ] **步骤 4：Commit**

```bash
git add frontend/lib/digital-employee/
git commit -m "feat(数字员工): 前端 SSE 类型与 useOfficeStream hook + 单测"
```

---

## 任务 7：OfficeBadge 工牌组件

**文件：**
- 创建：`frontend/components/digital-employee/office/office-badge.tsx`

- [ ] **步骤 1：实现工牌（突出工作事项，走设计 token + Badge 语义 variant）**

```tsx
// frontend/components/digital-employee/office/office-badge.tsx
'use client'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OfficeEmployee, DisplayStatus } from '@/lib/digital-employee/office-stream-types'

const STATUS_BADGE: Record<DisplayStatus, { variant: 'info' | 'warning' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  WORKING: { variant: 'info', label: '在岗' },
  PAUSING: { variant: 'secondary', label: '收尾' },
  IDLE: { variant: 'outline', label: '待命' },
  OFFLINE: { variant: 'outline', label: '离线' },
  FAILED: { variant: 'destructive', label: '失败' },
}

export function OfficeBadge({ employee }: { employee: OfficeEmployee }) {
  const { persona, work_item, display_status, busy_level, virtual_progress, step_label, queued_count, today_done, success_rate } = employee
  const status = STATUS_BADGE[display_status]
  const busy = busy_level === 'BUSY' || busy_level === 'SWAMPED'
  const hero = work_item.project_name
    ? `【${work_item.project_name}】${work_item.report_label ?? ''}`
    : (employee.current_task?.task_name ?? '暂无任务')

  return (
    <div
      className={cn(
        'dashboard-surface u-interactive flex flex-col gap-3 p-4',
        busy && 'ring-1 ring-warning/40 shadow-raised',
        display_status === 'OFFLINE' && 'opacity-60 saturate-50'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-lg">{persona.emoji}</span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{employee.name}</p>
            <p className="dashboard-kicker">{persona.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {busy && <span className="text-xs">🔥</span>}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </div>

      <div className="min-h-[3.5rem]">
        <p className="dashboard-kicker">正在处理</p>
        <p className="dashboard-display text-foreground" style={{ fontSize: 'clamp(1.25rem, 2vw, 1.6rem)' }}>{hero}</p>
      </div>

      <div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[2800ms] ease-linear"
            style={{ width: `${Math.max(2, virtual_progress)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{step_label}</p>
      </div>

      <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span>今日 {today_done} 件 · 成功率 {Math.round(success_rate * 100)}%</span>
        {queued_count > 0 && <span className="text-warning">排队 {queued_count}</span>}
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：lint + build 验证**

```bash
cd frontend && pnpm lint && pnpm build
```
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/digital-employee/office/office-badge.tsx
git commit -m "feat(数字员工): OfficeBadge 工牌组件（突出工作事项）"
```

---

## 任务 8：/office 页面 + 路由入口

**文件：**
- 创建：`frontend/app/dashboard/ai/digital-employees/office/page.tsx`
- 修改（可选）：`frontend/lib/sidebar-config.ts` 加入口

- [ ] **步骤 1：实现页面**

```tsx
// frontend/app/dashboard/ai/digital-employees/office/page.tsx
'use client'
import { useOfficeStream } from '@/lib/digital-employee/use-office-stream'
import { OfficeBadge } from '@/components/digital-employee/office/office-badge'
import { Skeleton } from '@/components/ui/skeleton'

export default function DigitalOfficePage() {
  const { employees, connected } = useOfficeStream()

  return (
    <div className="dashboard-page-shell space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="dashboard-display">虚拟办公室</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {connected ? `🟢 实时同步中 · 在岗 ${employees.length} 位员工` : '🔌 连接中…'}
          </p>
        </div>
      </header>

      {employees.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {employees.map((e) => <OfficeBadge key={e.employee_id} employee={e} />)}
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：lint + build + test 验证**

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
预期：全 PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/ai/digital-employees/office/ frontend/lib/sidebar-config.ts
git commit -m "feat(数字员工): /office 工牌墙页面 + 路由入口"
```

---

## 任务 9：端到端验证 + 代理 SSE 透传确认

**文件：** 无（验证）

- [ ] **步骤 1：验证 Next.js 代理透传 SSE**

启动后端 + 前端，浏览器开 DevTools Network 看 `/api/backend/api/v1/digital-employees/office/stream`：
- 若为 `text/event-stream` 且持续收到 `event: snapshot` → 通过。
- 若被缓冲/一次性返回 → 在代理 route（`frontend/app/api/backend/[...path]/route.ts`）显式流式透传，或让 `EventSource` 直连后端同源地址。修复后重测。

- [ ] **步骤 2：跑模拟器 + 观察拉伸**

```bash
cd backend && python scripts/simulate_agent.py --count 3
```
打开 `http://localhost:3200/dashboard/ai/digital-employees/office`。

- [ ] **步骤 3：业务测试清单（交用户手动验）**

| 场景 | 预期 |
|------|------|
| 模拟器上报 1 个 5 秒任务 | 工牌进入"在岗"，进度条**缓慢**爬升（拉伸到 ~1h），不跳变 |
| 连续上报 3 个任务 | 排队计数出现，pace 升高、进度加快消化 |
| 任务播完 | 进入"收尾/PAUSING"，停顿后回"待命" |
| 30 分钟无心跳 | 工牌变"离线"、压暗 |
| 浏览器刷新 | 重新连接 SSE，游标已持久化、进度不回退 |

- [ ] **步骤 4：Commit（如有修复）**

```bash
git status  # 按需提交代理修复
```

---

## Phase 1 完成判定
- [ ] 引擎 11 个单测 + service 2 个 + SSE 端点测试全绿
- [ ] 前端 lint/build/test 全绿
- [ ] 模拟器驱动下，前端工牌把 5 秒真实任务拉伸成慢播、进度平滑、多任务加速、失败告警
- [ ] 顶部状态：在本文件标题下追加 `> **状态：** ✅ Phase 1 完成`，并起草 Phase 2 文件
