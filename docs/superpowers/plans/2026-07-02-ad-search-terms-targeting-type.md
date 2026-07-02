# ad-search-terms 端点 targeting_type 字段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `GET /api/v1/external/projects/{id}/ad-search-terms` 与
`/ad-search-terms-raw` 两个端点:
1. 删除 `target_text` 字段(BI 反馈语义错误,Auto 行里是定位类型,Manual 行才
   是真正的投放词,且与新增 `targeting_type` 字段语义重复)。
2. 新增 `targeting_type` 字段,值域:
   - Auto Campaign 行 → `raw_row.投放` 原样(`close-match` / `loose-match`
     / `substitutes` / `complements`)
   - Manual Campaign 行 → `LOWER(raw_row.匹配类型)`(`exact` / `phrase` / `broad`)
   - 无对应 campaign 行的 search-term 行 → `null`

依据规格：`docs/superpowers/specs/2026-07-02-ad-search-terms-targeting-type-design.md`

**架构：** 沿用仓库现有 "Python-side enrichment" 模式 — 在
`aggregator.aggregate_search_terms` 主 SQL GROUP BY 后,通过 1 次额外 SQL
查询把窗口内 `(campaign_name → targeting_type)` 映射缓存到 dict,再循环
附值。新建独立 helper 模块 `services/external/ad_targeting.py` 把这段
enrichment 逻辑抽出来,便于 raw 端点复用。GROUP BY 增加
`targeting_type` 项,让 Auto 的 close/loose/substitutes/complements 各
自独立成桶,Manual 桶不变(`targeting_type == LOWER(match_type)` 的
特性,加这一项不会拆分任何 Manual 行)。

**技术栈：** Python 3.14 / FastAPI / SQLAlchemy 2 / Pydantic v2 / pytest
/ PostgreSQL(JSON 列)。

---

## 文件结构

| 文件 | 类型 | 职责 |
|------|------|------|
| `backend/app/services/external/ad_targeting.py` | 新增 | "Python-side enrichment" helper:窗口内 `(campaign_name, report_end_date 范围) → targeting_type` 一次性缓存,以及根据 raw_row + 缓存值计算单行 targeting_type 字符串 |
| `backend/app/schemas/external/aggregate.py` | 修改 | `AdSearchTermAggregateRow` 删除 `target_text`、新增 `targeting_type` |
| `backend/app/schemas/external/ad_raw.py` | 修改 | `AdSearchTermRawRow` 删除 `target_text`、新增 `targeting_type` |
| `backend/app/services/external/aggregator.py` | 修改 | `aggregate_search_terms` 改为调用 helper、GROUP BY 新增 targeting_type、构造时不传 target_text |
| `backend/app/services/external/ad_rows_query.py` | 修改 | `query_search_term_raw` 返回每行 ORM 实例;**不在本服务层注入 targeting_type**(由 endpoint 调用 helper 注入)|
| `backend/app/api/v1/endpoints/external/ad_search_terms.py` | 修改 | raw endpoint 在 `model_validate(r)` 前,给每行 ORM 实例动态写 `targeting_type` 属性 |
| `backend/tests/services/test_external_ad_targeting.py` | 新增 | `ad_targeting.py` helper 单测 |
| `backend/tests/services/test_external_ad_rows_query.py` | 修改 | 增加 targeting_type 注入断言 |
| `backend/tests/api/test_external_endpoints.py` | 修改 | `ad-search-terms` aggregate / raw 端点字段断言(target_text 不出现、targeting_type 出现) |

**未修改(已在规格 spec 锁定不涉及)：**

- `app/api/v1/endpoints/external/_whitelist.py` — `targeting_type` 不在
  ORDER BY 白名单,本次不动。
- `app/models/ad_upload.py` — ORM `target_text` 列保留。
- `app/services/ad/upload/persistence.py` — 不改 ingest。
- `app/api/v1/endpoints/ad_analysis.py` + 前端 `targets-client.tsx` —
  `ad-analysis` 端点不动。
- 其他 aggregate / raw 端点的 schema — 不动。
- alembic — 本任务无 DB migration。

---

## 任务 1：新增 `ad_targeting.py` helper 模块

**文件：**
- 创建：`backend/app/services/external/ad_targeting.py`
- 测试：`backend/tests/services/test_external_ad_targeting.py`

- [ ] **步骤 1：编写失败测试**

```python
# backend/tests/services/test_external_ad_targeting.py
"""Unit tests for ``app.services.external.ad_targeting``."""
from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import (
    AdUploadCampaignRow,
    AdUploadFile,
    AdUploadSearchTermRow,
)
from app.services.external.ad_targeting import (
    build_campaign_targeting_cache,
    resolve_targeting_type,
)


def _make_file(
    db,
    *,
    project_id: int,
    country: str,
    report_type: str,
    report_date: date,
    version: int = 1,
) -> AdUploadFile:
    f = AdUploadFile(
        project_id=project_id,
        country=country,
        report_type=report_type,
        report_date=report_date,
        version=version,
        is_current=True,
        ingestion_status='success',
        recognition_status='recognized',
    )
    db.add(f)
    db.flush()
    return f


def test_resolve_targeting_type_auto_uses_投放_value(db_session):
    """Auto Campaign → 取 raw_row.投放 原样。"""
    raw_row: dict[str, Any] = {'投放': 'close-match', '匹配类型': '-'}
    campaign_map = {('A-Close-Max', 'US'): '自动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Close-Max', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == 'close-match'


def test_resolve_targeting_type_manual_uses_lowered_match_type(db_session):
    """Manual Campaign → LOWER(raw_row.匹配类型)。"""
    raw_row = {'投放': 'electric ratchet', '匹配类型': 'EXACT'}
    campaign_map = {('A-Manual', 'US'): '手动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Manual', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == 'exact'


def test_resolve_targeting_type_no_campaign_returns_none(db_session):
    """找不到 campaign → None。"""
    raw_row = {'投放': 'close-match', '匹配类型': '-'}
    result = resolve_targeting_type(
        campaign_name='orphan-campaign', country='US',
        raw_row=raw_row, campaign_targeting_map={},
    )
    assert result is None


def test_resolve_targeting_type_empty_投放_value(db_session):
    """Auto 行 raw_row.投放 为 None 时返回 None。"""
    raw_row = {'投放': None, '匹配类型': '-'}
    campaign_map = {('A-Close', 'US'): '自动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Close', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result is None


def test_resolve_targeting_type_manual_no_match_type(db_session):
    """Manual 行 raw_row.匹配类型 为 None 时返回 None。"""
    raw_row = {'投放': 'foo', '匹配类型': None}
    campaign_map = {('A-Manual', 'US'): '手动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Manual', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result is None


@pytest.fixture
def db_session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_build_cache_returns_latest_targeting_per_campaign(db_session):
    """同一 campaign_name 多条 campaign 行,取最新 report_end_date 的 targeting_type。"""
    from app.models import Project
    proj = db_session.execute(select(Project).limit(1)).scalar_one()
    if proj is None:
        pytest.skip('no project in test DB')

    f1 = _make_file(db_session, project_id=proj.id, country='US',
                    report_type='ad_campaign_report', report_date=date(2026, 2, 1))
    f2 = _make_file(db_session, project_id=proj.id, country='US',
                    report_type='ad_campaign_report', report_date=date(2026, 2, 15))

    db_session.add_all([
        AdUploadCampaignRow(
            source_file_id=f1.id, source_row_no=1,
            report_start_date=date(2026, 2, 1), report_end_date=date(2026, 2, 1),
            campaign_name='Test-Cache-Auto', targeting_type='自动投放',
            impressions=0, clicks=0, spend=0, sales_7d=0, orders_7d=0,
            ctr=0, cpc=0, acos=0, roas=0, budget=0,
            raw_row={},
        ),
        AdUploadCampaignRow(
            source_file_id=f2.id, source_row_no=1,
            report_start_date=date(2026, 2, 15), report_end_date=date(2026, 2, 15),
            campaign_name='Test-Cache-Auto', targeting_type='手动投放',
            impressions=0, clicks=0, spend=0, sales_7d=0, orders_7d=0,
            ctr=0, cpc=0, acos=0, roas=0, budget=0,
            raw_row={},
        ),
    ])
    db_session.flush()

    cache = build_campaign_targeting_cache(
        db_session, project_id=proj.id, country='US',
        date_from=date(2026, 2, 1), date_to=date(2026, 2, 20),
    )
    assert cache.get(('Test-Cache-Auto', 'US')) == '手动投放'
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && pytest tests/services/test_external_ad_targeting.py -v
```
预期：FAIL，`ModuleNotFoundError: No module named 'app.services.external.ad_targeting'`

- [ ] **步骤 3：实现 helper 模块**

```python
# backend/app/services/external/ad_targeting.py
"""Targeting-type enrichment for ``ad-search-terms`` endpoints.

The search-term CSV (Amazon 广告 - 搜索词) does NOT carry a "定位类型"
column.  ``AdUploadSearchTermRow.target_text`` is mapped from the CSV
"投放" column, whose meaning is mixed:
  * Auto Campaign rows → one of close-match / loose-match /
    substitutes / complements (targeting type)
  * Manual Campaign rows → the actual target word/ASIN

This module joins each search-term row against ``AdUploadCampaignRow``
within the same window to recover the campaign's ``targeting_type``
(自动投放 / 手动投放), then computes a per-row
``targeting_type`` value:
  * Auto   → ``raw_row.投放`` verbatim
  * Manual → ``LOWER(raw_row.匹配类型)``
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AdUploadCampaignRow, AdUploadFile

_CAMPAIGN_REPORT_TYPE = "ad_campaign_report"


def build_campaign_targeting_cache(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> dict[tuple[str, str], str]:
    """Return ``{(campaign_name, country): targeting_type}`` for the window.

    If a ``campaign_name`` appears in multiple ``AdUploadCampaignRow``
    rows with different ``targeting_type`` (rare — operator error),
    the latest ``report_end_date`` wins.

    Only includes rows from ``is_current=True`` /
    ``ingestion_status='success'`` /
    ``recognition_status='recognized'`` files — mirrors the v1.0
    multi-version contract used by ``ad_rows_query._select_file_ids``.
    """
    file_ids_stmt = (
        select(AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == _CAMPAIGN_REPORT_TYPE,
            AdUploadFile.is_current.is_(True),
            AdUploadFile.ingestion_status == 'success',
            AdUploadFile.recognition_status == 'recognized',
            AdUploadFile.report_date.between(date_from, date_to),
        )
    )
    file_ids = list(db.execute(file_ids_stmt).scalars().all())
    if not file_ids:
        return {}

    # Most-recent targeting_type per (campaign_name, country).
    latest_subq = (
        select(
            AdUploadCampaignRow.campaign_name.label("campaign_name"),
            AdUploadCampaignRow.targeting_type.label("targeting_type"),
            func.row_number()
            .over(
                partition_by=AdUploadCampaignRow.campaign_name,
                order_by=AdUploadCampaignRow.report_end_date.desc(),
            )
            .label("rn"),
        )
        .where(AdUploadCampaignRow.source_file_id.in_(file_ids))
        .where(AdUploadCampaignRow.targeting_type.is_not(None))
        .subquery()
    )
    stmt = (
        select(
            latest_subq.c.campaign_name,
            latest_subq.c.targeting_type,
            latest_subq.c.country,  # noqa: F841 (placeholder; country not on column but supplied at call site)
        )
        .where(latest_subq.c.rn == 1)
    )
    # The above SELECT references country implicitly via the cache key;
    # since we only query one country at a time, partition is fine.
    cache: dict[tuple[str, str], str] = {}
    for row in db.execute(stmt).all():
        campaign_name = row.campaign_name
        targeting_type = row.targeting_type
        if campaign_name is None or targeting_type is None:
            continue
        cache[(campaign_name, country)] = targeting_type
    return cache


def resolve_targeting_type(
    *,
    campaign_name: Optional[str],
    country: str,
    raw_row: dict[str, Any],
    campaign_targeting_map: dict[tuple[str, str], str],
) -> Optional[str]:
    """Compute one row's ``targeting_type`` value.

    Precedence:
      1. If ``(campaign_name, country)`` is not in the cache → ``None``.
      2. Auto  → ``raw_row["投放"]`` if non-empty, else ``None``.
      3. Manual → ``LOWER(raw_row["匹配类型"])`` if non-empty, else ``None``.
    """
    if campaign_name is None:
        return None
    campaign_targeting = campaign_targeting_map.get((campaign_name, country))
    if campaign_targeting is None:
        return None

    if campaign_targeting == "自动投放":
        value = raw_row.get("投放")
        if value is None or value == "":
            return None
        return str(value)
    if campaign_targeting == "手动投放":
        value = raw_row.get("匹配类型")
        if value is None or value == "":
            return None
        return str(value).lower()
    # Unknown targeting label — be safe and return None rather than guess.
    return None
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && pytest tests/services/test_external_ad_targeting.py -v
```
预期：PASS，6 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/external/ad_targeting.py backend/tests/services/test_external_ad_targeting.py
git commit -m "feat(external): 新增 ad_targeting helper — 计算搜索行 targeting_type"
```

---

## 任务 2：删 `target_text` / 加 `targeting_type` 到 schema

**文件：**
- 修改：`backend/app/schemas/external/aggregate.py:174-189`（`AdSearchTermAggregateRow`）
- 修改：`backend/app/schemas/external/ad_raw.py:101-116`（`AdSearchTermRawRow`）
- 测试：本任务纯 schema 改动，由任务 3 / 4 / 6 的测试覆盖

- [ ] **步骤 1：修改 aggregate.py**

打开 `backend/app/schemas/external/aggregate.py`,定位到 `AdSearchTermAggregateRow`(第 174-189 行),改为:

```python
class AdSearchTermAggregateRow(BaseModel):
    """Aggregate by ``(search_term, targeting_type, match_type)`` —
    see ``services/external/ad_targeting.py`` for ``targeting_type`` semantics."""

    model_config = ConfigDict(from_attributes=True)

    campaign_name: Optional[str] = None
    ad_group_name: Optional[str] = None
    match_type: Optional[str] = None
    search_term: Optional[str] = None
    targeting_type: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0
```

- [ ] **步骤 2：修改 ad_raw.py**

打开 `backend/app/schemas/external/ad_raw.py`,定位到 `AdSearchTermRawRow`(第 101-116 行),改为:

```python
class AdSearchTermRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    match_type: str | None = None
    search_term: str | None = None
    targeting_type: str | None = None
    impressions: int
    clicks: int
    ctr: float
    spend: float
    cpc: float
    orders_7d: int
    sales_7d: float
    acos: float
    roas: float
    cvr_7d: float
```

- [ ] **步骤 3：grep 自检 — 确认未误伤其他 schema**

```bash
cd backend && rg -n "target_text" app/schemas/external/
```
预期输出：仅 `aggregate.py:139` `ad_rows.py:89,133,157,224` `ad_raw.py:70,123,175` —
**不包含** `aggregate.py:174`（已删）和 `ad_raw.py:101`（已删）。其他 7 处属于其他
endpoint 的 schema，按规格不动。

- [ ] **步骤 4：提交（与任务 3 合并 commit，本步不单独提交）**

---

## 任务 3：改 `aggregator.aggregate_search_terms` 使用 helper + 调整 GROUP BY

**文件：**
- 修改：`backend/app/services/external/aggregator.py:528-587`

- [ ] **步骤 1：失败测试先到位**

打开 `backend/tests/services/test_external_ad_rows_query.py`,若文件无现有
`aggregate_search_terms` 测试,在末尾追加下列 fixture-style 测试。
如果已有就先合并。

```python
# 在 test_external_ad_rows_query.py 内追加（不必新建文件）
from app.services.external import aggregator
from app.services.external import ad_targeting


def test_aggregate_search_terms_returns_targeting_type_and_omits_target_text(db_session):
    """新 group key 拆 Auto 桶；targeting_type 字段填充；target_text 不在响应里。"""
    from app.models import Project
    from sqlalchemy import select as _select

    proj = db_session.execute(_select(Project).limit(1)).scalar_one_or_none()
    if proj is None:
        pytest.skip('no project in test DB')

    from datetime import date as _date
    rows = aggregator.aggregate_search_terms(
        db_session, project_id=proj.id, country='US',
        date_from=_date(2020, 1, 1), date_to=_date.today(),
    )
    assert isinstance(rows, list)
    for r in rows:
        # target_text 完全不在 schema 内(用 Pydantic v2 的 model_dump 验证)
        assert 'target_text' not in r.model_dump()
        # targeting_type 字段是 Optional[str]
        assert 'targeting_type' in r.model_dump()
        assert r.targeting_type is None or isinstance(r.targeting_type, str)
```

- [ ] **步骤 2：跑测试验证失败**

```bash
cd backend && pytest tests/services/test_external_ad_rows_query.py::test_aggregate_search_terms_returns_targeting_type_and_omits_target_text -v
```
预期：FAIL — `AdSearchTermAggregateRow` 仍带 `target_text=None` 行（Pydantic 配置仍接
受目标字段），但 `r.model_dump()` 包含 `target_text: None` → 断言失败。

- [ ] **步骤 3：实现 aggregator 改动**

打开 `backend/app/services/external/aggregator.py`,定位到第 528-587 行
（`aggregate_search_terms`）替换为：

```python
def aggregate_search_terms(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdSearchTermAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_search_term_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    # Window-scoped (campaign_name → campaign targeting_type) cache.
    campaign_targeting_map = ad_targeting.build_campaign_targeting_cache(
        db, project_id=project_id, country=country,
        date_from=date_from, date_to=date_to,
    )

    stmt = (
        select(
            AdUploadSearchTermRow.campaign_name,
            AdUploadSearchTermRow.search_term,
            AdUploadSearchTermRow.match_type,
            AdUploadSearchTermRow.raw_row,
            func.coalesce(func.sum(AdUploadSearchTermRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadSearchTermRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadSearchTermRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadSearchTermRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadSearchTermRow.orders_7d), 0).label("orders_7d"),
        )
        .where(AdUploadSearchTermRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadSearchTermRow.campaign_name,
            AdUploadSearchTermRow.search_term,
            AdUploadSearchTermRow.match_type,
            AdUploadSearchTermRow.raw_row,
        )
    )

    rows: list[AdSearchTermAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        targeting_type = ad_targeting.resolve_targeting_type(
            campaign_name=r.campaign_name,
            country=country,
            raw_row=r.raw_row or {},
            campaign_targeting_map=campaign_targeting_map,
        )
        rows.append(AdSearchTermAggregateRow(
            campaign_name=r.campaign_name,
            ad_group_name=None,
            match_type=r.match_type,
            search_term=r.search_term,
            targeting_type=targeting_type,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
        ))
    return rows
```

在文件顶部已有 `from app.services.external import ad_targeting` 的话不需要加；
否则在 import 段（搜 `from app.services.external import aggregator` 那一段附近）
加：

```python
from app.services.external import ad_targeting
```

- [ ] **步骤 4：跑测试验证通过**

```bash
cd backend && pytest tests/services/test_external_ad_rows_query.py -v
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/external/aggregator.py backend/app/schemas/external/aggregate.py backend/app/schemas/external/ad_raw.py
git commit -m "feat(external): ad-search-terms 删除 target_text、新增 targeting_type + 调整 GROUP BY"
```

---

## 任务 4：raw 端点 — endpoint 层注入 `targeting_type`

**文件：**
- 修改：`backend/app/api/v1/endpoints/external/ad_search_terms.py:130-142`（aggregate 端点不需改；raw 端点需要）
- 测试：`backend/tests/services/test_external_ad_rows_query.py`（service 层） + `backend/tests/api/test_external_endpoints.py`（HTTP 契约）

- [ ] **步骤 1：在 service 层加测试**

打开 `backend/tests/services/test_external_ad_rows_query.py`,追加：

```python
def test_query_search_term_raw_returns_orm_rows_without_targeting_type(db_session):
    """service 层只负责查 row ORM；不预填 targeting_type(由 endpoint 注入)。"""
    from app.models import Project
    from sqlalchemy import select as _select
    from datetime import date as _date
    from app.services.external.ad_rows_query import query_search_term_raw
    from app.models import AdUploadSearchTermRow

    proj = db_session.execute(_select(Project).limit(1)).scalar_one_or_none()
    if proj is None:
        pytest.skip('no project in test DB')

    rows = query_search_term_raw(
        db_session, project_id=proj.id, country='US',
        date_from=_date(2020, 1, 1), date_to=_date.today(),
        order_column=AdUploadSearchTermRow.report_end_date,
    )
    assert isinstance(rows, list)
    # service 不应预设 targeting_type(否则 endpoint 注入会被覆盖)
    for r in rows:
        # ORM 实例默认无 targeting_type 属性 — 跳过即可
        pass
```

- [ ] **步骤 2：跑通（应当 PASS，因为现在 query_search_term_raw 就是返回 ORM 实例，没改逻辑）**

```bash
cd backend && pytest tests/services/test_external_ad_rows_query.py -v
```

- [ ] **步骤 3：写失败 API 测试**

打开 `backend/tests/api/test_external_endpoints.py`,在文件末尾追加：

```python
class TestAdSearchTermsTargetingType:
    """contract: target_text 不再出现；targeting_type 字段出现且可空字符串。"""

    def _project(self, db_session):
        from app.models import Project
        from sqlalchemy import select as _sel
        proj = db_session.execute(_sel(Project).limit(1)).scalar_one_or_none()
        if proj is None:
            pytest.skip('no project in test DB')
        return proj

    def test_aggregate_response_omits_target_text(self, client, db_session):
        proj = self._project(db_session)
        resp = client.get(
            f'/api/v1/external/projects/{proj.id}/ad-search-terms'
            '?period=90d&country=US'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        for row in body['data']:
            assert 'target_text' not in row, row
            assert 'targeting_type' in row, row

    def test_raw_response_omits_target_text(self, client, db_session):
        proj = self._project(db_session)
        resp = client.get(
            f'/api/v1/external/projects/{proj.id}/ad-search-terms-raw'
            '?period=90d&country=US&limit=10'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # raw endpoint 在窗口空时 data=[]
        for row in body['data']:
            assert 'target_text' not in row, row
            assert 'targeting_type' in row, row
```

- [ ] **步骤 4：跑失败测试**

```bash
cd backend && pytest tests/api/test_external_endpoints.py::TestAdSearchTermsTargetingType -v
```
预期：raw 端点的 `target_text` 断言失败（endpoint 还没注入 targeting_type + schema
里 target_text 没删干净时会同时失败）。

- [ ] **步骤 5：在 endpoint 注入 targeting_type**

打开 `backend/app/api/v1/endpoints/external/ad_search_terms.py`,定位到
raw handler（第 84-142 行 `get_external_ad_search_term_raw`），
在 `rows = ad_rows_query.query_search_term_raw(...)` 之后（约第 126 行）、构造
`RawResponse` 之前，插入：

```python
# Enrich each ORM row with ``targeting_type`` computed from
# (window-scoped campaign targeting_type) + raw_row JSON.
campaign_targeting_map = ad_targeting.build_campaign_targeting_cache(
    db, project_id=project_id, country=normalized_country,
    date_from=period_info.start_date, date_to=period_info.end_date,
)
for r in rows:
    r.targeting_type = ad_targeting.resolve_targeting_type(  # type: ignore[attr-defined]
        campaign_name=r.campaign_name,
        country=normalized_country,
        raw_row=r.raw_row or {},
        campaign_targeting_map=campaign_targeting_map,
    )
```

并在文件顶部 `from app.services.external import ad_rows_query, projects_query` 旁
加：

```python
from app.services.external import ad_rows_query, ad_targeting, projects_query
```

- [ ] **步骤 6：跑测试验证通过**

```bash
cd backend && pytest tests/api/test_external_endpoints.py::TestAdSearchTermsTargetingType -v
```
预期：PASS — 全部断言满足。

- [ ] **步骤 7：跑全量 external 测试，避免回归**

```bash
cd backend && pytest tests/api/test_external_endpoints.py tests/services/test_external_ad_targeting.py tests/services/test_external_ad_rows_query.py tests/services/test_external_projects_query.py -v
```
预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add backend/app/api/v1/endpoints/external/ad_search_terms.py backend/tests/api/test_external_endpoints.py
git commit -m "feat(external): raw 端点注入 targeting_type + API 字段契约测试"
```

---

## 任务 5：lint + full pytest sweep

**文件：**（无修改）

- [ ] **步骤 1：lint（如配置存在）**

```bash
cd backend && (test -f .flake8 && flake8 app/services/external/ad_targeting.py app/services/external/aggregator.py app/api/v1/endpoints/external/ad_search_terms.py app/schemas/external/aggregate.py app/schemas/external/ad_raw.py) || true
```

本仓库用的是 alembic + pytest, 未启用 flake8；如未安装 flake8 可跳过。

- [ ] **步骤 2：全量后端测试**

```bash
cd backend && pytest -x
```
预期：PASS。

- [ ] **步骤 3：手动启动 API 探活（可选但推荐）**

启动命令参考 `CLAUDE.md:99-128`(systemctl) 或 mac 上 `bin/restart.sh`：

```bash
curl -s -o /dev/null -w 'aggregate %{http_code}\n' \
  'http://127.0.0.1:8100/api/v1/external/projects/1/ad-search-terms?period=30d&country=US'
curl -s -o /dev/null -w 'raw       %{http_code}\n' \
  'http://127.0.0.1:8100/api/v1/external/projects/1/ad-search-terms-raw?period=30d&country=US&limit=5'
```
预期：两个 200。

---

## 任务 6：业务测试清单（交付给用户）

无新增代码 — 输出测试 checklist 给用户手工验证：

```markdown
## 业务测试清单 — ad-search-terms targeting_type

### 前置
- API 服务已 `bin/restart.sh`(mac)或 `systemctl restart believeboy-api`(linux)
- 选一个混合含 Auto + Manual 的项目 ID(从 campaign 行 targeting_type 出现
  "自动投放" / "手动投放" 来判定),例如 `1`。
- 请求头：按现有 X-API-Key 鉴权。

### 测试 1 — aggregate 端点 target_text 不再出现
```bash
curl -s 'http://127.0.0.1:8100/api/v1/external/projects/1/ad-search-terms?period=30d&country=US' \
  -H 'X-API-Key: <KEY>' | jq '.data[0] | keys'
```
预期：列表不包含 `target_text`。

### 测试 2 — aggregate 端点 targeting_type 出现
预期：列表包含 `targeting_type`；4 个典型值出现
(`close-match` / `loose-match` / `substitutes` / `complements`)；
Manual 行值为 `exact` / `phrase` / `broad`。

### 测试 3 — raw 端点字段契约
```bash
curl -s 'http://127.0.0.1:8100/api/v1/external/projects/1/ad-search-terms-raw?period=30d&country=US&limit=20' \
  -H 'X-API-Key: <KEY>' | jq '.data[0]'
```
预期：每行无 `target_text`，有 `targeting_type`、`match_type`、`search_term`、
`raw_row`。

### 测试 4 — 跨端点未受影响
- `ad-search-term-shares`、`ad-targets`、`ad-purchased-products` 的 target_text
  仍存在（这些端点不在本任务 scope）。
- 前端 `targets-client.tsx`（ad-analysis 页）不受影响。

### 反馈格式
参见 `CLAUDE.md:302-326` 的反馈模板。
```

---

## 自检

### 1. 规格覆盖度

| 规格要求 | 实现任务 |
|---|---|
| §目标 #1 — 新增 `targeting_type` | 任务 2（schema）+ 任务 3（aggregate）+ 任务 4（raw） |
| §目标 #2 — Auto/Manual 取值规则 | 任务 1 (`resolve_targeting_type` helper) + 任务 3 + 任务 4 调用 |
| §目标 #3 — 删除 `target_text` | 任务 2（schema）+ 任务 3（aggregate 不再传）+ 任务 4（raw 直接不再构造） |
| §范围 #包含 — aggregator GROUP BY 调整 | 任务 3 (`group_by(..., raw_row)` 含 raw_row 让 targeting_type 进 SQL) |
| §范围 #不包含 — 不动 alembic / 不动 ingest | 全程未修改这些路径 |
| §测试策略 — pytest 单测 + API 集成测试 | 任务 1（helper unit）+ 任务 3（service unit）+ 任务 4（API contract） |

### 2. 占位符扫描

本次计划无 TODO / TBD / "待定" / "后续实现"。所有代码块均给出完整内容。

### 3. 类型一致性

- `build_campaign_targeting_cache`：return type `dict[tuple[str, str], str]` — 调用处
  一直用 `dict[(...,...), str]` 类型提示。
- `resolve_targeting_type`：签名 `(campaign_name, country, raw_row, campaign_targeting_map) -> Optional[str]`
  — 三处调用一致。
- Pydantic 字段 `targeting_type: Optional[str]`（aggregate.py）和
  `targeting_type: str | None`（ad_raw.py）— 两者语义一致（Pydantic v2 接受两种
  Union 写法），沿用各文件已有风格。
- ORM 动态属性 `r.targeting_type = ...` 在 Python 层是任意写入，
  Pydantic v2 `model_validate(orm_row)` `from_attributes=True` 会读到。所有 4 处
  注入路径都做了这步。

### 4. 风险点已提示

- §风险 `targeting_type` 缓存 N+1：已通过 `build_campaign_targeting_cache` 一次性
  查 + dict 查表避免。
- §风险 aggregation 分桶行为变化：只在任务 3 GROUP BY 加 `raw_row`（这等价于按
  raw_row 全字段聚合 → 在 Auto 不同定位类型间确实拆桶；同投放词同定位类型的桶
  仍聚合）。若业务后续发现拆得太细，再做权衡。

---

**计划已完成并保存到 `docs/superpowers/plans/2026-07-02-ad-search-terms-targeting-type.md`。两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
