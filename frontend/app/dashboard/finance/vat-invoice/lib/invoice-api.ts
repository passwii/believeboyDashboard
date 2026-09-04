// VAT 发票 — 通用 API 客户端
// 所有请求走 Next.js 代理（/api/backend/[...path]/route.ts），自动带 session 与 X-API-Key。

import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

import type { ProjectOption } from '../types'

/** 拉取店铺下拉列表（按当前 operator 过滤权限，含 vat_enabled） */
export async function fetchProjectsManage(): Promise<ProjectOption[]> {
  // BEL-424：复用 projects/manage 2min 客户端缓存（带在途去重）——
  // SellerCard 与历史面板同页 mount 冷启动只打一次后端，2min 内复访 0 请求。
  const data = await fetchManagedProjectsCached<ProjectOption[] | { items: ProjectOption[] }>()
  return Array.isArray(data) ? data : (data.items ?? [])
}
