# 佣金管理页面 - 多国家站点显示重构设计

**日期**: 2026-05-20
**状态**: 已批准

---

## 背景与目标

佣金管理页面的"总览"Tab 需要支持多国家站点项目的展示。当一个项目有多个国家站点（US/DE/UK）时，需要在表格中清晰呈现，同时确保销售额字段显示正确的本地货币。

---

## 设计方案：扁平化列表 + Row Span

### 表格结构

| 项目名称 | 站点 | 销售额 | 工厂佣金(RMB) | 收款状态 | 已收款(RMB) |
|---------|------|--------|--------------|---------|-----------|
| 项目A（跨N行） | US | $1,234 USD | ¥567 | 已付款 | ¥567 |
| | DE | €987 EUR | ¥234 | 部分付款 | ¥100 |
| | UK | £654 GBP | ¥123 | 未付款 | ¥0 |
| 项目B | US | $2,345 USD | ¥789 | 已付款 | ¥789 |

### 核心规则

1. **Row Span 合并项目名列**：当项目有多站点数据时，项目名称列使用 Row Span 合并，仅第一行显示项目名，后续行留空
2. **无数据站点不显示**：仅显示有数据的站点行，无数据的站点不渲染行
3. **销售额显示本地货币**：
   - US → USD（如 `$1,234 USD`）
   - DE → EUR（如 `€987 EUR`）
   - UK → GBP（如 `£654 GBP`）
4. **保持站点标识**：站点列仍显示简写（US/DE/UK），可保留彩色圆点标识
5. **不需要汇总行**：店铺只需按国家站点维度展示

---

## 实现要点

### 前端改动

**1. 数据处理（utils.ts）**

```typescript
export function groupProjectsBySites(rows: CommissionProjectMonth[]): ProjectRow[] {
  // 按 project_id 分组
  // 仅保留有数据的站点
  // 计算 Row Span 值
}

interface ProjectRow {
  projectId: number
  projectName: string
  rowSpan: number  // 用于项目名列的合并行数
  country: SiteCode
  income: number
  incomeDisplay: string  // 带币种格式化的销售额
  factoryCommission: number
  paymentStatus: PaymentStatus
  receivedRmb: number
}
```

**2. 站点显示格式化**

```typescript
export function formatIncomeWithCurrency(amount: number, country: SiteCode): string {
  const symbols: Record<SiteCode, { symbol: string; currency: string }> = {
    US: { symbol: '$', currency: 'USD' },
    DE: { symbol: '€', currency: 'EUR' },
    UK: { symbol: '£', currency: 'GBP' },
  }
  const { symbol, currency } = symbols[country]
  return `${symbol}${amount.toLocaleString()} ${currency}`
}
```

**3. 表格渲染（detail-tab.tsx）**

- 项目名称列：根据 rowSpan 决定是否显示内容
- 站点列：显示简写 + 彩色圆点
- 销售额列：显示带币种的格式化值

### 数据源

API `/api/v1/commissions/project-months` 返回的数据结构无需改变，前端负责聚合和格式化。

---

## 变更范围

| 文件 | 改动内容 |
|------|---------|
| `frontend/.../commission-management/utils.ts` | 新增格式化函数，调整分组逻辑 |
| `frontend/.../commission-management/types.ts` | 调整类型定义 |
| `frontend/.../commission-management/detail-tab.tsx` | 表格渲染逻辑重构 |

---

## 验证方式

1. 选择一个有多个站点数据的项目，验证：
   - 项目名称列正确合并
   - 各站点行显示对应币种
   - 无数据站点不显示
2. 选择只有单个站点的项目，验证：
   - 正常单行显示
   - 项目名无 Row Span
3. 测试筛选功能是否正常工作