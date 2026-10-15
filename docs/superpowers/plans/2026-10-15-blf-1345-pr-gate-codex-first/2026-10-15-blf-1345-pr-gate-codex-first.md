# PR 把关流程简化与 Codex 审查方案

> **状态：** 实施完成（S1 / S2 已落地，S3 试运行样本 #1 已记录）· **分支：** `agent/seth/blf-1345-docs` · **PR：** [#726](https://github.com/passwii/believeboyDashboard/pull/726) · **日期：** 2026-10-15
> **作者：** Tia（代码质量工程师，PLAN 模式）；**实施：** Seth（前端工程师）
> **归档：** 由 Seth 在修复 PR 中提交，S3 样本见同目录 [`...-s3-trial-sample-1.md`](./2026-10-15-blf-1345-pr-gate-codex-first-s3-trial-sample-1.md)

## 需求确认

把 PR 把关的主流程改为读取当前 PR 的 Codex 自动审查结果；Codex 指出有效问题时再定向处理，减少例行人工检查与重复测试，同时避免把“没有看到评论”误判成“审查通过”，也不把静态代码审查误当作测试结果。

## 调研结论与建议

- PR #720（2026-10-14）已有 Codex 自动审查：审查摘要显示完成，但详细反馈是单独的 PR 行内评论；Codex 指出一个 P1 跨操作员项目数据访问风险。仅读 PR 概览或 issue 评论摘要会漏掉这条实际反馈。因此必须同时读取审查状态/摘要、行内评论和 PR 评论线程。
- 该案例证明 Codex 反馈能帮助发现风险，但**不能证明没有反馈就无风险**；“没有评论”只有在确认 Codex 已完成对当前 HEAD 的审查后才可解释为无发现。对旧 commit 的审查不能作为新 HEAD 的结论。
- Codex 自动审查是静态审阅信号，不能替代测试执行、CI 或部署检查。建议它成为低风险 PR 的主要语义 review 来源；常规 PR 取消无差别全量测试/重复人工 checklist，但保留作者测试声明和既有必要门禁。Codex 发现问题并修复后，按影响面跑目标测试；权限、安全、迁移、共享 schema/config 等既有 T3 高风险改动仍执行相应验证。
- 本工作区的 `AGENTS.md` 已被运行时注入了自动管理内容；该注入不是仓库自身的 review 指令，实施时不可把运行时注入段落当作本次改动提交。当前 agent 的 Review 模式提示属于 Multica 运行时 Agent Identity，不是可由仓库 PR 直接修改的普通源码；须由平台/提示词维护者更新，并同步调整仓库文档。

## 任务分解

### S1：更新 Review 智能体指令，采用 Codex-first 的状态判定

- **角色**：frontend + backend（跨前后端通用的 PR review instruction）
- **依赖**：无
- **产出**：Multica Agent Identity 的 Review 模式；仓库 `AGENTS.md` 中新增简短入口/链接（只改仓库跟踪的项目指令，不提交运行时注入块）
- **验收标准**：
  1. 指令明确 Codex 结果要按当前 PR 最新 HEAD 判定，并汇总摘要、review、inline review comments、issue comments/reactions；不得只看一处或只看 `gh pr view` 的摘要。
  2. `chatgpt-codex-connector` 的行内问题被作为待处理发现；“无发现”仅在 Codex 明确完成且对应当前 HEAD 时成立。缺失、运行中、API 读取失败、commit 不匹配都记为 `PENDING/UNKNOWN`，不当作通过。
  3. 有效风险/缺陷进入修复或人工确认；修复提交后，确认 Codex 已审查新 HEAD（必要时显式触发 `@codex review`），再作结论。
  4. Codex 清洁完成时，低风险 PR 不再重复执行冗长的人工逐项 review/无差别全量本地测试；仍保留适用的既有必需 GitHub 检查、前端 Vercel 成功门禁及作者测试证据。不得把 Codex review 描述为“已运行测试”。
  5. 继续按既有测试档位抽验：问题修复跑受影响目标集；触发迁移、权限、安全或公共 schema/config 等 T3 条件时不因 Codex 无发现而跳过相应测试。CodeGraph 仅在需要确认公共符号影响面时调用，不再作为每个 PR 的重复手续。
  6. 保留 PR 变更面识别及合并/部署责任边界；若 Agent Identity 由平台托管，平台提示词变更须由有权限的 owner 完成，不能假设仓库文件会覆盖注入指令。

### S2：让测试文档与新 review 流程一致

- **角色**：frontend + backend
- **依赖**：S1
- **产出**：`docs/REFERENCE.md` 的完整测试规则；`TESTING.md` 与 `AGENTS.md` 的入口/摘要
- **验收标准**：
  1. 清楚区分“Codex 静态审查”与“测试执行/CI/Vercel”；说明各自可以证明什么、不能证明什么。
  2. 保留 T0–T3 和 E2E 风险判断；说明普通 PR 可依赖作者测试声明及 Codex 完成结果而不机械全量跑，但命中 T3 条件时仍按原有规定验证。
  3. 明确修复 Codex 发现后需针对变更运行对应测试，若 review 重新触发则以新 HEAD 的反馈为准。
  4. 文档不重复维护多套相互矛盾的完整流程；`AGENTS.md`、`TESTING.md` 指向一个权威详细章节。

### S3：用 PR 样本验证新流程并收敛

- **角色**：frontend + backend
- **依赖**：S1、S2
- **产出**：3 个后续 PR 的试运行记录（至少一个前端、一个后端/纯后端、一个命中高风险条件或相应的人工演练）
- **验收标准**：
  1. 每个样本都记录 PR HEAD、Codex 是否完成/审查 commit、实际 inline findings、必需检查状态及是否执行定向测试。
  2. 用 PR #720 回放确认流程能读到摘要之外的 P1 行内评论；用一例“审查未完成/commit 过期/API 读取失败”确认不会误报通过。
  3. 试运行中未出现把 Codex clean 当成测试通过、漏读 inline finding 或对旧 commit 结论放行的情况；发现流程歧义则先修订指令再全面采用。

## 接口契约

本改动不涉及产品前后端业务 API。Review agent 与 GitHub/Codex 的读取契约如下（以当前仓库 PR 编号为 `<N>`，owner/repo 为 `passwii/believeboyDashboard`）：

| 用途 | 读取接口/命令 | 关键字段与判定 |
| --- | --- | --- |
| PR/HEAD、文件、部署检查概览 | `gh pr view <N> --json number,title,state,headRefOid,files,comments,reviews,latestReviews,statusCheckRollup`（按当前 `gh` 版本取可用字段） | 记录当前 HEAD SHA；`statusCheckRollup` 用于识别既有检查（含前端 Vercel）。不能只依赖 `comments` 摘要来获取所有审查反馈。 |
| Codex review 结果 | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | 读取 `user.login`、`state`、`commit_id`、`body`、`submitted_at`。只将 Codex reviewer 对应当前 HEAD 的完成结果作为当前轮审查证据。 |
| 行内审查问题 | `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` | 读取 `user.login`、`body`、`path`、`line`、`commit_id`、`in_reply_to_id`；逐条检查 Codex review comment/thread，不能因摘要评论为空而跳过。 |
| PR 对话中的自动审查摘要/状态 | `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` | 读取 Codex connector 的最新摘要与完成状态；检查其关联/描述的 reviewed commit。仅存在“已完成”字样但 commit 不匹配不算当前 HEAD 完成。 |
| 无发现的完成信号（辅助） | `GET /repos/{owner}/{repo}/issues/{issue_number}/reactions` | `👍` 只作辅助信号；必须结合当前 HEAD 的已完成审查，不能单独作为批准依据。 |

**决策枚举**：

- `PENDING`：Codex 尚在审查，或当前 HEAD 的完成状态尚未出现；等待/按需触发审查，不合并。
- `UNKNOWN`：GitHub API/权限/网络失败、review commit 不可确认、反馈源结果矛盾；报告原因并回退到人工 review，不视为 clean。
- `FINDINGS`：当前 HEAD 的 Codex 行内/整体反馈提出一个或多个风险；逐条判断有效性，真实问题修复或经人工明确接受后再继续。
- `CLEAN`：已确认 Codex 对当前 HEAD 完成，所有反馈源均已读，且无待处理有效发现；仍需满足该 PR 适用的必需检查与测试策略。

API 读取失败、无权限或 GitHub CLI 字段不兼容时不得静默降级为 `CLEAN`；记录失败并使用可用 GitHub 页面/接口复核，仍无法确认则 `UNKNOWN`。Codex 反馈是 review 建议，不是对产品数据权限、测试执行或部署成功的保证。

## 风险标注

1. **需要人工确认（平台权限）**：当前 Agent Identity 的 Review 模式由 Multica 运行时注入，仓库 PR 无法可靠覆盖它。需平台/提示词 owner 同意并实际更新该指令；仓库侧只能提供对应文档入口和测试政策。
2. **高风险（不建议完全取消测试）**：Codex 不等于运行测试，且静态审查可能漏报。建议只简化低风险 PR 的例行 reviewer/全量测试，不取消必要 CI/Vercel、作者测试证据和 T3 验证。如果业务决定连这些也取消，应由用户明确接受风险。
3. **状态信号风险**：GitHub 的汇总评论可能与 inline review 分开，且审查可能落后于最新 HEAD。必须验证 commit SHA、读取所有反馈源；没有评论不等于没有审查发现。
4. **暂不确定的行为**：Codex 在新 commit 后是否总会自动重审不能只依赖假设；实施时若未观察到对应最新 HEAD 的完成记录，应显式请求 `@codex review` 并等待明确完成状态。
