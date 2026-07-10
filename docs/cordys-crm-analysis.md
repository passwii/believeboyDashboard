# CordysCRM 项目结构分析（→ believeboyDashboard CRM 组件移植参考）

> 调研时间：2026-07-10
> 仓库：[1Panel-dev/CordysCRM](https://github.com/1Panel-dev/CordysCRM)（v1.7.0，2025-11 开源，2026-07 仍在持续迭代）
> 目的：拆解 CordysCRM 内部功能结构，提取可移植到本仓库 Dashboard 的 CRM 组件清单与设计模式

---

## 0. 一句话总览

CordysCRM 是一个**前端是 Vue 3 单体、后端是 Spring Boot 微服务**的传统 CRM。它最大的价值不在于 UI 设计（Naive-UI 中规中矩），而在于它**抽象出了一套"以可配置字段（custom form / custom field / formula）为核心"**的 CRM 工程范式——把线索/客户/商机/合同/订单/产品的属性和流程都做成了"可拖拽配置 + 公式计算 + 审批流"，而不是写死的实体。

**对你的意义**：本仓库是 Next.js 16 + React 19 + Radix/shadcn，不能直接 copy Vue 组件。移植的是 **52 个 business 组件的设计意图** + **9 大业务域的拆解思路** + **以"自定义字段"为核心的 CRM 抽象**。

---

## 1. 仓库整体结构

```
CordysCRM/
├── backend/                       Spring Boot（CRM + 框架 + App 三模块）
│   ├── app/
│   ├── crm/                      业务模块（Clue/Customer/Opportunity/...）
│   └── framework/                自研框架（log/i18n/license/...）
├── frontend/                      pnpm monorepo
│   ├── packages/
│   │   ├── lib-shared/           ⭐ 类型/枚举/工具/方法（web+mobile 共享）
│   │   ├── web/                  PC 端（Naive-UI + Vite）
│   │   └── mobile/               H5 端（Vant-UI + Vite）
│   └── installer/
└── installer/                    Docker 一键部署
```

**对你的启示**：
- `lib-shared` 的拆分是金标准。本仓库现在用 `lib/` 平铺，**至少应该把 CRM 相关的 types/enums/method 拆出 `lib/crm-shared/`**，否则 web 端业务一多就糊成一锅。
- PC + H5 同时维护说明它有强复用诉求。对你来说"先只做 PC"是合理的，但要为后续 H5 留好接口边界（不要把 viewport 相关逻辑写死在业务组件里）。

---

## 2. 前端架构（`frontend/packages/web`）

### 2.1 目录骨架

```
packages/web/src/
├── api/                          axios 封装 + 业务模块接口
│   ├── http/                     httpClient / 拦截器 / 错误码
│   └── modules/                  system/log/... （按业务域分）
├── components/
│   ├── pure/        (34 个)      通用 UI 原子（Card/Table/Modal/Drawer/...）
│   └── business/    (52 个)      CRM 业务组件（crm-table/crm-stage-board/...）
├── views/                       业务页面（薄壳，几乎只组合 business 组件）
│   ├── clueManagement/
│   ├── customer/
│   ├── opportunity/
│   ├── contract/
│   ├── order/
│   ├── product/
│   ├── customForm/              ⭐ 自定义表单设计器入口
│   ├── dashboard/               BI 仪表板（iframe + DataEase）
│   ├── workbench/               工作台/首页
│   ├── system/                  系统管理（org/role/module/...）
│   ├── agent/                   AI 助手
│   └── base/                    login/404/403
├── store/modules/               Pinia（app/user/setting/overview/view）
├── router/routes/modules/       按业务域拆分的路由
├── layout/                      default-layout / full-page / page-content
├── enums/                       业务枚举
├── hooks/                       通用 hooks
├── locale/                      i18n
├── directive/                   v-permission 等指令
├── utils/                       纯函数工具
├── types/                       全局类型
└── models/                      业务模型（与 lib-shared 互补）
```

### 2.2 三层组件分层（最值得学的设计）

| 层 | 路径 | 数量 | 职责 | 对应本仓库 |
|---|---|---|---|---|
| **Pure** | `components/pure/` | 34 | 设计系统原子（Card/Table/Modal/Drawer/Tag/Tree） | `components/ui/`（已有 shadcn） |
| **Business** | `components/business/` | 52 | CRM 业务组件（crm-table/crm-stage-board/crm-formula-editor） | ❌ **需要新建 `components/crm/`** |
| **View** | `views/*/` | ~30 | 业务页面，**极薄壳子** | `app/dashboard/crm/*` |

**关键模式**（可以直接照搬）：
```vue
<!-- views/customer/customer.vue —— 整个文件只有 22 行 -->
<template>
  <div ref="customerCardRef" class="h-full">
    <CrmCard no-content-padding hide-footer>
      <div class="h-full px-[16px] pt-[16px]">
        <CustomerTable :form-key="FormDesignKeyEnum.CUSTOMER" />
      </div>
    </CrmCard>
  </div>
</template>
```
→ View 层只做"布局 + 路由 + 壳"，真正的逻辑（列表/筛选/分页/批量操作）全在 `CustomerTable` business 组件里。**这条铁律必须立住，否则后期每个页面都写一遍筛选器，CRM 就崩了。**

---

## 3. 9 大 CRM 业务域（按销售链路顺序）

| 域 | 路由 | 视图文件 | 核心功能 |
|---|---|---|---|
| **线索 Clue** | `/lead` | `clueManagement/clue/` | 线索列表、领用、转入客户池、批量操作 |
| **线索池** | `/lead/leadPool` | `clueManagement/cluePool/` | 公共线索，规则自动分配/回收 |
| **客户 Account** | `/account` | `customer/customer.vue` | 客户主数据、360° 详情、查重、合并、转移 |
| **联系人 Contact** | `/account/contact` | `customer/contact.vue` | 客户下的联系人（多对一） |
| **公海 OpenSea** | `/account/openSea` | `customer/openSea.vue` | 公共客户池，类似线索池 |
| **商机 Opportunity** | `/opportunity/opt` | `opportunity/index.vue` | 销售管道、阶段流转（Kanban 看板） |
| **报价 Quotation** | `/opportunity/quotation` | `opportunity/quotation.vue` | 报价单（独立实体，可转合同） |
| **产品 Product** | `/product/pro` | `product/index.vue` | 产品库 |
| **价格表 Price** | `/product/price` | `product/price.vue` | 多套价格表（按客户等级/渠道） |
| **合同 Contract** | `/contract` | `contract/contract/` | 合同主数据、审批、归档 |
| **回款计划** | `/contract/contractPaymentPlan` | `contract/contractPaymentPlan/` | 合同分期回款计划 |
| **回款记录** | `/contract/contractPaymentRecord` | `contract/contractPaymentRecord/` | 实际回款流水 |
| **发票 Invoice** | `/contract/contractInvoice` | `contract/invoice/` | 发票登记 |
| **工商抬头** | `/contract/contractBusinessName` | `contract/businessTitle/` | 开票主体管理 |
| **订单 Order** | `/order` | `order/order/` | 订单（与合同可互转） |
| **标讯 Tender** | `/tender` | `tender/index.vue` | 招投标信息抓取（v1.4+） |
| **工作台** | `/workbench` | `workbench/index.vue` | 个人首页：待办/数据卡片/快捷入口/类别 |
| **BI 仪表板** | `/dashboard` | `dashboard/` | **iframe 嵌入 DataEase**（不自渲染图表） |
| **自定义表单** | `/customForm` | `customForm/` | ⭐ 拖拽式表单设计器（CRM 抽象核心） |
| **AI 助手** | `/agent` | `agent/` | Cordys CRM Skills（OpenClaw/WorkBuddy） |

**对你的建议——按销售链路分阶段实施**：

**MVP（先做这 5 个，1-2 周）**：
1. 客户 Account（含联系人 + 公海）
2. 线索 Clue（含线索池）
3. 商机 Opportunity（Kanban 看板）
4. 产品 Product
5. 报价 Quotation

**V2**：合同 + 回款计划 + 回款记录 + 发票 + 工商抬头
**V3**：订单 + 标讯 + 工作台 + AI 助手

---

## 4. 8 大系统管理域（后台）

| 域 | 路由 | 子模块 |
|---|---|---|
| **组织 Org** | `/system/org` | 部门树、成员 |
| **角色 Role** | `/system/role` | 角色 + 成员 + 数据权限（memberTab / permissionTab） |
| **功能模块 Module** | `/system/module` | 自定义业务模块的元数据 |
| **审批流 Process** | `/system/process` | 审批流定义（process + workflow 两层） |
| **消息 Message** | `/system/message` | 系统通知/站内信 |
| **日志 Log** | `/system/log` | 操作日志 |
| **业务设置 Business** | `/system/business` | 业务参数 |
| **许可证 License** | `/system/license` | 商业版 license |

**对 CRM 必做的 3 个**：
- **RBAC（角色 + 数据权限）**——CRM 强需求（销售只能看自己的客户，经理看团队的，老板看全部）
- **操作日志**——合规/审计
- **业务设置**——自定义字段、阶段、来源、状态等都从这进

**审批流/工作流** 复杂度高（用了 `@antv/x6` 画流程图），V2 再说。

---

## 5. ⭐ 52 个 Business 组件清单（核心交付物）

这是你**真正需要重写的部分**。按重要性分组：

### 5.1 表格与筛选（CRM 的 80% 时间都在这里）

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-table** | 通用表格：列配置/分页/批量/导出/拖列/列宽，958 行 + useTable.ts hook | ★★★★★ | **P0** |
| **crm-advance-filter** | 高级筛选（支持自定义字段条件、日期范围、负责人、来源等） | ★★★★ | **P0** |
| **crm-view-select** | 视图切换（保存的筛选条件集合，按角色共享） | ★★★ | **P0** |
| **crm-pagination** | 通用分页 | ★★ | P1 |
| **crm-header-table** | 表头冻结/可拖拽 | ★★★ | P1 |
| **crm-sub-table** | 详情里的子表（如客户下的联系人表） | ★★★★ | P1 |
| **crm-table-export-modal** | 导出弹窗（字段选择 + 格式） | ★★ | P2 |
| **crm-batch-edit-modal** | 批量编辑弹窗 | ★★★ | P2 |
| **crm-batch-form** | 批量表单 | ★★★ | P2 |
| **crm-import-button** | 导入按钮（Excel → 字段映射） | ★★★ | P2 |

### 5.2 表单设计（CRM 灵活性的核心）

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-form-design** ⭐ | 表单设计器（拖拽字段/配置校验/权限） | ★★★★★ | **P0**（或第三期） |
| **crm-form-design-drawer** | 设计器抽屉版 | ★★★★ | P1 |
| **crm-form-create** | 表单实例（基于设计器 schema 渲染） | ★★★★ | **P0** |
| **crm-form-create-drawer** | 抽屉版创建表单 | ★★★ | **P0** |
| **crm-form-create-table** | 表格列配置（哪些字段展示、按什么格式） | ★★★★ | **P0** |
| **crm-formula** ⭐ | 公式引擎（声明式字段联动计算） | ★★★★★ | **P0**（可先做减法版） |
| **crm-formula-editor** | 公式编辑器（语法高亮 + 自动补全） | ★★★★ | P2 |
| **crm-form-description** | 表单说明渲染 | ★★ | P2 |
| **crm-editable-text** | 行内可编辑文本（双击改） | ★★ | P2 |

### 5.3 销售管道（商机 Kanban）

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-stage-board** ⭐ | 商机阶段看板（拖拽换阶段） | ★★★★★ | **P0**（商机页直接用） |
| **crm-status-config-drawer** | 阶段配置抽屉 | ★★★ | P1 |
| **crm-status-flow-modal** | 状态流转规则（哪些阶段能跳到哪些阶段） | ★★★ | P1 |

### 5.4 详情与抽屉（CRM 习惯侧拉抽屉看详情）

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-overview-drawer** ⭐ | 客户/线索/商机详情抽屉（Tabs 组合） | ★★★★★ | **P0** |
| **crm-detail-card** | 详情卡片（字段 + 自定义字段 + 公式结果） | ★★★★ | **P0** |
| **crm-description** | 描述/备注展示（多行文本） | ★★ | P2 |
| **crm-follow-record / crm-follow-drawer** | 跟进记录（每条线索/客户下都有时间线） | ★★★★ | **P0** |

### 5.5 流程与审批

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-flow** ⭐ | 流程图渲染（@antv/x6） | ★★★★★ | V2 |
| **crm-approval** | 审批面板（待我审/我已审/抄送我） | ★★★★ | V2 |
| **crm-process-drawer** | 流程详情抽屉 | ★★★★ | V2 |

### 5.6 业务原子（频繁复用的小东西）

| 组件 | 作用 | 复杂度 | 移植优先级 |
|---|---|---|---|
| **crm-avatar** | 头像（首字母 fallback） | ★★ | P1 |
| **crm-user-select** | 选人（支持搜索/部门/最近选择） | ★★★ | **P0** |
| **crm-user-tag-selector** | 多人 tag 选择 | ★★★ | P1 |
| **crm-member-selector-box** | 成员选择盒 | ★★★ | P1 |
| **crm-select-user-drawer** | 选人抽屉（更复杂场景） | ★★★ | P1 |
| **crm-city-select** | 省市区联动 | ★★★ | P2 |
| **crm-industry-select** | 行业选择（树形） | ★★ | P2 |
| **crm-data-source-select** | 数据来源选择（线索/客户公用枚举） | ★★ | P1 |
| **crm-auto-search-select** | 带远程搜索的下拉 | ★★★ | P1 |
| **crm-tag / crm-tag-group / crm-tag-input** | 标签 | ★★ | P1 |
| **crm-file-input / crm-file-list / crm-file-list-modal** | 文件上传/列表/预览 | ★★★ | P2 |
| **crm-input-number-with-unit** | 带单位的数字输入（金额/百分比） | ★★ | P1 |
| **crm-time-range-picker** | 时间范围选择 | ★★ | P1 |
| **crm-message-list** | 站内信列表 | ★★★ | P2 |
| **crm-task-drawer** | 任务抽屉（跟进/待办） | ★★★ | P1 |
| **crm-operation-button** | 操作按钮组（带权限过滤） | ★★ | P1 |
| **crm-more-action** | 更多操作（下拉） | ★★ | P1 |
| **crm-business-name-prefix** | 业务名称前缀（区分线索/客户/商机） | ★ | P2 |
| **crm-transfer-modal** | 转移弹窗（把客户转给别人） | ★★ | P2 |
| **crm-move-modal** | 移动弹窗（公海/私海） | ★★ | P2 |
| **crm-reason-drawer** | 操作原因抽屉（退回/转公海需要填原因） | ★★ | P2 |
| **crm-duplicate-check-drawer** | 查重抽屉（创建前查重复） | ★★★ | P2 |
| **crm-expire-alert** | 即将到期提醒条 | ★★ | P2 |
| **crm-top-menu** | 顶部操作菜单 | ★★ | P2 |
| **crm-agent-drawer** | AI 助手侧栏 | ★★★ | V3 |
| **crm-tab-setting** | Tab 配置（设置哪些 Tab 可见） | ★★★ | P2 |
| **crm-expand-button** | 展开/收起按钮 | ★ | P2 |
| **crm-sys-upgrade-tip** | 升级提示条 | ★ | P2 |

---

## 6. 移植到本仓库的实施路线图

### 6.1 目录建议

```
believeboyDashboard/frontend/
├── app/dashboard/crm/              新建：CRM 业务页面（路由）
│   ├── leads/
│   ├── customers/
│   ├── opportunities/
│   ├── products/
│   ├── quotations/
│   └── workbench/
├── components/
│   ├── ui/                        （已有 shadcn，不动）
│   └── crm/                       ⭐ 新建：CRM 业务组件（52 个的全部）
│       ├── crm-table/
│       ├── crm-advance-filter/
│       ├── crm-stage-board/
│       ├── crm-overview-drawer/
│       ├── crm-formula/
│       ├── crm-form-create/
│       └── ...
├── lib/
│   ├── crm-shared/                ⭐ 新建：CRM 共享 types/enums/methods
│   │   ├── enums/                 (clueEnum / customerEnum / opportunityEnum ...)
│   │   ├── types/                 (Customer / Clue / Opportunity ...)
│   │   └── method/                (formCreate / exportPdf / validate ...)
│   └── crm-api/                   CRM 后端接口
└── hooks/
    └── use-crm-table.ts           从 useTable.ts 移植
```

### 6.2 实施顺序（建议 4 个 Sprint）

| Sprint | 范围 | 交付物 | 依赖 |
|---|---|---|---|
| **S1（1 周）** | 基础设施 + 客户域 | `crm-table` + `crm-advance-filter` + `crm-overview-drawer` + `customer` 列表+详情 | shadcn 已有，TanStack Table 已有 |
| **S2（1 周）** | 线索 + 公海 | `customer-table` 改造成 `clue-table`，加公海（OpenSea）逻辑 | S1 表格组件 |
| **S3（1-2 周）** | 商机 Kanban + 报价 | `crm-stage-board` + `crm-status-config` + 报价单 | S1 + 一个拖拽库（dnd-kit） |
| **S4（2 周）** | 自定义字段/表单 + 公式引擎 | `crm-formula` + `crm-form-create`（不含设计器）+ `crm-detail-card` | S1-S3 |
| V2 | 合同/订单/回款/发票 | — | 全部前置 |
| V3 | 工作台 + AI 助手 | — | 全部前置 |

### 6.3 关键技术决策

1. **不要做 iframe BI 仪表板**——本仓库 `components/ui/chart.tsx` 已存在，直接用 Recharts/Tremor 画。
2. **自定义字段 vs 写死字段**——MVP 阶段可以**写死核心字段**（姓名/电话/公司/金额/阶段等），自定义字段做 P2。但**接口层要预留 schema 概念**（详情见 §7）。
3. **拖拽库**——商机 Kanban 用 `@dnd-kit/core`（shadcn 生态首选）。
4. **流程图**——V2 再考虑，本期跳过 `@antv/x6`，可换成 `reactflow`。
5. **Pinia → Zustand/Jotai**——本仓库如有状态管理，**不要照搬 Pinia 分模块**的拆分方式，按域拆 store 即可（pinia 模块 = zustand slice）。
6. **i18n**——本仓库若已用 `next-intl`，照搬 lib-shared/locale 的 key 结构（`clue.*` / `customer.*` / `opportunity.*`）。
7. **34 个 pure 组件**——**不要重复造轮子**，直接用 shadcn + 现有 `components/ui/`。CordysCRM 自己造的 Card/Modal/Drawer 在你的栈里就是 shadcn 的 Card/Dialog/Drawer。

---

## 7. 抽象模式提取（最值钱的部分）

### 7.1 Custom Field Schema 模式

CordysCRM 的核心抽象是**自定义字段（Custom Field）**：
- 实体（客户/线索/商机/合同...）的属性**不是写死在 TypeScript interface 里**，而是运行时从 `formDesign` 配置中加载
- 每个字段有：`key / name / type(text/number/select/date/relation/formula)/required / visible_to_roles / default_value`
- 前端渲染详情/表格/筛选时，**根据 schema 动态生成列、筛选项、表单**
- 这就是为什么一个 `crm-table` 组件能同时给客户、线索、商机、合同用——只要传 `formKey` 即可

**对你简化的版本**（不追求完整自定义字段）：
- 第一阶段：**写死核心字段**，但接口层用 `Record<string, FieldValue>` 包一层
- 第二阶段：抽出 `FieldDefinition` 类型 + 渲染器（`renderField(fieldDef, value, mode)`）
- 第三阶段：上拖拽式表单设计器

### 7.2 FormDesignKey 枚举

```ts
// 简化版
enum FormDesignKeyEnum {
  CUSTOMER = 'customer',
  CLUE = 'clue',
  OPPORTUNITY = 'opportunity',
  CONTACT = 'contact',
  PRODUCT = 'product',
  CONTRACT = 'contract',
  ORDER = 'order',
  // ...
}
```
所有需要"自定义字段"的实体都对应一个 formKey。表格组件就靠这个 key 决定拉哪套 schema。

### 7.3 Save View 模式（视图切换）

`crm-view-select` 允许用户把当前筛选条件**保存为视图**（"我关注的客户"/"本周待回款"），下次一键切换。视图按角色共享。

对你：可以先做"个人视图"（只给自己看），后做"团队共享"。

### 7.4 Overview Drawer 模式（侧拉详情）

CRM 几乎所有列表都是"**列表 + 侧拉详情**"结构（不在新页面打开，保留上下文）。**这是必须遵循的 UX 范式**：
- 列表点行 → 右侧 Drawer 滑出详情
- Drawer 里是 Tabs：基本信息 / 跟进记录 / 相关合同 / 操作日志
- Drawer 顶部有"上一条/下一条"翻页按钮

### 7.5 Follow Record 模式

每个核心实体（线索/客户/商机/合同）都有"跟进记录"子表——本质是通用 Timeline 组件：
```ts
type FollowRecord = {
  id: string;
  entityType: 'clue' | 'customer' | 'opportunity' | 'contract';
  entityId: string;
  type: 'call' | 'email' | 'meeting' | 'note' | 'visit' | 'system';
  content: string;
  attachments?: FileRef[];
  nextFollowAt?: Date;
  createdBy: User;
  createdAt: Date;
};
```
**抽出独立 `FollowTimeline` 组件**给所有域共用。

### 7.6 公海 + 线索池 + 回收规则

销售型 CRM 必备的"公海机制"：
- 线索/客户有"所有者"字段
- 超过 N 天无跟进自动回收到公海
- 公海里的线索/客户可被任意销售领取
- 领取有冷却期（如 7 天内不能释放给别人）

**对你**：直接做一个 `useOwnerPool(entityType)` hook 封装逻辑。

### 7.7 数据权限（RBAC 的 CRM 特别版）

普通 RBAC 是"能不能看这个菜单"，CRM 还需要"能看到哪些数据"：
- 本人数据：只看自己拥有的
- 本部门数据：看部门的
- 本部门及子部门：树形下钻
- 全部数据：超管
- 自定义：勾选特定部门/成员

CordysCRM 把这个做到 `role/components/permissionTab.vue`，你需要**单独抽一个 `useDataScope()` hook**。

---

## 8. 移植时容易踩的坑

1. **别照搬 Vue 的 `<script setup>`**——React 用 hooks + JSX 表达，模板思维要转过来。
2. **别照搬 Naive-UI 的写法**——n-button/n-card/n-table 在你这里就是 shadcn 的 Button/Card/Table。
3. **i18n key 不要逐字翻译**——CordysCRM 用 `t('clue.list.title')` 这种域前缀，shadcn/next-intl 也支持，**保持命名空间清晰**即可。
4. **CSS 方案**——它用 Less + scoped，本仓库大概率 Tailwind。**className 用 cn() 工具**拼接即可。
5. **拖拽不要直接用 SortableJS**——它在 React 里很不自然，用 `@dnd-kit`。
6. **公式引擎**——`crm-formula` 是它最复杂的一块（支持 IF/AND/OR/CONCAT/数字函数/日期函数）。MVP 可以只支持：`字段A + 字段B`、`字段A * (1 - 字段B%)` 这种简单表达式，第三方库如 `expr-eval` 或 `mathjs` 都能用。
7. **不要复制 52 个组件**——先做 P0 的 5-6 个，跑通"客户域"全流程，再扩。

---

## 9. 一周内可交付的"客户域 MVP"最小集

如果你想**先做一个能跑通的 Demo**，这一组就够了：

```
components/crm/
├── crm-table/                     (基于 TanStack Table + shadcn)
├── crm-advance-filter/            (基于 react-hook-form + zod)
├── crm-overview-drawer/           (基于 shadcn Drawer + Tabs)
├── crm-detail-card/               (字段渲染)
├── crm-user-select/               (选人)
├── crm-tag/                       (标签)
└── crm-follow-timeline/           (跟进时间线)

app/dashboard/crm/customers/
├── page.tsx                       (列表，22 行壳子)
├── components/customer-table.tsx  (业务表格，~500 行)
└── [id]/page.tsx                  (全屏详情，可选，先用 Drawer)
```

跑通这一个域，就能验证：表格/筛选/详情/选人/跟进/状态流转——后续商机/合同/订单都是 copy + 改 schema。

---

## 10. 后续可挖深的资料

- `frontend/packages/lib-shared/` —— 共享类型/枚举（建议详细读完 enums/）
- `frontend/packages/web/src/components/business/crm-table/useTable.ts` —— 通用表格的 hook 抽象
- `frontend/packages/web/src/components/business/crm-formula/` —— 公式引擎
- `frontend/packages/web/src/components/business/crm-form-design/` —— 表单设计器
- `frontend/packages/web/src/views/customer/components/customerTable.vue` —— 803 行的客户表格全集
- `frontend/packages/web/src/views/opportunity/components/opportunityTable.vue` —— 1093 行的商机表格（含 Kanban 逻辑）
- `backend/crm/src/main/java/cn/cordys/crm/` —— 后端领域模型（验证前端理解的实体关系）

---

## 附录 A：CRM 实体关系图（基于代码推断）

```
Clue (线索) ──转化──> Customer (客户) ──1:N──> Contact (联系人)
   │                      │
   │                      │ 1:N
   │                      ↓
   │                  Opportunity (商机) ──1:N──> Quotation (报价)
   │                      │                          │
   │                      │ 1:1                      │ 1:1
   │                      ↓                          ↓
   │                  Contract (合同) ←─────────────┘
   │                      │
   │                      │ 1:N
   │                      ├──> PaymentPlan (回款计划)
   │                      ├──> PaymentRecord (回款记录)
   │                      └──> Invoice (发票)
   │
   └──> OpenSea (公海：客户 + 线索共用)
        └──> CluePool (线索池)

Product (产品) ──M:N──> PriceBook (价格表)
   └── 出现在 Quotation / Contract / Order 的子表里

Order (订单) ←→ Contract (可互转)

Tender (标讯) 独立实体，定期抓取/手动录入

FollowRecord (跟进) ──多态──> Clue | Customer | Opportunity | Contract
```

## 附录 B：本仓库已有可复用资源

- `components/ui/chart.tsx` —— 图表（替代 DataEase iframe）
- `components/ui/data-card.tsx` —— 数据卡片（替代 BI 仪表板）
- `components/ui/calendar-with-presets.tsx` —— 日期选择（替代 crm-time-range-picker）
- `components/ui/empty-state.tsx` —— 空态
- `lib/dashboard-format.tsx` / `lib/dashboard-route-meta.ts` —— 仪表板/路由元数据
- `lib/excel-styles.ts` / `lib/product-analysis-export.ts` —— Excel 导出（替代 crm-table-export-modal）
- `lib/commission.ts` / `lib/pricing-calculation-api.ts` —— 计算/定价（CRM 公式引擎的种子）
- `lib/api/` —— 后端接口（CRM API 接入点）
