# Amazon 评论追踪阶段 A 移交说明

> 面向接手的 AI harness / 开发者。本文记录当前分支状态、已完成范围、验证结果和后续推荐步骤。请先阅读本文件，再阅读关联设计与计划。

## 当前 Git 状态

- 仓库：`believeboyDashboard`
- 当前 worktree：`/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking`
- 分支：`feat/amazon-review-tracking`
- 当前 HEAD：`36ff0f92db44b9caa5b3b33b946ef9c5ef55109f`
- 分支基线：`3d7b7b844215d8d3e4c4223591eadfa6da705e20`（从当时的 `main` 分出）
- 阶段 A 代码、报告、设计稿和计划均已提交；没有已暂存/已修改文件。
- 当前仍有 4 个未跟踪的临时任务简报：
  - `docs/superpowers/plans/2026-10-12-amazon-review-tracking/task-1-brief.md`
  - `docs/superpowers/plans/2026-10-12-amazon-review-tracking/task-2-brief.md`
  - `docs/superpowers/plans/2026-10-12-amazon-review-tracking/task-3-brief.md`
  - `docs/superpowers/plans/2026-10-12-amazon-review-tracking/task-5-brief.md`
  它们是执行用拆分简报，不是产品文档，不要误加入提交；如不需要可留着或由接手者清理。
- 重要：主 worktree `/Users/damon/DamonProjects/believeboyDashboard` 与本 worktree 不同。主 worktree 有其他用户/任务留下的未提交改动（pricing-calculation、文件删除及文档变更等），**不可覆盖、重置、清理或 cherry-pick 回写到主 worktree**。当前分支工作应继续在此隔离 worktree 上。
- 分支尚未合并到 `main`，也没有推送到远端。用户之前要求“把阶段提交掉”，已完成的是提交在本地功能分支，不是 merge/push。

### 近期提交

- `36ff0f92 docs(评论追踪): 归档阶段A设计与实施计划`
- `08993a41 docs(评论追踪): 更正阶段A验证报告`
- `5a0e2c31 docs(评论追踪): 还原Task4实现简报`
- `69243786 fix(评论追踪): 修复组PATCH校验与重名`
- `507c2d79 fix(评论追踪): 停用组时释放有效成员`
- `a3e5f930 test(Agent SKU): 锁定父体字段局部更新行为`
- `2905f0c6 docs(评论追踪): 记录Task5验证报告`
- `2b9d0acb test(评论追踪): 覆盖审计失败回滚`
- `9311e526 fix(评论追踪): 补充跨域API拒绝测试`
- `b020d710 fix(评论追踪): 加固管理接口审查问题`
- `03c678a7 feat(评论追踪): 暴露运营共享组管理接口`
- `3b0c7cd8 fix(亚马逊评论追踪): 修复成员事务与归属校验`
- `78324f92 feat(评论追踪): 实现共享组服务规则`
- `cd09990c fix(评论跟踪): 补齐复合外键与归属约束`
- `cc4bcec2 fix(评论追踪): 修正迁移字段归属与外键类型`
- `0add9a2a feat(评论追踪): 注册共享组数据模型`
- `4044ec0f feat(SKU): 增加 Father ID 字段`

## 已提交文档

- 设计/需求主文档：[`docs/superpowers/specs/2026-10-12-amazon-review-tracking-design.md`](docs/superpowers/specs/2026-10-12-amazon-review-tracking-design.md)
- 阶段 A 实施计划：[`docs/superpowers/plans/2026-10-12-amazon-review-tracking/2026-10-12-amazon-review-tracking-phase-a.md`](docs/superpowers/plans/2026-10-12-amazon-review-tracking/2026-10-12-amazon-review-tracking-phase-a.md)
- 阶段任务执行报告：同目录 `task-1-report.md` 至 `task-5-report.md`。Task 4 的报告与实现简报路径分别是 `task-4-report.md` 和 `task-4-brief.md`；Task 4 brief 曾被误提交修改、之后于 `5a0e2c31` 还原为执行时简报内容。
- 本移交文件：`HANDOFF-AMAZON-REVIEW-TRACKING.md`。

设计文档状态已更正：阶段 A 完成；阶段 B–D 未实施且仍需深化设计。

## 阶段 A 已实现

### 1. SKU 父体标识

- 在现有 SKU info / `product_costs` 记录上增加可空 `father_id`，按运营人员手工维护；它与 ASIN 不同，不自动推导，也未改变既有 SKU 唯一键 `(project_id, sku, asin, country)`。
- 内部 SKU 创建、更新、列表/详情响应及 Agent SKU 写入/读取支持此字段。PATCH 区分缺省（保留）与显式 `null`（清空）。
- Agent PATCH 已测试设置、清空和不传字段三种语义。

### 2. 内部评论共享组基础

- 新增 revision `281`：内部评论共享组、成员关系表、复合外键及部分唯一索引；Father ID 列 nullable。
- 共享组以稳定 ID 标识；成员必须和组在 Project/Marketplace 上一致；代表 SKU 必须是组的有效成员；同一 SKU 不能在多个有效内部组中重复。
- 运营管理 API 提供共享组列表、创建、PATCH 成员/代表/名称/说明、软停用；写操作有管理员校验、事务审计与回滚；列表成员查询批量化。
- 删除/移除为软标记。停用旧组会标记其活动成员 removed，让 SKU 能重新加入其他组，同时保留旧成员历史行。父子或共享组调整不自动迁移历史。
- 本阶段**没有**保存评分快照或逐条 Amazon Review。

### 3. 复审修复已纳入当前提交

- Agent PATCH Father ID set/null/omitted。
- 停用组释放有效成员并保留成员历史。
- API PATCH 空/负成员或代表 ID 返回 422。
- 同项目/Marketplace 活动组重名创建/改名冲突返回 409。
- 事务失败、跨项目/Marketplace、认证、读写审计等目标路径有针对性测试。

## 已确认的后续产品方向

- 内部 ASIN 来自 Project 下 SQ info；SKU info 中运营人员手动维护 Father ID，并手动配置评论共享组和代表 ASIN。
- 父子关系与评论共享组是两个概念；一个 Father 下允许多个评论共享组，因为异常案例中同一父体下不同 ASIN 有不同的评分/Review 集合。
- 快照和 Review 历史按评论共享组归属；组内 ASIN 不重复抓取，Agent 从系统先获取当前有效目标、代表 ASIN、Marketplace 和规则。
- 外部竞品 ASIN 不进 SKU info，只在“评论追踪”页面临时登记并关联店铺；默认每个外部 ASIN 独立成组。移除是软状态，重加同一店铺关系时恢复并沿用历史。一个 Marketplace + ASIN 只有一套追踪数据，可被多店铺关联。
- 共享关系改变后不自动合并/拆分旧历史；之后如要挪动历史，再做专门的人为调整功能。
- 评分和 Review 抓取状态分开。只有评分、没有文字 Review 时仍保存评分快照；ratings 数和有正文 reviews 数不等价。
- 同一共享组同一业务日期一条快照；同日重试更新该日快照，但保留运行记录。预计每周抓取一至两次，不要求每日任务必跑。
- 单条 Review 后续内容变更只更新当前版本；保留 first/last seen。完整评论列表成功抓取且连续两次未出现，标疑似移除；不完整/失败不作删除判断，后续再次出现可恢复。
- Review ID 优先取页面 DOM ID 或 URL；不存在时允许用 Marketplace + 共享组 + 可取评论属性指纹生成低可信度内部 ID。指纹可能因编辑改变，不能保证等同来源 ID。

## 当前验证状况（必须如实传递）

见 `task-5-report.md`：

- 目标测试最终报告：**80 passed**（覆盖 SKU/Agent Father ID、Review group service/API、停用成员后重新分组）。另外 Task 4 PATCH 修复专项记录 API 13 项、service 9 项通过。
- `python scripts/check_alembic.py` 通过，迁移单 head、命名/链路检查通过。
- 在本地 `BLF_test` 执行 revision 281 downgrade/upgrade 往返通过；downgrade 保留 `father_id`。没有连接或写入开发/生产库 `BLF`。
- 全量 pytest：**40 failed、4097 passed、14 skipped**，约 357.72 秒。失败集原始 node ID 未能准确恢复，候选 pytest cache 与 40 项报告数不吻合；**没有和 main 对账**，所以不能说全量通过，也不能断言这 40 项都是历史失败。
- 全量执行时本地 `backend/.venv` 缺少 requirements 未声明的 `pytest-asyncio`；仅在本机 venv 临时安装了 `pytest-asyncio==1.3.0`，未改 `requirements.txt`。重现时注意测试插件和环境。
- 曾执行 `alembic check`，因现有 DB/schema 大量差异返回非零；离线 `upgrade --sql` 被早期 baseline 的 `sa.inspect(bind)` 阻塞。这些限制详见 Task 5 报告，不代表 revision 281 的定向 upgrade/downgrade 往返失败。
- 完整分支复审通过主要代码项；终审未发现 Critical 代码问题。仍把全量失败集未对账视作明确验证缺口。

## 还没做的阶段

### 阶段 B：评论追踪后端（尚未开始）

需要先将业务方向细化成专门 spec/plan，主要考虑：

- 稳定共享组与商品来源：内部组来自 SKU info；外部 ASIN/店铺临时关联不属于 SKU 主数据。
- 评分快照：组、Marketplace、抓取业务日期/时间、均分、global ratings 数、可获得的有文案 Review 数、各星百分比、星数及精确/估算/不可得质量、抓取状态、来源、运行记录。
- Review 当前记录：来源 Review ID / 推导 ID、身份可信度、user ID 可空、昵称、星级、标题、正文、日期、Verified Purchase（三态/未知）、helpful 数、first/last seen、可见/疑似移除状态。
- `review_count` 与 `rating_count` 不混用；页面星级比例可能舍入，推算绝对数量不能冒称精确。
- 独立抓取运行记录、按组独立提交/失败重试、同日幂等更新，以及完整列表判定。
- 外部竞品软关联表及重加恢复逻辑，数据留存/权限/隐私/平台合规。

### 阶段 C：评论追踪运营页面（尚未开始）

- 入口“评论追踪”；按共享组/ASIN/店铺/Marketplace/日期查询趋势与评论详情。
- 图表 hover 显示该日期评分、ratings 总数、review 数、1–5 星原始占比和星数精度；显示缺采、部分成功和日期空档。
- 页面只管理外部竞品临时关联；内部共享组关系在 SKU info 管理。

### 阶段 D：Agent API（尚未开始）

- Agent 先读系统提供的 active 采集目标和规则，再抓取；不可自行决定内部父子组或改组。
- Agent 按评论共享组独立提交结果，一个组失败不影响其他组。
- 沿用现有 Agent API 凭证、project scope（适用于内部项目数据）、确认/幂等策略、限流和审计模式；外部竞品的授权边界需单独设计。

## 接手建议

1. 先从仓库根 `AGENTS.md` 与 `TESTING.md` 读取当前指令，并验证本文件开头所列分支、SHA 和 worktree 状态；不要假设默认打开的主工作区就是功能分支。
2. 不要在 `main` 上直接开发，不要将主工作区现存未提交改动混入。本阶段分支尚未推送/合并。
3. 继续之前，决定如何处理全量 pytest 的 40 项未分类失败：恢复精确原始失败清单，或重新在 main 与 feature 使用同环境/同失败集做一次定向对账（不要第二遍跑全量）。不能把未知失败加 skip/xfail。
4. 接着先为阶段 B 写 spec / plan 并确认具体库表与接口契约；不要因为阶段 A 已有组模型，就直接把快照/Review 字段塞进当前共享组表。
5. 浏览器案例数据曾在 2026-10-12 观察：ASIN `B0G6C865B6` 2.6/5、7 global ratings；页面星占比 5星16%、4星16%、3星15%、2星16%、1星37%；DOM 有类似 `R1F90C6R6GV8L6` 的评论 ID；当次显示 6 条文字 review 卡片。Amazon 页面会变，应在真正定义采集 schema 前再验证。
