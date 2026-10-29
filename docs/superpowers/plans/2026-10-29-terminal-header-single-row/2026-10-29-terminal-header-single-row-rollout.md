# Terminal Header 单行插槽逐级推广 Playbook

> 父计划：`docs/superpowers/plans/2026-10-29-terminal-header-single-row/2026-10-29-terminal-header-single-row.md`
> 状态：待样例页验收通过后启动

## 1. 推广原则

- 一次只迁移一个波次，不同时改共享 Header 和多个页面。
- 每个页面必须明确拆成 primary（项目、日期）和 secondary（其余筛选）两组。
- 页面没有日期维度时，只固定项目；页面没有项目维度时，按既有业务例外处理，不伪造空控件。
- 页面没有次级筛选时，不显示箭头，不保留空行。
- 移动端筛选条先保持原状；迁移桌面插槽不得复制或重建页面筛选状态。
- 页面筛选值、URL、缓存键、查询参数和请求时机保持原契约。
- 每个波次完成后跑该波次的目标测试；共享 Header 再有改动时升级为前端全量测试。
- 单页验收未通过时停止该波次，不把后续页面一起带进同一次修复。

## 2. 页面迁移标准步骤

对任意待迁移页面执行以下步骤：

1. 阅读页面现有筛选状态和请求触发逻辑，标出项目、日期、其余筛选。
2. 在同一个组件中构造 `primaryControls` 和 `secondaryControls`，两者复用页面原有受控值和回调。
3. 桌面端用 `usePrimaryFilterSlot(primaryControls)` 和 `useSecondaryHeaderSlot(secondaryControls)`；移动端继续用 `useMobileFilterStrip(mobileControls)`。
4. 删除该页原先把全部筛选同时塞进 `useHeaderSlot` 的入口；页面操作按钮继续留在 `useHeaderSlot`。
5. 保留 `useHeaderRefresh` 注册和页面原有刷新语义。
6. 增加该页测试，至少断言 primary、secondary、mobile 三组内容进入各自锚点，页面操作不进入筛选锚点。
7. 浏览器检查 1440、1024、768、390 四档。
8. 单独提交该页迁移，提交信息写清迁移的对象和断点。

标准接线形态：

```tsx
const primaryControls = (
  <>
    {projectControl}
    {dateControl}
  </>
)

const secondaryControls = (
  <>
    {countryControl}
    {skuControl}
  </>
)

const primaryPortal = usePrimaryFilterSlot(isMobile ? null : primaryControls)
const secondaryPortal = useSecondaryHeaderSlot(isMobile ? null : secondaryControls)
const mobilePortal = useMobileFilterStrip(mobileControls)
```

页面返回：

```tsx
return (
  <>
    {primaryPortal}
    {secondaryPortal}
    {mobilePortal}
    {pageContent}
  </>
)
```

## 3. 波次安排

### Wave 0：样例页门禁

入口页：`/dashboard/operations/daily-analysis`

文件：

- `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`
- `frontend/components/dashboard/daily-analysis-header-slots.tsx`
- `frontend/components/dashboard/daily-analysis-header-slots.test.tsx`

通过条件：

- 父计划全部验收项通过。
- 默认单行、展开两行、路由复位、移动端筛选条均通过。
- 此波次完成后才允许改第二个页面。

### Wave 1：全局筛选试点页

入口页：

- `/dashboard/reports/order-info`
- `/dashboard/operations/shipping-plan`

重点文件：

- `frontend/app/dashboard/reports/order-info/page.tsx`
- `frontend/app/dashboard/reports/order-info/page.test.tsx`
- `frontend/app/dashboard/operations/shipping-plan/shipping-plan-client.tsx`
- `frontend/app/dashboard/operations/shipping-plan/shipping-plan-client.test.tsx`

迁移口径：

- 项目、日期继续由全局筛选提供，固定在第一层。
- 页面私有筛选如果属于低频查询条件，迁入次级插槽；如果已是正文工具行，保持正文工具行。
- 不把导出、编辑、创建等写操作移入次级筛选。

通过条件：

- 全局项目/日期只出现一次，不重复渲染。
- 次级插槽有内容时才显示箭头。
- 页面筛选请求参数与迁移前一致。

### Wave 2：低密度筛选页

入口页：

- `/dashboard`
- `/dashboard/operations/weekly-product-analysis`
- `/dashboard/operations/return-analysis`
- `/dashboard/operations/project-goals`

重点文件：

- `frontend/app/dashboard/page.tsx`
- `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.tsx`
- `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`
- `frontend/app/dashboard/operations/project-goals/page.tsx`

迁移口径：

- 项目、日期或业务周期进入 primary。
- 站点、状态、关键词等进入 secondary。
- 页面原本只有 2-3 个筛选时，不得为了填满二级行而制造筛选。

通过条件：

- 默认主行不产生换行第二行。
- 每个页面的目标测试更新并通过。
- 波次结束跑：

```bash
cd frontend
pnpm exec vitest run \
  app/dashboard/page.test.tsx \
  app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.test.tsx \
  app/dashboard/operations/return-analysis/return-analysis-client.test.tsx \
  app/dashboard/operations/project-goals/page.test.tsx
```

### Wave 3：中密度筛选页

入口页：

- `/dashboard/operations/inventory-ledger`
- `/dashboard/operations/seasonal-replenishment`
- `/dashboard/operations/shipment-management`
- `/dashboard/operations/portfolio-overview`
- `/dashboard/reports/monthly-report/display`
- `/dashboard/reports/monthly-report/generate`

重点文件：

- `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx`
- `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.tsx`
- `frontend/app/dashboard/operations/shipment-management/page.tsx`
- `frontend/app/dashboard/operations/portfolio-overview/portfolio-overview-client.tsx`
- `frontend/app/dashboard/reports/monthly-report/display/display-client.tsx`
- `frontend/app/dashboard/reports/monthly-report/generate/generate-client.tsx`

迁移口径：

- 项目、日期/月份固定。
- 站点、仓库、状态、关键词、月份导航等按业务频率进入 secondary。
- 视图 Tab、导出、创建、编辑、快照选择器继续留正文或操作区。
- 遇到插槽内已有重复刷新按钮时，删除页面内刷新入口，只保留全局刷新。

通过条件：

- 同级控件保持 `h-10`、零圆角、`TERM_HEADER_*` 宽度档。
- 每个页面在 1024 宽度下不把右侧工具挤出视口。
- 目标测试逐个通过后才进入 Wave 4。

### Wave 4：高密度与例外页

入口页：

- `/dashboard/operations/sku-info`
- `/dashboard/finance/platform-revenue`
- `/dashboard/finance/commission-management`
- `/dashboard/finance/exchange-rate`
- `/dashboard/advertising/ad-analysis/*`
- `/dashboard/advertising/ad-data/*`
- `/dashboard/reports/monthly-report/reconcile`

迁移口径：

- 优先保证项目、日期稳定，不要一次把 6-7 个私有筛选塞进 primary。
- 超预算时把低频私有筛选下移到 secondary 或正文工具行，遵循 BLF-997 §4.3。
- ad-analysis / ad-data 同时补齐移动端 `useMobileFilterStrip` 缺口。
- reconcile 继续使用 `activeTab === 'auto' ? controls : null` 的条件化插槽模式。

通过条件：

- 1280 宽度下 primary 只保留项目、日期，不裁切。
- 页面私有筛选不超过次级行承载能力；仍超宽时下移正文。
- 移动端筛选入口可达。

### Wave 5：剩余已插槽化页面

对 `docs/terminal-design/header-slot-spec.md` §2.1 中尚未迁移的页面逐页执行第 2 节标准步骤。每一页单独提交，不按目录批量盲改。

完成后运行：

```bash
cd frontend
pnpm test
pnpm lint
```

Expected: 全量测试通过，lint exit code `0`。

## 4. 单页验收模板

```text
页面：
路由：
primary 控件：项目 / 日期
secondary 控件：
保留正文控件：
移动端入口：

1440：
- 默认一条 Head 行：
- 项目/日期可见：
- 展开后第二行：
- 收起后无空行：

1024：
- 单行：
- 插槽滚动：
- 右侧工具：

768：
- 单行：
- 无裁切：

390：
- 移动筛选条：
- 桌面插槽隐藏：

状态/URL/请求：
- 项目：
- 日期：
- 其余筛选：

目标测试：
全量测试：
lint：
```

## 5. 停止条件

出现以下任一情况时停止推广并回到设计/根因分析：

- 任一页面仍然出现默认两条 Head 行。
- 页面操作按钮被常驻筛选挤到不可见或不可点击。
- 同一筛选在 primary、secondary、移动筛选条中同一视口重复出现。
- 页面 URL、请求参数或筛选状态源需要改变才能完成迁移。
- 1280 宽度下项目/日期被裁切且插槽滚动不可用。
- 共享 Header 测试在连续两个页面迁移后出现同一根因的新失败。

## 6. 完成定义

- 所有目标页面默认只有一条 Head 主行。
- 项目、日期在 primary 中固定显示；次级筛选只在展开后出现。
- 无次级筛选页面没有箭头和空行。
- 移动端筛选入口完整可达。
- 全站前端测试与 lint 通过。
- `docs/terminal-design/header-slot-spec.md` 与实际实现一致。

