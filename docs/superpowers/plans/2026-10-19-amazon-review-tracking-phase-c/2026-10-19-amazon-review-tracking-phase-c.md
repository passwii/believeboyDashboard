# Amazon 评论追踪阶段 C 实施计划（前端运营页 + SKU 维护 UI）

> 关联 issue：BLF-1377（阶段 C）
> 设计来源：[`../../specs/2026-10-12-amazon-review-tracking-design.md`](../../specs/2026-10-12-amazon-review-tracking-design.md) §8.1–§8.5
> 前置阶段：[阶段 A 计划](../2026-10-12-amazon-review-tracking/2026-10-12-amazon-review-tracking-phase-a.md) · [阶段 B 计划](../2026-10-12-amazon-review-tracking/2026-10-16-amazon-review-tracking-phase-b.md)
> 状态：🚧 前端实施完成，已提 PR 待把关合并（见 [`phase-c-report.md`](./phase-c-report.md)）

**目标：** 让运营在 Dashboard 里看到并维护评论追踪数据——新增「评论追踪」运营页（目标选择、评分趋势、评论明细、采集健康度、外部竞品管理），并在 SKU 信息页补齐阶段 A 遗留的 Father ID 编辑与内部评论共享组维护能力。

**范围：** 只改 `frontend/`。不改 `backend/` 的 API、数据层、迁移。后端契约已在 main（`/api/v1/amazon-review-tracking/*`，见 PR #732）。

**技术栈：** Next.js App Router（client components）、React 19、Tailwind + term 设计令牌、recharts、Vitest + Testing Library。

---

## 一、可直接消费的后端契约（已核实）

| 能力 | 方法与路径 | 鉴权 | 前端映射注意 |
| --- | --- | --- | --- |
| 共享组列表 | `GET /api/v1/amazon-review-tracking/groups?project_id&marketplace&is_active` | **管理员** | 成员/代表都是 `product_costs.id` |
| 建组 / 改组 / 停用 | `POST /groups`、`PATCH /groups/{id}`、`POST /groups/{id}/deactivate` | **管理员** | PATCH 不允许 `name/member_ids/representative_id` 传 null（422） |
| 目标列表 | `GET /targets?project_id&marketplace&kind&is_active&limit&offset` | 运营/管理员 + 项目可见性 | 运营账号只能看到可见项目下的内部目标 + 全部外部目标 |
| 评分快照 | `GET /targets/{id}/rating-snapshots?from&to&limit&offset` | 同上 | `capture_date` 唯一；同日重试是更新 |
| 评论明细 | `GET /targets/{id}/reviews?visibility_status&review_date_from&review_date_to&limit&offset` | 同上 | 响应无 total，按「返回行数 == limit」判断还有下一页 |
| 采集运行 | `GET /targets/{id}/runs?limit&offset` | 同上 | 按 `started_at desc` 排序 |
| 外部竞品 | `GET /external-targets`、`POST /external-targets` | 读=运营/管理员；写=管理员 | 外部目标无 project，对所有运营可见 |
| 外部关联 | `POST /targets/{id}/external-links`、`DELETE /targets/{id}/external-links/{link_id}` | **管理员** | 软删，重新关联复活原记录并沿用历史 |

权限语义（前端必须如实呈现，不做假绿）：

- 非运营/管理员 → 403；页面显示「需要运营或管理员权限」，不重试。
- 不可见项目的内部目标 → 404（不泄露存在性）；目标详情/快照/评论/运行统一按 404 展示「目标不存在或无权访问」。
- 写操作仅管理员：非管理员隐藏/禁用写入口，并保留只读视图。

枚举取值（后端已校验，前端需具备兜底文案）：

- `capture_status` ∈ `success` / `partial` / `failed`
- `star_count_quality` ∈ `exact` / `estimated` / `unavailable`
- `visibility_status` ∈ `visible` / `suspected_removed`
- `id_confidence` ∈ `original` / `derived`
- 运行 `status` ∈ `success` / `partial` / `failed`

---

## 二、空数据现状（直接影响验收）

生产快照里 targets / groups / snapshots / reviews / crawl_runs **全部 0 行**（阶段 D 未上线，没有东西写进来）。因此：

- 每个区块都必须有明确空态（「等待采集端接入」），不能靠假数据撑版面。
- 页面不能假设「有数据才渲染」——空数组、`null` 指标、无目标都要能正常呈现。
- 需要真实数据做视觉验收时，在本地 `BLF` / `BLF_test` 造样本，不写生产。

---

## 三、文件结构与职责

### 新增（API 层）

- `frontend/lib/review-tracking-api.ts`：评论追踪域 API 客户端 + DTO→页面模型映射（目标、快照、评论、运行、外部竞品/关联、共享组）。集中处理：
  - `capture_status` / `star_count_quality` / `visibility_status` / `id_confidence` 的中文文案与色档；
  - 「本次没取到」一律 `null`，渲染成 `—` / 「未取到」，**不能渲染成 0**；
  - `estimated` 星数加 `≈` 前缀，`unavailable` 不显示数量；
  - 错误状态分流（401/403/404 各自的提示文案）。
- `frontend/lib/review-tracking-api.test.ts`：映射层单测（空值/估算/状态文案/错误分流/分页判定）。

### 新增（页面）

- `frontend/app/dashboard/operations/review-tracking/page.tsx`：server 入口（metadata + 渲染 client）。
- `frontend/app/dashboard/operations/review-tracking/loading.tsx`：骨架屏。
- `frontend/app/dashboard/operations/review-tracking/review-tracking-client.tsx`：页面状态编排（筛选、目标选择、各区块数据拉取、tab 切换、刷新回调）。
- `frontend/app/dashboard/operations/review-tracking/components/target-selector.tsx`：目标列表 + 项目/站点/状态筛选（内部组目标 / 外部 ASIN 目标分组展示）。
- `frontend/app/dashboard/operations/review-tracking/components/rating-trend-panel.tsx`：评分趋势（平均分 / 评分数 / 评论数 / 1–5 星分布）+ 自定义 hover tooltip（当天明细、采集状态、星数口径）。
- `frontend/app/dashboard/operations/review-tracking/components/reviews-table.tsx`：评论明细表（星级/标题/正文/日期/Verified/helpful），`visibility_status` 筛选 + 分页。
- `frontend/app/dashboard/operations/review-tracking/components/crawl-health-panel.tsx`：采集健康度（最近运行、`is_complete_list`、`reviews_seen`、`error_message`）。
- `frontend/app/dashboard/operations/review-tracking/components/external-targets-panel.tsx`：外部竞品登记 + 店铺关联/移除（软删、复活）。
- `frontend/app/dashboard/operations/review-tracking/components/star-distribution.tsx`：1–5 星占比条（百分比 / 估算数量 / 未取到）。

### 新增（SKU 信息页维护能力）

- `frontend/components/dashboard/sku-info/review-group-sheet.tsx`：内部评论共享组维护 Sheet（列表、建组、改成员、换代表 ASIN、停用），仅管理员可写。

### 修改

- `frontend/lib/sidebar-config.ts`：`operations` 组加入「评论追踪」入口。
- `frontend/lib/dashboard-route-meta.ts` + `.test.ts`：加页面标题并补断言。
- `frontend/app/dashboard/operations/sku-info/page.tsx`：
  - `ProductCostItem` 增加 `father_id`；
  - 行内编辑增加 Father ID 输入，`saveRow` 的 PATCH 带上 `father_id`（空串 → `null` 清除）；
  - 展示区增加「父体」一行；
  - 操作列增加管理员可见的「评论共享组」按钮，打开 `ReviewGroupSheet`。
- `frontend/app/dashboard/operations/sku-info/page.test.tsx`：补 Father ID 编辑载荷断言与共享组入口权限断言。

### 测试

- `frontend/lib/review-tracking-api.test.ts`
- `frontend/app/dashboard/operations/review-tracking/review-tracking-client.test.tsx`（空态 / 403 / 404 / 目标切换）
- `frontend/app/dashboard/operations/review-tracking/components/rating-trend-panel.test.tsx`（空值不渲染 0、estimated `≈`、tooltip 状态文案）
- `frontend/app/dashboard/operations/review-tracking/components/external-targets-panel.test.tsx`（登记 → 关联 → 移除 → 复活）
- `frontend/components/dashboard/sku-info/review-group-sheet.test.tsx`（建组/改成员/停用调用与管理员门禁）

---

## 四、页面结构

```text
/dashboard/operations/review-tracking
├─ Header（Top Header 插槽）：项目选择 · 站点选择 · 目标状态下拉 · 刷新
├─ 左栏 目标列表（内部共享组 / 外部 ASIN，选中态）
├─ 右栏（Tabs，term 变体）
│   ├─ 评分趋势：StatCard 行（平均分 / 评分数 / 评论数 / 最近采集）
│   │   ├─ recharts 折线（平均分）+ 面积（评分数）
│   │   └─ hover 明细：当天各星占比、星数（带 ≈ / — 口径）、capture_status
│   ├─ 评论明细：visibility 筛选 + 分页表
│   ├─ 采集健康度：运行记录表 + 状态色档
│   └─ 外部竞品：登记表单 + 目标卡片（链接列表 + 关联/移除店铺）
└─ 空态：无目标 / 无快照 / 无评论 / 无运行 / 无外部竞品
```

移动端沿用 `MobileFilterStrip`（与 complaint-center 同模式）。

---

## 五、关键口径（页面必须讲清）

1. **「没取到」不是 0**：`average_rating` / `rating_count` / `review_count` / 星占比 / 星数任一为 `null` 时渲染 `—` 或「未取到」，禁止 `?? 0`。
2. **评分数 ≠ 评论数**：`rating_count` 是页面 global ratings，`review_count` 是有正文的评论数，两列分开展示，不互相兜底。
3. **星数口径三档**：`exact` 直接显示数量；`estimated` 显示 `≈N` 并在 tooltip 标注「按页面百分比估算」；`unavailable` 只显示百分比不显示数量。
4. **采集状态**：`success`（成功）/ `partial`（部分成功：部分字段未取到）/ `failed`（失败）。失败/部分成功当天不得把缺失字段渲染成 0，且趋势图该点需要有可辨识样式（断点/空心点）+ tooltip 说明。
5. **同日唯一**：`capture_date` 唯一，同日重试是更新当天快照；页面按日期升序展示，不做同日多值。
6. **评论可见性**：`visible`（可见）/ `suspected_removed`（疑似移除）。标记为疑似移除只代表「连续 2 次完整抓取未出现」，不等于已删除。
7. **ID 可信度**：`original`（来源提供）/ `derived`（内部指纹推导，可能因编辑被判为新评论）——明细表用弱提示标注 `derived`。
8. **外部关联是软删**：移除后重新关联同一店铺会复活原记录并沿用历史，UI 文案要说明，不能提示「已删除历史」。

---

## 六、测试清单

| 层级 | 用例 | 断言重点 |
| --- | --- | --- |
| 映射层（Vitest） | 快照空值 | `null` → `—`，不出现 `0`；`estimated` → `≈N`；`unavailable` → 不显示数量 |
| 映射层 | 状态文案 | `capture_status` / `visibility_status` / `id_confidence` / `run.status` 全枚举 + 未知值兜底 |
| 映射层 | 错误分流 | 401 / 403 / 404 各自文案，不与 500 混 |
| 映射层 | 分页判定 | reviews 返回行数 == limit → `hasMore=true` |
| 页面 | 空态 | targets 为空 → 「等待采集端接入」；选中目标无快照/评论/运行 → 各区块空态 |
| 页面 | 403 | 非运营账号 → 权限提示，不重试、不渲染数据区 |
| 页面 | 404 | 不可见目标 → 「目标不存在或无权访问」 |
| 组件 | 趋势 tooltip | 缺失字段 / `partial` / `estimated` 文案正确 |
| 组件 | 外部竞品 | 登记 → 关联 → 移除（软删）→ 重新关联复活 |
| 组件 | 共享组 Sheet | 建组/改成员/换代表/停用调用载荷正确；非管理员不可写 |
| 页面 | SKU Father ID | 行内编辑保存时 PATCH 带 `father_id`，空串 → `null` |

mock 纪律：涉及 `useSession` / `useNotifications` 的用例必须用 `frontend/test-utils/stable-mocks.ts` 的 `stableSession()` / `stableNotifications()`，`pnpm check:mocks` 不得命中。

判档：新页面 + 共享 `sidebar-config.ts` / `dashboard-route-meta.ts` + 改动既有 SKU 页面 → 命中 T3 条件 ①（共享配置符号），收尾跑一次前端全量 `pnpm test` + `pnpm lint`，失败集按 `AGENTS.md` §失败集对账记录，不用 `skip` / `xfail` 隐藏。

---

## 七、风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 生产无数据，视觉验收不可靠 | 页面真实形态无法确认 | 空态优先设计；本地造样本做一次手动走查，PR 中写明验证方式 |
| 运营账号拿不到共享组列表（`/groups` 仅管理员） | 内部目标只能显示 group_id / display_name | 目标列表用 `display_name`（后端写入组名）+ 项目名兜底；组维护只在 SKU 页管理员入口 |
| 外部关联需要店铺列表，但没有「全站店铺」接口 | 关联店铺选择器缺数据源 | 复用 `projects/manage` + `GET /projects/{id}/shops` 聚合项目可见店铺，模块内 2min 缓存；不做 N 次裸请求 |
| reviews 接口无 total | 无法显示总页数 | 用「返回行数 == limit」做「还有下一页」判定，分页文案显示「第 N 页」而非总页数 |
| `PATCH /groups/{id}` 拒绝 null | 改成员/代表时空值会 422 | UI 侧禁止提交空成员与空代表；停用走独立 `deactivate` 接口 |
| 大文件 SKU 页面改动带来回归 | 既有 6 个 tab 与批量操作可能受影响 | 只做最小侵入：新增字段/入口，不改既有列顺序与批量逻辑；保留并扩展 `page.test.tsx` |
| 表格 / 图表在 jsdom 下不渲染 | 单测无法断言视觉 | 断言数据契约与文案，不对 recharts 像素做断言；tooltip 通过导出纯函数测映射 |

---

## 八、执行顺序

1. `lib/review-tracking-api.ts` + 单测（映射层先定契约）。
2. 页面骨架 + 目标选择 + 空态（先跑通「无数据也完整」）。
3. 评分趋势（图表 + tooltip 口径）。
4. 评论明细（筛选 + 分页）。
5. 采集健康度。
6. 外部竞品（登记 / 关联 / 移除 / 复活）。
7. 侧栏 + route-meta。
8. SKU 页 Father ID + 共享组 Sheet。
9. 组件/页面测试补齐 → `pnpm check:mocks` → `pnpm lint` → 前端全量 `pnpm test`。
10. PR（标题带 `BLF-1377`）+ issue 交棒 Tia。
