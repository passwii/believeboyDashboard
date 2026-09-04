'use client'

import { useState } from 'react'
import { Camera } from 'lucide-react'

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

interface CreatePricingSnapshotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number | null
  country: string
  onSuccess: (snapshotId: number) => void
}

export function CreatePricingSnapshotDialog({
  open,
  onOpenChange,
  projectId,
  country,
  onSuccess,
}: CreatePricingSnapshotDialogProps) {
  const { notify } = useNotifications()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  async function handleCreate() {
    if (!projectId) {
      notify({ type: 'error', title: '请先选择项目' })
      return
    }

    setCreating(true)
    try {
      const params = new URLSearchParams({
        project_id: String(projectId),
        country,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/pricing-calculation-snapshots?${params.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim() || null,
            description: description.trim() || null,
          }),
        }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: '创建失败' }))
        throw new Error(error.detail || '创建失败')
      }

      const result = (await response.json()) as { id: number }
      notify({ type: 'success', title: '快照已保存' })
      onSuccess(result.id)
      onOpenChange(false)
      setName('')
      setDescription('')
    } catch (e) {
      notify({
        type: 'error',
        title: '创建失败',
        message: e instanceof Error ? e.message : '未知错误',
      })
    } finally {
      setCreating(false)
    }
  }

  function handleClose() {
    if (!creating) {
      setName('')
      setDescription('')
      onOpenChange(false)
    }
  }

  const countryLabel = country === 'US' ? '美国' : country === 'DE' ? '德国' : '英国'

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            保存为定价快照
          </DialogTitle>
          <DialogDescription>
            将 {countryLabel}站当前所有 SKU 的核算结果保存为快照，方便后续回放和对比。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">快照名称（可选）</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：月末调价 v2"
              disabled={creating}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">备注（可选）</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="记录快照的用途或重要说明..."
              rows={3}
              disabled={creating}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            取消
          </Button>
          <Button onClick={() => void handleCreate()} disabled={creating}>
            {creating ? '保存中...' : '保存快照'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
