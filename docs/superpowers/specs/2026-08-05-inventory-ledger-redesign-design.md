# 库存分类账前端重构设计文档（总览 + Summary/Detail 双 Tab）

> v1 · 2026-08-05 · BLF-428（用户已在 issue 评论中拍板）
> 状态：设计已确认，实施中
> 前置：`2026-07-31-inventory-ledger-design.md`（v1 页面）、BEL-428 双视图三表架构（commit b8b13495）

## 1. 背景与决策

BEL-428 落地后，后端已有 `inventory_ledger_summary`（22 列日水位快照，真相源）+
`inventory_ledger_detail`（16 列事件行）+ 批次元数据三表，但前端仍是 v1 的 6 个平铺 tab
（月度总览/事件流水/入库记录/仓库明细/事件明细/上传批次），问题：

1. 无信息层级，没有"先看结论、再下钻"路径；
2. Summary 视图原始行（每日期初→事件流→期末）从未展示；
3. 后端 `/trend`（近 N 月趋势）从未被前端调用；
4. 双表对账/跨月连续性徽章与内容脱节。

### 已拍板决策（2026-08-05，Yawei）

| # | 决策 | 内容 |
|---|------|------|
| D1 | 结构 | **方案 A**：全局筛选条 + 总览置顶 + Summary/Detail 双 Tab（总览常驻，非平级 tab） |
| D2 | Summary 形态 | 展示**每日水位原始行**；新增后端 `GET /summary` 原始行端点（唯一必动后端处） |
| D3 | 旧 tab 处置 | 月度总览/事件流水/入库记录/仓库明细被新结构吸收合并；上传批次保留为运维 tab |
| D4 | 命名 | 页面标题与侧边栏由"库存盘点"改为"库存分类账"（对齐报表本名） |
| D5 | 筛选架构 | **一份全局筛选状态**（项目/月份/SKU/仓库/Disposition/事件类型）驱动总览 + 两 tab；总览不响应 tab 内局部筛选，避免多份 truth |
| D6 | 数据源 | summary + detail 两个原始数据集是页面唯一真相源；总览 KPI/图表全部客户端派生自它们（筛选后） |

## 2. 信息架构与布局

```
┌─────────────────────────────────────────────────────────────┐
│ 库存分类账   [项目 ▾] [月份 ▾] [SKU ▾] [仓库 ▾] [状态 ▾] [类型 ▾] [🔄] │ 全局筛选条
├─────────────────────────────────────────────────────────────┤
│ 健康徽章: 双表对账 ✅/❌   跨月连续性 ✅/⏳                       │
│ KPI 卡: 期末总库存 | 环比变动 | 损坏占比 | 事件净变动             │
│ 图表: 近 N 月趋势折线(/trend) | 事件构成柱状图                   │
│       Disposition 构成 | Top 仓库分布                         │  ← 总览区（常驻）
├─────────────────────────────────────────────────────────────┤
│ Tabs: [汇总视图 Summary] [明细视图 Detail] [上传批次]            │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 全局筛选条（唯一筛选真相源）

- 必选：项目（`project_id`）、月份（`month`）
- 联动可空：SKU、仓库（FC）、Disposition、事件类型
- 全部 URL 同步（复用 `useUrlParam`），可分享可还原
- 总览区与两个 tab 的数据请求/客户端派生全部消费这一份状态

### 2.2 总览区（常驻，响应全局筛选）

| 元素 | 数据源 | 说明 |
|---|---|---|
| KPI：期末总库存 | summary 行客户端派生 | 按 (msku×location×disposition) 取末日 `ending_balance` 求和（受筛选） |
| KPI：环比变动 | `/snapshot` 的 `prev_qty_eom/change` | 月份级 + SKU 筛选口径（location/disposition 筛选不参与环比，文档注明） |
| KPI：损坏占比 | summary 行派生 | 末日非 SELLABLE 库存 / 总库存 |
| KPI：事件净变动 | detail 行派生 | 筛选后 `sum(quantity)` |
| 趋势折线 | `/trend`（现成端点，首次接入） | 近 6 月 EOM 总量 + 损坏率，项目级不参与筛选 |
| 事件构成柱状图 | detail 行派生 | 按 event_type 分组 |
| Disposition 构成 | summary 行派生 | 末日各 disposition 占比 |
| Top 仓库分布 | summary 行派生 | 末日按 location 求和 top N |
| 健康徽章 | `/consistency` + `/snapshot.integrity` | 移入总览区顶部 |

### 2.3 Summary tab（每日水位账）

- 表格列（22 列精简）：日期 / MSKU / 品名 / 仓库 / Disposition / 期初 / 入库 / 出库 / 客户退货 / 供应商退货 / 调拨 / 盘盈 / 盘亏 / 损坏 / 报废 / 其他 / 期末（次级列默认折叠可展开）
- 每 SKU 期末水位线（recharts LineChart，x=日期 y=ending_balance）
- 客户端分页（页长 50）+ CSV 导出

### 2.4 Detail tab（每笔事件账）

- 现有"事件明细"升级：消费全局筛选 + 仓库/事件类型联动 + 客户端分页 + CSV 导出
- 数量正负着色、事件类型中文标签沿用现有约定

### 2.5 上传批次 tab

保留现实现（运维/追溯视图），不与业务视图平级强调。

## 3. 后端改动（唯一必动处）

### 3.1 新增 `GET /inventory-ledger/summary`（内部 + 外部镜像）

- 契约镜像 `/detail`：`project_id` + `period`（必选，BEL-370 语法）+ 可选 `msku` / `location` / `disposition`
- 返回 `LedgerSummaryResponse { report_month, rows: LedgerSummaryRow[] }`，按 `date desc, id desc` 排序，`limit=5000` 兜底
- Service：`get_ledger_summary_rows(db, project_id, start, end, msku, location, disposition, limit)` —— 与 `get_ledger_detail_rows` 同构
- 无迁移（只读现有 `inventory_ledger_summary` 表）

### 3.2 不动的部分

`/snapshot`、`/events`、`/trend`、`/detail`、`/batches`、`/consistency`、`/months` 全部保留原契约。

## 4. 前端文件结构

现有 1075 行单文件拆为聚焦模块（设计上的"小而边界清晰"）：

```
app/dashboard/supply-chain/inventory-ledger/
├── page.tsx                    不变
├── ledger-load.ts              不变（fetch 包装）
├── ledger-types.ts             共享类型
├── ledger-derive.ts            纯函数派生（KPI/分组/水位线），可单测
├── ledger-badges.tsx           IntegrityBadge + ConsistencyBadge
├── ledger-overview.tsx         总览区（KPI + 图表）
├── ledger-summary-tab.tsx      Summary tab（水位表 + 水位线图）
├── ledger-detail-tab.tsx       Detail tab（事件表）
├── ledger-batches-tab.tsx      上传批次 tab（原样迁移）
└── inventory-ledger-client.tsx 编排：筛选状态 + 数据加载 + 布局
```

图表走 recharts（仓库已有 2.15.4），`next/dynamic` + `ssr:false` 代码分割（对齐 dashboard v1/v2 模式）。

## 5. 测试计划

- 后端：`test_ledger_summary_rows.py`（service 级：过滤/排序/limit，用 ingest 造数）+ 外部端点 contract 测试（TestClient，无 auth）
- 前端：`ledger-derive` 纯函数单测（KPI/事件分组/水位线/损坏占比）+ 页面级渲染测试（mock fetch，总览+tab 结构、筛选联动）
- 回归：后端 ledger 相关 pytest 全绿；前端 `pnpm lint && pnpm build && pnpm test` 全绿

## 6. 范围边界

### 做

全局筛选条、总览区、Summary/Detail 双 tab、`/summary` 端点、CSV 导出、侧边栏改名

### 不做

- `/detail` 服务端分页（客户端分页足够，月量级 ≤ 2k 行）
- 仓库 region 映射、DoH/周转等分析指标（归 inventory-analysis）
- 总览 AI 摘要、预警

## 7. 部署

后端有新端点 → push 后需 VPS 部署（`deploy_vps.py --auto`）。前端 Vercel 自动部署。
