import type { CrmClient, ListParams, Paginated } from './crm-client'
import type {
  Customer,
  CustomerInput,
  Follow,
  FollowEntityType,
  FollowInput,
  Lead,
  LeadInput,
  User,
} from '@/lib/crm/types'
import {
  mapCustomer,
  mapFollow,
  mapLead,
  mapUser,
  toConvertPayload,
  toCustomerPayload,
  toFollowPayload,
  toLeadPayload,
  type CustomerDto,
  type FollowDto,
  type LeadDto,
  type UserDto,
} from './dto-mappers'

/**
 * 真实后端 CRM 客户端。
 *
 * 经 Next 代理 `/api/backend/v1/crm/...` 访问（代理注入 X-API-Key/X-User-Id 等
 * 鉴权头，见 app/api/backend/[...path]/route.ts），客户端只设 Content-Type。
 * 切换：`NEXT_PUBLIC_CRM_API_MODE=http`（见 crm-client-provider.tsx）。
 */
const BASE = '/api/backend/v1/crm'

interface ListResponseDto<TDto> {
  items: TDto[]
  total: number
  page: number
  page_size: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let message = `CRM 请求失败（${res.status}）`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') message = body.detail
      else if (body?.detail) message = JSON.stringify(body.detail)
      else if (typeof body?.message === 'string') message = body.message
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** ListParams → 后端 query string。filters（高级筛选）后端暂不支持，不入站。 */
function toQueryString(params: ListParams): string {
  const qs = new URLSearchParams()
  if (params.scope) qs.set('scope', params.scope)
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.page != null) qs.set('page', String(params.page))
  if (params.pageSize != null) qs.set('page_size', String(params.pageSize))
  if (params.sortBy) qs.set('sort_by', params.sortBy)
  if (params.sortOrder) qs.set('sort_order', params.sortOrder)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

function mapPage<TDto, T>(dto: ListResponseDto<TDto>, map: (d: TDto) => T): Paginated<T> {
  return { items: dto.items.map(map), total: dto.total, page: dto.page, pageSize: dto.page_size }
}

export class HttpCrmClient implements CrmClient {
  // ===== Customer =====
  async listCustomers(params: ListParams): Promise<Paginated<Customer>> {
    const dto = await request<ListResponseDto<CustomerDto>>(`/customers${toQueryString(params)}`)
    return mapPage(dto, mapCustomer)
  }
  async getCustomer(id: string): Promise<Customer> {
    return mapCustomer(await request<CustomerDto>(`/customers/${id}`))
  }
  async createCustomer(input: CustomerInput): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>('/customers', {
        method: 'POST',
        body: JSON.stringify(toCustomerPayload(input)),
      })
    )
  }
  async updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>(`/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toCustomerPayload(input)),
      })
    )
  }
  async deleteCustomer(id: string): Promise<void> {
    await request<void>(`/customers/${id}`, { method: 'DELETE' })
  }
  async batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void> {
    await request<void>('/customers/batch-transfer', {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(Number), to_owner_id: toOwnerId }),
    })
  }
  async batchMoveToSea(ids: string[]): Promise<void> {
    await request<void>('/customers/batch-move-sea', {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(Number) }),
    })
  }
  async claimFromSea(id: string): Promise<Customer> {
    return mapCustomer(await request<CustomerDto>(`/customers/${id}/claim`, { method: 'POST' }))
  }

  // ===== Lead =====
  async listLeads(params: ListParams): Promise<Paginated<Lead>> {
    const dto = await request<ListResponseDto<LeadDto>>(`/leads${toQueryString(params)}`)
    return mapPage(dto, mapLead)
  }
  async getLead(id: string): Promise<Lead> {
    return mapLead(await request<LeadDto>(`/leads/${id}`))
  }
  async createLead(input: LeadInput): Promise<Lead> {
    return mapLead(
      await request<LeadDto>('/leads', { method: 'POST', body: JSON.stringify(toLeadPayload(input)) })
    )
  }
  async updateLead(id: string, input: Partial<LeadInput>): Promise<Lead> {
    return mapLead(
      await request<LeadDto>(`/leads/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toLeadPayload(input)),
      })
    )
  }
  async convertLead(
    id: string,
    customerInput?: Partial<CustomerInput>
  ): Promise<{ lead: Lead; customer: Customer }> {
    const payload = toConvertPayload(customerInput)
    const dto = await request<{ lead: LeadDto; customer: CustomerDto }>(`/leads/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    })
    return { lead: mapLead(dto.lead), customer: mapCustomer(dto.customer) }
  }

  // ===== Follow =====
  async listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]> {
    const dtos = await request<FollowDto[]>(
      `/follows?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`
    )
    return dtos.map(mapFollow)
  }
  async createFollow(input: FollowInput): Promise<Follow> {
    return mapFollow(
      await request<FollowDto>('/follows', {
        method: 'POST',
        body: JSON.stringify(toFollowPayload(input)),
      })
    )
  }

  // ===== User =====
  async listUsers(): Promise<User[]> {
    return (await request<UserDto[]>('/users')).map(mapUser)
  }
  async getUser(id: string): Promise<User> {
    return mapUser(await request<UserDto>(`/users/${id}`))
  }
}
