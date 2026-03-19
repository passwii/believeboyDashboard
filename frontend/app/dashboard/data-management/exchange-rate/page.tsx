"use client"

import { useState, useEffect, useCallback } from "react"
import Image from "next/image"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Pencil, Trash2, Plus, RotateCcw, ImagePlus, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

// 预定义货币选项
const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD - 美元" },
  { value: "EUR", label: "EUR - 欧元" },
  { value: "CNY", label: "CNY - 人民币" },
  { value: "JPY", label: "JPY - 日元" },
  { value: "GBP", label: "GBP - 英镑" },
  { value: "HKD", label: "HKD - 港币" },
  { value: "AUD", label: "AUD - 澳元" },
  { value: "CAD", label: "CAD - 加元" },
  { value: "KRW", label: "KRW - 韩元" },
  { value: "SGD", label: "SGD - 新加坡元" },
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
const ALL_FILTER_VALUE = "__ALL__"

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

interface Filters {
  currency: string
  year: string
  month: string
}

const getCurrencyBadgeMeta = (currency: string) => {
  const normalizedCurrency = currency.trim().toUpperCase()

  switch (normalizedCurrency) {
    case "USD":
      return {
        symbol: "$",
        accent: "美元",
        className:
          "border-emerald-300 bg-gradient-to-r from-emerald-50 via-emerald-100 to-lime-100 text-emerald-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-emerald-800 dark:from-emerald-950 dark:via-emerald-900 dark:to-lime-950 dark:text-emerald-100",
      }
    case "EUR":
      return {
        symbol: "€",
        accent: "欧元",
        className:
          "border-blue-300 bg-gradient-to-r from-sky-50 via-blue-100 to-indigo-100 text-blue-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-blue-800 dark:from-sky-950 dark:via-blue-950 dark:to-indigo-950 dark:text-blue-100",
      }
    default:
      return {
        symbol: "¤",
        accent: "其他货币",
        className:
          "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
      }
  }
}

export default function ExchangeRatePage() {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [rates, setRates] = useState<ExchangeRate[]>([])
  const [loading, setLoading] = useState(true)
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 0,
  })
  const [filters, setFilters] = useState<Filters>({
    currency: "",
    year: "",
    month: "",
  })

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingRate, setDeletingRate] = useState<ExchangeRate | null>(null)
  const [previewImage, setPreviewImage] = useState<NoteImage | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)

  // 表单状态
  const [formData, setFormData] = useState({
    currency: "",
    currencyName: "",
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    rate: "",
    description: "",
    noteImages: [] as NoteImage[],
  })

  // 获取汇率列表
  const fetchRates = useCallback(async () => {
    setLoading(true)
    try {
      const queryParams = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
      })

      if (filters.currency) queryParams.append("currency", filters.currency)
      if (filters.year) queryParams.append("year", filters.year)
      if (filters.month) queryParams.append("month", filters.month)

      const response = await fetch(`/api/exchange-rates?${queryParams}`)
      if (!response.ok) {
        throw new Error("Failed to fetch exchange rates")
      }

      const result = await response.json()
      setRates(result.data)
      setPagination(result.pagination)
    } catch (error) {
      console.error("Error fetching rates:", error)
      // Error handling without toast
    } finally {
      setLoading(false)
    }
  }, [filters, pagination.page, pagination.pageSize])

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
    setFilters({ currency: "", year: "", month: "" })
    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  // 打开新增弹窗
  const handleAdd = () => {
    setEditingRate(null)
    setFormData({
      currency: "",
      currencyName: "",
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      rate: "",
      description: "",
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
      description: rate.description || "",
      noteImages: rate.noteImages || [],
    })
    setDialogOpen(true)
  }

  // 打开删除确认弹窗
  const handleDeleteClick = (rate: ExchangeRate) => {
    setDeletingRate(rate)
    setDeleteDialogOpen(true)
  }

  // 提交表单
  const handleSubmit = async () => {
    try {
      // 验证必填字段
      if (!formData.currency || !formData.currencyName || !formData.rate) {
        // Validation error - no toast
        return
      }

      const url = editingRate
        ? `/api/exchange-rates/${editingRate.id}`
        : "/api/exchange-rates"
      const method = editingRate ? "PUT" : "POST"

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "操作失败")
      }

      setDialogOpen(false)
      fetchRates()
    } catch (error: any) {
      console.error("Error saving exchange rate:", error)
      // Error handling without toast
    }
  }

  // 删除记录
  const handleDelete = async () => {
    if (!deletingRate) return

    try {
      const response = await fetch(`/api/exchange-rates/${deletingRate.id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("删除失败")
      }

      setDeleteDialogOpen(false)
      setDeletingRate(null)
      fetchRates()
    } catch (error) {
      console.error("Error deleting exchange rate:", error)
      // Error handling without toast
    }
  }

  // 处理货币选择变化，自动填充货币名称
  const handleCurrencyChange = (currency: string) => {
    const selected = CURRENCY_OPTIONS.find((c) => c.value === currency)
    setFormData((prev) => ({
      ...prev,
      currency,
      currencyName: selected
        ? selected.label.split(" - ")[1]
        : prev.currencyName,
    }))
  }

  const handleImageUpload = async (file: File | null) => {
    if (!file) return
    setUploadingImage(true)
    try {
      const payload = new FormData()
      payload.append("file", file)

      const response = await fetch("/api/exchange-rates/upload-image", {
        method: "POST",
        body: payload,
      })
      if (!response.ok) {
        throw new Error("上传图片失败")
      }

      const result = await response.json()
      const image = result?.data as NoteImage
      if (!image?.id || !image?.url) {
        throw new Error("图片信息异常")
      }

      setFormData((prev) => ({
        ...prev,
        noteImages: [...prev.noteImages, image],
      }))
    } catch (error) {
      console.error("Error uploading image:", error)
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

  // 生成分页按钮
  const renderPagination = () => {
    const { page, totalPages } = pagination
    const pages: (number | string)[] = []

    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      if (page <= 3) {
        pages.push(1, 2, 3, 4, "...", totalPages)
      } else if (page >= totalPages - 2) {
        pages.push(1, "...", totalPages - 3, totalPages - 2, totalPages - 1, totalPages)
      } else {
        pages.push(1, "...", page - 1, page, page + 1, "...", totalPages)
      }
    }

    return (
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() =>
                setPagination((prev) => ({
                  ...prev,
                  page: Math.max(1, prev.page - 1),
                }))
              }
              className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
          {pages.map((p, index) => (
            <PaginationItem key={index}>
              {p === "..." ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  onClick={() =>
                    setPagination((prev) => ({ ...prev, page: p as number }))
                  }
                  isActive={page === p}
                  className="cursor-pointer"
                >
                  {p}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              onClick={() =>
                setPagination((prev) => ({
                  ...prev,
                  page: Math.min(prev.totalPages, prev.page + 1),
                }))
              }
              className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    )
  }

  return (
    <div className="container mx-auto py-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>汇率信息管理</CardTitle>
            {isAdmin ? (
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" />
                新增汇率
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {/* 筛选区域 */}
          <div className="mb-6 flex flex-wrap gap-4 rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">货币种类</Label>
              <Select
                value={filters.currency || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange("currency", value === ALL_FILTER_VALUE ? "" : value)
                }
              >
                <SelectTrigger className="w-[180px]">
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
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-sm font-medium">年份</Label>
              <Select
                value={filters.year || ALL_FILTER_VALUE}
                onValueChange={(value) =>
                  handleFilterChange("year", value === ALL_FILTER_VALUE ? "" : value)
                }
              >
                <SelectTrigger className="w-[120px]">
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
                  handleFilterChange("month", value === ALL_FILTER_VALUE ? "" : value)
                }
              >
                <SelectTrigger className="w-[112px]">
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
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重置
              </Button>
            </div>
          </div>

          {/* 数据表格 */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>货币代码</TableHead>
                  <TableHead>货币名称</TableHead>
                  <TableHead>年份</TableHead>
                  <TableHead>月份</TableHead>
                  <TableHead className="text-right">汇率值</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead>更新时间</TableHead>
                  {isAdmin ? <TableHead className="text-right">操作</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 8 : 7} className="h-24 text-center">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : rates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 8 : 7} className="h-24 text-center text-muted-foreground">
                      {isAdmin ? "暂无汇率数据，点击右上角按钮新增" : "暂无汇率数据"}
                    </TableCell>
                  </TableRow>
                ) : (
                  rates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell>
                        {(() => {
                          const badgeMeta = getCurrencyBadgeMeta(rate.currency)

                          return (
                            <Badge
                              variant="outline"
                              className={cn(
                                "gap-1.5 rounded-full px-3 py-1 font-mono text-[11px] font-bold tracking-[0.18em]",
                                badgeMeta.className
                              )}
                              title={`${rate.currency} - ${badgeMeta.accent}`}
                            >
                              <span className="text-sm leading-none">{badgeMeta.symbol}</span>
                              <span>{rate.currency}</span>
                            </Badge>
                          )
                        })()}
                      </TableCell>
                      <TableCell>{rate.currencyName}</TableCell>
                      <TableCell>{rate.year}</TableCell>
                      <TableCell>{rate.month}月</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {Number(rate.rate).toFixed(6)}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="space-y-2">
                          <p className="truncate text-sm">
                            {rate.description || (rate.noteImages?.length > 0 ? "" : "-")}
                          </p>
                          {rate.noteImages?.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {rate.noteImages.slice(0, 4).map((image) => (
                                <button
                                  key={image.id}
                                  type="button"
                                  className="relative h-10 w-10 overflow-hidden rounded border"
                                  onClick={() => setPreviewImage(image)}
                                  title={image.filename}
                                >
                                  <Image
                                    src={image.thumbnailUrl || image.url}
                                    alt={image.filename}
                                    fill
                                    className="object-cover"
                                    unoptimized
                                  />
                                </button>
                              ))}
                              {rate.noteImages.length > 4 && (
                                <div className="flex h-10 w-10 items-center justify-center rounded border text-xs text-muted-foreground">
                                  +{rate.noteImages.length - 4}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(rate.updatedAt).toLocaleString("zh-CN")}
                      </TableCell>
                      {isAdmin ? (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(rate)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => handleDeleteClick(rate)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* 分页 */}
          {pagination.totalPages > 1 && (
            <div className="mt-4 flex justify-center">{renderPagination()}</div>
          )}

          {/* 数据汇总 */}
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <div>
              共 <span className="font-medium text-foreground">{pagination.total}</span> 条记录
            </div>
            <div>
              每页 <span className="font-medium text-foreground">{pagination.pageSize}</span> 条
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingRate ? "编辑汇率信息" : "新增汇率信息"}
            </DialogTitle>
            <DialogDescription>
              {editingRate
                ? "修改汇率信息，保存后将立即生效"
                : "录入新的月度汇率信息，每个月每种货币仅可录入一条。SKU 信息页维护的是人民币 FOB 成本，其他页面会按站点和月份使用这里的汇率自动换算。"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="currency">
                  货币代码 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.currency}
                  onValueChange={handleCurrencyChange}
                  disabled={!!editingRate}
                >
                  <SelectTrigger id="currency">
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
                {editingRate && (
                  <p className="text-xs text-muted-foreground">货币代码不可修改</p>
                )}
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

            <div className="grid grid-cols-2 gap-4">
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
                  <SelectTrigger id="year">
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
                  <SelectTrigger id="month" className="w-[112px]">
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
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, rate: e.target.value }))
                }
                placeholder="如：7.234500"
              />
              <p className="text-xs text-muted-foreground">
                输入 1 单位外币对应多少人民币，例如 USD 填 7.200000、EUR 填 7.850000、GBP 填 9.150000
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">备注说明</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, description: e.target.value }))
                }
                placeholder="可选：添加相关备注信息"
              />
            </div>

            <div className="space-y-3">
              <Label htmlFor="note-image-upload">备注图片</Label>
              <div className="flex items-center gap-3">
                <label
                  htmlFor="note-image-upload"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  {uploadingImage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  上传图片
                </label>
                <input
                  id="note-image-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    void handleImageUpload(file)
                    e.currentTarget.value = ""
                  }}
                  disabled={uploadingImage}
                />
                <p className="text-xs text-muted-foreground">支持 PNG/JPG/WEBP/GIF，最大 10MB</p>
              </div>
              {formData.noteImages.length > 0 && (
                <div className="flex flex-wrap gap-3 rounded-md border bg-muted/30 p-3">
                  {formData.noteImages.map((image) => (
                    <div key={image.id} className="space-y-1">
                      <button
                        type="button"
                        className="relative block h-20 w-20 overflow-hidden rounded border"
                        onClick={() => setPreviewImage(image)}
                      >
                        <Image
                          src={image.thumbnailUrl || image.url}
                          alt={image.filename}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      </button>
                      <div className="w-20 truncate text-[10px] text-muted-foreground" title={image.filename}>
                        {image.filename}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">{formatFileSize(image.size)}</span>
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
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit}>
              {editingRate ? "保存修改" : "确认创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              您确定要删除这条汇率记录吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deletingRate && (
            <div className="my-4 rounded-md bg-muted p-3 text-sm">
              <p>
                <span className="font-medium">货币:</span>{" "}
                {deletingRate.currency} ({deletingRate.currencyName})
              </p>
              <p>
                <span className="font-medium">时间:</span>{" "}
                {deletingRate.year}年{deletingRate.month}月
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

      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>图片预览</DialogTitle>
            <DialogDescription>{previewImage?.filename}</DialogDescription>
          </DialogHeader>
          {previewImage && (
            <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/20">
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
