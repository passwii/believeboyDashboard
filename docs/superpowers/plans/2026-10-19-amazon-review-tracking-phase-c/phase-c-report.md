# Amazon 评论追踪阶段 C 实施报告（前端）

> 关联 issue：BLF-1377 · 计划：[`2026-10-19-amazon-review-tracking-phase-c.md`](./2026-10-19-amazon-review-tracking-phase-c.md)
> 状态：前端实施完成，已提 PR 待 Tia 把关合并（**未**自行 merge）

## 交付内容

### 1. API 层

- `frontend/lib/review-tracking-api.ts`：目标 / 快照 / 评论 / 运行 / 外部竞品 / 共享组的客户端与 DTO→页面模型映射。
  集中收敛四类口径：
  - 缺失值一律 `null` → 渲染 `—`，**不会**落成 0（`average_rating` / `rating_count` / `review_count` / 星占比 / 星数）；
  - 星数三档：`exact` 数字、`estimated` 前加 `≈`、`unavailable` 不展示数量；
  - 状态文案：`capture_status` / `visibility_status` / `id_confidence` / 运行 `status`，未知枚举有兜底；
  - 错误分流：401 / 403 / 404 各自文案（403 = 需要运营或管理员；404 = 目标不存在或无权访问，不泄露存在性）。
- `frontend/lib/review-tracking-shops.ts`：外部关联店铺选项。后端只有 `GET /projects/{id}/shops`，因此按
  `projects/manage` 的可见项目聚合，结果 2min 缓存；单个项目失败不影响其它项目可选。

### 2. 页面 `/dashboard/operations/review-tracking`

- 目标选择区：内部共享组 / 外部竞品分组展示，按项目、站点、目标状态（仅启用 / 仅停用 / 全部）筛选。
- 评分趋势：平均分 / 评分数 / 评论数 / 采集状态指标行 + 平均分折线；缺采日期折线断开（`connectNulls=false`），
  不画成 0；hover 明细含当天 1–5 星占比与数量口径、采集状态与「缺失项不按 0 计」说明。
- 评论明细：星级 / 标题 / 正文 / 日期 / Verified（三态：是 / 否 / 未知）/ helpful；按 `visibility_status` 筛选 +
  分页（接口无 total，用「返回行数 == limit」判定还有下一页，只显示「第 N 页」）。
- 采集健康度：最近运行记录（状态、是否完整列表、评论数、是否取到评分、抓取 ASIN、错误信息）。
- 外部竞品：登记 ASIN（站点 + ASIN + 展示名，可选直接关联店铺）、关联 / 移除店铺。
  移除是软删，UI 明确写「历史保留、重新关联会复活原记录并沿用历史」。
- 空态：无目标 / 无快照 / 无评论 / 无运行 / 无外部竞品各自有明确文案，统一指向「等待采集端接入」。

### 3. 侧栏与标题

- `lib/sidebar-config.ts`：operations 组新增「评论追踪」（Star 图标）。
- `lib/dashboard-route-meta.ts`：新增「评论追踪」页面标题，并在既有测试补断言。

### 4. SKU 信息页补齐阶段 A 遗留

- `ProductCostItem` 增加 `father_id`；成本 / 尺寸 tab 的 SKU 单元展示「父体」，行内编辑可改；
  保存 PATCH 带 `father_id`，空串显式提交 `null`（后端 `model_fields_set` 语义：显式 null 才清空）。
- 新增 `components/dashboard/sku-info/review-group-sheet.tsx`：内部评论共享组维护
  （列表、建组、改成员、换代表 ASIN、停用）。入口在成本 tab 操作列，**仅管理员可见**。
  约束按后端语义前置校验：成员非空、代表必须是成员、`PATCH` 不提交 null 成员/代表、停用走独立接口。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit`（项目全量） | 通过；新增/改动文件 0 错误 |
| `pnpm lint` | **0 errors**，27 warnings（均为既有基线，新增文件 0 warning） |
| `pnpm check:mocks` | 扫描 263 个测试文件，0 命中 ✅ |
| `pnpm check:motion` | 硬门禁全部通过（3 CSS / 1071 TS / 1074 消费文件） |
| `pnpm gen:api-types:check` | 通过（类型与 `openapi.json` 同步） |
| 前端全量 `pnpm test` | **263 文件 / 1988 例全绿**（含 `check-motion-tokens` / `check-unstable-mocks` 两道机械门禁） |

新增测试（共 53 例）：

- `lib/review-tracking-api.test.ts`（22）：空值不渲染 0、星数三档、状态文案与未知兜底、错误分流、分页判定、查询串、403 抛错。
- `review-tracking-client.test.tsx`（7）：无目标空态、无快照空态、有快照渲染、403 权限墙不重试、404 走通用错误、目标分组、切换目标重新拉取。
- `components/rating-trend-panel.test.tsx`（4）：指标区、缺失渲染 `—` 且无 `0`、部分成功文案、口径说明常驻。
- `components/external-targets-panel.test.tsx`（10）：管理员门禁、登记载荷（ASIN 大写）、关联、软删文案、已移除关联不算有效、空态。
- `components/dashboard/sku-info/review-group-sheet.test.tsx`（10）：按项目+站点拉取、建组载荷、编辑 PATCH 载荷、停用二次确认与取消、409/403 文案。
- `sku-info/page.test.tsx`（+4）：父体展示、PATCH 带 `father_id`（空串 → null）、管理员可见共享组入口、非管理员隐藏。

## 手动验证步骤（建议 Tia / 业务验收）

生产当前 targets / snapshots / reviews / runs 全为 0 行（阶段 D 未上线），以下步骤在本地造样本后进行：

1. **空态**：直接打开 `/dashboard/operations/review-tracking` → 左侧「还没有追踪目标…等待采集端接入」；四个 tab 各自空态可读。
2. **非运营 403**：用 businessdev 账号访问 → 页面显示「没有访问权限：评论追踪仅对运营与管理员开放」，无数据区、无重试。
3. **不可见目标 404**：用运营账号访问同事项目的目标 URL/选中后拉详情 → 弹一次 toast「目标不存在或无权访问」，不暴露目标存在性；刷新后列表回落到空态（注意：这是一次性提示，不是常驻页态）。
4. **外部关联软删复活**：管理员登记 `US + B0TEST0001` → 关联店铺 A → 移除关联（历史仍在）→ 再次关联同一店铺 →
   仍只有一条追踪数据与一份历史，UI 提示「复活原记录并沿用历史」。
5. **SKU 父体与共享组**：SKU 信息页 → 成本 tab → 编辑某行填父体保存 → 重新查询可见；管理员点「评论共享组」→ 建组（默认选中当前 SKU 为代表）→ 改成员 / 换代表 → 停用后成员可加入其它组；非管理员看不到该入口。

## 已知限制

- `GET /groups` 仅管理员可用，运营账号拿不到组名，内部目标靠 `display_name`（后端写入组名）展示；组维护入口只在 SKU 页管理员可见。
- 外部关联店铺选择器依赖按项目聚合（后端无「全站店铺」接口），首次打开会有 N 个项目请求，结果缓存 2min。
- 评论接口无 total，分页只能「上一页 / 下一页」，不显示总页数。
