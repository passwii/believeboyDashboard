# 退货分析原始数据导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/dashboard/operations/return-analysis` 页新增「原始数据」Tab，并让导出的 Excel 多一张「亚马逊原始数据」sheet，内容为该周期当前生效的亚马逊退货报表原始行（17 列，含中文翻译列）。

**Architecture:** 后端把「当前生效退货行」查询抽成唯一共享函数 `query_current_return_rows()`（fallback / snapshot 两条分析路径都改调它，锁死口径），并新增独立只读端点 `GET /api/v1/return-analysis/raw-rows` 返回原始行 + 中文翻译列；前端**懒加载**该端点（切 Tab 或点导出才发请求），表格与 Excel 共用一份列配置 `RETURN_RAW_COLUMNS`。主响应、Redis 缓存、Agent 通道、现有 5 张 sheet 全部零改动。

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic（后端，pytest 打 `BLF_test` 库）；Next.js App Router + React + TypeScript + exceljs + Vitest/jsdom（前端）。

**Spec:** `docs/superpowers/specs/2026-09-14-return-analysis-raw-data-export-design.md`（本计划的唯一需求来源，冲突以 spec 为准）

---

## Global Constraints

- **不改**：`/api/v1/return-analysis` 主响应与 Redis v2 缓存、`build_return_analysis()` 输出 schema、Agent 5 条退货路由、`/return-analysis-raw` 的 PII 白名单（永不返回 `customer_comments` / `raw_row` / `fnsku` / `license_plate_number`）、现有 5 张 Excel sheet 的顺序与内容。
- **无数据库迁移**（不加表、不加列）；**无 API 破坏性变更**（纯新增端点）。
- **对账硬要求**：原始 sheet 的 `quantity` 合计必须等于分析 `summary.total_quantity`，由测试锁死（Task 1 / Task 2 各一条）。
- **安全阀**：单次返回上限 `MAX_RAW_ROWS = 50_000`，超限显式 400，**禁止静默截断**。
- **切周期防串数据**：`loadData()` 必须先清空 `rawRows`，旧周期原始行绝不进表格或导出文件。
- **导出失败即中止**：原始行拉取失败时不产出文件（不输出「缺 sheet 的假完整包」）。
- **提交规范**：中文 + Conventional Commits，scope 用中文，subject 动宾短语 ≤50 字、无句号。
- **提交纪律**：只用显式路径 `git add <file>...`；**禁止** `git add -A` / `git add .` / `git commit -a`（主 checkout 里有另一会话的未提交改动）。
- **测试库纪律**：pytest 一律打 `BLF_test`，绝不写 `BLF`。

## 环境准备（已实测完成，执行者不要重复创建）

工作目录固定在 worktree，**所有命令的 `<WT>` = `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/return-analysis-raw-data`**：

| 项 | 状态 |
|---|---|
| worktree / 分支 | `.worktrees/return-analysis-raw-data` @ `feat/return-analysis-raw-data`，基线 = `main`（含 spec commit `f2d450f2`） |
| `.worktrees/` 是否被忽略 | 是（`.gitignore:22`），`git status` 干净 |
| `backend/.env`、`backend/.env.test` | 已软链到主 checkout（gitignore 规则匹配软链，不污染 status） |
| `frontend/node_modules` | 已软链到主 checkout（主 checkout 的 79 个悬空软链已被修复） |
| `backend/.venv` | **故意不软链**：`.gitignore` 的 `/backend/.venv/` 是目录规则，软链会被 git 当成未跟踪文件。一律用绝对路径调用主 checkout 的解释器 |
| `pnpm` | 本沙箱不可用（corepack 要写工作区外的 `COREPACK_HOME`）。用等价直连二进制，仓库标准命令并列给出 |

**本计划使用的命令（全部已实测通过）：**

```bash
# 后端单测 / 全量（cwd 必须是 worktree 的 backend，import 才会取 worktree 代码）
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/<path> -q
# 前端单测 / lint / 契约检查
cd <WT>/frontend && node_modules/.bin/vitest run app/<path>
cd <WT>/frontend && node_modules/.bin/eslint app/dashboard/operations/return-analysis --ext .ts,.tsx
cd <WT>/frontend && node scripts/gen-api-types.mjs --check
# OpenAPI 导出（worktree 无 .venv，必须显式覆盖 VENV）
cd <WT>/backend && VENV=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python make openapi-export
```

仓库标准命令（在 `pnpm` 健康的环境由用户/CI 跑）：`pnpm lint` → `pnpm build` → `pnpm test`；后端 `cd backend && pytest`。

## 任务总览

| # | 交付物 | 提交信息 |
|---|---|---|
| 1 | 共享查询函数 + 服务层测试（含对账） | `refactor(退货分析): 抽出当前生效退货行共享查询` |
| 2 | 原始行端点 + schema + 常量 + API 测试 | `feat(退货分析): 新增原始行查询端点` |
| 3 | 修复 `openapi_export.py` 懒分组崩溃 + 脚本测试 | `fix(后端): openapi 导出前物化懒分组` |
| 4 | 前端列配置模块 + 单测 | `feat(退货分析): 新增原始数据列配置` |
| 5 | 原始数据 Tab + 懒加载 + 表格 + 测试 | `feat(退货分析): 新增原始数据 Tab 懒加载` |
| 6 | 导出新增「亚马逊原始数据」sheet + 测试 | `feat(退货分析): 导出增加亚马逊原始数据 sheet` |
| 7 | proxy 超时档位 + 测试 | `chore(前端): 原始行端点挂 stats 超时档` |
| 8 | 契约重生成（独立 commit）+ 漂移守卫测试 | `chore(契约): 同步 OpenAPI 与前端生成类型` |

---

### Task 1: 共享查询函数 `query_current_return_rows`

**Files:**
- Create: `backend/app/services/analysis/return_analysis/queries.py`
- Modify: `backend/app/services/analysis/return_analysis/analysis.py:12-17`（顶层 models import）、`:721-740`（fallback 查询块）、`:1210-1215`（snapshot 局部 import）、`:1246-1263`（snapshot 查询块）
- Modify: `backend/app/services/analysis/return_analysis/__init__.py`
- Test: `backend/tests/services/analysis/return_analysis/test_shared_return_rows_query.py`

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces: `query_current_return_rows(db: Session, *, project_id: int, country: str, start_date: str, end_date: str, sku: str | None = None) -> list[AnalysisReturnRow]`；可从 `app.services.analysis.return_analysis` 或 `app.services.analysis.return_analysis.queries` 导入。语义：只回 `is_current=True` 的 `return_report` 源文件下、`return_date ∈ [start_date, end_date]` 的行，可选 `sku` 精确过滤，排序 `return_date ASC, id ASC`。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/services/analysis/return_analysis/test_shared_return_rows_query.py`：

```python
"""共享查询 ``query_current_return_rows`` 回归（退货分析口径唯一真相源）。

背景：同一个「当前生效退货行」查询曾在三处各写一份（fallback / snapshot /
Agent raw），Agent 那份漏了 ``is_current`` 过滤，口径已经漂移。本测试锁死
共享函数的语义，并用「与分析 summary 对账」防止再次漂移。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.analysis.return_analysis import (
    build_return_analysis,
    query_current_return_rows,
)


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def test_project(db_session):
    """独占测试项目 + 显式 teardown（对齐 test_feedback_dedup 模式）。"""
    from app.models import Project

    project = Project(
        project_name=f"shared-return-rows {uuid.uuid4().hex[:8]}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    try:
        yield pid
    finally:
        db_session.expire_all()
        for table in (
            "analysis_return_rows",
            "analysis_sales_order_rows",
            "analysis_source_files",
            "analysis_return_aggregates",
        ):
            db_session.execute(
                text(f"DELETE FROM {table} WHERE project_id = :pid"), {"pid": pid}
            )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _seed_source(
    db_session,
    project_id: int,
    tag: str,
    *,
    is_current: bool = True,
    version: int = 1,
    country: str = "US",
):
    """建一张 return_report 源文件。

    唯一键是 (project_id, report_type, country, period_start_date,
    period_end_date, version) —— 同国家同周期要建第二张必须换 version。
    """
    from app.models import AnalysisSourceFile

    sf = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type="return_report",
        upload_file_id=f"shared_{tag}_{project_id}",
        upload_file_path=f"/tmp/shared_{tag}.csv",
        original_filename=f"shared_{tag}.csv",
        stored_filename=f"shared_{tag}.csv",
        logical_filename=f"shared_{tag}.csv",
        storage_key=f"shared/{tag}.csv",
        period_start_date=date.today() - timedelta(days=30),
        period_end_date=date.today(),
        is_current=is_current,
        version=version,
        ingestion_status="success",
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)
    return sf


def _add_row(
    db_session,
    *,
    source_file_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date: date,
    license_plate: str,
    row_no: int,
    country: str = "US",
    quantity: int = 1,
):
    from app.models import AnalysisReturnRow

    db_session.add(
        AnalysisReturnRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            return_date=return_date,
            order_id=order_id,
            sku=sku,
            quantity=quantity,
            detailed_disposition="SELLABLE",
            reason="NOT_AS_DESCRIBED",
            status="Unit returned to inventory",
            license_plate_number=license_plate,
            original_return_datetime=f"{return_date.isoformat()}T10:00:00+00:00",
        )
    )
    db_session.commit()


def _window() -> tuple[str, str]:
    """近 7 天窗口（与 Agent 测试同口径：昨天为右端点）。"""
    d = date.today() - timedelta(days=1)
    return (d - timedelta(days=6)).isoformat(), d.isoformat()


def test_returns_only_current_source_file_rows(db_session, test_project):
    """非 current 的旧版本源文件行必须排除（Agent raw 端点曾漏掉这条）。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    current = _seed_source(db_session, test_project, "cur", is_current=True, version=1)
    stale = _seed_source(db_session, test_project, "old", is_current=False, version=2)
    _add_row(
        db_session,
        source_file_id=current.id,
        project_id=test_project,
        order_id="O-CUR",
        sku="S-1",
        return_date=d,
        license_plate="LP-CUR",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=stale.id,
        project_id=test_project,
        order_id="O-OLD",
        sku="S-1",
        return_date=d,
        license_plate="LP-OLD",
        row_no=1,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-CUR"]


def test_excludes_out_of_range_and_other_country(db_session, test_project):
    """日期范围外与别的国家的行都不出现。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf_us = _seed_source(db_session, test_project, "us")
    sf_de = _seed_source(db_session, test_project, "de", country="DE")
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-IN",
        sku="S-1",
        return_date=d,
        license_plate="LP-1",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-BEFORE",
        sku="S-1",
        return_date=date.fromisoformat(start) - timedelta(days=1),
        license_plate="LP-2",
        row_no=2,
    )
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-AFTER",
        sku="S-1",
        return_date=date.fromisoformat(end) + timedelta(days=1),
        license_plate="LP-3",
        row_no=3,
    )
    _add_row(
        db_session,
        source_file_id=sf_de.id,
        project_id=test_project,
        country="DE",
        order_id="O-DE",
        sku="S-1",
        return_date=d,
        license_plate="LP-4",
        row_no=1,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-IN"]


def test_sku_filter(db_session, test_project):
    """传 sku 只回该 SKU；不传回全部。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "sku")
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-A",
        sku="SKU-A",
        return_date=d,
        license_plate="LP-A",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-B",
        sku="SKU-B",
        return_date=d,
        license_plate="LP-B",
        row_no=2,
    )

    filtered = query_current_return_rows(
        db_session,
        project_id=test_project,
        country="US",
        start_date=start,
        end_date=end,
        sku="SKU-A",
    )
    everything = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in filtered] == ["O-A"]
    assert {r.sku for r in everything} == {"SKU-A", "SKU-B"}


def test_ordering_is_return_date_then_id(db_session, test_project):
    """排序确定性：return_date 升序，同日按 id 升序（导出可复现的前提）。"""
    start, end = _window()
    end_date = date.today() - timedelta(days=1)
    earlier = end_date - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "ord")
    # 故意先插较晚的两行，验证结果不是插入顺序
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-1",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L1",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-2",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L2",
        row_no=2,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-EARLY",
        sku="S-1",
        return_date=earlier,
        license_plate="LP-E1",
        row_no=3,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-EARLY", "O-LATE-1", "O-LATE-2"]


def test_parity_with_analysis_summary_total_quantity(db_session, test_project):
    """对账：共享查询 quantity 合计 == 分析 summary.total_quantity（防口径漂移）。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "parity")
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-1",
        sku="S-1",
        return_date=d,
        license_plate="LP-1",
        row_no=1,
        quantity=2,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-2",
        sku="S-2",
        return_date=d,
        license_plate="LP-2",
        row_no=2,
        quantity=3,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )
    analysis = build_return_analysis(
        db_session,
        project_id=test_project,
        country="US",
        start_date=start,
        end_date=end,
    )
    # build_return_analysis 会把 ORM 对象的 return_date 就地改成 str（历史行为），
    # rollback 丢弃这处脏状态，避免 teardown 的 DELETE 触发 autoflush 写坏列。
    # 种子数据是已提交的，rollback 不会丢。
    db_session.rollback()

    assert sum(r.quantity for r in rows) == 5
    assert sum(r.quantity for r in rows) == analysis.summary.total_quantity
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/services/analysis/return_analysis/test_shared_return_rows_query.py -q
```

Expected: `ImportError: cannot import name 'query_current_return_rows'`（collection error，0 passed）。

- [ ] **Step 3: 新建 `queries.py` 并实现共享查询**

创建 `backend/app/services/analysis/return_analysis/queries.py`：

```python
"""退货分析的共享读查询。

独立成模块的原因：`analysis.py` 已 1600+ 行，且同一个「当前生效退货行」
查询曾被三处各写一份（fallback / snapshot / Agent raw），Agent 那份漏了
``is_current`` 过滤导致口径漂移。这里收敛成唯一真相源，分析路径与新端点
都必须调它 —— 唯一的例外是 Agent R3（``query_return_analysis_raw``），
它有分页/排序参数与 PII 剥离契约，另行评估。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from app.models import AnalysisReturnRow, AnalysisSourceFile


def query_current_return_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> list[AnalysisReturnRow]:
    """当前生效版本的退货原始行（退货分析口径唯一真相源）。

    过滤条件与 ``build_return_analysis()`` 的 fallback 路径逐字一致：只取
    ``is_current`` 的 ``return_report`` 源文件下、``return_date`` 落在
    ``[start_date, end_date]`` 区间的行。

    排序 ``return_date ASC, id ASC``：让原始数据导出可复现（分析路径下游
    自行聚合/排序，不受影响）。
    """
    query = (
        db.query(AnalysisReturnRow)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,
            AnalysisReturnRow.return_date >= date.fromisoformat(start_date),
            AnalysisReturnRow.return_date <= date.fromisoformat(end_date),
        )
    )
    if sku:
        query = query.filter(AnalysisReturnRow.sku == sku)

    return (
        query.order_by(
            AnalysisReturnRow.return_date.asc(),
            AnalysisReturnRow.id.asc(),
        )
        .all()
    )


__all__ = ["query_current_return_rows"]
```

- [ ] **Step 4: 把两条分析路径改为调用共享函数**

在 `backend/app/services/analysis/return_analysis/analysis.py` 顶层（第 12-17 行的 models import 之后）加 import：

```python
from app.services.analysis.return_analysis.queries import query_current_return_rows
```

把顶层 models import 里的两个已不再使用的名字删掉，即：

```python
# 改前
from app.models import (
    AnalysisReturnRow,
    AnalysisSourceFile,
    SkuRecord,
    Project,
)

# 改后
from app.models import (
    SkuRecord,
    Project,
)
```

替换 `build_return_analysis()` 里的查询块（原 `analysis.py:721-740`，紧跟 `# Try AnalysisReturnRow (new source linked to AnalysisSourceFile) first` 注释那一段）：

```python
    # 当前生效（is_current）退货报表原始行 —— 与分析口径唯一真相源共用查询
    raw_records: list = query_current_return_rows(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )
```

替换 `build_return_analysis_from_snapshot()` 里的查询块（原 `analysis.py:1244-1263`，`# 2) 从 raw 表读全部 ...` 注释那一段），**保留紧随其后的 return_date 归一循环**：

```python
    # 2) 从 raw 表读全部 (project, country, date 范围) 行（用于分布维）
    records: list = query_current_return_rows(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )
    for r in records:
        # Snapshot 路径重跑时 r.return_date 可能是 date 或 str（取决于 session）
        if hasattr(r.return_date, "isoformat"):
            r.return_date = r.return_date.isoformat()
```

同一函数内的局部 import（原 `analysis.py:1210-1215`）里 `AnalysisReturnRow` 与 `AnalysisSourceFile` 已无引用，删掉，只留仍在用的：

```python
    from app.models import (
        AnalysisReturnAggregate,
        Project,
    )
```

- [ ] **Step 5: 在包 `__init__.py` 导出新函数**

`backend/app/services/analysis/return_analysis/__init__.py` 的 analysis import 块加一行 `query_current_return_rows`：

```python
from app.services.analysis.return_analysis.analysis import (
    _build_sales_aggregates,
    _build_summary_text,
    _safe_rate,
    build_return_analysis,
    build_return_analysis_from_snapshot,
    get_snapshot_last_computed_at,
    is_snapshot_fresh_for_range,
)
from app.services.analysis.return_analysis.queries import query_current_return_rows
```

并在 `__all__` 列表里加 `"query_current_return_rows",`。

- [ ] **Step 6: 跑新测试确认通过**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/services/analysis/return_analysis/test_shared_return_rows_query.py -q
```

Expected: `5 passed`。

- [ ] **Step 7: 跑回归（抽取没改变分析语义）**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/services/analysis/return_analysis tests/api/agent/test_return_read.py tests/api/agent/test_return_coverage.py tests/celery_tasks/test_return_analysis_refresh.py tests/celery_tasks/test_return_analysis_rebuild.py -q
```

Expected: 全绿（0 failed）。若出现 `E712`/未使用 import 类 static 检查报错，按报错提示处理（本仓库现存代码普遍使用 `== True` 比较，属既有风格）。

- [ ] **Step 8: 提交**

```bash
cd <WT> && git add backend/app/services/analysis/return_analysis/queries.py \
  backend/app/services/analysis/return_analysis/analysis.py \
  backend/app/services/analysis/return_analysis/__init__.py \
  backend/tests/services/analysis/return_analysis/test_shared_return_rows_query.py
git commit -m "refactor(退货分析): 抽出当前生效退货行共享查询"
```

---

### Task 2: 端点 `GET /return-analysis/raw-rows`

**Files:**
- Modify: `backend/app/constants/return_thresholds.py`（追加常量）
- Modify: `backend/app/schemas/return_analysis.py`（追加 2 个模型）
- Modify: `backend/app/api/v1/endpoints/return_analysis.py`（imports + 路由）
- Test: `backend/tests/api/test_return_analysis_raw_rows.py`

**Interfaces:**
- Consumes: Task 1 的 `query_current_return_rows(...)`
- Produces: `GET /api/v1/return-analysis/raw-rows?project_id&start_date&end_date&country&sku` → `ReturnRawRowsResponse { project_id, country, start_date, end_date, row_count, rows: ReturnRawRowItem[] }`；`ReturnRawRowItem` 的 17 个字段名即前端 `ReturnRawRow` 类型（Task 4 逐字对齐）。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/api/test_return_analysis_raw_rows.py`：

```python
"""内部退货分析原始行端点测试（GET /api/v1/return-analysis/raw-rows）。

口径（spec §1.1/§2）：只回当前生效（is_current）退货报表源文件下、
return_date 落在所选周期内的行；带中文翻译列；超上限显式 400 不静默截断。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app

WINDOW_DAYS = 6


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def project_id():
    """独占测试项目 + 显式 teardown（competing 会话/历史数据不干扰断言）。"""
    from app.models import Project

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"raw-rows-api {uuid.uuid4().hex[:8]}",
            sort_order=0,
            is_active=False,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id
    finally:
        db.close()

    yield pid

    db = SessionLocal()
    try:
        for table in (
            "analysis_return_rows",
            "analysis_sales_order_rows",
            "analysis_source_files",
            "analysis_return_aggregates",
        ):
            db.execute(text(f"DELETE FROM {table} WHERE project_id = :pid"), {"pid": pid})
        db.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db.commit()
    finally:
        db.close()


def _window() -> tuple[str, str]:
    d = date.today() - timedelta(days=1)
    return (d - timedelta(days=WINDOW_DAYS)).isoformat(), d.isoformat()


def _seed_source(
    project_id: int,
    tag: str,
    *,
    is_current: bool = True,
    version: int = 1,
    country: str = "US",
) -> int:
    """建 return_report 源文件并返回 id（同国家同周期建第二张必须换 version）。"""
    from app.models import AnalysisSourceFile

    db = SessionLocal()
    try:
        sf = AnalysisSourceFile(
            project_id=project_id,
            country=country,
            report_type="return_report",
            upload_file_id=f"rawapi_{tag}_{project_id}",
            upload_file_path=f"/tmp/rawapi_{tag}.csv",
            original_filename=f"rawapi_{tag}.csv",
            stored_filename=f"rawapi_{tag}.csv",
            logical_filename=f"rawapi_{tag}.csv",
            storage_key=f"rawapi/{tag}.csv",
            period_start_date=date.today() - timedelta(days=30),
            period_end_date=date.today(),
            is_current=is_current,
            version=version,
            ingestion_status="success",
        )
        db.add(sf)
        db.commit()
        db.refresh(sf)
        return sf.id
    finally:
        db.close()


def _seed_row(
    project_id: int,
    source_file_id: int,
    *,
    order_id: str,
    sku: str,
    return_date: date,
    license_plate: str,
    row_no: int,
    country: str = "US",
    quantity: int = 1,
    **overrides,
) -> None:
    from app.models import AnalysisReturnRow

    db = SessionLocal()
    try:
        db.add(
            AnalysisReturnRow(
                project_id=project_id,
                country=country,
                source_file_id=source_file_id,
                source_row_no=row_no,
                return_date=return_date,
                order_id=order_id,
                sku=sku,
                asin=overrides.get("asin"),
                fnsku=overrides.get("fnsku"),
                product_name=overrides.get("product_name"),
                quantity=quantity,
                fulfillment_center_id=overrides.get("fulfillment_center_id"),
                detailed_disposition=overrides.get("detailed_disposition", "SELLABLE"),
                reason=overrides.get("reason", "NOT_AS_DESCRIBED"),
                status=overrides.get("status", "Unit returned to inventory"),
                license_plate_number=license_plate,
                original_return_datetime=(
                    f"{return_date.isoformat()}T10:00:00+00:00"
                ),
                customer_comments=overrides.get("customer_comments"),
                raw_row={},
            )
        )
        db.commit()
    finally:
        db.close()


def _qs(project_id: int, **extra) -> str:
    start, end = _window()
    parts = [
        f"project_id={project_id}",
        "country=US",
        f"start_date={start}",
        f"end_date={end}",
    ]
    parts += [f"{k}={v}" for k, v in extra.items()]
    return "/api/v1/return-analysis/raw-rows?" + "&".join(parts)


class TestRawRowsEndpoint:
    def test_returns_rows_with_display_fields(self, client, project_id, admin_headers):
        """基线：字段齐全 + 三个中文翻译列与分析页同源。"""
        d = date.today() - timedelta(days=1)
        sf = _seed_source(project_id, "base")
        _seed_row(
            project_id,
            sf,
            order_id="O-1",
            sku="S-1",
            return_date=d,
            license_plate="LP-1",
            row_no=1,
            asin="B01",
            fnsku="X01",
            product_name="测试商品",
            fulfillment_center_id="PGA1",
            customer_comments="质量差",
        )

        resp = client.get(_qs(project_id), headers=admin_headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == project_id
        assert body["country"] == "US"
        assert body["row_count"] == 1
        assert body["start_date"] == _window()[0]
        assert body["end_date"] == _window()[1]
        row = body["rows"][0]
        assert row["order_id"] == "O-1"
        assert row["sku"] == "S-1"
        assert row["asin"] == "B01"
        assert row["fnsku"] == "X01"
        assert row["product_name"] == "测试商品"
        assert row["quantity"] == 1
        assert row["fulfillment_center_id"] == "PGA1"
        assert row["license_plate_number"] == "LP-1"
        assert row["customer_comment"] == "质量差"
        assert row["return_date"] == d.isoformat()
        assert row["original_return_datetime"].startswith(d.isoformat())
        # 中文翻译列（与 translate_return_field 同源）
        assert row["reason"] == "NOT_AS_DESCRIBED"
        assert row["reason_display"] == "与描述不符"
        assert row["detailed_disposition"] == "SELLABLE"
        assert row["disposition_display"] == "可售"
        assert row["status_display"] == "退回库存"

    def test_excludes_non_current_source_file(self, client, project_id, admin_headers):
        """旧版本源文件（is_current=False）的行不得出现。"""
        d = date.today() - timedelta(days=1)
        current = _seed_source(project_id, "cur", is_current=True, version=1)
        stale = _seed_source(project_id, "old", is_current=False, version=2)
        _seed_row(
            project_id, current, order_id="O-CUR", sku="S-1", return_date=d,
            license_plate="LP-CUR", row_no=1,
        )
        _seed_row(
            project_id, stale, order_id="O-OLD", sku="S-1", return_date=d,
            license_plate="LP-OLD", row_no=1,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-CUR"]

    def test_excludes_out_of_range(self, client, project_id, admin_headers):
        start, end = _window()
        d = date.today() - timedelta(days=1)
        sf = _seed_source(project_id, "range")
        _seed_row(
            project_id, sf, order_id="O-IN", sku="S-1", return_date=d,
            license_plate="LP-IN", row_no=1,
        )
        _seed_row(
            project_id, sf, order_id="O-BEFORE", sku="S-1",
            return_date=date.fromisoformat(start) - timedelta(days=1),
            license_plate="LP-B", row_no=2,
        )
        _seed_row(
            project_id, sf, order_id="O-AFTER", sku="S-1",
            return_date=date.fromisoformat(end) + timedelta(days=1),
            license_plate="LP-A", row_no=3,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-IN"]

    def test_sku_filter(self, client, project_id, admin_headers):
        d = date.today() - timedelta(days=1)
        sf = _seed_source(project_id, "sku")
        _seed_row(
            project_id, sf, order_id="O-A", sku="SKU-A", return_date=d,
            license_plate="LP-A", row_no=1,
        )
        _seed_row(
            project_id, sf, order_id="O-B", sku="SKU-B", return_date=d,
            license_plate="LP-B", row_no=2,
        )

        filtered = client.get(_qs(project_id, sku="SKU-A"), headers=admin_headers).json()
        everything = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in filtered["rows"]] == ["O-A"]
        assert filtered["row_count"] == 1
        assert everything["row_count"] == 2

    def test_ordering_is_return_date_then_id(self, client, project_id, admin_headers):
        end_date = date.today() - timedelta(days=1)
        earlier = end_date - timedelta(days=1)
        sf = _seed_source(project_id, "ord")
        _seed_row(
            project_id, sf, order_id="O-LATE", sku="S-1", return_date=end_date,
            license_plate="LP-L", row_no=1,
        )
        _seed_row(
            project_id, sf, order_id="O-EARLY", sku="S-1", return_date=earlier,
            license_plate="LP-E", row_no=2,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-EARLY", "O-LATE"]

    def test_sum_matches_analysis_total_quantity(self, client, project_id, admin_headers):
        """对账：端点 quantity 合计 == 分析 summary.total_quantity（跨层锁口径）。"""
        from app.services.analysis.return_analysis import build_return_analysis

        d = date.today() - timedelta(days=1)
        sf = _seed_source(project_id, "parity")
        _seed_row(
            project_id, sf, order_id="O-1", sku="S-1", return_date=d,
            license_plate="LP-1", row_no=1, quantity=2,
        )
        _seed_row(
            project_id, sf, order_id="O-2", sku="S-2", return_date=d,
            license_plate="LP-2", row_no=2, quantity=3,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()
        start, end = _window()
        db = SessionLocal()
        try:
            analysis = build_return_analysis(
                db,
                project_id=project_id,
                country="US",
                start_date=start,
                end_date=end,
            )
        finally:
            db.close()

        assert sum(r["quantity"] for r in body["rows"]) == 5
        assert sum(r["quantity"] for r in body["rows"]) == analysis.summary.total_quantity

    def test_project_not_found_404(self, client, admin_headers):
        resp = client.get(_qs(99999999), headers=admin_headers)

        assert resp.status_code == 404

    def test_non_admin_without_operator_403(self, client, project_id, settings):
        """与 /return-analysis 同鉴权语义：非 admin 且无 X-Operator → 403。"""
        headers = {"X-API-Key": settings.api_key, "X-Is-Admin": "false"}

        resp = client.get(_qs(project_id), headers=headers)

        assert resp.status_code == 403

    def test_exceeds_max_rows_400(self, client, project_id, admin_headers, monkeypatch):
        """超上限显式 400，不返回任何部分数据（拒绝静默截断）。"""
        from app.api.v1.endpoints import return_analysis as ra_module

        monkeypatch.setattr(ra_module, "MAX_RAW_ROWS", 1)
        d = date.today() - timedelta(days=1)
        sf = _seed_source(project_id, "cap")
        _seed_row(
            project_id, sf, order_id="O-1", sku="S-1", return_date=d,
            license_plate="LP-1", row_no=1,
        )
        _seed_row(
            project_id, sf, order_id="O-2", sku="S-1", return_date=d,
            license_plate="LP-2", row_no=2,
        )

        resp = client.get(_qs(project_id), headers=admin_headers)

        assert resp.status_code == 400
        assert "上限" in resp.json()["detail"]
        assert "rows" not in resp.json()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/api/test_return_analysis_raw_rows.py -q
```

Expected: 全部 404（路由不存在），例如 `assert 404 == 200` / `assert 404 == 400`。

- [ ] **Step 3: 加常量**

`backend/app/constants/return_thresholds.py` 末尾追加：

```python
# 原始行端点单次返回上限（spec §2.4）：超限显式 400，禁止静默截断 ——
# 静默截断会让「导出包含全部原始内容」变成假承诺。实测数据量距上限三个数量级。
MAX_RAW_ROWS = 50_000
```

- [ ] **Step 4: 加 schema**

`backend/app/schemas/return_analysis.py` 末尾追加：

```python
class ReturnRawRowItem(BaseModel):
    """亚马逊退货报表原始行（原始数据 Tab / Excel sheet 的一行，共 17 字段）。"""

    return_date: str  # 站点时区归一后的退货日期 YYYY-MM-DD
    original_return_datetime: str  # 报表原值 return-date（UTC ISO8601）
    order_id: str
    sku: str
    asin: str | None
    fnsku: str | None
    product_name: str | None
    quantity: int
    fulfillment_center_id: str | None
    detailed_disposition: str
    disposition_display: str  # 中文翻译
    reason: str
    reason_display: str  # 中文翻译
    status: str
    status_display: str  # 中文翻译
    license_plate_number: str | None
    customer_comment: str | None


class ReturnRawRowsResponse(BaseModel):
    """退货原始行响应（独立端点 /return-analysis/raw-rows）。"""

    project_id: int
    country: str
    start_date: str
    end_date: str
    row_count: int
    rows: list[ReturnRawRowItem]
```

- [ ] **Step 5: 加路由**

`backend/app/api/v1/endpoints/return_analysis.py`：

把首部 fastapi import 改为带 `HTTPException` / `status`：

```python
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
```

在 `from app.api.deps import ...` 之后追加：

```python
from app.constants.return_thresholds import MAX_RAW_ROWS
from app.constants.return_translations import translate_return_field
```

把 schema import 扩为：

```python
from app.schemas.return_analysis import (
    ReturnAnalysisResponse,
    ReturnRawRowItem,
    ReturnRawRowsResponse,
)
```

把 service import 扩为：

```python
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
    is_snapshot_fresh_for_range,
    query_current_return_rows,
)
```

文件末尾追加路由（放在 `get_return_analysis` 之后）：

```python
@router.get("/return-analysis/raw-rows", response_model=ReturnRawRowsResponse)
def get_return_analysis_raw_rows(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """亚马逊退货报表原始行（该周期、当前生效版本）。

    与 /return-analysis 同口径（共用 query_current_return_rows），供前端
    「原始数据」Tab 与 Excel「亚马逊原始数据」sheet 使用。独立端点而非并入
    主响应：主响应与 Redis v2 缓存保持零改动（spec §2.1）。

    不做分页：真实数据量为单周期数十至数百行，上限 MAX_RAW_ROWS 兜底；
    超限显式 400 而不是静默截断（spec §2.4）。
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    rows = query_current_return_rows(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )

    if len(rows) > MAX_RAW_ROWS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"所选周期原始退货行 {len(rows)} 条，超过上限 {MAX_RAW_ROWS} 条，"
                "请缩小日期范围后重试"
            ),
        )

    items = [
        ReturnRawRowItem(
            return_date=(
                row.return_date.isoformat()
                if hasattr(row.return_date, "isoformat")
                else str(row.return_date)
            ),
            original_return_datetime=row.original_return_datetime,
            order_id=row.order_id,
            sku=row.sku,
            asin=row.asin,
            fnsku=row.fnsku,
            product_name=row.product_name,
            quantity=row.quantity,
            fulfillment_center_id=row.fulfillment_center_id,
            detailed_disposition=row.detailed_disposition,
            disposition_display=translate_return_field(
                "disposition", row.detailed_disposition
            ),
            reason=row.reason,
            reason_display=translate_return_field("reason", row.reason),
            status=row.status,
            status_display=translate_return_field("status", row.status),
            license_plate_number=row.license_plate_number,
            customer_comment=row.customer_comments,
        )
        for row in rows
    ]

    return ReturnRawRowsResponse(
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        row_count=len(items),
        rows=items,
    )
```

- [ ] **Step 6: 跑新测试确认通过**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/api/test_return_analysis_raw_rows.py -q
```

Expected: `9 passed`。

- [ ] **Step 7: 跑回归**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/api tests/services/analysis -q
```

Expected: 0 failed（允许既有 skip）。

- [ ] **Step 8: 提交**

```bash
cd <WT> && git add backend/app/constants/return_thresholds.py \
  backend/app/schemas/return_analysis.py \
  backend/app/api/v1/endpoints/return_analysis.py \
  backend/tests/api/test_return_analysis_raw_rows.py
git commit -m "feat(退货分析): 新增原始行查询端点"
```

---

### Task 3: 修复 `openapi_export.py` 的懒分组崩溃

**背景（实测）**：`make openapi-export` / `openapi-check` 自 BLF-657 懒路由改造后必崩：
`app.api.v1.lazy_router` 的 `LazyGroupRouter` 在 openapi 生成过程中才物化分组，会让
`effective_candidates` 缓存失效并重建 route 克隆，导致
`KeyError: (ModelField(field_info=Body(PydanticUndefined), name='payload', mode='validation'), 'validation')`。
`lazy_router.preload_all_lazy_groups()` 的 docstring 已写明必须在 `app.openapi()` **之前**调用，
而导出脚本漏了。这条不修，Task 8 的契约重生成无法执行。

**Files:**
- Modify: `backend/scripts/openapi_export.py:32-35`（`build_app()`）
- Test: `backend/tests/scripts/test_openapi_export.py`

**Interfaces:**
- Consumes: `app.api.v1.lazy_router.preload_all_lazy_groups()`
- Produces: `scripts.openapi_export.build_app()` 返回的 app 可直接 `app.openapi()` 成功；Task 8 依赖此行为。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/scripts/test_openapi_export.py`：

```python
"""openapi 导出脚本回归（BLF-657 懒分组后的 schema 生成）。

背景：FastAPI 0.139 的 ``_IncludedRouter`` 懒物化机制下，若懒分组在
``app.openapi()`` 生成过程中才加载，``effective_candidates`` 缓存失效会重建
route 克隆 → ``field_mapping`` 里的旧 ModelField 与新克隆对不上，抛
``KeyError: (ModelField(... name='payload' ...), 'validation')``。
``backend/scripts/openapi_export.py`` 在 BLF-657 之后漏调
``preload_all_lazy_groups()``，导致 ``make openapi-export`` / ``openapi-check``
直接崩、契约无法再同步。
"""

from __future__ import annotations

import json
import os
import sys

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from scripts.openapi_export import build_app  # noqa: E402


def test_build_app_can_generate_openapi_schema():
    """build_app() 之后 app.openapi() 必须跑得通（懒分组已物化）。"""
    app = build_app()

    schema = app.openapi()

    assert "paths" in schema
    assert len(schema["paths"]) > 400


def test_openapi_generation_is_deterministic():
    """同一进程内两次生成必须逐字一致（导出可复现）。"""
    app = build_app()

    first = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True)
    second = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True)

    assert first == second
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/scripts/test_openapi_export.py -q
```

Expected: 两条都 FAIL，报 `KeyError: (ModelField(field_info=Body(PydanticUndefined), name='payload', ...`。

- [ ] **Step 3: 在 `build_app()` 里物化懒分组**

`backend/scripts/openapi_export.py` 的 `build_app()` 改为：

```python
def build_app():
    # Import lazily so the script can be run with a clean PYTHONPATH after
    # `cd backend && pip install -r requirements.txt`.
    from app.main import app  # type: ignore[import-not-found]
    from app.api.v1.lazy_router import preload_all_lazy_groups

    # BLF-657 懒分组：FastAPI 0.139 的 openapi 生成过程中若懒分组才被加载，
    # effective_candidates 缓存失效会重建 route 克隆 → field_mapping 里的旧
    # ModelField 与新克隆对不上，直接抛 KeyError。必须在 app.openapi() 之前
    # 一次性物化全部懒分组（export 与 check 两条路径都走这里）。
    preload_all_lazy_groups()
    return app
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/scripts/test_openapi_export.py -q
```

Expected: `2 passed`。

- [ ] **Step 5: 确认 `make openapi-check` 不再是崩溃而是正常报告**

```bash
cd <WT>/backend && VENV=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python make openapi-check; echo "exit=$?"
```

Expected: 因已提交的 `openapi.json` 存在历史漂移，输出 `DRIFT: ...` 且 `exit=1`（**这是正确行为**，Task 8 会重生成消除漂移）；关键是**不再出现 KeyError 堆栈**。

- [ ] **Step 6: 提交**

```bash
cd <WT> && git add backend/scripts/openapi_export.py backend/tests/scripts/test_openapi_export.py
git commit -m "fix(后端): openapi 导出前物化懒分组"
```

---

### Task 4: 前端列配置模块 `RETURN_RAW_COLUMNS`

**Files:**
- Create: `frontend/app/dashboard/operations/return-analysis/return-raw-columns.ts`
- Test: `frontend/app/dashboard/operations/return-analysis/return-raw-columns.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ReturnRawRowItem` 字段名（逐字对齐，不得改名）
- Produces:
  - `type ReturnRawRow`（17 字段，与后端响应一致）
  - `type ReturnRawColumn = { key: keyof ReturnRawRow; label: string; width: number; minWidth: string; truncate?: boolean }`
  - `const RETURN_RAW_COLUMNS: ReturnRawColumn[]`（17 项，顺序 = spec §1.2）
  - `const RAW_DISPLAY_LIMIT = 200`

- [ ] **Step 1: 写失败测试**

创建 `frontend/app/dashboard/operations/return-analysis/return-raw-columns.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { RAW_DISPLAY_LIMIT, RETURN_RAW_COLUMNS } from './return-raw-columns'

/** spec §1.2 的 17 列表头（顺序即契约：原值列后紧跟中文翻译列）。 */
const EXPECTED_LABELS = [
  '退货日期（站点时区）',
  '原始退货时间',
  '订单号',
  'SKU',
  'ASIN',
  'FNSKU',
  '产品名称',
  '数量',
  '运营中心',
  '商品状态',
  '商品状态（中文）',
  '退货原因',
  '退货原因（中文）',
  '库存属性',
  '库存属性（中文）',
  'LPN',
  '顾客评论',
]

describe('退货原始数据列配置', () => {
  it('17 列，key 与表头均唯一', () => {
    expect(RETURN_RAW_COLUMNS).toHaveLength(17)
    expect(new Set(RETURN_RAW_COLUMNS.map((c) => c.key)).size).toBe(17)
    expect(new Set(RETURN_RAW_COLUMNS.map((c) => c.label)).size).toBe(17)
  })

  it('列顺序与 spec §1.2 一致', () => {
    expect(RETURN_RAW_COLUMNS.map((c) => c.label)).toEqual(EXPECTED_LABELS)
  })

  it('每列都有正数列宽与页面最小宽度（Excel 与 Tab 共用同一份配置）', () => {
    for (const column of RETURN_RAW_COLUMNS) {
      expect(column.width).toBeGreaterThan(0)
      expect(column.minWidth).toMatch(/^min-w-\[/)
    }
  })

  it('页内渲染上限为正整数', () => {
    expect(Number.isInteger(RAW_DISPLAY_LIMIT)).toBe(true)
    expect(RAW_DISPLAY_LIMIT).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-raw-columns.test.ts
```

Expected: FAIL —— `Failed to resolve import "./return-raw-columns"`。

- [ ] **Step 3: 实现列配置模块**

创建 `frontend/app/dashboard/operations/return-analysis/return-raw-columns.ts`：

```ts
/**
 * 退货分析「原始数据」列配置 —— Tab 表格与 Excel sheet 的唯一来源（可单测）。
 *
 * 顺序 = 亚马逊退货报表列顺序：每个原值列后紧跟它的中文翻译列（spec §1.2）。
 * 17 个 key 与后端 `ReturnRawRowItem` 字段一一对应，改名必须两边同改。
 *
 * 中文翻译列由后端用 `app/constants/return_translations.py` 产出，前端不重复翻译，
 * 保证与「退货原因 / 商品状态 / 库存状态」等分析 Tab 的译文永远一致。
 */

export type ReturnRawRow = {
  return_date: string
  original_return_datetime: string
  order_id: string
  sku: string
  asin: string | null
  fnsku: string | null
  product_name: string | null
  quantity: number
  fulfillment_center_id: string | null
  detailed_disposition: string
  disposition_display: string
  reason: string
  reason_display: string
  status: string
  status_display: string
  license_plate_number: string | null
  customer_comment: string | null
}

export type ReturnRawColumn = {
  /** ReturnRawRow 上的字段名（也是取值 key） */
  key: keyof ReturnRawRow
  /** Excel 表头与页面表头共用的中文列名 */
  label: string
  /** Excel 列宽（字符数） */
  width: number
  /** 页面表格该列的最小宽度（Tailwind 任意值类） */
  minWidth: string
  /** true → 单元格单行截断 + title 全量提示 */
  truncate?: boolean
}

export const RETURN_RAW_COLUMNS: ReturnRawColumn[] = [
  { key: 'return_date', label: '退货日期（站点时区）', width: 18, minWidth: 'min-w-[130px]' },
  { key: 'original_return_datetime', label: '原始退货时间', width: 26, minWidth: 'min-w-[190px]' },
  { key: 'order_id', label: '订单号', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'sku', label: 'SKU', width: 20, minWidth: 'min-w-[140px]' },
  { key: 'asin', label: 'ASIN', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'fnsku', label: 'FNSKU', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'product_name', label: '产品名称', width: 46, minWidth: 'min-w-[240px]', truncate: true },
  { key: 'quantity', label: '数量', width: 8, minWidth: 'min-w-[70px]' },
  { key: 'fulfillment_center_id', label: '运营中心', width: 12, minWidth: 'min-w-[96px]' },
  { key: 'detailed_disposition', label: '商品状态', width: 18, minWidth: 'min-w-[130px]' },
  { key: 'disposition_display', label: '商品状态（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'reason', label: '退货原因', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'reason_display', label: '退货原因（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'status', label: '库存属性', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'status_display', label: '库存属性（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'license_plate_number', label: 'LPN', width: 20, minWidth: 'min-w-[140px]', truncate: true },
  { key: 'customer_comment', label: '顾客评论', width: 60, minWidth: 'min-w-[260px]', truncate: true },
]

/**
 * 页内一次渲染的行数上限（完整数据由导出 Excel 承载）。
 * 真实数据量为单周期数十至数百行；调大此值即放宽页内展示，Excel 不受影响。
 */
export const RAW_DISPLAY_LIMIT = 200
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-raw-columns.test.ts
```

Expected: `4 passed`。

- [ ] **Step 5: 提交**

```bash
cd <WT> && git add frontend/app/dashboard/operations/return-analysis/return-raw-columns.ts \
  frontend/app/dashboard/operations/return-analysis/return-raw-columns.test.ts
git commit -m "feat(退货分析): 新增原始数据列配置"
```

---

### Task 5: 原始数据 Tab + 懒加载表格

**Files:**
- Modify: `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`
  - import 区（第 6 行 lucide、第 40-44 行 table、第 46 行后新增列配置 import）
  - `type ViewTab`（第 75 行）、`VIEW_TAB_ORDER`（第 83 行）、`TAB_LABELS`（第 271 行）、`TAB_ICONS`（第 284 行）
  - `allowed` 白名单（第 357-365 行）
  - 状态区（第 367-370 行后）
  - `loadData`（第 409 行起）
  - 新增 `loadRawRows` + 懒加载 effect（插在 `handleExportExcel` 之前）
  - `TabsList` 栅格（第 797 行）
  - 新增 `TabsContent` 块（插在 feedback 块之后）
- Test: `frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx`

**Interfaces:**
- Consumes: Task 2 端点 + Task 4 的 `ReturnRawRow` / `RETURN_RAW_COLUMNS` / `RAW_DISPLAY_LIMIT`
- Produces（Task 6 依赖）：
  - `type ReturnRawRowsResponse = { project_id: number; country: string; start_date: string; end_date: string; row_count: number; rows: ReturnRawRow[] }`
  - state `rawRows: ReturnRawRowsResponse | null`
  - `loadRawRows(force?: boolean): Promise<ReturnRawRowsResponse | null>`（失败返回 `null`，不抛）
  - tab id `'raw'`，标签「原始数据」

- [ ] **Step 1: 写失败测试（扩展现有测试文件）**

在 `frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx` 里改 mock 并追加用例。

先把 `@/lib/ops-client-cache` 的 mock 换成按 URL 分流，并把原始行 payload/计数器加在 mock 之前：

```ts
const RAW_ROWS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  start_date: '2026-08-20',
  end_date: '2026-08-26',
  row_count: 1,
  rows: [
    {
      return_date: '2026-08-22',
      original_return_datetime: '2026-08-22T10:00:00+00:00',
      order_id: 'ORDER-RAW-1',
      sku: 'SKU-RAW-1',
      asin: 'B0RAW00001',
      fnsku: 'X00RAW',
      product_name: '原始数据商品',
      quantity: 2,
      fulfillment_center_id: 'PGA1',
      detailed_disposition: 'SELLABLE',
      disposition_display: '可售',
      reason: 'NOT_AS_DESCRIBED',
      reason_display: '与描述不符',
      status: 'Unit returned to inventory',
      status_display: '退回库存',
      license_plate_number: 'LP-RAW-1',
      customer_comment: '原始评论',
    },
  ],
}
```

```ts
function rawRowsPayload(overrides?: Partial<Record<string, unknown>>) {
  // order_id 带请求序号：让「切周期后旧行被替换」可观测（不是追加）
  return {
    ...RAW_ROWS_PAYLOAD,
    rows: [{ ...RAW_ROWS_PAYLOAD.rows[0], order_id: `ORDER-RAW-${rawRequestCount}` }],
    ...overrides,
  }
}

let rawRequestCount = 0
let rawShouldFail = false
let rawRowCountOverride: number | null = null
let rawRowsEmpty = false

let lastForce: boolean | undefined
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((url: string, opts?: { force?: boolean }) => {
      lastForce = opts?.force
      if (url.includes('/return-analysis/raw-rows')) {
        rawRequestCount += 1
        if (rawShouldFail) return Promise.reject(new Error('原始数据加载失败'))
        if (rawRowsEmpty) {
          return Promise.resolve({ ...rawRowsPayload(), rows: [], row_count: 0 })
        }
        if (rawRowCountOverride !== null) {
          return Promise.resolve(rawRowsPayload({ row_count: rawRowCountOverride }))
        }
        return Promise.resolve(rawRowsPayload())
      }
      return Promise.resolve(returnPayload())
    }),
  }
})
```

> **注意**：这块是**整块替换**原有的 `let lastForce: boolean | undefined` + `vi.mock('@/lib/ops-client-cache', ...)`，不要保留旧的那两行，否则 `lastForce` 重复声明。

`afterEach` 里补计数器复位（`lastForce = undefined` 一行保留）：

```ts
  rawRequestCount = 0
  rawShouldFail = false
  rawRowCountOverride = null
  rawRowsEmpty = false
```

在文件末尾追加新 describe：

```ts
describe('原始数据 Tab（原始行懒加载）', () => {
  it('默认停留在 rankings，不发 raw-rows 请求', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    expect(rawRequestCount).toBe(0)
  })

  it('切到原始数据 Tab 才请求一次，且 query 带项目/站点/周期', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('亚马逊原始数据')).toBeInTheDocument()
    await vi.waitFor(() => expect(rawRequestCount).toBe(1))
    const rawCall = vi
      .mocked(fetchOpsJsonCached)
      .mock.calls.find(([url]) => url.includes('/return-analysis/raw-rows'))
    expect(rawCall?.[0]).toContain('project_id=1')
    expect(rawCall?.[0]).toContain('country=US')
    expect(rawCall?.[0]).toContain('start_date=')
    expect(rawCall?.[0]).toContain('end_date=')
  })

  it('渲染 17 列表头与中文翻译列', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('退货原因（中文）')).toBeInTheDocument()
    expect(screen.getByText('商品状态（中文）')).toBeInTheDocument()
    expect(screen.getByText('库存属性（中文）')).toBeInTheDocument()
    expect(await screen.findByText('ORDER-RAW-1')).toBeInTheDocument()
    expect(screen.getByText('原始数据商品')).toBeInTheDocument()
  })

  it('超过页内上限时提示走导出 Excel', async () => {
    rawRowCountOverride = 4321
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText(/完整 4,321 条请导出 Excel/)).toBeInTheDocument()
  })

  it('空返回展示空态文案', async () => {
    rawRowsEmpty = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('所选周期无原始退货数据')).toBeInTheDocument()
  })

  it('加载失败展示错误与重试按钮，重试会再发一次请求', async () => {
    rawShouldFail = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('原始数据加载失败')).toBeInTheDocument()
    expect(rawRequestCount).toBe(1)

    rawShouldFail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    await vi.waitFor(() => expect(rawRequestCount).toBe(2))
  })

  it('切换周期后清空旧周期原始行（防串数据）', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)
    // 首次懒加载拿到 ORDER-RAW-1
    await screen.findByText('ORDER-RAW-1')

    // 触发一次全局刷新：loadData 先清空 rawRows，随后懒加载重取（序号递增）
    capturedRefreshHandler?.()

    // 新 payload 是 ORDER-RAW-2 且旧行消失 —— 证明是「替换」不是「追加」
    expect(await screen.findByText('ORDER-RAW-2')).toBeInTheDocument()
    expect(screen.queryByText('ORDER-RAW-1')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(rawRequestCount).toBe(2))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
```

Expected: 新增 7 条 FAIL（找不到「亚马逊原始数据」/`rawRequestCount` 恒为 0 等），原有 9 条仍 PASS。

- [ ] **Step 3: 改 import**

第 6 行 lucide import 加 `Table2`：

```ts
import { Boxes, Download, Loader2, MessageSquare, Package, Sparkles, Table2, Tags, TrendingUp, Trophy, type LucideIcon } from 'lucide-react'
```

`@/components/ui/table` 的 import 加 `STICKY_TOP_ROW`：

```ts
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ColGroup,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
```

在 `import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'` 之后追加：

```ts
import {
  RAW_DISPLAY_LIMIT,
  RETURN_RAW_COLUMNS,
  type ReturnRawRow,
} from './return-raw-columns'
```

- [ ] **Step 4: 加 tab 维度**

`type ViewTab` 加 `| 'raw'`；`VIEW_TAB_ORDER` 末尾追加 `'raw'`：

```ts
const VIEW_TAB_ORDER: ViewTab[] = [
  'rankings',
  'reason',
  'trend',
  'product-status',
  'inventory-status',
  'feedback',
  'summary',
  'raw',
]
```

`TAB_LABELS` 末尾加：

```ts
  summary: 'AI 总结',
  raw: '原始数据',
```

`TAB_ICONS` 末尾加：

```ts
  summary: Sparkles,
  raw: Table2,
```

`useUrlParam<ViewTab>('tab', 'rankings', { allowed: [...] })` 的数组末尾加 `'raw'`：

```ts
    allowed: [
      'rankings',
      'reason',
      'trend',
      'product-status',
      'inventory-status',
      'feedback',
      'summary',
      'raw',
    ],
```

`TabsList` 栅格改为 8 列：

```tsx
          <TabsList variant="term" className="grid h-auto w-full grid-cols-4 lg:grid-cols-8">
```

- [ ] **Step 5: 加响应类型与状态**

紧跟 `ReturnAnalysisResponse` 类型定义之后追加：

```ts
type ReturnRawRowsResponse = {
  project_id: number
  country: string
  start_date: string
  end_date: string
  row_count: number
  rows: ReturnRawRow[]
}
```

状态区（`const [exporting, setExporting] = useState(false)` 之后）追加：

```ts
  // 原始行懒加载状态：只在切到「原始数据」Tab 或点导出时才发请求（spec §3.3）
  const [rawRows, setRawRows] = useState<ReturnRawRowsResponse | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  // 全局刷新（force）时把 force 语义传递给原始行请求，避免命中 2min 客户端缓存
  const rawForceRef = useRef(false)
```

- [ ] **Step 6: `loadData` 清空旧周期原始行**

在 `loadData` 里、`setLoading(true)` **之前**插入：

```ts
      // 周期切换防串数据：旧周期的原始行一律作废，等下次进 Tab/导出时重取
      setRawRows(null)
      setRawError(null)
      if (force) rawForceRef.current = true
```

- [ ] **Step 7: 加 `loadRawRows` 与懒加载 effect**

紧接 `loadData` 的 `useCallback` 之后、`handleExportExcel` 之前插入：

```ts
  // 原始行按需拉取：失败返回 null（由调用方决定提示方式），不抛异常
  const loadRawRows = useCallback(
    async (force = false) => {
      const effectiveRange = normalizeDateRange(dateRange)
      if (!effectiveRange?.from || !effectiveRange?.to || !projectId) return null

      const search = new URLSearchParams({
        project_id: projectId,
        country,
        start_date: formatYMD(effectiveRange.from),
        end_date: formatYMD(effectiveRange.to),
      })
      setRawLoading(true)
      setRawError(null)
      try {
        const payload = await fetchOpsJsonCached<ReturnRawRowsResponse>(
          `${API_BASE}/return-analysis/raw-rows?${search.toString()}`,
          { session, force, fallbackError: '原始数据加载失败' }
        )
        setRawRows(payload)
        return payload
      } catch (fetchError) {
        setRawError(
          fetchError instanceof Error ? fetchError.message : '原始数据加载失败'
        )
        return null
      } finally {
        rawForceRef.current = false
        setRawLoading(false)
      }
    },
    [projectId, country, dateRange, session]
  )

  // 只在切到「原始数据」Tab 时懒加载一次（已有数据不重复请求）
  useEffect(() => {
    if (activeTab !== 'raw') return
    if (!projectId || !data) return
    if (rawRows || rawLoading) return
    void loadRawRows(rawForceRef.current)
  }, [activeTab, projectId, data, rawRows, rawLoading, loadRawRows])
```

- [ ] **Step 8: 加原始数据 Tab 内容**

在 feedback 的 `TabsContent` 块（`{activeTab === 'feedback' && (...)}`）之后、summary 块之前插入：

```tsx
                {activeTab === 'raw' && (
                  <div className="space-y-4 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-base font-semibold">亚马逊原始数据</h3>
                      <span className="font-mono text-xs text-term-muted">
                        {rawRows
                          ? `${rawRows.start_date} 至 ${rawRows.end_date} · 共 ${rawRows.row_count.toLocaleString()} 条`
                          : '—'}
                      </span>
                    </div>
                    {rawRows && rawRows.row_count > RAW_DISPLAY_LIMIT && (
                      <p className="font-mono text-xs text-term-warn">
                        页内仅展示前 {RAW_DISPLAY_LIMIT} 条，完整{' '}
                        {rawRows.row_count.toLocaleString()} 条请导出 Excel。
                      </p>
                    )}
                    {rawError ? (
                      <div className="flex flex-wrap items-center gap-3 border border-term-border bg-term-panel px-3 py-2">
                        <span className="text-sm text-term-neg">{rawError}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void loadRawRows(true)}
                          disabled={rawLoading}
                        >
                          重试
                        </Button>
                      </div>
                    ) : (
                      <Table
                        className="min-w-[2280px] table-auto text-xs"
                        containerClassName="max-h-[560px] overflow-auto bg-[hsl(var(--surface-panel))]/94"
                      >
                        <TableHeader>
                          <TableRow className={STICKY_TOP_ROW}>
                            {RETURN_RAW_COLUMNS.map((column) => (
                              <TableHead key={column.key} className={column.minWidth}>
                                {column.label}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <RefreshProgressBar
                          refreshing={isRefreshing}
                          as="tbody"
                          className="[&_tr:last-child]:border-b-0"
                        >
                          {rawLoading ? (
                            <TableSkeletonRows columns={RETURN_RAW_COLUMNS.length} rows={8} />
                          ) : rawRows?.rows.length ? (
                            rawRows.rows.slice(0, RAW_DISPLAY_LIMIT).map((row, index) => (
                              <TableRow key={`${row.order_id}-${row.sku}-${index}`}>
                                {RETURN_RAW_COLUMNS.map((column) => {
                                  const value = row[column.key]
                                  const text =
                                    value === null || value === undefined ? '' : String(value)
                                  return (
                                    <TableCell
                                      key={column.key}
                                      className={cn(
                                        'text-term-muted',
                                        column.key === 'quantity' &&
                                          'text-right tabular-nums',
                                        column.truncate && 'max-w-[320px] truncate'
                                      )}
                                      title={column.truncate ? text : undefined}
                                    >
                                      {text}
                                    </TableCell>
                                  )
                                })}
                              </TableRow>
                            ))
                          ) : (
                            <EmptyTableState
                              colSpan={RETURN_RAW_COLUMNS.length}
                              message="所选周期无原始退货数据"
                            />
                          )}
                        </RefreshProgressBar>
                      </Table>
                    )}
                  </div>
                )}
```

- [ ] **Step 9: 跑测试确认通过**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
```

Expected: `16 passed`（原有 9 + 新增 7：懒加载不发请求 / 切 tab 请求一次 / 17 列渲染 / 截断提示 / 空态 / 错误+重试 / 防串数据）。

- [ ] **Step 10: lint 该目录**

```bash
cd <WT>/frontend && node_modules/.bin/eslint app/dashboard/operations/return-analysis --ext .ts,.tsx
```

Expected: 无 error（warning 若为既有则忽略）。

- [ ] **Step 11: 提交**

```bash
cd <WT> && git add frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx \
  frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
git commit -m "feat(退货分析): 新增原始数据 Tab 懒加载"
```

---

### Task 6: 导出新增「亚马逊原始数据」sheet

**Files:**
- Modify: `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`（`handleExportExcel`，含 deps 数组）
- Test: `frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx`

**Interfaces:**
- Consumes: Task 4 `RETURN_RAW_COLUMNS`；Task 5 的 `rawRows` state 与 `loadRawRows(force?)`
- Produces: 导出文件的第 6 张 sheet「亚马逊原始数据」（表头 17 列、冻结首行）；原始行拉取失败时**不产出文件**。

- [ ] **Step 1: 写失败测试**

在 `return-analysis-client.test.tsx` 顶部（`@/lib/ops-client-cache` mock 之前）加 exceljs 假实现与 jsdom 桩：

```ts
// exceljs 假实现：捕获 addWorksheet 顺序与每个 sheet 写入的行
const excelCapture = vi.hoisted(() => ({
  sheetNames: [] as string[],
  rowsBySheet: {} as Record<string, unknown[][]>,
}))

vi.mock('exceljs', () => {
  class FakeWorksheet {
    name: string
    views: unknown[] = []
    columns: unknown[] = []
    constructor(name: string) {
      this.name = name
    }
    addRow(values: unknown) {
      const cells = Array.isArray(values) ? values : [values]
      const bucket = excelCapture.rowsBySheet[this.name] ?? []
      bucket.push(cells)
      excelCapture.rowsBySheet[this.name] = bucket
      const cell = { font: {}, border: {}, fill: {}, alignment: {} }
      return {
        height: 0,
        font: {},
        eachCell: (cb: (c: typeof cell) => void) => cells.forEach(() => cb(cell)),
      }
    }
    getRow() {
      const cell = { font: {}, border: {}, fill: {}, alignment: {} }
      return { eachCell: (cb: (c: typeof cell) => void) => cb(cell) }
    }
  }
  class FakeWorkbook {
    creator = ''
    created: Date = new Date()
    addWorksheet(name: string) {
      excelCapture.sheetNames.push(name)
      return new FakeWorksheet(name)
    }
    get xlsx() {
      return { writeBuffer: () => Promise.resolve(new ArrayBuffer(8)) }
    }
  }
  return { Workbook: FakeWorkbook, default: { Workbook: FakeWorkbook } }
})

// jsdom 未实现 blob URL 与锚点导航：导出用例只需不抛错
window.URL.createObjectURL = () => 'blob:mock'
window.URL.revokeObjectURL = () => {}
HTMLAnchorElement.prototype.click = () => {}
```

`afterEach` 里补清理：

```ts
  excelCapture.sheetNames.length = 0
  Object.keys(excelCapture.rowsBySheet).forEach((key) => {
    delete excelCapture.rowsBySheet[key]
  })
```

文件末尾追加：

```ts
describe('导出 Excel：亚马逊原始数据 sheet', () => {
  it('未打开过原始数据 Tab 时，导出会先拉原始行并追加第 6 张 sheet', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(rawRequestCount).toBe(0)

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() => expect(rawRequestCount).toBe(1))
    await vi.waitFor(() =>
      expect(excelCapture.sheetNames).toEqual([
        '退货排行',
        '退货原因',
        '商品状态',
        '库存状态',
        '顾客反馈',
        '亚马逊原始数据',
      ])
    )
    const rawSheetRows = excelCapture.rowsBySheet['亚马逊原始数据']
    expect(rawSheetRows).toHaveLength(2) // 表头 + 1 行数据
    expect(rawSheetRows[0]).toHaveLength(17)
    expect(rawSheetRows[0][0]).toBe('退货日期（站点时区）')
    expect(rawSheetRows[1][2]).toBe('ORDER-RAW-1')
    expect(rawSheetRows[1][12]).toBe('与描述不符')
  })

  it('原始行拉取失败时中止导出，不产出任何 sheet', async () => {
    rawShouldFail = true
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: '导出失败' })
      )
    )
    expect(excelCapture.sheetNames).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
```

Expected: 新增 2 条 FAIL —— sheet 名数组缺少「亚马逊原始数据」（第一条），第二条因根本没中止导出而 sheet 名非空。

- [ ] **Step 3: 导出前置取原始行**

`handleExportExcel` 开头（`setExporting(true)` 之前）插入：

```ts
    // 原始行按需拉取：失败即中止导出，不产出缺 sheet 的「假完整包」（spec §3.4）
    const raw = rawRows ?? (await loadRawRows())
    if (!raw) {
      notify({
        type: 'error',
        title: '导出失败',
        message: '原始数据加载失败，已中止导出',
      })
      return
    }
```

并在 `setExporting(true)` 之后、`const ExcelJS = await import('exceljs')` 之前**不要**放任何东西（保持顺序：先判定再建 workbook）。

把 `useCallback` 的依赖数组从 `[data, notify]` 改为：

```ts
  }, [data, notify, rawRows, loadRawRows])
```

- [ ] **Step 4: 追加第 6 张 sheet**

在 Sheet 5「顾客反馈」块之后、`const buffer = await workbook.xlsx.writeBuffer()` 之前插入：

```ts
      // ── Sheet 6: 亚马逊原始数据（spec §1.2 的 17 列，列配置与 Tab 共用）──
      {
        const ws = workbook.addWorksheet('亚马逊原始数据')
        ws.columns = RETURN_RAW_COLUMNS.map((column) => ({ width: column.width }))
        const headerRow = ws.addRow(RETURN_RAW_COLUMNS.map((column) => column.label))
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        raw.rows.forEach((row) => {
          const r = ws.addRow(
            RETURN_RAW_COLUMNS.map((column) => {
              const value = row[column.key]
              return value === null || value === undefined ? '' : value
            })
          )
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
```

Expected: `18 passed`（16 + 导出新增 2）。

- [ ] **Step 6: 提交**

```bash
cd <WT> && git add frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx \
  frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx
git commit -m "feat(退货分析): 导出增加亚马逊原始数据 sheet"
```

---

### Task 7: proxy 超时档位（stats 15s）

**Files:**
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.ts:67-74`（`STATS_PATH_PATTERNS`）
- Test: `frontend/lib/server/backend-proxy-timeout-policy.test.ts`

**Interfaces:**
- Consumes: Task 2 的端点路径 `/api/v1/return-analysis/raw-rows`
- Produces: 该路径命中 `stats` 档（15_000ms）；`/return-analysis` 主端点仍为默认 5_000ms。

- [ ] **Step 1: 写失败测试**

在 `frontend/lib/server/backend-proxy-timeout-policy.test.ts` 末尾追加：

```ts
describe('退货分析原始行端点：stats 档（15s）', () => {
  it('matches the `stats` tier (15_000ms)', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis/raw-rows', null)).toBe(15_000)
    expect(getProxyTimeoutMs('/api/v1/return-analysis/raw-rows', null)).toBe(15_000)
  })

  it('不误伤 /return-analysis 主端点（保持默认 5_000ms）', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis', null)).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/return-analysis?period=30d', null)).toBe(5_000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run lib/server/backend-proxy-timeout-policy.test.ts
```

Expected: 第一条 FAIL（实际拿到 5_000），第二条 PASS。

- [ ] **Step 3: 加锚定模式**

`STATS_PATH_PATTERNS` 追加（保留既有条目与注释）：

```ts
const STATS_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/metrics\//,
  /\/aggregations\//,
  /\/dashboard\/summary$/,
  // BLF-1019：order-info/filter-options 是 3 个 distinct 全表扫（3-6s），
  // 默认 5s 档必超时 → 前端下拉永久空白。给 15s stats 档。
  /\/order-info\/filter-options$/,
  // 退货分析原始行：一次返回整周期无分页明细，属统计量级而非单资源 detail；
  // `$` 锚定保证不误伤 /return-analysis 主端点（那仍走默认 5s 档）。
  /\/return-analysis\/raw-rows$/,
]
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run lib/server/backend-proxy-timeout-policy.test.ts
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
cd <WT> && git add frontend/lib/server/backend-proxy-timeout-policy.ts \
  frontend/lib/server/backend-proxy-timeout-policy.test.ts
git commit -m "chore(前端): 原始行端点挂 stats 超时档"
```

---

### Task 8: 契约重生成（独立 commit）

**Files:**
- Modify: `backend/tests/scripts/test_openapi_export.py`（追加漂移守卫）
- Modify: `frontend/types/api-generated/openapi.json`（重生成）
- Modify: `frontend/types/api-generated/api.d.ts`（重生成）

**Interfaces:**
- Consumes: Task 3 修好的 `build_app()`；Task 1/2 的后端契约
- Produces: `openapi.json` 与 `api.d.ts` 与当前后端 schema 一致（含新端点）；后续 `pnpm build` 的 `gen:api-types:check` 继续通过。

- [ ] **Step 1: 追加漂移守卫测试（此时必然失败）**

在 `backend/tests/scripts/test_openapi_export.py` 末尾追加：

```python
def test_committed_openapi_matches_current_schema():
    """契约不得漂移（BEL-29）——`make openapi-check` 的 pytest 版。

    失败时的修法：`cd backend && make openapi-export` → `cd frontend &&
    pnpm gen:api-types`（worktree 无 .venv 时用 `VENV=<绝对路径>/python make
    openapi-export`），然后把两个生成文件一起提交。
    """
    from scripts.openapi_export import DEFAULT_OUT

    app = build_app()
    fresh = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    committed = DEFAULT_OUT.read_text(encoding="utf-8")

    assert committed == fresh, (
        "frontend/types/api-generated/openapi.json 已漂移："
        "cd backend && make openapi-export 后提交，再 cd frontend && pnpm gen:api-types"
    )
```

- [ ] **Step 2: 跑测试确认失败（漂移可见）**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/scripts/test_openapi_export.py -q
```

Expected: 1 failed（漂移）+ 2 passed。

- [ ] **Step 3: 重生成 OpenAPI JSON**

```bash
cd <WT>/backend && VENV=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python make openapi-export
```

Expected: `Wrote OpenAPI schema to ../frontend/types/api-generated/openapi.json`（无 KeyError）。

- [ ] **Step 4: 确认新端点已进 JSON**

```bash
cd <WT> && grep -c "return-analysis/raw-rows" frontend/types/api-generated/openapi.json
```

Expected: ≥1。

- [ ] **Step 5: 重生成前端类型**

```bash
cd <WT>/frontend && node scripts/gen-api-types.mjs && node scripts/gen-api-types.mjs --check
```

Expected: `Wrote .../api.d.ts` 然后 `OK — generated types are in sync with openapi.json.`

- [ ] **Step 6: 跑漂移守卫与全量后端测试**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest tests/scripts/test_openapi_export.py -q
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest -q
```

Expected: 漂移守卫 3 passed；全量 0 failed。

- [ ] **Step 7: 提交（独立 commit，与功能提交分开，便于单独回滚）**

```bash
cd <WT> && git add backend/tests/scripts/test_openapi_export.py \
  frontend/types/api-generated/openapi.json \
  frontend/types/api-generated/api.d.ts
git commit -m "chore(契约): 同步 OpenAPI 与前端生成类型"
git log --oneline -9
```

Expected: 8 个提交（任务 1-8 各一），最上面是本条。

---

## 收尾验证（全部通过才算完成）

- [ ] **后端全量**

```bash
cd <WT>/backend && /Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python -m pytest -q
```

Expected: `0 failed`。

- [ ] **前端单测全量（等价 `pnpm test`）**

```bash
cd <WT>/frontend && node_modules/.bin/vitest run
```

Expected: `0 failed`。若本沙箱有既有失败，先确认失败集合与 `main` 基线一致（在 worktree 里 `git stash` 或对比 `main` 跑一次），再继续。

- [ ] **前端 lint（等价 `pnpm lint`）**

```bash
cd <WT>/frontend && node_modules/.bin/eslint . --ext .ts,.tsx
```

Expected: 无新增 error。

- [ ] **契约检查（等价 `pnpm build` 的 DTO 门）**

```bash
cd <WT>/frontend && node scripts/gen-api-types.mjs --check
```

Expected: `OK`。

- [ ] **生产构建（等价 `pnpm build` 剩余部分）**

```bash
cd <WT>/frontend && node_modules/.bin/next build
```

Expected: 构建成功。

- [ ] **工作区干净**

```bash
cd <WT> && git status --short
```

Expected: 空输出。

- [ ] **交人工业务验收**（spec §8，逐条走，需要真实项目数据）

1. 选项目 + 站点 + 周期 → 切「原始数据」Tab：能看到该周期原始行，中文翻译列正确。
2. 页内展示条数提示与 Excel 实际行数一致（除非触发 200 行截断提示）。
3. 导出 Excel：第 6 张 sheet 名为「亚马逊原始数据」，表头 17 列、顺序与 spec §1.2 一致，冻结首行、边框字体与其余 sheet 一致。
4. 对账：原始 sheet「数量」合计 == 页面磁贴「退货总量」。
5. 切换周期后再导出：内容为新周期数据，无旧周期残留。
6. 现有 5 张 sheet 内容与改造前完全一致。
7. 无权限项目访问：与改造前表现一致。

## 部署注意（不要擅自执行）

- 本计划的改动命中 `backend/`，按 `AGENTS.md`，一旦 `git push origin main`（或 `git deploy`）就会触发 VPS 部署。**合并/推送由用户决定**，agent 不主动 push。
- 合并方式：`feat/return-analysis-raw-data` 合入 `main` 后，前端由 Vercel 自动部署、后端由部署脚本处理。合入前无需 `alembic`（本计划无迁移），`check_alembic` 不会阻断。
- 收尾时按 `finishing-a-development-branch` 技能给出合并/PR/清理选项。
