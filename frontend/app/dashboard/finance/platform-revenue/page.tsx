'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useSession } from 'next-auth/react'
import { Label } from '@/components/ui/label'
import { UploadZone } from '@/components/ui/upload-zone'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { cn } from '@/lib/utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { getCountryLabel } from '@/lib/country'
import { downloadBlob } from '@/lib/download-blob'
import { applyDataRowBanding, disableGridLines } from '@/lib/excel-styles'
import { useNotifications } from '@/components/notifications'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  CalendarIcon,
  Pencil,
  Trash2,
  Plus,
  X,
  Download,
} from 'lucide-react'
import styles from './platform-revenue-warm.module.css'

// 币种选项
const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - 美元', symbol: '$' },
  { value: 'GBP', label: 'GBP - 英镑', symbol: '£' },
  { value: 'EUR', label: 'EUR - 欧元', symbol: '€' },
]

// 站点选项
const COUNTRY_OPTIONS = [
  { value: 'US', label: 'US - 美国' },
  { value: 'UK', label: 'UK - 英国' },
  { value: 'DE', label: 'DE - 德国' },
  { value: 'CA', label: 'CA - 加拿大' },
  { value: 'JP', label: 'JP - 日本' },
  { value: 'AU', label: 'AU - 澳大利亚' },
  { value: 'MX', label: 'MX - 墨西哥' },
  { value: 'BR', label: 'BR - 巴西' },
]

// 生成年份选项
const getYearOptions = () => {
  const currentYear = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => ({
    value: currentYear - 2 + i,
    label: `${currentYear - 2 + i}年`,
  }))
}

// 生成月份选项
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: `${i + 1}月`,
}))

const ALL_FILTER_VALUE = '__ALL__'

interface Attachment {
  id: string
  filename: string
  stored_path: string
  url: string
  size: number
  created_at: string
}

interface PlatformRevenue {
  id: number
  project_id: number
  project_name: string
  country: string
  received_date: string
  amount: string
  currency: string
  revenue_type: string
  note: string | null
  attachments: Attachment[]
  screenshot_r2_url?: string | null
  created_by: string
  created_at: string
  updated_at: string
}

interface ProjectOption {
  id: number
  name: string
}

interface Filters {
  project_id: string
  year: string
  month: string
  currency: string
  revenue_type: string
}

const formatCurrency = (amount: string | number, currency: string) => {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  const symbol = CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol || ''
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// 解析用户输入的金额字符串，支持：
//   - 千分位逗号：1,234.56 / 1,234,567.89
//   - 欧洲逗号小数：11693,69 / 1.234,56
//   - 含空格：1 234.56
//   - 货币符号前缀：$ 1,234.56 / ¥11,693.69
// 返回 null 表示无法解析为有效正数。
const parseAmount = (raw: string | number | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  if (!str) return null

  // 去掉常见货币符号与空白字符（含中文空格 \u3000）
  let cleaned = str.replace(/[\s ¥$€£￥]/g, '')

  // 形如 "1.234,56" → "1234.56"；形如 "1,234.56" → "1234.56"
  // 判断规则：最后一个分隔符是小数点 → 千分位是逗号；最后一个分隔符是逗号 → 小数点是逗号
  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')
  if (lastDot === -1 && lastComma === -1) {
    // 没有分隔符
  } else if (lastComma > lastDot) {
    // 逗号在小数位（欧洲写法），把剩余逗号当千分位去掉
    cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.')
  } else {
    // 点在小数位（英语写法），去掉所有逗号
    cleaned = cleaned.replace(/,/g, '')
  }

  // 只允许数字 + 一个可选小数点
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null

  const num = Number(cleaned)
  if (!Number.isFinite(num)) return null
  return num
}

// 格式化金额输入框显示（剥千分位逗号，保留用户原始小数）
const formatAmountInput = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // 直接把逗号去掉，保留点和数字，方便用户继续输入
  return trimmed.replace(/,/g, '')
}

// 计算合计金额（按币种分组）
const calculateTotals = (revenues: PlatformRevenue[]) => {
  const totals: Record<string, number> = {}
  revenues.forEach((r) => {
    const currency = r.currency || 'USD'
    totals[currency] = (totals[currency] || 0) + parseFloat(r.amount)
  })
  return totals
}

export function formatCurrencyTotalsForExcel(totals: Record<string, number>) {
  const entries = Object.entries(totals).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  if (entries.length <= 1) {
    return {
      amount: entries[0]?.[1] ?? 0,
      currency: entries[0]?.[0] ?? '',
    }
  }
  return {
    amount: entries.map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(' / '),
    // Keep adjacent cells empty so Excel can overflow the full multi-currency total.
    currency: null,
  }
}

export function buildCurrencyTotalRow(
  summary: ReturnType<typeof formatCurrencyTotalsForExcel>
) {
  return ['合计', null, null, summary.amount, summary.currency, null, null] as const
}

// 格式化合计行显示
const formatTotals = (totals: Record<string, number>) => {
  return Object.entries(totals)
    .map(
      ([currency, amount]) =>
        `${CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol || currency}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    )
    .join(' | ')
}

/** 币种 → Warm 文本符号与辅助名称 */
const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()
  switch (normalizedCurrency) {
    case 'USD':
      return { symbol: '$', accent: '美元' }
    case 'GBP':
      return { symbol: '£', accent: '英镑' }
    case 'EUR':
      return { symbol: '€', accent: '欧元' }
    default:
      return { symbol: '¤', accent: '其他货币' }
  }
}

/** 站点代码（终端化：去 emoji 渐变 Badge，站点直接 mono 文本展示） */
const getCountryBadgeMeta = (country: string) => {
  const normalizedCountry = country.trim().toUpperCase()
  const accents: Record<string, string> = {
    US: '美国',
    UK: '英国',
    DE: '德国',
    CA: '加拿大',
    JP: '日本',
    AU: '澳大利亚',
    MX: '墨西哥',
    BR: '巴西',
  }
  return { code: normalizedCountry, accent: accents[normalizedCountry] ?? '其他' }
}

export default function PlatformRevenuePage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  // 状态
  const [revenues, setRevenues] = useState<PlatformRevenue[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pagination, setPagination] = useState({
    page: 1,
    page_size: 20,
    total: 0,
    total_pages: 1,
  })
  const [filters, setFilters] = useState<Filters>({
    project_id: '',
    year: new Date().getFullYear().toString(),
    month: '',
    currency: '',
    revenue_type: '',
  })

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRevenue, setEditingRevenue] = useState<PlatformRevenue | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingRevenue, setDeletingRevenue] = useState<PlatformRevenue | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [previewZoomed, setPreviewZoomed] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageUploadState, setImageUploadState] = useState<{
    status: 'idle' | 'uploading' | 'success' | 'error'
    message: string
  }>({ status: 'idle', message: '' })

  // 表单状态
  const [formData, setFormData] = useState({
    project_id: '',
    project_name: '',
    country: 'US',
    received_date: null as Date | null,
    amount: '',
    currency: 'USD',
    revenue_type: '订单回款',
    note: '',
    attachments: [] as Attachment[],
    currencyLocked: true,
  })

  // 导出状态
  const [exporting, setExporting] = useState(false)

  // 获取项目列表
  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectsError(null)
    try {
      // 复用 projects/manage 2min 客户端缓存（BEL-424）：跨页共享项目列表。
      const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
      const items = Array.isArray(data) ? data : []
      setProjects(items)
    } catch (error) {
      console.error('Error fetching projects:', error)
      setProjectsError('项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [session])

  // 获取回款列表
  const fetchRevenues = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const queryParams = new URLSearchParams({
        page: pagination.page.toString(),
        page_size: pagination.page_size.toString(),
      })

      if (filters.project_id) queryParams.append('project_id', filters.project_id)
      if (filters.year) queryParams.append('year', filters.year)
      if (filters.month) queryParams.append('month', filters.month)
      if (filters.currency) queryParams.append('currency', filters.currency)
      if (filters.revenue_type) queryParams.append('revenue_type', filters.revenue_type)

      const response = await fetch(`/api/backend/api/v1/platform-revenues?${queryParams}`)
      if (!response.ok) {
        throw new Error('平台回款数据加载失败')
      }

      const result = await response.json()
      setRevenues(result.items || [])
      setPagination({
        page: result.page,
        page_size: result.page_size,
        total: result.total,
        total_pages: result.total_pages,
      })
    } catch (error) {
      console.error('Error fetching revenues:', error)
      setLoadError('平台回款数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [filters, pagination.page, pagination.page_size])

  // 获取项目的站点列表
  const fetchProjectCountries = useCallback(async (projectId: number) => {
    try {
      const response = await fetch(
        `/api/backend/api/v1/platform-revenues/project-countries/${projectId}`
      )
      if (response.ok) {
        const result = await response.json()
        return result.countries || []
      }
    } catch (error) {
      console.error('Error fetching project countries:', error)
    }
    return []
  }, [])

  // 初始加载
  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  useEffect(() => {
    void fetchRevenues()
  }, [fetchRevenues])

  useEffect(() => {
    if (previewImage) setPreviewZoomed(false)
  }, [previewImage])

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义：当前筛选条件下重新拉取。
  const fetchRef = useRef(fetchRevenues)
  fetchRef.current = fetchRevenues
  useHeaderRefresh(() => fetchRef.current())

  const handleFilterChange = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 重置筛选
  const resetFilters = () => {
    setFilters({ project_id: '', year: '', month: '', currency: '', revenue_type: '' })
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 打开新增弹窗
  const handleAdd = () => {
    setEditingRevenue(null)
    setFormData({
      project_id: '',
      project_name: '',
      country: 'US',
      received_date: new Date(),
      amount: '',
      currency: 'USD',
      revenue_type: '订单回款',
      note: '',
      attachments: [],
      currencyLocked: true,
    })
    setDialogOpen(true)
  }

  // 打开编辑弹窗
  const handleEdit = (revenue: PlatformRevenue) => {
    setEditingRevenue(revenue)
    // 编辑时根据当前站点判断是否锁定币种
    const lockedCountries = ['US', 'UK', 'DE']
    const isCurrencyLocked = lockedCountries.includes(revenue.country)
    setFormData({
      project_id: revenue.project_id.toString(),
      project_name: revenue.project_name,
      country: revenue.country,
      received_date: new Date(revenue.received_date),
      amount: revenue.amount,
      currency: revenue.currency,
      revenue_type: revenue.revenue_type || '订单回款',
      note: revenue.note || '',
      attachments: revenue.attachments || [],
      currencyLocked: isCurrencyLocked,
    })
    setDialogOpen(true)
  }

  // 打开删除确认弹窗
  const handleDeleteClick = (revenue: PlatformRevenue) => {
    setDeletingRevenue(revenue)
    setDeleteDialogOpen(true)
  }

  // 提交表单
  const handleSubmit = async () => {
    try {
      // 验证必填字段（按字段精确定位缺失项，避免笼统提示）
      const missingFields: string[] = []
      if (!formData.project_id) missingFields.push('项目')
      if (!formData.country) missingFields.push('站点')
      if (!formData.received_date) missingFields.push('回款日期')
      if (!formData.amount || !formData.amount.trim()) missingFields.push('回款金额')

      if (missingFields.length > 0) {
        notify({
          type: 'error',
          title: '请填写必填字段',
          message: `以下字段为必填：${missingFields.join('、')}`,
        })
        return
      }

      // 金额格式校验（支持千分位逗号 / 欧洲逗号小数）
      const parsedAmount = parseAmount(formData.amount)
      if (parsedAmount === null) {
        notify({
          type: 'error',
          title: '请输入有效金额',
          message: '请检查金额格式，例如 11693.69 或 1,234.56',
        })
        return
      }
      if (parsedAmount <= 0) {
        notify({
          type: 'error',
          title: '金额需大于 0',
          message: `当前金额：${parsedAmount}`,
        })
        return
      }

      const payload: Record<string, any> = editingRevenue
        ? {
            // PATCH: only send mutable fields (no project_id)
            country: formData.country,
            received_date: formData.received_date
              ? format(formData.received_date, 'yyyy-MM-dd')
              : '',
            amount: parsedAmount,
            currency: formData.currency,
            revenue_type: formData.revenue_type,
            note: formData.note || null,
            attachments: formData.attachments.map((att) => ({
              id: att.id,
              filename: att.filename,
              stored_path: att.stored_path,
              url: att.url,
              size: att.size,
              created_at: att.created_at,
            })),
          }
        : {
            // POST: include project_id
            project_id: parseInt(formData.project_id),
            country: formData.country,
            received_date: formData.received_date
              ? format(formData.received_date, 'yyyy-MM-dd')
              : '',
            amount: parsedAmount,
            currency: formData.currency,
            revenue_type: formData.revenue_type,
            note: formData.note || null,
            attachments: formData.attachments.map((att) => ({
              id: att.id,
              filename: att.filename,
              stored_path: att.stored_path,
              url: att.url,
              size: att.size,
              created_at: att.created_at,
            })),
          }

      const url = editingRevenue
        ? `/api/backend/api/v1/platform-revenues/${editingRevenue.id}`
        : '/api/backend/api/v1/platform-revenues'
      const method = editingRevenue ? 'PATCH' : 'POST'

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const error = await response.json()
        console.error('Validation error detail:', JSON.stringify(error.detail, null, 2))
        // Pydantic validation errors: detail is an array of {msg, loc, type}
        const detail = Array.isArray(error.detail)
          ? error.detail.map((e: any) => `${e.loc?.join('.')} — ${e.msg}`).join('; ')
          : error.detail
        throw new Error(detail || '操作失败')
      }

      setDialogOpen(false)
      fetchRevenues()
      notify({ type: 'success', title: editingRevenue ? '回款记录已更新' : '回款记录已添加' })
    } catch (error: any) {
      console.error('Error saving revenue:', error)
      notify({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '操作失败',
      })
    }
  }

  // 删除记录
  const handleDelete = async () => {
    if (!deletingRevenue) return

    try {
      const response = await fetch(`/api/backend/api/v1/platform-revenues/${deletingRevenue.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('删除失败')
      }

      setDeleteDialogOpen(false)
      setDeletingRevenue(null)
      fetchRevenues()
      notify({ type: 'success', title: '回款记录已删除' })
    } catch (error) {
      console.error('Error deleting revenue:', error)
      notify({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '删除失败',
      })
    }
  }

  // 删除图片附件
  const handleRemoveImage = (imageId: string) => {
    setFormData((prev) => ({
      ...prev,
      attachments: prev.attachments.filter((image) => image.id !== imageId),
    }))
  }

  // 导出 Excel
  const handleExport = async () => {
    setExporting(true)
    try {
      // 获取所有筛选数据（分页拉取，后端限制 page_size 最大 200）
      const allRevenues: PlatformRevenue[] = []
      let currentPage = 1
      let totalPages = 1

      do {
        const queryParams = new URLSearchParams()
        if (filters.project_id) queryParams.append('project_id', filters.project_id)
        if (filters.year) queryParams.append('year', filters.year)
        if (filters.month) queryParams.append('month', filters.month)
        if (filters.currency) queryParams.append('currency', filters.currency)
        if (filters.revenue_type) queryParams.append('revenue_type', filters.revenue_type)
        queryParams.append('page', currentPage.toString())
        queryParams.append('page_size', '200')

        const response = await fetch(`/api/backend/api/v1/platform-revenues?${queryParams}`)
        if (!response.ok) throw new Error('获取导出数据失败')

        const result = await response.json()
        allRevenues.push(...(result.items || []))
        totalPages = result.total_pages || 1
        currentPage++
      } while (currentPage <= totalPages)

      if (allRevenues.length === 0) {
        notify({ type: 'warning', title: '暂无数据可导出' })
        return
      }

      // 动态导入 ExcelJS
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'BelieveBoy Dashboard'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('平台回款')
      disableGridLines(worksheet)

      // 设置列宽（不设 header，避免与后续 mergeCells 冲突）
      worksheet.columns = [
        { key: 'received_date', width: 14 },
        { key: 'project_name', width: 20 },
        { key: 'country', width: 8 },
        { key: 'amount', width: 14 },
        { key: 'currency', width: 8 },
        { key: 'revenue_type', width: 12 },
        { key: 'note', width: 30 },
      ]

      // 表头行（首行即列头，去掉原标题行与筛选信息行）
      const headerLabels = ['回款日期', '项目', '站点', '金额', '币种', '回款类型', '备注']
      let currentRow = 1
      const headerRow = worksheet.getRow(currentRow)
      headerLabels.forEach((label, i) => {
        const cell = headerRow.getCell(i + 1)
        cell.value = label
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      currentRow++

      // 数据行
      const dataStartRow = currentRow
      allRevenues.forEach((revenue: PlatformRevenue, index: number) => {
        const row = worksheet.getRow(dataStartRow + index)
        row.values = [
          revenue.received_date,
          revenue.project_name,
          revenue.country,
          parseFloat(revenue.amount),
          revenue.currency,
          revenue.revenue_type || '订单回款',
          revenue.note || '',
        ]
        applyDataRowBanding({
          worksheet,
          startRow: dataStartRow + index,
          rowCount: 1,
          columnCount: headerLabels.length,
          dataRowOffset: index,
        })
        // 设置默认字体（Microsoft YaHei），后续条件样式会覆盖
        for (let col = 1; col <= 7; col++) {
          row.getCell(col).font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
        }
        row.getCell(1).alignment = { horizontal: 'left' }
        row.getCell(2).alignment = { horizontal: 'left' }
        row.getCell(3).alignment = { horizontal: 'center' }
        row.getCell(4).numFmt = '#,##0.00'
        row.getCell(4).alignment = { horizontal: 'right' }
        row.getCell(5).alignment = { horizontal: 'center' }
        row.getCell(6).alignment = { horizontal: 'center' }
        row.getCell(7).alignment = { horizontal: 'left' }

        // 为回款类型单元格添加颜色
        const revenueType = revenue.revenue_type || '订单回款'
        const typeCell = row.getCell(6)
        if (revenueType === 'B2B回款') {
          typeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } }
          typeCell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF6B21A8' } }
        } else {
          typeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
          typeCell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF1E40AF' } }
        }

        // 为站点单元格添加颜色
        const countryCell = row.getCell(3)
        const countryMeta = getCountryBadgeMeta(revenue.country)
        {
          const countryColorMap: Record<string, { bg: string; fg: string }> = {
            US: { bg: 'FFF1F2', fg: 'BE123C' },
            UK: { bg: 'FAF5FF', fg: '7E22CE' },
            DE: { bg: 'ECFEFF', fg: '0369A1' },
            CA: { bg: 'ECFDF5', fg: '047857' },
            JP: { bg: 'FFF1F2', fg: 'BE123C' },
            AU: { bg: 'FFFBEB', fg: 'B45309' },
            MX: { bg: 'F0FDFA', fg: '0D9488' },
            BR: { bg: 'F0FDF4', fg: '15803D' },
          }
          const countryColors = countryColorMap[countryMeta.code] || {
            bg: 'F8FAFC',
            fg: '64748B',
          }
          countryCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: countryColors.bg },
          }
          countryCell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: countryColors.fg },
          }
        }

        // 为币种单元格添加颜色
        const currencyCell = row.getCell(5)
        const currencyMeta = getCurrencyBadgeMeta(revenue.currency)
        if (currencyMeta.symbol !== '¤') {
          const currencyColorMap: Record<string, { bg: string; fg: string }> = {
            $: { bg: 'ECFDF5', fg: '047857' },
            '£': { bg: 'FFFBEB', fg: 'B45309' },
            '€': { bg: 'F0F9FF', fg: '0369A1' },
          }
          const currencyColors = currencyColorMap[currencyMeta.symbol] || {
            bg: 'F8FAFC',
            fg: '64748B',
          }
          currencyCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: currencyColors.bg },
          }
          currencyCell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: currencyColors.fg },
          }
        }

        // 添加边框
        for (let col = 1; col <= 7; col++) {
          const cell = row.getCell(col)
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
        }
      })

      // 添加合计行
      const totals = calculateTotals(allRevenues)
      const totalSummary = formatCurrencyTotalsForExcel(totals)
      const totalRowIndex = dataStartRow + allRevenues.length
      const totalRow = worksheet.getRow(totalRowIndex)
      totalRow.values = [...buildCurrencyTotalRow(totalSummary)]
      for (let col = 1; col <= 7; col++) {
        totalRow.getCell(col).font = { name: 'Microsoft YaHei', bold: true }
      }
      if (typeof totalSummary.amount === 'number') {
        totalRow.getCell(4).numFmt = '#,##0.00'
      }

      // 为合计行添加浅色背景
      for (let col = 1; col <= 7; col++) {
        const cell = totalRow.getCell(col)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'medium', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'medium', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      }

      // 生成并下载
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const date = new Date().toISOString().slice(0, 10)
      const projectName = filters.project_id
        ? projects.find((p) => p.id.toString() === filters.project_id)?.name || filters.project_id
        : '全部项目'
      const uniqueCountries = Array.from(new Set(allRevenues.map((r) => r.country).filter(Boolean)))
      const derivedCountryLabel =
        uniqueCountries.length === 1 ? getCountryLabel(uniqueCountries[0]) : '全部站点'
      const safeProjectName = projectName.replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = derivedCountryLabel.replace(/[\\/:*?"<>|]/g, '-')
      downloadBlob(blob, `${safeProjectName}_${safeCountryLabel}-平台回款-${date}.xlsx`)

      notify({ type: 'success', title: `已导出 ${allRevenues.length} 条记录` })
    } catch (error) {
      console.error('Export error:', error)
      notify({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setExporting(false)
    }
  }

  const filterControls = (
    <div className={styles.filters} role="group" aria-label="平台回款筛选">
      <div className={styles.projectFilterGroup} aria-busy={projectsLoading || undefined}>
        <WarmSelect
          id="platform-revenue-project-filter"
          label="项目"
          value={filters.project_id || ALL_FILTER_VALUE}
          options={[
            { value: ALL_FILTER_VALUE, label: '全部项目' },
            ...projects.map((project) => ({
              value: project.id.toString(),
              label: project.name,
            })),
          ]}
          onChange={(value) =>
            handleFilterChange('project_id', value === ALL_FILTER_VALUE ? '' : value)
          }
          disabled={projectsLoading}
          error={projectsError}
          className={styles.filterProject}
        />
        {projectsLoading ? (
          <span className={styles.projectFilterLoading} role="status">
            正在加载项目
          </span>
        ) : projectsError ? (
          <div className={styles.projectFilterStatus}>
            <WarmButton
              className={styles.projectFilterRetry}
              variant="quiet"
              onClick={() => void fetchProjects()}
            >
              重试
            </WarmButton>
          </div>
        ) : null}
      </div>
      <WarmSelect
        id="platform-revenue-year-filter"
        label="年份"
        value={filters.year || ALL_FILTER_VALUE}
        options={[
          { value: ALL_FILTER_VALUE, label: '全部年份' },
          ...getYearOptions().map((year) => ({
            value: year.value.toString(),
            label: year.label,
          })),
        ]}
        onChange={(value) =>
          handleFilterChange('year', value === ALL_FILTER_VALUE ? '' : value)
        }
        className={styles.filterSelect}
      />
      <WarmSelect
        id="platform-revenue-month-filter"
        label="月份"
        value={filters.month || ALL_FILTER_VALUE}
        options={[
          { value: ALL_FILTER_VALUE, label: '全部月份' },
          ...MONTH_OPTIONS.map((month) => ({
            value: month.value.toString(),
            label: month.label,
          })),
        ]}
        onChange={(value) =>
          handleFilterChange('month', value === ALL_FILTER_VALUE ? '' : value)
        }
        className={styles.filterSelect}
      />
      <WarmSelect
        id="platform-revenue-currency-filter"
        label="币种"
        value={filters.currency || ALL_FILTER_VALUE}
        options={[
          { value: ALL_FILTER_VALUE, label: '全部币种' },
          ...CURRENCY_OPTIONS.map((currency) => ({
            value: currency.value,
            label: currency.label,
          })),
        ]}
        onChange={(value) =>
          handleFilterChange('currency', value === ALL_FILTER_VALUE ? '' : value)
        }
        className={styles.filterSelect}
      />
      <WarmSelect
        id="platform-revenue-type-filter"
        label="回款类型"
        value={filters.revenue_type || ALL_FILTER_VALUE}
        options={[
          { value: ALL_FILTER_VALUE, label: '全部类型' },
          { value: '订单回款', label: '订单回款' },
          { value: 'B2B回款', label: 'B2B回款' },
        ]}
        onChange={(value) =>
          handleFilterChange('revenue_type', value === ALL_FILTER_VALUE ? '' : value)
        }
        className={styles.filterSelect}
      />
      <WarmButton
        className={styles.filterReset}
        variant="quiet"
        aria-label="重置筛选"
        onClick={resetFilters}
      >
        重置
      </WarmButton>
    </div>
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  const selectedProject = projects.find((p) => p.id.toString() === filters.project_id)
  const projectLabel = selectedProject ? selectedProject.name : '全部项目'
  const yearLabel = filters.year ? `${filters.year}年` : '全部年份'
  const monthLabel = filters.month ? `${filters.month}月` : '全部月份'
  const mobileFilterSummary = `${projectLabel} · ${yearLabel} · ${monthLabel}`

  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      variant="warm-ledger"
      className={styles.mobileFilterStrip}
      controls={
        <>
          <WarmSelect
            id="platform-revenue-mobile-project"
            label="项目"
            value={filters.project_id || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部项目' },
              ...projects.map((project) => ({
                value: project.id.toString(),
                label: project.name,
              })),
            ]}
            onChange={(value) =>
              handleFilterChange('project_id', value === ALL_FILTER_VALUE ? '' : value)
            }
            disabled={projectsLoading}
            error={projectsError}
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="platform-revenue-mobile-year"
            label="年份"
            value={filters.year || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部年份' },
              ...getYearOptions().map((year) => ({
                value: year.value.toString(),
                label: year.label,
              })),
            ]}
            onChange={(value) =>
              handleFilterChange('year', value === ALL_FILTER_VALUE ? '' : value)
            }
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="platform-revenue-mobile-month"
            label="月份"
            value={filters.month || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部月份' },
              ...MONTH_OPTIONS.map((month) => ({
                value: month.value.toString(),
                label: month.label,
              })),
            ]}
            onChange={(value) =>
              handleFilterChange('month', value === ALL_FILTER_VALUE ? '' : value)
            }
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="platform-revenue-mobile-currency"
            label="币种"
            value={filters.currency || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部币种' },
              ...CURRENCY_OPTIONS.map((currency) => ({
                value: currency.value,
                label: currency.label,
              })),
            ]}
            onChange={(value) =>
              handleFilterChange('currency', value === ALL_FILTER_VALUE ? '' : value)
            }
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="platform-revenue-mobile-type"
            label="回款类型"
            value={filters.revenue_type || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部类型' },
              { value: '订单回款', label: '订单回款' },
              { value: 'B2B回款', label: 'B2B回款' },
            ]}
            onChange={(value) =>
              handleFilterChange('revenue_type', value === ALL_FILTER_VALUE ? '' : value)
            }
            className={styles.mobileFilterWide}
          />
          <MobileFilterWide>
            <WarmButton
              variant="quiet"
              className={styles.mobileResetButton}
              onClick={resetFilters}
            >
              重置筛选
            </WarmButton>
          </MobileFilterWide>
        </>
      }
    />
  )

  return (
    <div className={styles.page} data-warm-platform-revenue="true">
      {headerSlotPortal}
      {mobileFilterStrip}

      {!loading && !loadError && revenues.length > 0 ? (
        <div className={styles.mobileSummaryBanner} role="status">
          <span className={styles.mobileSummaryLabel}>当前页合计</span>
          <span className={styles.mobileSummaryValue}>{formatTotals(calculateTotals(revenues))}</span>
        </div>
      ) : null}

      <section
        className={styles.panel}
        data-warm-platform-revenue-panel="true"
        aria-labelledby="platform-revenue-title"
      >
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle} id="platform-revenue-title">
              平台回款
            </h2>
          </div>
          <div className={styles.panelActions}>
            <WarmButton
              className={styles.actionButton}
              variant="secondary"
              onClick={handleExport}
              disabled={revenues.length === 0}
              loading={exporting}
              loadingLabel="正在导出平台回款"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {exporting ? '导出中…' : '导出 Excel'}
            </WarmButton>
            <WarmButton
              className={styles.actionButton}
              variant="primary"
              onClick={handleAdd}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              新增回款
            </WarmButton>
          </div>
        </header>

        <div
          className={styles.tableRegion}
          role="region"
          aria-label="平台回款表格"
          aria-busy={loading || undefined}
          data-warm-platform-revenue-table="true"
          tabIndex={0}
        >
          <table className={styles.table} aria-label="平台回款">
            <thead>
              <tr>
                <th scope="col">回款日期</th>
                <th scope="col">项目</th>
                <th scope="col">站点</th>
                <th className={styles.numeric} scope="col">
                  金额
                </th>
                <th scope="col">币种</th>
                <th scope="col">回款类型</th>
                <th scope="col">备注</th>
                <th className={styles.numeric} scope="col">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <>
                  <tr>
                    <td colSpan={8}>
                      <p className={styles.loadingLabel} role="status">
                        正在加载平台回款
                      </p>
                    </td>
                  </tr>
                  {Array.from({ length: 6 }).map((_, rowIndex) => (
                    <tr key={`skeleton-${rowIndex}`}>
                      {Array.from({ length: 8 }).map((__, columnIndex) => (
                        <td key={columnIndex}>
                          <span
                            className={cn(
                              styles.skeletonBar,
                              columnIndex > 0 && styles.skeletonBarNumeric
                            )}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              ) : loadError ? (
                <tr className={styles.messageRow}>
                  <td colSpan={8}>
                    <div
                      className={cn(styles.message, styles.errorMessage, styles.errorState)}
                      role="alert"
                    >
                      {loadError}
                      <WarmButton variant="quiet" onClick={() => void fetchRevenues()}>
                        重试
                      </WarmButton>
                    </div>
                  </td>
                </tr>
              ) : revenues.length === 0 ? (
                <tr className={styles.messageRow}>
                  <td colSpan={8}>
                    <p className={styles.message} role="status">
                      暂无回款数据，点击右上角「新增回款」录入
                    </p>
                  </td>
                </tr>
              ) : (
                revenues.map((revenue) => {
                  const currencyMeta = getCurrencyBadgeMeta(revenue.currency)
                  const countryMeta = getCountryBadgeMeta(revenue.country)
                  return (
                    <tr key={revenue.id}>
                      <td className={styles.date}>{revenue.received_date.slice(0, 10)}</td>
                      <td className={styles.project} title={revenue.project_name}>
                        {revenue.project_name}
                      </td>
                      <td title={`${countryMeta.code} - ${countryMeta.accent}`}>
                        <span className={styles.siteCode}>{countryMeta.code}</span>
                      </td>
                      <td className={styles.amount}>
                        {formatCurrency(revenue.amount, revenue.currency)}
                      </td>
                      <td title={`${revenue.currency} - ${currencyMeta.accent}`}>
                        <WarmBadge className={styles.currencyBadge}>
                          <span className={styles.currencySymbol}>{currencyMeta.symbol}</span>{' '}
                          {revenue.currency}
                        </WarmBadge>
                      </td>
                      <td>
                        <WarmBadge>{revenue.revenue_type || '订单回款'}</WarmBadge>
                      </td>
                      <td className={styles.noteCell} title={revenue.note || undefined}>
                        <span className={styles.noteText}>
                          {revenue.note || (revenue.attachments?.length > 0 ? '' : '-')}
                        </span>
                        {revenue.attachments?.length > 0 ? (
                          <span className={styles.thumbnailList}>
                            {revenue.attachments.slice(0, 3).map((image) => (
                              <button
                                key={image.id}
                                type="button"
                                className={styles.thumbnailButton}
                                onClick={() => setPreviewImage(image.url)}
                                title={image.filename}
                                aria-label={`预览附件 ${image.filename}`}
                              >
                                <Image
                                  src={image.url}
                                  alt=""
                                  fill
                                  sizes="22px"
                                  className={styles.thumbnailImage}
                                  unoptimized
                                />
                              </button>
                            ))}
                            {revenue.attachments.length > 3 ? (
                              <span className={styles.attachmentOverflow}>
                                +{revenue.attachments.length - 3}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </td>
                      <td className={styles.numeric}>
                        <span className={styles.rowActions}>
                          <WarmIconButton
                            className={styles.rowAction}
                            aria-label={`编辑回款 ${revenue.project_name}`}
                            onClick={() => handleEdit(revenue)}
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </WarmIconButton>
                          <WarmIconButton
                            className={`${styles.rowAction} ${styles.rowActionDanger}`}
                            aria-label={`删除回款 ${revenue.project_name}`}
                            onClick={() => handleDeleteClick(revenue)}
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </WarmIconButton>
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {!loading && !loadError && revenues.length > 0 ? (
              <tfoot>
                <tr className={styles.totalRow}>
                  <td className={styles.totalLabel} colSpan={3}>
                    合计（当前页）
                  </td>
                  <td className={styles.totalValue}>{formatTotals(calculateTotals(revenues))}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      <nav
        className={styles.pagination}
        aria-label="平台回款分页"
        aria-busy={loading || undefined}
      >
        {loading || loadError ? (
          <span className={styles.paginationPlaceholder} aria-hidden="true" />
        ) : pagination.total === 0 ? (
          <span>共 0 条</span>
        ) : (
          <span>
            共 {pagination.total} 条 · 第 {pagination.page}/{pagination.total_pages} 页
          </span>
        )}
        <div className={styles.paginationActions}>
          <WarmButton
            className={styles.paginationButton}
            variant="quiet"
            onClick={() =>
              setPagination((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }))
            }
            disabled={loading || Boolean(loadError) || pagination.page <= 1}
          >
            上一页
          </WarmButton>
          <WarmButton
            className={styles.paginationButton}
            variant="quiet"
            onClick={() =>
              setPagination((prev) => ({
                ...prev,
                page: Math.min(prev.total_pages, prev.page + 1),
              }))
            }
            disabled={
              loading ||
              Boolean(loadError) ||
              pagination.total_pages === 0 ||
              pagination.page >= pagination.total_pages
            }
          >
            下一页
          </WarmButton>
        </div>
      </nav>

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-describedby="platform-revenue-dialog-description"
          className={cn('warm-ledger', styles.dialog)}
        >
          <span id="platform-revenue-dialog-description" className="sr-only">
            {editingRevenue ? '修改回款记录' : '录入新的回款记录'}
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>
              {editingRevenue ? '编辑回款记录' : '新增回款记录'}
            </DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              {editingRevenue ? '修改回款信息，保存后将立即生效' : '录入新的回款记录'}
            </DialogDescription>
          </DialogHeader>

          <div className={styles.form}>
            <div className={styles.formGrid}>
              <WarmSelect
                id="platform-revenue-project"
                label="项目 *"
                value={formData.project_id}
                placeholder="选择项目"
                options={projects.map((project) => ({
                  value: project.id.toString(),
                  label: project.name,
                }))}
                onChange={(value) => {
                  const selectedProject = projects.find((project) => project.id.toString() === value)
                  setFormData((prev) => ({
                    ...prev,
                    project_id: value,
                    project_name: selectedProject?.name || '',
                    country: 'US',
                    currency: 'USD',
                    currencyLocked: true,
                  }))
                }}
              />
              <WarmSelect
                id="platform-revenue-country"
                label="站点 *"
                value={formData.country}
                placeholder="选择站点"
                options={COUNTRY_OPTIONS.map((country) => ({
                  value: country.value,
                  label: country.label,
                }))}
                disabled={!formData.project_id}
                onChange={(value) => {
                  const currencyMap: Record<string, string> = {
                    US: 'USD',
                    UK: 'GBP',
                    DE: 'EUR',
                  }
                  const newCurrency = currencyMap[value] || formData.currency
                  const isLocked = !!currencyMap[value]

                  setFormData((prev) => ({
                    ...prev,
                    country: value,
                    currency: newCurrency,
                    currencyLocked: isLocked,
                  }))
                }}
              />
            </div>

            <div className={styles.formGrid}>
              <div className={styles.field}>
                <Label className={styles.fieldLabel} htmlFor="platform-revenue-received-date">
                  回款日期 <span className={styles.required}>*</span>
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <WarmButton
                      id="platform-revenue-received-date"
                      className={styles.dateButton}
                      variant="secondary"
                    >
                      <CalendarIcon className="h-4 w-4" aria-hidden="true" />
                      {formData.received_date ? (
                        <span>{format(formData.received_date, 'yyyy-MM-dd')}</span>
                      ) : (
                        <span className={styles.datePlaceholder}>选择日期</span>
                      )}
                    </WarmButton>
                  </PopoverTrigger>
                  <PopoverContent
                    className={cn('warm-ledger', styles.calendarPopover)}
                    align="start"
                  >
                    <Calendar
                      mode="single"
                      selected={formData.received_date || undefined}
                      onSelect={(date) =>
                        setFormData((prev) => ({ ...prev, received_date: date || null }))
                      }
                      initialFocus
                      locale={zhCN}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className={styles.field}>
                <Label className={styles.fieldLabel} htmlFor="platform-revenue-amount">
                  回款金额 <span className={styles.required}>*</span>
                </Label>
                <input
                  id="platform-revenue-amount"
                  type="text"
                  inputMode="decimal"
                  value={formData.amount}
                  onChange={(event) => {
                    const formatted = formatAmountInput(event.target.value)
                    setFormData((prev) => ({ ...prev, amount: formatted }))
                  }}
                  placeholder="0.00"
                  className={styles.input}
                />
              </div>
            </div>

            <div className={styles.formGrid}>
              <WarmSelect
                id="platform-revenue-currency"
                label="币种 *"
                value={formData.currency}
                options={CURRENCY_OPTIONS.map((currency) => ({
                  value: currency.value,
                  label: currency.label,
                }))}
                disabled={formData.currencyLocked}
                onChange={(value) => {
                  if (!formData.currencyLocked) {
                    setFormData((prev) => ({ ...prev, currency: value }))
                  }
                }}
              />
              <WarmSelect
                id="platform-revenue-type"
                label="回款类型 *"
                value={formData.revenue_type}
                options={[
                  { value: '订单回款', label: '订单回款' },
                  { value: 'B2B回款', label: 'B2B回款' },
                ]}
                onChange={(value) =>
                  setFormData((prev) => ({ ...prev, revenue_type: value }))
                }
              />
            </div>

            <div className={styles.field}>
              <Label className={styles.fieldLabel} htmlFor="platform-revenue-note">
                备注
              </Label>
              <textarea
                id="platform-revenue-note"
                value={formData.note}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, note: event.target.value }))
                }
                placeholder="可选：添加相关备注信息"
                rows={2}
                className={styles.textarea}
              />
            </div>

            <div className={styles.field}>
              <Label className={styles.fieldLabel}>图片附件</Label>
              <div className={styles.uploadZone}>
                <UploadZone
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  maxSize={10}
                  onUpload={async (file) => {
                    if (!formData.project_name) {
                      notify({ type: 'error', title: '请先选择项目' })
                      return
                    }

                    setImageUploadState({ status: 'uploading', message: '上传中…' })
                    setUploadingImage(true)
                    try {
                      const uploadFormData = new FormData()
                      uploadFormData.append('file', file)
                      uploadFormData.append('project_name', formData.project_name)

                      const response = await fetch(
                        '/api/backend/api/v1/platform-revenues/upload-image',
                        {
                          method: 'POST',
                          body: uploadFormData,
                        }
                      )
                      if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}))
                        throw new Error(errorData.detail || '上传图片失败')
                      }

                      const result = await response.json()
                      if (!result.id || !result.url) {
                        throw new Error('图片信息异常')
                      }

                      setFormData((prev) => ({
                        ...prev,
                        attachments: [...prev.attachments, result],
                      }))
                      setImageUploadState({ status: 'success', message: '上传成功' })
                      setTimeout(
                        () => setImageUploadState({ status: 'idle', message: '' }),
                        2000
                      )
                    } catch (error) {
                      console.error('Error uploading image:', error)
                      setImageUploadState({
                        status: 'error',
                        message: error instanceof Error ? error.message : '上传失败',
                      })
                      setTimeout(
                        () => setImageUploadState({ status: 'idle', message: '' }),
                        3000
                      )
                      throw error
                    } finally {
                      setUploadingImage(false)
                    }
                  }}
                  uploadingText={imageUploadState.message || '上传中…'}
                  disabled={uploadingImage}
                />
              </div>
              {imageUploadState.message && imageUploadState.status !== 'idle' ? (
                <p
                  className={cn(
                    styles.uploadStatus,
                    imageUploadState.status === 'error' && styles.uploadError,
                    imageUploadState.status === 'success' && styles.uploadSuccess
                  )}
                  role={imageUploadState.status === 'error' ? 'alert' : 'status'}
                >
                  {imageUploadState.message}
                </p>
              ) : null}
              {formData.attachments.length > 0 ? (
                <div className={styles.attachmentGrid}>
                  {formData.attachments.map((image) => (
                    <div key={image.id} className={styles.attachmentItem}>
                      <div className={styles.attachmentTile}>
                        <button
                          type="button"
                          className={styles.attachmentImageButton}
                          onClick={() => setPreviewImage(image.url)}
                          aria-label={`预览附件 ${image.filename}`}
                        >
                          <Image
                            src={image.url}
                            alt=""
                            fill
                            className={styles.thumbnailImage}
                            unoptimized
                          />
                        </button>
                        <button
                          type="button"
                          className={styles.removeImageButton}
                          onClick={() => handleRemoveImage(image.id)}
                          aria-label={`移除附件 ${image.filename}`}
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                      <div className={styles.attachmentName} title={image.filename}>
                        {image.filename}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <DialogFooter className={styles.dialogFooter}>
            <WarmButton variant="quiet" onClick={() => setDialogOpen(false)}>
              取消
            </WarmButton>
            <WarmButton variant="primary" onClick={handleSubmit}>
              {editingRevenue ? '保存修改' : '确认创建'}
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          aria-describedby="delete-revenue-dialog-description"
          className={cn('warm-ledger', styles.dialog)}
        >
          <span id="delete-revenue-dialog-description" className="sr-only">
            确认删除回款记录
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>确认删除</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              您确定要删除这条回款记录吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deletingRevenue ? (
            <div className={styles.deleteSummary}>
              <p>
                <strong>项目：</strong> {deletingRevenue.project_name}
              </p>
              <p>
                <strong>日期：</strong>{' '}
                <span className={styles.deleteValue}>
                  {new Date(deletingRevenue.received_date).toLocaleDateString('zh-CN')}
                </span>
              </p>
              <p>
                <strong>金额：</strong>{' '}
                <span className={styles.deleteValue}>
                  {formatCurrency(deletingRevenue.amount, deletingRevenue.currency)}
                </span>
              </p>
            </div>
          ) : null}
          <DialogFooter className={styles.dialogFooter}>
            <WarmButton variant="quiet" onClick={() => setDeleteDialogOpen(false)}>
              取消
            </WarmButton>
            <WarmButton
              variant="secondary"
              className={styles.dangerButton}
              onClick={handleDelete}
            >
              确认删除
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!previewImage}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewImage(null)
            setPreviewZoomed(false)
          }
        }}
      >
        <DialogContent
          className={cn('warm-ledger', styles.dialog, styles.previewDialog)}
          data-warm-attachment-preview="true"
        >
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          <DialogDescription className="sr-only">查看回款附件大图</DialogDescription>
          <button
            type="button"
            className={styles.previewViewport}
            onClick={() => setPreviewZoomed((current) => !current)}
            aria-label={previewZoomed ? '缩小图片' : '放大图片'}
            title={previewZoomed ? '点击缩小' : '点击放大'}
          >
            {previewImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewImage}
                alt="图片预览"
                className={cn(
                  styles.previewImage,
                  previewZoomed && styles.previewImageZoomed
                )}
              />
            ) : null}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
