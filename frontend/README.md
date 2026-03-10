# Frontend (Next.js)

## 📋 环境要求

- Node.js 18+
- pnpm（推荐）或 npm

## 🚀 快速开始

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

```bash
cp .env.example .env.local
```

编辑 `.env.local` 文件，配置以下变量：

```env
# NextAuth 配置
NEXTAUTH_SECRET=your-secret-key
NEXTAUTH_URL=http://localhost:3000

# 后端 API 地址（仅服务端使用，不暴露到浏览器）
BACKEND_API_BASE_URL=http://localhost:8000
BACKEND_API_KEY=replace_with_backend_api_key
```

### 启动开发服务器

```bash
pnpm dev
```

前端将在 `http://localhost:3000` 启动。

## 📦 构建与部署

### 本地构建

```bash
pnpm build
pnpm start
```

### 部署到 Vercel

```bash
cd frontend
vercel --prod
```

## 📁 项目结构

```
frontend/
├── app/                          # Next.js App Router
│   ├── dashboard/                # 仪表盘页面
│   │   ├── ai-panel/             # AI 面板
│   │   ├── change-password/      # 修改密码
│   │   ├── data-analysis/        # 数据分析
│   │   ├── data-management/      # 数据管理
│   │   ├── data-reporting/       # 报表核算
│   │   ├── operations/           # 运营导航
│   │   └── system-management/    # 系统管理
│   ├── api/                      # API Route Handlers
│   │   ├── admin/                # 管理员 API
│   │   ├── auth/                 # 认证 API
│   │   └── ...
│   ├── layout.tsx                # 根布局
│   ├── page.tsx                  # 首页
│   └── globals.css               # 全局样式
├── components/                   # React 组件
│   ├── dashboard/                # 仪表盘专用组件
│   └── ui/                       # shadcn/ui 组件
├── lib/                          # 工具库
│   ├── auth/                     # 认证相关
│   └── server/                   # 服务端工具
├── public/                       # 静态资源
├── .env.example                  # 环境变量示例
├── .env.local                    # 本地环境变量（不提交）
├── next.config.js                # Next.js 配置
├── tailwind.config.ts            # Tailwind CSS 配置
├── tsconfig.json                 # TypeScript 配置
└── package.json                  # 依赖配置
```

## 🛠️ 技术栈

- **Next.js 14** - React 框架，支持 App Router
- **TypeScript** - 类型安全的 JavaScript 超集
- **Tailwind CSS** - 原子化 CSS 框架
- **shadcn/ui** - 现代化 UI 组件库
- **Radix UI** - 无障碍、可访问的组件基础
- **NextAuth.js** - Next.js 的认证解决方案
- **Recharts** - React 图表库
- **TanStack Table** - 功能强大的数据表格组件

---

## 🔗 相关文档

- [完整前端设置指南](../docs/02-快速开始/frontend-setup.md)
- [项目概述](../docs/01-项目概述/project-overview.md)
- [API 文档](../docs/04-API 文档/api-endpoints.md)
