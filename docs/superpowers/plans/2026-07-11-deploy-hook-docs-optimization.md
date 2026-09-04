# 部署 Hook / 文档优化计划（2026-07-11）

## 背景

核对了实际运行的 hook、模板、deploy 脚本与两份文档（AGENTS.md / DEPLOYMENT_SKILL.md）及 API 路由后，发现：

1. **核心 bug 已修复**：AGENTS.md 记载的 "pre-push 递归卡死"（`GIT_SKIP_HOOKS=1 git push` 不屏蔽 pre-push）在活文件 `.git/hooks/pre-push` 中**已经用 `git push --no-verify` 解决**（第 66 行）。文档仍把旧 bug 写成当前问题，会误导。
2. **文档严重失配**（DEPLOYMENT_SKILL.md）：
   - 推荐 post-commit hook（每次提交即部署，含本地分支）→ 比活 hook 危险；
   - "方式 3" 让你装 `productEnvAgent/post-push.sh`，但活的、且 git **根本没有 post-push 这个内置 hook**，该文件永不自动触发；
   - "方式 4" 引用 `projectEnvAgent/settings.json`（实际目录 `productEnvAgent`、文件 `config.json`，不存在 triggers 配置）；
   - 部署流程写 `systemctl stop`+`start`，脚本实际用 `systemctl restart`；
   - 健康检查写 `curl /api/v1/health` 返回 `{"status":"ok"}`，但脚本 `CHECK_COMMANDS` 没做 curl（只 `systemctl is-active`+`import app.main`），而 `/health` 需 `require_api_key`，裸 curl 必 401。
3. **脚本健壮性缺口**：
   - pre-push 先 push 再 deploy；deploy 失败 → 脚本非零退出 → git 报 "push failed"，但代码已在 origin；重推 up-to-date 不再触发 deploy，VPS 悄无声息停留旧代码。
   - `git pull` 在 VPS 无 `--ff-only` 保护，非快进/脏树会失败。
   - 健康探测 `curl ... | grep '"detail"'` 因 401 恒返回 `{"detail":...}` 而**永远通过**（假阳性）。

## 改动清单

### A. AGENTS.md（Push/部署规则段）
- 把"已知坑（递归卡死）"改写为"已于 2026-07-09 用 `--no-verify` 修复"，保留历史说明。
- 补充触发条件（仅 `backend/` 改动才部署）。
- 新增"deploy 失败怎么办"说明（代码已上 origin，手动 `deploy_vps.py --auto` 补齐，重推不再触发）。

### B. productEnvAgent/DEPLOYMENT_SKILL.md
- 重写"触发方式"段：以活 `.git/hooks/pre-push` 为唯一真相源；删 post-commit 推荐；把 post-push.sh 标为"git 无此后置 hook、非默认"；配置来源改为 `config.json`。
- 部署流程：`systemctl stop`+`start` → `systemctl restart`。
- 错误处理表：健康检查说明需 API key，401 也代表服务已起。

### C. .git/hooks/pre-push
- deploy 失败时打印清晰告警（⚠️ 代码已推送，VPS 未更新，请手动 `deploy_vps.py --auto`）并以 `exit 0` 结束，避免误报 push 失败。

### D. productEnvAgent/deploy_vps.py
- `DEPLOY_COMMANDS[0]`：`git pull` → `git pull --ff-only`。
- 拉取步骤超时 120s → 300s（github 从 VPS 拉取偶发慢）。
- 健康探测改用 `curl -w '%{http_code}'`：200=健康，401=服务已起（受 key 保护，探活视为通过），其余=失败。消除假阳性。

### E. post-push.sh / config.json
- `post-push.sh`：头部标注弃用（git 无 post-push 内置 hook，自动部署请用 pre-push）。
- `config.json` workflow：`stop`+`start` → `restart`，与脚本一致。

## 验证
- `bash -n` 检查 pre-push / post-push.sh 语法。
- `python -m py_compile productEnvAgent/deploy_vps.py`。
- `python productEnvAgent/deploy_vps.py --dry-run` 冒烟（不实际执行）。
