# 报表中心「上传与分析簇」快照（BLF-1068，macOS Stage 5.5）

7 条端点的**真实后端响应**，用于把「同源同值」与「识别 / 入库 / 任务状态的响应形状」变成
可执行断言（`ReportDecodingTests` / `ReportClientTests` / `ProductAnalysisStoreTests` /
`ReportAutomationStoreTests` / `ReportRenderingTests`）。

| 文件 | 端点 | 库 |
| --- | --- | --- |
| `rpa-status.json` | `GET /rpa-reports/status?report_date=2026-09-14&country=US` | 生产快照库 `BLF` |
| `ad-upload-status.json` | `GET /ad-upload/status?country=US&limit=50` | 生产快照库 `BLF` |
| `ad-upload-status-filtered.json` | 同上 + `project_name=犀牛&report_type=ad_promoted_product_report` | 生产快照库 `BLF` |
| `ad-upload-recognize.json` | `POST /ad-upload/recognize`（multipart） | 生产快照库 `BLF`（只读） |
| `ad-upload-commit-dry-run.json` | `POST /ad-upload/commit`（`dry_run=true`） | 生产快照库 `BLF`（不写业务表） |
| `ad-upload-recognize-unsupported-extension.json` | 同上（`.pdf`）→ 真实 400 | 生产快照库 `BLF` |
| `ad-upload-recognize-unknown-headers.json` | 同上（表头不命中规则）→ 真实 400 | 生产快照库 `BLF` |
| `ad-upload-commit-type-mismatch.json` | `commit` 的 `report_type` 与识别不一致 → 真实 422 | 生产快照库 `BLF` |
| `product-analysis-report-create.json` | `POST /product-analysis-reports` | 隔离库 `BLF_test` |
| `product-analysis-task-failed.json` | `GET .../tasks/{id}`（真实 failed 终态） | 隔离库 `BLF_test` |
| `product-analysis-result-not-ready.json` | `GET .../tasks/{id}/result` → 真实 409 | 隔离库 `BLF_test` |
| `product-analysis-task-not-found.json` | `GET .../tasks/{不存在}` → 真实 404 | 隔离库 `BLF_test` |

## 为什么是真实响应

- **读侧**（RPA 状态、广告入库状态）是本批验收 1「与 Web 同源同值」的唯一可执行证据：
  这两张表的形状由后端的多表聚合决定（15 列 × 每项目、`latest_date` 来自不同来源），手写
  「看起来对」的 JSON 只能证明解码器能解自己编的数据。
- **写侧**（recognize / commit）的形状同样只能由后端给出：`AdUploadRecognitionResponse`
  与 `/report-upload/recognize` 的响应**不是同一个形状**（见下），照抄会静默少字段。
- **异步任务**（`product-analysis-reports`）的终态形状（`stage` / `progress` /
  `persistence_status` 是三个不同的东西）只能从真跑一次里看到。

### 关键形状差异（客户端踩坑点）

`/ad-upload/recognize` 与 `/report-upload/recognize` **是两个不同的响应模型**：

| | `ad-upload`（本批） | `report-upload` |
| --- | --- | --- |
| 日期字段 | `detected_report_date` / `detected_start_date` / `detected_end_date` | `detected_date` / `detected_start_date` / `detected_end_date` |
| 多站点 | 无 | `detected_countries` / `primary_country` |
| 日期输入模式 | 无 | `date_input_mode` |
| 命中列 | `matched_columns` | 无 |

故桌面端**不能**把两个端点的识别结果当同一个模型用。

## 抓取口径（`manifest.json` 里也逐项记着）

- 鉴权：`X-API-Key`（主 key）+ `X-Is-Admin: true` + `X-Operator: admin`（与 S5.1~S5.3 同一组）。
- 固定参数：`country=US`；RPA 状态取 **2026-09-14**（往前找的第一天有已上传数据的日期）；
  入库状态 `limit=50`（＝后端默认值，也是页面口径）。
- **没有任何写业务表的请求**：`recognize` 只落磁盘临时文件（后端那条路径里没有一次
  `db.add/commit`）；`commit` 一律 `dry_run=true`（后端注释：不写 `ad_upload_files` /
  `ad_upload_promoted_product_rows`、不占版本号）；`product-analysis-reports` 的 POST 会写
  一条审计日志，故只在隔离库 `BLF_test` 上跑，抓完即删。
- 唯一的一处归一化：响应文本里的**仓库根绝对路径 → `<repo>`**（`file_path` /
  `error_message` 天生带本机路径）。字段名 / 类型 / 数值一律原样。

### 合成源文件说明（recognize 那三条）

识别的输入是一份**合成**的 CSV（`开始日期,结束日期,广告SKU,广告ASIN,广告活动名称,广告组名称`
＋ 2 行数据），表头照抄 `app/services/ad/upload/specs.py` 的 `required_columns`；SKU / ASIN
取自生产快照库里**同一个项目**的真实行（`创酷` / `JDB-10PCS1-4` / `B0G1SPQL12`），
这样 `project_match` 落在 `matched` 上而不是只能钉「未匹配」分支。

响应本身 100% 由后端识别器 / 入库器产出（`recognize_saved_ad_upload` /
`commit_ad_upload`），合成只发生在**输入**。合成源文件不落 git（脚本随时可重建）。

## 与 Web 同源同值的抽样口径与实测数字

抽样口径：`report_date=2026-09-14`、`country=US`，**全量**比对（不是抽样点）——
`rpa-status.json` 的 10 个项目 × 15 个报表类型逐格数出来：

| 口径 | 实测数字 |
| --- | --- |
| 项目数 | 10 |
| 每个项目的状态格数 | 15（＝ Web `REPORT_TYPES` 的列数） |
| 格子总数 / 已上传格数 | 150 / 133 |
| 首个项目 `博朗姆`（id=19） | 14/15（唯一缺的是 `payment_report`） |
| 末个项目 `吕沃`（id=16） | 15/15 |
| `ad-upload/status`（US, limit=50） | 50 条（**顶到 limit**，即可能被截断）、覆盖 10 个广告报表类型、6 个项目 |

这些数字逐条钉在 `ReportDecodingTests` / `ReportAutomationStoreTests` 里 —— 后端聚合口径
一变就会报红。

## 重新抓取

```bash
python3 macos/scripts/capture-report-fixtures.py              # 写回本目录
python3 macos/scripts/capture-report-fixtures.py --out <dir>  # 写别处（复核漂移用）
```

脚本会自己解析本机 Postgres（可用 `DATABASE_URL` 覆盖；`BLF` 与 `BLF_test` 都必须存在），
并在结束时清理它造出来的磁盘临时区与 `BLF_test` 里的审计行。重抓后 `manifest.json` 的
`sha256` / `bytes` / `captured_at` 会一并更新 —— `ReportDecodingTests`
的 `testCommittedSnapshotHashesMatchManifest` 会拦下不一致。
