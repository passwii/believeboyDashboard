'use client'

import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useNotifications } from '@/components/notifications'

const API_BASE = '/api/backend'

interface EditPricingSnapshotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshotId: number
  initialName: string | null
  initialDescription: string | null
  onSuccess: () => void
}

export function EditPricingSnapshotDialog({
  open,
  onOpenChange,
  snapshotId,
  initialName,
  initialDescription,
  onSuccess,
}: EditPricingSnapshotDialogProps) {
  const { notify } = useNotifications()
  const [name, setName] = useState(initialName ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
  const [saving, setSaving] = useState(false)

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
        `${API_BASE}/api/v1/pricing-calculation-snapshots/${snapshotId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim() || null,
            description: description.trim() || null,
          }),
        },
      )
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: '保存失败' }))
        throw new Error(error.detail || '保存失败')
      }
      notify({ type: 'success', title: '已更新' })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5" />
            编辑定价快照
          </DialogTitle>
          <DialogDescription>仅管理员可修改快照名称或备注。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">快照名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：月末调价 v2"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">备注</label>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
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
