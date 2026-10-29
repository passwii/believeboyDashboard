# Terminal Header 单行常驻插槽修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每日分析样例页的 Top Header 恢复为默认一条 56px 主行，项目与日期两个常驻插槽固定显示在同一行内，只有点击箭头后才增加次级筛选行。

**Architecture:** 保留现有 `usePrimaryFilterSlot` / `PrimaryFilterSlotMount` 和 `useSecondaryHeaderSlot` API，只把 `PrimaryFilterSlotMount` 从独立 `terminal-header-primary-filter-row` 迁入 `terminal-header-primary-row`。次级筛选继续使用现有条件渲染行；页面筛选状态、URL、请求和移动端筛选条都不改。

**Tech Stack:** React 18、Next.js 16、TypeScript、Tailwind CSS、Vitest、Testing Library、Playwright、pnpm。

## Global Constraints

- 桌面端默认只能有一条 Head 主行，高度为 `TERMINAL_HEADER_HEIGHT = 56`。
- 常驻插槽固定放项目、日期，顺序为项目在前、日期在后。
- 次级筛选默认收起；有次级筛选时显示箭头，展开后才渲染第二行。
- 没有常驻筛选时不显示空插槽；没有次级筛选时不显示箭头或空行。
- 页面切换后次级筛选恢复收起。
- 常驻控件的可用宽度不足时，筛选插槽内部横向滚动，不允许换行成第二条默认 Head 行，也不允许裁掉控件。
- `<md` 继续使用正文顶部现有移动筛选条；桌面双插槽不复制移动端状态。
- 不改变筛选状态源、URL 参数、缓存策略、API 请求参数或数据加载时机。
- 当前主工作区存在与本任务无关的 CRM 改动；执行本计划前必须从最新 `origin/main` 创建独立 worktree，不得把那些改动带入本分支。
- 当前主工作区还有未跟踪的 `docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md`。该文件是本次设计的输入，不得删除；执行 Task 4 时将更新后的版本带入功能分支。
- 本次改动命中共享 Header 组件和 slot hook，按仓库 T3 规则执行前端全量测试。

---

## 执行前检查

- [ ] **Step 1: 确认当前分支和未提交改动**

```bash
git status --short
git rev-list --left-right --count origin/main...HEAD
```

Expected: 能看到现有未提交文件；左/右计数用于确认基准。不要暂存、覆盖或提交这些改动。

- [ ] **Step 2: 同步 main**

```bash
git fetch origin
git switch main
git pull --ff-only origin main
```

Expected: `Already up to date.` 或快进成功。

- [ ] **Step 3: 创建隔离 worktree**

```bash
git worktree add ../believeboyDashboard-header-single-row -b agent/frontend/terminal-header-single-row origin/main
cd ../believeboyDashboard-header-single-row
```

Expected: 新 worktree 从最新 `origin/main` 创建，当前主工作区原有改动保持不变。

- [ ] **Step 4: 建立 CodeGraph 索引**

```bash
codegraph init -i
codegraph status .
```

Expected: `Index is up to date`。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `frontend/components/terminal/terminal-header.tsx` | 修改 | 把常驻筛选锚点迁入唯一主行，移除独立常驻筛选行 |
| `frontend/components/terminal/terminal-header-slot.tsx` | 原则上不改 | 继续提供 primary/secondary slot API；只有测试暴露 API 缺陷时才改 |
| `frontend/components/terminal/terminal-header.test.tsx` | 修改 | 锁定单行结构、常驻插槽位置、展开后第二行和路由复位 |
| `frontend/components/terminal/terminal-header-slot.test.tsx` | 只读回归 | 验证 portal、注册、注销语义不受布局迁移影响 |
| `frontend/components/dashboard/daily-analysis-header-slots.tsx` | 原则上不改 | 每日分析页继续把项目/日期交给 primary，把站点/SKU 交给 secondary |
| `frontend/components/dashboard/daily-analysis-header-slots.test.tsx` | 只读回归 | 验证样例页的 primary/secondary/mobile 路由不变 |
| `docs/superpowers/specs/2026-10-26-expandable-header-design.md` | 修改 | 把旧“导航行下方常驻筛选行”改为“同一 Head 行内常驻插槽” |
| `docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md` | 修改 | 同步最终设计口径；从主工作区复制该未跟踪设计稿后再修改 |
| `docs/terminal-design/header-slot-spec.md` | 修改 | 更新 BLF-997 的 Header 三区结构说明，补上常驻筛选锚点 |

---

### Task 1: 用失败测试锁定单行 Head 契约

**Files:**
- Modify: `frontend/components/terminal/terminal-header.test.tsx:225-255`
- Modify: `frontend/components/terminal/terminal-header.test.tsx:266-302`
- Test: `frontend/components/terminal/terminal-header.test.tsx`

**Interfaces:**
- Consumes: `TerminalHeader`、`TerminalHeaderSlotProvider`、`usePrimaryFilterSlot(node)`、`useSecondaryHeaderSlot(node)`。
- Produces: 测试契约 `terminal-header-primary-row` 必须同时包含导航/操作区和 `terminal-primary-filter-slot`；`terminal-header-primary-filter-row` 不再存在；展开后 `<header>` 才出现第二个直接子行。

- [ ] **Step 1: 替换试点路由的默认布局测试**

把 `frontend/components/terminal/terminal-header.test.tsx` 中原有的“试点路由（销售数据）”用例替换为：

```tsx
  it('试点路由（销售数据）：默认只有一条 Head 行，项目与日期固定在同排插槽', async () => {
    const user = userEvent.setup()
    const { container } = renderHeader('/dashboard/operations/daily-analysis')
    const header = container.querySelector('header') as HTMLElement
    const navigationRow = screen.getByTestId('terminal-header-primary-row')
    const primaryFilterSlot = screen.getByTestId('terminal-primary-filter-slot')
    const primaryFilters = screen.getByTestId('terminal-header-primary-global-filters')

    expect(header.children).toHaveLength(1)
    expect(header.firstElementChild).toBe(navigationRow)
    expect(navigationRow).toContainElement(primaryFilterSlot)
    expect(primaryFilterSlot).toContainElement(primaryFilters)
    expect(primaryFilterSlot).toHaveClass('overflow-x-auto')
    expect(primaryFilterSlot).toHaveClass('max-w-[30rem]')
    expect(screen.queryByTestId('terminal-header-primary-filter-row')).not.toBeInTheDocument()
    expect(primaryFilters).toContainElement(screen.getByTitle('全局项目筛选'))
    expect(primaryFilters.querySelectorAll('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '展开次级筛选' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('terminal-header-secondary-row')).not.toBeInTheDocument()
    expect(screen.queryByTitle('全局站点筛选')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开次级筛选' }))

    expect(header.children).toHaveLength(2)
    expect(screen.getByTestId('terminal-header-primary-row')).toContainElement(
      screen.getByTestId('terminal-primary-filter-slot')
    )
    expect(screen.getByTestId('terminal-header-secondary-row')).toContainElement(
      screen.getByTitle('全局站点筛选')
    )
    expect(screen.getByRole('button', { name: '收起次级筛选' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
```

- [ ] **Step 2: 替换页面筛选接线测试**

把“常驻筛选与页面操作分行”用例替换为：

```tsx
  it('页面操作与常驻筛选同排，次级筛选展开后才新增第二行，路由切换后收起', async () => {
    const user = userEvent.setup()
    const pathname = '/dashboard/operations/daily-analysis'
    const { rerender } = render(
      <TerminalHeaderSlotProvider>
        <HeaderWithPageFilters pathname={pathname} />
      </TerminalHeaderSlotProvider>
    )

    const navigationRow = await screen.findByTestId('terminal-header-primary-row')

    await waitFor(() => {
      expect(navigationRow).toContainElement(screen.getByTestId('page-primary-control'))
      expect(navigationRow).toContainElement(screen.getByTestId('page-action-control'))
      expect(screen.queryByTestId('terminal-header-primary-filter-row')).not.toBeInTheDocument()
    })

    expect(screen.queryByTestId('page-secondary-control')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '展开次级筛选' }))
    expect(await screen.findByTestId('page-secondary-control')).toBeInTheDocument()
    expect(navigationRow).toContainElement(screen.getByTestId('page-primary-control'))
    expect(navigationRow).toContainElement(screen.getByTestId('page-action-control'))

    rerender(
      <TerminalHeaderSlotProvider>
        <HeaderWithPageFilters pathname="/dashboard/profile" />
      </TerminalHeaderSlotProvider>
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '展开次级筛选' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    )
    expect(screen.queryByTestId('page-secondary-control')).not.toBeInTheDocument()
  })
```

- [ ] **Step 3: 更新非试点路由断言**

在“非试点页面”用例中，把 `terminal-header-primary-filter-row` 断言替换为：

```tsx
    expect(screen.queryByTestId('terminal-primary-filter-slot')).not.toBeInTheDocument()
```

同时把“全局筛选未水合”用例中的同一断言替换为上面的断言。

- [ ] **Step 4: 运行目标测试并确认失败**

Run:

```bash
cd frontend
pnpm exec vitest run components/terminal/terminal-header.test.tsx
```

Expected: FAIL。新断言应报 `header.children` 为 2，或 `terminal-header-primary-row` 不包含 `terminal-primary-filter-slot`。若测试直接通过，说明测试没有覆盖当前错误结构，先修正测试。

- [ ] **Step 5: 提交测试契约**

```bash
git add frontend/components/terminal/terminal-header.test.tsx
git commit -m "test(头部): 锁定常驻筛选单行契约"
```

---

### Task 2: 将常驻筛选锚点并入唯一 Head 主行

**Files:**
- Modify: `frontend/components/terminal/terminal-header.tsx:176-417`
- Test: `frontend/components/terminal/terminal-header.test.tsx`

**Interfaces:**
- Consumes: Task 1 的测试契约；现有 `hasPrimaryFilters`、`hasGlobalPrimaryFilters`、`primaryFilterSlotActive`。
- Produces: `terminal-header-primary-row` 内包含 `terminal-primary-filter-slot`；页面无需调整 `usePrimaryFilterSlot` 调用；`terminal-header-primary-filter-row` 被删除。

- [ ] **Step 1: 在页面操作插槽之后插入常驻筛选锚点**

在 `frontend/components/terminal/terminal-header.tsx` 中，将 `HeaderSlotMount` 后面的内容改为以下结构：

```tsx
        {/* 页面操作插槽保持在导航/操作行，不与常驻筛选共享可裁切区域。 */}
        <HeaderSlotMount className="hidden min-w-0 shrink flex-nowrap items-center gap-1.5 overflow-hidden rounded-none border-l border-term-border px-2 md:flex" />

        {/* 常驻筛选不再单独占行；宽度不足时仅此区域横向滚动。 */}
        {hasPrimaryFilters ? (
          <PrimaryFilterSlotMount
            className={cn(
              'min-w-0 max-w-[30rem] shrink items-center gap-1.5 overflow-x-auto rounded-none border-l border-term-border px-2 term-scroll',
              hasGlobalPrimaryFilters && !primaryFilterSlotActive
                ? 'hidden xl:flex'
                : 'hidden md:flex'
            )}
          >
            {hasGlobalPrimaryFilters ? (
              <div
                data-testid="terminal-header-primary-global-filters"
                className="hidden shrink-0 items-center gap-1.5 xl:flex"
              >
                <HeaderProjectSelect
                  value={globalFilter.projectId}
                  onChange={globalFilter.setProjectId}
                />
                <HeaderDateRangePicker
                  dateFrom={globalFilter.dateFrom}
                  dateTo={globalFilter.dateTo}
                  country={globalFilter.country}
                  onChange={globalFilter.setDateRange}
                />
              </div>
            ) : null}
          </PrimaryFilterSlotMount>
        ) : null}

        {/* 右段：次级筛选展开 / 全局刷新 / 搜索 / 通知 / Inspector / 用户 */}
```

保留原来的右段 `<div className="flex shrink-0 items-center gap-1 px-2">` 和它内部全部按钮。

- [ ] **Step 2: 删除独立常驻筛选行**

删除从 `{hasPrimaryFilters ? (` 开始、到对应 `) : null}` 结束的整个 `terminal-header-primary-filter-row` 块。删除后，主行闭合标签之后应直接进入次级筛选条件块：

```tsx
      </div>
      {hasSecondaryFilters && secondaryFiltersExpanded ? (
        <div
          id="terminal-header-secondary-row"
          data-testid="terminal-header-secondary-row"
          className={cn(
            'w-full border-t border-term-border bg-term-panel',
            hasGlobalSecondaryFilters && !secondarySlotActive && 'hidden xl:block'
          )}
        >
          <SecondaryHeaderSlotMount className="flex min-h-11 min-w-0 flex-wrap items-center gap-1.5 px-2 py-1">
            {hasGlobalSecondaryFilters ? (
              <div className="hidden items-center gap-1.5 xl:flex">
                <HeaderCountrySelect
                  value={globalFilter.country}
                  onChange={globalFilter.setCountry}
                />
              </div>
            ) : null}
          </SecondaryHeaderSlotMount>
        </div>
      ) : null}
    </header>
```

- [ ] **Step 3: 更新组件注释**

把 `TerminalHeader` 上方注释改为：

```tsx
/**
 * Top Header: one fixed navigation/action/filter row by default.
 * The secondary filter row is mounted only while explicitly expanded.
 */
```

把 `terminal-header-slot.tsx` 中 `PrimaryFilterSlotMount` 的注释改为：

```tsx
/** TerminalHeader 唯一主行内的常驻筛选锚点，由页面 portal 项目与日期控件。 */
```

- [ ] **Step 4: 运行目标测试**

```bash
cd frontend
pnpm exec vitest run components/terminal/terminal-header.test.tsx
```

Expected: PASS，所有 `TerminalHeader` 用例通过。

- [ ] **Step 5: 运行 slot 与样例页适配器回归**

```bash
cd frontend
pnpm exec vitest run \
  components/terminal/terminal-header-slot.test.tsx \
  components/dashboard/daily-analysis-header-slots.test.tsx \
  components/dashboard/daily-analysis-header-filters.test.tsx
```

Expected: PASS。`usePrimaryFilterSlot` 的注册/注销、每日分析页的 primary/secondary/mobile 路由均不变。

- [ ] **Step 6: 提交实现**

```bash
git add \
  frontend/components/terminal/terminal-header.tsx \
  frontend/components/terminal/terminal-header-slot.tsx
git commit -m "fix(头部): 常驻筛选并入顶栏单行"
```

---

### Task 3: 样例页结构回归与路由复位

**Files:**
- Test: `frontend/components/terminal/terminal-header.test.tsx`
- Test: `frontend/components/dashboard/daily-analysis-header-slots.test.tsx`

**Interfaces:**
- Consumes: Task 2 的单行 Header。
- Produces: 每日分析样例页的验收证据；后续推广页直接复用同一 slot 契约。

- [ ] **Step 1: 增加“无次级筛选时无箭头、无空行”断言**

在 `terminal-header.test.tsx` 增加独立用例：

```tsx
  it('没有次级筛选时不渲染箭头或第二行', () => {
    const { container } = renderHeader('/dashboard/profile')
    const header = container.querySelector('header') as HTMLElement

    expect(header.children).toHaveLength(1)
    expect(screen.queryByTestId('terminal-header-secondary-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-header-secondary-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-primary-filter-slot')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: 增加“展开再收起后只剩主行”断言**

在单行布局用例的展开断言之后补上：

```tsx
    await user.click(screen.getByRole('button', { name: '收起次级筛选' }))
    expect(header.children).toHaveLength(1)
    expect(screen.queryByTestId('terminal-header-secondary-row')).not.toBeInTheDocument()
```

- [ ] **Step 3: 保持每日分析适配器测试不变并运行**

```bash
cd frontend
pnpm exec vitest run \
  components/terminal/terminal-header.test.tsx \
  components/dashboard/daily-analysis-header-slots.test.tsx
```

Expected: PASS。每日分析页仍将 `primary` 放入 `terminal-primary-filter-slot`，将 `secondary` 放入 `terminal-secondary-header-slot`，将移动控件放入 `terminal-mobile-strip`。

- [ ] **Step 4: 提交样例页回归**

```bash
git add frontend/components/terminal/terminal-header.test.tsx
git commit -m "test(头部): 覆盖样例页单行与展开复位"
```

---

### Task 4: 同步设计与插槽规范

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-expandable-header-design.md:3-31`
- Create/Modify: `docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md`
- Modify: `docs/terminal-design/header-slot-spec.md:20-35`

**Interfaces:**
- Consumes: Task 2 的最终 DOM 结构与交互。
- Produces: 后续推广页面唯一遵循的文字规范，不再存在“导航行下方常驻筛选行”的旧口径。

- [ ] **Step 1: 把未跟踪设计稿带入 worktree**

从主工作区复制当前未跟踪设计稿：

```bash
cp \
  /Users/damon/DamonProjects/believeboyDashboard/docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md \
  docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md
```

Expected: 功能 worktree 中出现该文件；主工作区原件不变。

- [ ] **Step 2: 修正 2026-10-26 设计稿**

把状态段改为：

```markdown
## 状态

原二层头部方案已于 2026-10-29 修订。Header 默认只保留一条 56px 主行；项目/日期常驻插槽与导航、页面操作、右侧工具同排，次级筛选仅在点击箭头后增加一行。本文件保留历史背景，最终布局以 2026-10-28 双层筛选插槽规范为准。
```

把“交互与布局 / 桌面与平板”的前三条改为：

```markdown
- 顶部默认只保留一条 56px Head 主行，承载导航、页面操作、项目/日期常驻插槽及右侧全局图标。
- 项目与日期位于同一主行内的常驻筛选插槽，顺序固定为项目、日期；宽度不足时只允许该插槽内部横向滚动。
- 次级筛选行默认收起。当前路由有次级筛选时，右侧显示向下箭头按钮；按钮使用 `aria-expanded` 和明确的展开/收起可访问名称。
```

把“展开后”第一条改为：

```markdown
- 展开后，Header 在主行下方增加第二筛选行。该行按内容自然增高，正文向下流动，不覆盖内容。
```

- [ ] **Step 3: 修正 2026-10-28 双层筛选插槽规范**

把状态改为：

```markdown
> 状态：**设计定稿（2026-10-29 修订）**
```

把 §3.1 标题和首段改为：

```markdown
### 3.1 一级筛选区

一级筛选区不是一个额外的默认行，而是 Top Header 唯一 56px 主行内的固定插槽区。两个语义位置依次为项目、日期，与面包屑、页面操作和右侧全局工具同排显示。
```

把 §3.1 最后一段改为：

```markdown
项目与日期在布局上保持左到右顺序。桌面空间不足时，只允许常驻筛选插槽内部横向滚动；不得换行生成第二条默认 Head 行，不得把项目/日期藏入次级筛选，也不得让页面操作区把它们裁切掉。
```

把 §3.2 第一段改为：

```markdown
二级筛选行默认收起，由头部的箭头按钮展开或收起。它只承载当前页面项目与日期之外的筛选条件，展开后作为 Header 的第二行出现，正文自然下移。
```

把 §7 第一条验收标准改为：

```markdown
- [ ] 桌面端默认只有一条 56px Head 主行；项目、日期按顺序固定显示在该行的常驻筛选插槽内。
```

- [ ] **Step 4: 修正 BLF-997 的 Header 三区结构说明**

把 `docs/terminal-design/header-slot-spec.md` §1.1 的中段行改为：

```markdown
| 中段 | 页面操作 `HeaderSlotMount` + 常驻筛选 `PrimaryFilterSlotMount`（项目/日期）；两者与导航同处唯一 56px 主行。次级筛选仅在展开时进入第二行 | 常驻插槽 `hidden md:flex`；全局项目/日期在 `xl+` 复用同锚点 |
```

把右段行补充为：

```markdown
| 右段 | 次级筛选展开开关 / 全局刷新 / ⌘K 搜索 / 通知 / Inspector / 用户菜单 | 固定 |
```

- [ ] **Step 5: 扫描旧口径和格式**

```bash
rg -n "导航行下方显示常驻筛选层|常驻筛选行|独立筛选行" \
  docs/superpowers/specs/2026-10-26-expandable-header-design.md \
  docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md \
  docs/terminal-design/header-slot-spec.md
git diff --check -- \
  docs/superpowers/specs/2026-10-26-expandable-header-design.md \
  docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md \
  docs/terminal-design/header-slot-spec.md
```

Expected: `rg` 无输出；`git diff --check` 无输出且退出码为 `0`。

- [ ] **Step 6: 提交规范修正**

```bash
git add \
  docs/superpowers/specs/2026-10-26-expandable-header-design.md \
  docs/superpowers/specs/2026-10-28-expandable-header-slots-design.md \
  docs/terminal-design/header-slot-spec.md
git commit -m "docs(头部): 统一单行常驻插槽规范"
```

---

### Task 5: 技术门禁与样例页人工验收

**Files:**
- Verify only: `frontend/**`

**Interfaces:**
- Consumes: Task 1-4 的代码、测试和规范。
- Produces: 每日分析样例页可交付的验收记录，以及进入逐级推广的准入结论。

- [ ] **Step 1: 运行定向测试**

```bash
cd frontend
pnpm exec vitest run \
  components/terminal/terminal-header.test.tsx \
  components/terminal/terminal-header-slot.test.tsx \
  components/dashboard/daily-analysis-header-slots.test.tsx \
  components/dashboard/daily-analysis-header-filters.test.tsx
```

Expected: 所有测试 PASS，无新增 warning。

- [ ] **Step 2: 运行共享组件全量门禁**

```bash
cd frontend
pnpm test
```

Expected: 全部测试文件通过；`check:mocks` 与 `check:motion-tokens` 均通过。

- [ ] **Step 3: 运行 lint**

```bash
cd frontend
pnpm lint
```

Expected: exit code `0`。

- [ ] **Step 4: 启动样例页做桌面验收**

```bash
cd frontend
pnpm dev
```

在浏览器打开 `/dashboard/operations/daily-analysis`，逐项确认：

```text
1440×900：
- header 默认只有一条 56px 主行。
- 项目、日期在导航/操作同排可见，顺序为项目 -> 日期。
- 页面正文紧接主行，不再出现项目/日期独立第二行。
- 展开箭头存在，默认 aria-expanded=false；点击后出现站点/SKU 第二行，正文下移。
- 再点收起后第二行消失，header 恢复单行。

1024×768：
- 仍只有一条 Head 主行。
- 项目/日期插槽不换行；空间不足时插槽内部可横向滚动，两个控件不被裁掉。
- 右侧刷新、搜索、通知、用户入口仍可操作。

768×800：
- 不会产生默认第二行。
- 常驻筛选插槽不把右侧工具挤出视口。

390×844：
- 桌面 primary/secondary 插槽不显示。
- 正文顶部移动筛选条可见，仍包含项目、站点、日期、SKU。
```

- [ ] **Step 5: 验证页面切换复位**

在样例页展开次级筛选后，从侧栏切到任意其他页面，再返回每日分析页：

```text
- 返回后次级筛选默认收起。
- 项目/日期值仍来自页面原有状态，不被 Header 重建或重置。
- 切换过程中没有空白的次级行残留。
```

- [ ] **Step 6: 记录最终差异**

```bash
git status --short
git diff --stat origin/main...
git log --oneline origin/main..HEAD
```

Expected: 只有本计划的代码、测试、文档文件；没有 CRM 或后端文件。

---

## 样例页验收清单

- [ ] 默认 Header 只有一个直接主行，高度引用 `TERMINAL_HEADER_HEIGHT`。
- [ ] 项目、日期在唯一主行内的 `terminal-primary-filter-slot` 中固定显示。
- [ ] 页面操作仍位于 `terminal-header-slot`，与常驻筛选互不覆盖。
- [ ] 次级筛选默认不渲染，有内容时只显示箭头。
- [ ] 展开后新增第二行，收起后第二行被移除。
- [ ] 路由切换后次级筛选收起。
- [ ] 无次级筛选页面没有箭头或空行。
- [ ] `md` 到 `xl` 使用页面降级项目/日期控件；`xl+` 使用全局项目/日期。
- [ ] 移动端继续使用正文顶部筛选条，桌面插槽不重复渲染状态。
- [ ] 定向测试、前端全量测试、lint 全部通过。
- [ ] 1440、1024、768、390 四档浏览器验收通过。

## 推广准入条件

完成本计划后，只有同时满足以下条件的页面才能进入 `2026-10-29-terminal-header-single-row-rollout.md`：

1. 样例页人工验收通过。
2. 前端全量测试和 lint 通过。
3. 单行 Head 的 DOM 契约稳定：默认 `<header>` 只有一个直接子行。
4. 项目/日期不再以任何形式生成独立默认行。
5. 样例页移动端筛选状态、URL 和请求参数无变化。

