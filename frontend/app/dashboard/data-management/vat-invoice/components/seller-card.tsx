"use client"

// Seller 卡片：店铺下拉 + 加载/编辑 Seller 预填信息
// - 切换店铺自动 GET /projects/{id}/context，缺失字段回退到 brand_name + store_address
// - "Edit Seller" 弹 Dialog 编辑，PATCH /projects/{id}/context 持久化
// - seller 状态受控（由父级提升），便于 PDF 渲染访问

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
import { Loader2, Pencil, AlertTriangle } from "lucide-react"
import { useNotifications } from "@/components/notifications"
import { normalizeErrorMessage } from "@/lib/error-utils"
import {
  fetchProjectsManage,
  fetchProjectContext,
  patchInvoiceSeller,
} from "../lib/invoice-api"
import type { InvoiceSeller, ProjectOption } from "../types"

interface SellerCardProps {
  selectedProjectId: number | null
  seller: InvoiceSeller
  onSellerChange: (seller: InvoiceSeller) => void
  onSelectProject: (id: number) => void
}

const emptySeller: InvoiceSeller = {
  company_name: "",
  vat_id: "",
  address_line: "",
  postal_code: "",
  city: "",
  country: "",
}

function buildFallbackSeller(p: ProjectOption): InvoiceSeller {
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
  seller,
  onSellerChange,
  onSelectProject,
}: SellerCardProps) {
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingContext, setLoadingContext] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editDraft, setEditDraft] = useState<InvoiceSeller>(emptySeller)
  const [isFallback, setIsFallback] = useState(false)

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

  // 加载店铺 Seller
  useEffect(() => {
    if (selectedProjectId == null) {
      onSellerChange(emptySeller)
      setIsFallback(false)
      return
    }
    const p = projects.find((x) => x.id === selectedProjectId)
    if (!p) return
    const fallback = buildFallbackSeller(p)

    let alive = true
    setLoadingContext(true)
    fetchProjectContext(selectedProjectId)
      .then((ctx) => {
        if (!alive) return
        const stored = ctx.project_context?.invoice_seller
        if (stored && stored.company_name) {
          onSellerChange(stored)
          setIsFallback(false)
        } else {
          onSellerChange(fallback)
          setIsFallback(true)
        }
      })
      .catch(() => {
        if (!alive) return
        onSellerChange(fallback)
        setIsFallback(true)
      })
      .finally(() => {
        if (!alive) return
        setLoadingContext(false)
      })
    return () => {
      alive = false
    }
  }, [selectedProjectId, projects, onSellerChange])

  const openEdit = () => {
    setEditDraft(seller)
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (selectedProjectId == null) return
    if (!editDraft.company_name.trim()) {
      notify({ type: "error", title: "校验失败", message: "公司名不能为空" })
      return
    }
    setSaving(true)
    try {
      await patchInvoiceSeller(selectedProjectId, editDraft)
      onSellerChange(editDraft)
      setIsFallback(false)
      setEditOpen(false)
      notify({ type: "success", title: "保存成功", message: "Seller 信息已保存" })
    } catch (err) {
      notify({ type: "error", title: "保存失败", message: normalizeErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="dashboard-surface">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">1. 店铺与 Seller 信息</CardTitle>
        {selectedProjectId != null && (
          <Button
            variant="outline"
            size="sm"
            onClick={openEdit}
            disabled={loadingContext}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            编辑 Seller
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 店铺下拉 */}
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
                  .map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.brand_name ? `${p.brand_name} — ${p.name}` : p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Seller 预览块 */}
        {selectedProjectId != null ? (
          loadingContext ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载 Seller…
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] p-4">
              {isFallback && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    尚未为该店铺预填 Seller（VAT 号缺失）。点击右上角"编辑 Seller"补充。
                  </div>
                </div>
              )}
              <div className="space-y-1 text-sm">
                <div className="font-semibold text-foreground">
                  {seller.company_name || "（未填写公司名）"}
                </div>
                {seller.vat_id && (
                  <div className="text-muted-foreground">VAT: {seller.vat_id}</div>
                )}
                {seller.address_line && (
                  <div className="text-muted-foreground">{seller.address_line}</div>
                )}
                {(seller.postal_code || seller.city) && (
                  <div className="text-muted-foreground">
                    {[seller.postal_code, seller.city].filter(Boolean).join(" ")}
                  </div>
                )}
                {seller.country && (
                  <div className="text-muted-foreground">{seller.country}</div>
                )}
              </div>
            </div>
          )
        ) : (
          <p className="text-sm text-muted-foreground">请先选择店铺以加载 Seller。</p>
        )}
      </CardContent>

      {/* Edit Seller Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>编辑 Seller 信息</DialogTitle>
            <DialogDescription>
              将保存到当前店铺的 context（仅对 VAT 发票功能可见）。
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="seller-company">公司名 *</Label>
              <Input
                id="seller-company"
                value={editDraft.company_name}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, company_name: e.target.value })
                }
                placeholder="ACME EU GmbH"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="seller-vat">VAT 号 *</Label>
              <Input
                id="seller-vat"
                value={editDraft.vat_id}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, vat_id: e.target.value })
                }
                placeholder="DE123456789"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="seller-addr">街道地址</Label>
              <Input
                id="seller-addr"
                value={editDraft.address_line}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, address_line: e.target.value })
                }
                placeholder="38 avenue John F. Kennedy"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seller-postal">邮编</Label>
              <Input
                id="seller-postal"
                value={editDraft.postal_code}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, postal_code: e.target.value })
                }
                placeholder="L-1855"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seller-city">城市</Label>
              <Input
                id="seller-city"
                value={editDraft.city}
                onChange={(e) =>
                  setEditDraft({ ...editDraft, city: e.target.value })
                }
                placeholder="Luxembourg"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="seller-country">国家（ISO 2 字母）</Label>
              <Input
                id="seller-country"
                value={editDraft.country}
                onChange={(e) =>
                  setEditDraft({
                    ...editDraft,
                    country: e.target.value.toUpperCase().slice(0, 2),
                  })
                }
                placeholder="LU"
                maxLength={2}
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
    </Card>
  )
}
