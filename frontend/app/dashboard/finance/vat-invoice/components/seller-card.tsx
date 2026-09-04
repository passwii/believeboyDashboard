'use client'

// Seller 卡片：店铺下拉（按 vat_enabled 过滤）+ 国家下拉 + VAT 主体 CRUD
// 数据来自 /api/v1/vat-entities（vat-entity-api）；不再回退到 project_context JSON。

import { useEffect, useState } from 'react'
import { TermPanel } from '@/components/terminal/term-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Loader2, Pencil, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchProjectsManage } from '../lib/invoice-api'
import {
  fetchEntities,
  upsertEntity,
  updateEntity,
  deleteEntity,
} from '../lib/vat-entity-api'
import type { ProjectOption, VatEntity } from '../types'

interface SellerCardProps {
  selectedProjectId: number | null
  sellers: VatEntity[]
  selectedCountry: string
  onSellersChange: (sellers: VatEntity[]) => void
  onCountryChange: (country: string) => void
  onSelectProject: (id: number) => void
}

const emptyEntry: Omit<VatEntity, 'id' | 'project_id' | 'created_at' | 'updated_at'> = {
  country: '',
  company_name: '',
  vat_id: '',
  address_line: '',
  postal_code: '',
  city: '',
  email: '',
  is_default: false,
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
  const [loadingEntities, setLoadingEntities] = useState(false)
  const [saving, setSaving] = useState(false)

  // 编辑 Dialog 状态
  const [editOpen, setEditOpen] = useState(false)
  const [editDraft, setEditDraft] =
    useState<typeof emptyEntry>(emptyEntry)
  const [editMode, setEditMode] = useState<'edit' | 'add'>('edit')
  const [editingEntityId, setEditingEntityId] = useState<number | null>(null)

  // 删除确认
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const currentSeller = sellers.find((s) => s.country === selectedCountry) ?? null

  // 加载店铺列表（仅一次）
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
        notify({ type: 'error', title: '加载失败', message: normalizeErrorMessage(err) })
      })
      .finally(() => {
        if (!alive) return
        setLoadingProjects(false)
      })
    return () => {
      alive = false
    }
  }, [notify])

  // 选中店铺时加载其 VAT 主体
  useEffect(() => {
    if (selectedProjectId == null) {
      onSellersChange([])
      onCountryChange('')
      return
    }
    let alive = true
    setLoadingEntities(true)
    fetchEntities(selectedProjectId)
      .then((list) => {
        if (!alive) return
        onSellersChange(list)
        if (list.length > 0) {
          if (!selectedCountry || !list.find((s) => s.country === selectedCountry)) {
            onCountryChange(list[0].country)
          }
        } else {
          onCountryChange('')
        }
      })
      .catch((err) => {
        if (!alive) return
        notify({ type: 'error', title: '加载 VAT 主体失败', message: normalizeErrorMessage(err) })
        onSellersChange([])
        onCountryChange('')
      })
      .finally(() => {
        if (!alive) return
        setLoadingEntities(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId])

  const openEdit = () => {
    if (!currentSeller) return
    setEditMode('edit')
    setEditingEntityId(currentSeller.id)
    setEditDraft({
      country: currentSeller.country,
      company_name: currentSeller.company_name,
      vat_id: currentSeller.vat_id,
      address_line: currentSeller.address_line,
      postal_code: currentSeller.postal_code,
      city: currentSeller.city,
      email: currentSeller.email,
      is_default: currentSeller.is_default,
    })
    setEditOpen(true)
  }

  const openAddNew = () => {
    setEditMode('add')
    setEditingEntityId(null)
    setEditDraft({ ...emptyEntry })
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (selectedProjectId == null) return
    if (!editDraft.company_name.trim()) {
      notify({ type: 'error', title: '校验失败', message: '公司名不能为空' })
      return
    }
    if (!editDraft.country.trim()) {
      notify({ type: 'error', title: '校验失败', message: '国家代码不能为空' })
      return
    }
    setSaving(true)
    try {
      const saved = await upsertEntity({
        project_id: selectedProjectId,
        country: editDraft.country,
        company_name: editDraft.company_name,
        vat_id: editDraft.vat_id,
        address_line: editDraft.address_line,
        postal_code: editDraft.postal_code,
        city: editDraft.city,
        email: editDraft.email,
        is_default: editDraft.is_default,
      })
      // 合并到本地 sellers
      const next = [
        ...sellers.filter((s) => s.id !== saved.id && s.country !== saved.country),
        saved,
      ]
      onSellersChange(next)
      onCountryChange(saved.country)
      setEditOpen(false)
      notify({ type: 'success', title: '保存成功', message: `${saved.country} Seller 已保存` })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: normalizeErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = (country: string) => {
    setDeleteTarget(country)
    setDeleteConfirmOpen(true)
  }

  const executeDelete = async () => {
    if (selectedProjectId == null || !deleteTarget) return
    const target = sellers.find((s) => s.country === deleteTarget)
    if (!target) {
      setDeleteConfirmOpen(false)
      setDeleteTarget(null)
      return
    }
    setSaving(true)
    try {
      await deleteEntity(target.id)
      const next = sellers.filter((s) => s.id !== target.id)
      onSellersChange(next)
      if (selectedCountry === deleteTarget) {
        onCountryChange(next.length > 0 ? next[0].country : '')
      }
      notify({ type: 'success', title: '删除成功', message: `${deleteTarget} Seller 已删除` })
    } catch (err) {
      notify({ type: 'error', title: '删除失败', message: normalizeErrorMessage(err) })
    } finally {
      setSaving(false)
      setDeleteConfirmOpen(false)
      setDeleteTarget(null)
    }
  }

  return (
    <TermPanel
      title="1 · 店铺与 Seller"
      actions={
        selectedProjectId != null && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
              onClick={openAddNew}
              disabled={loadingEntities}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              新增国家
            </Button>
            {selectedCountry && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
                onClick={openEdit}
                disabled={loadingEntities}
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                编辑
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="space-y-4 p-3">
        {/* 店铺下拉（vat_enabled 过滤） */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <Label htmlFor="project-select" className="self-center">
            店铺
          </Label>
          <div className="md:col-span-2">
            <Select
              value={selectedProjectId != null ? String(selectedProjectId) : ''}
              onValueChange={(v) => onSelectProject(Number(v))}
              disabled={loadingProjects}
            >
              <SelectTrigger id="project-select">
                <SelectValue placeholder={loadingProjects ? '加载中…' : '选择店铺'} />
                {loadingProjects && <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin" />}
              </SelectTrigger>
              <SelectContent>
                {projects
                  .filter((p) => p.is_active && p.vat_enabled)
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
        {selectedProjectId != null && sellers.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Label className="self-center">开票国家</Label>
            <div className="flex gap-2 md:col-span-2">
              <div className="flex-1">
                <Select value={selectedCountry} onValueChange={onCountryChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择国家" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellers
                      .filter((s) => s.country)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.country}>
                          {s.country} — {s.company_name || '未填写'}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedCountry && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive max-md:h-11 max-md:w-11"
                  onClick={() => confirmDelete(selectedCountry)}
                  disabled={saving}
                  title={`删除 ${selectedCountry} Seller`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        ) : selectedProjectId != null && !loadingEntities ? (
          <div className="flex items-start gap-2 rounded-none border border-[hsl(var(--data-warning)/0.4)] bg-[hsl(var(--data-warning)/0.08)] px-3 py-2 text-xs text-[hsl(var(--data-warning))]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>尚未配置任何国家的 VAT 主体。请点击右上角「新增国家」补充。</div>
          </div>
        ) : null}

        {/* Seller 预览 */}
        {selectedProjectId != null ? (
          loadingEntities ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载 Seller…
            </div>
          ) : currentSeller ? (
            <div className="rounded-none border border-border/60 bg-term-raised p-4">
              <div className="space-y-1 text-sm">
                <div className="font-semibold text-foreground">
                  {currentSeller.company_name || '（未填写公司名）'}
                </div>
                {currentSeller.vat_id && (
                  <div className="text-muted-foreground">VAT: {currentSeller.vat_id}</div>
                )}
                {currentSeller.address_line && (
                  <div className="text-muted-foreground">{currentSeller.address_line}</div>
                )}
                {(currentSeller.postal_code || currentSeller.city) && (
                  <div className="text-muted-foreground">
                    {[currentSeller.postal_code, currentSeller.city].filter(Boolean).join(' ')}
                  </div>
                )}
                {currentSeller.country && (
                  <div className="text-muted-foreground">{currentSeller.country}</div>
                )}
                {currentSeller.email && (
                  <div className="text-muted-foreground">{currentSeller.email}</div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">尚未配置任何国家的 Seller。请新增。</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">请先选择店铺以加载 Seller。</p>
        )}
      </div>

      {/* 编辑 / 新增 Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-none sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editMode === 'add' ? '新增 Seller' : `编辑 ${selectedCountry} Seller`}
            </DialogTitle>
            <DialogDescription>
              将保存到当前店铺的 vat_entities 表（仅 VAT 启用店铺可见）。
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
                disabled={editMode === 'edit'}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-company">公司名 *</Label>
              <Input
                id="edit-company"
                value={editDraft.company_name}
                onChange={(e) => setEditDraft({ ...editDraft, company_name: e.target.value })}
                placeholder="ACME EU GmbH"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-vat">VAT 号 *</Label>
              <Input
                id="edit-vat"
                value={editDraft.vat_id}
                onChange={(e) => setEditDraft({ ...editDraft, vat_id: e.target.value })}
                placeholder="DE123456789"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-addr">街道地址</Label>
              <Input
                id="edit-addr"
                value={editDraft.address_line}
                onChange={(e) => setEditDraft({ ...editDraft, address_line: e.target.value })}
                placeholder="38 avenue John F. Kennedy"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-postal">邮编</Label>
              <Input
                id="edit-postal"
                value={editDraft.postal_code}
                onChange={(e) => setEditDraft({ ...editDraft, postal_code: e.target.value })}
                placeholder="L-1855"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-city">城市</Label>
              <Input
                id="edit-city"
                value={editDraft.city}
                onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })}
                placeholder="Luxembourg"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-email">邮箱</Label>
              <Input
                id="edit-email"
                value={editDraft.email}
                onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                placeholder="ar@acme.example"
              />
            </div>
            <div className="flex items-center gap-2 md:col-span-2">
              <Checkbox
                id="edit-default"
                checked={editDraft.is_default}
                onCheckedChange={(v) =>
                  setEditDraft({ ...editDraft, is_default: Boolean(v) })
                }
              />
              <Label htmlFor="edit-default">设为该国家默认 Seller</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 {deleteTarget} 的 Seller 信息吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="destructive" onClick={executeDelete} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TermPanel>
  )
}
