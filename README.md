# BelieveBoy Dashboard 🚀

这是一个为跨境电商业务定制的运营管理后台，虽然最初参考了 shadcn/ui 的 Dashboard 示例，但现在早已面目全非——功能完全按实际业务需求来定制。

## 📋 项目概述

BelieveBoy Dashboard 是一个**垂直领域的跨境电商运营工具**，旨在为运营团队提供统一的数据管理和分析平台。系统整合了多平台销售数据、库存管理、财务核算、佣金计算等核心业务功能，大大提升了运营效率。

## 🎯 核心功能

### 🧭 运营导航
- **运营总览** - 快速查看关键业务指标和概况
- **站点导航** - 多站点销售数据集中管理
- **店铺导航** - 统一管理多个电商店铺

### 🤖 AI 面板
- **AI 聊天** - 智能对话助手，支持业务业务数据分析和决策建议

### 📊 报表核算
- **销售日报** - 每日销售数据录入、查看和趋势分析
- **财务月报** - 月度财务数据汇总、审核和管理
- **产品分析** - 产品销售表现、利润分析和库存建议

### 📈 数据分析
- **月度财务分析** - 深度财务分析，包含收入、成本、利润等多维度指标
- **按周产品分析** - 产品周度表现跟踪，识别销售趋势和季节性模式
- **业务报告** - 综合业务分析报告，支持多维度数据对比
- **广告分析** - 广告投放效果分析和 ROI 评估
- **库存销售分析** - 库存周转率、动销率等关键指标分析

### 🛠️ 数据管理
- **SKU 成本管理** - 产品成本录入、更新和查询，支持批量导入
- **汇率信息管理** - 多币种汇率维护，支持图片上传和自动更新
- **项目信息管理** - 品牌项目信息维护，支持关联店铺和地址管理

### ⚙️ 系统管理（管理员权限）
- **数据库状态监控** - 数据库连接状态和性能指标监控
- **账号管理** - 用户账号创建、权限分配和密码管理
- **佣金总览** - 团队成员佣金统计和汇总
- **提成管理** - 提成比例配置、计算规则管理和记录查询
- **数据导入导出** - 支持数据批量导入和导出功能

### 🚧 运营协作（开发中）
- 工作日历
- 运营工作台
- 运营公告

## 🏗️ 技术架构

| 类别 | 技术选型 | 说明 |
|------|----------|------|
| **前端** | Next.js 14 | React 框架，支持 App Router |
| **前端** | TypeScript | 类型安全的 JavaScript 超集 |
| **前端** | Tailwind CSS | 原子化 CSS 框架 |
| **前端** | shadcn/ui | 现代化 UI 组件库 |
| **前端** | Radix UI | 无障碍、可访问的组件基础 |
| **前端** | NextAuth.js | Next.js 的认证解决方案 |
| **前端** | Recharts | React 图表库 |
| **前端** | TanStack Table | 功能强大的数据表格组件 |
| **后端** | FastAPI | 现代高性能 Python Web 框架 |
| **后端** | SQLAlchemy | Python SQL 工具包和 ORM |
| **后端** | Alembic | 数据库迁移工具 |
| **后端** | Celery | 分布式任务队列（当前不依赖 Redis） |
| **数据库** | PostgreSQL | 强大的开源关系数据库 |
| **部署** | Vercel | 前端部署平台 |
| **部署** | Systemd | 后端服务管理（VPS） |

## 📂 项目结构

```
believeboyDashboard/
├── frontend/                      # Next.js 前端应用
│   ├── app/                      # App Router 页面
│   │   ├── dashboard/            # 仪表盘页面
│   │   │   ├── ai-panel/         # AI 面板
│   │   │   ├── change-password/  # 修改密码
│   │   │   ├── data-analysis/     # 数据分析
│   │   │   ├── data-management/   # 数据管理
│   │   │   ├── data-reporting/   # 报表核算
│   │   │   ├── operations/       # 运营导航
│   │   │   └── system-management/ # 系统管理
│   │   ├── api/                  # API 路由
│   │   ├── layout.tsx            # 根布局
│   │   └── page.tsx              # 首页
│   ├── components/               # React 组件
│   │   ├── dashboard/            # 仪表盘组件
│   │   └── ui/                   # shadcn/ui 组件
│   ├── lib/                      # 工具库
│   └── package.json             # 前端依赖
├── backend/                      # FastAPI 后端
│   ├── app/                      # 应用代码
│   │   ├── api/                  # API 路由
│   │   │   └── v1/endpoints/     # v1 API 端点
│   │   ├── core/                 # 核心配置
│   │   ├── db/                   # 数据库连接
│   │   ├── models/               # SQLAlchemy 模型
│   │   ├── schemas/              # Pydantic 数据模型
│   │   ├── services/             # 业务逻辑服务
│   │   └── tasks/                # 后台任务
│   ├── alembic/                  # 数据库迁移
│   ├── scripts/                  # 数据导入脚本
│   ├── tests/                    # 测试文件
│   ├── worker/                   # 任务执行器
│   └── requirements.txt          # 后端依赖
├── .gitignore                    # Git 忽略配置
└── README.md                     # 项目文档
```

## 🚀 快速开始

### 环境要求
- Node.js 18+
- Python 3.9+
- PostgreSQL 12+
- pnpm（推荐）

### 前端设置

```bash
cd frontend
pnpm install
cp .env.example .env.local  # 配置环境变量
pnpm dev
```

前端将在 `http://localhost:3000` 启动。

### 后端设置

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # 配置环境变量

# 启动 API 服务器
./run_api.sh
```

API 服务器将在 `http://localhost:8000` 启动。

### 数据库初始化

```bash
cd backend
source .venv/bin/activate

# 运行数据库迁移
alembic upgrade head

# 创建初始管理员用户
python scripts/seed_admin_user.py

# 导入基础数据（可选）
python scripts/init_and_import_projects.py
```

## 🔑 后端 API 端点

| 端点 | 功能 |
|------|------|
| `/api/v1/health` | 健康检查 |
| `/api/v1/auth/` | 认证授权 |
| `/api/v1/users/` | 用户管理 |
| `/api/v1/projects/` | 项目管理 |
| `/api/v1/product-costs/` | 产品成本管理 |
| `/api/v1/daily-reports/` | 销售日报 |
| `/api/v1/monthly-reports/` | 财务月报 |
| `/api/v1/product-analysis/` | 产品分析 |
| `/api/v1/product-analysis-reports/` | 产品分析报告 |
| `/api/v1/ai-chat/` | AI 聊天服务 |
| `/api/v1/jobs/` | 任务管理 |
| `/api/v1/uploads/` | 文件上传 |
| `/api/v1/system-management/` | 系统管理 |

## 🗄️ 数据模型

系统包含以下核心数据模型：
- **用户管理** - `user_accounts`、`project_role_assignments`
- **项目管理** - `projects`
- **产品成本** - `product_costs`、`product_analysis_sources`
- **报表数据** - `daily_reports`、`monthly_reports`
- **佣金管理** - `commission_records`、`commission_ratio_overrides`、`commission_project_month`
- **AI 功能** - `ai_chat`
- **任务管理** - `jobs`

## 📦 部署

### 前端部署
```bash
cd frontend
vercel --prod
```

### 后端部署（VPS + Systemd）
```bash
cd backend
./scripts/systemd-install.sh
```

这将创建并启用 Systemd 服务：
- `believeboy-api.service` - API 服务器
- `believeboy-worker.service` - 后台任务执行器

### 数据库
- 生产环境建议使用独立的 PostgreSQL 实例
- 配置定时备份策略

## 📖 详细文档

更多详细信息请参考：
- [后端 README](./backend/README.md) - 后端详细文档
- [Redis 恢复计划](./backend/REDIS_PLAN.md) - Redis 集成计划
- [报告处理规范](./backend/docs/report-processing-sync-spec.md) - 报告处理同步规范

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📝 许可证

内部使用项目。
