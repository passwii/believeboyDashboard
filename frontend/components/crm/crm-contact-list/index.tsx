'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, MessageCircle, Pencil, Phone, Plus, Star, Trash2, X } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import type { Contact, ContactInput } from '@/lib/crm/types'

import styles from './crm-contact-list-warm.module.css'

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
      <div className={styles.loading} role="status" aria-label="联系人加载中">
        <span className={styles.loadingBar} aria-hidden="true" />
        <span className={styles.loadingBar} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className={styles.list}>
      <div className={styles.toolbar}>
        <p className={styles.muted}>
          {contacts.length > 0 ? `${contacts.length} 个联系人` : '暂无联系人'}
        </p>
        {editingId === null && (
          <WarmButton onClick={startCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" /> 添加联系人
          </WarmButton>
        )}
      </div>

      {editingId !== null && (
        <div className={styles.form}>
          <div className={styles.grid}>
            <div className={`${styles.field} ${styles.wide}`}>
              <Label className={styles.label}>姓名 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="联系人姓名"
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <Label className={styles.label}>职务</Label>
              <Input
                value={form.title ?? ''}
                onChange={(e) => setField('title', e.target.value)}
                placeholder="如：采购经理"
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <Label className={styles.label}>电话</Label>
              <Input
                value={form.phone ?? ''}
                onChange={(e) => setField('phone', e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <Label className={styles.label}>微信</Label>
              <Input
                value={form.wechat ?? ''}
                onChange={(e) => setField('wechat', e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <Label className={styles.label}>邮箱</Label>
              <Input
                value={form.email ?? ''}
                onChange={(e) => setField('email', e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={`${styles.field} ${styles.wide}`}>
              <Label className={styles.label}>备注</Label>
              <Input
                value={form.remark ?? ''}
                onChange={(e) => setField('remark', e.target.value)}
                className={styles.input}
              />
            </div>
          </div>
          <label className={styles.primaryToggle}>
            <input
              type="checkbox"
              checked={form.isPrimary ?? false}
              onChange={(e) => setField('isPrimary', e.target.checked)}
              className="h-4 w-4"
            />
            设为主联系人
          </label>
          <div className={styles.formActions}>
            <WarmButton variant="quiet" onClick={cancel} disabled={saving}>
              <X className="h-4 w-4" aria-hidden="true" /> 取消
            </WarmButton>
            <WarmButton variant="primary" onClick={submit} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </WarmButton>
          </div>
        </div>
      )}

      <div className={styles.contacts}>
        {contacts.map((c) => (
          <div key={c.id} className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardBody}>
                <div className={styles.nameLine}>
                  <span className={styles.name}>{c.name}</span>
                  {c.title && <span className={styles.title}>{c.title}</span>}
                  {c.isPrimary && (
                    <WarmCrmStatusPill tone="accent">
                      <Star className="mr-1 h-3 w-3 fill-current" aria-hidden="true" /> 主联系人
                    </WarmCrmStatusPill>
                  )}
                </div>
                <div className={styles.contactMeta}>
                  {c.phone && (
                    <span className={styles.metaItem}>
                      <Phone className={styles.metaIcon} aria-hidden="true" /> {c.phone}
                    </span>
                  )}
                  {c.wechat && (
                    <span className={styles.metaItem}>
                      <MessageCircle className={styles.metaIcon} aria-hidden="true" /> {c.wechat}
                    </span>
                  )}
                  {c.email && (
                    <span className={styles.metaItem}>
                      <Mail className={styles.metaIcon} aria-hidden="true" /> {c.email}
                    </span>
                  )}
                </div>
                {c.remark && <p className={styles.remark}>{c.remark}</p>}
              </div>
              <div className={styles.contactActions}>
                {!c.isPrimary && (
                  <WarmIconButton aria-label="设为主联系人" onClick={() => handleSetPrimary(c)}>
                    <Star className="h-4 w-4" />
                  </WarmIconButton>
                )}
                <WarmIconButton aria-label="编辑" onClick={() => startEdit(c)}>
                  <Pencil className="h-4 w-4" />
                </WarmIconButton>
                <WarmIconButton aria-label="删除" onClick={() => handleDelete(c)}>
                  <Trash2 className={`h-4 w-4 ${styles.dangerIcon}`} />
                </WarmIconButton>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
