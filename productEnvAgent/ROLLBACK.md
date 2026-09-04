# 回滚操作手册（BLF-524）

生产合并即上线、无 staging：坏合并直接到生产。本文档定义**何时需要回滚、
谁来触发、怎么执行、回滚后如何重试**，并说明迁移降级的风险约束（BEL-492）。

相关文件：

- `productEnvAgent/rollback.py` — 回滚执行工具（后端 revert + 重启 + 健康检查；前端 Vercel 回滚）
- `productEnvAgent/alerting.py` — 部署失败告警助手（multica issue 评论 + 本地留痕）
- `productEnvAgent/deploy_vps.py` — 部署工具（失败路径自动发告警）

---

## 1. 触发条件（什么算「需要回滚」）

合并到 main 后出现以下任一情况，且**简单修复无法立即恢复**时，考虑回滚：

| 现象 | 判定 | 回滚对象 |
|---|---|---|
| 后端服务起不来（`systemctl status believeboy-api` failed） | 部署后 API 不可用 | 后端 |
| 健康检查不过（`/api/v1/health` 非 200/401） | 服务在但探活失败 | 后端 |
| 新功能上线即报错（页面 5xx、接口 500、数据异常） | 冒烟/线上验证失败 | 后端 + 前端 |
| 数据库迁移失败或迁移后数据读写异常 | alembic 失败/疑似坏迁移 | 后端（含 downgrade） |
| Vercel production 部署状态 failed / 页面白屏 | Vercel 部署失败或产物损坏 | 前端 |

**不适用回滚的情形**：本地小修即可解决（如环境变量、单文件 hotfix）、
纯数据问题（走数据修复脚本）、需要重新上线验证的新版本（先回滚再重试）。

## 2. 谁触发、谁执行

1. **发现**：Tia（合并把关人）或任何 Agent 在部署后验证中发现上述现象；
   部署失败告警（见 §5）会自动通知目标 issue。
2. **决策**：Tia 评估是否回滚；**高风险或迁移相关回滚由用户拍板**，
   低风险（纯后端代码问题、无迁移）可直接执行。
3. **执行**：`rollback.py` 由 Tia 或用户本机执行（需要 SSH 到 VPS 的密钥 +
   multica CLI / Vercel 凭据）。
4. **记录**：回滚完成后在受影响的 issue / PR 上留档（bad-sha、回滚命令、结果）。

## 3. 后端回滚

```bash
# 预览命令序列（推荐先看一遍）
python productEnvAgent/rollback.py --bad-sha <bad-sha> --dry-run

# 正式回滚（会要求确认；--force 跳过确认）
python productEnvAgent/rollback.py --bad-sha <bad-sha> --auto --force
```

工具自动完成：

1. `git fetch` + 校验 bad-sha 存在；
2. **merge-aware revert**：merge commit 用 `git revert -m 1`，普通 commit 直接 revert；
3. 可选 `--push-back`：把 revert 提交推回 `origin/main`，保持 VPS 与远端一致
   （推荐，否则下次部署会因 non-fast-forward 失败）；
4. Alembic 机械检查（BLF-492 `scripts/check_alembic.py`）；
5. 需要降库时用 `--downgrade <rev>`（执行前工具会先展示 `alembic history` 供核对）；
6. 重启 `believeboy-api` + `believeboy-celery` + `believeboy-celery-scheduled`；
7. 服务状态 + HTTP 健康检查（200/401 视为通过）。

### bad-sha 怎么拿

- 部署失败告警里自带 bad-sha；
- 或 `git log --oneline -3 origin/main` 取坏提交；
- 或 `python productEnvAgent/rollback.py --auto --force`：自动读
  `productEnvAgent/logs/last-failed-deploy.json`（deploy_vps.py 失败时写入）。

### 回滚后重试部署

```bash
# revert 提交已在 origin/main 上（--push-back）时：
python productEnvAgent/deploy_vps.py --auto          # 直接重试部署

# 未 push-back（VPS 本地 revert，origin/main 仍是坏提交）时，先同步远端：
git checkout main && git pull
git revert --no-edit -m 1 <bad-sha>                  # 在本地也 revert（merge-aware）
git push origin main                                 # 远端恢复为修复后状态
# 然后重试：python productEnvAgent/deploy_vps.py --auto
```

## 4. 前端回滚（Vercel）

`rollback.py` 默认含前端步骤（`--no-frontend` 跳过）：

- 优先 `vercel` CLI（需本机已 `vercel login`）：自动列出 production 部署并回滚到上一部署；
- 否则需 `VERCEL_TOKEN`（含 `VERCEL_PROJECT_ID` 环境变量，走 Vercel REST API）；
- 两者都不可用时，工具会明确提示人工操作：
  `vercel ls --prod && vercel rollback <旧部署 URL>`。

> 前端 Vercel 部署失败本身：Vercel 侧有失败状态，由 Tia 合并后验证环节兜底
> （Stage 1 已含），无需额外告警。

## 5. 部署失败自动告警

`deploy_vps.py --auto` 的失败路径（git pull 冲突 / 迁移图拦截 / 依赖安装 /
alembic 失败 / 服务起不来 / 健康检查不过）统一走 `handle_deploy_failure`：

1. 收集 VPS 日志 + 生成分析报告（原有行为）；
2. 记录 bad-sha 到 `productEnvAgent/logs/last-failed-deploy.json`；
3. 通过 **multica issue 评论**（workspace 现有渠道，复用不新建）发出告警，
   内容含失败阶段、bad-sha、受影响 PR、回滚命令；
4. multica 不可用时兜底：告警正文落 `productEnvAgent/logs/alerts/` 并打印到控制台。

### 告警目标 issue 配置（按优先级）

1. CLI 参数 `--alert-issue <uuid>`
2. 环境变量 `ALERT_ISSUE_ID`
3. `productEnvAgent/config.json` 的 `alert.issue_id`

未配置时只落本地文件（`logs/alerts/`），不打扰 issue。

### 测试告警

```bash
python productEnvAgent/alerting.py --test --issue <uuid>   # 发一条测试告警
python productEnvAgent/alerting.py --test --dry-run        # 只打印不发送
```

## 6. 回滚与迁移降级的风险提示

- **BEL-492**：已部署到 prod 的迁移**禁止改 revision id / 重命名**；回滚与迁移
  图修复都只能新增 merge/新迁移，不能改历史。
- **downgrade 前必须核对 `alembic history`**：确认目标修订确实是上一部署点；
  降错版本会造成 schema 与代码不匹配，导致服务起不来。
- revert 代码不自动回退 schema：**只有坏迁移已经执行且需要撤销 schema 变更时**
  才需要 `--downgrade`；纯代码 bug 回滚不要 downgrade。
- revert 产生的新提交与 origin/main 历史分叉时，先按 §3「回滚后重试部署」
  同步远端，不要直接在 VPS 上 `git push --force`。
- 回滚不是银弹：若坏代码已写入生产数据（如任务跑脏数据），回滚后还需数据修复。
