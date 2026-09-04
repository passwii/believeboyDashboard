'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, MessageCircle, Pencil, Phone, Plus, Star, Trash2, X } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import type { Contact, ContactInput } from '@/lib/crm/types'

const EMPTY_FORM: ContactInput = {
  name: '',
  phone: '',
  email: '',
  wechat: '',
  title: '',
  remark: '',
  isPrimary: false,
}

function toInput(c: Contact): ContactInput {
  return {
    name: c.name,
    phone: c.phone,
    email: c.email,
    wechat: c.wechat,
    title: c.title,
    remark: c.remark,
    isPrimary: c.isPrimary,
  }
}

/**
 * 客户联系人列表（P2c）：一个客户多个联系人 + 主联系人标注。
 * 后端保证主联系人唯一（设主降旧主 / 删主递补 / 首个自动主）。
 * 自包含 useCrmClient，挂在客户详情 Drawer 的「联系人」tab。
 */
export function CrmContactList({ customerId }: { customerId: string }) {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<ContactInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setContacts(await client.listContacts(customerId))
    } catch {
      // 静默：拉取失败显示空列表
    } finally {
      setLoading(false)
    }
  }, [client, customerId])

  useEffect(() => {
    void load()
  }, [load])

  const setField = (key: keyof ContactInput, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }))

  const startCreate = () => {
    setEditingId('new')
    setForm({ ...EMPTY_FORM, isPrimary: contacts.length === 0 })
  }
  const startEdit = (c: Contact) => {
    setEditingId(c.id)
    setForm(toInput(c))
  }
  const cancel = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const submit = async () => {
    if (!form.name.trim()) {
      notify({ type: 'error', title: '请填写联系人姓名' })
      return
    }
    setSaving(true)
    try {
      if (editingId === 'new') {
        await client.createContact(customerId, form)
        notify({ type: 'success', title: '联系人已添加' })
      } else if (editingId) {
        await client.updateContact(editingId, form)
        notify({ type: 'success', title: '联系人已更新' })
      }
      cancel()
      await load()
    } catch (e) {
      notify({
        type: 'error',
        title: '保存失败',
        message: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSetPrimary = async (c: Contact) => {
    try {
      await client.updateContact(c.id, { ...toInput(c), isPrimary: true })
      notify({ type: 'success', title: '已设为主联系人' })
      await load()
    } catch (e) {
      notify({ type: 'error', title: '操作失败', message: e instanceof Error ? e.message : undefined })
    }
  }

  const handleDelete = async (c: Contact) => {
    const ok = await confirm({
      title: '删除联系人',
      description: `确定删除联系人「${c.name}」吗？`,
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await client.deleteContact(c.id)
      notify({ type: 'success', title: '联系人已删除' })
      await load()
    } catch (e) {
      notify({ type: 'error', title: '删除失败', message: e instanceof Error ? e.message : undefined })
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-term-faint">
          {contacts.length > 0 ? `${contacts.length} 个联系人` : '暂无联系人'}
        </p>
        {editingId === null && (
          <Button size="sm" variant="outline" onClick={startCreate}>
            <Plus className="mr-1 h-4 w-4" /> 添加联系人
          </Button>
        )}
      </div>

      {editingId !== null && (
        <div className="space-y-3 rounded-none border border-term-border bg-term-panel p-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="col-span-2 space-y-1">
              <Label>姓名 *</Label>
              <Input value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="联系人姓名" />
            </div>
            <div className="space-y-1">
              <Label>职务</Label>
              <Input value={form.title ?? ''} onChange={(e) => setField('title', e.target.value)} placeholder="如：采购经理" />
            </div>
            <div className="space-y-1">
              <Label>电话</Label>
              <Input value={form.phone ?? ''} onChange={(e) => setField('phone', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>微信</Label>
              <Input value={form.wechat ?? ''} onChange={(e) => setField('wechat', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>邮箱</Label>
              <Input value={form.email ?? ''} onChange={(e) => setField('email', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>备注</Label>
              <Input value={form.remark ?? ''} onChange={(e) => setField('remark', e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 font-mono text-xs text-term-muted">
            <input
              type="checkbox"
              checked={form.isPrimary ?? false}
              onChange={(e) => setField('isPrimary', e.target.checked)}
              className="h-4 w-4 rounded-none border-term-border"
            />
            设为主联系人
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              <X className="mr-1 h-4 w-4" /> 取消
            </Button>
            <Button size="sm" onClick={submit} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {contacts.map((c) => (
          <div
            key={c.id}
            className="rounded-none border border-term-border bg-term-panel p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-term-text">{c.name}</span>
                  {c.title && <span className="truncate font-mono text-xs text-term-faint">{c.title}</span>}
                  {c.isPrimary && (
                    <Badge variant="secondary" className="font-mono text-[11px] bg-term-warn/10 text-term-warn">
                      <Star className="mr-0.5 h-3 w-3 fill-current" /> 主联系人
                    </Badge>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-term-faint">
                  {c.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {c.phone}
                    </span>
                  )}
                  {c.wechat && (
                    <span className="flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" /> {c.wechat}
                    </span>
                  )}
                  {c.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {c.email}
                    </span>
                  )}
                </div>
                {c.remark && <p className="mt-1 font-mono text-xs text-term-faint">{c.remark}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!c.isPrimary && (
                  <Button size="sm" variant="ghost" title="设为主联系人" onClick={() => handleSetPrimary(c)}>
                    <Star className="h-4 w-4" />
                  </Button>
                )}
                <Button size="sm" variant="ghost" title="编辑" onClick={() => startEdit(c)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" title="删除" onClick={() => handleDelete(c)}>
                  <Trash2 className="h-4 w-4 text-term-neg" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
