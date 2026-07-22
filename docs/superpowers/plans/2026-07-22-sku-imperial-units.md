# SKU 页面美制单位显示 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 SKU 信息页面的尺寸/重量列中折行显示美制单位（英寸/磅），并在导出 CSV 中增加对应美制列。

**架构：** 纯前端换算（cm→inch, kg→lb），不涉及后端数据模型变更。前端表格单元格内折行显示换算值；后端导出接口在 dimension 类型 CSV 中追加美制列。

**技术栈：** React/TSX（前端表格）、Python/FastAPI（后端 CSV 导出）

**换算常量：**
- 1 cm = 0.3937 in（即 ÷ 2.54）
- 1 kg = 2.2046 lb

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `frontend/lib/unit-convert.ts` | 单位换算工具函数 |
| 创建 | `frontend/lib/unit-convert.test.ts` | 换算函数单元测试 |
| 修改 | `frontend/app/dashboard/supply-chain/sku-info/page.tsx:1506-1561` | 表格单元格折行显示美制 |
| 修改 | `backend/app/api/v1/endpoints/sku_info.py:490-527` | 导出 CSV 增加美制列 |

---

### 任务 1：创建单位换算工具函数

**文件：**
- 创建：`frontend/lib/unit-convert.ts`
- 测试：`frontend/lib/unit-convert.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// frontend/lib/unit-convert.test.ts
import { describe, expect, it } from 'vitest'
import { cmToInch, kgToLb, formatInch, formatLb } from './unit-convert'

describe('unit-convert', () => {
  it('cmToInch converts correctly', () => {
    expect(cmToInch(2.54)).toBeCloseTo(1, 4)
    expect(cmToInch(10)).toBeCloseTo(3.937, 2)
    expect(cmToInch(0)).toBe(0)
  })

  it('kgToLb converts correctly', () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046, 3)
    expect(kgToLb(0)).toBe(0)
    expect(kgToLb(0.5)).toBeCloseTo(1.1023, 3)
  })

  it('formatInch returns formatted string', () => {
    expect(formatInch(2.54)).toBe('1.00 in')
    expect(formatInch(10)).toBe('3.94 in')
  })

  it('formatLb returns formatted string', () => {
    expect(formatLb(1)).toBe('2.20 lb')
    expect(formatLb(0.5)).toBe('1.10 lb')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd frontend && pnpm vitest run lib/unit-convert.test.ts`
预期：FAIL，模块 `./unit-convert` 不存在

- [ ] **步骤 3：实现换算函数**

```ts
// frontend/lib/unit-convert.ts
const CM_PER_INCH = 2.54
const LB_PER_KG = 2.20462

export function cmToInch(cm: number): number {
  return cm / CM_PER_INCH
}

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG
}

export function formatInch(cm: number): string {
  return `${cmToInch(cm).toFixed(2)} in`
}

export function formatLb(kg: number): string {
  return `${kgToLb(kg).toFixed(2)} lb`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd frontend && pnpm vitest run lib/unit-convert.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/unit-convert.ts frontend/lib/unit-convert.test.ts
git commit -m "feat(工具): 添加公制转美制单位换算函数"
```

---

### 任务 2：前端表格折行显示美制单位

**文件：**
- 修改：`frontend/app/dashboard/supply-chain/sku-info/page.tsx`

需要在 4 个单元格中折行追加美制显示：
1. 单品尺寸（~line 1507）：`cm` 行下方追加 `inch` 行
2. 单品重量（~line 1523）：`kg` 行下方追加 `lb` 行
3. 外箱尺寸（~line 1544）：`cm` 行下方追加 `inch` 行
4. 外箱重量（~line 1560）：`kg` 行下方追加 `lb` 行

- [ ] **步骤 1：在文件顶部添加 import**

在 `page.tsx` 的 import 区域添加：

```ts
import { formatInch, formatLb } from '@/lib/unit-convert'
```

- [ ] **步骤 2：修改单品尺寸单元格（非编辑态）**

将 ~line 1506-1508 的：
```tsx
) : (
  `${row.package_length_cm} × ${row.package_width_cm} × ${row.package_height_cm} cm`
)}
```

替换为：
```tsx
) : (
  <div>
    <div>{row.package_length_cm} × {row.package_width_cm} × {row.package_height_cm} cm</div>
    <div className="mt-0.5 text-xs text-muted-foreground">
      {formatInch(row.package_length_cm)} × {formatInch(row.package_width_cm)} × {formatInch(row.package_height_cm)}
    </div>
  </div>
)}
```

- [ ] **步骤 3：修改单品重量单元格（非编辑态）**

将 ~line 1522-1524 的：
```tsx
) : (
  `${row.weight_kg} kg`
)}
```

替换为：
```tsx
) : (
  <div>
    <div>{row.weight_kg} kg</div>
    <div className="mt-0.5 text-xs text-muted-foreground">{formatLb(row.weight_kg)}</div>
  </div>
)}
```

- [ ] **步骤 4：修改外箱尺寸单元格（非编辑态）**

将 ~line 1543-1545 的：
```tsx
) : (
  `${row.carton_length_cm} × ${row.carton_width_cm} × ${row.carton_height_cm} cm`
)}
```

替换为：
```tsx
) : (
  <div>
    <div>{row.carton_length_cm} × {row.carton_width_cm} × {row.carton_height_cm} cm</div>
    <div className="mt-0.5 text-xs text-muted-foreground">
      {formatInch(row.carton_length_cm)} × {formatInch(row.carton_width_cm)} × {formatInch(row.carton_height_cm)}
    </div>
  </div>
)}
```

- [ ] **步骤 5：修改外箱重量单元格（非编辑态）**

将 ~line 1559-1561 的：
```tsx
) : (
  `${row.carton_weight_kg} kg`
)}
```

替换为：
```tsx
) : (
  <div>
    <div>{row.carton_weight_kg} kg</div>
    <div className="mt-0.5 text-xs text-muted-foreground">{formatLb(row.carton_weight_kg)}</div>
  </div>
)}
```

- [ ] **步骤 6：运行 lint 和 build 验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：无错误

- [ ] **步骤 7：Commit**

```bash
git add frontend/app/dashboard/supply-chain/sku-info/page.tsx
git commit -m "feat(SKU信息): 尺寸和重量列折行显示美制单位"
```

---

### 任务 3：后端导出 CSV 增加美制列

**文件：**
- 修改：`backend/app/api/v1/endpoints/sku_info.py:490-527`

- [ ] **步骤 1：修改 dimension 导出的 headers 和 csv_rows**

将 `backend/app/api/v1/endpoints/sku_info.py` 中 `if normalized_export_type == "dimension":` 分支的 headers 和 csv_rows 替换为：

```python
    if normalized_export_type == "dimension":
        headers = [
            "project_name",
            "SKU",
            "ASIN(可留空)",
            "FNSKU(可留空)",
            "品名(可留空)",
            "国家",
            "单品长(cm)",
            "单品宽(cm)",
            "单品高(cm)",
            "单品长(inch)",
            "单品宽(inch)",
            "单品高(inch)",
            "单品重量(kg)",
            "单品重量(lb)",
            "外箱长(cm)",
            "外箱宽(cm)",
            "外箱高(cm)",
            "外箱长(inch)",
            "外箱宽(inch)",
            "外箱高(inch)",
            "外箱重量(kg)",
            "外箱重量(lb)",
            "装箱数量",
        ]
        csv_rows = [
            [
                row.project_name,
                row.sku,
                row.asin or "",
                row.fnsku or "",
                row.product_name or "",
                row.country,
                float(row.package_length_cm),
                float(row.package_width_cm),
                float(row.package_height_cm),
                round(float(row.package_length_cm) / 2.54, 2),
                round(float(row.package_width_cm) / 2.54, 2),
                round(float(row.package_height_cm) / 2.54, 2),
                float(row.weight_kg),
                round(float(row.weight_kg) * 2.20462, 2),
                float(row.carton_length_cm),
                float(row.carton_width_cm),
                float(row.carton_height_cm),
                round(float(row.carton_length_cm) / 2.54, 2),
                round(float(row.carton_width_cm) / 2.54, 2),
                round(float(row.carton_height_cm) / 2.54, 2),
                float(row.carton_weight_kg),
                round(float(row.carton_weight_kg) * 2.20462, 2),
                int(row.units_per_carton),
            ]
            for row in rows
        ]
```

- [ ] **步骤 2：运行后端测试验证**

运行：`cd backend && python -m pytest tests/ -k "sku" --no-header -q`
预期：现有测试全部 PASS（导出逻辑无独立测试则确认无 import 错误即可）

- [ ] **步骤 3：Commit**

```bash
git add backend/app/api/v1/endpoints/sku_info.py
git commit -m "feat(SKU导出): CSV 尺寸导出增加英寸和磅列"
```

---

### 任务 4：端到端验证

- [ ] **步骤 1：前端完整检查**

运行：`cd frontend && pnpm lint && pnpm build && pnpm test`
预期：全部通过

- [ ] **步骤 2：后端完整检查**

运行：`cd backend && python -m pytest --no-header -q`
预期：全部通过

- [ ] **步骤 3：手动业务验证清单**

启动开发环境后验证：
1. 打开 SKU 信息页面 → 尺寸管理 tab → 确认单品尺寸/重量、外箱尺寸/重量列下方有灰色小字美制换算
2. 编辑某行 → 确认编辑态不显示美制（只有 Input）
3. 点击"导出当前筛选结果" → 打开 CSV → 确认有 inch 和 lb 列且数值正确
4. 确认 0 值显示为 `0.00 in` / `0.00 lb`
