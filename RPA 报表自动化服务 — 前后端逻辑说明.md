# RPA 报表自动化服务 — 前后端逻辑说明

### 一、系统定位

RPA（Robotic Process Automation）服务是 **BelieveBoy Dashboard 的报表自动采集与状态监控系统**。它独立运行于 FastAPI 后端之外，负责监控指定目录、新文件识别与入库，同时提供人工上传和状态查看的 UI。

---

### 二、三大组成部分

```
autoReportUpload/          独立服务（Python 进程）
  ├── monitor.py            主循环：定时扫描项目目录
  ├── processor.py          文件处理：调用共享识别模块→解析→入库
  └── models.py             独立的数据模型（SQLAlchemy）

backend/                    FastAPI 后端
  ├── endpoints/uploads.py            上传 API（recognize + commit）
  ├── services/report_upload_service.py  上传服务（调用共享识别模块）
  ├── schemas/                          Pydantic 响应模型
  ├── models/                           数据表模型
  └── shared/recognition/               ★ 共享识别模块（统一识别逻辑）
       ├── models.py                    识别结果数据类
       ├── patterns.py                  文件读取/国家检测模式
       └── recognizers/                 各类型识别器实现
            └── __init__.py             识别入口函数

frontend/
  ├── lib/file-recognition.ts          轻量级前端识别（仅用于预判）
  └── dashboard/data-management/auto-upload/page.tsx  人工上传 + RPA 状态看板
```

---

### 三、识别逻辑架构（★ 核心重构点）

#### 3.1 共享识别模块 (shared/recognition/)

**目的**：将识别逻辑集中管理，避免多处重复维护。

**文件结构**：
```
backend/app/shared/recognition/
├── __init__.py           # 统一导出入口
├── models.py             # RecognitionResult 数据类
├── patterns.py           # 通用模式（文件读取、国家检测、日期处理）
└── recognizers/
    └── __init__.py       # 识别入口 + 各类型识别器
```

**识别流程**（识别器实现）：
```
recognize_file(path, country, original_filename)
    │
    ├─ 读取文件首行/表头
    ├─ 根据扩展名 + 内容匹配报表类型
    │   ├─ .txt + "snapshot-date"  → inventory_report
    │   ├─ .txt + "purchase-date"  → sales_report
    │   ├─ .txt + "return-date"    → return_report
    │   ├─ .csv + "Includes Amazon" → payment_report
    │   ├─ .csv + ASIN 字段         → business_report
    │   ├─ .xlsx + 广告SKU/ASIN     → ad_product_report
    │   └─ .xlsx + 客户搜索词       → ad_search_term_report
    └─ 返回 RecognitionResult（类型/日期/国家/列信息）
```

**支持的报表类型（共 7 种）**：

| 类型标识 | 说明 | 关键字段 | 日期模式 |
|---------|------|---------|---------|
| `inventory_report` | 库存快照 | snapshot-date / sku / asin | single_detected |
| `business_report` | 业务报告 | ASIN 字段 | single_detected (从文件名) |
| `ad_product_report` | 广告商品 | 开始日期 / 结束日期 / 广告SKU / 广告ASIN | single_detected |
| `sales_report` | 销售报表 | purchase-date / sku / asin | multi_auto |
| `payment_report` | 付款报告 | sku (变长表头) | range_manual |
| `return_report` | 退货报告 | return-date / sku | multi_auto |
| `ad_search_term_report` | 搜索词报告 | 开始日期 / 结束日期 | single_detected |

#### 3.2 各组件如何调用共享模块

| 组件 | 调用方式 | 说明 |
|------|---------|------|
| **后端 report_upload_service** | `from app.shared.recognition import recognize_file` | 调用共享模块处理文件，返回 `RecognitionResult`，然后转换为 `RecognitionPayload` 并做项目匹配 |
| **autoReportUpload** | `from app.shared.recognition import recognize_file` | 通过 `sys.path` 添加 `backend/` 目录，直接引用 `app.shared.recognition` |
| **前端 file-recognition.ts** | 独立实现 | 仅做轻量级预判（文件类型/首行关键字），不做复杂解析；后端上传时会重新完整识别 |

#### 3.3 项目匹配逻辑（仅后端需要）

**位置**：`report_upload_service._build_project_match()`

**逻辑**：
1. 根据识别出的 SKU/ASIN 列表
2. 在 `product_costs` 表中匹配活跃记录
3. 返回匹配结果：
   - `matched` — 唯一匹配到某项目
   - `conflict` — 匹配到多个项目，需人工确认
   - `unmatched` — 未匹配到任何项目

---

### 四、文件自动采集流程（autoReportUpload 独立服务）

```
monitor.py main_loop()
    │
    ├─ 首次运行：全局扫描所有项目目录
    │   └─ run_cycle()
    │       ├─ 遍历 PROJECTS 配置的每个项目目录
    │       ├─ _collect_files() 收集顶层新文件（排除 processed/ 子目录）
    │       └─ process_file() 处理每个文件
    │
    └─ 定时循环：每 CHECK_INTERVAL_MINUTES 分钟增量扫描
```

**processor.py 处理流程：**

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 调用共享识别模块 | `recognize_file(path, country)` 返回类型/日期/国家 |
| 2 | `_build_project_match()` | 通过 SKU/ASIN 在 `product_costs` 表匹配项目 |
| 3 | `_persist_one_file()` | 写入 `analysis_source_files` + 各类行数据表 |
| 4 | `_write_upload_log()` | 写入 `report_upload_logs` 表（**RPA 状态数据源**） |
| 5 | `_move_to_processed()` | 非 local 模式下将文件移入 `processed/` 子目录 |

---

### 五、后端状态查询 API

**端点：** `GET /api/v1/rpa-reports/status?report_date=YYYY-MM-DD&country=US`

**业务逻辑（rpa_report_service.py）：** 三级优先级

| 优先级 | 数据源 | 说明 |
|--------|--------|------|
| **优先 1** | `report_upload_logs` | 当日上传记录（upload_date == target_date），直接标记 `is_uploaded=True` |
| **优先 2** | `analysis_source_files` | 无上传记录时，通过业务日期覆盖判断是否有历史数据 |
| **兜底** | 所有 REPORT_TYPES 默认 false | 未匹配到任何数据则标记未上传 |

**关键字段：** `has_data`（有真实业务数据行）、`is_uploaded`（有上传记录）、`latest_date`（实际业务日期，优先取 source 文件的 period_end_date）、`original_filename`、`status_source`（upload_log / business_date_backfill）

---

### 六、前端页面结构

页面路径：`/dashboard/data-management/auto-upload`

**两个 Tab：**

**Tab 1 — 文件上传（AutoUploadContent）**

```
拖拽/选择文件 → POST /api/v1/report-upload/recognize 识别 → 展示识别结果（类型/项目/日期）
  → 用户确认 → POST /api/v1/report-upload/commit 提交入库
```

- 支持 `.txt` `.csv` `.xlsx`
- 识别状态：pending / recognized / error
- 上传状态：idle / saving / success / error

**Tab 2 — RPA 状态（RpaStatusGrid）**

```
GET /api/v1/rpa-reports/status 获取所有项目 × 12种报表类型 的状态矩阵
  → 绿色 CheckCircle2 = 已上传
  → 红色 CircleX = 未上传
  → 支持按项目筛选、按国家筛选、按日期左右切换
```

---

### 七、核心数据模型

**AnalysisSourceFile** — 上传文件与解析结果

- `project_id / report_type / country` — 联合唯一索引
- `period_start_date / period_end_date` — 周期报表的业务日期区间
- `snapshot_at` — 库存快照时间戳
- `is_current` — 是否为该项目/类型/国家的当前最新版本
- `row_count_total / row_count_included` — 总行数 / 纳入计算的行数
- `ingestion_status` — pending / running / success / failed

**ReportUploadLog** — RPA 状态查询的唯一数据源

- `project_id / report_type / country / upload_date` — 唯一索引
- `has_real_data` — 是否包含真实业务数据
- `source_file_id` — 关联到 AnalysisSourceFile

---

### 八、autoReportUpload 与后端/前端的关系

```
autoReportUpload（独立进程）
  ├─ 调用 shared/recognition 共享识别模块
  ├─ 直接写入 backend 的同一套 PostgreSQL 数据库
  ├─ 写入 AnalysisSourceFile（解析后的行数据）
  └─ 写入 ReportUploadLog（RPA 状态来源）

后端 API（report-upload/recognize + commit）
  ├─ 调用 shared/recognition 共享识别模块
  └─ 仅读取 ReportUploadLog + AnalysisSourceFile

frontend
  ├─ lib/file-recognition.ts（轻量级预判）
  └─ 两个 Tab 分别对应：人工上传流程 + RPA 自动采集状态看板
```

**简言之：** autoReportUpload 是"自动采集员"，backend 是"状态查询 API"，frontend 是"人工操作 + 状态监控界面"，三者共享同一套 PostgreSQL 数据库，且识别逻辑统一由 `shared/recognition` 模块提供。
