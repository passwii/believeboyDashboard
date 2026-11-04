# Wave 1 Shared Warm Ledger Frame

> Status: complete on 2026-11-04. This record covers only the shared route, navigation, title, and breadcrumb frame. Page bodies remain in Wave 2.

## Route contract

The shared frame now recognizes 45 exact/dynamic Warm route templates:

- 10 existing C1-C3 templates.
- 4 C5 Finance routes.
- 10 C6 CRM routes, including one proposal-detail pattern.
- 8 C7-AI routes, including one digital-employee detail pattern.
- 5 C7-Tools dashboard routes.
- 8 C7-System routes.

### C5 Finance

| Route | Title | Breadcrumb section |
| --- | --- | --- |
| `/dashboard/finance/platform-revenue` | 平台回款 | 财务资金 |
| `/dashboard/finance/exchange-rate` | 汇率信息 | 财务资金 |
| `/dashboard/finance/vat-invoice` | VAT 发票 | 财务资金 |
| `/dashboard/finance/commission-management` | 佣金管理 | 财务资金 |

`/dashboard/finance/vat-invoices` remains a redirect and is outside Warm.

### C6 CRM

| Route | Title | Breadcrumb section |
| --- | --- | --- |
| `/dashboard/crm/dashboard` | 数据看板 | CRM 客户与合作伙伴 |
| `/dashboard/crm/follow-ups` | 待跟进 | CRM 客户与合作伙伴 |
| `/dashboard/crm/customers` | 客户 | CRM 客户与合作伙伴 |
| `/dashboard/crm/sea` | 客户公海 | CRM 客户与合作伙伴 |
| `/dashboard/crm/proposals` | 客户方案 | CRM 客户与合作伙伴 |
| `/dashboard/crm/proposals/[id]` | 客户方案详情 | CRM 客户与合作伙伴 |
| `/dashboard/crm/leads` | 线索 | CRM 客户与合作伙伴 |
| `/dashboard/crm/tasks` | 任务 | CRM 客户与合作伙伴 |
| `/dashboard/crm/audit` | 操作日志 | CRM 客户与合作伙伴 |
| `/dashboard/crm/settings` | CRM 设置 | CRM 客户与合作伙伴 |

The proposal pattern accepts exactly one non-empty segment. `/dashboard/crm`, `/dashboard/crm/workbench`, and nested proposal subroutes remain outside Warm. The CRM sea route maps its current navigation state to the configured customer item.

### C7-AI

| Route | Title | Breadcrumb section |
| --- | --- | --- |
| `/dashboard/ai/insights` | AI洞察 | AI 智能 |
| `/dashboard/ai/ad-analysis` | AI 广告分析 | AI 智能 |
| `/dashboard/ai/inventory-health` | AI 库存健康 | AI 智能 |
| `/dashboard/ai/believeboy-models` | 模型选型 | AI 智能 |
| `/dashboard/ai/customer-service` | 客服交流 | AI 智能 |
| `/dashboard/ai/digital-employees` | 数字员工 | AI 智能 |
| `/dashboard/ai/digital-employees/[id]` | 数字员工详情 | AI 智能 |
| `/dashboard/ai/digital-employees/office` | 虚拟办公室 | AI 智能 |

The employee-detail pattern excludes `office`, accepts exactly one non-empty segment, and is checked after the exact office route. `/dashboard/ai` and `/dashboard/ai/chat` remain visual exceptions in the existing shell.

### C7-Tools

| Route | Title | Breadcrumb section |
| --- | --- | --- |
| `/dashboard/tools/markdown-to-word` | Markdown 转 Word | 工具箱 |
| `/dashboard/tools/page-render` | Markdown / HTML 渲染 | 工具箱 |
| `/dashboard/tools/brand-registration-example` | 品牌备案示例 | 工具箱 |
| `/dashboard/tools/product-label` | 产品标签制作 | 工具箱 |
| `/dashboard/tools/cross-border-compliance` | 跨境电商合规 | 工具箱 |

Public `/p/[id]` remains outside the dashboard shell. White document-preview surfaces remain page-owned exceptions.

### C7-System

| Route | Title | Breadcrumb section |
| --- | --- | --- |
| `/dashboard/system/account-management` | 系统账号管理 | 系统管理 |
| `/dashboard/system/agent-management` | Agent 接入管理 | 系统管理 |
| `/dashboard/system/alerts` | 告警中心 | 系统管理 |
| `/dashboard/system/changelog` | 更新日志 | 系统管理 |
| `/dashboard/system/data-management` | 数据库状态 | 系统管理 |
| `/dashboard/system/logs` | 日志查看 | 系统管理 |
| `/dashboard/system/operator-management` | 运营管理 | 系统管理 |
| `/dashboard/system/project-info` | 项目信息 | 系统管理 |

`/dashboard/system/digital-display` remains a forced-dark/full-screen exception.

## Navigation contract

- `sidebar-config.ts` remains the single navigation data source.
- Finance, CRM, AI, Tools, and System expose every configured item in their group instead of linking only the group's first item.
- Agent management is shown in the System section because it is one of the eight C7-System Warm routes, while its label and icon still come from `sidebar-config.ts`.
- Existing C1/C2/C3 links and the four QuickLinks remain unchanged.
- Active navigation uses the route metadata's explicit `navHref`, not broad prefix matching. Detail routes therefore activate their list item, and exact Office takes precedence over the employee-detail pattern.
- All navigation hrefs remain unique.

## Exceptions and follow-ups

- Dashboard visual exceptions: `/dashboard/ai`, `/dashboard/ai/chat`, `/dashboard/system/digital-display`.
- Redirect-only routes: `/dashboard/finance/vat-invoices`, `/dashboard/crm`, `/dashboard/crm/workbench`.
- Coupled non-dashboard surface: public `/p/[id]`.
- Page-owned exceptions: Office presentation mode and Tools white document previews.
- The five audit security follow-up areas remain outside this visual frame work: Finance access scope, system-management authorization, alert/log visibility, CRM write boundaries, and Page Render public deletion/cache behavior.
