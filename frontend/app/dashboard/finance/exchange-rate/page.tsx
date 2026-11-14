'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useSession } from 'next-auth/react'
import { UploadZone } from '@/components/ui/upload-zone'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  Pencil,
  Trash2,
  Plus,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import styles from './exchange-rate-warm.module.css'

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

/** 币种 → Warm 文本符号与辅助名称 */
const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()
  switch (normalizedCurrency) {
    case 'USD':
      return { symbol: '$', accent: '美元' }
    case 'EUR':
      return { symbol: '€', accent: '欧元' }
    default:
      return { symbol: '¤', accent: '其他货币' }
  }
}

export default function ExchangeRatePage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [rates, setRates] = useState<ExchangeRate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
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
  const [previewZoomed, setPreviewZoomed] = useState(false)
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
        throw new Error('汇率数据加载失败')
      }

      const result = await response.json()
      setRates(result.data)
      setPagination(result.pagination)
    } catch (error) {
      console.error('Error fetching rates:', error)
      setLoadError('汇率数据加载失败')
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

  useEffect(() => {
    if (previewImage) setPreviewZoomed(false)
  }, [previewImage])

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
    <div className={styles.filters} role="group" aria-label="汇率筛选">
      <WarmSelect
        id="exchange-rate-currency-filter"
        label="货币"
        value={filters.currency || ALL_FILTER_VALUE}
        options={[
          { value: ALL_FILTER_VALUE, label: '全部货币' },
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
        id="exchange-rate-year-filter"
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
        id="exchange-rate-month-filter"
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

  const currencyLabel = filters.currency
    ? CURRENCY_OPTIONS.find((c) => c.value === filters.currency)?.label.split(' - ')[0] || filters.currency
    : '全部货币'
  const yearLabel = filters.year ? `${filters.year}年` : '全部年份'
  const monthLabel = filters.month ? `${filters.month}月` : '全部月份'
  const mobileFilterSummary = `${currencyLabel} · ${yearLabel} · ${monthLabel}`

  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      variant="warm-ledger"
      className={styles.mobileFilterStrip}
      controls={
        <>
          <WarmSelect
            id="exchange-rate-mobile-currency"
            label="货币"
            value={filters.currency || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部货币' },
              ...CURRENCY_OPTIONS.map((c) => ({ value: c.value, label: c.label })),
            ]}
            onChange={(val) => handleFilterChange('currency', val === ALL_FILTER_VALUE ? '' : val)}
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="exchange-rate-mobile-year"
            label="年份"
            value={filters.year || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部年份' },
              ...getYearOptions().map((y) => ({ value: y.value.toString(), label: y.label })),
            ]}
            onChange={(val) => handleFilterChange('year', val === ALL_FILTER_VALUE ? '' : val)}
            className={styles.mobileFilterWide}
          />
          <WarmSelect
            id="exchange-rate-mobile-month"
            label="月份"
            value={filters.month || ALL_FILTER_VALUE}
            options={[
              { value: ALL_FILTER_VALUE, label: '全部月份' },
              ...MONTH_OPTIONS.map((m) => ({ value: m.value.toString(), label: m.label })),
            ]}
            onChange={(val) => handleFilterChange('month', val === ALL_FILTER_VALUE ? '' : val)}
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
    <div className={styles.page} data-warm-exchange-rate="true">
      {headerSlotPortal}
      {mobileFilterStrip}
      <section
        className={styles.panel}
        data-warm-exchange-rate-panel="true"
        aria-labelledby="exchange-rate-title"
      >
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle} id="exchange-rate-title">
              汇率管理
            </h2>
          </div>
          {isAdmin ? (
            <WarmButton
              className={styles.actionButton}
              variant="primary"
              onClick={handleAdd}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              新增汇率
            </WarmButton>
          ) : null}
        </header>

        <div
          className={styles.tableRegion}
          role="region"
          aria-label="汇率管理表格"
          aria-busy={loading || undefined}
          data-warm-exchange-rate-table="true"
          tabIndex={0}
        >
          <table className={styles.table} aria-label="汇率管理">
            <thead>
              <tr>
                <th scope="col">货币代码</th>
                <th scope="col">货币名称</th>
                <th className={styles.numeric} scope="col">
                  年份
                </th>
                <th className={styles.numeric} scope="col">
                  月份
                </th>
                <th className={styles.numeric} scope="col">
                  汇率值
                </th>
                <th scope="col">备注</th>
                <th scope="col">更新时间</th>
                {isAdmin ? (
                  <th className={styles.numeric} scope="col">
                    操作
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <>
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7}>
                      <p className={styles.loadingLabel} role="status">
                        正在加载汇率
                      </p>
                    </td>
                  </tr>
                  {Array.from({ length: 6 }).map((_, rowIndex) => (
                    <tr key={`skeleton-${rowIndex}`}>
                      {Array.from({ length: isAdmin ? 8 : 7 }).map((__, columnIndex) => (
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
                  <td colSpan={isAdmin ? 8 : 7}>
                    <div
                      className={cn(styles.message, styles.errorMessage, styles.errorState)}
                      role="alert"
                    >
                      {loadError}
                      <WarmButton variant="quiet" onClick={() => void fetchRates()}>
                        重试
                      </WarmButton>
                    </div>
                  </td>
                </tr>
              ) : rates.length === 0 ? (
                <tr className={styles.messageRow}>
                  <td colSpan={isAdmin ? 8 : 7}>
                    <p className={styles.message} role="status">
                      {isAdmin ? '暂无汇率数据，点击右上角「新增汇率」录入' : '暂无汇率数据'}
                    </p>
                  </td>
                </tr>
              ) : (
                rates.map((rate) => {
                  const meta = getCurrencyBadgeMeta(rate.currency)
                  return (
                    <tr key={rate.id}>
                      <td title={`${rate.currency} - ${meta.accent}`}>
                        <WarmBadge className={styles.currencyBadge}>
                          <span className={styles.currencySymbol}>{meta.symbol}</span>{' '}
                          {rate.currency}
                        </WarmBadge>
                      </td>
                      <td className={styles.currencyName}>{rate.currencyName}</td>
                      <td className={styles.numeric}>{rate.year}</td>
                      <td className={styles.numeric}>{rate.month}月</td>
                      <td className={styles.rate}>{Number(rate.rate).toFixed(6)}</td>
                      <td className={styles.noteCell} title={rate.description || undefined}>
                        <span className={styles.noteText}>
                          {rate.description || (rate.noteImages?.length > 0 ? '' : '-')}
                        </span>
                        {rate.noteImages?.length > 0 ? (
                          <span className={styles.thumbnailList}>
                            {rate.noteImages.slice(0, 3).map((image) => (
                              <button
                                key={image.id}
                                type="button"
                                className={styles.thumbnailButton}
                                onClick={() => setPreviewImage(image.url)}
                                title={image.filename}
                                aria-label={`预览备注图片 ${image.filename}`}
                              >
                                <Image
                                  src={image.thumbnailUrl || image.url}
                                  alt=""
                                  fill
                                  sizes="22px"
                                  className={styles.thumbnailImage}
                                  unoptimized
                                />
                              </button>
                            ))}
                            {rate.noteImages.length > 3 ? (
                              <span className={styles.attachmentOverflow}>
                                +{rate.noteImages.length - 3}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </td>
                      <td className={styles.updatedAt}>
                        {new Date(rate.updatedAt).toLocaleString('zh-CN')}
                      </td>
                      {isAdmin ? (
                        <td className={styles.numeric}>
                          <span className={styles.rowActions}>
                            <WarmIconButton
                              className={styles.rowAction}
                              aria-label={`编辑 ${rate.currency} 汇率`}
                              onClick={() => handleEdit(rate)}
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </WarmIconButton>
                            <WarmIconButton
                              className={`${styles.rowAction} ${styles.rowActionDanger}`}
                              aria-label={`删除 ${rate.currency} 汇率`}
                              onClick={() => handleDeleteClick(rate)}
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </WarmIconButton>
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <nav
        className={styles.pagination}
        aria-label="汇率管理分页"
        aria-busy={loading || undefined}
      >
        {loading || loadError ? (
          <span className={styles.paginationPlaceholder} aria-hidden="true" />
        ) : pagination.total === 0 ? (
          <span>共 0 条</span>
        ) : (
          <span>
            第 {pagination.page} / {pagination.totalPages} 页 · 共 {pagination.total} 条
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
                page: Math.min(prev.totalPages, prev.page + 1),
              }))
            }
            disabled={
              loading ||
              Boolean(loadError) ||
              pagination.totalPages === 0 ||
              pagination.page >= pagination.totalPages
            }
          >
            下一页
          </WarmButton>
        </div>
      </nav>



      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-describedby="exchange-rate-dialog-description"
          className={cn('warm-ledger', styles.dialog)}
        >
          <span id="exchange-rate-dialog-description" className="sr-only">
            {editingRate ? '修改汇率信息' : '录入新的月度汇率信息，每个月每种货币仅可录入一条'}
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>
              {editingRate ? '编辑汇率信息' : '新增汇率信息'}
            </DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              {editingRate
                ? '修改汇率信息，保存后将立即生效'
                : '录入新的月度汇率信息，每个月每种货币仅可录入一条。SKU 信息页维护的是人民币 FOB 成本，其他页面会按站点和月份使用这里的汇率自动换算。'}
            </DialogDescription>
          </DialogHeader>

          <div className={styles.form}>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <WarmSelect
                  id="exchange-rate-currency"
                  label="货币代码 *"
                  value={formData.currency}
                  placeholder="选择货币"
                  options={CURRENCY_OPTIONS.map((currency) => ({
                    value: currency.value,
                    label: currency.label,
                  }))}
                  disabled={!!editingRate}
                  onChange={handleCurrencyChange}
                />
                {editingRate ? (
                  <p className={styles.fieldLocked}>货币代码不可修改</p>
                ) : null}
              </div>
              <div className={styles.field}>
                <Label className={styles.fieldLabel} htmlFor="exchange-rate-currency-name">
                  货币名称 <span className={styles.required}>*</span>
                </Label>
                <input
                  id="exchange-rate-currency-name"
                  value={formData.currencyName}
                  onChange={(event) =>
                    setFormData((prev) => ({ ...prev, currencyName: event.target.value }))
                  }
                  placeholder="如：美元"
                  className={styles.input}
                />
              </div>
            </div>

            <div className={styles.formGrid}>
              <WarmSelect
                id="exchange-rate-year"
                label="年份 *"
                value={formData.year.toString()}
                placeholder="选择年份"
                options={getYearOptions().map((year) => ({
                  value: year.value.toString(),
                  label: year.label,
                }))}
                disabled={!!editingRate}
                onChange={(value) =>
                  setFormData((prev) => ({ ...prev, year: parseInt(value) }))
                }
              />
              <WarmSelect
                id="exchange-rate-month"
                label="月份 *"
                value={formData.month.toString()}
                placeholder="选择月份"
                options={MONTH_OPTIONS.map((month) => ({
                  value: month.value.toString(),
                  label: month.label,
                }))}
                disabled={!!editingRate}
                onChange={(value) =>
                  setFormData((prev) => ({ ...prev, month: parseInt(value) }))
                }
              />
            </div>

            <div className={styles.field}>
              <Label className={styles.fieldLabel} htmlFor="exchange-rate-value">
                汇率值 <span className={styles.required}>*</span>
              </Label>
              <input
                id="exchange-rate-value"
                type="number"
                step="0.000001"
                value={formData.rate}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, rate: event.target.value }))
                }
                placeholder="如：7.234500"
                className={styles.input}
              />
              <p className={styles.fieldHint}>
                输入 1 单位外币对应多少人民币，例如 USD 填 7.200000、EUR 填 7.850000、GBP 填
                9.150000
              </p>
            </div>

            <div className={styles.field}>
              <Label className={styles.fieldLabel} htmlFor="exchange-rate-description">
                备注说明
              </Label>
              <input
                id="exchange-rate-description"
                value={formData.description}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, description: event.target.value }))
                }
                placeholder="可选：添加相关备注信息"
                className={styles.input}
              />
            </div>

            <div className={styles.field}>
              <Label className={styles.fieldLabel}>备注图片</Label>
              <div className={styles.uploadZone}>
                <UploadZone
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  maxSize={10}
                  onUpload={async (file) => {
                    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
                    if (!validTypes.includes(file.type)) {
                      throw new Error('不支持的图片格式')
                    }

                    setImageUploadState({ status: 'uploading', message: '上传中…' })
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
                      setTimeout(
                        () => setImageUploadState({ status: 'idle', message: '' }),
                        2000
                      )
                    } catch (error: any) {
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
              {formData.noteImages.length > 0 ? (
                <div className={styles.attachmentGrid}>
                  {formData.noteImages.map((image) => (
                    <div key={image.id} className={styles.attachmentItem}>
                      <div className={styles.attachmentTile}>
                        <button
                          type="button"
                          className={styles.attachmentImageButton}
                          onClick={() => setPreviewImage(image.url)}
                          aria-label={`预览备注图片 ${image.filename}`}
                        >
                          <Image
                            src={image.thumbnailUrl || image.url}
                            alt=""
                            fill
                            className={styles.thumbnailImage}
                            unoptimized
                          />
                        </button>
                      </div>
                      <div className={styles.attachmentName} title={image.filename}>
                        {image.filename}
                      </div>
                      <div className={styles.attachmentMeta}>
                        <span>{formatFileSize(image.size)}</span>
                        <button
                          type="button"
                          className={styles.removeTextButton}
                          onClick={() => handleRemoveImage(image.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <DialogFooter className={styles.dialogFooter}>
            <WarmButton
              variant="quiet"
              onClick={() => setDialogOpen(false)}
              disabled={submitting}
            >
              取消
            </WarmButton>
            <WarmButton
              variant="primary"
              onClick={handleSubmit}
              loading={submitting}
              loadingLabel="正在保存汇率"
            >
              {submitting ? '保存中…' : editingRate ? '保存修改' : '确认创建'}
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          aria-describedby="delete-exchange-rate-dialog-description"
          className={cn('warm-ledger', styles.dialog)}
        >
          <span id="delete-exchange-rate-dialog-description" className="sr-only">
            确认删除汇率记录
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>确认删除</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              您确定要删除这条汇率记录吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deletingRate ? (
            <div className={styles.deleteSummary}>
              <p>
                <strong>货币：</strong> {deletingRate.currency} ({deletingRate.currencyName})
              </p>
              <p>
                <strong>时间：</strong>{' '}
                <span className={styles.deleteValue}>
                  {deletingRate.year}年{deletingRate.month}月
                </span>
              </p>
              <p>
                <strong>汇率：</strong>{' '}
                <span className={styles.deleteValue}>{deletingRate.rate}</span>
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
          <DialogDescription className="sr-only">查看汇率备注图片大图</DialogDescription>
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
