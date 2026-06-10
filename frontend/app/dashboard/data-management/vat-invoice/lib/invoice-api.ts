// VAT 发票 — API 客户端
// 所有请求走 Next.js 代理（/api/backend/[...path]/route.ts），自动带 session 与 X-API-Key。

import type { InvoiceSellerEntry, ProjectContext, ProjectOption } from "../types"

const BASE = "/api/backend/api/v1"

/** VAT 发票功能启用的店铺白名单（暂时只允许弥森） */
export const VAT_ENABLED_PROJECT_NAMES = ["弥森"] as const

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return (await res.json()) as T
}

/** 拉取店铺下拉列表（按当前 operator 过滤权限） */
export async function fetchProjectsManage(): Promise<ProjectOption[]> {
  const data = await jsonFetch<ProjectOption[] | { items: ProjectOption[] }>(
    `${BASE}/projects/manage`,
  )
  return Array.isArray(data) ? data : (data.items ?? [])
}

/** 拉取单个店铺的 context（包含 invoice_sellers） */
export async function fetchProjectContext(projectId: number): Promise<ProjectContext> {
  return jsonFetch<ProjectContext>(`${BASE}/projects/${projectId}/context`)
}

/**
 * 写入 invoice_sellers（merge patch）。
 * 合并而非覆盖：保留 context 中其他键。
 */
export async function patchInvoiceSellers(
  projectId: number,
  sellers: InvoiceSellerEntry[],
): Promise<ProjectContext> {
  return jsonFetch<ProjectContext>(`${BASE}/projects/${projectId}/context`, {
    method: "PATCH",
    body: JSON.stringify({
      project_context: { invoice_sellers: sellers },
    }),
  })
}

/**
 * 惰性迁移：若 project_context 存在 invoice_seller（单数）但不存在 invoice_sellers（复数），
 * 自动转换为数组并写回。
 */
export async function migrateSellersIfNeeded(
  ctx: ProjectContext,
): Promise<ProjectContext> {
  const pc = ctx.project_context
  if (!pc) return ctx
  // 已有复数字段且非空 → 跳过
  if (pc.invoice_sellers && pc.invoice_sellers.length > 0) return ctx
  // 旧字段存在且有内容 → 迁移
  if (pc.invoice_seller && pc.invoice_seller.company_name) {
    const migrated: InvoiceSellerEntry = {
      ...pc.invoice_seller,
      country: pc.invoice_seller.country || "",
    }
    const updated = await patchInvoiceSellers(ctx.project_id, [migrated])
    return updated
  }
  return ctx
}
