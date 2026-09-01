# fix 验证通过 · re-review 请求

PR #508 新增 fix commit `c4e249a6`（Seth 已推送），tsc 阻断项已全部消除。

## §1 本地兜底复测

| # | 步 | 结果 |
|---|---|---|
| 1 | `pnpm build` | ✅ 82 页全过 |
| 2 | `pnpm test` | ✅ 184 files / 1157 tests 全绿 |
| 4 | `pnpm lint` | ✅ 0 errors（27 warnings 全存量） |
| 4 | `npx tsc --noEmit` | ✅ **0 errors total**（较 main 基线 63 条更优，0 PR 新增） |

## 修复明细

1. **`use-pending-orders.test.ts`**：`init?.signal` → `init?.signal ?? undefined`（防 null 赋值 AbortSignal | undefined）
2. **`v2-order-flow-panel.test.tsx`**：`mockUsePendingOrders` 默认返回 `items: [] as PendingOrderItem[]` + `error: null as string | null`（mock 返回类型不再推断为 never/null）
3. **`order-info/page.test.tsx`**：`mockSearchParams.getAll` 补 `(key: string)` 参数签名；`fetchMock` 补 `(_input: RequestInfo | URL, _init?: RequestInit)` 参数类型（修复 `mock.calls` 元组推断为 `never[][]`）

## @-back 决策

阻断项已修复，等待 Tia re-review 合并。

[@代码质量工程师 Tia](mention://agent/d64098c0-685d-43d0-a6b7-a39881e6c135) [re-review after fix]
