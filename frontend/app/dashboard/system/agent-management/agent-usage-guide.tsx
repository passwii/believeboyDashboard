'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BookOpen, Check, Copy } from 'lucide-react'
import { AGENT_DOMAINS, liveAgentDomains } from '@/lib/agent-domains'

/** 取后端公共地址（未配置或失败时返回空串，调用方回退占位符）。 */
export async function fetchBackendBaseUrl(): Promise<string> {
  try {
    const res = await fetch('/api/backend-base', { cache: 'no-store' })
    if (!res.ok) return ''
    const payload = (await res.json()) as { base_url?: string }
    return payload.base_url || ''
  } catch {
    return ''
  }
}

/** 货件域调用说明（原默认，保持兼容）。 */
function buildShipmentsGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 读取货件列表】

  curl "${apiBase}/api/v1/agent/projects/{project_id}/shipments?page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【3. 写操作（两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "${apiBase}/api/v1/agent/projects/{project_id}/shipments" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"shipment_no":"SH-XXX","country":"US","shipping_method":"sea","shipment_status":"draft","items":[{"sku":"X-001","quantity":100}]}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

【4. 删除货件（两步确认，不可逆）】

  第一步（预览，返回 confirm_token）：
  curl -X DELETE "${apiBase}/api/v1/agent/projects/{project_id}/shipments/{shipment_no}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>"

  第二步（向用户确认后重放；DELETE 无请求体，重放保持同样不带 body）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"`
}

/** 店铺测算域调用说明。 */
function buildShopCalculationsGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 读取测算列表】

  curl "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations?page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【3. 查询单个 SKU 测算详情（多国站点需带 ?country=）】

  curl "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【4. 查看 SKU 测算历史与审计】

  curl "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}/history" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  curl "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}/audit" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【5. 试算（不落库，纯计算）】

  curl -X POST "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations/compute" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","country":"US","accounting_type":"profit_calc","sale_price_usd":19.99}'

【6. 追加写（两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "${apiBase}/api/v1/agent/projects/{project_id}/shop-calculations" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","country":"US","source":"agent_listing_pull","sale_price_usd":19.99,"profit_usd":4.8}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"`
}

/** 规划中/未知域的通用占位说明。 */
function buildPlaceholderGuide(opts: { key?: string; agentId?: string; apiBase: string }): string {
  const { key, agentId, apiBase } = opts
  return `【该业务域尚未接入 Agent API】

  当前仅可调用存活探针：
  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  业务域接入后，调用示例会自动生成。`
}

/**
 * 生成给 Agent 的调用说明文本（按业务域）。
 * ``domain`` 缺省为 shipments（保持旧签名兼容）。
 */
export function buildUsageText(opts?: {
  plaintextKey?: string
  agentId?: string
  baseUrl?: string
  domain?: string
}) {
  const key = opts?.plaintextKey ?? '<明文 Key>'
  const agentId = opts?.agentId ?? '<Agent ID>'
  const apiBase = (opts?.baseUrl || '').replace(/\/+$/, '') || '<后端地址>'
  const domain = opts?.domain ?? 'shipments'

  const authHeader = `【鉴权头】每次请求都必须携带（两个都缺一不可）：

  Authorization: Bearer ${key}
  X-Agent-Id: ${agentId}`

  let domainGuide: string
  if (domain === 'shipments') {
    domainGuide = buildShipmentsGuide({ key, agentId, apiBase })
  } else if (domain === 'shop_calculations') {
    domainGuide = buildShopCalculationsGuide({ key, agentId, apiBase })
  } else {
    domainGuide = buildPlaceholderGuide({ key, agentId, apiBase })
  }

  return `Agent API 调用说明（${AGENT_DOMAINS.find((d) => d.code === domain)?.label ?? domain}）
=====================

${authHeader}

${domainGuide}

【注意事项】
- 明文 Key 只在创建时展示一次，请妥善保存；库中只存 SHA-256
- 吊销后该凭据立即失效，Agent 需换新卡
- 写操作涉及费用/不可逆状态变更，确认流是强制安全门
- 限流：读 300 次/分钟，写 30 次/分钟（按 Agent ID 计）`
}

export function AgentUsageGuide() {
  const [copied, setCopied] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [domain, setDomain] = useState('shipments')

  useEffect(() => {
    let cancelled = false
    void fetchBackendBaseUrl().then((url) => {
      if (!cancelled) setBaseUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const domainLabel = useMemo(
    () => AGENT_DOMAINS.find((d) => d.code === domain)?.label ?? domain,
    [domain]
  )

  const copyAll = async () => {
    await navigator.clipboard.writeText(buildUsageText({ baseUrl, domain }))
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
            每次请求都必须同时携带{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">Authorization</code>{' '}
            与 <code className="rounded bg-muted px-1 font-mono text-xs">X-Agent-Id</code>{' '}
            两个鉴权头。
            {baseUrl ? (
              <span className="mt-1 block">
                后端地址已自动填入：
                <code className="rounded bg-muted px-1 font-mono text-xs">{baseUrl}</code>
              </span>
            ) : (
              <span className="mt-1 block">
                （<code className="rounded bg-muted px-1 font-mono text-xs">&lt;后端地址&gt;</code>{' '}
                请替换为实际后端域名）
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="选择业务域" />
              </SelectTrigger>
              <SelectContent>
                {liveAgentDomains().map((d) => (
                  <SelectItem key={d.code} value={d.code}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={copyAll}>
              {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
              {copied ? '已复制' : '复制说明'}
            </Button>
          </div>
        </div>
        <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs leading-relaxed">
          {buildUsageText({ baseUrl, domain })}
        </pre>
      </CardContent>
    </Card>
  )
}
