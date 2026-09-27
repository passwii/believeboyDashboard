# Agent API 文件型资源二进制响应规范

日期：2026-09-28
状态：已实施

## 背景

Agent API 的文件型资源应由调用方直接保存和处理。JSON + Base64 会扩大响应体，并把文件字节带入 Agent 的文本上下文。货件 FBA 模板已调整为 XLSX 二进制响应；需要把响应规则写入 Agent API 设计文档，并为后续文件接口提供统一实现。

只读审计发现：当前 Agent 命名空间中，`GET /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/fba-delivery-template` 是唯一直接交付文件的成功响应。`platform-inspection/template` 是 JSON 输入 schema；巡检截图和 FNSKU PDF 是 multipart 上传输入；SKU 图片/PDF URL 是业务元数据。它们不是文件下载响应。

全局 API 中 `POST /api/v1/order-info/export` 仍返回 Base64 CSV，前端明确依赖该 JSON 结构。本次仅规定并统一 Agent API 文件交付，不变更这个非 Agent 接口。

## 设计

### 文件成功响应

- 成功时返回文件原始字节，HTTP body 不包 JSON，不编码为 Base64 或 data URL。
- 通过正确的 `Content-Type` 声明格式；通过 `Content-Disposition: attachment` 提供文件名，非 ASCII 文件名使用 RFC 5987 `filename*` 编码。
- 小型内存文件可以直接返回字节响应；较大或惰性生成的文件使用流式响应。两种方式的成功 body 都是文件二进制。
- OpenAPI 对成功响应声明实际文件媒体类型，不声明 JSON 文件载荷。
- 鉴权、校验、限流、资源不存在和内部错误继续使用现有 Agent JSON 错误契约。

### 统一实现

新增 Agent 文件响应 helper，负责生成 RFC 5987 文件名头、设置媒体类型和可用的 `Content-Length`，以 `StreamingResponse` 返回原始 bytes。FBA 模板路由迁移到 helper，移除路由模块内的重复头部实现。

### 验收测试

- helper 测试验证原始 body、文件媒体类型、文件名编码和 Content-Length。
- Agent FBA 路由测试验证 XLSX 的 ZIP 魔数和工作簿可读性，成功响应不是 JSON；鉴权、资源不存在等错误仍为 Agent JSON。
- 规范写入 `docs/agent-api-design.md`；本地 Agent skill 索引同步路由数，并注明规范位置。

## 边界

- 不改变上传接口的 multipart 请求格式和 JSON 元数据响应。
- 不把 URL、缩略图地址、模板 schema 等 JSON 元数据改成二进制。
- 不迁移非 Agent 的订单导出接口。
- 不新增数据库字段或迁移。

## 审核

- 用户已确认采用“文档规范 + 通用响应 helper + FBA 复用 + 契约测试”的实施方案。
- 自审：范围只覆盖 Agent 文件交付路径；错误响应继续使用标准 Agent JSON；现存上传和元数据语义保持原样。
- 实施完成：新增通用 helper，FBA 路由和 OpenAPI 已复用二进制契约；无其他 Agent 文件下载路由需要迁移。
