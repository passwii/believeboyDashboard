# 发货费用设计方案

## 1. 目标

在现有“发货管理”基础上增加一个 `发货费用` tab，按货件批次展示并维护：

- 项目
- 发货时间
- 货件编号
- 状态
- 货代
- 总发货数量
- 总重量
- 总体积
- 物流单价（每批次人工填写）
- 单品物流单价
- 物流总价

同时支持：

1. 货件内 SKU 维护完成后，从 `SKU 信息` 自动拉取尺寸/重量数据
2. 用户按批次填写物流单价
3. 自动核算批次总物流价、批次单品物流单价
4. 基于历史批次沉淀每个 SKU 的加权平均发货单品单价

---

## 2. 现状

当前项目中已经有两层发货模型：

- `shipment_schedules`
  - 批次头信息，包含项目、货件编号、货代、发货状态、ETD/ETA 等
- `shipment_schedule_items`
  - 批次内 SKU 行，包含 `sku` 和 `quantity`

同时 `product_costs` 已经维护了 SKU 的尺寸/重量字段：

- 单品尺寸：`package_length_cm/package_width_cm/package_height_cm`
- 单品重量：`weight_kg`
- 外箱尺寸：`carton_length_cm/carton_width_cm/carton_height_cm`
- 外箱重量：`carton_weight_kg`
- 装箱数：`units_per_carton`

并且当前 SKU 明细导入时已经校验：

- 该项目下的 SKU 必须在 `SKU 信息` 中存在且为启用状态

这意味着“发货费用”不需要另建一套发货主数据，应该直接挂在现有 `shipment_schedules` / `shipment_schedule_items` 上扩展。

---

## 3. 设计原则

### 3.1 历史口径必须可追溯

`SKU 信息` 后续可能被维护和修正。如果发货费用每次都实时 join `product_costs` 重新算，历史批次的重量、体积、SKU 单价会被改乱。

因此建议：

- 批次头保留“汇总结果”
- 批次 SKU 行保留“当时用于核算的尺寸/重量快照”

### 3.2 手工输入和自动计算分层

人工只维护少量“驱动字段”：

- 物流计价维度
- 物流单价
- 备注/调整值（如果未来需要）

系统负责计算：

- 批次总重量
- 批次总体积
- 批次物流总价
- SKU 分摊后的单品物流单价

### 3.3 优先兼容现有页面和接口

不建议单独新建 `shipment_cost_batches` 主表，避免与 `shipment_schedules` 双主表并存、后续同步困难。

推荐做法：

- 在 `shipment_schedules` 上补充费用字段
- 新增一张 `shipment_cost_item_snapshots` 表，记录每个批次 SKU 的成本快照和分摊结果

---

## 4. 推荐落库方案

## 4.1 批次头扩展：`shipment_schedules`

建议新增以下字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `shipping_charge_mode` | `varchar(20)` | 计价方式：`by_weight` / `by_volume` / `fixed_total` |
| `logistics_unit_price` | `numeric(12,4)` | 物流单价。若按重量则为 元/kg，按体积则为 元/m3 |
| `currency` | `varchar(8)` | 币种，先默认 `CNY` |
| `total_weight_kg` | `numeric(14,3)` | 批次总重量 |
| `total_volume_m3` | `numeric(14,6)` | 批次总体积 |
| `logistics_total_price` | `numeric(14,2)` | 批次物流总价 |
| `item_unit_shipping_cost` | `numeric(12,4)` | 批次级“平均单件物流单价” = 总价 / 总件数 |
| `costs_locked_at` | `timestamptz` | 最近一次成本快照时间 |
| `costs_version` | `integer` | 快照版本，便于后续重算 |

约束建议：

- `logistics_unit_price >= 0`
- `total_weight_kg >= 0`
- `total_volume_m3 >= 0`
- `logistics_total_price >= 0`
- `item_unit_shipping_cost >= 0`
- `shipping_charge_mode in ('by_weight', 'by_volume', 'fixed_total')`

说明：

- 如果你们当前物流统一按 kg 计价，第一版也可以只上 `by_weight`，但表结构建议先放开，避免后续再迁移一次。
- `item_unit_shipping_cost` 是批次级平均值，方便列表页直接展示。

## 4.2 新增明细快照表：`shipment_cost_item_snapshots`

推荐新增一张表，1 个批次 + 1 个 SKU 1 条记录。

### 字段建议

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | bigint PK | 主键 |
| `shipment_schedule_id` | bigint FK | 对应批次 |
| `shipment_schedule_item_id` | bigint FK | 对应批次 SKU 行 |
| `project_id` | bigint FK | 项目 |
| `project_name_snapshot` | varchar(255) | 项目名快照 |
| `shipment_no` | varchar(100) | 货件编号快照 |
| `sku` | varchar(100) | SKU |
| `quantity` | integer | 本批次数量 |
| `charge_mode` | varchar(20) | 本次分摊口径快照 |
| `unit_weight_kg_snapshot` | numeric(10,3) | 单品重量快照 |
| `unit_volume_m3_snapshot` | numeric(12,6) | 单品体积快照 |
| `total_weight_kg` | numeric(12,3) | SKU 总重量 |
| `total_volume_m3` | numeric(12,6) | SKU 总体积 |
| `allocation_ratio` | numeric(12,6) | 总价分摊占比 |
| `allocated_logistics_cost` | numeric(12,4) | 分摊后该 SKU 总物流成本 |
| `allocated_unit_shipping_cost` | numeric(12,4) | 该 SKU 单件物流成本 |
| `source_product_cost_id` | bigint nullable | 取值来源的 SKU info 记录 id |
| `snapshot_payload` | jsonb nullable | 备份原始尺寸/重量字段 |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

### 约束和索引建议

- 唯一键：`(shipment_schedule_item_id)`
- 索引：`shipment_schedule_id`
- 索引：`project_id, sku`
- 索引：`shipment_no`
- check：
  - `quantity > 0`
  - `unit_weight_kg_snapshot >= 0`
  - `unit_volume_m3_snapshot >= 0`
  - `allocated_logistics_cost >= 0`
  - `allocated_unit_shipping_cost >= 0`

### 为什么需要这张表

因为未来你要算“历史批次的加权平均发货单品单价”，这个口径天然是按 `项目 + SKU + 历史批次` 聚合。

如果不保存 SKU 级分摊结果，后面每次都要重新按历史批次重算，复杂度高，也容易被 SKU 信息变更污染历史结果。

---

## 5. 计算口径

## 5.1 单品体积

优先使用单品尺寸：

`unit_volume_m3 = package_length_cm * package_width_cm * package_height_cm / 1000000`

说明：

- 这里默认 `cm -> m3`
- 若任一尺寸缺失或为 0，则按 0 处理，并在页面提示“SKU 尺寸不完整”

## 5.2 批次汇总

对一个批次内所有 SKU 汇总：

- `total_quantity = sum(quantity)`
- `total_weight_kg = sum(quantity * unit_weight_kg_snapshot)`
- `total_volume_m3 = sum(quantity * unit_volume_m3_snapshot)`

## 5.3 批次物流总价

### 方式 A：按重量

`logistics_total_price = total_weight_kg * logistics_unit_price`

### 方式 B：按体积

`logistics_total_price = total_volume_m3 * logistics_unit_price`

### 方式 C：固定总价

如果未来业务需要录入“整票总运费”，则：

- 页面直接填写总价
- 系统反推平均单件成本

第一版如果只做“物流单价”，可以先不开放固定总价录入，但表结构建议预留 `shipping_charge_mode`。

## 5.4 SKU 分摊逻辑

### 按重量分摊

`allocation_ratio = sku_total_weight_kg / batch_total_weight_kg`

`allocated_logistics_cost = logistics_total_price * allocation_ratio`

`allocated_unit_shipping_cost = allocated_logistics_cost / quantity`

### 按体积分摊

`allocation_ratio = sku_total_volume_m3 / batch_total_volume_m3`

### 兜底策略

如果分摊分母为 0：

- 不自动算分摊
- 批次标记为“待补充 SKU 尺寸/重量”
- 页面显示异常提示，不允许确认成本快照

## 5.5 历史加权平均单品物流单价

按 `project_id + sku` 聚合：

`weighted_avg_shipping_unit_cost = sum(allocated_logistics_cost) / sum(quantity)`

也可以等价写成：

`sum(allocated_unit_shipping_cost * quantity) / sum(quantity)`

建议不要直接写回 `product_costs.first_leg_cost_rmb`，原因：

- 这个字段现在更像 SKU 基础资料
- 历史加权平均是衍生指标，不是主数据

推荐做法：

- 先作为查询结果实时聚合
- 性能不足时，再落一张汇总表或物化视图

---

## 6. 推荐接口改造

## 6.1 列表接口扩展

现有：

- `GET /api/v1/shipment-schedules`

建议返回新增字段：

- `total_weight_kg`
- `total_volume_m3`
- `logistics_unit_price`
- `logistics_total_price`
- `item_unit_shipping_cost`
- `shipping_charge_mode`
- `currency`
- `costs_locked_at`

这样前端“发货费用”tab 可以直接复用同一个批次列表接口。

## 6.2 详情接口扩展

现有：

- `GET /api/v1/shipment-schedules/{schedule_id}`

建议补充：

- 批次费用字段
- 每个 SKU 的快照结果列表

例如在返回体中新增：

- `cost_summary`
- `cost_items`

## 6.3 成本重算接口

建议新增：

- `POST /api/v1/shipment-schedules/{schedule_id}/costs/recalculate`

请求体：

- `shipping_charge_mode`
- `logistics_unit_price`
- `currency`

服务端处理：

1. 读取批次头 + SKU 行
2. join 当前启用的 `product_costs`
3. 生成或覆盖 `shipment_cost_item_snapshots`
4. 汇总回写 `shipment_schedules`
5. 更新 `costs_locked_at/costs_version`

说明：

- 用户在页面修改物流单价后，可以显式点击“重新核算”
- 也可以做成保存时自动重算

## 6.4 历史均价接口

建议新增：

- `GET /api/v1/shipment-costs/sku-history`

支持筛选：

- `project_id`
- `sku`
- `shipment_status`
- `date_from/date_to`

返回：

- 历史总批次数
- 历史总数量
- 历史总分摊运费
- 加权平均单品物流单价

---

## 7. 前端改造建议

位置：

- 页面：`frontend/app/dashboard/data-management/shipment-management/page.tsx`

建议从当前 2 区布局扩展为双 tab：

- `发货批次`
- `发货费用`

### 7.1 发货费用 tab 列表字段

建议列：

- 项目
- 发货时间：优先 `created_date`，没有则显示 `etd_date`
- 货件编号
- 状态
- 货代
- 总发货数量
- 总重量(kg)
- 总体积(m3)
- 物流单价
- 单品物流单价
- 物流总价
- 最近核算时间

### 7.2 右侧详情

选中一个批次后展示：

- 批次基础信息
- 物流计价方式
- 物流单价输入框
- 批次汇总指标
- SKU 级费用明细表

SKU 明细建议列：

- SKU
- 数量
- 单品重量
- 单品体积
- SKU 总重量
- SKU 总体积
- 分摊占比
- SKU 总物流成本
- SKU 单件物流成本

### 7.3 交互建议

- 当批次没有 SKU 明细时：
  - 禁止核算
- 当 SKU 信息缺尺寸或重量时：
  - 给出 warning badge
  - 允许查看，但不允许确认核算
- 当物流单价为空时：
  - 不计算总价
- 支持“重新核算”
- 支持“查看历史均价”

---

## 8. 后端实现顺序

建议按下面顺序做，风险最低：

1. Alembic migration
2. SQLAlchemy model 扩展
3. Pydantic schema 扩展
4. service 里新增成本重算逻辑
5. endpoint 暴露重算和历史均价接口
6. shipment-management 页面新增 `发货费用` tab
7. 测试补齐

---

## 9. Migration 建议

### 9.1 第一步：加字段和新表

新增：

- `shipment_schedules` 成本字段
- `shipment_cost_item_snapshots`

这一版不做历史回填，只保证结构上线。

### 9.2 第二步：增量回填

写一个 one-off 脚本：

- 遍历已有批次
- 对有 SKU 明细且 SKU 信息完整的批次执行重算
- 将结果回填

### 9.3 第三步：前端开放入口

前端先只展示已核算数据，并提供“重新核算”按钮。

这样即使存量数据不完整，也不会阻塞上线。

---

## 10. 测试点

建议至少覆盖以下测试：

1. 批次内 SKU 都有有效尺寸/重量时，可以正确生成总重量、总体积、总物流价
2. 缺少 SKU info 时，接口报错或返回明确异常状态
3. 修改物流单价后重新核算，批次头和快照表都会更新
4. 按重量分摊的 SKU 单件物流成本正确
5. 历史加权平均单价聚合正确
6. 删除批次时，对应快照随批次级联删除

---

## 11. 不建议的方案

### 方案一：只在前端临时算，不落库

问题：

- 历史口径不稳定
- 无法做历史均价
- SKU 信息变更后历史结果漂移

### 方案二：只在 `shipment_schedules` 存总价，不存 SKU 快照

问题：

- 无法解释每个 SKU 分摊结果
- 未来做 SKU 历史均价会变得很痛苦

### 方案三：直接把历史加权均价写回 `product_costs`

问题：

- 混淆“基础主数据”和“历史统计结果”
- 一旦批次重算，会触发主数据回写，副作用太大

---

## 12. 最小可用版本建议

如果希望先快速上线，建议 V1 只做：

1. `shipment_schedules` 增加：
   - `shipping_charge_mode`
   - `logistics_unit_price`
   - `total_weight_kg`
   - `total_volume_m3`
   - `logistics_total_price`
   - `item_unit_shipping_cost`
2. 新增 `shipment_cost_item_snapshots`
3. 只支持 `by_weight`
4. 页面新增 `发货费用` tab
5. 提供“重新核算”按钮

这样已经能满足你当前描述的主流程，并且后面扩展到按体积/固定总价时不会推翻 V1。

---

## 13. 最终建议

推荐采用：

- `shipment_schedules` 存批次费用汇总
- `shipment_cost_item_snapshots` 存 SKU 成本快照
- 通过显式“重算”动作，把 `SKU 信息` 的当前尺寸/重量固化到批次
- 历史加权平均单品物流单价通过快照表聚合得到

这是当前项目里改动最小、业务可解释性最好、后续也最容易扩展的一条路。
