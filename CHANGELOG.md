# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **数据库备份端到端链路 + R2 异步上传**（plan [`2026-07-17-pg-r2-backup-feature`](docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature.md)）：手动触发 → API 5ms 异步入队 → `backups` 队列 worker（`-c 1`）跑 pgBackRest → 打 tar.gz → 上传 Cloudflare R2（幂等 via `check_file_exists`）→ phase 全程 `pending→pgbackrest_running→compressing→r2_uploading→completed` → 落 `r2_key/r2_url/r2_uploaded_at/compressed_size_bytes` 等字段
  - **详情端点**：`POST /api/v1/backups/trigger`、`GET /api/v1/backups/{id}`、`GET /api/v1/backups/{id}/download-url`（presigned，1h）、`GET /api/v1/backups/{id}/restore-command`（预览不执行）、`DELETE /api/v1/backups/{id}`（软删 + 删 R2）、`POST /api/v1/backups/cleanup`
  - **模型**：新增 `phase / triggered_by / retry_count / r2_key / r2_url / r2_bucket / r2_uploaded_at / r2_deleted_at / compressed_size_bytes / backup_set_name / backup_set_path` + 部分索引
  - **调度**：Celery Beat 每日 03:00 全量 + 04:30 R2 保留清理（默认留 7 份，与本地 `retention-full=7` 对齐）
  - **前端**：3s 条件轮询 + phase 进度条 + 行展开（R2 元信息 + 下载 / 恢复命令 / 软删三按钮）
  - **部署**：`believeboy-worker-backups.service`（独立单元 + 单并发）+ 运维手册（`backend/docs/multi-worker-ops.md`）补充 Beat 单实例约束
  - **配置**：`BACKUP_VIA_CELERY` 异步开关（默认 true，回滚 false 走旧同步路径）、`BACKUP_SOFT_TIME_LIMIT`（90min）、`BACKUP_HARD_TIME_LIMIT`（120min）、`R2_BACKUP_RETENTION_COUNT`（7）、`BACKUP_DAILY_SCHEDULE_HOUR`（3）
  - **测试**：29 个备份相关测试全绿，零回归（与 base 失败清单逐条 diff 验证）
  - **实现评审**：[`implementation-review.md`](docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-implementation-review.md) 记录与 frozen 方案的 8 处偏差 + 3 项未完成项
  - **分支**：`feat/pg-r2-backup`（19 个 commit，未动 main）

- **Motion design system v1** — Apple 级动效设计系统（spring 物理、玻璃/聚光、加权按下、统一页面过渡）
  - **Token 层**：CSS (`frontend/app/globals.css :root`) + JS (`frontend/lib/motion/tokens.ts`) 双侧定义，约 100 行新 token + utility 规则
  - **Primitive 层**：`PageTransition` / `MotionFade` / `MotionStagger` / `MotionStaggerItem` / `useSpotlight`
  - **Variant 层**：`page` / `fadeUp` / `stagger` / `press` 四组 framer-motion variants
  - **Utility 层**：`.u-interactive` / `.u-press` / `.u-focus` / `.u-stagger-item` 规范 utility
  - **组件层**：`<DashboardSurfaceCard>` 可选 spotlight 包装
  - **完整覆盖**：sidebar hover / 页面切换 / 各类显示反馈 / Radix popover/dialog/sheet/tooltip / 表单元素 / Skeleton/Loading
  - **质量门**：Vitest 21 files / 154 tests / Playwright 10 specs（性能断言 + @axe-core a11y 扫描 + reduced-motion/transparency 退化）
  - **CI**：`motion-system-ci.yml` workflow 独立 job

详见 [动效系统开发者指南](frontend/docs/motion-system.md)。

### Changed

- **定时报告销售口径含税化（BLF-475）**：`analysis_sales_order_rows` 新增 `item_tax` / `shipping_tax` 列（迁移 241，含 `raw_row` 存量回填）；解析器开始读取订单报表的 `item-tax` / `shipping-tax`；日/周/月定时报告销售额聚合改为 DE/UK 含税（净额 + VAT）、其余站点保持净额，与财务月报口径对齐
- **daily-analysis 页 SKU 明细 Tab 按 is_active 过滤（BLF-917）**：SKU 明细 Tab 此前只显示 sales/ad/inventory 聚合行，未按 SKU info 的 `is_active` 过滤，导致历史 SKU 混入明细污染数据
  - **前端**：`daily-analysis-client.tsx` 在 `loadProjectSkus` 调用 `/api/v1/sku-info` 时新增 `is_active=true` 查询参数（API 已支持），并用 `skuOptions` 派生 `activeSkuMap` 在 `detailRows` / `comparisonDetailRows` 出口统一过滤；`ProjectSkuOption` 类型补 `is_active: boolean`
  - **过滤行为**：SKU 详情下拉与表格 / 对比图 / Excel 导出一致只展示激活 SKU；未加载 SKU 列表前不强行过滤（首屏空白保护）
- `components/ui/dropdown-menu.tsx` / `tabs.tsx` / `combobox.tsx` / `calendar.tsx` / `popover.tsx` / `dialog.tsx` / `sheet.tsx` / `tooltip.tsx` / `toggle.tsx` / `checkbox.tsx` / `switch.tsx` — 接入 motion token
- `components/ui/button.tsx` — 接入 `u-press / u-focus / u-interactive`
- `components/ui/skeleton.tsx` — Skeleton/Loading 入场过渡优化
- `components/dashboard/sidebar-panel.tsx` / `sidebar-icon-rail.tsx` — Sidebar active 指示 spring + nav item hover 规范
- `components/notifications/notification-toast.tsx` — toast duration / 缓动统一引用 token
- `components/customer-service/...` — ai-chat 自定义动效 token 化
- `frontend/app/globals.css` — 新增 ~100 行 motion/z-index/spotlight token + utility + reduced 守卫
- CI：新增 `.github/workflows/motion-system-ci.yml`

### Removed

- **0 引用冗余 token 清理**（v2 token 调研建议）：
  - 5 个 `--z-*` CSS token
  - `EASE.springBack` 常量
  - `SPRING.press` 常量
  - `Z` 对象

[Unreleased]: https://github.com/passwii/believeboyDashboard/compare/main...feat/frontend-motion-system
