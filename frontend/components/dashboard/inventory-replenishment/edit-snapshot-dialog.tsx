'use client'

import { useEffect, useState } from 'react'
import { Camera, Pencil } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'

const API_BASE = '/api/backend'

interface EditSnapshotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshotId: number
  initialName: string | null
  initialDescription: string | null
  onSuccess: () => void
}

export function EditSnapshotDialog({
  open,
  onOpenChange,
  snapshotId,
  initialName,
  initialDescription,
  onSuccess,
}: EditSnapshotDialogProps) {
  const { notify } = useNotifications()
  const [name, setName] = useState(initialName ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
  const [saving, setSaving] = useState(false)

  // Sync state when dialog opens with new values
  useEffect(() => {
    if (open) {
      setName(initialName ?? '')
      setDescription(initialDescription ?? '')
    }
  }, [open, initialName, initialDescription])

  async function handleSave() {
    setSaving(true)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/inventory-replenishment-snapshots/${snapshotId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim() || null,
            description: description.trim() || null,
          }),
        }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: '保存失败' }))
        throw new Error(error.detail || '保存失败')
      }

      notify({ type: 'success', title: '快照已更新' })
      onSuccess()
      onOpenChange(false)
    } catch (e) {
      notify({
        type: 'error',
        title: '保存失败',
        message: e instanceof Error ? e.message : '未知错误',
      })
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    if (!saving) {
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5" />
            编辑快照
          </DialogTitle>
          <DialogDescription>
            修改快照的名称和备注信息。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">快照名称（可选）</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：月末库存盘点-2026-05"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">备注（可选）</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="记录快照的用途或重要说明..."
              rows={3}
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}