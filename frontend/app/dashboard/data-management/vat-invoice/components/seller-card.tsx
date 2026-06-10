"use client"

// Seller 卡片：店铺下拉（白名单过滤） + 国家下拉 + 加载/编辑/新增/删除 Seller
// - 店铺下拉只显示白名单店铺（目前只允许弥森）
// - 选店铺后加载 invoice_sellers 列表，自动执行旧数据迁移
// - 国家下拉选择当前 Seller
// - 编辑 Dialog 支持编辑、新增、删除国家 Seller

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2, Pencil, Plus, Trash2, AlertTriangle } from "lucide-react"
import { useNotifications } from "@/components/notifications"
import { normalizeErrorMessage } from "@/lib/error-utils"
import {
  VAT_ENABLED_PROJECT_NAMES,
  fetchProjectsManage,
  fetchProjectContext,
  patchInvoiceSellers,
  migrateSellersIfNeeded,
} from "../lib/invoice-api"
import type { InvoiceSellerEntry, ProjectOption } from "../types"

interface SellerCardProps {
  selectedProjectId: number | null
  sellers: InvoiceSellerEntry[]
  selectedCountry: string
  onSellersChange: (sellers: InvoiceSellerEntry[]) => void
  onCountryChange: (country: string) => void
  onSelectProject: (id: number) => void
}

const emptyEntry: InvoiceSellerEntry = {
  company_name: "",
  vat_id: "",
  address_line: "",
  postal_code: "",
  city: "",
  country: "",
}

function buildFallbackSeller(p: ProjectOption): InvoiceSellerEntry {
  return {
    company_name: p.brand_name ?? p.name,
    vat_id: "",
    address_line: p.store_address ?? "",
    postal_code: "",
    city: "",
    country: "",
  }
}

export function SellerCard({
  selectedProjectId,
  sellers,
  selectedCountry,
  onSellersChange,
  onCountryChange,
  onSelectProject,
}: SellerCardProps) {
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingContext, setLoadingContext] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isFallback, setIsFallback] = useState(false)

  // 编辑 Dialog 状态
  const [editOpen, setEditOpen] = useState(false)
  const [editDraft, setEditDraft] = useState<InvoiceSellerEntry>(emptyEntry)
  const [editMode, setEditMode] = useState<"edit" | "add">("edit")

  // 删除确认 Dialog
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // 当前选中的 Seller
  const currentSeller = sellers.find((s) => s.country === selectedCountry) ?? null

  // 加载店铺列表
  useEffect(() => {
    let alive = true
    setLoadingProjects(true)
    fetchProjectsManage()
      .then((rows) => {
        if (!alive) return
        setProjects(rows)
      })
      .catch((err) => {
        if (!alive) return
        notify({ type: "error", title: "加载失败", message: normalizeErrorMessage(err) })
      })
      .finally(() => {
        if (!alive) return
        setLoadingProjects(false)
      })
    return () => {
      alive = false
    }
  }, [notify])

  // 加载店铺 Seller 列表 + 旧数据迁移
  useEffect(() => {
    if (selectedProjectId == null) {
      onSellersChange([])
      onCountryChange("")
      setIsFallback(false)
      return
    }
    const p = projects.find((x) => x.id === selectedProjectId)
    if (!p) return

    let alive = true
    setLoadingContext(true)
    fetchProjectContext(selectedProjectId)
      .then(async (ctx) => {
        if (!alive) return
        // 惰性迁移
        const migrated = await migrateSellersIfNeeded(ctx)
        const list = migrated.project_context?.invoice_sellers ?? []
        onSellersChange(list)
        if (list.length > 0) {
          // 选中第一个（或保持已选中的）
          if (!selectedCountry || !list.find((s) => s.country === selectedCountry)) {
            onCountryChange(list[0].country)
          }
          setIsFallback(false)
        } else {
          // 回退到项目表推断
          const fallback = buildFallbackSeller(p)
          onSellersChange([fallback])
          onCountryChange("")
          setIsFallback(true)
        }
      })
      .catch(() => {
        if (!alive) return
        const fallback = buildFallbackSeller(p)
        onSellersChange([fallback])
        onCountryChange("")
        setIsFallback(true)
      })
      .finally(() => {
        if (!alive) return
        setLoadingContext(false)
      })
    return () => {
      alive = false
    }
  }, [selectedProjectId, projects])

  // 编辑当前国家
  const openEdit = () => {
    setEditMode("edit")
    setEditDraft(currentSeller ?? emptyEntry)
    setEditOpen(true)
  }

  // 新增国家
  const openAddNew = () => {
    setEditMode("add")
    setEditDraft(emptyEntry)
    setEditOpen(true)
  }

  // 保存（编辑或新增）
  const saveEdit = async () => {
    if (selectedProjectId == null) return
    if (!editDraft.company_name.trim()) {
      notify({ type: "error", title: "校验失败", message: "公司名不能为空" })
      return
    }
    if (!editDraft.country.trim()) {
      notify({ type: "error", title: "校验失败", message: "国家代码不能为空" })
      return
    }
    setSaving(true)
    try {
      // 合并：如果已存在该 country 则替换，否则追加
      const existing = sellers.filter((s) => s.country !== editDraft.country)
      const next = [...existing, editDraft]
      await patchInvoiceSellers(selectedProjectId, next)
      onSellersChange(next)
      onCountryChange(editDraft.country)
      setEditOpen(false)
      setIsFallback(false)
      notify({ type: "success", title: "保存成功", message: `${editDraft.country} Seller 已保存` })
    } catch (err) {
      notify({ type: "error", title: "保存失败", message: normalizeErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  // 确认删除
  const confirmDelete = (country: string) => {
    setDeleteTarget(country)
    setDeleteConfirmOpen(true)
  }

  const executeDelete = async () => {
    if (selectedProjectId == null || !deleteTarget) return
    setSaving(true)
    try {
      const next = sellers.filter((s) => s.country !== deleteTarget)
      await patchInvoiceSellers(selectedProjectId, next)
      onSellersChange(next)
      if (selectedCountry === deleteTarget) {
        onCountryChange(next.length > 0 ? next[0].country : "")
      }
      notify({ type: "success", title: "删除成功", message: `${deleteTarget} Seller 已删除` })
    } catch (err) {
      notify({ type: "error", title: "删除失败", message: normalizeErrorMessage(err) })
    } finally {
      setSaving(false)
      setDeleteConfirmOpen(false)
      setDeleteTarget(null)
    }
  }

  return (
    <Card className="dashboard-surface">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">1. 店铺与 Seller 信息</CardTitle>
        {selectedProjectId != null && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={openAddNew}
              disabled={loadingContext}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              新增国家
            </Button>
            {selectedCountry && (
              <Button
                variant="outline"
                size="sm"
                onClick={openEdit}
                disabled={loadingContext}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                编辑
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 店铺下拉（白名单过滤） */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <Label htmlFor="project-select" className="self-center">
            店铺
          </Label>
          <div className="md:col-span-2">
            <Select
              value={selectedProjectId != null ? String(selectedProjectId) : ""}
              onValueChange={(v) => onSelectProject(Number(v))}
              disabled={loadingProjects}
            >
              <SelectTrigger id="project-select">
                <SelectValue
                  placeholder={loadingProjects ? "加载中…" : "选择店铺"}
                />
                {loadingProjects && (
                  <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin" />
                )}
              </SelectTrigger>
              <SelectContent>
                {projects
                  .filter((p) => p.is_active)
                  .filter((p) => (VAT_ENABLED_PROJECT_NAMES as readonly string[]).includes(p.name))
                  .map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.brand_name ? `${p.brand_name} — ${p.name}` : p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 国家选择 */}
        {selectedProjectId != null && sellers.length > 0 && !isFallback ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Label className="self-center">开票国家</Label>
            <div className="flex gap-2 md:col-span-2">
              <div className="flex-1">
                <Select value={selectedCountry} onValueChange={onCountryChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择国家" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellers.map((s) => (
                      <SelectItem key={s.country} value={s.country}>
                        {s.country} — {s.company_name || "未填写"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedCountry && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-red-600"
                  onClick={() => confirmDelete(selectedCountry)}
                  disabled={saving}
                  title={`删除 ${selectedCountry} Seller`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        ) : selectedProjectId != null && !loadingContext && isFallback ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              尚未配置任何国家的 VAT 主体。请点击右上角"新增国家"补充。
            </div>
          </div>
        ) : null}

        {/* Seller 预览块 */}
        {selectedProjectId != null ? (
          loadingContext ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载 Seller…
            </div>
          ) : currentSeller ? (
            <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] p-4">
              <div className="space-y-1 text-sm">
                <div className="font-semibold text-foreground">
                  {currentSeller.company_name || "（未填写公司名）"}
                </div>
                {currentSeller.vat_id && (
                  <div className="text-muted-foreground">VAT: {currentSeller.vat_id}</div>
                )}
                {currentSeller.address_line && (
                  <div className="text-muted-foreground">{currentSeller.address_line}</div>
                )}
                {(currentSeller.postal_code || currentSeller.city) && (
                  <div className="text-muted-foreground">
                    {[currentSeller.postal_code, currentSeller.city].filter(Boolean).join(" ")}
                  </div>
                )}
                {currentSeller.country && (
                  <div className="text-muted-foreground">{currentSeller.country}</div>
                )}
              </div>
            </div>
          ) : sellers.length === 0 && !isFallback ? (
            <p className="text-sm text-muted-foreground">尚未配置任何国家的 Seller。请新增。</p>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground">请先选择店铺以加载 Seller。</p>
        )}
      </CardContent>

      {/* 编辑 / 新增 Seller Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editMode === "add" ? "新增 Seller" : `编辑 ${selectedCountry} Seller`}
            </DialogTitle>
            <DialogDescription>
              将保存到当前店铺的 context（仅对 VAT 发票功能可见）。
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-country">国家代码 *</Label>
              <Input
                id="edit-country"
                value={editDraft.country}
                onChange={(e) =>
                  setEditDraft({
                    ...editDraft,
                    country: e.target.value.toUpperCase().slice(0, 2),
                  })
                }
                placeholder="DE"
                maxLength={2}
                disabled={editMode === "edit"}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-company">公司名 *</Label>
              <Input
                id="edit-company"
                value={editDraft.company_name}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, company_name: e.target.value })
                }
                placeholder="ACME EU GmbH"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-vat">VAT 号 *</Label>
              <Input
                id="edit-vat"
                value={editDraft.vat_id}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, vat_id: e.target.value })
                }
                placeholder="DE123456789"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-addr">街道地址</Label>
              <Input
                id="edit-addr"
                value={editDraft.address_line}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, address_line: e.target.value })
                }
                placeholder="38 avenue John F. Kennedy"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-postal">邮编</Label>
              <Input
                id="edit-postal"
                value={editDraft.postal_code}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, postal_code: e.target.value })
                }
                placeholder="L-1855"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-city">城市</Label>
              <Input
                id="edit-city"
                value={editDraft.city}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, city: e.target.value })
                }
                placeholder="Luxembourg"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 {deleteTarget} 的 Seller 信息吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={executeDelete}
              disabled={saving}
            >
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
