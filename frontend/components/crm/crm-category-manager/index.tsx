'use client'

/**
 * CrmCategoryManager — 产品类目管理（P6b，仅管理员增/改名/删）。
 * 从设置页独立抽取，供设置页（与规则引擎/工作流设置并存）引用。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { Category } from '@/lib/crm/types'
import { useNotifications } from '@/components/notifications'
import { TermPanel } from '@/components/terminal/term-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CrmCategoryManager() {
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

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      await client.createCategory({ name })
      notify({ type: 'success', title: '类目已创建' })
      setNewName('')
      await load()
    } catch (e) {
      notify({
        type: 'error',
        title: '创建失败',
        message: e instanceof Error ? e.message : undefined,
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
    } catch (e) {
      notify({
        type: 'error',
        title: '改名失败',
        message: e instanceof Error ? e.message : undefined,
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
    } catch (e) {
      notify({
        type: 'error',
        title: '删除失败',
        message: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    // BLF-837：区块容器走 TermPanel（与规则引擎/工作流设置同规格）
    <TermPanel title="产品类目">
      <div className="space-y-3 px-3 py-3">
        {error && (
          <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg">
            {error}
          </div>
        )}

        {/* 新增 */}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
            }}
            placeholder="新类目名称，如：宠物用品"
            className="max-w-xs rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text"
            data-testid="new-category-name"
          />
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !newName.trim()}
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            添加
          </Button>
        </div>

        {/* 列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : categories.length === 0 ? (
          <p className="py-6 text-center font-mono text-xs text-term-faint">暂无类目</p>
        ) : (
          <ul className="divide-y divide-term-border rounded-none border border-term-border">
            {categories.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 px-3 py-2"
                data-testid={`category-row-${c.name}`}
              >
                {editingId === c.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(c.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="h-9 max-w-xs rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text"
                      autoFocus
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px]"
                      onClick={() => void handleRename(c.id)}
                      disabled={busy || !editName.trim()}
                      aria-label="确认改名"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px]"
                      onClick={() => setEditingId(null)}
                      aria-label="取消"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm text-term-text">{c.name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px]"
                      onClick={() => {
                        setEditingId(c.id)
                        setEditName(c.name)
                      }}
                      aria-label="改名"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {confirmDelete === c.id ? (
                      <>
                          <span className="font-mono text-xs text-term-faint">
                          删除将解除客户挂接，确定？
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 max-md:min-h-[44px]"
                          onClick={() => void handleDelete(c.id)}
                          disabled={busy}
                          aria-label={`确认删除 ${c.name}`}
                        >
                          删除
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 max-md:min-h-[44px]"
                          onClick={() => setConfirmDelete(null)}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px] text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                        onClick={() => setConfirmDelete(c.id)}
                        aria-label="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </TermPanel>
  )
}

CrmCategoryManager.displayName = 'CrmCategoryManager'
