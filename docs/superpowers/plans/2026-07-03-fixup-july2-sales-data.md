# 7.2 sales_report 错数据 fixup 计划

> **日期**: 2026-07-03
> **前置**: PR #fix(autoReportUpload) fail-loud fallback + upload_file_path 只存 basename
> **目标**: 清理 7.2 期间错数据, 让 daemon 重 ingest 走新逻辑
> **重要**: 所有 SQL 操作 **不可逆** — 先在 transaction 里 SELECT 看清楚再 COMMIT

## 背景

7.1 切换到 HTTP-only ingest 后, 7.2 号因 daemon processor.py 的 fallback + 22:00 手动 re-ingest 两条路径, 共 **20 个 source_file 错** (覆盖 14 个项目, total 255 行 AnalysisSalesOrderRow 错位)。

**受影响的 source_file 列表** (id, project, filename, total_rows, real_PT_dist):

```
27758 博朗姆   Orders-2026-07-02_14-47-47.txt 19 行  PT: 6-28:7, 6-29:7, 6-30:2, 7-1:3
27761 弥森    Orders-2026-07-02_14-48-41.txt  7 行  PT: 6-30:5, 7-1:2
27771 卡斯摩   Orders-2026-07-02_14-48-46.txt  4 行  PT: 6-28:1, 6-29:3
27773 创酷    Orders-2026-07-02_14-48-42.txt 32 行  PT: 6-28:10, 6-29:6, 6-30:11, 7-1:5
27774 吕沃    Orders-2026-07-02_14-48-29.txt 10 行  PT: 6-28:3, 6-29:4, 6-30:1, 7-1:2
27776 铨富    Orders-2026-07-02_14-47-46.txt  6 行  PT: 6-29:2, 6-30:1, 7-1:3
27778 骏成    Orders-2026-07-02_14-49-27.txt 12 行  PT: 6-28:4, 6-30:4, 7-1:4
27779 华洋泛航  Orders-2026-07-02_14-47-39.txt  3 行  PT: 6-29:2, 7-1:1
27780 玥涵    Orders-2026-07-02_14-47-41.txt 25 行  PT: 6-28:4, 6-29:7, 6-30:8, 7-1:6
27782 博智1店  Orders-2026-07-02_14-49-25.txt 18 行  PT: 6-28:5, 6-29:7, 6-30:4, 7-1:2
27784 博智2店  Orders-2026-07-02_14-49-32.txt 16 行  PT: 6-28:5, 6-29:6, 6-30:5
27786 犀牛    Orders-2026-07-02_14-47-43.txt  2 行  PT: 6-28:1, 7-1:1
27787 铨富    Orders-2026-07-02_18-03-29.txt  6 行  PT: 6-29:2, 6-30:1, 7-1:3
27788 博朗姆   Orders-2026-07-02_18-03-36.txt 12 行  PT: 6-29:7, 6-30:2, 7-1:3
27789 玥涵    Orders-2026-07-02_18-03-41.txt 21 行  PT: 6-29:7, 6-30:8, 7-1:6
27790 创酷    Orders-2026-07-02_18-04-35.txt 22 行  PT: 6-29:6, 6-30:11, 7-1:5
27791 吕沃    Orders-2026-07-02_18-04-42.txt  7 行  PT: 6-29:4, 6-30:1, 7-1:2
27792 骏成    Orders-2026-07-02_18-05-35.txt  8 行  PT: 6-30:4, 7-1:4
27793 博智1店  Orders-2026-07-02_18-05-44.txt 14 行  PT: 6-29:7, 6-30:4, 7-1:2, 7-2:1
27794 博智2店  Orders-2026-07-02_18-05-45.txt 11 行  PT: 6-29:6, 6-30:5
```

每个 source_file 把 12-32 行订单全部塞到 `report_date=2026-07-01`, 但实际 PT 日期分布跨 6-28 ~ 7-2, **导致 daily-analysis 7-1 那个桶看到不属于自己的订单**, 6-28/6-29/6-30/7-2 的桶缺订单。

## 步骤

### Step 1: 部署 fix (commit + push + restart)

**先做** —— 必须先部署, 否则 daemon 重跑仍走错逻辑。

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
git add backend/app/services/internal_ingest.py backend/tests/api/test_internal.py
git commit -m "fix(autoReportUpload): fail-loud fallback + upload_file_path 只存 basename

HTTP-only ingest 7.1 切换后, processor.py line 381-389 fallback
在 parse_sales_rows 抛异常时静默创建 scope_rows=[] 的空 source_file
(regression: 7.2 18:03:36 博朗姆 Orders-2026-07-02_18-03-36.txt
走 fallback 后 0 行入库, daily-analysis 静默无数据)。

本次 fail-loud: 全 scope scope_rows=[] + row_count_preview>0 → 抛
HTTPException(500) 让 daemon 不动文件, 下个周期重试。

同时 upload_file_path 改存 Path(local_file_path).name (basename
only). Mac 本地绝对路径不应该落到 VPS 数据库, SHA-256 + basename
足够审计。

新增 test_ingest_sales_failure_no_source_row + test_ingest_stores_basename_not_absolute_path
覆盖两个改动。tests/api/test_internal.py 10 passed."
git push origin feat/ad-analysis-scripts
.git/hooks/post-push "refs/heads/feat/ad-analysis-scripts" "$(git remote get-url origin)"
# 远程
ssh vps 'sudo systemctl restart believeboy-api'
```

### Step 2: SQL fixup 删错 source_file

**事务模式** — 先 SELECT 看要删的, 再 DELETE。

```sql
BEGIN;

-- Step 2a: 确认 20 个 source_file
SELECT id, project_id, original_filename, file_sha256, row_count_total, report_date
FROM analysis_source_files
WHERE id IN (
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794
)
ORDER BY id;

-- Step 2b: 删关联 report_upload_logs (FK)
DELETE FROM report_upload_logs
WHERE source_file_id IN (
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794
);

-- Step 2c: 删关联 analysis_sales_order_rows
DELETE FROM analysis_sales_order_rows
WHERE source_file_id IN (
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794
);

-- Step 2d: 删 source_file 本身
DELETE FROM analysis_source_files
WHERE id IN (
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794
);

-- 验证: 0 行
SELECT count(*) FROM analysis_source_files WHERE id IN (
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794
);

COMMIT;
```

**审计日志保留** —— `operation_audit_logs` 不动, 7.2 那个 audit 记录 (operator=`autoReportUpload-reprocess`) 留着, 是这次 bug 的根因证据。

### Step 3: 把 processed/ 里 7.2 错文件移回根目录

**工具脚本** `autoReportUpload/scripts/replay_july2_to_root.py` (本次新建):

- 读 SQL fixup 删掉的 20 个 source_file 的 `original_filename`
- 对每个文件名, 在 `WATCH_ROOT/*/processed/` 里找
- 移动到对应项目根目录 (查 `report_upload_logs` 或 `operation_audit_logs` 找原始 project_id, 默认 fallback 顺序: 博朗姆 > 弥森 > 卡斯摩 > ... 按项目列表)
- 注意 `Orders-2026-07-02_18-03-36.txt` 在 3 个项目 processed/ 里都有, 跳过
- **dry-run 模式默认开** —— 先打印移动计划, 用户确认后再 `--apply`

### Step 4: 启动 daemon (Mac 本地)

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/autoReportUpload
source ../backend/.venv/bin/activate
python run.py --once   # 单次扫描, 处理 20 个移回根目录的文件
```

预期: 20 个文件全部按 purchase_date_pt 拆 3-4 个 source_file, 走新逻辑入库。

### Step 5: 验证

```sql
-- 7.2 的 20 个 source_file 应被新 source_file 取代
-- 总 source_file 数: 旧 20 个 (已删) + 新 (每个文件按 PT 日期分桶)
-- 例: 博朗姆 14-47-47.txt → 4 个 source_file (6-28, 6-29, 6-30, 7-1)

SELECT project_id, report_date, COUNT(*), SUM(row_count_total)
FROM analysis_source_files
WHERE report_type = 'sales_report'
  AND created_at >= '2026-07-03 12:00:00+08'  -- 重 ingest 后的时间窗
GROUP BY project_id, report_date
ORDER BY project_id, report_date;

-- daily-analysis 应能正确按日聚合
-- 博朗姆 7-1 实际: 3 行 (3 个订单), 不是 12 行
SELECT COUNT(*) FROM analysis_sales_order_rows r
JOIN analysis_source_files sf ON sf.id = r.source_file_id
WHERE sf.project_id = 19
  AND sf.report_type = 'sales_report'
  AND sf.report_date = '2026-07-01'
  AND sf.is_current = true;
```

预期: 博朗姆 7-1 应有 3 行 (Orders-2026-07-02_18-03-36.txt 的 3 个 7-1 订单)。

## 风险

- **processed/ 文件移动后被 daemon 触发**: 确保 daemon 是单例在跑, 不要多处同时跑
- **8.3 之后 7.2 文件已被 supersede**: 清掉旧 source_file 后, 7.2 之前的 (sha 3804d569 + 17b419bd) "旧" source_file 都在 7.2 22:00 已经被翻 is_current=False, 重跑会创建新 source_file (version 递增, period_start_date 不变)
- **report_upload_logs 行丢失**: 这 20 个 source_file 的 report_upload_logs 行会被删, 但 daemon 重跑时会自动补写新的 (内部逻辑 perform_ingest 写 report_upload_logs)
- **审计追溯**: `operation_audit_logs` 不动, 7.2 那条 audit 记录 (`autoReportUpload-reprocess` operator) 还在, 是 bug 复盘的关键证据

## 验证脚本

跑完 Step 5 后, 用 `docs/superpowers/specs/2026-07-03-auto-report-file-path-design.md` 里的端到端测试, 跑 1 个 sales_report 验证:
- source_file 按 PT 日期分桶 (✅ fix 9416579)
- upload_file_path 是 basename (✅ 本次 fix)
- fail-loud 拒绝 scope_rows=[] (✅ 本次 fix)
