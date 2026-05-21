'use client'

import { useState, useEffect, useCallback, useRef, DragEvent } from 'react'
import Image from 'next/image'
import { useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyTableState } from '@/components/ui/empty-state'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { disableGridLines } from '@/lib/excel-styles'
import { useNotifications } from '@/components/notifications'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { CalendarIcon, Pencil, Trash2, Plus, RotateCcw, ImagePlus, Loader2, X, Download, Upload, CheckCircle, AlertCircle } from 'lucide-react'

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
  const symbol = CURRENCY_OPTIONS.find(c => c.value === currency)?.symbol || ''
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
    .map(([currency, amount]) => `${CURRENCY_OPTIONS.find(c => c.value === currency)?.symbol || currency}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join(' | ')
}

// 币种 Badge 元数据
const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()
  switch (normalizedCurrency) {
    case 'USD':
      return {
        symbol: '$',
        accent: '美元',
        className: 'border-emerald-300 bg-gradient-to-r from-emerald-50 via-emerald-100 to-lime-100 text-emerald-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-emerald-800 dark:from-emerald-950 dark:via-emerald-900 dark:to-lime-950 dark:text-emerald-100',
      }
    case 'GBP':
      return {
        symbol: '£',
        accent: '英镑',
        className: 'border-amber-300 bg-gradient-to-r from-amber-50 via-amber-100 to-yellow-100 text-amber-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-amber-800 dark:from-amber-950 dark:via-amber-900 dark:to-yellow-950 dark:text-amber-100',
      }
    case 'EUR':
      return {
        symbol: '€',
        accent: '欧元',
        className: 'border-sky-300 bg-gradient-to-r from-sky-50 via-blue-100 to-indigo-100 text-sky-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-sky-800 dark:from-sky-950 dark:via-blue-950 dark:to-indigo-950 dark:text-sky-100',
      }
    default:
      return {
        symbol: '¤',
        accent: '其他货币',
        className: 'border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground',
      }
  }
}

// 站点 Badge 元数据
const getCountryBadgeMeta = (country: string) => {
  const normalizedCountry = country.trim().toUpperCase()
  switch (normalizedCountry) {
    case 'US':
      return {
        symbol: '🇺🇸',
        accent: '美国',
        className: 'border-rose-300 bg-gradient-to-r from-rose-50 via-red-100 to-orange-100 text-rose-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-rose-800 dark:from-rose-950 dark:via-red-950 dark:to-orange-950 dark:text-rose-100',
      }
    case 'UK':
      return {
        symbol: '🇬🇧',
        accent: '英国',
        className: 'border-violet-300 bg-gradient-to-r from-violet-50 via-purple-100 to-fuchsia-100 text-violet-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-violet-800 dark:from-violet-950 dark:via-purple-950 dark:to-fuchsia-950 dark:text-violet-100',
      }
    case 'DE':
      return {
        symbol: '🇩🇪',
        accent: '德国',
        className: 'border-cyan-300 bg-gradient-to-r from-cyan-50 via-blue-100 to-indigo-100 text-cyan-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-cyan-800 dark:from-cyan-950 dark:via-blue-950 dark:to-indigo-950 dark:text-cyan-100',
      }
    case 'CA':
      return {
        symbol: '🇨🇦',
        accent: '加拿大',
        className: 'border-emerald-300 bg-gradient-to-r from-emerald-50 via-teal-100 to-cyan-100 text-emerald-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-emerald-800 dark:from-emerald-950 dark:via-teal-950 dark:to-cyan-950 dark:text-emerald-100',
      }
    case 'JP':
      return {
        symbol: '🇯🇵',
        accent: '日本',
        className: 'border-pink-300 bg-gradient-to-r from-pink-50 via-rose-100 to-fuchsia-100 text-pink-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-pink-800 dark:from-pink-950 dark:via-rose-950 dark:to-fuchsia-950 dark:text-pink-100',
      }
    case 'AU':
      return {
        symbol: '🇦🇺',
        accent: '澳大利亚',
        className: 'border-orange-300 bg-gradient-to-r from-orange-50 via-amber-100 to-yellow-100 text-orange-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-orange-800 dark:from-orange-950 dark:via-amber-950 dark:to-yellow-950 dark:text-orange-100',
      }
    case 'MX':
      return {
        symbol: '🇲🇽',
        accent: '墨西哥',
        className: 'border-teal-300 bg-gradient-to-r from-teal-50 via-cyan-100 to-sky-100 text-teal-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-teal-800 dark:from-teal-950 dark:via-cyan-950 dark:to-sky-950 dark:text-teal-100',
      }
    case 'BR':
      return {
        symbol: '🇧🇷',
        accent: '巴西',
        className: 'border-lime-300 bg-gradient-to-r from-lime-50 via-green-100 to-emerald-100 text-lime-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-lime-800 dark:from-lime-950 dark:via-green-950 dark:to-emerald-950 dark:text-lime-100',
      }
    default:
      return {
        symbol: '🏳️',
        accent: '其他',
        className: 'border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground',
      }
  }
}

export default function PlatformRevenuePage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)

  // 状态
  const [revenues, setRevenues] = useState<PlatformRevenue[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
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
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null)
  const [previewScreenshotUrl, setPreviewScreenshotUrl] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [imageUploadState, setImageUploadState] = useState<{ status: 'idle' | 'uploading' | 'success' | 'error'; message: string }>({ status: 'idle', message: '' })
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      const response = await fetch('/api/backend/api/v1/projects/manage')
      if (response.ok) {
        const data = await response.json()
        const items = Array.isArray(data) ? data : (data.items ?? data.data ?? [])
        setProjects(items)
      }
    } catch (error) {
      console.error('Error fetching projects:', error)
    }
  }, [])

  // 获取回款列表
  const fetchRevenues = useCallback(async () => {
    setLoading(true)
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
    } finally {
      setLoading(false)
    }
  }, [filters, pagination.page, pagination.page_size])

  // 获取项目的站点列表
  const fetchProjectCountries = useCallback(async (projectId: number) => {
    try {
      const response = await fetch(`/api/backend/api/v1/platform-revenues/project-countries/${projectId}`)
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
    fetchRevenues()
  }, [fetchRevenues])

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
      // 验证必填字段
      if (!formData.project_id || !formData.country || !formData.received_date || !formData.amount) {
        notify({ type: 'error', title: '请填写必填字段' })
        return
      }

      const payload: Record<string, any> = editingRevenue
        ? {
            // PATCH: only send mutable fields (no project_id)
            country: formData.country,
            received_date: formData.received_date ? format(formData.received_date, 'yyyy-MM-dd') : '',
            amount: parseFloat(formData.amount),
            currency: formData.currency,
            revenue_type: formData.revenue_type,
            note: formData.note || null,
            attachments: formData.attachments.map(att => ({
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
            received_date: formData.received_date ? format(formData.received_date, 'yyyy-MM-dd') : '',
            amount: parseFloat(formData.amount),
            currency: formData.currency,
            revenue_type: formData.revenue_type,
            note: formData.note || null,
            attachments: formData.attachments.map(att => ({
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
      notify({ type: 'error', title: '保存失败', message: error instanceof Error ? error.message : '操作失败' })
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
      notify({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '删除失败' })
    }
  }

  // 图片上传
  const handleImageUpload = async (file: File | null) => {
    if (!file) return

    if (!formData.project_name) {
      notify({ type: 'error', title: '请先选择项目' })
      return
    }

    // 客户端验证
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!validTypes.includes(file.type)) {
      setImageUploadState({ status: 'error', message: '不支持的图片格式' })
      setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 3000)
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setImageUploadState({ status: 'error', message: '图片大小不能超过 10MB' })
      setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 3000)
      return
    }

    setImageUploadState({ status: 'uploading', message: '上传中...' })
    setUploadingImage(true)
    try {
      const uploadFormData = new FormData()
      uploadFormData.append('file', file)
      uploadFormData.append('project_name', formData.project_name)

      const response = await fetch('/api/backend/api/v1/platform-revenues/upload-image', {
        method: 'POST',
        body: uploadFormData,
      })
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
      setImageUploadState({ status: 'error', message: error instanceof Error ? error.message : '上传失败' })
      setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 3000)
    } finally {
      setUploadingImage(false)
    }
  }

  // 拖拽处理
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      void handleImageUpload(files[0])
    }
  }

  // 粘贴上传：监听 Ctrl/Cmd+V 粘贴图片
  useEffect(() => {
    if (!dialogOpen) return

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            void handleImageUpload(file)
          }
          break
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [dialogOpen])

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

      // 标题行
      worksheet.mergeCells(1, 1, 1, 7)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = '平台回款记录'
      titleCell.font = { name: 'Microsoft YaHei', size: 16, bold: true }
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' }

      // 筛选信息行
      const filterInfo = [
        filters.project_id ? `项目: ${projects.find(p => p.id.toString() === filters.project_id)?.name || filters.project_id}` : '',
        filters.year ? `年份: ${filters.year}` : '',
        filters.month ? `月份: ${filters.month}` : '',
        filters.currency ? `币种: ${filters.currency}` : '',
        filters.revenue_type ? `回款类型: ${filters.revenue_type}` : '',
      ].filter(Boolean).join(' | ')
      let currentRow = 2
      if (filterInfo) {
        worksheet.mergeCells(currentRow, 1, currentRow, 7)
        const filterCell = worksheet.getCell(currentRow, 1)
        filterCell.value = filterInfo
        filterCell.font = { name: 'Microsoft YaHei', size: 11, color: { argb: 'FF64748B' } }
        currentRow++
      }

      // 表头行
      const headerLabels = ['回款日期', '项目', '站点', '金额', '币种', '回款类型', '备注']
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
        if (countryMeta.symbol !== '🏳️') {
          const countryColorMap: Record<string, { bg: string; fg: string }> = {
            '🇺🇸': { bg: 'FFF1F2', fg: 'BE123C' },
            '🇬🇧': { bg: 'FAF5FF', fg: '7E22CE' },
            '🇩🇪': { bg: 'ECFEFF', fg: '0369A1' },
            '🇨🇦': { bg: 'ECFDF5', fg: '047857' },
            '🇯🇵': { bg: 'FFF1F2', fg: 'BE123C' },
            '🇦🇺': { bg: 'FFFBEB', fg: 'B45309' },
            '🇲🇽': { bg: 'F0FDFA', fg: '0D9488' },
            '🇧🇷': { bg: 'F0FDF4', fg: '15803D' },
          }
          const countryColors = countryColorMap[countryMeta.symbol] || { bg: 'F8FAFC', fg: '64748B' }
          countryCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: countryColors.bg } }
          countryCell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: countryColors.fg } }
        }

        // 为币种单元格添加颜色
        const currencyCell = row.getCell(5)
        const currencyMeta = getCurrencyBadgeMeta(revenue.currency)
        if (currencyMeta.symbol !== '¤') {
          const currencyColorMap: Record<string, { bg: string; fg: string }> = {
            '$': { bg: 'ECFDF5', fg: '047857' },
            '£': { bg: 'FFFBEB', fg: 'B45309' },
            '€': { bg: 'F0F9FF', fg: '0369A1' },
          }
          const currencyColors = currencyColorMap[currencyMeta.symbol] || { bg: 'F8FAFC', fg: '64748B' }
          currencyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: currencyColors.bg } }
          currencyCell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: currencyColors.fg } }
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
        ? (projects.find(p => p.id.toString() === filters.project_id)?.name || filters.project_id)
        : '全部项目'
      link.href = url
      link.download = `${projectName}_平台回款_${date}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      notify({ type: 'success', title: `已导出 ${allRevenues.length} 条记录` })
    } catch (error) {
      console.error('Export error:', error)
      notify({ type: 'error', title: '导出失败', message: error instanceof Error ? error.message : '未知错误' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="min-w-0 space-y-6 text-foreground">
      {/* 筛选区域 */}
      <DataCard className="overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
        <DataCardHeader
          title="平台回款"
          description="记录各项目平台回款情况"
          action={
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" />
              新增回款
            </Button>
          }
        />
        <DataCardContent className="p-0 px-4 pb-4 pt-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">项目</Label>
              <Select
                value={filters.project_id || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange('project_id', value === ALL_FILTER_VALUE ? '' : value)
                }
              >
                <SelectTrigger className="w-[180px] dark:bg-[hsl(var(--surface-soft))]">
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
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">年份</Label>
              <Select
                value={filters.year || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange('year', value === ALL_FILTER_VALUE ? '' : value)
                }
              >
                <SelectTrigger className="w-[120px] dark:bg-[hsl(var(--surface-soft))]">
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
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">月份</Label>
              <Select
                value={filters.month || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange('month', value === ALL_FILTER_VALUE ? '' : value)
                }
              >
                <SelectTrigger className="w-[112px] dark:bg-[hsl(var(--surface-soft))]">
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
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">币种</Label>
              <Select
                value={filters.currency || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange('currency', value === ALL_FILTER_VALUE ? '' : value)
                }
              >
                <SelectTrigger className="w-[140px] dark:bg-[hsl(var(--surface-soft))]">
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
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">回款类型</Label>
              <Select
                value={filters.revenue_type || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange('revenue_type', value === ALL_FILTER_VALUE ? '' : value)
                }
              >
                <SelectTrigger className="w-[140px] dark:bg-[hsl(var(--surface-soft))]">
                  <SelectValue placeholder="全部类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER_VALUE}>全部类型</SelectItem>
                  <SelectItem value="订单回款">订单回款</SelectItem>
                  <SelectItem value="B2B回款">B2B回款</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重置
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
              >
                {exporting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-1 h-4 w-4" />
                )}
                导出
              </Button>
            </div>
          </div>
        </DataCardContent>
      </DataCard>

      {/* 数据表格 */}
      <DataCard className="overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
        <DataCardContent className="p-0">
          <div className="border-border/70 bg-[hsl(var(--surface-panel))]">
            <Table>
              <TableHeader className="bg-[hsl(var(--surface-subtle))]">
                <TableRow>
                  <TableHead>回款日期</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>站点</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead>回款类型</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : revenues.length === 0 ? (
                  <EmptyTableState colSpan={8} message="暂无回款数据，点击右上角按钮新增" />
                ) : (
                  revenues.map((revenue) => (
                    <TableRow key={revenue.id}>
                      <TableCell className="whitespace-nowrap">
                        {new Date(revenue.received_date).toLocaleDateString('zh-CN')}
                      </TableCell>
                      <TableCell className="font-medium">{revenue.project_name}</TableCell>
                      <TableCell>
                        {(() => {
                          const badgeMeta = getCountryBadgeMeta(revenue.country)
                          return (
                            <Badge
                              className={cn(
                                "gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.1em]",
                                badgeMeta.className
                              )}
                              title={`${revenue.country} - ${badgeMeta.accent}`}
                            >
                              <span className="text-sm leading-none">{badgeMeta.symbol}</span>
                              <span>{revenue.country}</span>
                            </Badge>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-medium">
                        {formatCurrency(revenue.amount, revenue.currency)}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const badgeMeta = getCurrencyBadgeMeta(revenue.currency)
                          return (
                            <Badge
                              className={cn(
                                "gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.1em]",
                                badgeMeta.className
                              )}
                              title={`${revenue.currency} - ${badgeMeta.accent}`}
                            >
                              <span className="text-sm leading-none">{badgeMeta.symbol}</span>
                              <span>{revenue.currency}</span>
                            </Badge>
                          )
                        })()}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${
                          revenue.revenue_type === 'B2B回款'
                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                        }`}>
                          {revenue.revenue_type || '订单回款'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="space-y-2">
                          <p className="truncate text-sm">
                            {revenue.note || (revenue.attachments?.length > 0 ? "" : "-")}
                          </p>
                          {revenue.attachments?.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {revenue.attachments.slice(0, 4).map((image) => (
                                <button
                                  key={image.id}
                                  type="button"
                                  className="relative h-10 w-10 overflow-hidden rounded border border-border/70"
                                  onClick={() => setPreviewImage(image)}
                                  title={image.filename}
                                >
                                  <Image
                                    src={image.url}
                                    alt={image.filename}
                                    fill
                                    className="object-cover"
                                    unoptimized
                                  />
                                </button>
                              ))}
                              {revenue.attachments.length > 4 && (
                                <div className="flex h-10 w-10 items-center justify-center rounded border border-border/70 text-xs text-muted-foreground">
                                  +{revenue.attachments.length - 4}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(revenue)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDeleteClick(revenue)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
                {/* 合计行 */}
                {!loading && revenues.length > 0 && (
                  <TableRow className="bg-muted/50 font-medium">
                    <TableCell className="py-3">合计</TableCell>
                    <TableCell colSpan={2}></TableCell>
                    <TableCell className="text-right">
                      {formatTotals(calculateTotals(revenues))}
                    </TableCell>
                    <TableCell colSpan={4}></TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* 分页 */}
          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm text-muted-foreground">
              共 {pagination.total} 条记录，第 {pagination.page}/{pagination.total_pages} 页
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setPagination((prev) => ({
                    ...prev,
                    page: Math.max(1, prev.page - 1),
                  }))
                }
                disabled={pagination.page <= 1}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
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
        </DataCardContent>
      </DataCard>

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent aria-describedby="platform-revenue-dialog-description" className="sm:max-w-[520px] dark:border-border/90 dark:bg-[hsl(var(--surface-panel))]">
          <span id="platform-revenue-dialog-description" className="sr-only">
            {editingRevenue ? '修改回款记录' : '录入新的回款记录'}
          </span>
          <DialogHeader>
            <DialogTitle>
              {editingRevenue ? '编辑回款记录' : '新增回款记录'}
            </DialogTitle>
            <DialogDescription>
              {editingRevenue
                ? '修改回款信息，保存后将立即生效'
                : '录入新的回款记录'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="project">
                  项目 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.project_id}
                  onValueChange={(value) => {
                    const selectedProject = projects.find(p => p.id.toString() === value)
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
                      'US': 'USD',
                      'UK': 'GBP',
                      'DE': 'EUR',
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

            <div className="grid grid-cols-2 gap-4">
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
                      onSelect={(date) => setFormData((prev) => ({ ...prev, received_date: date || null }))}
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
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.amount}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, amount: e.target.value }))
                  }
                  placeholder="0.00"
                  className="w-full"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
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
                  <SelectTrigger id="currency" className="w-full dark:bg-[hsl(var(--surface-soft))]">
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
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, revenue_type: value }))}
                >
                  <SelectTrigger id="revenue_type" className="w-full dark:bg-[hsl(var(--surface-soft))]">
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
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, note: e.target.value }))
                }
                placeholder="可选：添加相关备注信息"
                rows={2}
                className="w-full"
              />
            </div>

            <div className="space-y-3">
              <Label htmlFor="note-image-upload">图片附件</Label>
              <div
                className={cn(
                  "relative rounded-md border-2 border-dashed p-4 transition-colors",
                  isDragOver
                    ? "border-primary bg-primary/5"
                    : "border-border/70 hover:border-primary/50",
                  imageUploadState.status === 'error' && "border-destructive bg-destructive/5",
                  imageUploadState.status === 'success' && "border-green-500 bg-green-500/5"
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input
                  id="note-image-upload"
                  type="file"
                  ref={fileInputRef}
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    void handleImageUpload(file)
                    e.currentTarget.value = ''
                  }}
                  disabled={uploadingImage}
                />
                <div className="flex items-center gap-3">
                  <label
                    htmlFor="note-image-upload"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm transition-colors",
                      "hover:bg-muted dark:hover:bg-[hsl(var(--surface-subtle))]",
                      uploadingImage && "cursor-not-allowed opacity-50"
                    )}
                  >
                    {uploadingImage ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : imageUploadState.status === 'success' ? (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    ) : imageUploadState.status === 'error' ? (
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    上传图片
                  </label>
                  <p className="text-xs text-muted-foreground">支持 PNG/JPG/WEBP/GIF，最大 10MB · 可直接 Ctrl+V 粘贴</p>
                </div>
                {imageUploadState.message && (
                  <div className={cn(
                    "mt-2 text-xs",
                    imageUploadState.status === 'error' && "text-destructive",
                    imageUploadState.status === 'success' && "text-green-600",
                    imageUploadState.status === 'uploading' && "text-muted-foreground"
                  )}>
                    {imageUploadState.message}
                  </div>
                )}
                {isDragOver && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="rounded-md bg-primary/20 px-4 py-2 text-sm font-medium text-primary">
                      释放在此处上传
                    </div>
                  </div>
                )}
              </div>
              {formData.attachments.length > 0 && (
                <div className="flex flex-wrap gap-3 rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
                  {formData.attachments.map((image) => (
                    <div key={image.id} className="space-y-1">
                      <div
                        role="button"
                        tabIndex={0}
                        className="relative block h-20 w-20 cursor-pointer overflow-hidden rounded border"
                        onClick={() => setPreviewImage(image)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPreviewImage(image) }}
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
                      <div className="w-20 truncate text-[10px] text-muted-foreground" title={image.filename}>
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
            <Button onClick={handleSubmit}>
              {editingRevenue ? '保存修改' : '确认创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent aria-describedby="delete-revenue-dialog-description" className="sm:max-w-[425px]">
          <span id="delete-revenue-dialog-description" className="sr-only">确认删除回款记录</span>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              您确定要删除这条回款记录吗？此操作不可恢复。
            </DialogDescription>
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

      {/* 图片预览弹窗 */}
      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent aria-describedby="image-preview-dialog-description" className="max-w-3xl dark:border-border/90 dark:bg-[hsl(var(--surface-panel))]">
          <span id="image-preview-dialog-description" className="sr-only">图片预览</span>
          <DialogHeader>
            <DialogTitle>图片预览</DialogTitle>
            <DialogDescription>{previewImage?.filename}</DialogDescription>
          </DialogHeader>
          {previewImage && (
            <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))]">
              <Image
                src={previewImage.url}
                alt={previewImage.filename}
                fill
                className="object-contain"
                unoptimized
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 回款截图预览弹窗 */}
      <Dialog open={!!previewScreenshotUrl} onOpenChange={(open) => !open && setPreviewScreenshotUrl(null)}>
        <DialogContent aria-describedby="screenshot-preview-dialog-description" className="max-w-3xl dark:border-border/90 dark:bg-[hsl(var(--surface-panel))]">
          <span id="screenshot-preview-dialog-description" className="sr-only">回款截图预览</span>
          <DialogHeader>
            <DialogTitle>回款截图</DialogTitle>
            <DialogDescription>回款截图预览</DialogDescription>
          </DialogHeader>
          {previewScreenshotUrl && (
            <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))]">
              <Image
                src={previewScreenshotUrl}
                alt="回款截图"
                fill
                className="object-contain"
                unoptimized
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}