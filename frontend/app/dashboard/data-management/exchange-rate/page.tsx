"use client"



import { useState, useEffect } from "react"
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
import { Pencil, Trash2, Plus, Search, X, RotateCcw } from "lucide-react"

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
  createdAt: string
  updatedAt: string
}

interface Filters {
  currency: string
  year: string
  month: string
}

export default function ExchangeRatePage() {
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

  // 表单状态
  const [formData, setFormData] = useState({
    currency: "",
    currencyName: "",
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    rate: "",
    description: "",
  })

  // 获取汇率列表
  const fetchRates = async () => {
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
  }

  // 初始加载
  useEffect(() => {
    fetchRates()
  }, [pagination.page, filters])

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
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" />
              新增汇率
            </Button>
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
                <SelectTrigger className="w-[100px]">
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
                ) : rates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      暂无汇率数据，点击右上角按钮新增
                    </TableCell>
                  </TableRow>
                ) : (
                  rates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell>
                        <Badge variant="secondary">{rate.currency}</Badge>
                      </TableCell>
                      <TableCell>{rate.currencyName}</TableCell>
                      <TableCell>{rate.year}</TableCell>
                      <TableCell>{rate.month}月</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {Number(rate.rate).toFixed(6)}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">
                        {rate.description || "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(rate.updatedAt).toLocaleString("zh-CN")}
                      </TableCell>
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
                : "录入新的月度汇率信息，每个月每种货币仅可录入一条"}
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
                  <SelectTrigger id="month">
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
                输入该月份该货币相对于基准货币的汇率值
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
    </div>
  )
}
