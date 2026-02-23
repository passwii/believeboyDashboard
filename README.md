# BelieveBoy Dashboard

一个基于 **Next.js 14 + TypeScript + Tailwind CSS + shadcn/ui** 的现代化 Dashboard 项目，当前已实现侧边栏布局、指标卡片、趋势图表、数据表格、主题切换与命令搜索等核心界面能力。

## 项目概述

BelieveBoy Dashboard 复刻并扩展了 shadcn/ui 的 Dashboard 交互模式，使用 App Router 架构，适合作为后台管理系统、运营看板、数据中台前端模板的基础工程。

当前项目特点：

- `app/` 下使用 Next.js App Router 组织页面与布局
- 内置 `shadcn/ui` 组件体系（Radix UI + Tailwind 变量主题）
- 支持明暗主题切换（`next-themes`）
- 提供可交互数据表格（排序、筛选、分页、列显隐、行选择）
- 提供 Recharts 图表与统计卡片组合视图
- 首页自动重定向到 `/dashboard`

## 技术栈

- Next.js 14
- React 18
- TypeScript 5
- Tailwind CSS 3
- shadcn/ui + Radix UI
- Recharts
- TanStack Table
- next-themes
- lucide-react

## 当前功能

- 仪表盘主布局：侧边栏 + 顶栏 + 主内容区
- 可折叠 Sidebar（`collapsible="icon"`）
- 顶栏快捷入口（主题切换、搜索触发）
- 命令面板搜索（`Cmd/Ctrl + K`）
- 4 个业务指标卡片
- Visitors/Page Views 趋势图（7/30/90 天切换）
- 文档列表数据表格（排序、过滤、列控制、行操作）

## 目录结构

```text
believeboyDashboard/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   └── dashboard/
│       ├── layout.tsx
│       └── page.tsx
├── components/
│   ├── dashboard/
│   ├── ui/
│   ├── theme-provider.tsx
│   └── theme-toggle.tsx
├── hooks/
├── lib/
├── Docs/
├── tailwind.config.ts
├── next.config.js
└── vercel.json
```

## 快速开始

### 1. 环境要求

- Node.js >= 18.17
- pnpm >= 8（推荐）

### 2. 安装依赖

```bash
pnpm install
```

### 3. 启动开发环境

```bash
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)，会自动跳转到 `/dashboard`。

## 常用命令

```bash
pnpm dev     # 本地开发
pnpm build   # 生产构建
pnpm start   # 运行生产构建
pnpm lint    # ESLint 检查
```

## 部署

项目已提供 `vercel.json`，可直接部署到 Vercel：

1. 将仓库连接到 Vercel
2. 使用默认 Next.js 配置（或沿用仓库中的构建命令）
3. 触发部署

## 项目文档

更详细设计与规范在 `Docs/` 目录：

- `Docs/00-项目概述.md`
- `Docs/01-技术架构.md`
- `Docs/02-功能规格.md`
- `Docs/03-开发指南.md`
- `Docs/04-部署指南.md`
