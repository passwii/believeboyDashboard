'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UploadZone } from '@/components/ui/upload-zone'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { Textarea } from '@/components/ui/textarea'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  useHeaderRefresh,
  useHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import { cn } from '@/lib/utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { getCountryLabel } from '@/lib/country'
import { disableGridLines } from '@/lib/excel-styles'
import { useNotifications } from '@/components/notifications'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  CalendarIcon,
  Pencil,
  Trash2,
  Plus,
  Loader2,
  X,
  Download,
} from 'lucide-react'

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

// 格式化合计行显示
const formatTotals = (totals: Record<string, number>) => {
  return Object.entries(totals)
    .map(
      ([currency, amount]) =>
        `${CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol || currency}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    )
    .join(' | ')
}

/** 币种 → mono 符号 + term 语义色（终端化：去渐变 Badge，走文本语义色） */
const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()
  switch (normalizedCurrency) {
    case 'USD':
      return { symbol: '$', accent: '美元', tone: 'pos' as const }
    case 'GBP':
      return { symbol: '£', accent: '英镑', tone: 'warn' as const }
    case 'EUR':
      return { symbol: '€', accent: '欧元', tone: undefined }
    default:
      return { symbol: '¤', accent: '其他货币', tone: 'muted' as const }
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
  const isMobile = useIsMobile()
  const isAdmin = Boolean(session?.user?.isAdmin)

  // 状态
  const [revenues, setRevenues] = useState<PlatformRevenue[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
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
    try {
      // 复用 projects/manage 2min 客户端缓存（BEL-424）：跨页共享项目列表。
      const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
      const items = Array.isArray(data) ? data : []
      setProjects(items)
    } catch (error) {
      console.error('Error fetching projects:', error)
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
        throw new Error('Failed to fetch revenues')
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
      setLoadError(error instanceof Error ? error.message : '回款数据加载失败')
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

  const formatFileSize = (size: number) => {
    if (size < 1024) return `${size}B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
    return `${(size / (1024 * 1024)).toFixed(1)}MB`
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
      const totalRowIndex = dataStartRow + allRevenues.length
      const totalRow = worksheet.getRow(totalRowIndex)
      totalRow.values = [
        '合计',
        '',
        '',
        Object.values(totals).reduce((sum, v) => sum + v, 0),
        Object.keys(totals).join('/'),
        '',
        '',
      ]
      for (let col = 1; col <= 7; col++) {
        totalRow.getCell(col).font = { name: 'Microsoft YaHei', bold: true }
      }
      totalRow.getCell(4).numFmt = '#,##0.00'

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
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const date = new Date().toISOString().slice(0, 10)
      const projectName = filters.project_id
        ? projects.find((p) => p.id.toString() === filters.project_id)?.name || filters.project_id
        : '全部项目'
      const uniqueCountries = Array.from(new Set(allRevenues.map((r) => r.country).filter(Boolean)))
      const derivedCountryLabel =
        uniqueCountries.length === 1 ? getCountryLabel(uniqueCountries[0]) : '全部站点'
      const safeProjectName = projectName.replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = derivedCountryLabel.replace(/[\\/:*?"<>|]/g, '-')
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-平台回款-${date}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

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
    <>
      <Select
        value={filters.project_id || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('project_id', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[160px]">
          <SelectValue placeholder="全部项目" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部项目</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id.toString()}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.year || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('year', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[110px]">
          <SelectValue placeholder="全部年份" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部年份</SelectItem>
          {getYearOptions().map((year) => (
            <SelectItem key={year.value} value={year.value.toString()}>
              {year.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.month || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('month', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[100px]">
          <SelectValue placeholder="全部月份" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部月份</SelectItem>
          {MONTH_OPTIONS.map((month) => (
            <SelectItem key={month.value} value={month.value.toString()}>
              {month.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.currency || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('currency', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[130px]">
          <SelectValue placeholder="全部币种" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部币种</SelectItem>
          {CURRENCY_OPTIONS.map((currency) => (
            <SelectItem key={currency.value} value={currency.value}>
              {currency.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.revenue_type || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('revenue_type', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[120px]">
          <SelectValue placeholder="全部类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部类型</SelectItem>
          <SelectItem value="订单回款">订单回款</SelectItem>
          <SelectItem value="B2B回款">B2B回款</SelectItem>
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="sm"
        onClick={resetFilters}
        className="h-7 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
      >
        重置
      </Button>
    </>
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={isMobile} controls={filterControls} />
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* BLF-826 阶段 C：筛选控件已上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      {headerSlotPortal}

      {/* 数据表格 */}
      <TermPanel
        title="平台回款"
        bodyClassName="min-h-0 overflow-hidden"
        actions={
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
              onClick={handleExport}
              disabled={exporting || revenues.length === 0}
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              {exporting ? '导出中...' : '导出 Excel'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
              onClick={handleAdd}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              新增回款
            </Button>
          </div>
        }
      >
        {/* 滚动收口在面板内（Canvas 内滚动），表头 sticky */}
        <div className="max-h-[calc(100vh-280px)] min-h-[240px] overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>回款日期</TermHead>
                <TermHead>项目</TermHead>
                <TermHead>站点</TermHead>
                <TermHead numeric>金额</TermHead>
                <TermHead>币种</TermHead>
                <TermHead>回款类型</TermHead>
                <TermHead>备注</TermHead>
                <TermHead numeric>操作</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TermRow key={`skeleton-${i}`} className="hover:bg-transparent">
                    {Array.from({ length: 8 }).map((__, j) => (
                      <TermCell key={j}>
                        <Skeleton className="h-3.5 w-full max-w-[80px] rounded-none" />
                      </TermCell>
                    ))}
                  </TermRow>
                ))
              ) : loadError ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={8} className="h-24 text-center" tone="neg">
                    <span className="inline-flex items-center justify-center gap-2">{loadError}</span>
                  </TermCell>
                </TermRow>
              ) : revenues.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={8} className="h-24 text-center" tone="muted">
                    暂无回款数据，点击右上角「新增回款」录入
                  </TermCell>
                </TermRow>
              ) : (
                <>
                  {revenues.map((revenue) => {
                    const currencyMeta = getCurrencyBadgeMeta(revenue.currency)
                    const countryMeta = getCountryBadgeMeta(revenue.country)
                    return (
                      <TermRow key={revenue.id}>
                        <TermCell className="whitespace-nowrap font-mono">
                          {revenue.received_date.slice(0, 10)}
                        </TermCell>
                        <TermCell title={revenue.project_name}>{revenue.project_name}</TermCell>
                        <TermCell tone="muted" title={`${countryMeta.code} - ${countryMeta.accent}`}>
                          {countryMeta.code}
                        </TermCell>
                        <TermCell numeric className="font-medium">
                          {formatCurrency(revenue.amount, revenue.currency)}
                        </TermCell>
                        <TermCell tone={currencyMeta.tone} title={`${revenue.currency} - ${currencyMeta.accent}`}>
                          {currencyMeta.symbol} {revenue.currency}
                        </TermCell>
                        <TermCell tone={revenue.revenue_type === 'B2B回款' ? 'warn' : undefined}>
                          {revenue.revenue_type || '订单回款'}
                        </TermCell>
                        <TermCell
                          className="max-w-[260px] truncate"
                          title={revenue.note || undefined}
                        >
                          {revenue.note || (revenue.attachments?.length > 0 ? '' : '-')}
                          {revenue.attachments?.length > 0 && (
                            <span className="ml-1 inline-flex gap-0.5 align-middle">
                              {revenue.attachments.slice(0, 3).map((image) => (
                                <button
                                  key={image.id}
                                  type="button"
                                  className="relative h-5 w-5 shrink-0 overflow-hidden border border-term-border align-middle"
                                  onClick={() => setPreviewImage(image.url)}
                                  title={image.filename}
                                >
                                  <Image
                                    src={image.url}
                                    alt={image.filename}
                                    fill
                                    sizes="20px"
                                    className="object-cover"
                                    unoptimized
                                  />
                                </button>
                              ))}
                              {revenue.attachments.length > 3 && (
                                <span className="font-mono text-[10px] text-term-muted">
                                  +{revenue.attachments.length - 3}
                                </span>
                              )}
                            </span>
                          )}
                        </TermCell>
                        <TermCell numeric>
                          <span className="inline-flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-text"
                              onClick={() => handleEdit(revenue)}
                              title="编辑"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-neg"
                              onClick={() => handleDeleteClick(revenue)}
                              title="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </Button>
                          </span>
                        </TermCell>
                      </TermRow>
                    )
                  })}
                  {/* 合计行 */}
                  <TermRow highlight className="[&>td]:font-semibold [&>td]:bg-term-raised hover:bg-term-raised">
                    <TermCell colSpan={3}>合计（当前页）</TermCell>
                    <TermCell numeric>{formatTotals(calculateTotals(revenues))}</TermCell>
                    <TermCell colSpan={4} />
                  </TermRow>
                </>
              )}
            </TermBody>
          </TermTable>
        </div>
      </TermPanel>

      {/* 分页：终端工具条规格 */}
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs tabular-nums text-term-muted">
        <span>
          共 {pagination.total} 条 · 第 {pagination.page}/{pagination.total_pages} 页
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text"
            onClick={() =>
              setPagination((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }))
            }
            disabled={pagination.page <= 1}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text"
            onClick={() =>
              setPagination((prev) => ({
                ...prev,
                page: Math.min(prev.total_pages, prev.page + 1),
              }))
            }
            disabled={pagination.page >= pagination.total_pages}
          >
            下一页
          </Button>
        </div>
      </div>

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-describedby="platform-revenue-dialog-description"
          className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg sm:max-w-[520px] dark:border-border/90 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="platform-revenue-dialog-description" className="sr-only">
            {editingRevenue ? '修改回款记录' : '录入新的回款记录'}
          </span>
          <DialogHeader>
            <DialogTitle>{editingRevenue ? '编辑回款记录' : '新增回款记录'}</DialogTitle>
            <DialogDescription>
              {editingRevenue ? '修改回款信息，保存后将立即生效' : '录入新的回款记录'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="project">
                  项目 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.project_id}
                  onValueChange={(value) => {
                    const selectedProject = projects.find((p) => p.id.toString() === value)
                    setFormData((prev) => ({
                      ...prev,
                      project_id: value,
                      project_name: selectedProject?.name || '',
                      country: 'US',
                      currency: 'USD',
                      currencyLocked: true,
                    }))
                  }}
                >
                  <SelectTrigger id="project" className="w-full dark:bg-[hsl(var(--surface-soft))]">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id.toString()}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">
                  站点 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.country}
                  onValueChange={(value) => {
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
                  disabled={!formData.project_id}
                >
                  <SelectTrigger id="country" className="w-full dark:bg-[hsl(var(--surface-soft))]">
                    <SelectValue placeholder="选择站点" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((country) => (
                      <SelectItem key={country.value} value={country.value}>
                        {country.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="received_date">
                  回款日期 <span className="text-destructive">*</span>
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'w-full justify-start text-left font-normal',
                        !formData.received_date && 'text-muted-foreground'
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formData.received_date ? (
                        format(formData.received_date, 'yyyy-MM-dd')
                      ) : (
                        <span>选择日期</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
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
              <div className="space-y-2">
                <Label htmlFor="amount">
                  回款金额 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="amount"
                  type="text"
                  inputMode="decimal"
                  value={formData.amount}
                  onChange={(e) => {
                    // 允许粘贴带千分位逗号的金额（如 "11,693.69"），
                    // 同时阻止用户连续输入多个逗号以外的非法字符
                    const formatted = formatAmountInput(e.target.value)
                    setFormData((prev) => ({ ...prev, amount: formatted }))
                  }}
                  placeholder="0.00"
                  className="w-full"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="currency">
                  币种 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.currency}
                  onValueChange={(value) => {
                    if (!formData.currencyLocked) {
                      setFormData((prev) => ({ ...prev, currency: value }))
                    }
                  }}
                  disabled={formData.currencyLocked}
                >
                  <SelectTrigger
                    id="currency"
                    className="w-full dark:bg-[hsl(var(--surface-soft))]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map((currency) => (
                      <SelectItem key={currency.value} value={currency.value}>
                        {currency.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="revenue_type">
                  回款类型 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.revenue_type}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, revenue_type: value }))
                  }
                >
                  <SelectTrigger
                    id="revenue_type"
                    className="w-full dark:bg-[hsl(var(--surface-soft))]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="订单回款">订单回款</SelectItem>
                    <SelectItem value="B2B回款">B2B回款</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="note">备注</Label>
              <Textarea
                id="note"
                value={formData.note}
                onChange={(e) => setFormData((prev) => ({ ...prev, note: e.target.value }))}
                placeholder="可选：添加相关备注信息"
                rows={2}
                className="w-full"
              />
            </div>

            <div className="space-y-3">
              <Label>图片附件</Label>
              <UploadZone
                accept="image/png,image/jpeg,image/webp,image/gif"
                maxSize={10}
                onUpload={async (file) => {
                  if (!formData.project_name) {
                    notify({ type: 'error', title: '请先选择项目' })
                    return
                  }

                  setImageUploadState({ status: 'uploading', message: '上传中...' })
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
                    setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 2000)
                  } catch (error) {
                    console.error('Error uploading image:', error)
                    setImageUploadState({
                      status: 'error',
                      message: error instanceof Error ? error.message : '上传失败',
                    })
                    setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 3000)
                    throw error
                  } finally {
                    setUploadingImage(false)
                  }
                }}
                uploadingText={imageUploadState.message || '上传中...'}
                disabled={uploadingImage}
              />
              {imageUploadState.message && imageUploadState.status !== 'idle' && (
                <div
                  className={cn(
                    'text-xs',
                    imageUploadState.status === 'error' && 'text-destructive',
                    imageUploadState.status === 'success' && 'text-green-600',
                    imageUploadState.status === 'uploading' && 'text-muted-foreground'
                  )}
                >
                  {imageUploadState.message}
                </div>
              )}
              {formData.attachments.length > 0 && (
                <div className="flex flex-wrap gap-3 rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
                  {formData.attachments.map((image) => (
                    <div key={image.id} className="space-y-1">
                      <div
                        role="button"
                        tabIndex={0}
                        className="relative block h-20 w-20 cursor-pointer overflow-hidden rounded border"
                        onClick={() => setPreviewImage(image.url)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') setPreviewImage(image.url)
                        }}
                      >
                        <Image
                          src={image.url}
                          alt={image.filename}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                        <button
                          type="button"
                          className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl bg-black/50 text-white"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRemoveImage(image.id)
                          }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div
                        className="w-20 truncate text-[10px] text-muted-foreground"
                        title={image.filename}
                      >
                        {image.filename}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit}>{editingRevenue ? '保存修改' : '确认创建'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          aria-describedby="delete-revenue-dialog-description"
          className="max-w-[calc(100%-2rem)] rounded-lg sm:max-w-[425px]"
        >
          <span id="delete-revenue-dialog-description" className="sr-only">
            确认删除回款记录
          </span>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>您确定要删除这条回款记录吗？此操作不可恢复。</DialogDescription>
          </DialogHeader>
          {deletingRevenue && (
            <div className="my-4 rounded-md bg-[hsl(var(--surface-subtle))] p-3 text-sm">
              <p>
                <span className="font-medium">项目:</span> {deletingRevenue.project_name}
              </p>
              <p>
                <span className="font-medium">日期:</span>{' '}
                {new Date(deletingRevenue.received_date).toLocaleDateString('zh-CN')}
              </p>
              <p>
                <span className="font-medium">金额:</span>{' '}
                {formatCurrency(deletingRevenue.amount, deletingRevenue.currency)}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PortraitScreenshotDialog
        open={!!previewImage}
        onOpenChange={(open) => !open && setPreviewImage(null)}
        src={previewImage}
        alt="图片预览"
      />
    </div>
  )
}
