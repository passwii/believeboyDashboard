import type { LucideIcon } from 'lucide-react'
import type { FilterCondition, ListParams, Paginated } from '@/lib/crm/api/crm-client'
import type { TermTone } from '@/components/crm/term-shared'

export type CrmCellFormat = 'date' | 'datetime' | 'currency' | 'tag' | 'enum' | 'number'

export interface CrmColumnDef<T> {
  key: keyof T
  title: string
  width?: number
  sortable?: boolean
  render?: (value: T[keyof T], row: T) => React.ReactNode
  format?: CrmCellFormat
  /** BLF-837：终端单色语义 tone（传入时 enum 单元格走 TermEnumPill，忽略 color 彩色胶囊） */
  enumMap?: Record<string, { label: string; color: string; tone?: TermTone }>
  className?: string
  headerClassName?: string
}

export interface FilterFieldOption {
  label: string
  value: string
}

export interface FilterFieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'dateRange' | 'select' | 'multiselect' | 'user'
  options?: FilterFieldOption[]
  field?: string
}

export interface CrmTableProps<T> {
  queryKey: string
  fetchPage: (params: ListParams) => Promise<Paginated<T>>
  columns: CrmColumnDef<T>[]
  onRowClick?: (row: T) => void
  selectable?: boolean
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  emptyText?: string
  defaultPageSize?: number
  rowKey: keyof T
  /** 外部变更后主动刷新表格（每次 +1 触发） */
  refreshKey?: number
  /** 由页面主表格注册 Head 刷新；嵌套/独立表格默认不占用全局 callback */
  headerRefresh?: boolean
  /** 表头快捷筛选字段定义（P4 实用档）；不传则不渲染筛选行 */
  filterFields?: FilterFieldDef[]
  /** 是否显示关键词搜索框（写入 URL keyword，hook 已支持） */
  searchable?: boolean
  /** 搜索框占位符 */
  searchPlaceholder?: string
}

export interface CrmTableSelectionState {
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

// 重新导出，方便消费方单点 import
export type { FilterCondition, ListParams, Paginated, LucideIcon }
