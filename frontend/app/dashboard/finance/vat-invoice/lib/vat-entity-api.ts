// VAT 主体（vat_entities）API 客户端
import type { VatEntity } from '../types'

const BASE = '/api/backend/api/v1'

export type VatEntityUpsertInput = Omit<
  VatEntity,
  'id' | 'created_at' | 'updated_at'
>

export type VatEntityPatch = Partial<
  Pick<VatEntity, 'company_name' | 'vat_id' | 'address_line' | 'postal_code' | 'city' | 'email' | 'is_default'>
>

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

/** 列出某店铺的所有 VAT 主体（按 country 排序） */
export async function fetchEntities(projectId: number): Promise<VatEntity[]> {
  const res = await fetch(
    `${BASE}/vat-entities?project_id=${projectId}`,
    { headers: { 'Content-Type': 'application/json' } },
  )
  return (await jsonOrThrow(res)) as VatEntity[]
}

/** 新增或在 (project, country) 已存在时覆盖 */
export async function upsertEntity(input: VatEntityUpsertInput): Promise<VatEntity> {
  const res = await fetch(`${BASE}/vat-entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await jsonOrThrow(res)) as VatEntity
}

/** 部分字段更新 */
export async function updateEntity(id: number, patch: VatEntityPatch): Promise<VatEntity> {
  const res = await fetch(`${BASE}/vat-entities/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return (await jsonOrThrow(res)) as VatEntity
}

/** 删除 */
export async function deleteEntity(id: number): Promise<void> {
  const res = await fetch(`${BASE}/vat-entities/${id}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
}
