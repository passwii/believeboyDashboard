// VAT 发票 — 通用 API 客户端
// 所有请求走 Next.js 代理（/api/backend/[...path]/route.ts），自动带 session 与 X-API-Key。

import type { ProjectOption } from '../types'

const BASE = '/api/backend/api/v1'

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return (await res.json()) as T
}

/** 拉取店铺下拉列表（按当前 operator 过滤权限，含 vat_enabled） */
export async function fetchProjectsManage(): Promise<ProjectOption[]> {
  const data = await jsonFetch<ProjectOption[] | { items: ProjectOption[] }>(
    `${BASE}/projects/manage`
  )
  return Array.isArray(data) ? data : (data.items ?? [])
}
