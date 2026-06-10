# VAT 发票生成器：多国家 Seller 支持 + 字段精简

**日期**：2026-06-10
**范围**：frontend/app/dashboard/data-management/vat-invoice/
**目的**：支持一个店铺在多个欧洲国家有 VAT 主体（按国家切换 Seller），精简表单字段，并限定只对欧洲店铺可见。

---

## 1. 背景与动机

### 现状问题

当前 `VAT 发票生成器`模块假设"一个店铺只有一个 VAT 主体"：

- `InvoiceSeller` 类型是单数结构，存到 `projects.project_context.invoice_seller`（单数键）。
- `SellerCard` 选店铺后直接加载该单数 Seller；UI 上没有国家切换。

实际业务中存在"一个店铺有多个欧洲国家 VAT 主体"的情况（例如弥森同时在 DE 与 UK 注册了 VAT）。当前结构无法表达这个语义。

另外，三个表单字段（**Bill ID\***、**Bill HS\***、**交付日期\***）目前被当作必填，但实际开票流程不需要这些，应移除。

### 范围

| 范围 | 处理 |
|------|------|
| 一个店铺多个欧洲国家 VAT 主体 | **新增**：店铺下挂多个 Seller 条目，每条对应一个国家 |
| 字段精简（Bill ID/Bill HS/交付日期） | **删除**：从 InvoiceForm 数据结构、UI、校验、PDF 输出整体移除 |
| 非欧洲店铺的入口 | **屏蔽**：店铺下拉前端按白名单过滤，只对弥森可见 |
| 后端 schema | **小改**：ProjectContext 增加可选字段 `invoice_sellers`（复数） |

不在范围：
- 自动同步欧洲店铺元数据到项目表
- VAT 主体按订单国家自动匹配（仍由用户手动选国家）
- 后端权限收紧

---

## 2. 数据模型

### 2.1 新 TypeScript 类型（`frontend/app/dashboard/data-management/vat-invoice/types.ts`）

**删除**：

```typescript
export interface InvoiceSeller {
  company_name: string
  vat_id: string
  address_line: string
  postal_code: string
  city: string
  country: string
}
```

**新增**：

```typescript
/** 单个国家的 Seller 条目（VAT 主体） */
export interface InvoiceSellerEntry {
  /** ISO 2 字母国家代码，作为列表内唯一性约束 */
  country: string
  company_name: string
  vat_id: string
  address_line: string
  postal_code: string
  city: string
}
```

**`InvoiceForm` 字段精简**：删除 `bill_id`、`bill_hs`、`delivery_date` 三个字段。新的最小必填集合：

```typescript
export interface InvoiceForm {
  project_id: number | null
  currency: Currency
  order_id: string
  invoice_date: string
  buyer: InvoiceBuyer
  line_items: InvoiceLineItem[]
  shipping_incl_vat: number
}
```

**`ProjectContext` 扩展**：新增可选字段 `invoice_sellers`。

```typescript
export interface ProjectContext {
  project_id: number
  project_name: string
  project_context: {
    invoice_sellers?: InvoiceSellerEntry[]
  } | null
  sku_context: unknown
}
```

### 2.2 持久化

`projects.project_context.invoice_sellers` 持久化为 JSON 数组。

后端 `ProjectContext` schema（`backend/app/schemas/project.py`）的 `project_context` 字段（`JSONB`）已经接受任意键；**后端代码无需修改**，只是新增了一个推荐键名。

### 2.3 旧数据迁移

**触发时机**：前端在 `fetchProjectContext()` 拿到结果后，运行时做一次惰性迁移：

- 若 `project_context.invoice_seller`（单数）存在且非空，且 `invoice_sellers`（复数）不存在 → 自动转成 `[{...invoice_seller}]`，并 PATCH 写回。
- 转换规则：`{ ...invoice_seller, country: invoice_seller.country || "" }`。
- 转换后保留原 `invoice_seller` 单数字段作为冗余备份（不删除，避免回滚困难）。

**前端白名单常量**（`frontend/app/dashboard/data-management/vat-invoice/lib/invoice-api.ts`）：

```typescript
/** VAT 发票功能启用的店铺白名单（暂时只允许弥森） */
export const VAT_ENABLED_PROJECT_NAMES = ["弥森"] as const
```

未来若其他项目启用 VAT，将名字加入此数组即可。

---

## 3. UI 变更

### 3.1 SellerCard（1. 店铺与 Seller 信息）

**改造点**：

1. **店铺下拉过滤**：在 `projects` 列表渲染时追加 `.filter(p => VAT_ENABLED_PROJECT_NAMES.includes(p.name as any))`。
2. **国家下拉**（新增）：在选完店铺后显示，仅在该店铺的 `invoice_sellers` 列表里提取去重后的 `country` 值。空时显示提示"尚未配置任何国家的 VAT 主体"。
3. **当前 Seller 预览**：根据选中的国家展示对应 Seller 字段。
4. **编辑 Seller 对话框**：
   - 标题从"编辑 Seller 信息"改为"编辑 {国家} Seller"，country 字段也允许编辑（增删国家的入口）。
   - 删除国家时弹出确认（删除后该国家不再可切换）。
5. **新增 Seller 按钮**：在国家下拉旁加 "+" 按钮，点击弹出对话框填一个新国家的 Seller。
6. **Fallback**：当 `invoice_sellers` 为空数组时，仍用 `buildFallbackSeller()` 推断一个 Seller，但**不持久化**。给出黄条提示"尚未配置 Seller，请点击右上角编辑"。

### 3.2 InvoiceFormSection（2. 订单与买方）

**删除字段**：

- `<Label>Bill ID *</Label>` 与对应 Input
- `<Label>Bill HS *</Label>` 与对应 Input
- `<Label>交付日期 *</Label>` 与对应 DatePicker

**保留**：

- 币种、Order ID *、发票日期 *、买方（Bill To）所有字段

**布局调整**：第一行从 `md:grid-cols-4` 改为 `md:grid-cols-2`（币种 + Order ID），第二行只保留发票日期。

### 3.3 InvoiceSummary / InvoicePreviewDialog / invoice-pdf.ts

- `InvoiceSummary`：不变（与字段无关）。
- `InvoicePreviewDialog` / `invoice-pdf.ts`：移除 Bill ID / Delivery Date / HS Code 相关输出。
  - `meta` 表中 `["Invoice #", form.bill_id]` 改为 `["Invoice #", form.order_id]`。
  - 删除 `["Delivery Date", ...]`、`["HS Code", ...]` 之类的字段（如有）。

### 3.4 vat-invoice-client.tsx

- `initialForm`：删除 `bill_id`、`bill_hs`、`delivery_date` 三个字段。
- `emptySeller`：删除（改为 `emptySellerEntry`）。
- `canPreview` 校验：删除 `!form.bill_id.trim()`、`!form.bill_hs.trim()`、`!form.delivery_date` 三条。

---

## 4. 组件与文件改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `frontend/app/dashboard/data-management/vat-invoice/types.ts` | 改 | `InvoiceSeller` → `InvoiceSellerEntry`；`InvoiceForm` 删除 3 字段；`ProjectContext` 加字段 |
| `frontend/app/dashboard/data-management/vat-invoice/lib/invoice-api.ts` | 改 | 新增 `VAT_ENABLED_PROJECT_NAMES`；`patchInvoiceSeller` → `patchInvoiceSellers`；新增迁移辅助函数 |
| `frontend/app/dashboard/data-management/vat-invoice/components/seller-card.tsx` | 改 | 店铺白名单过滤；新增国家下拉；编辑对话框支持新增/删除国家；空列表回退 |
| `frontend/app/dashboard/data-management/vat-invoice/components/invoice-form.tsx` | 改 | 删除 3 个字段 UI 与对应 update 调用 |
| `frontend/app/dashboard/data-management/vat-invoice/vat-invoice-client.tsx` | 改 | `initialForm` 调整；`canPreview` 校验调整；`InvoiceSeller` → `InvoiceSellerEntry` |
| `frontend/app/dashboard/data-management/vat-invoice/lib/invoice-pdf.ts` | 改 | 删除 Bill ID/Delivery Date/HS Code 相关行 |
| `frontend/app/dashboard/data-management/vat-invoice/components/invoice-preview-dialog.tsx` | 改 | 同上（如果它本身有输出这些字段） |

**后端**：

- 不动 schema 代码（JSONB 已支持任意键）。
- 不新增 alembic 迁移（`project_context` 字段已存在）。

---

## 5. 行为细节

### 5.1 国家切换流程

1. 用户选店铺 → 加载该店铺的 `invoice_sellers` 列表。
2. 若列表为空 → 显示回退 Seller（来自项目表）+ 黄条提示，**不持久化**。
3. 若列表非空 → 自动选中列表第一个国家的 Seller 展示；用户可切换国家。
4. 切换国家 → 表单不动，只是 `seller` state 切换为对应国家的条目。
5. 点击"编辑 Seller"或"+" → 进入对话框，保存时 PATCH 整个 `invoice_sellers` 数组（合并语义）。

### 5.2 旧数据迁移触发条件

- 首次 `fetchProjectContext()` 返回结果后，若同时满足：
  - `project_context.invoice_seller` 存在且非空
  - `project_context.invoice_sellers` 不存在或为空数组
- 则执行转换并 PATCH。

### 5.3 非白名单店铺行为

- 店铺下拉中不出现。
- 即使通过 URL 直接访问或旧的 localStorage 残留选择了非白名单店铺，UI 显示占位提示："该店铺暂未启用 VAT 发票功能"。
- 不调用 `fetchProjectContext`，避免误加载。

---

## 6. 测试

### 6.1 强制技术测试

- `cd frontend && pnpm lint`：每次改动后必跑。
- `cd frontend && pnpm build`：提交前必跑。
- 后端：`pytest`：现有测试应通过；`ProjectContext` schema 是 JSONB，不影响后端。

### 6.2 业务测试清单

| 编号 | 测试项 | 期望 |
|------|--------|------|
| T1 | 打开 `/dashboard/data-management/vat-invoice` | 页面正常加载 |
| T2 | 店铺下拉只显示"弥森"，其他项目（按现有数据）不显示 | 通过 |
| T3 | 选弥森 → 若未配置 Seller，显示黄条提示 | 通过 |
| T4 | 点击"编辑 Seller"，保存一个国家的 Seller（如 DE） | 保存成功，刷新页面后保留 |
| T5 | 点击"+" 新增第二个国家 Seller（如 UK），切换国家下拉 | Seller 字段随之变化 |
| T6 | 删除国家 Seller，刷新 | 该国家 Seller 不再出现 |
| T7 | 切换国家时，"买家/订单/明细行"表单内容不变 | 不变 |
| T8 | 不填 Bill ID/Bill HS/交付日期，按钮"预览并导出 PDF" 不再被这三个字段阻止 | 通过 |
| T9 | PDF 中不再含 "Bill ID"、"Delivery Date"、"HS Code" 字段 | 通过 |
| T10 | 旧数据迁移：手动在数据库里给某个项目写入 `invoice_seller` 单数字段 | 前端加载后自动迁移到 `invoice_sellers` 复数字段 |

---

## 7. 风险与回滚

- **风险 1**：旧数据迁移可能误触发。
  - 缓解：迁移前严格检查 `invoice_sellers` 已存在则跳过；保留旧字段冗余。
- **风险 2**：店铺下拉过滤后用户看不到原本能选的店铺。
  - 缓解：白名单常量集中在一处（`VAT_ENABLED_PROJECT_NAMES`），扩展只需修改该数组。
- **回滚**：所有变更都在前端；后端不动。回滚只需 `git revert`。

---

## 8. 后续可能（非本次范围）

- VAT 主体按订单国家自动匹配（自动从 `invoice_sellers` 选出与买方 country 一致的条目）。
- 把 VAT 主体配置从 ProjectContext JSONB 提到独立表 `project_vat_registrations`，便于按国家索引和报表统计。
- 后端权限控制：仅 admin 可修改 VAT 主体配置。