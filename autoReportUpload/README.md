# autoReportUpload —— 遗留 Python 服务（已被 Go 版替代）

监控项目报表目录，识别新落盘的 Excel/CSV 报表，入库并归档。

> **2026-11-13：Go 版已实现** —— `backend-go/cmd/autoreport-upload`。
> 本目录保留作为行为参考与回退对照，生产切换验证通过后可整体删除。

## Go 版怎么跑

```bash
cd backend-go

# 只识别、不入库、不移动（先干跑）
API_KEY=<API_KEY> WATCH_ROOT=/Users/damon/Documents/RPA \
  go run ./cmd/autoreport-upload --once --dry-run

# 真正入库 + 归档（单次）
API_KEY=<API_KEY> WATCH_ROOT=/Users/damon/Documents/RPA \
  go run ./cmd/autoreport-upload --once

# 常驻（默认每 5 分钟扫一次）
API_KEY=<API_KEY> WATCH_ROOT=/Users/damon/Documents/RPA \
  go run ./cmd/autoreport-upload
```

常用环境变量（与 Python 版同名，便于原地切换）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WATCH_ROOT` | `/Users/damon/Documents/RPA` | 项目目录根 |
| `AUTORUN_PROJECTS` | 10 个既有项目名 | 逗号分隔，覆盖监听的目录 |
| `AUTORUN_WATCH_WORKERS` | 3 | 并发文件数 |
| `AUTORUN_STABLE_SAMPLES` / `AUTORUN_STABLE_POLL_SECONDS` | 2 / 1 | 文件写完判定 |
| `AUTORUN_MAX_FILE_ATTEMPTS` | 3 | 单文件重试上限 |
| `CHECK_INTERVAL_MINUTES` | 5 | 轮询间隔 |
| `GO_API_BASE_URL` | `http://127.0.0.1:8200` | 网关地址 |
| `API_KEY` / `GO_API_TRUSTED_PROXY_SECRET` | — | 网关鉴权（后者用于放行 `X-Operator` 身份头） |
| `AUTORUN_OPERATOR` | `autoReportUpload` | 写库时的操作者名 |
| `AUTORUN_DRY_RUN` / `AUTORUN_ONCE` | false | 干跑 / 只跑一轮 |

## 处理流程（Go 版）

1. 扫描 `<root>/<project>/` 与 `<root>/<project>/美国/` 下 `.txt/.csv/.xlsx`；
2. 等文件 fingerprint（size + mtime）稳定 `STABLE_SAMPLES` 次；
3. 先调 `/api/v1/ad-upload/recognize`，命中则 `/commit` 并归档到 `广告Processed/`；
4. 否则调 `/api/v1/report-upload/recognize`，命中则 `/commit` 并归档到 `processed/`；
5. 两边都识别不出 → 跳过，文件留在原地等人工；
6. 项目以**目录名**为准；识别结果里的项目与之不一致时跳过；
7. 同名归档冲突自动加 `_1` / `_2`。

## 与 Python 版的差异（切换前需知）

| 项 | Python 版 | Go 版现状 |
| --- | --- | --- |
| 触发方式 | watchdog 事件（macOS FSEvents） | **轮询**（默认 5 分钟；无 fsnotify 依赖） |
| 数字员工任务上报 | 写 `employee task` 记录（面板可见） | **未实现**（Go 只有读接口，需新增内部写接口） |
| 心跳 | `POST /internal/auto-report/heartbeat` | **未实现**（原端点已随 FastAPI 删除） |
| sha256 去重 | 命中则跳过并归档 | **未实现**；改由网关的 `duplicate_warnings` 提示版本覆盖 |
| 项目白名单 | 硬编码 10 个 | 同默认值，`AUTORUN_PROJECTS` 可覆盖 |

这三项差异不影响数据入库正确性，但会影响「数字员工面板」与运维监控；需要时按下面的顺序补。

## 待补（按顺序）

1. **数字员工任务上报**：在网关加一个内部端点（写 employee task/log），CLI 在处理前后各调一次；
2. **心跳**：同一端点或独立端点记录 `last_run_ts/status`，供面板读取；
3. **fsnotify**：替换轮询（可选，改 `go.mod` 加依赖）；
4. **sha256 去重**：网关 `Status` 或新增查询端点返回同 sha 的既有 file_id。

## 旧 Python 版（回退参考）

Python 版依赖已删除的 `backend/app/**`，main 上无法直接运行。需要对照行为时，
用仍含 `backend/app` 的历史 commit 检出独立 worktree：

```bash
git worktree add ../believeboy-legacy 171866d5^
cd ../believeboy-legacy
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt -r autoReportUpload/requirements.txt
cd autoReportUpload && ../backend/.venv/bin/python run.py --dry-run
```

## 目录结构（行为参考）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `monitor.py` | 1140 | 目录扫描、watchdog 派发、单实例锁、运行日志 |
| `processor.py` | 1641 | 各类报表入库与归档移动 |
| `recognition.py` | 411 | 报表类型识别与项目匹配 |
| `api_client.py` | 173 | 内部 ingest HTTP 客户端 |
| `tests/` | 1602 | pytest 用例（Go 迁移的行为基线） |
