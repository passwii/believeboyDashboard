import type { Category } from '@/lib/crm/types'

/** P6b 产品类目种子（与后端迁移 243 的 9 个主流类目一致）。 */
export const CATEGORIES_FIXTURE: Category[] = [
  { id: '1', name: '家居', sortOrder: 0, createdAt: '2026-08-08T00:00:00Z' },
  { id: '2', name: '3C', sortOrder: 1, createdAt: '2026-08-08T00:00:00Z' },
  { id: '3', name: '服装', sortOrder: 2, createdAt: '2026-08-08T00:00:00Z' },
  { id: '4', name: '家纺', sortOrder: 3, createdAt: '2026-08-08T00:00:00Z' },
  { id: '5', name: '科学配件', sortOrder: 4, createdAt: '2026-08-08T00:00:00Z' },
  { id: '6', name: '工业配件', sortOrder: 5, createdAt: '2026-08-08T00:00:00Z' },
  { id: '7', name: '工具配件', sortOrder: 6, createdAt: '2026-08-08T00:00:00Z' },
  { id: '8', name: '电动工具', sortOrder: 7, createdAt: '2026-08-08T00:00:00Z' },
  { id: '9', name: '户外用品', sortOrder: 8, createdAt: '2026-08-08T00:00:00Z' },
]
