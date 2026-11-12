# CI 触发策略评估：PR 必跑 vs 本地测试 + 仅 main 跑 CI

> 评估日期：2026-11-12；评估基线：`origin/main` = `78599306`（`feat/go-setup-test-db` 合并后）。
> 数据来源：`.github/workflows/` 现状、`gh run list` / `gh run view` 实测、`gh api` 分支保护与 workflow 状态。

## 一句话结论

**PR 触发 CI 必须保留，"本地全量 + 仅 main 跑 CI" 不合理。**
但现状确实有三处该改的地方：① main 上的前端全量**已经红了**（两条过期断言），② CI 的
**路径过滤有洞**，改 `deploy/**` 不会跑部署配置不变量测试，导致"main 绿灯 = 假绿"，③
文档仍写"仓库没有后端 CI"，与 `test-ci.yml` 实际承担 backend pytest 全量冲突。

优先级：**补门禁、修漏跑**，而不是减少触发。

## 现状实测

### 工作流与状态

| workflow | 触发 | 状态（2026-11-12） | 备注 |
| --- | --- | --- | --- |
| `test-ci` | `pull_request`→main（带 paths）、`push`→main（带 paths）、`schedule`（每日 18:00 UTC）、`workflow_dispatch` | active | 唯一的自动门禁，承担全局套件 |
| `cache-governance` | PR / push→main（paths 限 `backend/app/services/infra/**` 等） | active | 最近一次运行 2026-10-16 |
| `lighthouse-ci` | PR（任意目标分支）+ push→main | **disabled_manually** | 实际不跑 |
| `motion-system-ci` | PR / push 限 `feat/frontend-motion-system` | **disabled_manually** | 实际不跑 |
| `deploy-dashboard` / `cleanup-dashboard-legacy` / `remove-legacy-dashboard-image` / `audit-vps-project-runtime` | `workflow_dispatch` | active | 手动，不参与分支 CI |

推论：**"每个 feat 分支必跑 CI" 的观察需要修正**——`push` 到 feat 分支不会触发
`test-ci`（push 过滤只认 `main`）；只有**开 PR** 才会触发一次全量。`lighthouse-ci` /
`motion-system-ci` 已被手动禁用，不产生任何运行。

### 运行量与耗时（最近 100 次 `test-ci`，2026-11-10 05:59 → 2026-11-12 06:52 UTC）

| 事件 | 次数 | 成功 / 失败 / 取消 | PR 单次平均耗时 |
| --- | --- | --- | --- |
| `pull_request` | 50 | 39 / 6 / 4 | **227s（~3.8 分钟）** |
| `push`（main） | 48 | 41 / 6 / 2 | ~230s |
| `schedule`（nightly） | 2 | 1 / 1 | ~290s |

- 约 **25 次 PR 全量 / 天**，每次 ≈4 分钟墙钟；同分支连续 push 会因
  `concurrency: cancel-in-progress` 取消旧运行。
- 仓库是 **public**（`visibility: public`）→ GitHub Actions 的标准 runner 分钟不产生费用。
  因此"每 PR 一次全量"的**边际成本≈0**，真实成本只有 reviewer 多等约 4 分钟，以及
  "看到绿灯就以为全量绿"的认知风险。

### 门禁现状

- `GET /repos/passwii/believeboyDashboard/branches/main/protection` → **404 Branch not protected**；
  `GET /repos/passwii/believeboyDashboard/rulesets` → `[]`。
  → **main 没有 required status checks，CI 绿灯目前不是 GitHub 侧强制门禁**，
  它只是人工 review 时的证据来源。

## 为什么"本地全量 + 仅 main 跑 CI"不成立

1. **本地跑全量与既定要求冲突。** `test-ci.yml` 顶部注释记录了用户 2026-10-22 的明确要求：
   "本地制作单元测试，全局测试放在 GitHub Action 做，避免出现 CPU 负载问题。"
   本机还有并发 agent 满载，前端全量实测 43s～2 分钟（`TESTING.md` §前端单测）。
2. **后端全量本地不可比、不可靠。** CI 把 pytest 全量拆成 4 个 shard 跑在**隔离 Postgres**
   上（`backend/scripts/ci_pytest_gate.py` 做基线对账）；本地 `pytest -n auto` 在共享
   `BLF_test` 上会因 autouse `TRUNCATE` 互相死锁（实测 225 failed / 155 errors），
   所以"本地全量"实际等价于"本地串行全量"，既慢又和 CI 口径不同。
3. **门禁后移没有省掉这次运行，只是把发现点推后。** `pull_request` 事件默认跑 **merge ref**
   （base + head 合成的结果），已经等价于"合并结果"的验证。若改成合并后才跑，
   回归会带着 main 一起变红；而 main 又没有分支保护、没有自动回滚（Go 后端全量迁移
   还在冻结期），处理成本远高于合并前拦下。
4. **"只跑 main" 会在路径过滤下产生假绿**（见下节 P1）：main 的 push 运行只跑受影响 job，
   其余 job 记为 skipped，看板全绿并不代表全量绿。

## 三个实证问题（本次 PR 已处理 P1 / P3，P2 交用户拍板）

### P1 路径过滤漏跑：main 的前端全量已经红了，但 CI 看起来是绿的

- 部署配置不变量测试放在 `frontend/scripts/check-deployment-config.test.mjs`（属于
  `pnpm test` 入口），它断言的却是 `deploy/docker-compose.yml` 与 `deploy/deploy-remote.sh`。
- `test-ci.yml` 的 frontend job 过滤只认 `frontend/**`（外加排除 `frontend/docs/**`、
  `frontend/**/*.md`）。**改 `deploy/**` 时 frontend job 被 skip → 这些断言根本没跑。**
- 证据链：
  - `edfb1f35`（2026-11-11，加 Go worker / scheduler）与 `d4c449e7`（2026-11-12，
    FastAPI / Celery 改 compose profile）改了 compose，但测试断言（最后更新于
    `c8a5afbc`）仍按 7 个 `network_mode: host` 与旧的 pull 命令写 → 断言过期。
  - PR #852 合并到 main 的 push 运行（2026-11-12 05:28 UTC）**success**——因为它只改了
    `backend/**` / `deploy/**`，frontend job 被 skip。
  - nightly 运行 `43125951709`（2026-11-12 00:15 UTC）唯一失败 job 是
    `frontend vitest (全量)`：`AssertionError 9 !== 7`。
  - 本地复现一致：`cd frontend && node --test scripts/check-deployment-config.test.mjs`
    → 11 tests / 9 pass / **2 fail**（`9 !== 7` + 过期 pull 断言）。
- 本次 PR 的处理：① 修好两条过期断言；② `deploy/**`、`.github/workflows/deploy-dashboard.yml`
  变更时也跑 frontend job（补洞）。

### P2 main 无分支保护：CI 绿灯只是"建议"，不是"门禁"

没有 required status checks，任何人合并都能跳过红灯。建议（需用户拍板后由管理员执行）：

- 给 main 配 branch protection / ruleset，**required check 指向一个 always-run 的聚合 job**
  （例如新增 `gate` job：`if: always()` + 汇总各 job 结论）。直接 require 现有 job 有坑：
  路径过滤会让 job 处于 skipped / 未上报状态（`Expected — waiting for status to be reported`），
  把 PR 永久卡住；聚合 job 才能让"这次 PR 该跑的 job 集合"成为稳定门禁。
- 配套：把 nightly 的失败当作需要响应的事件（目前红过一次无人处理）。

### P3 文档与实际脱节

- `AGENTS.md` §测试规则 与 `docs/REFERENCE.md` §测试规则（完整）仍写
  "仓库**没有后端 CI**（`.github/workflows` 无后端任务），T3 的后端全量仍不能省"，
  与 `test-ci.yml` 的 `backend` job（4 shard pytest 全量）矛盾；同一处要求本地跑后端全量，
  又与 `test-ci.yml` 顶部"全局套件跑在 CI（不在本地跑）"的用户要求矛盾。
- 本次 PR 已把 AGENTS.md / docs/REFERENCE.md / TESTING.md 同步成实际口径：
  **后端全量在 CI（4 shard）、本地按 T1/T2 目标集、T3 的全量证据取 PR 的 `test-ci` 运行**；
  前端全量本地仍可裸跑（~43s 起），CI 也跑一遍。

## 附带的配置/注释不一致

- `test-ci.yml` 的 `concurrency.group: test-ci-${{ github.ref }}` 注释写
  "同一时刻只跑一条（排队而非取消）"，但 group 里含 `github.ref` →
  **不同分支的 PR 是并行的，不是排队**；同分支的新 push 才会取消旧运行。
  注释与行为不一致（行为本身合理，注释需要改，本次未改行为）。

## 建议的最终流程

| 阶段 | 触发 | 跑什么 | 目的 |
| --- | --- | --- | --- |
| 本地 | 开发者改动 | T1/T2 目标集 + 目录回归（前端全量可裸跑） | 快速反馈 |
| PR | `pull_request`→main | `test-ci` 按 paths 过滤跑受影响 job（当前 ≈4 分钟） | 合并前证据（merge ref ≈ 合并结果） |
| 合并后 | `push`→main | 同上 | 复核合并结果（当前与 PR 运行内容重复，见下） |
| 兜底 | 每日 18:00 UTC | 全量 | 兜住路径过滤漏跑（当前红过一次，需有人看） |

需要用户拍板的三件事：

1. **是否给 main 配分支保护 + required 聚合 job**（把 P2 变成真门禁）。这是本次评估里
   价值最高的一项。
2. **是否保留合并后的 main push 全量**：PR 已跑 merge ref，main push 属于重复
   （每次合并多 ~4 分钟，public 仓库不花钱）。保留更安全；要去重可改成"仅直推 main 才跑"
   （实现上需要额外条件判断，收益主要是省几分钟）。
3. **nightly 时间与响应**：GitHub 的 cron 可能延迟数小时（实测多次落在 00:15–01:18 UTC
   而非 18:00 UTC），是否改到更早的时段、是否给失败建自动 issue。

另外两项待决：`lighthouse-ci` 与 `motion-system-ci` 是否恢复（当前 `disabled_manually`，
恢复后才会产生"每分支触发 Playwright / Lighthouse"的额外负担）。

## 复核命令

```bash
# workflow 现状与状态
gh workflow list --repo passwii/believeboyDashboard --all

# 触发与耗时
gh run list --repo passwii/believeboyDashboard --workflow test-ci --limit 100 \
  --json event,conclusion,createdAt,updatedAt

# 门禁现状（404 = 无保护）
gh api repos/passwii/believeboyDashboard/branches/main/protection

# main 当前是否真的绿（本地复现 nightly 的失败）
cd frontend && node --test scripts/check-deployment-config.test.mjs
```
