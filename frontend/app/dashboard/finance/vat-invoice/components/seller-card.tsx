'use client'

// Seller 卡片：店铺下拉（按 vat_enabled 过滤）+ 国家下拉 + VAT 主体 CRUD
// 数据来自 /api/v1/vat-entities（vat-entity-api）；不再回退到 project_context JSON。

import { useEffect, useState } from 'react'
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
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { fetchProjectsManage } from '../lib/invoice-api'
import {
  fetchEntities,
  upsertEntity,
  updateEntity,
  deleteEntity,
} from '../lib/vat-entity-api'
import type { ProjectOption, VatEntity } from '../types'
import styles from '../vat-invoice-warm.module.css'

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
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [projectRetryKey, setProjectRetryKey] = useState(0)
  const [loadingEntities, setLoadingEntities] = useState(false)
  const [entityLoadError, setEntityLoadError] = useState<string | null>(null)
  const [entityRetryKey, setEntityRetryKey] = useState(0)
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
    setProjectLoadError(null)
    fetchProjectsManage()
      .then((rows) => {
        if (!alive) return
        setProjects(rows)
      })
      .catch((err) => {
        if (!alive) return
        setProjectLoadError('店铺列表加载失败')
        notify({ type: 'error', title: '加载失败', message: normalizeErrorMessage(err) })
      })
      .finally(() => {
        if (!alive) return
        setLoadingProjects(false)
      })
    return () => {
      alive = false
    }
  }, [notify, projectRetryKey])

  // 选中店铺时加载其 VAT 主体
  useEffect(() => {
    if (selectedProjectId == null) {
      onSellersChange([])
      onCountryChange('')
      setEntityLoadError(null)
      setLoadingEntities(false)
      return
    }
    let alive = true
    setLoadingEntities(true)
    setEntityLoadError(null)
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
        const message = normalizeErrorMessage(err)
        setEntityLoadError(message)
        notify({ type: 'error', title: '加载 VAT 主体失败', message })
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
  }, [selectedProjectId, entityRetryKey])

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
    <section className={styles.panel} aria-labelledby="invoice-seller-title" data-warm-panel="true">
      <header className={styles.panelHeader}>
        <h2 id="invoice-seller-title" className={styles.panelTitle}>
          1 · 店铺与 Seller
        </h2>
        {selectedProjectId != null ? (
          <div className={styles.panelActions}>
            <WarmButton variant="secondary" onClick={openAddNew} disabled={loadingEntities}>
              <Plus aria-hidden />
              新增国家
            </WarmButton>
            {selectedCountry && (
              <WarmButton variant="quiet" onClick={openEdit} disabled={loadingEntities}>
                <Pencil aria-hidden />
                编辑
              </WarmButton>
            )}
          </div>
        ) : null}
      </header>
      <div className={styles.panelBody}>
        <div className={styles.sellerProjectRow}>
          <Label htmlFor="project-select" className={styles.label}>
            店铺
          </Label>
          <div
            className={styles.projectControl}
            aria-busy={loadingProjects || undefined}
          >
            <Select
              value={selectedProjectId != null ? String(selectedProjectId) : ''}
              onValueChange={(v) => onSelectProject(Number(v))}
              disabled={loadingProjects || Boolean(projectLoadError)}
            >
              <SelectTrigger
                id="project-select"
                className={styles.selectTrigger}
                aria-invalid={projectLoadError ? true : undefined}
                aria-describedby={projectLoadError ? 'vat-create-project-error' : undefined}
              >
                <SelectValue placeholder={loadingProjects ? '加载中…' : '选择店铺'} />
                {loadingProjects && <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin" />}
              </SelectTrigger>
              <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                {projects
                  .filter((p) => p.is_active && p.vat_enabled)
                  .map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.brand_name ? `${p.brand_name} — ${p.name}` : p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {loadingProjects ? (
              <span className={styles.projectControlStatus} role="status">
                正在加载店铺
              </span>
            ) : projectLoadError ? (
              <div className={styles.projectControlStatus}>
                <span
                  id="vat-create-project-error"
                  className={styles.projectControlError}
                  role="alert"
                >
                  {projectLoadError}
                </span>
                <WarmButton
                  className={styles.projectRetry}
                  variant="quiet"
                  onClick={() => setProjectRetryKey((current) => current + 1)}
                >
                  重试
                </WarmButton>
              </div>
            ) : null}
          </div>
        </div>

        {selectedProjectId != null && sellers.length > 0 ? (
          <div className={styles.sellerCountryRow}>
            <Label className={styles.label}>开票国家</Label>
            <div className={styles.sellerCountryControls}>
              <div className={styles.sellerCountrySelect}>
                <Select value={selectedCountry} onValueChange={onCountryChange}>
                  <SelectTrigger className={styles.selectTrigger}>
                    <SelectValue placeholder="选择国家" />
                  </SelectTrigger>
                  <SelectContent className={cn('warm-ledger', styles.selectContent)}>
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
                <WarmIconButton
                  onClick={() => confirmDelete(selectedCountry)}
                  disabled={saving}
                  title={`删除 ${selectedCountry} Seller`}
                  aria-label={`删除 ${selectedCountry} Seller`}
                >
                  <Trash2 aria-hidden />
                </WarmIconButton>
              )}
            </div>
          </div>
        ) : selectedProjectId != null && !loadingEntities && !entityLoadError ? (
          <div className={styles.notice}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>尚未配置任何国家的 VAT 主体。请点击右上角「新增国家」补充。</div>
          </div>
        ) : null}

        {selectedProjectId != null ? (
          loadingEntities ? (
            <div className={styles.loadingState} role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载 Seller…
            </div>
          ) : entityLoadError ? (
            <div className={styles.loadError} role="alert">
              <span>VAT 主体加载失败：{entityLoadError}</span>
              <WarmButton
                variant="quiet"
                onClick={() => setEntityRetryKey((current) => current + 1)}
              >
                重试
              </WarmButton>
            </div>
          ) : currentSeller ? (
            <div className={styles.subpanel}>
              <div className={styles.sellerIdentity}>
                <div className={styles.sellerName}>
                  {currentSeller.company_name || '（未填写公司名）'}
                </div>
                {currentSeller.vat_id ? <div>VAT: {currentSeller.vat_id}</div> : null}
                {currentSeller.address_line ? <div>{currentSeller.address_line}</div> : null}
                {currentSeller.postal_code || currentSeller.city ? (
                  <div>
                    {[currentSeller.postal_code, currentSeller.city].filter(Boolean).join(' ')}
                  </div>
                ) : null}
                {currentSeller.country ? <div>{currentSeller.country}</div> : null}
                {currentSeller.email ? <div>{currentSeller.email}</div> : null}
              </div>
            </div>
          ) : (
            <p className={styles.emptyState}>尚未配置任何国家的 Seller。请新增。</p>
          )
        ) : (
          <p className={styles.emptyState}>请先选择店铺以加载 Seller。</p>
        )}
      </div>

      {/* 编辑 / 新增 Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className={cn('warm-ledger', styles.dialog, styles.dialogForm)}>
          <DialogHeader>
            <DialogTitle>
              {editMode === 'add' ? '新增 Seller' : `编辑 ${selectedCountry} Seller`}
            </DialogTitle>
            <DialogDescription>
              将保存到当前店铺的 vat_entities 表（仅 VAT 启用店铺可见）。
            </DialogDescription>
          </DialogHeader>

          <div className={styles.fieldGrid}>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="edit-country" className={styles.label}>
                国家代码 *
              </Label>
              <Input
                id="edit-country"
                className={cn(styles.control, styles.numericControl)}
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
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="edit-company" className={styles.label}>
                公司名 *
              </Label>
              <Input
                id="edit-company"
                className={styles.control}
                value={editDraft.company_name}
                onChange={(e) => setEditDraft({ ...editDraft, company_name: e.target.value })}
                placeholder="ACME EU GmbH"
              />
            </div>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="edit-vat" className={styles.label}>
                VAT 号 *
              </Label>
              <Input
                id="edit-vat"
                className={cn(styles.control, styles.numericControl)}
                value={editDraft.vat_id}
                onChange={(e) => setEditDraft({ ...editDraft, vat_id: e.target.value })}
                placeholder="DE123456789"
              />
            </div>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="edit-addr" className={styles.label}>
                街道地址
              </Label>
              <Input
                id="edit-addr"
                className={styles.control}
                value={editDraft.address_line}
                onChange={(e) => setEditDraft({ ...editDraft, address_line: e.target.value })}
                placeholder="38 avenue John F. Kennedy"
              />
            </div>
            <div className={styles.field}>
              <Label htmlFor="edit-postal" className={styles.label}>
                邮编
              </Label>
              <Input
                id="edit-postal"
                className={cn(styles.control, styles.numericControl)}
                value={editDraft.postal_code}
                onChange={(e) => setEditDraft({ ...editDraft, postal_code: e.target.value })}
                placeholder="L-1855"
              />
            </div>
            <div className={styles.field}>
              <Label htmlFor="edit-city" className={styles.label}>
                城市
              </Label>
              <Input
                id="edit-city"
                className={styles.control}
                value={editDraft.city}
                onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })}
                placeholder="Luxembourg"
              />
            </div>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="edit-email" className={styles.label}>
                邮箱
              </Label>
              <Input
                id="edit-email"
                className={styles.control}
                value={editDraft.email}
                onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                placeholder="ar@acme.example"
              />
            </div>
            <div className={cn(styles.checkboxRow, styles.fieldFull)}>
              <Checkbox
                id="edit-default"
                className={styles.checkbox}
                checked={editDraft.is_default}
                onCheckedChange={(v) =>
                  setEditDraft({ ...editDraft, is_default: Boolean(v) })
                }
              />
              <Label htmlFor="edit-default" className={styles.label}>
                设为该国家默认 Seller
              </Label>
            </div>
          </div>

          <DialogFooter>
            <WarmButton variant="quiet" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </WarmButton>
            <WarmButton
              variant="primary"
              onClick={saveEdit}
              disabled={saving}
              loading={saving}
              loadingLabel="正在保存 Seller"
            >
              {saving ? '保存中…' : '保存'}
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className={cn('warm-ledger', styles.dialog, styles.dialogSmall)}>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 {deleteTarget} 的 Seller 信息吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <WarmButton
              variant="quiet"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={saving}
            >
              取消
            </WarmButton>
            <WarmButton
              variant="secondary"
              className={styles.dangerAction}
              onClick={executeDelete}
              disabled={saving}
              loading={saving}
              loadingLabel="正在删除 Seller"
            >
              删除
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
