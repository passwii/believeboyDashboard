'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UploadZone } from '@/components/ui/upload-zone'
import { Label } from '@/components/ui/label'
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
import {
  Pencil,
  Trash2,
  Plus,
  Loader2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { useIsMobile } from '@/hooks/use-mobile'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import {
  useHeaderRefresh,
  useHeaderSlot,
} from '@/components/terminal/terminal-header-slot'

// 预定义货币选项
const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - 美元' },
  { value: 'EUR', label: 'EUR - 欧元' },
  { value: 'CNY', label: 'CNY - 人民币' },
  { value: 'JPY', label: 'JPY - 日元' },
  { value: 'GBP', label: 'GBP - 英镑' },
  { value: 'HKD', label: 'HKD - 港币' },
  { value: 'AUD', label: 'AUD - 澳元' },
  { value: 'CAD', label: 'CAD - 加元' },
  { value: 'KRW', label: 'KRW - 韩元' },
  { value: 'SGD', label: 'SGD - 新加坡元' },
]

// 生成当前年份前后各5年的选项
const getYearOptions = () => {
  const currentYear = new Date().getFullYear()
  return Array.from({ length: 11 }, (_, i) => ({
    value: currentYear - 5 + i,
    label: `${currentYear - 5 + i}年`,
  }))
}

// 月份选项
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: `${i + 1}月`,
}))
interface Filters {
  currency: string
  year: string
  month: string
}

const ALL_FILTER_VALUE = '__ALL__'

interface ExchangeRate {
  id: number
  currency: string
  currencyName: string
  year: number
  month: number
  rate: number
  description: string | null
  noteImages: NoteImage[]
  createdAt: string
  updatedAt: string
}

interface NoteImage {
  id: string
  url: string
  thumbnailUrl?: string
  filename: string
  contentType: string
  size: number
  uploadedAt: string
}

// 拖拽上传状态
type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

interface ImageUploadState {
  status: UploadStatus
  message: string
}

// 表单验证状态
interface FormValidation {
  currency: string | null
  currencyName: string | null
  rate: string | null
}

/** 币种 → mono 符号 + term 语义色（终端化：去渐变 Badge，走文本语义色） */
const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()
  switch (normalizedCurrency) {
    case 'USD':
      return { symbol: '$', accent: '美元', tone: 'pos' as const }
    case 'EUR':
      return { symbol: '€', accent: '欧元', tone: undefined }
    default:
      return { symbol: '¤', accent: '其他货币', tone: 'muted' as const }
  }
}

export default function ExchangeRatePage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [rates, setRates] = useState<ExchangeRate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const isMobile = useIsMobile()
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 0,
  })
  const [filters, setFilters] = useState<Filters>({
    currency: '',
    year: '',
    month: '',
  })

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingRate, setDeletingRate] = useState<ExchangeRate | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageUploadState, setImageUploadState] = useState<ImageUploadState>({
    status: 'idle',
    message: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [formValidation, setFormValidation] = useState<FormValidation>({
    currency: null,
    currencyName: null,
    rate: null,
  })

  // 表单状态
  const [formData, setFormData] = useState({
    currency: '',
    currencyName: '',
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    rate: '',
    description: '',
    noteImages: [] as NoteImage[],
  })

  // 获取汇率列表
  const fetchRates = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const queryParams = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
      })

      if (filters.currency) queryParams.append('currency', filters.currency)
      if (filters.year) queryParams.append('year', filters.year)
      if (filters.month) queryParams.append('month', filters.month)

      const response = await fetch(`/api/exchange-rates?${queryParams}`)
      if (!response.ok) {
        throw new Error('Failed to fetch exchange rates')
      }

      const result = await response.json()
      setRates(result.data)
      setPagination(result.pagination)
    } catch (error) {
      console.error('Error fetching rates:', error)
      setLoadError(error instanceof Error ? error.message : '汇率数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [filters, pagination.page, pagination.pageSize])

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义：当前筛选条件下重新拉取。
  const fetchRef = useRef(fetchRates)
  fetchRef.current = fetchRates
  useHeaderRefresh(() => fetchRef.current())

  // 初始加载
  useEffect(() => {
    fetchRates()
  }, [fetchRates])

  // 处理筛选变化
  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 重置筛选
  const resetFilters = () => {
    setFilters({ currency: '', year: '', month: '' })
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 打开新增弹窗
  const handleAdd = () => {
    setEditingRate(null)
    setFormData({
      currency: '',
      currencyName: '',
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      rate: '',
      description: '',
      noteImages: [],
    })
    setDialogOpen(true)
  }

  // 打开编辑弹窗
  const handleEdit = (rate: ExchangeRate) => {
    setEditingRate(rate)
    setFormData({
      currency: rate.currency,
      currencyName: rate.currencyName,
      year: rate.year,
      month: rate.month,
      rate: rate.rate.toString(),
      description: rate.description || '',
      noteImages: rate.noteImages || [],
    })
    setDialogOpen(true)
  }

  // 打开删除确认弹窗
  const handleDeleteClick = (rate: ExchangeRate) => {
    setDeletingRate(rate)
    setDeleteDialogOpen(true)
  }

  // 验证汇率值
  const validateRate = (value: string): string | null => {
    if (!value) return '请输入汇率值'
    const num = parseFloat(value)
    if (isNaN(num) || num <= 0) return '汇率必须是正数'
    if (num > 1000000) return '汇率值过大'
    return null
  }

  // 实时验证表单
  const validateForm = useCallback(() => {
    const errors: FormValidation = {
      currency: formData.currency ? null : '请选择货币代码',
      currencyName: formData.currencyName ? null : '请输入货币名称',
      rate: validateRate(formData.rate),
    }
    setFormValidation(errors)
    return !errors.currency && !errors.currencyName && !errors.rate
  }, [formData])

  // 提交表单
  const handleSubmit = async () => {
    if (!validateForm()) {
      notify({ type: 'error', title: '表单验证失败', message: '请检查输入项' })
      return
    }

    setSubmitting(true)
    try {
      const url = editingRate ? `/api/exchange-rates/${editingRate.id}` : '/api/exchange-rates'
      const method = editingRate ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || '操作失败')
      }

      setDialogOpen(false)
      fetchRates()
      notify({ type: 'success', title: editingRate ? '汇率已更新' : '汇率已添加' })
    } catch (error: any) {
      console.error('Error saving exchange rate:', error)
      notify({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '操作失败',
      })
    } finally {
      setSubmitting(false)
    }
  }

  // 删除记录
  const handleDelete = async () => {
    if (!deletingRate) return

    try {
      const response = await fetch(`/api/exchange-rates/${deletingRate.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('删除失败')
      }

      setDeleteDialogOpen(false)
      setDeletingRate(null)
      fetchRates()
      notify({ type: 'success', title: '汇率记录已删除' })
    } catch (error) {
      console.error('Error deleting exchange rate:', error)
      notify({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '删除失败',
      })
    }
  }

  // 处理货币选择变化，自动填充货币名称
  const handleCurrencyChange = (currency: string) => {
    const selected = CURRENCY_OPTIONS.find((c) => c.value === currency)
    setFormData((prev) => ({
      ...prev,
      currency,
      currencyName: selected ? selected.label.split(' - ')[1] : prev.currencyName,
    }))
  }

  const handleImageUpload = async (file: File | null) => {
    if (!file) return

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
      const payload = new FormData()
      payload.append('file', file)

      const response = await fetch('/api/exchange-rates/upload-image', {
        method: 'POST',
        body: payload,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || '上传图片失败')
      }

      const result = await response.json()
      const image = result?.data as NoteImage
      if (!image?.id || !image?.url) {
        throw new Error('图片信息异常')
      }

      setFormData((prev) => ({
        ...prev,
        noteImages: [...prev.noteImages, image],
      }))
      setImageUploadState({ status: 'success', message: '上传成功' })
      setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 2000)
    } catch (error: any) {
      console.error('Error uploading image:', error)
      setImageUploadState({
        status: 'error',
        message: error instanceof Error ? error.message : '上传失败',
      })
      setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 3000)
    } finally {
      setUploadingImage(false)
    }
  }

  const handleRemoveImage = (imageId: string) => {
    setFormData((prev) => ({
      ...prev,
      noteImages: prev.noteImages.filter((image) => image.id !== imageId),
    }))
  }

  const formatFileSize = (size: number) => {
    if (size < 1024) return `${size}B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
    return `${(size / (1024 * 1024)).toFixed(1)}MB`
  }

  const filterControls = (
    <>
      <Select
        value={filters.currency || ALL_FILTER_VALUE}
        onValueChange={(value) =>
          handleFilterChange('currency', value === ALL_FILTER_VALUE ? '' : value)
        }
      >
        <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none md:w-[160px]">
          <SelectValue placeholder="全部货币" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>全部货币</SelectItem>
          {CURRENCY_OPTIONS.map((currency) => (
            <SelectItem key={currency.value} value={currency.value}>
              {currency.label}
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
        title="汇率管理"
        bodyClassName="min-h-0 overflow-hidden"
        actions={
          isAdmin ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
              onClick={handleAdd}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              新增汇率
            </Button>
          ) : null
        }
      >
        {/* 滚动收口在面板内（Canvas 内滚动），表头 sticky */}
        <div className="max-h-[calc(100vh-280px)] min-h-[240px] overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>货币代码</TermHead>
                <TermHead>货币名称</TermHead>
                <TermHead numeric>年份</TermHead>
                <TermHead numeric>月份</TermHead>
                <TermHead numeric>汇率值</TermHead>
                <TermHead>备注</TermHead>
                <TermHead>更新时间</TermHead>
                {isAdmin ? <TermHead numeric>操作</TermHead> : null}
              </TermRow>
            </TermTHead>
            <TermBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TermRow key={'skeleton-' + i} className="hover:bg-transparent">
                    {Array.from({ length: isAdmin ? 8 : 7 }).map((__, j) => (
                      <TermCell key={j}>
                        <Skeleton className="h-3.5 w-full max-w-[80px] rounded-none" />
                      </TermCell>
                    ))}
                  </TermRow>
                ))
              ) : loadError ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={isAdmin ? 8 : 7} className="h-24 text-center" tone="neg">
                    <span className="inline-flex items-center justify-center gap-2">{loadError}</span>
                  </TermCell>
                </TermRow>
              ) : rates.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={isAdmin ? 8 : 7} className="h-24 text-center" tone="muted">
                    {isAdmin ? '暂无汇率数据，点击右上角「新增汇率」录入' : '暂无汇率数据'}
                  </TermCell>
                </TermRow>
              ) : (
                rates.map((rate) => {
                  const meta = getCurrencyBadgeMeta(rate.currency)
                  return (
                    <TermRow key={rate.id}>
                      <TermCell tone={meta.tone} title={rate.currency + ' - ' + meta.accent}>
                        {meta.symbol} {rate.currency}
                      </TermCell>
                      <TermCell>{rate.currencyName}</TermCell>
                      <TermCell numeric>{rate.year}</TermCell>
                      <TermCell numeric>{rate.month}月</TermCell>
                      <TermCell numeric className="font-medium">
                        {Number(rate.rate).toFixed(6)}
                      </TermCell>
                      <TermCell className="max-w-[260px] truncate" title={rate.description || undefined}>
                        {rate.description || (rate.noteImages?.length > 0 ? '' : '-')}
                        {rate.noteImages?.length > 0 && (
                          <span className="ml-1 inline-flex gap-0.5 align-middle">
                            {rate.noteImages.slice(0, 3).map((image) => (
                              <button
                                key={image.id}
                                type="button"
                                className="relative h-5 w-5 shrink-0 overflow-hidden border border-term-border align-middle"
                                onClick={() => setPreviewImage(image.url)}
                                title={image.filename}
                              >
                                <Image
                                  src={image.thumbnailUrl || image.url}
                                  alt={image.filename}
                                  fill
                                  sizes="20px"
                                  className="object-cover"
                                  unoptimized
                                />
                              </button>
                            ))}
                            {rate.noteImages.length > 3 && (
                              <span className="font-mono text-[10px] text-term-muted">
                                +{rate.noteImages.length - 3}
                              </span>
                            )}
                          </span>
                        )}
                      </TermCell>
                      <TermCell tone="muted" className="font-mono">
                        {new Date(rate.updatedAt).toLocaleString('zh-CN')}
                      </TermCell>
                      {isAdmin ? (
                        <TermCell numeric>
                          <span className="inline-flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-text"
                              onClick={() => handleEdit(rate)}
                              title="编辑"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-neg"
                              onClick={() => handleDeleteClick(rate)}
                              title="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </Button>
                          </span>
                        </TermCell>
                      ) : null}
                    </TermRow>
                  )
                })
              )}
            </TermBody>
          </TermTable>
        </div>
      </TermPanel>

      {/* 分页：终端工具条规格 */}
      <div className="flex items-center justify-center gap-2 font-mono text-xs tabular-nums text-term-muted">
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
        <span>
          第 {pagination.page} / {pagination.totalPages} 页 · 共 {pagination.total} 条
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text"
          onClick={() =>
            setPagination((prev) => ({
              ...prev,
              page: Math.min(prev.totalPages, prev.page + 1),
            }))
          }
          disabled={pagination.page >= pagination.totalPages}
        >
          下一页
        </Button>
      </div>



      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-describedby="exchange-rate-dialog-description"
          className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg sm:max-w-[500px] dark:border-border/90 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="exchange-rate-dialog-description" className="sr-only">
            {editingRate ? '修改汇率信息' : '录入新的月度汇率信息，每个月每种货币仅可录入一条'}
          </span>
          <DialogHeader>
            <DialogTitle>{editingRate ? '编辑汇率信息' : '新增汇率信息'}</DialogTitle>
            <DialogDescription>
              {editingRate
                ? '修改汇率信息，保存后将立即生效'
                : '录入新的月度汇率信息，每个月每种货币仅可录入一条。SKU 信息页维护的是人民币 FOB 成本，其他页面会按站点和月份使用这里的汇率自动换算。'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="currency">
                  货币代码 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.currency}
                  onValueChange={handleCurrencyChange}
                  disabled={!!editingRate}
                >
                  <SelectTrigger id="currency" className="dark:bg-[hsl(var(--surface-soft))]">
                    <SelectValue placeholder="选择货币" />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map((currency) => (
                      <SelectItem key={currency.value} value={currency.value}>
                        {currency.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editingRate && <p className="text-xs text-muted-foreground">货币代码不可修改</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="currencyName">
                  货币名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="currencyName"
                  value={formData.currencyName}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, currencyName: e.target.value }))
                  }
                  placeholder="如：美元"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="year">
                  年份 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.year.toString()}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, year: parseInt(value) }))
                  }
                  disabled={!!editingRate}
                >
                  <SelectTrigger id="year" className="dark:bg-[hsl(var(--surface-soft))]">
                    <SelectValue placeholder="选择年份" />
                  </SelectTrigger>
                  <SelectContent>
                    {getYearOptions().map((year) => (
                      <SelectItem key={year.value} value={year.value.toString()}>
                        {year.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="month">
                  月份 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.month.toString()}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, month: parseInt(value) }))
                  }
                  disabled={!!editingRate}
                >
                  <SelectTrigger
                    id="month"
                    className="w-full max-md:min-h-[44px] sm:w-[112px] dark:bg-[hsl(var(--surface-soft))]"
                  >
                    <SelectValue placeholder="选择月份" />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_OPTIONS.map((month) => (
                      <SelectItem key={month.value} value={month.value.toString()}>
                        {month.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rate">
                汇率值 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="rate"
                type="number"
                step="0.000001"
                value={formData.rate}
                onChange={(e) => setFormData((prev) => ({ ...prev, rate: e.target.value }))}
                placeholder="如：7.234500"
              />
              <p className="text-xs text-muted-foreground">
                输入 1 单位外币对应多少人民币，例如 USD 填 7.200000、EUR 填 7.850000、GBP 填
                9.150000
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">备注说明</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="可选：添加相关备注信息"
              />
            </div>

            <div className="space-y-3">
              <Label>备注图片</Label>
              <UploadZone
                accept="image/png,image/jpeg,image/webp,image/gif"
                maxSize={10}
                onUpload={async (file) => {
                  // 复用现有的上传逻辑，但调整一下以适配 UploadZone
                  const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
                  if (!validTypes.includes(file.type)) {
                    throw new Error('不支持的图片格式')
                  }

                  setImageUploadState({ status: 'uploading', message: '上传中...' })
                  setUploadingImage(true)
                  try {
                    const payload = new FormData()
                    payload.append('file', file)

                    const response = await fetch('/api/exchange-rates/upload-image', {
                      method: 'POST',
                      body: payload,
                    })

                    if (!response.ok) {
                      const errorData = await response.json().catch(() => ({}))
                      throw new Error(errorData.detail || '上传图片失败')
                    }

                    const result = await response.json()
                    const image = result?.data as NoteImage
                    if (!image?.id || !image?.url) {
                      throw new Error('图片信息异常')
                    }

                    setFormData((prev) => ({
                      ...prev,
                      noteImages: [...prev.noteImages, image],
                    }))
                    setImageUploadState({ status: 'success', message: '上传成功' })
                    setTimeout(() => setImageUploadState({ status: 'idle', message: '' }), 2000)
                  } catch (error: any) {
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
              {formData.noteImages.length > 0 && (
                <div className="flex flex-wrap gap-3 rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
                  {formData.noteImages.map((image) => (
                    <div key={image.id} className="space-y-1">
                      <button
                        type="button"
                        className="relative block h-20 w-20 overflow-hidden rounded border"
                        onClick={() => setPreviewImage(image.url)}
                      >
                        <Image
                          src={image.thumbnailUrl || image.url}
                          alt={image.filename}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      </button>
                      <div
                        className="w-20 truncate text-[10px] text-muted-foreground"
                        title={image.filename}
                      >
                        {image.filename}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">
                          {formatFileSize(image.size)}
                        </span>
                        <button
                          type="button"
                          className="text-[10px] text-destructive"
                          onClick={() => handleRemoveImage(image.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  保存中...
                </>
              ) : editingRate ? (
                '保存修改'
              ) : (
                '确认创建'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          aria-describedby="delete-exchange-rate-dialog-description"
          className="max-w-[calc(100%-2rem)] rounded-lg sm:max-w-[425px]"
        >
          <span id="delete-exchange-rate-dialog-description" className="sr-only">
            确认删除汇率记录
          </span>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>您确定要删除这条汇率记录吗？此操作不可恢复。</DialogDescription>
          </DialogHeader>
          {deletingRate && (
            <div className="my-4 rounded-md bg-[hsl(var(--surface-subtle))] p-3 text-sm">
              <p>
                <span className="font-medium">货币:</span> {deletingRate.currency} (
                {deletingRate.currencyName})
              </p>
              <p>
                <span className="font-medium">时间:</span> {deletingRate.year}年{deletingRate.month}
                月
              </p>
              <p>
                <span className="font-medium">汇率:</span> {deletingRate.rate}
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
        src={previewImage ?? ''}
        alt="图片预览"
      />
    </div>
  )
}
