# FastAPI → Go 迁移状态（2026-11-13）

## 结论

**后端已全量 Go 化**：网关承接全部 623 个 OpenAPI operation，异步任务、定时任务、
数据库迁移、PDF、截图、邮件、契约测试与部署链路均已切换。Python 运行时已从仓库与
部署栈移除，只剩 `autoReportUpload/` 一个独立服务尚未迁移。

## 已完成

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| HTTP 网关（70 模块 / 623 operation / 694 路由） | `backend-go/internal/api/` + `internal/httpserver/router.go` | `cmd/gateway/route_coverage_test.go` |
| 异步任务 | `cmd/go-worker` + `internal/queue` | `go test ./...` |
| 定时任务 | `cmd/go-scheduler` + `internal/scheduler` | 同上 |
| 数据库迁移（Goose） | `cmd/migrate` + `internal/migrations/sql` | `cmd/checkmigrations` |
| PDF 生成 | `internal/pdf` | 单测 + 定时报表端到端 |
| 报表截图 | `internal/scheduledreport` | 单测 + 邮件附件用例 |
| 邮件（含附件） | `internal/mailer` | `attachment_test.go` |
| 契约测试（FastAPI golden） | `internal/livecontract` + `tests/contract` | 15 用例 / 14 路由，无 Python |
| 测试库准备 | `cmd/setuptestdb` | 克隆 schema + seed 账号 |
| 部署（Compose / Actions） | `deploy/docker-compose.yml` + `deploy-remote.sh` | `deploy-scripts` CI job |

### 已删除的 Python

- `backend/app/`（695 个文件）、`backend/scripts/`、`backend/tests/`（370 个 pytest 文件）、
  `backend/Dockerfile` / `requirements.txt` / `alembic.ini` 等运行入口；
- Celery worker / beat 与 `legacy-python` Compose profile；
- `productEnvAgent/` 的 `deploy_vps.py` / `rollback.py` / `alerting.py`（旧 systemd + venv 形态）。

### 保留的归档（无运行时）

- `backend/alembic/versions/` —— 冻结在 revision 285，只被 `cmd/checkmigrations` 校验；
- `backend/deploy/` —— 旧 systemd / cron 单元，仅作冷启动排障参考；
- `backend/.env.example` —— 环境变量清单。

## 待办

### 1. autoReportUpload → Go（唯一剩余 Python 运行时）

现状与方案见 [`autoReportUpload/README.md`](../autoReportUpload/README.md)。工作量估计：
服务端 ingest 端点（广告报表可复用现有解析器，库存台账 / 退货 / 销售需新增）+ 目录监控 CLI，
约 1500–2000 行 Go。验收基线是同一批历史报表在 Go / Python 下识别结果一致。

### 2. 部署解冻

部署默认冻结，需要 `DEPLOYMENTS_ENABLED=true` 才执行。解冻前建议依次完成：

1. `bash deploy/validate-local-go-cutover.sh`（本地全链路，含 fallback 日志检查）；
2. 在预发 / 本地用 Go 网关跑一轮完整业务冒烟（登录、项目、报表上传、定时报表、告警）；
3. 切换 `GO_API_OWNED=all` 并确认 `request fell back` 计数为 0；
4. 再打开 `DEPLOYMENTS_ENABLED`。

### 3. 可选清理

- `backend/alembic/versions/` 若要彻底移除，需要把 `cmd/checkmigrations` 的 frozen manifest
  改成记录历史哈希而不是校验文件存在（当前保留成本极低，建议不动）；
- 仓库里仍有历史文档（`.rpiv/`、`docs/superpowers/plans/`、`attachments/`）提到 `backend/app`，
  它们是历史记录，**不需要**跟进修改。

## 常用验证命令

```bash
cd backend-go
go vet ./...
go test ./... -count=1
go run ./cmd/checkmigrations

# 契约（需要 BLF_test；无 Python）
BELIEVEBOY_ENV_FILE=../backend/.env.test ./scripts/run-live-contract.sh

# 部署脚本静态检查
actionlint .github/workflows/test-ci.yml .github/workflows/deploy-dashboard.yml
bash -n deploy/*.sh
```
