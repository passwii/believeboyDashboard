# ad-search-terms 端点新增 targeting_type 字段规格

## 背景

外部 BI 团队反馈:`GET /external/projects/{id}/ad-search-terms` 与
`/ad-search-terms-raw` 两个端点对 Auto Campaign 返回的数据语义不完整。

- `match_type` 字段对 Auto Campaign 永远是 `"-"`,无法区分
  `close-match / loose-match / substitutes / complements` 四种定位类型。
- `target_text` 字段在 Auto Campaign 实际存的就是定位类型值
  (`"close-match"` 等),不是投放词/ASIN;BI 端读到的语义是错的。
- 真实数据全部能在 `raw_row->>'投放'`(Auto)和 `raw_row->>'匹配类型'`(Manual)
  找到 — 这两列一直由 `app/services/ad/upload/persistence.py:_raw_row_dict`
  完整保存到 `AdUploadSearchTermRow.raw_row` JSON 里,只是没被 schema 暴露。

### 实测样本(本地 DB 抽样,2026-07-02)

`ad_upload_search_term_rows.raw_row` 里 `投放` 列的 distinct top 值:

| 值 | 行数 | 含义 |
|---|---|---|
| `close-match` | 3041 | 自动投放 - 紧密匹配 |
| `substitutes` | 1743 | 自动投放 - 替代品 |
| `loose-match` | 1275 | 自动投放 - 宽泛匹配 |
| `electric ratchet` | 173 | 手动投放 - 关键词 |
| `category="..."` | 200+ | 手动投放 - 类目投放 |
| `asin-expanded="..."` | 5 | 手动投放 - ASIN 拓展 |
| `keyword-group="..."` | 51 | 手动投放 - 关键词组 |

`匹配类型` 列的 distinct top 值:

| 值 | 行数 | 含义 |
|---|---|---|
| `-` | 6470 | 自动投放(无匹配类型语义) |
| `PHRASE` | 837 | 手动投放 - 词组匹配 |
| `EXACT` | 154 | 手动投放 - 精确匹配 |
| `BROAD` | 108 | 手动投放 - 广泛匹配 |

## 目标

1. 在 `ad-search-terms` 和 `ad-search-terms-raw` 两个端点的响应行里
   **新增** `targeting_type` 字段。
2. 字段取值规则 — 用户确认的 SQL 表达式:

   ```sql
   CASE
     WHEN campaign.targeting_type = '自动投放' THEN raw_row->>'投放'
     WHEN campaign.targeting_type = '手动投放' THEN LOWER(raw_row->>'匹配类型')
   END AS targeting_type
   ```

   - Auto Campaign → 取原始 4 选 1(`close-match` / `loose-match` / `substitutes` /
     `complements`)或同行的其他特殊值(如 `asin="..."`)。
   - Manual Campaign → 取 `exact` / `phrase` / `broad` 三选 1
     (来自 `raw_row.匹配类型` 大写 → 小写归一化)。
   - Campaign 行没有 `targeting_type` 记录(历史数据回溯不到)→ 返回 `null`。

3. **向后兼容**:不动 `match_type` / `target_text` / 任何已有字段。
4. **不引入新枚举映射**:值即 `raw_row` 原文 / 小写化原文。BI 端需要枚举语义时,
   自行维护映射表。

## 范围

### 包含

- `backend/app/schemas/external/aggregate.py`
  - `AdSearchTermAggregateRow` 增加 `targeting_type: Optional[str] = None`
- `backend/app/schemas/external/ad_raw.py`
  - `AdSearchTermRawRow` 增加 `targeting_type: Optional[str] = None`
- `backend/app/services/external/aggregator.py`
  - `aggregate_search_terms(...)` 业务键从 `(search_term, match_type)`
    改为 `(search_term, targeting_type, match_type)` —
    防止 close-match / substitutes 被并到同一聚合桶。
  - 聚合输出里加 `targeting_type` 字段(取值规则见目标 #2)。
- `backend/app/services/external/ad_rows_query.py`
  - `query_search_term_raw(...)` 每行输出加 `targeting_type`。
  - `order_by` 白名单增加 `targeting_type`(可选,随主流程)。

### 不包含

- **不**重命名 / **不**改 `target_text` / `match_type` 语义。
- **不**新建表 / **不**改 ingest pipeline / **不**重写历史 raw_row。
- **不**改 `ad-search-term-share` / `ad-target` 等其他端点 —
  以后按需扩展。
- **不**做 enum 类型校验 / Literal[...] 强制 —
  内部 raw_row 自由度高,API 端用 `Optional[str]` 兜底。
- **不**处理 campaign 没有对应 `AdUploadCampaignRow` 的回溯情况
  (历史 manual campaign 没上传过 campaign report 时,`targeting_type` 返回 `null`,
  已在测试覆盖)。

## 设计

### 1. Schema 改动

#### `aggregate.py` — `AdSearchTermAggregateRow`

```python
class AdSearchTermAggregateRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    campaign_name: Optional[str] = None
    ad_group_name: Optional[str] = None
    target_text: Optional[str] = None
    match_type: Optional[str] = None
    search_term: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    ...
    # 新增 — 见 §背景 的目标规则
    targeting_type: Optional[str] = None
```

#### `ad_raw.py` — `AdSearchTermRawRow`

```python
class AdSearchTermRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    target_text: str | None = None
    match_type: str | None = None
    search_term: str | None = None
    ...
    # 新增 — 同 §背景 的目标规则
    targeting_type: str | None = None
```

### 2. 字段取值表达式(SQLAlchemy)

新增 helper `services/external/ad_targeting.py`:

```python
from __future__ import annotations
from typing import Final

from sqlalchemy import case, cast, func, String
from sqlalchemy.sql import ColumnElement

# '投放' 列在 search-term 行:Auto 时=定位类型,Manual 时=投放词/ASIN
# '匹配类型' 列:Auto 时='-',Manual 时=EXACT/PHRASE/BROAD
#
# 决策:Auto → 取 投放;Manual → 取 LOWER(匹配类型)
#
# 以窗口内出现过的同 campaign_name 的 campaign.targeting_type 为准
# (campaign.targeting_type 在 AdUploadCampaignRow 已经存在,
# 见 persistence.py:112)

_AUTO_VALUE: Final = "自动投放"
_MANUAL_VALUE: Final = "手动投放"

def build_search_term_targeting_type_expr(
    search_term_raw_row,  # AdUploadSearchTermRow
    campaign_targeting_type_col,  # AdUploadCampaignRow.targeting_type 的引用
) -> ColumnElement[str]:
    """Compose targeting_type value per row.

    Case-A search_term 行在窗口内能从同 campaign_name 的
    AdUploadCampaignRow 查到 targeting_type:
        Auto  → search_term.raw_row['投放']
        Manual → LOWER(search_term.raw_row['匹配类型'])
    Case-B 查不到(历史 manual campaign 未上传过 campaign report):
        → None
    """
    raw_投放 = search_term_raw_row.raw_row["投放"].as_string()
    raw_匹配类型 = search_term_raw_row.raw_row["匹配类型"].as_string()
    return case(
        (campaign_targeting_type_col == _AUTO_VALUE, raw_投放),
        (campaign_targeting_type_col == _MANUAL_VALUE, func.lower(raw_匹配类型)),
        else_=None,
    )
```

实现要点:
- `raw_row` 是 JSON 列(Postgres JSON,不是 JSONB);SQLAlchemy
  `column[key].as_string()` 产出 `json ->> '投放'` 风格的 SQL。
- 关联查询用 `EXISTS` 子查询:窗口内任意一条 `AdUploadCampaignRow`
  满足 `campaign_name = outer.campaign_name AND
  report_end_date BETWEEN :start AND :end`,拿到
  `targeting_type`。**支持多个不同 targeting_type 的同名 campaign**
  (虽然极少见)。

实际写法 — 改用 `service-level` 而不是 SQL 一次执行聚合,避免
JSON cast 在 GROUP BY 里难处理。详见 §4。

### 3. Aggregate 改动(`aggregator.aggregate_search_terms`)

走 "Python-side enrichment" 路线(参考已有的
`aggregate_search_term_shares` 中
`latest.target_text if latest else None` 的写法,
在 `aggregator.py:631-646`):

1. **先**做现有 GROUP BY `(search_term, match_type)` 聚合得到结果集。
2. **再**对每个 bucket,根据 `(campaign_name, report_end_date 范围)`
   查同窗口的 `AdUploadCampaignRow`,得到该 campaign 的
   `targeting_type`。Auto 或 Manual 决定从 raw_row['投放']
   还是 raw_row['匹配类型'] 取值。
3. 加进返回 dict 的 `targeting_type` 字段。

由于第 2 步是 N+1 风险,我们改成:

- 主查询窗口内一次性查出 `(campaign_name, targeting_type)` 的 distinct 集合
  (`SELECT DISTINCT campaign_name, targeting_type FROM ...`)→ 一次性缓存。
- 然后循环里 O(1) dict 查表。

如果同一 `campaign_name` 在窗口内出现过 Auto **和** Manual 两条 campaign 行,
取最新一条 `report_end_date` 的 `targeting_type`(SELECT...ORDER BY ... LIMIT 1)。

#### 业务键调整

**建议业务键改为 `(search_term, targeting_type, match_type)`**
(否则 close-match 和 substitutes 会被并到一起,这是方案初衷)。

但请注意:Manual Campaign 行 `targeting_type` 从 LOWER(匹配类型) 得到
`exact/phrase/broad`,**正好等于** `match_type` 的小写。所以 Manual 行
`targeting_type == match_type`,加到 GROUP BY 里不会拆开任何已有的 Manual 桶。

Auto Campaign 行 `match_type` 永远等于 `-`,加 `targeting_type` 等于拆桶
— close / loose / substitutes / complements 各成一桶 ✓。

#### sql 输出

```python
return {
    ...
    'targeting_type': _resolve_targeting_type(r),  # helper from §3
}
```

### 4. Raw 改动(`ad_rows_query.query_search_term_raw`)

同样是 "Python enrichment" 路线(这是已有查询):
- 拿 `query_search_term_raw` 现行的结果集(每行一个 ORM 实例)。
- 一次性查同窗口的 `(campaign_name → targeting_type)` 表。
- 给每行附上 `targeting_type` 字段(计算规则同 §3)。
- 在 `model_validate(row)` 之前写入 row 对象(或传给 Pydantic 的
  `context` — 但本仓库用 `from_attributes=True` + `model_validate(orm_row)`,
  简单的做法是给实例 `row.targeting_type = ...` 动态赋值,Pydantic
  v2 读取是允许的)。

### 5. `_whitelist` 里加新排序键

`_whitelist.py:246-247` 现允许 `target_text` / `match_type` 排序。
在 `OrderBy 列白名单 for AdUploadSearchTermRow` 段加:

```python
targeting_type=literal_column("targeting_type"),  # 见 §6
```

但 `targeting_type` 不是 ORM 列,是 Python 阶段合成 — 不可能直接排。
**方案:不支持 targeting_type 排序。** 如果 BI 端需要,后续 PR 加。
本次改动不动 `_whitelist`,只在 OpenAPI / 文档说明。

### 6. OpenAPI 字段说明

`targeting_type` 在 Pydantic v2 的 OpenAPI schema 里只标 `Optional[str]`,
**不**用 `Literal[...]` — 因为未来 Amazon 后台可能会增加定位类型值。
BI 端按字符串消费即可。

## 测试策略

后端项目测试用 pytest。改动路径上的测试文件:

### 新增 / 修改

1. `backend/tests/api/test_external_endpoints.py`
   - 加 `assert "targeting_type" in row` 断言,验证 aggregate
     和 raw 响应里都出现新字段。
   - 加样例场景:
     - Auto Campaign 行:返回 4 个不同 `targeting_type` 值
       (`close-match` / `loose-match` / `substitutes` / `complements`)。
     - Manual Campaign 行:返回 `exact` / `phrase` / `broad`。
     - 没有对应 campaign 行的 search-term 行:`targeting_type` 为 `null`。

2. `backend/tests/services/test_external_ad_rows_query.py`
   - 验证 `query_search_term_raw` 输出每行带 `targeting_type` 字段,
     取值按 §3 规则。

3. (新增) `backend/tests/services/test_external_search_term_targeting.py`
   - 单元测试 `build_search_term_targeting_type_expr` 的 helper
     计算逻辑(给定 campaign.targeting_type + raw_row dict,断言输出)。
   - 单元测试 `_resolve_targeting_type` 的 campaign_name → targeting_type
     缓存命中/未命中。

### 手工 / 业务测试(给用户)

1. 拿一个含 Auto + Manual 都有的项目 ID,
   `GET /external/projects/{id}/ad-search-terms`,
   验证响应里:
   - Auto 行 `match_type="-"` 的同时 `targeting_type` 是 4 选 1。
   - Manual 行 `match_type="EXACT/PHRASE/BROAD"` 的同时
     `targeting_type` 是 `exact/phrase/broad`(小写)。
2. 同上,raw 行也验证。
3. 验证 history — 老 BI 调用没有 `targeting_type` 字段读取不会崩
   (`Optional`,Pydantic v2 不会因为缺字段报错)。

## 风险与回滚

### 风险

- **聚合分桶行为变化**:Auto 4 类以前被并到同一桶,现在拆成 4 桶。
  BI 端如果按 `total_spend` 排序看 "top-N",可能看到靠前的桶会变。
  这是预期收益。
- **`targeting_type` 计算依赖 campaign 行存在**:如果整个项目从未上传过
  campaign 报告,`targeting_type` 全 null。已在 §不包含 公开范围,
  后续 P2 可补 campaign-name-level 的 fallback(读广告活动名称里的
  "Auto"/"手动" 关键字 — 易错,先不做)。

### 回滚

仅 SQLAlchemy 表达式 / Pydantic 字段 — 直接 `git revert` 即可。无 DB
migration、无 ingest 变更、不动已有数据。

## 实施顺序(过渡到 writing-plans)

1. 加 `services/external/ad_targeting.py`(helper)。
2. 改 `schemas/external/aggregate.py` 和 `schemas/external/ad_raw.py`。
3. 改 `services/external/aggregator.py:aggregate_search_terms`。
4. 改 `services/external/ad_rows_query.py:query_search_term_raw`。
5. 加 pytest 单元 + 集成测试。
6. 跑 `pytest backend/tests/` 全量通过。
7. 提供手工业务测试清单给用户。

## 开放问题(已确认)

| # | 问题 | 决策 |
|---|------|------|
| 1 | 数据源 | `raw_row.投放`(Auto)+ `LOWER(raw_row.匹配类型)`(Manual),从 campaign 行的 `targeting_type` 决定走哪支 |
| 2 | 是否改 GROUP KEY | 改:`(search_term, targeting_type, match_type)` |
| 3 | 是否动 `target_text` / `match_type` 语义 | 不动,后向兼容 |
| 4 | 是否加 enum Literal[...] | 不加,字符串 |
| 5 | 是否同步改其他端点(share/target) | 不改,本任务范围 |
