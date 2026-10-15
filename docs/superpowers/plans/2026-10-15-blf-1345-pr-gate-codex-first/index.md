# PR 把关流程（Codex-first）· plan 归档

> **状态：** 实施完成（S1 / S2 已落地；S3 试运行进行中，样本 #1 已记录）
> **分支：** `agent/seth/blf-1345-docs` · **PR：** [#726](https://github.com/passwii/believeboyDashboard/pull/726) · **Issue：** BLF-1345 · **日期：** 2026-10-15
> **发起：** Tia（PLAN 模式）· **实施：** Seth

## 入口表

| 文档 | 内容 |
| --- | --- |
| [`2026-10-15-blf-1345-pr-gate-codex-first.md`](./2026-10-15-blf-1345-pr-gate-codex-first.md) | 主 plan：需求、调研结论、S1–S3 任务分解与验收标准、接口契约、风险标注 |
| [`2026-10-15-blf-1345-pr-gate-codex-first-s3-trial-sample-1.md`](./2026-10-15-blf-1345-pr-gate-codex-first-s3-trial-sample-1.md) | S3 试运行样本 #1（PR #726 自身）：四来源记录、3 条 finding 与处置、流程有效性观察 |

## 阶段进度

| 阶段 | 主题 | 状态 |
| --- | --- | --- |
| S1 | Review 智能体指令改为 Codex-first（Multica Agent Identity，平台侧） | ✅ 已落地（Seth / Damon / Tia 三条 instruction 已回读核对） |
| S2 | 仓库文档与 PR 模板对齐新流程（`AGENTS.md` / `docs/REFERENCE.md` / `TESTING.md` / PR 模板） | ✅ 已落地（PR #726） |
| S3 | 用真实 PR 样本验证并收敛 | 🔄 进行中（样本 #1 = PR #726，2×P1 + 1×P2 已修复；样本 #2 前端 / #3 后端待补） |

## 落地位置（S2 产出）

| 文件 | 内容 |
| --- | --- |
| `AGENTS.md` §PR 把关流程（Codex-first） | 摘要 + 入口：作者提 PR 要求、把关人四来源与 `PENDING` / `UNKNOWN` / `FINDINGS` / `CLEAN` 判定 |
| `docs/REFERENCE.md` §PR 把关流程（完整） | 权威章节：命令与字段、分页、跨 head 结转、必需检查判定、Codex ≠ 测试、T3 不跳过 |
| `TESTING.md` §PR 的测试证据与 Codex 审查的边界 | 三类质量信号各能 / 不能证明什么 |
| `.github/pull_request_template.md` | 精简为 6 项；CodeGraph 降为「改公共符号时填影响面结论」 |

## 外部关联

- Issue：BLF-1345「简化 PR 把关流程并更新智能体 instruction」
- PR #720：Codex 摘要 `Completed` 但 P1 只在行内评论的原型案例（流程设计的直接依据）
- PR #726：本流程文档自身的 Codex 审查 —— 挑出分页 / 跨 head 结转 / 必需检查 3 处边界缺陷

## 数据快照

| 指标 | 值 |
| --- | --- |
| 仓库改动文件 | 4（PR #726 首版）+ 3（归档：主 plan、S3 样本、index） |
| 测试档位 | T0（纯文档 / 模板，不跑 pytest / vitest / lint） |
| S3 样本 #1 Codex findings | 3（2×P1 + 1×P2），全部真实有效 |
| 平台 instruction 长度 | Seth 1452 / Damon 1628 / Tia 2520 字符 |
