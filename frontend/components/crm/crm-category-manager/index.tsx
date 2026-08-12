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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">产品类目</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
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
            className="max-w-xs"
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
          <p className="py-6 text-center text-sm text-muted-foreground">暂无类目</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
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
                      className="h-8 max-w-xs"
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
                    <span className="flex-1 text-sm">{c.name}</span>
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
                        <span className="text-xs text-muted-foreground">
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
      </CardContent>
    </Card>
  )
}

CrmCategoryManager.displayName = 'CrmCategoryManager'
