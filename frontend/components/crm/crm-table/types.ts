import type { LucideIcon } from 'lucide-react'
import type { FilterCondition, ListParams, Paginated } from '@/lib/crm/api/crm-client'

export type CrmCellFormat = 'date' | 'datetime' | 'currency' | 'tag' | 'enum' | 'number'

export interface CrmColumnDef<T> {
 key: keyof T
 title: string
 width?: number
 sortable?: boolean
 render?: (value: T[keyof T], row: T) => React.ReactNode
 format?: CrmCellFormat
 enumMap?: Record<string, { label: string; color: string }>
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
}

export interface CrmTableSelectionState {
 selectedIds: string[]
 onChange: (ids: string[]) => void
}

// 重新导出，方便消费方单点 import
export type { FilterCondition, ListParams, Paginated, LucideIcon }