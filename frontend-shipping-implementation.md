## 交付范围
负责 BLF-1284 发货规划的前端实现，对应父计划 Task 5–6。后端由 BLF-1286 接手；在 API 契约及可用测试环境未交付前，本地 mock 只用于页面开发/组件测试，不应把字段契约假设成冻结接口。

## 依赖与接口
基路径 `/api/backend/api/v1/shipping-plan`。遵循父 issue 内的端点表：GET `/skus`、GET `/forecast?sku=...`、PUT `/skus/{sku:path}/growth-factor`、GET `/shipment-history`、GET/POST `/batches`、PATCH `/batches/{id}`、POST `/batches/{id}/cancel`、POST `/batches/{id}/allocations`、DELETE `/allocations/{id}`。等 BLF-1286 的 request/response JSON 和错误码评论后，逐字段核对前端类型、参数及响应；若 API 不提供某个 UI 功能，先与父 issue owner 确认，不要发出未约定的候选端点请求。

## 本轮已完成的 UI 部分
- 新增 `/dashboard/operations/shipping-plan` 页面骨架：单项目/单站点约束、SKU 预测表、预测曲线、参数和倍率编辑、历史 ETD 概览、计划批次多 SKU 创建/编辑/取消、正式货件部分数量关联/解除。
- 导航新入口紧邻旧正式货件页之前；旧路由/API/Agent 技术标识保留，只统一用户可见名称“货件管理（Shipment Management）”。新页面登记为全局筛选试点，增加桌面与移动筛选测试。
- 更新库存补货说明、REFERENCE 链接和原外部计划文档；迁移 head 勘误（旧编号 278 过时，已观察 origin/main head 279）、预测日期区间、allocation 重复 POST 冲突和 V1 仅取消等边界已写入。

## 下一步前端检查
1. 收到后端契约后替换临时数据假设：尤其 `forecast`、SKU table、batch edit 的完整 schema，allocation route/候选 schedule 获取来源、错误响应和货件状态字段。
2. 将候选货件列举路径改为后端正式提供的 API（不要假定 `/batches/allocations/candidates`，当前仅为前端占位，父计划并未把该路径列为冻结端点）。
3. 增加 forecast 月度桶、未知销量断点、增长倍率失败保留输入、allocation 超限、重复提交、删除/取消余额等 UI 契约测试。
4. 接上后端本地 BLF_test API，按实际 request/response 完成请求冒烟与写操作往返；当前无 backend/.env(.test) 和服务/凭据，浏览器 Playwright 尚未连通真实 API。
5. 全局前端 T3 与 lint/build/Playwright 结果写入父 issue 最终交付。

## 已验证
- `cd frontend && pnpm test`：最近完整运行 240 files / 1722 passed / 0 failed。
- `cd frontend && pnpm lint`：0 errors / 27 warnings（现有 repository warnings）。
- `cd frontend && pnpm build`：exit 0，Next route table 包含 `/dashboard/operations/shipping-plan`。
- 定向 Vitest 26 passed；Playwright desktop + mobile viewport 均 pass（使用仓库本地测试 fixture session；数据 API 因 backend 未运行显示单站点提示/错误时页面仍可呈现且不溢出）。
- 当前 TypeScript `tsc --noEmit` 不是独立绿灯：除修复的新页面类型外，剩余错误分布在仓库其他现有测试文件（如 platform-inspection、CRM、order-info 等）；`pnpm build` 的正式类型检查通过。
- 无法宣称端到端 API 集成通过；当前真实后端联调被缺少本地测试服务与凭据阻塞。