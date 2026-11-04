# Warm Ledger C2 归档索引

> **状态：** C2 Task 6 完成；PR #798 已合并。
>
> **分支：** `feat/warm-ledger-c2-closeout`
>
> **基线：** `main` / `origin/main` at `435c9cc7`
>
> **日期：** 2026-11-04（Asia/Shanghai）

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [`2026-11-02-warm-ledger-c2.md`](./2026-11-02-warm-ledger-c2.md) | C2 页面合同、实现任务与整批收尾记录 |
| [`2026-11-03-warm-ledger-c2-stage-checkpoint.md`](./2026-11-03-warm-ledger-c2-stage-checkpoint.md) | C2 Task 6 验收证据与阶段交接 |
| [`2026-11-02-warm-ledger-c2-task-3-report.md`](./2026-11-02-warm-ledger-c2-task-3-report.md) | Shipping Plan / SKU Info 任务报告 |
| [`2026-11-03-warm-ledger-c2-task-4-report.md`](./2026-11-03-warm-ledger-c2-task-4-report.md) | Shipment Management 任务与审查报告 |
| [`2026-11-03-warm-ledger-c2-task-5-report.md`](./2026-11-03-warm-ledger-c2-task-5-report.md) | SKU Info 最终任务与审查报告 |
| [`2026-11-02-warm-ledger-c2-pr-description.md`](./2026-11-02-warm-ledger-c2-pr-description.md) | 本次 C2 PR 描述正文 |

## 阶段进度

| Task | 范围 | 状态 |
| --- | --- | --- |
| 1–5 | C2 route shell 与四个页面迁移 | 已完成并通过独立 Luna max page reviews |
| 6 | 整批回归、浏览器验收、rollout 与 integration review | 已完成；最终独立 review PASS |

## 验证摘要

- Vitest：27 个文件 / 199 例通过（`--maxWorkers=4`）。
- Playwright：78/78，Chromium 与 mobile 两个 project，四个 exact C2 routes、六种宽度与业务工作流；1440px Chromium auth smoke 另 4/4 通过。
- Changed-file ESLint、`pnpm.cmd build`、`pnpm.cmd check:mocks`（295 个测试文件，0 命中）、`git diff --check`、CodeGraph status 均通过。
- Build 有 Next.js workspace-root/NFT、旧 Browserslist 数据和 Turbopack NFT-list warnings；命令成功退出。

## 未解决 follow-ups

后端项目范围授权问题和 SKU Info 的 10,000-row/no-pagination、label ZIP headers、R2 image replacement window 均保留在 [`2026-11-02-warm-ledger-c2-security-follow-up.md`](../2026-11-02-warm-ledger-c2-security-follow-up.md)，不由 UI 改动宣称已解决。

## PR / Git 记录

- Git tag：无。
- PR：[#798](https://github.com/passwii/believeboyDashboard/pull/798)，于 2026-11-04 合并，merge commit `11c60b25`。
- GitHub CI：基线 main `435c9cc7` 的全量 Vitest run `41735587296` 有 57 例失败、分布在 8 个文件；C2 PR 最新 run `41753856697` 与合并后 main run `41754509447` 均为 5 例失败 / 2304 例通过，失败只在未改动的 `inventory-analysis-client.test.tsx` 与 `portfolio-overview-client.test.tsx`，与基线重合。C2 改动涉及的 Vitest 文件均通过；C2 focused suite 27/199 通过，并修正了基线 main 的 Warm topbar stale assertion。Vercel check 因 “Account is blocked” 失败，基线 main 同样失败。
- 本批没有 backend 改动；不手动部署。
- 预先存在的未跟踪 `gui/` 不属于本 PR，保持原样。
