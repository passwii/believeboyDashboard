# S3 试运行样本 #1：PR #726（docs-only）

> **状态：** 已记录 · **日期：** 2026-10-15 · **把关人：** Tia · **作者：** Seth
> **父 plan：** [`2026-10-15-blf-1345-pr-gate-codex-first.md`](./2026-10-15-blf-1345-pr-gate-codex-first.md)

本文是 `plan.md` S3 的第 1 个试运行样本：用「本流程文档自身」当作被审 PR，验证 Codex-first 判定链在真实 PR 上是否成立。

## 样本元信息

| 项 | 值 |
| --- | --- |
| PR | #726 `agent/seth/blf-1345-docs` → `main` |
| head SHA | `eccedca9ca2d6fb5776f60efe54a91bd17954f01`（单 commit） |
| 变更面 | FE=0 / BE=0 / MIG=0（纯 docs / 模板，4 文件：`.github/pull_request_template.md`、`AGENTS.md`、`TESTING.md`、`docs/REFERENCE.md`） |
| Codex 完成 | ✅ 2026-10-15T08:43:22Z，reviewed commit = head SHA |
| 触发方式 | PR opened（自动，无需显式 `@codex review`） |
| 四来源 | 摘要 1 条 `✅ Completed` / reviews 1 条 `COMMENTED`（空壳模板、无具体发现）/ inline 3 条（2×P1 + 1×P2）/ 无 `👍` |
| 必需检查 | `gh pr checks 726 --required` → **无**（该仓库 branch protection 未要求任何检查；Vercel rollup 里存在但非必需，实测 pass） |
| 定向测试 | 无（T0 档，纯文档 / 模板，无代码变更） |
| 判定 | **`FINDINGS`** |
| 结论 | 不合并，@-back 退回作者修复 |

## 流程有效性观察

- ✅ 复现「摘要 `Completed` 但 P1 只在行内评论」——`plan.md` 的核心假设成立（与 PR #720 同型）。
- ✅ 复现「`🔄 Running` 期间四来源全空」——08:40:43 开始审查时 reviews=0 / inline=0 / 只有 `👀` 反应；若按「没评论 = clean」的朴素读法，那 3 分钟内就会误判通过。08:43:22 完成后重读四来源才看到 3 条 inline。
- ⚠️ 新暴露：文档自身有 3 处边界缺陷（见下），恰好都是「本流程要防的那类漏报」。
- 📌 **建议保留的固定动作**：让 Codex 审自己写的流程文档。成本极低，收益明确。

## 3 条 finding 与处置

| # | 级别 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | P1 | `docs/REFERENCE.md`（命令表） | 三个 `gh api` 集合调用全部漏 `--paginate`，默认只读第一页；审查记录超过一页时摘要已 `Completed` 而后页 inline finding 读不到 → 假 `CLEAN`。`gh pr view --json latestReviews` 也不是全量 | 三个端点加 `--paginate`，并补「概览 ≠ 全量」说明 |
| 2 | P1 | `docs/REFERENCE.md`（`FINDINGS` 枚举） | 「只认当前 HEAD」的严格读法会让早于当前 HEAD 的未结 P1 因 `commit_id` 过期而**静默消失**（推一个无关 commit 即可绕过门禁） | 补跨 head 结转规则：未结 inline finding 继续算 finding，直到 thread 被 resolve 或人工 dismiss；附 GraphQL `reviewThreads.isResolved` 查询命令 |
| 3 | P2 | `docs/REFERENCE.md`（检查概览行） | 文档称 `statusCheckRollup` 能「识别必需检查」，实测它只给聚合结果、不区分是否必需；该仓库 `gh pr checks <N> --required` 为空，会误把 Vercel 当 branch-required 门禁 | 改为「rollup 只给聚合概览；必需检查用 `gh pr checks <N> --required` 或查 branch protection」，并明确 Vercel 属项目约定门禁 |

3 条经逐条核对 PR 实际内容后确认**全部真实有效**，非误报。

## 归档值

这是「审查者发现被审对象即审查流程自身缺陷」的一个闭环样本：S3 的验收标准 3（试运行中未出现漏读 inline / 放行旧 commit 结论）在这一个 PR 上就被证伪了一次 —— 不是试运行执行得不好，而是文档缺了分页与结转两个边界，流水线跑通前就暴露出来了。
