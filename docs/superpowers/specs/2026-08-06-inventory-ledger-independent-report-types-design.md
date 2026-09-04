# 库存分类账 Summary / Detail 独立识别设计

**日期：** 2026-08-06

## 背景

Amazon 库存分类账只有两种业务报表：

1. 一览视图（Summary）
2. 详细视图（Detail）

它们拥有不同的 CSV 表头、业务语义和目标数据表，不存在第三种通用库存分类账报表。当前系统将上传类型统一识别为 `inventory_ledger`，并在 ingestion 阶段再次按表头判断目标表；同时前置 recognizer 只覆盖 Summary 签名，导致 Detail 文件可能因包含 `ASIN` 被错误识别为 `business_report`。

## 目标

将两种库存分类账报表定义为两个互斥、独立的上传类型：

| Amazon 报表 | `report_type` | 中文名称 | 目标表 |
|---|---|---|---|
| Summary / 一览视图 | `inventory_ledger_summary` | 库存分类账 · 汇总视图（Summary） | `inventory_ledger_summary` |
| Detail / 详细视图 | `inventory_ledger_detail` | 库存分类账 · 明细视图（Detail） | `inventory_ledger_detail` |

系统不再产生新的 `inventory_ledger` 识别结果。兼容旧调用是否保留旧值，只能作为受控过渡输入，不能作为页面可选择或新识别输出的第三种报表类型。

## 真实文件签名

### Summary

真实文件 `库存分类账 2026-03一览视图.csv` 包含 22 列。标准化后以以下字段作为完整必需签名：

```text
date
msku
disposition
location
starting_warehouse_balance
ending_warehouse_balance
```

其中以下两列是 Summary 的强特征：

```text
starting_warehouse_balance
ending_warehouse_balance
```

### Detail

真实文件 `库存分类账-2026-03详细视图.csv` 包含 16 列。标准化后以以下字段作为完整必需签名：

```text
date
msku
event_type
quantity
fulfillment_center
disposition
```

其中以下三列是 Detail 的强特征：

```text
event_type
quantity
fulfillment_center
```

## 识别规则

库存分类账识别必须先于 `business_report`，避免 Detail 因包含 `asin` 被业务报告规则抢占。

识别矩阵：

| Summary 完整签名 | Detail 完整签名 | 结果 |
|---|---|---|
| 是 | 否 | `inventory_ledger_summary` |
| 否 | 是 | `inventory_ledger_detail` |
| 是 | 是 | 拒绝：库存分类账格式冲突 |
| 否 | 否 | 进入部分签名检查 |

部分签名检查：

- 出现任一 Summary 强特征但缺少 Summary 必需字段：拒绝为“库存分类账 Summary 格式不完整”，列出缺失字段。
- 出现任一 Detail 强特征但缺少 Detail 必需字段：拒绝为“库存分类账 Detail 格式不完整”，列出缺失字段。
- 同时出现两类强特征但都不完整：拒绝为“库存分类账格式冲突”。
- 完全没有库存分类账强特征：继续识别其他报表。

不得将部分匹配或冲突文件降级为 `business_report`。

## API 和 Schema

报表类型联合类型、支持列表及校验集合新增：

```text
inventory_ledger_summary
inventory_ledger_detail
```

新识别响应分别返回以上两个值，不再返回 `inventory_ledger`。

提交接口必须接受识别结果中的独立类型，并在入库时验证声明类型与 CSV 表头一致。

## 入库路由

业务路由必须显式独立：

```text
inventory_ledger_summary -> Summary parser -> inventory_ledger_summary
inventory_ledger_detail  -> Detail parser  -> inventory_ledger_detail
```

底层可以共享编码检测、日期解析、批次写入和 COPY 辅助函数，但不得在收到明确类型后重新猜测目标视图。

入库层需要进行防御性验证：

- 声明 Summary 但表头是 Detail：拒绝。
- 声明 Detail 但表头是 Summary：拒绝。
- 表头不完整或同时命中两种类型：拒绝。

两种文件均可继续写入共享的 `inventory_ledger_ingest_batch` 批次表；该表是 ingestion 元数据，不是第三种业务报表类型。

## RPA 自动上传

`autoReportUpload` 识别结果也必须返回两个独立类型，并添加两个独立 persistence 分支。两个分支复用后端库存分类账 ingestion service，分别只允许写入对应目标表。

不得让库存分类账类型落入通用 `_persist_single_source` 路径。

## 页面展示

上传队列、识别结果、成功反馈和批次状态使用中文主标签并保留英文对照：

```text
库存分类账 · 汇总视图（Summary）
库存分类账 · 明细视图（Detail）
```

内部值可作为辅助信息显示：

```text
inventory_ledger_summary
inventory_ledger_detail
```

不向运营用户展示 `ingest_ledger_*` 作为报表类型；`ingest` 代表程序处理动作，不代表 Amazon 报表。

成功反馈应至少包含：

- 独立报表类型
- 报表月份
- 写入行数
- 重复文件时的跳过状态

## 兼容性

旧的 `inventory_ledger` 不能继续作为新识别输出或页面第三选项。

若线上已有客户端会提交旧值，可采用一次受控兼容：后端仅在提交阶段读取表头并映射到两个新类型，同时记录弃用告警；新前端和 RPA 必须只发送新值。兼容层应有测试，并在调用方全部升级后删除。

历史数据库表和批次记录不因本次识别类型拆分而迁移；目标业务表本身已经是独立的 Summary 和 Detail 表。

## 错误处理

错误信息必须面向用户并可操作：

- `无法识别库存分类账 Summary：缺少 Ending Warehouse Balance`
- `无法识别库存分类账 Detail：缺少 Fulfillment Center`
- `库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段`
- `报表类型与文件内容不一致：声明为 Detail，实际检测为 Summary`

不得用裸 500 或静默回退代替结构化 4xx 错误。

## 测试要求

识别层至少覆盖：

1. 真实 Summary 表头识别为 `inventory_ledger_summary`。
2. 真实 Detail 表头识别为 `inventory_ledger_detail`。
3. Detail 不得落入 `business_report`。
4. 中文文件名不影响识别。
5. 两套签名同时存在时拒绝。
6. Summary 部分签名时返回缺失字段。
7. Detail 部分签名时返回缺失字段。

提交与入库至少覆盖：

1. Summary 只写 Summary 表。
2. Detail 只写 Detail 表。
3. 声明类型与表头不一致时拒绝。
4. 两种文件同月上传时分别生成正确批次和行数。
5. 重复文件保持幂等。
6. RPA 两种类型均走专用库存分类账路径。

前端至少覆盖：

1. 两种识别结果展示正确中文与英文对照。
2. 不再显示模糊的 `inventory_ledger`。
3. 识别失败、格式冲突和成功入库反馈正确。

## 不在本次范围

- 新增第三种库存分类账报表。
- 合并 Summary 与 Detail 两张业务数据表。
- 删除历史 `inventory_ledger_raw` 表。
- 重构库存分类账查询页面或统计口径。
