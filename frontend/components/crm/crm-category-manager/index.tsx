'use client'

/**
 * CrmCategoryManager — 产品类目管理（P6b，仅管理员增/改名/删）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { Category } from '@/lib/crm/types'
import { useNotifications } from '@/components/notifications'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmSection,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './category-manager.module.css'

export function CrmCategoryManager({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setCategories(await client.listCategories())
    } catch {
      setError('类目加载失败')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      await client.createCategory({ name })
      notify({ type: 'success', title: '类目已创建' })
      setNewName('')
      await load()
    } catch (error) {
      notify({
        type: 'error',
        title: '创建失败',
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async (id: string) => {
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await client.updateCategory(id, { name })
      notify({ type: 'success', title: '已改名' })
      setEditingId(null)
      await load()
    } catch (error) {
      notify({
        type: 'error',
        title: '改名失败',
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    setBusy(true)
    try {
      await client.deleteCategory(id)
      notify({ type: 'success', title: '类目已删除' })
      setConfirmDelete(null)
      await load()
    } catch (error) {
      notify({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <WarmCrmSection title="产品类目">
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.createRow}>
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleCreate()
          }}
          placeholder="新类目名称，如：宠物用品"
          className={styles.input}
          data-testid="new-category-name"
        />
        <WarmButton
          onClick={() => void handleCreate()}
          disabled={creating || !newName.trim()}
          loading={creating}
        >
          <Plus aria-hidden="true" />
          添加
        </WarmButton>
      </div>

      {loading ? (
        <WarmCrmState className={styles.embeddedState} kind="loading" title="加载中" />
      ) : categories.length === 0 ? (
        <WarmCrmState className={styles.embeddedState} kind="empty" title="暂无类目" />
      ) : (
        <ul className={styles.categoryList}>
          {categories.map((category) => (
            <li
              key={category.id}
              className={styles.categoryRow}
              data-testid={`category-row-${category.name}`}
            >
              {editingId === category.id ? (
                <>
                  <input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename(category.id)
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    className={styles.input}
                    autoFocus
                  />
                  <WarmIconButton
                    onClick={() => void handleRename(category.id)}
                    disabled={busy || !editName.trim()}
                    aria-label="确认改名"
                  >
                    <Check aria-hidden="true" />
                  </WarmIconButton>
                  <WarmIconButton
                    onClick={() => setEditingId(null)}
                    aria-label="取消"
                  >
                    <X aria-hidden="true" />
                  </WarmIconButton>
                </>
              ) : (
                <>
                  <span className={styles.categoryName}>{category.name}</span>
                  <WarmIconButton
                    onClick={() => {
                      setEditingId(category.id)
                      setEditName(category.name)
                    }}
                    aria-label="改名"
                  >
                    <Pencil aria-hidden="true" />
                  </WarmIconButton>
                  {confirmDelete === category.id ? (
                    <>
                      <span className={styles.deleteHint}>删除将解除客户挂接，确定？</span>
                      <WarmButton
                        className={styles.deleteButton}
                        onClick={() => void handleDelete(category.id)}
                        disabled={busy}
                        aria-label={`确认删除 ${category.name}`}
                      >
                        删除
                      </WarmButton>
                      <WarmButton
                        variant="quiet"
                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </WarmButton>
                    </>
                  ) : (
                    <WarmIconButton
                      className={styles.dangerAction}
                      onClick={() => setConfirmDelete(category.id)}
                      aria-label="删除"
                    >
                      <Trash2 aria-hidden="true" />
                    </WarmIconButton>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </WarmCrmSection>
  )
}

CrmCategoryManager.displayName = 'CrmCategoryManager'
