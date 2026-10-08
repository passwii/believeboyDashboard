## 交付范围
负责 BLF-1284 发货规划的后端实现（对应批准计划 Task 1–4）。这是前后端并行的后端子任务；前端由父任务负责人实现，接口按父任务描述和本子任务下方冻结的契约协同。

## 开始前必做
- 读取仓库 AGENTS.md / docs/REFERENCE.md 迁移规则，`git fetch origin && git rebase origin/main` 后确认 `cd backend && alembic heads` 唯一；最新 revision 以实际 head 为准，不采用原计划中的编号。
- 只修改 backend/；主键 Integer；遵循测试规则。创建迁移前不推进迁移到 main。
- 复核 `AnalysisSourceFile` 成功状态、report period 的销售完整覆盖判定；库存快照实际选源/完整性语义；项目站点访问依赖；计划/货件关联锁顺序。

## 实施范围
1. 增加 SKU 增长系数、预期计划批次、计划明细、计划数量关联四个模型、迁移和模型测试。
2. 在 replenishment 服务公开窄范围 baseline loader，严格复用补货分析 `_normalize_weighted_dms` 计算的未乘安全系数 `base_dms`，不能复用 seasonal replenishment 的加权算法；加回归测试保证现有补货输出不变。
3. 增加独立纯预测模拟器、shipping-plan schemas/service/endpoints，并注册 inventory router group。
4. 实现 SKU 列表/预测/历史 ETD 发运/倍率读写、计划批次 CRUD（V1 仅取消、不硬删除）、正式货件关联和解绑；保护替换 shipment schedule items 路径不破坏已有 allocation。
5. 权限使用 protected + ensure_project_access，审计/读主库依现有约定；不新增 Agent scope，不改 Agent 货件域。

## 前后端接口约定
遵循父 issue 附带的 2026-10-08 发货规划实施计划：API 基路径 `/api/v1/shipping-plan`，前端经 `/api/backend` 代理。提供 GET `/skus`、GET `/forecast?sku=...`、PUT `/skus/{sku:path}/growth-factor`、GET `/shipment-history`、GET/POST `/batches`、PATCH `/batches/{id}`、POST `/batches/{id}/cancel`、POST `/batches/{id}/allocations`、DELETE `/allocations/{id}`。请求需项目、country 单站点范围；ALL 拒绝；预测固定 180 日。开始接口实现前，在此子任务结果评论或父任务回复贴出实际 request/response JSON 示例（含日期、缺失值、数据质量、汇总、allocation），通知父任务负责人 Seth，以便前端按可运行契约接入。若实际设计需偏离，先在评论说明并协调，不静默改变。

严格实现父 issue 描述和实施计划的边界：库存快照同源；销售覆盖完整才将无订单日期判为 0、否则 null；completed 仅以实际入仓日及快照日判断并处理快照后已入仓；逾期/未知 ETA 不冒充未来供给；90 天逐日 + 后 90 天裁剪自然月；Decimal 计算；allocation 重复提交语义需明确并测试；对 schedule 主记录固定顺序加锁，明细替换冲突返回 409；V1 取消保留记录，取消后的已关联货件仍按正式状态纳入。

## 验证与交接
- 先写失败测试；目标测试，再按父 issue 要求 T3 全量 `cd backend && pytest` 一次并记录实际计数和失败对账；`python scripts/check_alembic.py`；BLF_test 迁移 upgrade/downgrade/upgrade；受影响的旧货件 API/替换路径回归。
- 不连接/写入生产 DB，不自行 push / deploy。
- 结果评论交付：改动概要、迁移 revision/head、接口契约示例、实际测试数字及失败、已知限制；通知父任务负责人 Seth 接入。