# BelieveBoy Dashboard 🚀

这是我为自己业务量身打造的运营管理后台，虽然最初参考了 shadcn/ui 的 Dashboard 示例，但现在早已面目全非——功能完全按我的实际需求来定制。

## 为什么要做这个？

之前每次看数据都要各种后台来回切换，麻烦得很，索性自己搞一个统一的入口。核心诉求很简单：
- **销售日报/周报/月报** - 每天看看数据走势
- **产品分析** - 了解哪些产品卖得好
- **项目管理** - 跟进各个项目的进度和状态
- **SKU 成本管理** - 记录和查询产品成本

所以这就是个**垂直领域的运营工具**，不是什么通用模板。

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端 | Next.js 14 + TypeScript + Tailwind CSS |
| UI | shadcn/ui + Radix UI |
| 后端 | FastAPI (Python) + Supabase (PostgreSQL) |
| 认证 | NextAuth.js |
| 图表 | Recharts |
| 表格 | TanStack Table |

## 项目结构

```
believeboyDashboard/
├── frontend/          # Next.js 前端应用
│   ├── app/          # App Router 页面
│   └── components/   # React 组件
├── backend/          # FastAPI 后端
│   ├── app/         # API 逻辑
│   ├── worker/      # 异步任务
│   └── scripts/     # 数据导入脚本
└── Docs/            # 项目文档
```

## 快速开始

### 前端

```bash
cd frontend
pnpm install
pnpm dev
```

### 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 启动 API
./run_api.sh

# 启动 Worker（后台任务）
./run_worker.sh
```

### 数据库迁移

```bash
cd backend
alembic upgrade head
```

## 功能列表

### 📊 数据分析
- 销售日报录入与查看
- 财务月报管理
- 产品销售分析

### 📁 数据管理
- 项目信息维护
- SKU 成本录入与查询

### ⚙️ 系统管理
- 账号权限管理
- 数据导入导出

## 部署

- 前端 → Vercel
- 后端 → VPS (Systemd)
- 数据库 → Supabase

详细部署文档见 `Docs/04-部署指南.md`

## 交流

有 Bug 或者新需求，直接开 Issue。
