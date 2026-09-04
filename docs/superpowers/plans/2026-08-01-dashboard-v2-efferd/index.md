# Dashboard V2（Efferd 密集网格）— 实施归档

> **状态：** ✅ **完成**（BLF-450，2026-08-05）
> **分支：** main（commit `0d5d9762` 脚手架合并 + `d10f9a4c`→`9a90f6fe` 六个实施 commit）
> **日期：** 2026-08-01（设计）→ 2026-08-05（实施完成）

## 入口

| 文档 | 路径 |
|---|---|
| 实施计划（44 步全勾选） | `2026-08-01-dashboard-v2-efferd.md` |
| 设计文档 | [`docs/superpowers/specs/2026-08-01-dashboard-v2-efferd-design.md`](../../specs/2026-08-01-dashboard-v2-efferd-design.md) |

## 任务进度

| Task | 主题 | 状态 | Commit |
|---|---|---|---|
| 1 | 脚手架（v2-card/format/grid + shadcn empty） | ✅ | `0d5d9762`（merge feat/dashboard-v2-efferd，2026-08-05 17:09） |
| 2 | v2-delta 趋势指示器 + 5 测试 | ✅ | `d10f9a4c` |
| 3 | v2-stats KPI 统计卡 + 7 测试 | ✅ | `cb8e8746` |
| 4 | v2-revenue-chart 渐变柱状图 | ✅ | `08105436` |
| 5 | v2-channel-chart 双折线图 | ✅ | `b22d9c79` |
| 6 | mock 区块（invoices/billing/activity） | ✅ | `aa42f8e5` |
| 7 | v2 页面 + 项目级过滤 + 4 测试 | ✅ | `75e46947` |
| 8 | v1 试试新版按钮 + loading.tsx | ✅ | `9a90f6fe` |

## 交付内容

- **新路由**：`/dashboard/v2`（Efferd 密集网格实验页：4 KPI 卡 + 渐变柱状图 + 双折线图 + 3 个 mock 区块）
- **互跳**：`/dashboard`（v1）↔ `/dashboard/v2`，均为 `next/link` 无状态切换
- **项目过滤**：v2 页面级 ProjectSelect（"全部项目"= v1 行为 / 单项目过滤）
- **性能**：recharts 双图 `next/dynamic` + `ssr:false` 拆包（沿用 v1 策略）
- **测试**：新增 16 个单测（delta 5 + stats 7 + page 4），全量 416 通过

## 与计划的偏差（实施中修正）

1. **v2-stats loading 断言**：项目 Skeleton 用自定义 `u-skeleton-shimmer`（非默认 `animate-pulse`），测试改为断言实际类名
2. **page.test 稳定性**：`useManagedProjects` / `useNotifications` mock 改为模块级常量，避免每次 render 新引用导致 effect/loadData 无限重跑、loading 状态振荡（fetch 永不落定假象）——生产实现本身无此问题（context/缓存引用稳定）
3. **mock 区块**：sample 的 TW4 `mask-*` 工具类（TW3.4 不存在）改为 arbitrary `[mask-image:...]`；`IconPlaceholder` 多图标库抽象替换为 lucide 直引
4. **loading.tsx**：`app/dashboard/v2/loading.tsx` 新增（BEL-419 路由骨架覆盖守卫要求每个含页面 section 自带 loading）

## 手动验证清单（交用户）

- [ ] `/dashboard` 右上角出现"试试新版"，点击跳转 `/dashboard/v2`
- [ ] `/dashboard/v2` 顶部有项目选择器（默认"全部项目"）+ "返回旧版"按钮，点击返回 `/dashboard`
- [ ] 亮色/暗色主题下：发丝线网格、纯平卡片、Delta 绿涨红跌均正常
- [ ] 4 个 KPI 卡显示中文标签 + `$` 金额 + 环比 delta
- [ ] 销售额柱状图（渐变柱）与双折线图渲染，tooltip 可用
- [ ] 切换单个项目后 KPI/图表数据刷新；切回"全部项目"恢复
- [ ] Recent invoices / Billing health / Activity 三个 mock 区块显示英文占位内容
- [ ] 移动端（<768px）回退 1 列布局
- [ ] 断网或后端挂掉时：真实数据区显示"暂无销售数据 + 重试"，mock 区块不受影响

## 外部关联

- **验收 issue**：BLF-450（确认 V2 进度 + 集成 V1/V2 切换）
- **数据快照**：新增 16 测试（delta 5 / stats 7 / page 4）；全量 78 文件 416 测试通过；`pnpm lint` 0 错误；`pnpm build` 含 `/dashboard/v2` 路由

## 打磨轮（2026-08-06，BLF-450 用户反馈）

用户三条反馈：业务数据集成 / 图表完整度 / 中文化。commit `e9472fd2` 一次性落地：

- **替换 3 个英文 mock 为真实业务数据**：`V2TopProjects`（项目排行表格，project_breakdown + 环比，销售额/广告花费 Tab）替代 `V2Invoices`；`V2AlertFeed`（告警动态，alerts/stats + alerts/events 自管 fetch）替代 `V2Activity`；`V2StockChart`（库存水位 7 日趋势）替代 `V2Billing`；删除 `v2-invoices/billing/activity.tsx`
- **新增 3 个真实数据图表**：`V2ProjectChart`（项目销售额对比 Top 5）、`V2CountryChart`（跨国家销售额，/all-countries 随页面项目选择）、`V2TrafficChart`（流量与转化：浏览量柱 + 转化率线 + 汇总）
- **全中文化**：页面已无 sample 英文残留；新表格/图表/告警全部中文标签
- **验证**：lint 0 错误 / build 含 `/dashboard/v2` / 全量 82 文件 447 测试通过（新增 top-projects 4 + stock-traffic 6 + page 1）
- **测试经验**：页面级测试中图表组件 mock 为 testid 占位（不渲染标题，断言 testid）；告警组件自管 fetch 先于页面主 fetch 触发，断言主请求需按 URL 过滤而非 calls[0]

## 打磨轮 2（2026-08-06，BLF-450 用户三条新反馈）

1. **销售 vs 广告花费复合图打磨**（commit `7cc774a4`）：双 Y 轴（销售额左轴/广告花费右轴，量级差异大）+ ChartLegend 图例 + 实线（销售额）/虚线（广告花费）+ 表头图标芯片 + 移除模糊 glow 滤镜，改 monotone 平滑线
2. **移除告警中心**：删除 `V2AlertFeed` 组件与页面引用；项目排行改 `md:col-span-4` 全宽收底
3. **商务蓝主题**：发丝线 `bg-blue-100/70 dark:bg-blue-900/50`、卡片淡蓝渐变（`from-blue-50/70 to-white` / 暗色 `from-blue-950/40`）、6 图表 series 全蓝系（`#2563eb` 主蓝 / `#60a5fa` 亮蓝 / `#93c5fd` 浅蓝 / `#1d4ed8` 深蓝）、KPI 数值蓝、表头图标芯片、Tab 高亮蓝、loading 占位同步蓝调；Delta 语义色（绿涨红跌）保留
- **验证**：lint 0 错 / build 通过 / 全量 472 测试全绿

## 转正轮（2026-08-06，BLF-450 用户确认弃用 V1）

用户拍板：正式弃用 V1，V2 转正为主概览（commit `9bb32640`）：

- **V2 转正到根路径**：`app/dashboard/v2/page.tsx` + `page.test.tsx` 移到根 `app/dashboard/page.tsx`（`/dashboard` 即 V2）；`app/dashboard/loading.tsx` 换 V2 扁平骨架；`/dashboard/v2` 路由删除；V2 工具栏移除「返回旧版」按钮
- **V1 弃用**：移至 `app/dashboard/v1/page.tsx`（`/dashboard/v1` 保留可访问作回退），移除「试试新版」按钮；补 `v1/loading.tsx`（BEL-419 守卫）；v1 图表组件 import 从 `@/app/dashboard/page` 改为 `@/app/dashboard/v1/page`
- **KPI 卡去灰**：移除底部灰色 footer（`bg-background` 条 + 「vs 上一周期」灰字），delta 徽章移到表头右侧
- **销售额复合图**：增加销量维度——`units_ordered` 折线（右轴）+ 销售额渐变柱（左轴）双轴 + 图例；描述改「每日销售额与销量」
- **验证**：lint 0 错 / build 通过（`/dashboard` 为 V2、`/dashboard/v1` 存在、`/dashboard/v2` 消失）/ 全量 472 测试全绿
- **路由现状**：`/dashboard` = V2 主概览；`/dashboard/v1` = 旧版（弃用，仅回退用）
