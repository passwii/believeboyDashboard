'use client'

import { useState, useEffect, useCallback } from 'react'
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
import { useNotifications } from '@/components/notifications'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { CalendarIcon, Pencil, Trash2, Plus, RotateCcw, ImagePlus, Loader2, X } from 'lucide-react'

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
  exchange_rate: string | null
  note: string | null
  attachments: Attachment[]
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
}

const formatCurrency = (amount: string | number, currency: string) => {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  const symbol = CURRENCY_OPTIONS.find(c => c.value === currency)?.symbol || ''
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
    year: '',
    month: '',
    currency: '',
  })

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRevenue, setEditingRevenue] = useState<PlatformRevenue | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingRevenue, setDeletingRevenue] = useState<PlatformRevenue | null>(null)
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)

  // 表单状态
  const [formData, setFormData] = useState({
    project_id: '',
    country: '',
    received_date: null as Date | null,
    amount: '',
    currency: 'USD',
    exchange_rate: '',
    note: '',
    attachments: [] as Attachment[],
  })

  // 获取项目列表
  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/backend/api/v1/projects')
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

  // 处理筛选变化
  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 重置筛选
  const resetFilters = () => {
    setFilters({ project_id: '', year: '', month: '', currency: '' })
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 打开新增弹窗
  const handleAdd = () => {
    setEditingRevenue(null)
    setFormData({
      project_id: '',
      country: '',
      received_date: new Date(),
      amount: '',
      currency: 'USD',
      exchange_rate: '',
      note: '',
      attachments: [],
    })
    setDialogOpen(true)
  }

  // 打开编辑弹窗
  const handleEdit = (revenue: PlatformRevenue) => {
    setEditingRevenue(revenue)
    setFormData({
      project_id: revenue.project_id.toString(),
      country: revenue.country,
      received_date: new Date(revenue.received_date),
      amount: revenue.amount,
      currency: revenue.currency,
      exchange_rate: revenue.exchange_rate || '',
      note: revenue.note || '',
      attachments: revenue.attachments || [],
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

      const payload = {
        project_id: parseInt(formData.project_id),
        country: formData.country,
        received_date: formData.received_date ? format(formData.received_date, 'yyyy-MM-dd') : '',
        amount: parseFloat(formData.amount),
        currency: formData.currency,
        exchange_rate: formData.exchange_rate ? parseFloat(formData.exchange_rate) : null,
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
        throw new Error(error.detail || '操作失败')
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
    setUploadingImage(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/backend/api/v1/platform-revenues/upload-image', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        throw new Error('上传图片失败')
      }

      const result = await response.json()
      if (!result.id || !result.url) {
        throw new Error('图片信息异常')
      }

      setFormData((prev) => ({
        ...prev,
        attachments: [...prev.attachments, result],
      }))
    } catch (error) {
      console.error('Error uploading image:', error)
      notify({ type: 'error', title: '上传失败' })
    } finally {
      setUploadingImage(false)
    }
  }

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
          <div className="flex flex-wrap gap-4 rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-4">
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
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重置
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
                  <TableHead>汇率</TableHead>
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
                        <Badge variant="outline" className="font-mono text-xs">
                          {revenue.country}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-medium">
                        {formatCurrency(revenue.amount, revenue.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {revenue.currency}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {revenue.exchange_rate ? parseFloat(revenue.exchange_rate).toFixed(4) : '-'}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <div className="space-y-2">
                          <p className="truncate text-sm">
                            {revenue.note || (revenue.attachments?.length > 0 ? `[${revenue.attachments.length}张图片]` : '-')}
                          </p>
                          {revenue.attachments?.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {revenue.attachments.slice(0, 3).map((image) => (
                                <button
                                  key={image.id}
                                  type="button"
                                  className="relative h-8 w-8 overflow-hidden rounded border border-border/70"
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
                              {revenue.attachments.length > 3 && (
                                <div className="flex h-8 w-8 items-center justify-center rounded border border-border/70 text-xs text-muted-foreground">
                                  +{revenue.attachments.length - 3}
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
                    setFormData((prev) => ({ ...prev, project_id: value, country: '' }))
                  }}
                >
                  <SelectTrigger id="project" className="dark:bg-[hsl(var(--surface-soft))]">
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
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, country: value }))}
                  disabled={!formData.project_id}
                >
                  <SelectTrigger id="country" className="dark:bg-[hsl(var(--surface-soft))]">
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
                  onValueChange={(value) => setFormData((prev) => ({ ...prev, currency: value }))}
                >
                  <SelectTrigger id="currency" className="dark:bg-[hsl(var(--surface-soft))]">
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
                <Label htmlFor="exchange_rate">
                  汇率
                </Label>
                <Input
                  id="exchange_rate"
                  type="number"
                  step="0.000001"
                  min="0"
                  value={formData.exchange_rate}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, exchange_rate: e.target.value }))
                  }
                  placeholder="可选"
                />
                <p className="text-xs text-muted-foreground">
                  币种非 USD 时可填写，用于折算显示
                </p>
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
              />
            </div>

            <div className="space-y-3">
              <Label>图片附件</Label>
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm hover:bg-muted dark:hover:bg-[hsl(var(--surface-subtle))]">
                  {uploadingImage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  上传图片
                </label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    void handleImageUpload(file)
                    e.currentTarget.value = ''
                  }}
                  disabled={uploadingImage}
                />
                <p className="text-xs text-muted-foreground">支持 PNG/JPG/WEBP/GIF，最大 10MB</p>
              </div>
              {formData.attachments.length > 0 && (
                <div className="flex flex-wrap gap-3 rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
                  {formData.attachments.map((image) => (
                    <div key={image.id} className="space-y-1">
                      <button
                        type="button"
                        className="relative block h-20 w-20 overflow-hidden rounded border"
                        onClick={() => setPreviewImage(image)}
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
                      </button>
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
    </div>
  )
}