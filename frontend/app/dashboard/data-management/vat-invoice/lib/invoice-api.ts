// VAT 发票 — API 客户端
// 所有请求走 Next.js 代理（/api/backend/[...path]/route.ts），自动带 session 与 X-API-Key。

import type { InvoiceSeller, ProjectContext, ProjectOption } from "../types"

const BASE = "/api/backend/api/v1"

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

/** 拉取单个店铺的 context（包含 invoice_seller） */
export async function fetchProjectContext(projectId: number): Promise<ProjectContext> {
  return jsonFetch<ProjectContext>(`${BASE}/projects/${projectId}/context`)
}

/**
 * 写入 invoice_seller（merge patch）。
 * 合并而非覆盖：保留 context 中其他键。
 */
export async function patchInvoiceSeller(
  projectId: number,
  seller: InvoiceSeller,
): Promise<ProjectContext> {
  return jsonFetch<ProjectContext>(`${BASE}/projects/${projectId}/context`, {
    method: "PATCH",
    body: JSON.stringify({
      project_context: { invoice_seller: seller },
    }),
  })
}
