# 退货分析 · 亚马逊原始数据 Tab + Excel sheet 设计规格

> **状态**：**设计定稿**（2026-09-14 三轮拍板：D1 原始数据范围＝仅退货报表原始行 / D2 前端形态＝新增「原始数据」Tab / D3 数据链路＝独立端点 + 懒加载 / D4 列口径＝原始列 + 中文翻译列；另定 D5 导出前必须拿到原始行，否则中止导出；详见 §0.3 的追加拍板——DTO 管道修复与契约重生成）。
> **范围**：`/dashboard/operations/return-analysis` 页面新增「原始数据」Tab，导出 Excel 新增「亚马逊原始数据」sheet。**本 spec 只设计，不含实施**；实施计划见 [`docs/superpowers/plans/2026-09-14-return-analysis-raw-data-export.md`](../plans/2026-09-14-return-analysis-raw-data-export.md)。
> **工单编号**：团队暂未分配；代码注释以「退货分析原始数据」描述，不臆造 BLF/BEL 编号。
> **不动的东西**（约束，实施时逐条核对）：`/api/v1/return-analysis` 主响应与 Redis v2 缓存、`build_return_analysis()` 输出 schema、Agent 5 条退货路由、`/return-analysis-raw` 的 PII 白名单、现有 5 个 Excel sheet 的顺序与内容。

---

## 0. 背景与问题

退货分析页当前只呈现**分析结果**（排行 / 原因 / 趋势 / 商品状态 / 库存状态 / 顾客反馈 / AI 总结），导出的 Excel 也只有这 5 张结果 sheet。业务方拿到导出文件后无法回溯到亚马逊原始报表行，对账时要回去翻原始报表，链路断裂。

诉求：**把所选周期的亚马逊原始数据一并导出**（Excel 一张 sheet），并且**前端页面上也要能看**。

### 0.1 关键前提（代码核实 2026-09-14）

原始数据**已经在库里、且已经按周期查询**，这是本功能零数据层风险的根本原因：

| 事实 | 证据 |
|---|---|
| 退货原始行落在 `analysis_return_rows`，每行保留亚马逊原列 + `raw_row` JSON 原样一行 | `backend/app/models/product_analysis_source.py:308` |
| 每行归属一次报表上传版本 `analysis_source_files`（`report_type='return_report'`、`is_current`） | 同上 `:31`、`:331` |
| 分析函数**已经把该周期的原始行全查出来了**（`records`），只是没往外传 | `backend/app/services/analysis/return_analysis/analysis.py:722-740`（fallback 路径）、`:1246-1263`（snapshot 路径） |
| 真实数据量很小：本地全库 1941 行，单项目单周期为数十至数百行 | `psql -d BLF`：`analysis_return_rows` 最大单项目累计 390 行 |
| 亚马逊原始列 | `raw_row` 实测键集：`return-date / order-id / sku / asin / fnsku / product-name / quantity / fulfillment-center-id / detailed-disposition / reason / status / license-plate-number / customer-comments` |

### 0.2 已存在的口径漂移（本 spec 顺带收口）

同一个「当前生效退货行」查询在仓库里有 **3 份拷贝**：

1. `analysis.py:722-740`（fallback）——含 `AnalysisSourceFile.is_current == True`
2. `analysis.py:1246-1263`（snapshot）——含 `is_current`
3. `services/external/return_analysis_query.py:421` `query_return_analysis_raw()`——**只有 `project_id / country / return_date`，没有 `is_current`、不 JOIN source_file**

第 3 份已被 Agent R3 使用。若新增的原始数据 sheet 也走它，导出的行会与页面分析数字**对不上**（含历史版本行）。因此本次把这份查询抽成**唯一共享函数**，新端点与两条分析路径都用它，并以对账测试锁死。

### 0.3 补充拍板（2026-09-14 追加：DTO 管道）

设计评审后实测发现一个**与本功能无关的既有 bug**：`make openapi-export` / `openapi-check` 自 BLF-657 懒路由改造后必崩——FastAPI 0.139 的 `_IncludedRouter` 懒物化机制要求 `app.openapi()` **之前**物化全部懒分组（`app/api/v1/lazy_router.py::preload_all_lazy_groups()` 的 docstring 已写明这一点），而 `backend/scripts/openapi_export.py` 漏调，直接抛
`KeyError: (ModelField(field_info=Body(PydanticUndefined), name='payload', mode='validation'), 'validation')`。
后果：已提交的 `frontend/types/api-generated/openapi.json` 因此漂移了 32 条别的功能加的路由，且没人能再同步。

**追加拍板**（用户 2026-09-14 选择）：本分支内一并处理，但**拆成两个 commit**——
(a) `fix(后端): openapi 导出前物化懒分组`（脚本修复 + 回归测试，随功能提交）；
(b) `chore(契约): 同步 OpenAPI 与前端生成类型`（重生成 `openapi.json` + `api.d.ts`，会一并带上那 32 条漂移路由，可单独回滚）。

理由：不修则契约管道永久瘫痪；只修不重生成，`make openapi-check` 会从「崩溃」变成「持续 drift 报红」，同样是坏信号。CI 只跑 `pnpm gen:api-types:check`（两个生成文件互相比对），故重生成不影响构建门禁，只是让契约回到诚实状态。

---

## 1. 数据口径

### 1.1 共享查询函数（新增，唯一真相源）

位置：**新建** `backend/app/services/analysis/return_analysis/queries.py`（该包已有 `analysis / models / parsers / persistence` 四模块拆分，读侧查询单独成模块，避免本已 1600+ 行的 `analysis.py` 继续膨胀；`queries.py` 只依赖 `app.models`，无循环导入）

```python
def query_current_return_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> list[AnalysisReturnRow]:
    """当前生效版本的退货原始行（分析口径唯一真相源）。"""
```

语义（与现有分析逐字一致）：

```
AnalysisReturnRow
  JOIN AnalysisSourceFile ON source_file.id = row.source_file_id
WHERE source_file.project_id = :project_id
  AND source_file.country    = :country
  AND source_file.report_type = 'return_report'
  AND source_file.is_current  = True
  AND row.return_date BETWEEN :start_date AND :end_date
  [AND row.sku = :sku]
ORDER BY row.return_date ASC, row.id ASC     -- 新增确定性排序
```

- `sku` 为 `None` 时不加过滤，保持现有 `if sku:` 语义。
- 抽出后 `build_return_analysis()` 与 `build_return_analysis_from_snapshot()` 的查询块替换为一次调用，**过滤条件零变化**（纯机械抽取）。
- 排序对分析结果无影响（分析路径下游自行聚合/排序）；仅让新端点的输出确定可复现。
- `query_return_analysis_raw()`（Agent R3）**本次不改**——它有分页/排序参数与 PII 剥离契约，改动会外溢到 Agent 契约。它的口径漂移作为已知问题记录在 §7，另行评估。

### 1.2 列口径（17 列，与 Excel / 页面共用）

| # | Excel 表头 | 响应字段 | 来源 |
|---|---|---|---|
| 1 | 退货日期（站点时区） | `return_date` | `return_date`（报表时间归一后的站点日期，`YYYY-MM-DD`） |
| 2 | 原始退货时间 | `original_return_datetime` | 报表原值 `return-date`（UTC ISO8601） |
| 3 | 订单号 | `order_id` | `order-id` |
| 4 | SKU | `sku` | `sku` |
| 5 | ASIN | `asin` | `asin` |
| 6 | FNSKU | `fnsku` | `fnsku` |
| 7 | 产品名称 | `product_name` | `product-name` |
| 8 | 数量 | `quantity` | `quantity` |
| 9 | 运营中心 | `fulfillment_center_id` | `fulfillment-center-id` |
| 10 | 商品状态 | `detailed_disposition` | `detailed-disposition`（英文原值） |
| 11 | 商品状态（中文） | `disposition_display` | `translate_return_field("disposition", ...)` |
| 12 | 退货原因 | `reason` | `reason`（英文原值） |
| 13 | 退货原因（中文） | `reason_display` | `translate_return_field("reason", ...)` |
| 14 | 库存属性 | `status` | `status`（英文原值） |
| 15 | 库存属性（中文） | `status_display` | `translate_return_field("status", ...)` |
| 16 | LPN | `license_plate_number` | `license-plate-number` |
| 17 | 顾客评论 | `customer_comment` | `customer-comments` |

**口径裁决**：

- 中文列由**后端**用 `app/constants/return_translations.py::translate_return_field` 产出，与分析页现有 `*_display` 同源，杜绝前端各译一套。
- 第 17 列不是新增暴露面：内部 `/return-analysis` 的 `feedback_rows.customer_comment` 已在浏览器侧展示同一字段。Agent 通道的 PII 剥离契约（永不返回 `customer_comments` / `raw_row` / `fnsku` / `license_plate_number`）**不受影响**——本端点不是 Agent 路由。
- `raw_row`（原始 JSON 全列）**不返回**：列已在 §1.2 显式展开，回传 JSON 只会放大 payload 且与固定表头冲突。

---

## 2. 后端设计

### 2.1 新端点

```
GET /api/v1/return-analysis/raw-rows
```

挂在现有 `backend/app/api/v1/endpoints/return_analysis.py` 的 `router` 上（`router_groups/analysis_group.py` 已 include，无需改注册）。

| 维度 | 定义 |
|---|---|
| 入参 | `project_id: int`（必填）、`start_date: str`（YYYY-MM-DD，必填）、`end_date: str`（同）、`country: str = "US"`、`sku: Optional[str] = None` |
| 鉴权 | 与 `get_return_analysis` 完全一致：`Depends(protected)` + `project_service.ensure_project_access(db, project_id, operator=..., is_admin=bool(X-Is-Admin))` |
| 成功响应 | `200` + `ReturnRawRowsResponse` |
| 错误 | `403/404` 由 `ensure_project_access` 既有语义给出；参数不合法走 FastAPI 422；超上限走 `400`（见 §2.4） |
| Redis | **不缓存**（对齐 `/return-analysis` 主端点之外的分析读路径；原始行按上传批次变化，5min 缓存收益低而 payload 大） |
| Next 服务端 data cache | **不入 allowlist**，理由与 `ad-*-raw` 一致（`frontend/lib/server/backend-cache.ts` 注释：「原始行因单请求可达数 MB，不入 data cache，其重复访问由前端 2min 客户端缓存吸收」） |
| 前端客户端缓存 | 走 `fetchOpsJsonCached`（2min TTL、在途去重、按用户域隔离），**无需改** `frontend/lib/ops-client-cache.ts` |

### 2.2 响应 schema（新增于 `backend/app/schemas/return_analysis.py`）

```python
class ReturnRawRowItem(BaseModel):
    return_date: str
    original_return_datetime: str
    order_id: str
    sku: str
    asin: str | None
    fnsku: str | None
    product_name: str | None
    quantity: int
    fulfillment_center_id: str | None
    detailed_disposition: str
    disposition_display: str
    reason: str
    reason_display: str
    status: str
    status_display: str
    license_plate_number: str | None
    customer_comment: str | None


class ReturnRawRowsResponse(BaseModel):
    project_id: int
    country: str
    start_date: str
    end_date: str
    row_count: int          # 实际返回行数
    rows: list[ReturnRawRowItem]
```

字段名与既有 `CustomerFeedbackItem`（`customer_comment`、`reason_display`）保持命名一致，前端不必记两套。

### 2.3 序列化实现要点

- 用 `query_current_return_rows()` 取行；`return_date` 可能是 `date` 或 `str`（session 差异，见 `analysis.py:1264-1267` 既有处理）→ 统一 `isoformat()`。
- `customer_comment` 取 `customer_comments`，`None` 保持 `None`（Excel 写空串，见 §3.4）。
- 翻译三次调用（disposition / reason / status）复用同一 helper。
- `license_plate_number` 在模型上 `nullable=False, server_default=''` → 空串正常回传。

### 2.4 安全阀（不静默截断）

```python
MAX_RAW_ROWS = 50_000
```

- 命中 `len(rows) > MAX_RAW_ROWS` → `HTTPException(400, detail="所选周期原始退货行超过 50000 条，请缩小日期范围后重试")`。
- **不做静默截断**：静默截断会让「导出包含全部原始内容」这个核心承诺变成假承诺。真实数据量（§0.1）距上限三个数量级。
- 与 Agent R3 的 `limit le=50000` 取同一个量级，便于记忆。

### 2.5 Proxy 超时档位

`frontend/lib/server/backend-proxy-timeout-policy.ts` 的 `STATS_PATH_PATTERNS`（`:67`）新增：

```ts
/\/return-analysis\/raw-rows$/,
```

理由：该端点一次返回整周期无分页明细，属「聚合/统计」量级而非单资源 detail；默认 5s 档在极端周期下偏紧。模式锚定 `$`，**不匹配** `/return-analysis`（主端点保持默认档，零影响）——该不误伤由测试断言。

---

## 3. 前端设计

### 3.1 列配置单一来源（新文件）

`frontend/app/dashboard/operations/return-analysis/return-raw-columns.ts`（仿 `frontend/lib/ad-data.ts` 的纯函数 + 配置风格，可单测）：

```ts
export type ReturnRawRow = { /* 17 字段，与 ReturnRawRowItem 对齐 */ }

export type ReturnRawColumn = {
  key: keyof ReturnRawRow
  label: string     // Excel 表头与页面表头共用
  width: number     // Excel 列宽
  minWidth?: string // 页面列最小宽度
}

export const RETURN_RAW_COLUMNS: ReturnRawColumn[] = [ /* §1.2 的 17 列，顺序一致 */ ]
```

页面表格与 Excel sheet 都只读这份配置 → 两边列不会漂。

### 3.2 Tab 接入

| 项 | 改动 |
|---|---|
| `ViewTab` | 追加 `'raw'` |
| `VIEW_TAB_ORDER` | 追加在**末尾**（AI 总结之后）——原始数据是附录性质，且不打乱现有 tab 的肌肉记忆 |
| `TAB_LABELS` | `raw: '原始数据'` |
| `TAB_ICONS` | `raw: Table2`（lucide，新增 import） |
| `useUrlParam('tab', ...)` 的 `allowed` | 追加 `'raw'`（否则 URL 状态被拒回默认） |
| `TabsList` 栅格 | `grid-cols-3 lg:grid-cols-7` → `grid-cols-4 lg:grid-cols-8` |

### 3.3 懒加载状态机

新增状态：

```ts
type RawRowsResponse = { project_id; country; start_date; end_date; row_count; rows: ReturnRawRow[] }
const [rawRows, setRawRows] = useState<RawRowsResponse | null>(null)
const [rawLoading, setRawLoading] = useState(false)
const [rawError, setRawError] = useState<string | null>(null)
```

`loadRawRows(force = false)`：`fetchOpsJsonCached<RawRowsResponse>('/api/backend/api/v1/return-analysis/raw-rows?...')`，query 与主请求**同一组** `project_id / country / start_date / end_date`（不含 `sku`，页面无 sku 筛选）。失败 → `rawError` 置消息，不弹 toast（用户没点导出时不该被打扰）。

触发时机（三条，互斥且幂等）：

1. `useEffect`：`activeTab === 'raw' && data && !rawRows && !rawLoading` → `loadRawRows()`
2. 「重试」按钮 → `loadRawRows(true)`
3. `handleExportExcel` → 见 §3.4

**防串周期（关键）**：`loadData()` 开头即 `setRawRows(null)` / `setRawError(null)`。任何项目 / 站点 / 日期变化都会先清掉旧周期的原始行，**旧周期数据绝不会被导出或展示**。`rawRows` 里的 `start_date/end_date/country/project_id` 仅作调试与展示辅助，不作为新鲜度判断依据（新鲜度由"清空 + 重取"保证，比时间戳比对更简单、更难出错）。

### 3.4 导出改造

`handleExportExcel()`（`return-analysis-client.tsx:451`）在构造 sheet 前插入：

```ts
const raw = rawRows ?? (await loadRawRows())   // 抛错则中止
```

- `loadRawRows` 失败 → `notify({ type: 'error', title: '导出失败', message: '原始数据加载失败，已中止导出' })` 并 `return`（**D5**：宁可不出文件，也不出缺 sheet 的假完整包）。
- 成功 → 在现有 Sheet 5「顾客反馈」之后追加 **Sheet 6「亚马逊原始数据」**：
  - 表头 = `RETURN_RAW_COLUMNS.map(c => c.label)`，`styleHeaderRow(ws, 1)` 复用现有样式
  - 数据 = `raw.rows` 按 §1.2 顺序逐行写入；`null/undefined` 写 `''`；`quantity` 写数字
  - 列宽 = `RETURN_RAW_COLUMNS.map(c => ({ width: c.width }))`
  - `r.font = { name: 'Microsoft YaHei' }` + `applyBorder(cell)`（与其余 sheet 一致）
  - `ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]`
- 文件名不变（`{项目}_{站点}-退货分析-{周期}.xlsx`）——同一次导出承载全部内容，不额外产文件。

### 3.5 原始数据 Tab UI

- 标题区：`亚马逊原始数据` + 周期 `{start_date} 至 {end_date}` + `共 {row_count} 条`。
- 容器：`max-h-[560px] overflow-auto`，表头 sticky；17 列宽表横向滚动，长文本列（产品名称 / 顾客评论 / LPN）`truncate` + `title` 全量。
- 行数：渲染前 `RAW_DISPLAY_LIMIT = 200` 条；`row_count > 200` 时显示提示条「页内仅展示前 200 条，完整 {row_count} 条请导出 Excel」。常量集中定义，便于后续调高或接虚拟滚动。
- 空态：`EmptyTableState`「所选周期无原始退货数据」。
- 加载态：`TableSkeletonRows`（与其余 tab 一致）。
- 错误态：错误消息 + 「重试」按钮（`Button variant="outline" size="sm"`）。
- 刷新语义：页头全局刷新按钮只强刷主数据；原始行随 `rawRows` 被清空后在下次进入 tab / 导出时重取（同一 `force` 语义下自然刷新，无需额外入口）。

---

## 4. 测试计划

### 4.1 后端

| 用例 | 断言 |
|---|---|
| 基线 | 同周期同国家返回全部当前行，`row_count == len(rows)`，字段与翻译列齐全 |
| `is_current` 过滤 | 造一条 `is_current=False` 的旧版本 source file 含行 → **不出现**在结果中 |
| 越界排除 | 跨项目 / 跨国家 / 日期范围外的行不出现 |
| `sku` 过滤 | 传 `sku` 只回该 SKU；不传回全部 |
| 排序确定性 | 结果按 `(return_date ASC, id ASC)` |
| 对账（核心） | `sum(rows.quantity) == build_return_analysis(...).summary.total_quantity`（同周期同国家），锁死口径不再漂移 |
| 鉴权 | 无权限项目 → 与 `/return-analysis` 同样的拒绝语义 |
| 安全阀 | 行数超 `MAX_RAW_ROWS` → 400 且不返回部分数据（用 monkeypatch 常量验证，不造 5 万行） |
| 回归 | 现有 return 分析 / Agent R1-R5 测试全绿（共享函数抽取未改变语义） |

### 4.2 前端

| 用例 | 断言 |
|---|---|
| 懒加载 | 默认（rankings tab）**不发** `raw-rows` 请求 |
| 切 tab 触发 | 切到「原始数据」→ 恰好一次 `raw-rows` 请求，query 含 project/country/日期 |
| 渲染 | 表头 17 列齐全；含中文翻译列；行数超 200 时出现截断提示 |
| 空态 / 错误态 | 空返回 → 空态文案；失败 → 错误 + 重试按钮可再次请求 |
| 防串周期 | 切换日期后 `rawRows` 被清空（旧周期行不出现在表格） |
| 导出（未加载过原始行） | 点导出 → 先发 `raw-rows` 请求 → `vi.mock('exceljs')` 断言 `addWorksheet` 调用序列末尾为「亚马逊原始数据」，且现有 5 张 sheet 名不变 |
| 导出失败中止 | `raw-rows` 失败 → 不产出文件、不调用 `writeBuffer`、toast 为导出失败 |
| 列配置 | `RETURN_RAW_COLUMNS` 无重复 key / 无重复表头，17 项，key 覆盖 §1.2 |

### 4.3 超时档位

`backend-proxy-timeout-policy.test.ts` 追加：`/return-analysis/raw-rows` → `stats` 档（15_000ms）；`/return-analysis` 仍为默认 5_000ms（不误伤）。

### 4.4 验证命令（按仓库规则顺序）

```bash
cd backend && pytest tests/api/test_return_analysis_raw_rows.py -q
cd backend && pytest -q                      # 全量回归
cd frontend && pnpm lint && pnpm build && pnpm test
```

Excel 表头/列宽/冻结行的视觉效果属业务验收项，交用户在真实数据上人工确认。

> 注：本次执行环境（DSH 沙箱）里 `pnpm` 不可用（corepack 需写工作区外的 `COREPACK_HOME`），执行时用等价直连二进制（`node_modules/.bin/vitest` / `.bin/eslint` / `node scripts/gen-api-types.mjs --check`），仓库标准命令由用户在健康环境复核。详见实施计划的「环境准备」节。

---

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `backend/app/services/analysis/return_analysis/queries.py` | **新增**：`query_current_return_rows()`（§1.1 唯一真相源） |
| `backend/app/services/analysis/return_analysis/analysis.py` | 两条分析路径替换为调用共享函数；清理不再使用的 models import |
| `backend/app/services/analysis/return_analysis/__init__.py` | 导出新函数 |
| `backend/app/schemas/return_analysis.py` | 新增 `ReturnRawRowItem` / `ReturnRawRowsResponse` |
| `backend/app/constants/return_thresholds.py` | 新增 `MAX_RAW_ROWS = 50_000` |
| `backend/app/api/v1/endpoints/return_analysis.py` | 新增 `GET /return-analysis/raw-rows` |
| `backend/tests/api/test_return_analysis_raw_rows.py` | 新增（§4.1） |
| `backend/tests/services/analysis/return_analysis/test_shared_return_rows_query.py` | 新增（§4.1 共享函数 + 对账） |
| `backend/scripts/openapi_export.py` | 修复：`build_app()` 内 `preload_all_lazy_groups()`（§0.3） |
| `backend/tests/scripts/test_openapi_export.py` | 新增：schema 可生成 + 可复现 + 漂移守卫（§0.3） |
| `frontend/types/api-generated/openapi.json` / `api.d.ts` | 重生成（独立 commit，§0.3） |
| `frontend/app/dashboard/operations/return-analysis/return-raw-columns.ts` | 新增（§3.1） |
| `frontend/app/dashboard/operations/return-analysis/return-raw-columns.test.ts` | 新增 |
| `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx` | Tab / 状态机 / 表格 / 导出 sheet（§3.2-§3.5） |
| `frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx` | 扩展（§4.2） |
| `frontend/lib/server/backend-proxy-timeout-policy.ts` + `.test.ts` | stats 档新增锚定模式（§2.5、§4.3） |
| `docs/superpowers/plans/2026-09-14-return-analysis-raw-data-export.md` | 实施计划（已产出） |

**无数据库迁移**（不加表、不加列）。**无 API 破坏性变更**（纯新增端点）。

---

## 6. 风险与回滚

| 风险 | 等级 | 处置 |
|---|---|---|
| 抽取共享查询函数改动分析主路径 | 中 | 纯机械替换（过滤条件逐字不变）；对账测试 + 现有 return/Agent 测试双保险；若回归即 `git revert` 该文件（新端点独立，不受影响） |
| 大周期 payload 偏大 | 低 | 实测数据量小 3 个数量级；50000 行硬上限显式报错；不入任何服务端缓存 |
| 页内渲染 200 行 × 17 列 | 低 | 截断到 200 行 + 完整数据走导出；如后续需要再上虚拟滚动 |
| 顾客评论进导出文件 | 低（已知） | 与现有「顾客反馈」tab 同一暴露面，无新增权限面；如合规要求剥离，去掉第 17 列即可（列配置单点改动） |
| 导出前多一次等待 | 低（已拍板 D3） | 仅未加载过原始行时发生；失败即中止并提示，不产出半成品文件 |
| 契约重生成顺带带上 32 条历史漂移路由 | 低（已拍板 §0.3） | 独立 commit、纯新增路径（`removed 0`）、可单独回滚；重生成文件由脚本产出，不做人工编辑 |
| 改 `openapi_export.py` 影响面 | 低 | 只加一次 `preload_all_lazy_groups()` 调用；回归测试锁 schema 可生成 + 可复现 + 无漂移；不影响运行时（只在导出脚本里跑） |

**回滚**：四处独立 —— (a) 前端导出 sheet 与 Tab 可单独移除；(b) 新端点可单独下线路由；(c) 共享函数抽取可单独 revert；(d) 契约重生成是独立 commit，可单独 revert（脚本修复保留）。互不捆绑。

---

## 7. 明确不做（YAGNI / 范围外）

1. **销售订单原始行**（`analysis_sales_order_rows`）不进本次 sheet（D1 拍板排除）。若后续要"分母也对账"，作为独立增量：同一 Tab 加第二个子视图 + Sheet 7。
2. **快照聚合表** `analysis_return_aggregates` 不作为原始层导出。
3. **不做表头点击排序**（设计确认时明确）：默认后端顺序（退货日期升序），需要排序再加。
4. **不改** `query_return_analysis_raw()`（Agent R3）的 `is_current` 缺失问题——属既有 Agent 契约，另行评估，避免本次外溢。
5. **不做分页 / 虚拟滚动 / 服务端排序**：真实数据量不需要；安全阀已覆盖极端情况。
6. **不做原始数据的上传 / 编辑**：`analysis_return_rows` 是 Amazon 报表来源的不可变事实，唯一写路径是文件上传通道。
7. **不改** Agent 通道任何契约与 PII 白名单。
8. **不重建懒路由机制本身**：`openapi_export.py` 只补一次 `preload_all_lazy_groups()`，不动 `lazy_router.py` 的懒加载策略（那会影响每个请求的内存/性能画像，属 BLF-657 领域）。

---

## 8. 验收清单（人工业务验收）

1. 选项目 + 站点 + 周期 → 切到「原始数据」Tab：能看见该周期亚马逊原始行，中文翻译列正确。
2. 页内展示条数提示与 Excel 中实际行数**一致**（除非触发 200 行截断提示）。
3. 导出 Excel：第 6 张 sheet 名为「亚马逊原始数据」，表头 17 列、顺序与 §1.2 一致，冻结首行、边框与字体与其余 sheet 一致。
4. **对账**：Excel 原始 sheet 的「数量」合计 == 退货排行合计（`summary.total_quantity`），且 == 页面磁贴「退货总量」。
5. 切换周期后再导出：sheet 内容为**新周期**数据，无旧周期残留。
6. 现有 5 张 sheet 内容与改造前完全一致。
7. 无权限项目访问：与改造前表现一致（拒绝）。
