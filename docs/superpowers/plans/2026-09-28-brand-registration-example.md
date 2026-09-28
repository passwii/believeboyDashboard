# 品牌备案示例页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Dashboard 工具箱增加一个符合 V3 Terminal 规范的静态品牌备案拍摄示例页，展示 6 张包装图、4 张产品图和简短拍摄要求。

**Architecture:** 使用 Next.js App Router 新增独立静态页面，素材保存在 `frontend/public/brand-registration-example/` 并由 Next Image 本地加载。将页面接入现有 Sidebar 和 Dashboard 标题元数据；图片分组与说明静态渲染，无新增 API、服务端状态或交互逻辑。CSS Module 容器查询按实际可用宽度决定单栏或桌面两栏，避免终端侧栏/Inspector 挤压内容。

**Tech Stack:** Next.js 16 App Router、React 18、TypeScript、Tailwind CSS、Next Image、CSS Modules、Vitest + Testing Library、macOS `sips`。

## Global Constraints

- 遵循 `frontend/docs/design-spec.md` §0.3 与 `docs/terminal-design/master-prompt.md`：零圆角、零阴影、1px `border-term-border`。
- 只使用 `term-*` 明暗主题令牌；不新增硬编码颜色。
- Padding/Gap 使用 4/8/12px 档位（个别紧凑处可 2px），字号遵循 V3 Terminal 阶梯。
- 包装图 3 列 × 2 排，产品图 2 列 × 2 排；不提供切换、轮播、上传或图片查看器。
- 实际内容宽度不足 768px 时单列；达到 768px 时图片区与说明区约 2:1。
- 不臆断素材无法确认的方位或标签；说明示例木纹背景不是建议的正式拍摄背景。
- 资源不依赖 Downloads 运行时路径；实施已参照 `frontend/node_modules/next/dist/docs/01-app/` 的 App Router、Metadata、CSS Modules 指南。

---

## File Structure

- Create: `frontend/app/dashboard/tools/brand-registration-example/page.tsx` — App Router 入口和 Metadata。
- Create: `frontend/app/dashboard/tools/brand-registration-example/brand-registration-example-page.tsx` — 页面静态内容、素材网格和要求说明。
- Create: `frontend/app/dashboard/tools/brand-registration-example/brand-registration-example-page.module.css` — 基于内容容器宽度的单列/2:1 响应式布局。
- Create: `frontend/app/dashboard/tools/brand-registration-example/brand-registration-example-page.test.tsx` — 内容、图片数量/布局、静态无交互、主题样式契约。
- Create: `frontend/public/brand-registration-example/box-01.jpg` … `box-06.jpg`, `product-07.jpg`, `product-08.jpg`, `product-09.jpg`, `product-10.jpg` — 源图缩放压缩副本，原 PNG 转为 `product-10.jpg`。
- Modify: `frontend/lib/sidebar-config.ts` 和 `frontend/lib/sidebar-config.test.ts` — 工具箱菜单和路由归属契约。
- Modify: `frontend/lib/dashboard-route-meta.ts`；Create: `frontend/lib/dashboard-route-meta.test.ts` — Header 标题映射契约。

## 实施状态

- [x] 工具箱导航契约：先写失败测试，再增加唯一菜单项并验证通过。
- [x] 素材准备：核对 10 张源图；压缩为最长边不超过 1800px 的 JPEG；总大小从约 17MB 降至约 3.7MB。
- [x] 静态页面：包装 6 张 3×2，产品 4 张 2×2；图片替代文本、来源用途说明、拍摄背景要求和客户提示齐全。
- [x] Terminal 视觉：使用 `TermPanel`、`term-*` 令牌、零圆角/零阴影；CSS Module 容器查询适配实际内容列宽。
- [x] 路由/标题：新增 `/dashboard/tools/brand-registration-example` 和「品牌备案示例」元数据标题。
- [x] 目标验证：3 个目标测试文件合计 13 项断言通过；受影响文件 ESLint 退出码 0；`git diff --check` 通过；V3 硬编码样式扫描无命中。
- [x] 构建验证：`pnpm --dir frontend build` 成功，新路由列入静态生成结果。
- [ ] 全量 Vitest：`pnpm --dir frontend test` 在 531 个测试文件的套件中多次未能完成（工具超时/worker 被 SIGKILL，部分运行报告共享终端筛选器测试 worker 超时）。本功能的定向测试通过，完整套件结果未确认。
- [ ] 浏览器人工视觉复核：当前桌面浏览器未连接，未完成 light/dark 页面截屏检查。

## 最终检查说明

- `pnpm --dir frontend lint` 退出码 0；报告仓库中 27 条既有 React Hook / 图片 lint 警告，本次新增页面文件单独 ESLint 无告警。
- Build 伴随 Next.js workspace 多 lockfile 推断和现有 `believeboy-models` 动态文件追踪警告；与新增路由无关，不阻止构建。
- 新增路由已由 build 确认静态生成，图片源存在于 `frontend/public/brand-registration-example/`。
- 全量测试未确认通过，不应表述为全量 suite 通过。
