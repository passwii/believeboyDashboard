# Agent 扁平锚列契约补齐设计

## 背景

BLF-1043 已为店铺测算富契约和 BI 扁平契约提供盈亏平衡广告费率 / 目标广告费率。
A 团队在接入时确认了三个阻塞点：

1. R5/R6/R7 没有 `include_anchor`，锚列恒带；R1/R2/R3 支持关闭，语义不统一。
2. R5 扁平行缺少 `non_ad_fee_usd`，调用方无法解释锚偏低的原因。
3. R5/R6/R7 的响应在 OpenAPI 中是 `additionalProperties: true`，客户端不能自动生成类型。

## 目标

以向后兼容方式统一锚列语义，并补齐可解释字段与 OpenAPI 类型：

1. R5/R6/R7 增加 `include_anchor`，默认 `true`。
2. `include_anchor=false` 时省略全部锚列，不返回 `null`。
3. 扁平行增加 `non_ad_fee_usd`。
4. R5/R6/R7 声明显式 Agent 成功响应模型，使 OpenAPI 暴露真实 data schema。
5. 默认响应仅做增量变更；现有调用方不因本次调整丢失字段。

## 非目标

- 不修改锚计算公式。
- 不新增数据库列或 Alembic 迁移。
- 不改变 compute 无状态试算语义。
- 不把 R5/R6/R7 合并为富契约，也不新增嵌套 `anchor` 对象。
- 不调整 R1/R2/R3 的既有 `include_anchor` 行为。

## 契约设计

### 锚列

R5/R6/R7 每行继续使用扁平字段：

```text
breakeven_advertising_rate
non_ad_fee_usd
max_ad_spend_per_unit_usd
target_advertising_rate
```

`non_ad_fee_usd` 与 `anchor.non_ad_fee_usd` 同源同口径，等于
`total_fee_usd - advertising_fee_usd`。

`include_anchor` 规则：

| 路由 | 参数位置 | 默认值 | true | false |
|---|---|---|---|---|
| R5 `/shop-calculation-history` | Query | `true` | 返回四个锚列 | 四列全部省略 |
| R6 `/shop-calculation/snapshots` | Query | `true` | 返回四个锚列 | 四列全部省略 |
| R7 `/pricing-snapshots` | Query | `true` | 返回四个锚列 | 四列全部省略 |

`include_anchor=false` 与 `target_net_margin` 同时传入时，`target_net_margin`
不产生目标列；请求仍可成功，不额外报参数冲突。

### OpenAPI 响应模型

三个读路由统一返回 Agent 成功壳：

```json
{
  "ok": true,
  "data": {}
}
```

使用泛型 `AgentOkResponse[T]` 将 `data` 声明为：

- R5：`ShopCalculationHistoryResponse`
- R6/R7：`ShopCalculationSnapshotsResponse`

返回对象仍由当前 Pydantic 模型构造；路由启用
`response_model_exclude_unset=True`，以便 `include_anchor=false` 时保留“字段缺失”
语义，而不是在下游重新补回 `null`。

## 实现边界

预计修改：

- `backend/app/schemas/external/shop_calculation.py`
  - 新增通用 Agent 成功壳模型。
  - `ShopCalculationHistoryRow` 新增 `non_ad_fee_usd`。
- `backend/app/services/external/_shop_calculation.py`
  - 扁平化当前态与时间序列时透传 `anchor.non_ad_fee_usd`。
- `backend/app/services/external/_pricing_calculation_snapshot.py`
  - 定价快照扁平化时同样透传 `non_ad_fee_usd`。
- `backend/app/api/v1/endpoints/agent/shop_calculation.py`
  - R5/R6 增加 `include_anchor`。
  - 关闭锚时移除四个锚列。
  - 增加显式响应模型。
- `backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py`
  - R7 增加 `include_anchor`、关闭锚时移除四列、增加显式响应模型。
- 契约与技能文档、生成后的 OpenAPI 类型。

## 测试策略

后端聚焦测试：

1. R5/R6/R7 默认响应包含四个锚列。
2. R5/R6/R7 传 `include_anchor=false` 后，四个键均不存在。
3. `non_ad_fee_usd` 与富契约 `anchor.non_ad_fee_usd` 一致。
4. `target_net_margin` 的目标列行为保持不变。
5. OpenAPI 中：
   - 三条路由都声明 `include_anchor`。
   - 三条路由的 200 响应引用显式 Agent 成功壳。
   - `data` 引用对应扁平响应 schema。
   - `ShopCalculationHistoryRow` 包含四个锚列。
6. 运行后端相关测试、前端生成类型检查与现有回归测试。

## 风险与兼容性

- 默认行为新增 `non_ad_fee_usd`，属于向后兼容的增量字段。
- `include_anchor` 是新增可选参数，默认值保持当前恒带行为。
- 显式响应模型可能暴露既有序列化差异；以生产当前响应为 parity 基线，通过测试锁定。
- 不新增迁移，部署回滚不涉及 schema 状态。
