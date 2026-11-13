# autoReportUpload —— 遗留 Python 服务（尚未迁移）

监控一个（或多个）报表目录，识别新落盘的 Excel/CSV 报表类型，入库并把文件移动到
"已处理"目录。是**仓库里最后一个 Python 运行时**。

## 当前状态（2026-11）

> ⚠️ **main 分支上无法直接运行。**

本服务的历史实现把识别 / 入库逻辑复用自 `backend/app/**`：

| 依赖 | 用途 |
| --- | --- |
| `app.services.ad.upload.*` | 广告报表 spec、识别、列匹配、持久化 |
| `app.utils.payment_locale` / `app.utils.parsers` / `app.utils.recognition` | 付款周期、报表解析、识别错误类型 |
| `app.models` / `app.db.session` | SQLAlchemy 模型与 session |
| `app.services.inventory.ledger` | 库存台账入库 |

2026-11 的 **Python 运行时下线**（PR #857）删除了 `backend/app`，所以这些 import 现在会
直接 `ModuleNotFoundError`。同时它调用的服务端内部端点
`/api/v1/internal/auto-report/{recognize,ingest,heartbeat}` 也只存在于已删除的
FastAPI 里——Go 网关没有对应实现。

## 临时运行方式（迁移完成前）

用最后一个仍含 `backend/app` 的 commit 检出独立 worktree：

```bash
git worktree add ../believeboy-legacy 171866d5^
cd ../believeboy-legacy
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt -r autoReportUpload/requirements.txt
cd autoReportUpload && ../backend/.venv/bin/python run.py --dry-run   # 先干跑
```

生产写入路径仍指向**尚未切换的 FastAPI**（部署处于冻结期），因此临时 worktree 与线上是同构的。

## Go 迁移方案（待实施）

分三步，每步都能独立验收：

1. **服务端 ingest 端点**：在 `backend-go/internal/api/` 下新增 `autoreport` 模块，实现
   `recognize` / `ingest` / `heartbeat` 三个内部端点（`X-Internal-Token` 鉴权）。
   广告报表可直接复用 `internal/store/ad_upload*.go` 的解析器；库存台账、退货、销售
   需要新增 ingest 实现（目前 Go 只有读接口）。
2. **目录监控 CLI**：新增 `backend-go/cmd/autoreport-upload`——`fsnotify` 监听 + 文件稳定检测
   + 单实例锁 + 归档移动，复用 `internal/autoreport` 的识别结果。
3. **切换与删除**：生产切到 Go CLI 后删除本目录与 `autoReportUpload/requirements.txt`。

验收基线：用 `--dry-run` 对同一批历史报表做识别，Go 与 Python 的 report_type /
project / 日期区间 / 行数完全一致。

## 目录结构（供迁移参考）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `monitor.py` | 1140 | 目录扫描、watchdog 派发、单实例锁、运行日志 |
| `processor.py` | 1641 | 各类报表的入库落库与归档移动 |
| `recognition.py` | 411 | 报表类型识别与项目匹配 |
| `api_client.py` | 173 | 内部 ingest HTTP 客户端（重试 / 退避） |
| `config.py` / `db.py` / `models.py` / `emit_event.py` | 471 | 配置、DB、模型、数字员工事件 |
| `tests/` | 1602 | pytest 用例（迁移时作为行为基线） |
