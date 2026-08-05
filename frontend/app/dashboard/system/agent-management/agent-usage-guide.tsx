'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BookOpen, Check, Copy } from 'lucide-react'

/** 生成给 Agent 的调用说明文本（含真实凭据时用于创建成功弹窗的一键复制）。 */
export function buildUsageText(opts?: { plaintextKey?: string; agentId?: string }) {
  const key = opts?.plaintextKey ?? '<明文 Key>'
  const agentId = opts?.agentId ?? '<Agent ID>'
  return `Agent API 调用说明
=====================

【鉴权头】每次请求都必须携带（两个都缺一不可）：

  Authorization: Bearer ${key}
  X-Agent-Id: ${agentId}

【1. 存活探针】

  curl http://<后端地址>/api/v1/agent/health \
    -H "Authorization: Bearer ${key}" \
    -H "X-Agent-Id: ${agentId}"

【2. 读取货件列表】

  curl "http://<后端地址>/api/v1/agent/projects/{project_id}/shipments?page_size=20" \
    -H "Authorization: Bearer ${key}" \
    -H "X-Agent-Id: ${agentId}"

【3. 写操作（两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "http://<后端地址>/api/v1/agent/projects/{project_id}/shipments" \
    -H "Authorization: Bearer ${key}" \
    -H "X-Agent-Id: ${agentId}" \
    -H "Idempotency-Key: <UUID>" \
    -H "Content-Type: application/json" \
    -d '{"shipment_no":"SH-XXX","country":"US","shipping_method":"sea","shipment_status":"draft","items":[{"sku":"X-001","quantity":100}]}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

【注意事项】
- 明文 Key 只在创建时展示一次，请妥善保存；库中只存 SHA-256
- 吊销后该凭据立即失效，Agent 需换新卡
- 写操作涉及费用/不可逆状态变更，确认流是强制安全门
- 限流：读 300 次/分钟，写 30 次/分钟（按 Agent ID 计）`
}

export function AgentUsageGuide() {
  const [copied, setCopied] = useState(false)

  const copyAll = async () => {
    await navigator.clipboard.writeText(buildUsageText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          如何告诉 Agent 调用
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            创建凭据后，把下面的说明复制给 Agent 作为调用配置。Agent
            每次请求都必须同时携带 <code className="rounded bg-muted px-1 font-mono text-xs">Authorization</code>{' '}
            与 <code className="rounded bg-muted px-1 font-mono text-xs">X-Agent-Id</code>{' '}
            两个鉴权头（<code className="rounded bg-muted px-1 font-mono text-xs">&lt;后端地址&gt;</code>{' '}
            替换为实际后端域名）。
          </p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={copyAll}>
            {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
            {copied ? '已复制' : '复制说明'}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs leading-relaxed">
          {buildUsageText()}
        </pre>
      </CardContent>
    </Card>
  )
}
