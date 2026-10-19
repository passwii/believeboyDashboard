/**
 * 店铺选项加载（阶段 C，BLF-1377）。
 *
 * 外部竞品关联店铺用的是 `project_shops.id`（ProjectShop 主键），而前端没有
 * 「全站店铺」聚合接口——只有 `GET /projects/{id}/shops`。这里按可见项目聚合：
 *  1. `fetchManagedProjectsCached`（2min 客户端缓存）拿可见项目；
 *  2. 并发拉每个项目的店铺（结果模块内缓存 2min，避免每次开面板都打一遍）。
 *
 * 关联选择器只需要「能关联哪些店铺」，不需要逐店实时状态，因此缓存可接受；
 * 页面写操作后会 `invalidateShopOptionsCache()` 让下次打开重新取。
 */
import type { Session } from 'next-auth'

import { getClientCache, setClientCache, clearClientCacheByPrefix } from '@/lib/client-cache'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

const CACHE_PREFIX = 'review-tracking:shop-options:'
const TTL_MS = 2 * 60 * 1000

export interface ShopOption {
  /** `project_shops.id` —— 关联接口要的 shop_id */
  id: number
  /** KJVS 店铺 id（展示用） */
  shopId: string
  shopName: string | null
  country: string
  projectId: number
  projectName: string
}

interface ManagedProject {
  id?: number | null
  name: string
}

interface ProjectShopDto {
  id: number
  country: string
  shop_id: string
  shop_name: string | null
}

export function invalidateShopOptionsCache(): void {
  clearClientCacheByPrefix(CACHE_PREFIX)
}

export async function fetchShopOptions(session?: Session | null): Promise<ShopOption[]> {
  const key = `${CACHE_PREFIX}${session?.user?.id ?? 'anonymous'}`
  const cached = getClientCache<ShopOption[]>(key, TTL_MS)
  if (cached) return cached

  const projects = await fetchManagedProjectsCached<ManagedProject[]>(session)
  const visible = projects.filter(
    (project): project is ManagedProject & { id: number } =>
      typeof project.id === 'number' && project.id > 0
  )

  const results = await Promise.allSettled(
    visible.map(async (project) => {
      const response = await fetch(`/api/backend/api/v1/projects/${project.id}/shops`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`项目 ${project.name} 的店铺列表加载失败`)
      const shops = (await response.json()) as ProjectShopDto[]
      return shops.map<ShopOption>((shop) => ({
        id: shop.id,
        shopId: shop.shop_id,
        shopName: shop.shop_name,
        country: shop.country,
        projectId: project.id,
        projectName: project.name,
      }))
    })
  )

  // 单个项目失败不影响其它项目可选——外部竞品关联不该被某个项目的权限问题卡死。
  const options = results
    .filter((result): result is PromiseFulfilledResult<ShopOption[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value)

  setClientCache(key, options)
  return options
}

/** 店铺下拉展示文本：`项目 / 店铺名 (id) · 站点`。 */
export function formatShopOption(option: ShopOption): string {
  const name = option.shopName?.trim() || option.shopId
  return `${option.projectName} / ${name} · ${option.country}`
}
