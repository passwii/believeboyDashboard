# 新增一个业务模块（client 模块 + view）指南

> 本文档是 BLF-759（P5-0 公共基建）交付的迁移手册：后续 45 个板块视图（BLF-713
> Phase 5 各棒）按此步骤接入，公共组件一律复用 `gui-app/src/widgets/` 下的
> 基建，不另造轮子。

## 0. 架构总览（依赖方向不可逆）

```
gui-domain（纯 serde 模型 + TableFilter）
   ↑
gui-api-client（reqwest 封装 + QueryBuilder / list_with_filter / get_one）
   ↑
gui-app（GPUI 视图；widgets/ 公共组件）
```

新增业务模块的三件事，顺序固定：

1. **domain 模型**（如 `gui-domain/src/operations/xxx.rs`）—— 后端响应的 serde 定型；
2. **client 模块**（如 `gui-api-client/src/xxx.rs`）—— 端点封装；
3. **view**（如 `gui-app/src/views/xxx.rs`）—— 页面渲染 + 状态机。

## 1. domain 模型（纯类型，无 IO）

对齐后端 Pydantic 模型（snake_case），时间用 `chrono::NaiveDate`：

```rust
// gui-domain/src/operations/stock.rs
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StockLedgerItem {
    pub id: i64,
    pub sku: String,
    #[serde(default)]
    pub available_qty: i64,          // 后端有默认值 → serde(default)
    pub snapshot_date: NaiveDate,
}
```

通用筛选值直接用现成的 [`TableFilter`](../../crates/gui-domain/src/filter.rs)
（项目 / 国家 / 日期区间），不要自建结构。

## 2. client 模块（端点封装）

`gui-api-client` 已提供三个模板方法，**无需再手写 query 拼接与请求样板**：

```rust
// gui-api-client/src/stock.rs
use gui_api_client::query::QueryBuilder;
use gui_domain::filter::TableFilter;

impl Client {
    /// GET /api/v1/operations/stock-ledger → 库存分类账列表
    pub async fn stock_ledger(
        &self,
        filter: &TableFilter,
        limit: i64,
    ) -> Result<Vec<StockLedgerItem>, ApiError> {
        let query = QueryBuilder::new()
            .with("limit", limit)
            .with_filter(filter);            // 空条件自动不携带
        self.list_with_filter("/api/v1/operations/stock-ledger", &query).await
    }

    /// GET /api/v1/operations/stock-ledger/{id} → 单条详情
    pub async fn stock_ledger_item(&self, id: i64) -> Result<StockLedgerItem, ApiError> {
        self.get_one(&format!("/api/v1/operations/stock-ledger/{id}")).await
    }
}
```

要点：
- 路径常量与后端 `backend/app/api/v1/` 1:1；query 键与后端参数一致（`project_id` /
  `country` / `date_from` / `date_to` 由 `TableFilter::to_query_params` 统一产出）；
- 分页契约各端点不统一（`limit/offset` vs `page/page_size` vs `{data, summary}` 包裹），
  模板方法不假设形状——按端点契约自己拼 `page` / `limit`，或定义包裹结构体走 `get_one`；
- 每个端点配 mockito 契约测试（锁路径 + query + 解析），见
  `gui-api-client/src/advertising.rs` 测试范式。

## 3. view（页面 + 状态机）

对齐既有视图范式（参考 `views/ad_analysis.rs` / `views/ad_data.rs`）：

```rust
// gui-app/src/views/stock.rs
#[derive(Debug, Clone, PartialEq)]
pub enum StockState { Loading, Loaded(StockData), Empty, Error(String) }

pub struct StockView {
    state: Entity<StockState>,
    client: Client,
    projects: Vec<ManagedProject>,       // 筛选菜单数据源
    selected_project_id: Option<i64>,
    filter: TableFilter,                 // 结构化筛选值
    table: Option<Entity<DataTable<StockLedgerItem>>>,   // 懒建
    date_picker: Option<Entity<DateRangePickerState>>,   // 懒建 + 订阅
    latest_request_id: u64,              // 竞态保护
}
```

四态渲染直接用公共组件（对齐 `views/ad_data.rs`）：

| 状态 | 公共组件 |
|---|---|
| Loading | `widgets::state_views::loading_state` |
| Error | `widgets::state_views::error_state(&view, ...)`（Alert + 重试） |
| Empty | `widgets::state_views::empty_state_with_action(&view, ...)` |
| Loaded | `widgets::data_table::DataTable` + `widgets::pagination::pagination_bar` |

### 3.1 表格（DataTable）

列定义 + 行数据，排序 / 斑马纹 / 空态 / 滚动全部内置：

```rust
fn columns() -> Vec<ColumnDef<StockLedgerItem>> {
    vec![
        ColumnDef::text("sku", "SKU", |r, _| SharedString::from(r.sku.clone())),
        ColumnDef::number("qty", "可用库存", |r| r.available_qty as f64, |r, _| {
            SharedString::from(r.available_qty.to_string())
        })
        .width(120.0),                     // 默认右对齐 + 可排序
    ]
}

// 视图持有实体，Loaded 时幂等注入（render 期调用安全）
self.table.get_or_insert_with(|| {
    cx.new(|_| DataTable::new("stock-table", columns()).striped(true).empty_text("暂无库存数据"))
});
table.update(cx, |t, cx| t.set_rows_if_changed(&data.items, cx));
```

### 3.2 筛选栏（FilterBar）

`filter_bar_layout` + `filter_select` 组装项目 / 国家下拉；日期区间用
`DateRangePickerState`（变更经 `cx.subscribe` 回连视图的 `apply_date_range`，
参考 `views/ad_analysis.rs`）：

```rust
filter_bar::filter_bar_layout(&theme)
    .child(filter_bar::filter_select(&theme, "项目", label, "stock-project-filter",
        move |menu, _w, _cx| { /* PopupMenuItem… */ menu }))
    .child(date_picker.clone().expect("已创建"))
    .child(div().flex_1())
    .child(Button::new("stock-refresh").outline().small().label("刷新")
        .on_click(/* reload */))
```

筛选值更新后 `reload()` 里直接 `QueryBuilder::new().with_filter(&self.filter)` 拉数据。

### 3.3 分页（Pagination）

```rust
let state = pagination::PageState::new(page, page_size, total);
pagination::pagination_bar(
    &view, &theme, "stock-pagination", &state, &[50, 100, 200, 500],
    |this, page, cx| this.set_page(page, cx),
    |this, size, cx| this.set_page_size(size, cx),
)
```

### 3.4 图表（Chart primitives）

`widgets::chart_primitives`：`trend_line_chart` / `trend_area_chart` /
`bar_series_chart` / `donut_share_chart` / `share_legend` / `chart_card` /
`chart_area` / `chart_empty` / `stat_item` / `big_number`。色板统一走
`AppTheme.chart_*` / `chart_palette()`（亮暗两态由 theme.rs 保证）。

gpui-component 0.5.1 图表能力边界（不可封装项在视图内自实现）：
无 radar / sankey / 双 Y 轴 / Y 轴刻度文字；双序列只能共用轴（`dual_area_chart`）。

## 4. root.rs 路由接入

- `gui-domain/src/sidebar.rs` 的 URL 已在侧栏中；`views/root.rs` 侧栏 Select 分支里
  把对应 URL 从占位改为懒建真实视图（对齐 `ad_analysis.rs` 的注册方式）；
- 视图构造需要 `Client`：`AdAnalysisView::new(cx, client.clone())`。

## 5. 验证（提交 PR 前全绿）

```bash
cd gui
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings   # 0 告警
cargo test --workspace                                  # 全绿
```

- 每个公共组件至少 1 个渲染冒烟测试（亮 / 暗主题 + 空 / 加载 / 错误态）；
- api-client 模板方法 mockito 单测；
- diff 无 TODO / FIXME / dbg! / todo!。
