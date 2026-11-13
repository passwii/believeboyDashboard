# productEnvAgent —— `git deploy` 入口

本目录只剩一个脚本：`deploy.sh`，也就是 `git deploy` 别名指向的入口。

```bash
git config alias.deploy '!bash productEnvAgent/deploy.sh'
```

## 它做什么

1. 校验当前分支是 `main`（不是就拒绝）；
2. 若本次改动涉及 `backend/` 或 `backend-go/`，先跑 `go run ./cmd/checkmigrations`（baseline 哈希 + Alembic 冻结 manifest）；
3. `git push origin main`；
4. 直接 `exec deploy/deploy-local.sh`——构建并推送 Web 与 Go API 镜像，再通过 GitHub Actions 以 digest 部署到 VPS。

`PUSH_ONLY=1 git deploy` 只推代码，不构建不部署。

## 部署链路

| 环节 | 位置 |
| --- | --- |
| 本机构建 / 推送 / 触发 | `deploy/deploy-local.sh` |
| GitHub Actions | `.github/workflows/deploy-dashboard.yml` |
| VPS 端执行（含回滚） | `deploy/deploy-remote.sh` |
| 运行手册 | [docs/deployment/dashboard-vps-compose.md](../docs/deployment/dashboard-vps-compose.md) |

部署默认冻结：`DEPLOYMENTS_ENABLED=true` 才会真正执行。

## 已删除的旧工具

2026-11 的 Python 运行时下线中删除了 `deploy_vps.py` / `rollback.py` / `alerting.py` /
`post-push.sh` / `config.json` / `DEPLOYMENT_SKILL.md` / `ROLLBACK.md`：

- 它们操作的是已退役的 **systemd + Python venv** 形态（`systemctl restart believeboy-api`、
  `backend/.venv`、`uvicorn`），与现在的 GHCR + Docker Compose 栈不兼容；
- 回滚能力已内建在 `deploy/deploy-remote.sh`（保存上一版 digest、`.deploy-rollback.*` 配置快照、
  `--no-deps` 只重启业务服务）；
- 失败诊断由 Actions 的 `Diagnose deployment failure` 步骤承担。
