# autoReportUpload file_path + fail-loud 设计

> **状态**: 设计中 (2026-07-03)
> **作者**: Claude Code (Damon 决策)
> **父任务**: BEL-127 follow-up (HTTP-only ingest 7.2 切换后)
> **目标 commit**: 接续 9416579 (sales_report 按 purchase_date_pt 分桶)

## 背景

7.1 号 `autoReportUpload` 切换到 HTTP-only ingest 后:

1. **daemon 端**: 本地 Mac 跑 `autoReportUpload/processor.py`, 调云端 FastAPI `/api/v1/internal/auto-report/{recognize,ingest,heartbeat}`
2. **后端**: `backend/app/services/internal_ingest.py` 收 `IngestRequest`, 写 A 表 (`analysis_source_files` + `analysis_sales_order_rows` 等) 或 C 表 (`ad_upload_files`)
3. **云端 VPS 不存文件**: 文件留在 Mac 本地 `WATCH_ROOT/<项目>/processed/`

### 发现的 bug

7.2 号博朗姆项目 `Orders-2026-07-02_18-03-36.txt` (12 行订单, PT 日期分布 6/29×7 + 6/30×2 + 7/1×3) 入库后, daily-analysis 在 7/1 那个桶看到 12 行 (实际应该是 3 行):

**bug 链** (按时间):
1. **7.2 18:03:36** daemon 自动处理: `parse_sales_rows` 抛异常 → 走 fallback (line 381-389) → 创建 1 个空 source_file (`scope_rows=[]`), **0 行入库**
2. **7.2 22:00:26** 手动 re-ingest (operator=`autoReportUpload-reprocess`): **没按 purchase_date_pt 拆分 scope** → 把 12 行打包到 1 个 scope `scope_date=2026-07-01` → 创建 source_file id=27788, 12 行全标 `report_date=2026-07-01` → 9 行错位 (实际 PT 是 6/29 / 6/30)

**根因**:
- 修复 9416579 已 commit 到 `feat/ad-analysis-scripts` 分支, **但未部署** (生产数据库 7.2 22:01 后无新数据)
- processor line 381-389 fallback 在 `parse_sales_rows` 抛异常时**创建空 source_file**, 没标记失败

### 当前架构问题

1. **`upload_file_path` 字段存的是 Mac 绝对路径** (如 `/Users/damon/Documents/RPA/博朗姆/processed/Orders-...txt`), 违反"云端不存文件"原则 —— 云端不应该持有可能让云端代码误读的本地路径
2. **fallback 静默创建空 source_file** 让错误难以发现 (audit log 里能看见 `scope_rows=[]`, 但没标记 `failed`)
3. **fix 9416579 未部署** 导致新处理的文件继续走错逻辑

## 决策 (Damon 已确认)

| 决策点 | 选择 | 理由 |
|---|---|---|
| 修复路径 | 先 deploy 9416579 + 修 file_path + 清 7.2 错数据 + 让 daemon 重 ingest | 一次到位, 不留尾巴 |
| `upload_file_path` 字段 | 保留字符串但只存 basename, 加注释"本地路径,云端不读" | 保留审计 trail (知道是哪个文件入库的) + 不让云端读路径 |
| daemon 失败 fallback | Fail-loud: 整次 ingest 返回 5xx, daemon 不动文件 | 避免"假绿色"状态, 监控能立刻发现 |

## 设计

### 改动 1: `internal_ingest.py` —— `upload_file_path` 只存 basename

**位置**: `backend/app/services/internal_ingest.py:_ingest_a_table` (line 412-434) + `_ingest_c_table` (类似位置)

**改动**: 
```python
# before
upload_file_path=payload.local_file_path,

# after
upload_file_path=Path(payload.local_file_path).name,
```

并在 `AnalysisSourceFile` / `AdUploadFile` 的 model 注释里加 "本地路径, 云端不读" 警告 (不改 schema, 字段仍保留)。

**影响**:
- `Path("/Users/damon/Documents/RPA/博朗姆/processed/Orders-2026-07-02_18-03-36.txt").name == "Orders-2026-07-02_18-03-36.txt"`
- SHA-256 仍存 (`file_sha256` 字段), 查重 + 审计够用
- 历史数据 (`upload_file_path` 是 Mac 绝对路径) **不修**, 不影响查询 (新数据从 7.3 起是 basename)

### 改动 2: `internal_ingest.py` —— fail-loud 失败处理

**位置**: `backend/app/services/internal_ingest.py:perform_ingest` + `_ingest_a_table` 入口

**改动**:
- `_ingest_a_table` 入口检查 `payload.scopes` 是否全部 `scope_rows=[]` (空) + `row_count_preview>0` (非空)
  - 这种情况 = daemon 报告了 N 行但实际发了 0 行 = 数据丢失
  - 抛 `HTTPException(500, "empty scope_rows with non-zero preview")`
- 任何 `Exception` 都不 catch, 直接传播
- `perform_ingest` 让 FastAPI 兜底返回 5xx, 不 commit
- 入口 (autoReportUpload/processor.py) 收到 5xx → 不 `_move_to_processed` → 文件留在原目录 → 下个周期重试

**位置**: 
```python
# internal_ingest.py:_ingest_a_table 入口加
if payload.scopes and all(
    s.row_count_preview > 0 and not s.scope_rows 
    for s in payload.scopes
):
    raise HTTPException(
        status_code=500,
        detail=f"all scopes are empty (preview={payload.scopes[0].row_count_preview}) - refusing to write empty source file"
    )
```

**影响**:
- daemon 不会再 "假绿色" 入库
- 监控告警直接定位: 日志搜 "refusing to write empty source file" 即可
- 7.2 那个 18:03 案例会被 fail-loud 拦下, 不会出现 source_file 27739

### 改动 3: SQL fixup 删 7.2 错数据

**写 `docs/superpowers/plans/2026-07-03-fixup-july2-sales-data.md`** (plan 文档), 包含:
- 删 source_file id=27758 (sha 3804d569) + 关联 19 行 `analysis_sales_order_rows`
- 删 source_file id=27788 (sha 17b419bd) + 关联 12 行 `analysis_sales_order_rows`
- 检查 7.2 18:00-22:00 期间所有 sales_report ingest, 找类似 bug (不只是博朗姆)
- **重点: 检查所有项目的所有 sales_report ingest 在 7.2 0:00-23:59 期间**, 看 `audit_logs` 里 `scope_rows=[]` 的 case
- 重置 7.2 18:00-23:59 期间所有 sales_report 的 `report_upload_logs` 为空, 让 daemon 重跑时不冲突

**触发 re-ingest**:
- 把 `WATCH_ROOT/<项目>/processed/` 里 7.2 错文件移回根目录 (绕过 daemon 跳过 processed 的逻辑)
- 或者: 写一个 ad-hoc 脚本用 `APIClient.ingest` 重发这些文件, 用新的 SHA (修改 file 内容产生新 hash) 走通

### 改动 4: deploy 流程

- 修完代码 + 测试通过 → `git add` + `git commit` (类型: `fix(autoReportUpload): fail-loud fallback + basename only file path`)
- push `feat/ad-analysis-scripts` 分支到 origin
- 触发 `.git/hooks/post-push` (CLAUDE.md 里有): `productEnvAgent/deploy_vps.py --auto`
- 验证: 远程跑 `systemctl status believeboy-api`, 跑 `pytest tests/api/test_internal.py`

## 测试

### T1: `test_ingest_sales_failure_no_source_row`
- mock: `IngestRequest` 带 1 个 scope, `scope_rows=[]` + `row_count_preview=12`
- assert: response 5xx, DB `analysis_source_files` 无新行, DB `analysis_sales_order_rows` 无新行
- 这是 fail-loud 验证

### T2: `test_ingest_stores_basename_not_absolute_path`
- mock: `IngestRequest` 带 1 个 scope, `scope_rows=[正常行]`, `local_file_path="/Users/damon/Documents/RPA/博朗姆/processed/Orders-2026-07-02_18-03-36.txt"`
- assert: DB `analysis_source_files.upload_file_path` == `"Orders-2026-07-02_18-03-36.txt"` (basename)
- 这是 basename 验证

### T3: 已有 `test_ingest_sales_splits_per_purchase_date` (9416579 引入)
- 跑通即过

### T4: 已有 `test_ingest_duplicate_sha256_returns_duplicate` (test DB 缺表, 已知失败, 无关本次)

## 部署 checklist

- [ ] backend `pytest tests/api/test_internal.py` 全过 (含 T1 T2 T3)
- [ ] `git diff HEAD` 无脏文件
- [ ] `git status` clean
- [ ] commit message 中文: `fix(autoReportUpload): fail-loud fallback + upload_file_path 只存 basename`
- [ ] `git push origin feat/ad-analysis-scripts`
- [ ] `.git/hooks/post-push "refs/heads/feat/ad-analysis-scripts" "<url>"` (因为 AI 推 push 不会自动触发)
- [ ] 远程 `systemctl restart believeboy-api`
- [ ] 远程 `curl -fsS http://127.0.0.1:8100/docs` 验证
- [ ] 远程 `pytest tests/api/test_internal.py` 验证
- [ ] Mac 本地: `autoReportUpload` 已启动, 处理 processed/ → 根目录移回的文件
- [ ] 验证博朗姆 7.1 PT 的 daily-analysis 显示真实 3 行

## 风险

- **7.2 错数据范围**: 7.2 18:00-22:00 期间所有 sales_report 都可能错 (不只是博朗姆). SQL fixup 前必须 audit_logs 排查全范围
- **重 ingest SHA 冲突**: processed/ 移回根目录后, daemon 重跑, SHA 一样, 后端命中 duplicate 路径, **只补写 upload_log 不重写 source_file**. 需要修 daemon 或用新 SHA
- **VPS 服务重启**: `believeboy-api` 重启时正在处理的请求会失败. 选低峰期
