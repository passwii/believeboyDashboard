'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Loader2, KeyRound, Copy, Check } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import {
  AgentApiKeyItem,
  createAgentApiKey,
  listAgentApiKeys,
  revokeAgentApiKey,
} from '@/lib/api/agent-key-admin'
import { AgentUsageGuide, buildUsageText } from './agent-usage-guide'

type CreatedResult = {
  plaintext_key: string
  agent_id: string
  label: string
}

export function AgentManagementClient() {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [keys, setKeys] = useState<AgentApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [agentId, setAgentId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [usageCopied, setUsageCopied] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await listAgentApiKeys())
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `加载失败：${error.message}` : '加载失败',
      })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!label.trim() || !agentId.trim()) return
    setSubmitting(true)
    try {
      const result = await createAgentApiKey({
        label: label.trim(),
        agent_id: agentId.trim(),
        expires_at: null,
      })
      setCreated({
        plaintext_key: result.plaintext_key,
        agent_id: result.agent_id ?? agentId.trim(),
        label: result.label,
      })
      setLabel('')
      setAgentId('')
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `创建失败：${error.message}` : '创建失败',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevoke = async (item: AgentApiKeyItem) => {
    const ok = await confirm({
      title: `吊销凭据「${item.label}」？`,
      description: '吊销后使用该凭据的 Agent 将立即无法访问，且不可恢复。',
      confirmText: '吊销',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await revokeAgentApiKey(item.id)
      notify({ type: 'success', title: `已吊销：${item.label}` })
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `吊销失败：${error.message}` : '吊销失败',
      })
    }
  }

  const copyPlaintext = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.plaintext_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyUsage = async () => {
    if (!created) return
    await navigator.clipboard.writeText(
      buildUsageText({
        plaintextKey: created.plaintext_key,
        agentId: created.agent_id,
      })
    )
    setUsageCopied(true)
    setTimeout(() => setUsageCopied(false), 2000)
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Agent 凭据管理
        </h1>
        <Button onClick={() => setCreateOpen(true)}>创建凭据</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>凭据列表</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">名称</th>
                  <th className="py-2 pr-4 font-medium">Key 前缀</th>
                  <th className="py-2 pr-4 font-medium">Agent ID</th>
                  <th className="py-2 pr-4 font-medium">最近使用</th>
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{item.label}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {item.key_prefix}…
                    </td>
                    <td className="py-2 pr-4">
                      {item.agent_id ? (
                        <span className="font-mono text-xs">{item.agent_id}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          —（存量 external key）
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {item.last_used_at
                        ? new Date(item.last_used_at).toLocaleString()
                        : '从未使用'}
                    </td>
                    <td className="py-2 pr-4">
                      {item.is_revoked ? (
                        <Badge variant="secondary">已吊销</Badge>
                      ) : (
                        <Badge variant="default">可用</Badge>
                      )}
                    </td>
                    <td className="py-2">
                      {!item.is_revoked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => handleRevoke(item)}
                        >
                          吊销
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      暂无凭据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AgentUsageGuide />

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setCreated(null)
            setLabel('')
            setAgentId('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {created ? '凭据创建成功' : '创建 Agent 凭据'}
            </DialogTitle>
          </DialogHeader>
          {created ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-muted-foreground mb-1">明文 Key</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs">
                    {created.plaintext_key}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyPlaintext}>
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Agent ID</div>
                <code className="rounded bg-muted p-1 font-mono text-xs">
                  {created.agent_id}
                </code>
              </div>
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                ⚠ 明文仅展示一次，请妥善保存。调用时 Authorization 用明文 Key，
                X-Agent-Id 用 Agent ID。
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={copyUsage}>
                  {usageCopied ? (
                    <Check className="mr-1 h-4 w-4" />
                  ) : (
                    <Copy className="mr-1 h-4 w-4" />
                  )}
                  {usageCopied ? '已复制调用说明' : '复制调用说明'}
                </Button>
                <Button onClick={() => setCreateOpen(false)}>关闭</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="agent-key-label" className="text-sm font-medium">
                  名称
                </label>
                <input
                  id="agent-key-label"
                  className="mt-1 w-full rounded border bg-background p-2 text-sm"
                  placeholder="如：货件助理 (生产)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="agent-key-agent-id" className="text-sm font-medium">
                  Agent ID
                </label>
                <input
                  id="agent-key-agent-id"
                  className="mt-1 w-full rounded border bg-background p-2 text-sm font-mono"
                  placeholder="如：shipment-assistant-prod"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={submitting || !label.trim() || !agentId.trim()}
                >
                  {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  创建
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
