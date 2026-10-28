# MyGo 原生工作台 Apple 交互实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with test-first checkpoints.
>
> **状态：** 实施完成，待 macOS 窗口视觉复核
> **日期：** 2026-10-27
> **关联计划：** `2026-10-26-mygo-native-go-migration/2026-10-26-mygo-native-go-migration.md`

**Goal:** 将 MyGo macOS 工作台收敛为使用框架原生 Sidebar、Toolbar、Split 和 Table 的桌面布局，并交付可搜索、可选择的项目页面。

**Architecture:** 继续使用 Go 与 MyGo `ui` 构建纯原生窗口，保留现有登录、API Client、Keychain 和 Router。共享 Workbench 使用 MyGo Sidebar 与 Toolbar；Inspector 使用可拖动 Split；项目列表通过现有只读 `/api/v1/projects/manage` loader 获取数据。

**Tech Stack:** Go 1.27.3、MyGo v0.6.4、MyGo `ui`、PostgreSQL-backed Go Gateway / FastAPI fallback。

## Global Constraints

- 桌面窗口不得创建 WebView、加载 HTTP 页面或依赖 Next.js / Bun。
- 登录、Keychain 会话边界和 Go Gateway API 契约保持兼容。
- 主题从 `ui.Context.Theme()` 继承系统外观、系统强调色和无障碍偏好。
- 所有异步 UI 状态更新必须通过 `Window.Update` 回到主线程。
- 新增行为先写 MyGo `ui.NewTester` 测试并确认 RED，再实现。
- 用户自有未提交计划与 `go.work.sum` 保留，不在本计划中覆盖或清理。

---

### Task 1：改为系统主题派生的语义调色板

**Files:**
- Modify: `desktop/internal/design/tokens.go`
- Modify: `desktop/internal/design/tokens_test.go`
- Modify: `desktop/internal/app/app.go`
- Modify: `desktop/internal/pages/home.go`
- Modify: `desktop/internal/pages/placeholder.go`
- Modify: `desktop/internal/components/stat_card.go`
- Modify: `desktop/internal/components/shell.go`
- Modify: `desktop/internal/components/header.go`
- Modify: `desktop/internal/components/sidebar.go`

- [x] 写 `PaletteFromTheme` 的浅色和深色行为测试。
- [x] 运行 `go test ./internal/design -run TestPaletteFromTheme -count=1`，确认预期失败。
- [x] 从 `ui.Theme` 生成语义 palette，保留 MyGo 默认强调色、表面、文字和状态色。
- [x] 移除每帧覆盖 `c.Theme()` 的 `ApplyTheme` 调用，组件从当前 context theme 读取颜色。
- [x] 运行设计 token、组件和页面目标测试。

### Task 2：共享 Shell 使用 MyGo 原生 Sidebar、Toolbar 与 Split

**Files:**
- Modify: `desktop/internal/components/shell.go`
- Modify: `desktop/internal/components/shell_test.go`
- Modify: `desktop/internal/components/workbench.go`
- Modify: `desktop/internal/components/header.go`
- Modify: `desktop/internal/components/header_test.go`
- Modify: `desktop/internal/components/sidebar.go`
- Create: `desktop/internal/components/sidebar_test.go`
- Delete: `desktop/internal/components/rail.go`
- Delete: `desktop/internal/components/inspector_toggle.go`
- Modify: `desktop/internal/app/app.go`
- Modify: `desktop/internal/app/app_test.go`

- [x] 先写原生分组侧栏选择、Toolbar 项目菜单和 Inspector Split 的行为测试。
- [x] 运行受影响的组件测试，确认新行为测试按预期失败。
- [x] 使用 `ui.Sidebar` 单列显示工作台、项目、运营、报表、AI 和系统分组。
- [x] 使用 `ui.Toolbar` 承载标题、项目菜单、刷新、Inspector 开关和用户菜单。
- [x] 使用 `ui.Split` 实现可键盘和拖动调整的主内容 / Inspector；把 Split 宽度保存在 App 状态中。
- [x] 删除旧的双层 Rail + 手工 Sidebar 实现及其失效测试。
- [x] 运行组件和 App 导航目标测试。

### Task 3：增加原生项目列表页

**Files:**
- Create: `desktop/internal/pages/projects.go`
- Create: `desktop/internal/pages/projects_test.go`
- Modify: `desktop/internal/app/app.go`
- Modify: `desktop/internal/app/app_test.go`
- Modify: `desktop/internal/components/workbench.go`

- [x] 写项目加载、加载失败、搜索过滤、键盘行选择和 Inspector 详情测试。
- [x] 运行 `go test ./internal/pages ./internal/app -run 'TestProjectsPage|TestAppProjects' -count=1`，确认新行为测试失败。
- [x] 用现有 `ProjectLoader` 异步加载数据，并通过注入的 Update 函数返回 UI 主线程。
- [x] 用 `ui.SearchField` 过滤项目、`ui.Table` 显示项目名 / 站点 / 状态、`ListState` 管理键盘选择。
- [x] 选择项目时在 Inspector 显示项目详情；空列表、加载中和加载错误均提供原生状态视图。
- [x] 将项目路由从 placeholder 改为 ProjectsPage，并在路由重置和 App.Close 时取消请求。
- [x] 运行 ProjectsPage 与 App 目标测试。

### Task 4：更新首页与全套桌面验收

**Files:**
- Modify: `desktop/internal/pages/home.go`
- Modify: `desktop/internal/pages/home_test.go`
- Modify: `desktop/internal/pages/placeholder.go`
- Modify: `desktop/internal/components/shell_test.go`
- Modify: `desktop/internal/components/header_test.go`
- Modify: `desktop/internal/components/sidebar_test.go`
- Modify: `desktop/internal/components/stat_card_test.go`

- [x] 首页与 placeholder 使用新的共享 Shell 和主题色。
- [x] 扩展测试覆盖深色主题、1000x700 最小窗口、Inspector 开合、Sidebar 路由和项目页面状态。
- [x] 运行 `go test ./...`、`go test -race ./...`、`CGO_ENABLED=0 go test ./...`、`go vet ./...`、`go tool mygo vet`。
- [x] 运行 `go tool mygo build -skip-dmg`，产出 macOS app。
- [ ] 在 macOS 原生窗口手工检查登录、导航、项目列表、搜索、Inspector 和系统主题。
- [x] 确认源码仍无 WebView / 网页地址加载。

---

### Task 5：将系统窗口按钮与工作台布局合并

**Files:**
- Modify: `desktop/main.go`
- Modify: `desktop/main_test.go`
- Modify: `desktop/internal/components/shell.go`
- Modify: `desktop/internal/components/shell_test.go`
- Modify: `desktop/internal/components/sidebar.go`
- Modify: `desktop/internal/pages/login.go`
- Modify: `desktop/internal/pages/login_test.go`

- [x] 用 `mygo.TitleBarHidden` 隐藏默认标题栏，但保留系统绘制的红黄绿按钮；不设置 `HideWindowButtons`。
- [x] 在共享 Shell 和登录页读取 `c.TitleBar()`，预留窗口按钮空间，并把可拖动区域放进页面布局。
- [x] 移除侧栏品牌行与主内容 Toolbar 的双层顶边；将应用标识、当前页面和操作组合进同一标题栏布局。
- [x] 为窗口选项、标题栏区域、无窗口按钮留白和子控件交互补充回归覆盖。

### Task 6：统一首阶段页面与原生动效

**Files:**
- Modify: `desktop/internal/design/tokens.go`
- Modify: `desktop/internal/design/tokens_test.go`
- Modify: `desktop/internal/components/brand_panel.go`
- Modify: `desktop/internal/components/header.go`
- Modify: `desktop/internal/components/stat_card.go`
- Modify: `desktop/internal/components/shell.go`
- Modify: `desktop/internal/pages/login.go`
- Modify: `desktop/internal/pages/home.go`
- Modify: `desktop/internal/pages/projects.go`
- Modify: `desktop/internal/pages/placeholder.go`

- [x] 以 MyGo 系统主题、强调色、深浅外观和高对比偏好派生语义颜色；保留深绿品牌面板，并修正所有页面中的硬编码对比色。
- [x] 统一标题层级、页面留白、侧栏和 Inspector 分隔、加载/空/错误状态；减少重复边框、同层卡片和重复文案。
- [x] 保留 MyGo Sidebar、Toolbar、Split、SearchField、Table 等原生组件及现有导航、登录、会话和项目行为。
- [x] 使用 MyGo Router 与数值 ContentTransition 提供短促状态反馈；由框架尊重 macOS Reduce Motion，不加入装饰性循环动效。
- [x] 目标验证：`cd desktop && go test ./... -count=1`、`go test -race ./... -count=1`、`CGO_ENABLED=0 go test ./... -count=1`、`go vet ./...`、`go tool mygo vet`、`go tool mygo build -skip-dmg`。

### Task 7：macOS 原生窗口验收

**Files:**
- Inspect: `desktop/build/darwin-arm64/BelieveBoy.app`
- Capture: `.impeccable/review/desktop-macos.png`

**当前结果：** 已启动构建产物并确认 Screen Recording 权限；macOS 窗口列表显示 `loginwindow` / `Display 1 Shield`，未列出 BelieveBoy 窗口，截图复核需在桌面解锁后完成。

- [ ] 启动构建后的原生 App，确认登录、首页、导航、项目表格、Inspector、深浅主题和红黄绿按钮位置。
- [ ] 检查最小窗口尺寸及全屏切换时的标题栏留白、拖动区和子控件点击。
- [ ] 以窗口截图检查圆角、侧栏层级、文字对比和状态布局；修复一轮中能确认的视觉问题。
- [ ] 确认 macOS Reduce Motion 下路由和数值变化不做位移/滚动动画。

### Task 8：让页面内容在固定工作台中切换

**Files:**
- Modify: `desktop/internal/app/app.go`
- Modify: `desktop/internal/app/app_test.go`
- Modify: `desktop/internal/pages/home.go`
- Modify: `desktop/internal/pages/projects.go`
- Modify: `desktop/internal/pages/placeholder.go`

- [x] 在页面路由切换时先复现侧栏背景像素随整页淡入而改变的现象。
- [x] 将已登录工作台放在路由器外部，把 `Router.View` 移入主内容槽；登录仍独立占据窗口。
- [x] 将首页、项目页和占位页拆成内容 / Inspector 渲染入口，保留共享 Toolbar、Sidebar 和 Inspector 布局。
- [x] 添加回归测试：路由切换后页面内容更新，但侧栏背景像素在转场中保持不变。
- [x] 运行桌面端全量测试、竞态测试、无 CGO 测试、`go vet`、`mygo vet` 并重新构建 macOS App。

## 范围外的联调问题

通知计数 API 的 `X-User-Id` 需要整数，而登录返回 UUID。这个身份映射尚未确认，不在本计划里伪造映射或变更 Python API；通知卡片继续如实显示加载失败，待账号与通知用户关系确认后单独处理。
