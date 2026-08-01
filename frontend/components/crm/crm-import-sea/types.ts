import type { CustomerSeaImportRow, CustomerSeaImportResult } from '@/lib/crm/types'

export type { CustomerSeaImportRow, CustomerSeaImportResult }

export type RowLevel = 'error' | 'warn'

export interface RowIssue {
  row: number // 1-based
  level: RowLevel
  field?: string
  message: string
}

export type ImportStep = 'input' | 'preview' | 'result'
