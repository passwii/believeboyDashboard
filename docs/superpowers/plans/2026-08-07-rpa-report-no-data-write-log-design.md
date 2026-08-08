# RPA 报表 write log 无数据补写 + Agent API 接入设计（BLF-477）

> **状态**：设计稿 v1（待评审）· **范围**：退货报告无数据/无文件时的 write log 写入时机设计，
> 并把 RPA 报表状态开放成 Agent API。**只接退货报告（return_report）**，不接其他报表。
> **配套代码**：`autoReportUpload/processor.py`、`backend/app/services/rpa_report_service.py`、
> `backend/app/api/v1/endpoints/agent/*`。

---

## 0. 结论速览（给用户的四个问题）

| # | 用户问题 | 结论 |
|---|----------|------|
| 1 | 无数据也要写 write log | ✅ 可行。文件存在但无数据**已支持**（`has_real_data=False`）；真正缺口是**完全没有文件**——新增"日终补写（sweep）"机制，为当天无 log 的 (项目 × 退货报告 × 站点) 写一条 `has_real_data=False` 的占位 log。 |
| 2 | 是否可同步处理（只限退货报告） | ✅ 可以。sweep 是只读 + 幂等 INSERT 的小事务，**严格过滤 `return_report`**，不碰其他报表的数据与 log，不存在"错误读写连累其他报表"的风险。与文件处理循环解耦（独立任务/独立调度），互不阻塞。 |
| 3 | 写入时机设计（需要看数据库字段） | 三条时机线：**T1 文件驱动（现状）→ T2 每轮扫描后补写（Mac 端，可选）→ T3 后端日终对账（推荐主机制）**。关键字段见 §3。 |
| 4 | 备选思路：空表上传 | 技术上可行（管线已能处理空 CSV），**但不推荐**：会污染数据层（假 `AnalysisSourceFile`、版本号空转、污染退货分析 R5 上传列表）。占位 write log 用零污染达成同样目标。详见 §4。 |

配套 Agent API：`GET /api/v1/agent/projects/{project_id}/rpa-status`（及可选全局视图），
返回每个报表的三态：`written_with_data` / `written_no_data` / `missing`（§5）。

---

## 1. 现状梳理（代码事实）

### 1.1 报表自动化链路

```
Mac 本地 RPA（autoReportUpload/，watchdog 监控 /Users/damon/Documents/RPA/{项目}/）
  └─ process_file() → 识别 → 按报表类型持久化
       ├─ AnalysisSourceFile + 行表（analysis_return_rows 等）  ← 真实数据
       ├─ ReportUploadLog（report_upload_logs）                 ← "write log"，驱动 RPA 状态格子
       └─ AutoReportUploadLog（auto_report_upload_logs）        ← 每次运行的控制台结果日志
```

- 前端页面：`frontend/app/dashboard/reports/auto-upload/page.tsx`（「文件上传」+「RPA 状态」两个 tab）。
- RPA 状态格子：`GET /api/v1/rpa-reports/status?report_date=YYYY-MM-DD&country=US` →
  `backend/app/services/rpa_report_service.py::get_report_status_for_date()`。

### 1.2 write log 表（ReportUploadLog）字段 —— 用户问的"数据库字段"

`backend/app/models/report_upload_log.py:21`（docstring 原文：*Records every file upload attempt for RPA status dashboard. One row per processed file, regardless of whether it contained real data.*）

| 字段 | 类型 | 语义 |
|------|------|------|
| `project_id` | int FK | 项目 |
| `report_type` | str(32) | 报表类型（`return_report` 等） |
| `country` | str(2) | 站点（US/DE/UK，`normalize_country` 归一） |
| `upload_date` | date | **写入日**（RPA 本地日期 `_resolve_upload_date(now)`）；状态格按它匹配"今天" |
| `has_real_data` | bool | 区分"有数据 / 无数据" |
| `row_count` | int | 入库行数（无数据 = 0） |
| `source_file_id` | int FK nullable | 指向 `analysis_source_files`；无文件 = NULL |
| `original_filename` | str nullable | 原始文件名；无文件 = NULL |
| `created_at` | datetime | 状态服务按 (project, report_type) 取最新行 |

### 1.3 状态读取优先级（rpa_report_service）

`get_report_status_for_date()` 三/四级回退：

1. `report_upload_logs`（`upload_date == 目标日`，同 (project,type) 保留最新 `created_at`）；
2. `analysis_source_files` 业务日期覆盖（periodic 报表 `period_start <= 目标日 <= period_end`）；
3. `ad_upload_files`（C 表 10 个广告维度）；
4. 库存分类账两张表。

格子 = `is_uploaded`（绿）/ 非绿（红）。

### 1.4 现有"无数据"处理（文件存在时已覆盖）

- **退货报告**（`processor.py::_persist_return_report`）：空 CSV → 仍建 source_file + log，`has_real_data = len(rows) > 0` → False；解析失败 → log `has_real_data=False, source_file_id=None, original_filename=<文件名>`。
- **销售报表**（`_persist_sales_report_marker`）：无有效行 → 标记 source_file + log `has_real_data=False`。
- **去重/冲突**（`_write_dedup_upload_log`）：仍写今天 log；幂等（已有 log 则跳过）。

### 1.5 真正的缺口

> **完全没有文件**（店铺当天无退货 → 未下载；或下载失败 / 机器人没跑）时，**没有任何 `report_upload_logs` 行**。
> 状态格显示红（未上传），Agent 无法区分：
> ① 已处理但无数据（正常）② 已处理但失败 ③ **完全没处理/遗漏（需要关注）**。

另注意：`auto_report_upload_logs`（AutoReportUploadLog）是每次运行的控制台结果日志（`monitor.py::RunLogger.result` 写入），
**不是**驱动状态格的 write log。本设计不把两者混用。

---

## 2. 需求 1：无数据也要写 write log（含"完全没文件"）

### 2.1 方案：占位 write log（no-op sweep 补写）

为每个"预期应有退货报表但当天没有 log 行"的 (项目 × `return_report` × 站点) 补一条：

```python
ReportUploadLog(
    project_id=project.id,
    report_type="return_report",
    country=country,
    upload_date=target_date,     # 对账的"业务日"
    has_real_data=False,
    row_count=0,
    source_file_id=None,          # 无文件 → NULL（没有 AnalysisSourceFile）
    original_filename=None,       # 无文件 → NULL
)
```

**三态判定规则**（无需新字段，全从现有列推导）：

| 状态 | `has_real_data` | `source_file_id` | `original_filename` |
|------|:---:|:---:|---|
| 已写入且有数据 | true | 非空 | 有 |
| 已写入但无数据（文件为空） | false | 非空 | 有 |
| 已写入但无数据（解析失败） | false | NULL | 有 |
| **已写入但无数据（无文件，sweep 补写）** | false | NULL | NULL |
| 未写入 / 遗漏 | — | — | —（无 log 行） |

> 结论：**不需要加表**。状态服务里已有 `has_data=log.has_real_data`，Agent 侧再暴露
> `status_source` 即可区分四种子状态。

### 2.2 幂等性

- sweep 前先查 `(project_id, report_type, country, upload_date)` 是否已有 log，有则跳过
  （复用 `_write_dedup_upload_log` 的既有幂等写法，`processor.py:206`）。
- 与文件处理路径的先后顺序天然安全：状态服务按 `created_at` 保留最新行。
  - sweep 先写 `has_real_data=False`，之后文件到达写了 `has_real_data=True` → 新行胜出，格子转绿✓；
  - 文件先写，sweep 后跑 → 幂等跳过 ✓。不会把"有数据"降级成"无数据"。

---

## 3. 需求 2 + 3：是否可同步处理 & 写入时机设计

### 3.1 为什么可以"同步处理"（只接退货报告）

- sweep 是**纯 DB 小事务**：一条 SELECT + 至多一条 INSERT，无文件 I/O、无解析、无版本号操作。
- **严格过滤 `report_type == "return_report"`**：其他报表的 log 与数据一律不读不写，
  从根上规避用户担心的"错误读写连累其他报表"。
- 与文件处理循环**解耦**：作为独立任务/调度运行，互不阻塞；即使并发写同一条
  (project,type,country,date)，幂等检查保证安全。
- 失败成本极低：sweep 抛错最多漏补几条占位 log，不影响任何数据入库。

### 3.2 三条时机线

#### T1 —— 文件驱动（现状，保留）

文件事件 → `process_file()` → 写 log。覆盖"有文件"的所有情况。不够，但不动。

#### T2 —— 每轮扫描后补写（Mac 端，可选增强）

`monitor.py::run_cycle()` 扫完项目文件夹后，调用一次
`sweep_missing_return_logs(db, upload_date=today)`。

- 优点：机器人一跑完就有实时"绿格"，不依赖固定时钟。
- 缺点：Mac 关机 / 下载步骤在机器人启动前就失败时，sweep 不执行。

#### T3 —— 后端日终对账（推荐主机制）

在**始终在线**的后端加一个 APScheduler 每日任务（`backend/app/core/scheduler.py` 的
minutely scan 同款模式），配置北京时间某小时（建议常量 `RPA_NO_DATA_SWEEP_HOUR`，
默认 23:30，即当天下载窗口结束后）：

```
for project in projects:                     # projects 表全量
    for country in {US, DE, UK}:             # normalize_country 合法站点
        # 只对"项目历史上出现过该站点"的 country 补写，避免给没做过该站点的项目造占位
        if country not in project_history_countries(project): continue
        if not exists log(project, "return_report", country, upload_date=today):
            insert no-op log
```

- 优点：不依赖 Mac；一处实现同时服务状态格与 Agent API；可加"昨日回补"自愈
  （上线头几天对 `upload_date = yesterday` 也跑一次）。
- 站点范围：用项目历史 `report_upload_logs` 里 `DISTINCT country` 作为"该项目实际经营站点"，
  避免给 US-only 项目凭空造 DE/UK 占位。

**推荐组合**：T3 为主（兜底 + 自愈）+ T2 可选（实时）。若想最小改动，先只上 T3。

### 3.3 时区一致性（易错点）

`_resolve_upload_date(now)` 用的是 RPA **本地日期**（`datetime.now().date()`）。
sweep 的 `target_date` 必须与它同语义（北京/本地日），否则"今天"对不齐——状态格按
`upload_date == 目标日` 匹配，差一天就会红/绿错位。

---

## 4. 需求 4：备选思路评估（每天做空表上传）

**技术上可行，但不推荐。**

- 可行性：管线已能处理空 CSV（`_persist_return_report` 对空文件写
  `has_real_data=False` 的 source + log），生成空表上传 ≈ 零解析改动。
- 问题：
  1. **污染数据层**：每个空表都会造一条假 `AnalysisSourceFile` → `next_version` 版本空转、
     `replace_current_pointer` 的 `is_current` 指针来回切、`row_count_total=0` 的历史行堆积；
  2. **污染退货分析 R5 上传列表**：`backend/app/api/v1/endpoints/agent/return_analysis.py`
     的 `_query_report_uploads` 会列出这些假上传（`row_count=0`），Agent 会被误导；
  3. **write log 失真**：`original_filename` 变成生成的空文件名，格子/Agent 看到的是
     "上传了文件" 而非 "当天没数据"。
- **结论**：占位 write log 用零污染达成同样目标（格子变绿 + Agent 能区分三态）。
  仅当某个下游**物理上需要文件**（例如直接读文件夹的消费方）时，才把空表上传当兜底。

---

## 5. Agent API 设计（总目标：Agent 每天查"哪些已写、哪些遗漏"）

### 5.1 路由

```
GET /api/v1/agent/projects/{project_id}/rpa-status?report_date=YYYY-MM-DD&country=US
```

（可选全局视图 `GET /api/v1/agent/rpa-reports/status`，按凭据 `project_scope` 过滤可见项目，
供"跨店铺每日巡检"一次拉全量；默认先做 project-scoped，与现有 agent 域保持一致。）

- 鉴权：`require_agent_credential` + `require_project_scope(project_id)` +
  `require_business_scope("rpa_reports")`（新域 code，接线见 `agent/__init__.py`，
  插在兜底路由之前——注释里已有"后续 include_router 一律插在兜底之前"的警告）。
- 实现：复用 `get_report_status_for_date()` 的服务逻辑（或薄封装），过滤到单项目，
  输出三态 + 中文 label。

### 5.2 响应（agent_ok 壳）

```json
{
  "ok": true,
  "data": {
    "report_date": "2026-08-06",
    "country": "US",
    "project_id": 12,
    "project_name": "博朗姆",
    "reports": [
      {
        "report_type": "return_report",
        "report_label": "退货报告",
        "status": "written_with_data",
        "is_uploaded": true,
        "has_data": true,
        "row_count": 34,
        "latest_date": "2026-08-05",
        "original_filename": "Return-2026-08-05.txt",
        "status_source": "upload_log"
      },
      {
        "report_type": "sales_report",
        "status": "missing",
        "is_uploaded": false,
        "has_data": false,
        "status_source": null
      }
    ],
    "summary": { "total": 17, "written_with_data": 15, "written_no_data": 1, "missing": 1 }
  }
}
```

`status` 三态映射（服务层已具备 `has_data`/`is_uploaded`，Agent 侧聚合即可，无需新查询）：

- `is_uploaded && has_data` → `written_with_data`
- `is_uploaded && !has_data` → `written_no_data`
- `!is_uploaded` → `missing`

### 5.3 域/凭据

- 新增 `business_scope` 域 code `rpa_reports`，在 Agent 凭据管理 UI 的域选项里登记。
- 存量 key `business_scope = "*"` 不受影响（server_default）。

---

## 6. 实施清单（后续实现的粗粒度拆分，本 issue 不实施）

1. **服务层**：`backend/app/services/rpa_report_service.py` 新增
   `sweep_missing_return_logs(db, upload_date, project_ids=None, countries=("US","DE","UK"))`
   —— 幂等、严格 `return_report`、站点按项目历史推断。
2. **调度**：`backend/app/core/scheduler.py` 加每日任务（`RPA_NO_DATA_SWEEP_HOUR`），
   T3 主机制；（可选）`monitor.py::run_cycle` 尾部调 sweep 作 T2。
3. **Agent API**：`backend/app/api/v1/endpoints/agent/rpa_reports.py` 新路由 + `rpa_reports`
   域 code 接线 + 单测（sweep 幂等 / 三态映射 / project_scope 403）。
4. **无需 Alembic**：所有字段已存在；三态全部可推导。
5. **回补**：上线后对近 7 天各跑一次 `upload_date = 当日` 的 sweep，让历史格子/历史查询先补齐。

---

## 7. 风险与边界

- **时区**：sweep 与 RPA 本地日期必须同语义（§3.3），否则日对齐错位。
- **站点范围**：只对项目历史出现过的 country 补写，避免噪声占位（§3.2 T3）。
- **只接退货报告**：本期不把其他报表接入 sweep 与 Agent 巡检（用户明确要求），
  但服务层按 `report_type` 参数化，未来接其他报表只加配置不改逻辑。
- **AutoReportUploadLog 不是 write log**：机器人运行日志与状态格 write log 分离，Agent 侧
  如需"机器人最后心跳/运行情况"，属另一条读路径（AutoReportUploadLog / DigitalEmployee），
  不在本 issue 范围。
