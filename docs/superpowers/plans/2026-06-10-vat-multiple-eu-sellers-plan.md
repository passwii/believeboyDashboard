# VAT 多国家 Seller 支持 + 字段精简 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 支持一个店铺在多个欧洲国家有 VAT 主体（按国家切换 Seller），精简表单字段，并限定只对欧洲店铺可见。

**架构：** `InvoiceSeller` 单数结构改为 `InvoiceSellerEntry[]` 复数结构（按国家索引）。店铺下拉前端按白名单过滤。删除 Bill ID / Bill HS / Delivery Date 三个字段。旧数据惰性迁移。

**技术栈：** Next.js 14 App Router, React 18, TypeScript, shadcn/ui, jsPDF

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `frontend/app/dashboard/data-management/vat-invoice/types.ts` | 共享类型定义 | 修改：`InvoiceSeller` → `InvoiceSellerEntry`；`InvoiceForm` 删 3 字段；`ProjectContext` 加字段 |
| `frontend/app/dashboard/data-management/vat-invoice/lib/invoice-api.ts` | API 客户端 | 修改：新增 `VAT_ENABLED_PROJECT_NAMES` 白名单；`patchInvoiceSeller` → `patchInvoiceSellers`；新增迁移函数 |
| `frontend/app/dashboard/data-management/vat-invoice/vat-invoice-client.tsx` | 主客户端协调器 | 修改：`initialForm` 删 3 字段；`canPreview` 校验调整；Seller 类型切换 |
| `frontend/app/dashboard/data-management/vat-invoice/components/seller-card.tsx` | 店铺与 Seller 信息卡片 | 修改：白名单过滤；新增国家下拉；编辑对话框支持新增/删除国家 |
| `frontend/app/dashboard/data-management/vat-invoice/components/invoice-form.tsx` | 订单与买方表单 | 修改：删除 Bill ID / Bill HS / 交付日期 3 个字段 UI |
| `frontend/app/dashboard/data-management/vat-invoice/components/invoice-preview-dialog.tsx` | PDF 预览对话框 | 修改：`InvoiceSeller` → `InvoiceSellerEntry` |
| `frontend/app/dashboard/data-management/vat-invoice/components/invoice-summary.tsx` | 实时 VAT 汇总 | 不变（与字段无关） |
| `frontend/app/dashboard/data-management/vat-invoice/lib/invoice-pdf.ts` | PDF 渲染 | 修改：删除 Bill ID / Delivery Date / HS Code 输出；`InvoiceSeller` → `InvoiceSellerEntry` |
| `frontend/app/dashboard/data-management/vat-invoice/lib/vat-calc.ts` | VAT 计算纯函数 | 不变（与字段无关） |
| `frontend/app/dashboard/data-management/vat-invoice/components/line-items-editor.tsx` | 商品明细编辑器 | 不变（与字段无关） |

**后端：** 不改动（JSONB 已支持任意键）。

---

### 任务 1：types.ts — 类型重构

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/types.ts`

- [ ] **步骤 1：用新的 `InvoiceSellerEntry` 替换 `InvoiceSeller`**

`types.ts:17-25` 的 `InvoiceSeller` 接口替换为：

```typescript
/** 单个国家的 Seller 条目（VAT 主体）。按 country 做列表内唯一性约束 */
export interface InvoiceSellerEntry {
  country: string
  company_name: string
  vat_id: string
  address_line: string
  postal_code: string
  city: string
}
```

- [ ] **步骤 2：删除 `InvoiceForm` 中 `bill_id`、`bill_hs`、`delivery_date` 字段**

`types.ts:46-58` 的 `InvoiceForm` 改为：

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

- [ ] **步骤 3：更新 `ProjectContext` 使用 `InvoiceSellerEntry[]`**

`types.ts:89-96` 改为：

```typescript
export interface ProjectContext {
  project_id: number
  project_name: string
  project_context: {
    invoice_sellers?: InvoiceSellerEntry[]
    /** @deprecated 旧字段，仅用于迁移 */
    invoice_seller?: InvoiceSellerEntry
  } | null
  sku_context: unknown
}
```

注意：保留 `invoice_seller`（单数）作为可选字段以便旧数据迁移读取。

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/types.ts
git commit -m "refactor(vat): 重构类型 — InvoiceSeller → InvoiceSellerEntry，删除 Bill ID/Bill HS/交付日期字段"
```

---

### 任务 2：invoice-api.ts — API 层 + 白名单 + 迁移函数

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/lib/invoice-api.ts`

- [ ] **步骤 1：新增白名单常量和 `InvoiceSellerEntry` 导入**

在文件顶部 import 区域更新：

```typescript
import type { InvoiceSellerEntry, ProjectContext, ProjectOption } from "../types"
```

新增白名单常量（在 `BASE` 之后）：

```typescript
/** VAT 发票功能启用的店铺白名单（暂时只允许弥森） */
export const VAT_ENABLED_PROJECT_NAMES = ["弥森"] as const
```

- [ ] **步骤 2：`patchInvoiceSeller` → `patchInvoiceSellers`**

```typescript
/**
 * 写入 invoice_sellers（merge patch）。
 * 合并而非覆盖：保留 context 中其他键。
 */
export async function patchInvoiceSellers(
  projectId: number,
  sellers: InvoiceSellerEntry[],
): Promise<ProjectContext> {
  return jsonFetch<ProjectContext>(`${BASE}/projects/${projectId}/context`, {
    method: "PATCH",
    body: JSON.stringify({
      project_context: { invoice_sellers: sellers },
    }),
  })
}
```

- [ ] **步骤 3：新增惰性迁移辅助函数**

```typescript
/**
 * 惰性迁移：若 project_context 存在 invoice_seller（单数）但不存在 invoice_sellers（复数），
 * 自动转换为数组并写回。
 */
export async function migrateSellersIfNeeded(
  ctx: ProjectContext,
): Promise<ProjectContext> {
  const pc = ctx.project_context
  if (!pc) return ctx
  // 已有复数字段且非空 → 跳过
  if (pc.invoice_sellers && pc.invoice_sellers.length > 0) return ctx
  // 旧字段存在且有内容 → 迁移
  if (pc.invoice_seller && pc.invoice_seller.company_name) {
    const migrated: InvoiceSellerEntry = {
      ...pc.invoice_seller,
      country: pc.invoice_seller.country || "",
    }
    const updated = await patchInvoiceSellers(ctx.project_id, [migrated])
    return updated
  }
  return ctx
}
```

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/lib/invoice-api.ts
git commit -m "feat(vat): 新增店铺白名单、patchInvoiceSellers、惰性迁移函数"
```

---

### 任务 3：vat-invoice-client.tsx — 主协调器调整

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/vat-invoice-client.tsx`

- [ ] **步骤 1：更新 import**

```typescript
import { CURRENCY_OPTIONS, type InvoiceForm, type InvoiceSellerEntry } from "./types"
```

- [ ] **步骤 2：删除 `emptySeller`，`initialForm` 删除 3 字段**

```typescript
const initialForm: InvoiceForm = {
  project_id: null,
  currency: "EUR",
  order_id: "",
  invoice_date: "",
  buyer: { ...emptyBuyer },
  line_items: [],
  shipping_incl_vat: 0,
}
```

删除 `emptySeller` 常量（行 38-45）。

- [ ] **步骤 3：更新 state 和 canPreview**

Seller state 改为列表 + 当前选中索引：

```typescript
const [sellers, setSellers] = useState<InvoiceSellerEntry[]>([])
const [selectedCountry, setSelectedCountry] = useState<string>("")
const seller = sellers.find(s => s.country === selectedCountry) ?? null
```

`canPreview` 校验删除 `bill_id`、`bill_hs`、`delivery_date` 三条：

```typescript
const canPreview = useMemo(() => {
  if (form.project_id == null) return false
  if (!form.order_id.trim()) return false
  if (!form.invoice_date) return false
  if (!form.buyer.name.trim() || !form.buyer.address_line.trim()) return false
  if (!seller?.company_name.trim()) return false
  if (form.line_items.length === 0) return false
  if (form.line_items.some((it) => !it.description.trim())) return false
  return true
}, [form, seller])
```

- [ ] **步骤 4：更新 SellerCard 的 props**

```tsx
<SellerCard
  selectedProjectId={form.project_id}
  sellers={sellers}
  selectedCountry={selectedCountry}
  onSellersChange={setSellers}
  onCountryChange={setSelectedCountry}
  onSelectProject={(id) => setForm({ ...form, project_id: id })}
/>
```

- [ ] **步骤 5：更新 InvoicePreviewDialog 的 seller prop**

```tsx
<InvoicePreviewDialog
  open={previewOpen}
  onOpenChange={setPreviewOpen}
  seller={seller ?? { company_name: "", vat_id: "", address_line: "", postal_code: "", city: "", country: "" }}
  form={form}
/>
```

- [ ] **步骤 6：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/vat-invoice-client.tsx
git commit -m "refactor(vat): 调整主协调器 — Seller 列表化、删除 3 字段、更新校验"
```

---

### 任务 4：invoice-form.tsx — 删除 3 个字段 UI

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/components/invoice-form.tsx`

- [ ] **步骤 1：删除 Bill ID 和 Bill HS 字段**

在 `invoice-form.tsx:44-92` 的第一行 `grid-cols-4` 中，删除 Bill ID 和 Bill HS 两个 `<div className="space-y-1.5">` 块。grid 改为 `md:grid-cols-2`（只保留币种 + Order ID）。

- [ ] **步骤 2：删除交付日期字段**

在 `invoice-form.tsx:96-113` 的日期行中，删除交付日期的 `<div className="space-y-1.5">` 块。grid 改为 `md:grid-cols-1`（只保留发票日期）。

- [ ] **步骤 3：更新表单类型引用**

`InvoiceForm` 类型已改变（删了 3 字段），确保 `update` 函数没有引用这些键。

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/components/invoice-form.tsx
git commit -m "refactor(vat): 删除 Bill ID / Bill HS / 交付日期表单字段"
```

---

### 任务 5：seller-card.tsx — 白名单过滤 + 国家下拉

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/components/seller-card.tsx`

这是改动最大的组件。需要：
1. 新增 `VAT_ENABLED_PROJECT_NAMES` 过滤店铺列表
2. 新增"国家"下拉选择器
3. `SellerCardProps` 改为接受 `sellers` 列表 + `selectedCountry`
4. 编辑对话框支持新增/删除国家

- [ ] **步骤 1：更新 import 和 props**

```typescript
import { VAT_ENABLED_PROJECT_NAMES, fetchProjectsManage, fetchProjectContext, patchInvoiceSellers, migrateSellersIfNeeded } from "../lib/invoice-api"
import type { InvoiceSellerEntry, ProjectOption } from "../types"

interface SellerCardProps {
  selectedProjectId: number | null
  sellers: InvoiceSellerEntry[]
  selectedCountry: string
  onSellersChange: (sellers: InvoiceSellerEntry[]) => void
  onCountryChange: (country: string) => void
  onSelectProject: (id: number) => void
}
```

- [ ] **步骤 2：店铺下拉过滤**

在 `SelectContent` 中，`.filter(p => p.is_active)` 后追加 `.filter(p => VAT_ENABLED_PROJECT_NAMES.includes(p.name as any))`。

- [ ] **步骤 3：加载店铺 Seller 列表 + 旧数据迁移**

`useEffect` 改为加载 `invoice_sellers`（复数），同时执行惰性迁移：

```typescript
useEffect(() => {
  if (selectedProjectId == null) {
    onSellersChange([])
    onCountryChange("")
    return
  }
  const p = projects.find((x) => x.id === selectedProjectId)
  if (!p) return

  let alive = true
  setLoadingContext(true)
  fetchProjectContext(selectedProjectId)
    .then(async (ctx) => {
      if (!alive) return
      // 惰性迁移
      const migrated = await migrateSellersIfNeeded(ctx)
      const list = migrated.project_context?.invoice_sellers ?? []
      onSellersChange(list)
      if (list.length > 0 && !selectedCountry) {
        onCountryChange(list[0].country)
      }
    })
    .catch(() => {
      if (!alive) return
      onSellersChange([])
      onCountryChange("")
    })
    .finally(() => {
      if (!alive) return
      setLoadingContext(false)
    })
  return () => { alive = false }
}, [selectedProjectId, projects])
```

- [ ] **步骤 4：新增国家下拉选择器**

在店铺下拉下方、Seller 预览上方，新增：

```tsx
{/* 国家选择 */}
{sellers.length > 0 ? (
  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
    <Label className="self-center">开票国家</Label>
    <div className="md:col-span-2">
      <Select value={selectedCountry} onValueChange={onCountryChange}>
        <SelectTrigger>
          <SelectValue placeholder="选择国家" />
        </SelectTrigger>
        <SelectContent>
          {sellers.map((s) => (
            <SelectItem key={s.country} value={s.country}>
              {s.country} — {s.company_name || "未填写"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  </div>
) : selectedProjectId != null && !loadingContext ? (
  <p className="text-xs text-amber-700">
    尚未配置任何国家的 VAT 主体。请点击右上角"编辑 Seller"补充。
  </p>
) : null}
```

- [ ] **步骤 5：更新 Seller 预览块**

将 `seller` 改为从 `sellers.find(s => s.country === selectedCountry)` 取值。若无匹配则显示 fallback。

- [ ] **步骤 6：更新编辑对话框 — 支持新增/删除国家**

编辑对话框标题改为"编辑 Seller 信息"，并支持：
- 选择已有国家进行编辑
- "+" 新增新国家
- 删除某国家（需确认）

```tsx
const [editCountry, setEditCountry] = useState<string>("")
const [editMode, setEditMode] = useState<"edit" | "add">("edit")

const openEdit = () => {
  setEditMode("edit")
  setEditCountry(selectedCountry)
  const found = sellers.find(s => s.country === selectedCountry)
  setEditDraft(found ?? emptyEntry)
  setEditOpen(true)
}

const openAddNew = () => {
  setEditMode("add")
  setEditCountry("")
  setEditDraft(emptyEntry)
  setEditOpen(true)
}

const deleteCountry = async (country: string) => {
  if (selectedProjectId == null) return
  const next = sellers.filter(s => s.country !== country)
  setSaving(true)
  try {
    await patchInvoiceSellers(selectedProjectId, next)
    onSellersChange(next)
    if (selectedCountry === country && next.length > 0) {
      onCountryChange(next[0].country)
    }
    notify({ type: "success", title: "删除成功", message: `${country} Seller 已删除` })
  } catch (err) {
    notify({ type: "error", title: "删除失败", message: normalizeErrorMessage(err) })
  } finally {
    setSaving(false)
  }
}

const saveEdit = async () => {
  if (selectedProjectId == null) return
  if (!editDraft.company_name.trim()) {
    notify({ type: "error", title: "校验失败", message: "公司名不能为空" })
    return
  }
  if (!editDraft.country.trim()) {
    notify({ type: "error", title: "校验失败", message: "国家代码不能为空" })
    return
  }
  setSaving(true)
  try {
    // 合并：如果已存在该 country 则替换，否则追加
    const existing = sellers.filter(s => s.country !== editDraft.country)
    const next = [...existing, editDraft]
    await patchInvoiceSellers(selectedProjectId, next)
    onSellersChange(next)
    onCountryChange(editDraft.country)
    setEditOpen(false)
    notify({ type: "success", title: "保存成功", message: `${editDraft.country} Seller 已保存` })
  } catch (err) {
    notify({ type: "error", title: "保存失败", message: normalizeErrorMessage(err) })
  } finally {
    setSaving(false)
  }
}
```

- [ ] **步骤 7：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/components/seller-card.tsx
git commit -m "feat(vat): SellerCard 重构 — 白名单过滤、国家下拉、新增/删除国家"
```

---

### 任务 6：invoice-pdf.ts — 删除 Bill ID / Delivery Date / HS Code 输出

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/lib/invoice-pdf.ts`

- [ ] **步骤 1：更新类型 import**

```typescript
import type { InvoiceForm, InvoiceSellerEntry } from "../types"
```

`InvoiceSeller` → `InvoiceSellerEntry` 在所有函数签名中。

- [ ] **步骤 2：修改 `drawBillToAndMeta` 的 meta 行**

`invoice-pdf.ts:173-181` 的 `meta` 数组改为：

```typescript
const meta: Array<[string, string]> = [
  ["Invoice #", form.order_id],
  ["Order ID", form.order_id],
  ["Invoice Date", form.invoice_date],
  ["VAT declared by", seller.company_name || "—"],
  ["VAT #", seller.vat_id || "—"],
  ["Total payable", fmtMoney(total, sym)],
]
```

删除 `["Delivery Date", form.delivery_date]` 和 `["Bill ID", form.bill_id]`（如有）。

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/lib/invoice-pdf.ts
git commit -m "refactor(vat): PDF 输出删除 Bill ID / Delivery Date，InvoiceSeller → InvoiceSellerEntry"
```

---

### 任务 7：invoice-preview-dialog.tsx — 类型更新

**文件：**
- 修改：`frontend/app/dashboard/data-management/vat-invoice/components/invoice-preview-dialog.tsx`

- [ ] **步骤 1：更新 import 和 props 类型**

```typescript
import type { InvoiceForm, InvoiceSellerEntry } from "../types"

interface InvoicePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  seller: InvoiceSellerEntry
  form: InvoiceForm
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/app/dashboard/data-management/vat-invoice/components/invoice-preview-dialog.tsx
git commit -m "refactor(vat): InvoicePreviewDialog 类型更新为 InvoiceSellerEntry"
```

---

### 任务 8：技术测试 — lint + build

- [ ] **步骤 1：运行 lint**

```bash
cd frontend && pnpm lint
```
预期：无错误

- [ ] **步骤 2：运行 build**

```bash
cd frontend && pnpm build
```
预期：构建成功

- [ ] **步骤 3：修复所有 lint/build 错误**

如有类型错误或未使用变量，逐个修复后重新运行。

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "fix(vat): 修复 lint/build 错误"
```

---

## 业务测试清单

| 编号 | 测试项 | 期望 |
|------|--------|------|
| T1 | 打开 `/dashboard/data-management/vat-invoice` | 页面正常加载 |
| T2 | 店铺下拉只显示"弥森"，其他项目不显示 | 通过 |
| T3 | 选弥森 → 若未配置 Seller，显示黄条提示 | 通过 |
| T4 | 点击"编辑 Seller"，保存一个国家的 Seller（如 DE） | 保存成功，刷新页面后保留 |
| T5 | 点击"+"新增第二个国家 Seller（如 UK），切换国家下拉 | Seller 字段随之变化 |
| T6 | 删除某个国家 Seller，刷新 | 该国家 Seller 不再出现 |
| T7 | 切换国家时，买家/订单/明细行表单内容不变 | 不变 |
| T8 | 不填 Bill ID/Bill HS/交付日期，"预览并导出 PDF" 按钮不被阻止 | 通过 |
| T9 | PDF 中不再含 "Bill ID"、"Delivery Date"、"HS Code" 字段 | 通过 |
| T10 | 旧数据迁移：数据库手动写入 `invoice_seller` 单数字段，前端加载后自动迁移 | 通过 |
