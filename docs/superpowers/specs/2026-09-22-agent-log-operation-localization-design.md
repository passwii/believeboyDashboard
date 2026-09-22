# Agent 访问与写操作日志中文化设计

## 目标

完善 `/dashboard/system/agent-management` 页面两个日志面板的操作文案：

- 写操作日志按完整 `action` 集合显示细化中文名称；
- 访问日志按 HTTP 方法与 Agent API 路径显示具体读写业务动作，而不是只显示业务域名称；
- 原始 `action`、路径和业务域信息继续可追溯，不改变后端审计数据与接口契约。

## 当前问题

写操作面板通过 `operationActionLabel` 映射少量已知 action，已有货件、店铺测算、SKU、补货设置和凭据签发等文案，但随着平台巡检、客诉中心、凭据更新、SKU 删除和 Listing 文案批量写入等接口上线，存在未映射 action 会直接显示英文 code 的情况。

访问日志后端只保存 `method`、`path` 和 `operation_type`。前端当前将 `operation_type` 映射为业务域名称，因此同一业务域下的不同读接口都显示成同一个标签，例如货件列表、货件详情、货件审计无法区分。

## 方案与边界

采用前端统一注册表方案，不增加数据库字段、不改后端响应结构：

1. 新增一个 Agent 操作标签模块，集中维护写 action 标签与访问路径标签。
2. 写操作面板继续按 action 查标签。
3. 访问日志按 `method + path` 从更具体到更通用匹配标签；没有命中时回退到现有业务域中文名，业务域也未知时回退原始 code。
4. 访问日志仍展示原始路径；操作标签的 `title` 属性包含 method、path 和业务域，便于排查。
5. 对历史日志和未来未知接口保持非破坏性：未知数据不被隐藏，也不被笼统改成“其他”。

不在本次范围内：

- 修改后端审计日志模型、迁移或 API schema；
- 修改 Agent API 路由或 action 命名；
- 改造日志筛选参数或统计口径；
- 为历史数据库记录做回填。

## 标签覆盖范围

### 写操作

覆盖后端 Agent endpoint 中当前存在的 action：

- 货件：新建、更新、替换明细、状态变更、重算费用、删除；
- 店铺测算与新品测算：追加/保存、试算（访问日志路径标签）；
- SKU 主数据：新建、更新、上下架、删除、上传 FNSKU 标签、批量写 Listing 文案；
- 补货设置：保存补货设置；
- 平台巡检：保存、提交、上传截图、删除截图；
- 客诉中心：批量写入；
- Agent 凭据：签发、更新及兼容 action 别名；
- 报表上传：校验、提交等写接口路径动作。

### 访问日志读写路由

按现有 Agent 路由覆盖项目列表，以及以下业务域的聚合、详情、历史、审计、原始数据、模板、状态、台账和设置读取接口：

- 货件管理；
- 店铺测算、新品测算；
- SKU 主数据；
- 退货分析、补货分析、库存信息、库存台账；
- 平台巡检/店铺合规健康、客诉中心、报表上传状态；
- 销售数据；
- 广告分析下的预算、活动、目标、版位、推广商品、购买商品、搜索词、搜索词份额、无效流量和时间趋势。

匹配规则必须按具体路径优先，例如先匹配 `货件/{编号}/审计`，再匹配通用的 `货件/{编号}`；SKU 详情与 SKU 审计、补货设置与补货设置写入也遵循同样规则。

## 数据流与组件边界

```text
后端 agent_api_audit_log
  ├─ method + path + operation_type
  │    └─ accessOperationLabel() → 访问日志中文动作
  └─ operation_audit_logs.action
       └─ operationActionLabel() → 写操作中文动作

统一标签模块
  ├─ 写 action 标签表
  ├─ 访问 path 匹配表
  └─ 业务域回退标签
```

现有 `agent-operation-diff` 仍负责写操作 before/after 的字段和值语义化；操作标签从统一模块导入，避免访问日志组件和写操作组件各自维护重复映射。

## 测试设计

采用测试先行，先写失败测试再实现：

1. 标签纯函数单测：已知写 action 全量映射，未知 action 原样回退。
2. 访问路径纯函数单测：覆盖每个业务域至少一个列表、详情和特殊接口；覆盖具体路由优先级；覆盖未知路径回退业务域/原始 code。
3. 组件回归测试：访问日志表格显示细化读动作；写日志高频排行和记录表显示平台巡检、客诉中心等新增中文 action。
4. 前端验证按仓库顺序执行：`pnpm lint`、`pnpm build`、`pnpm test`。

## 验收标准

- 截图中的 `shop_calculation.append`、`platform_inspection.upload_screenshot`、`platform_inspection.save`、`platform_inspection.submit`、`complaint_center.batch_write`、`shipment.update`、`shipment.recalculate_costs`、`shipment.create` 均显示细化中文名称。
- 访问日志中同一业务域的不同读接口显示不同中文动作，至少能区分列表、详情、历史、审计、汇总/原始数据等语义。
- 未知 action/path 仍可看到原始标识。
- 不改变后端 API、数据库和日志统计数据。
- 新增与既有前端测试通过，lint/build/test 全部通过。
