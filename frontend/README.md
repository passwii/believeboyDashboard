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
NEXTAUTH_URL=http://localhost:3200

# 后端 API 地址（仅服务端使用，不暴露到浏览器）
BACKEND_API_BASE_URL=http://localhost:8100
BACKEND_API_KEY=replace_with_backend_api_key
```

说明：

- 前端 `.env.local` 不需要配置 `DATABASE_URL`、`PGHOST` 之类的数据库变量。
- AI Provider 相关变量也不要放前端；`AI_CHAT_PROVIDER_API_KEY`、`AI_CHAT_PROVIDER_BASE_URL`、`AI_CHAT_DEFAULT_MODEL` 等统一放在 `backend/.env`。
- 数据库连接只由后端读取，放在 `backend/.env`。
- 如果前后端部署在同一台 VPS，`BACKEND_API_BASE_URL` 推荐写成 `http://127.0.0.1:8100`。

### 启动开发服务器

```bash
pnpm dev
```

前端将在 `http://localhost:3200` 启动。

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

---

## 📐 DTO 单一来源（BEL-22-3 / BEL-29）

> 后端 Pydantic schema 是契约的**唯一**事实来源；前端 DTO 永远从自动生成的 TypeScript 类型导出，不再手写镜像。

### 流水线

```
backend (Pydantic schemas)
    │  cd backend && make openapi-export
    ▼
frontend/types/api-generated/openapi.json       ← git 跟踪
    │  pnpm gen:api-types
    ▼
frontend/types/api-generated/api.d.ts          ← git 跟踪
    │  pnpm build（自动跑 pnpm gen:api-types:check）
    ▼
漂移 = 编译/构建失败
```

### 日常用法

| 场景 | 命令 |
| --- | --- |
| 后端改了 schema，本地重新生成 | `cd backend && make openapi-export` 然后 `cd ../frontend && pnpm gen:api-types` |
| 改完代码没改 schema，校验契约 | `pnpm gen:api-types:check`（`pnpm build` 会自动跑这一条） |
| 写新业务模块 | **不要**手写 DTO；按 schema 名字从 `@/types/api-generated/api` 取，例如 `import type { components } from '@/types/api-generated/api'`<br/>`type MyDto = components['schemas']['MyDto']` |
| 复用老模块的 re-export 风格 | `import type { HealthData, InspectionReport } from '@/lib/inspection-api'`（已经是从生成类型导出的） |
| 模板 / 工具方法检测契约 | `frontend/lib/__contract-tests__/api-generated-contract.ts` — 编译期 `Expect<Equal<…>>`，后端字段加/改/删都会让 `tsc` 失败 |

### 新增 schema 的流程

1. 在 `backend/app/schemas/<resource>.py` 增改 Pydantic 模型；保证每个 `class` 都有清晰的字段名、类型、`Field(...)` 约束。
2. 后端本地跑 `make openapi-export` 生成最新 `frontend/types/api-generated/openapi.json`，**commit 这个 JSON**。
3. 前端跑 `pnpm gen:api-types` 重新生成 `api.d.ts`，**commit**。
4. 前端代码 `import type { components } from '@/types/api-generated/api'`，按 `components['schemas']['<NewDto>']` 引用。
5. 跑 `pnpm build` 验证（包含 `gen:api-types:check` + `tsc` + `next build`）。
6. 如果是首批迁移目标（inspection / pricing-calculation / digital-employee / ai-insight-schedules），在 `frontend/lib/__contract-tests__/api-generated-contract.ts` 里加一条 `Expect<Equal<…>>` 把新 schema 钉死。

### 禁止事项

- ❌ 不要再为后端 Pydantic schema 写一份平行 TypeScript 镜像。
- ❌ 不要把 `frontend/types/api-generated/openapi.json` 加到 `.gitignore` —— 它是契约的快照，CI 拿来 drift 检查。
- ❌ 不要在 re-export 文件（`lib/inspection-api.ts` 等）里用 `interface` 重新声明 DTO 字段。
- ❌ 跳过 `pnpm gen:api-types:check` —— 后端改动没同步进来时 build 必须红。

### 故障排查

| 报错 | 解决 |
| --- | --- |
| `pnpm gen:api-types:check` 报 `Drift detected` | 跑 `cd backend && make openapi-export`，再 `cd frontend && pnpm gen:api-types`，提交两个文件 |
| `tsc` 报 `Type 'X \| null' is not assignable to type 'X'` | 字段在 Pydantic 里是 `Optional[...] = None`；前端访问前用 `?? ''` / `?? null` 处理 |
| `make openapi-export` 报 `database_url Field required` | 临时给环境变量（开发用）：`DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db API_KEY=test-key FRONTEND_URL=http://localhost:3200 make openapi-export` |
| 新加 schema 但 `pnpm build` 没漂移检测 | 检查 `frontend/package.json` 的 `build` 脚本是否含 `gen:api-types:check && ...` |
