import type { CrmClient } from './crm-client'

function notImplemented(method: string): never {
  throw new Error(`Not implemented: HTTP CRM client ships in V1.5 (${method})`)
}

/**
 * 真实后端 CRM 客户端占位实现。
 *
 * MVP 期间不使用；切换方法：将 `NEXT_PUBLIC_CRM_API_MODE=http`
 * （参见 `crm-client-provider.tsx`），并先跑 `pnpm gen:api-types` 生成新接口类型。
 */
export class HttpCrmClient implements Partial<CrmClient> {
  listCustomers = () => notImplemented('listCustomers')
  getCustomer = (id: string) => notImplemented(`getCustomer(${id})`)
  createCustomer = () => notImplemented('createCustomer')
  updateCustomer = (id: string) => notImplemented(`updateCustomer(${id})`)
  deleteCustomer = (id: string) => notImplemented(`deleteCustomer(${id})`)
  batchTransferCustomers = () => notImplemented('batchTransferCustomers')
  batchMoveToSea = () => notImplemented('batchMoveToSea')
  claimFromSea = (id: string) => notImplemented(`claimFromSea(${id})`)

  listLeads = () => notImplemented('listLeads')
  getLead = (id: string) => notImplemented(`getLead(${id})`)
  createLead = () => notImplemented('createLead')
  updateLead = (id: string) => notImplemented(`updateLead(${id})`)
  convertLead = (id: string) => notImplemented(`convertLead(${id})`)

  listOpportunities = () => notImplemented('listOpportunities')
  getOpportunity = (id: string) => notImplemented(`getOpportunity(${id})`)

  listFollows = () => notImplemented('listFollows')
  createFollow = () => notImplemented('createFollow')

  listUsers = () => notImplemented('listUsers')
  getUser = (id: string) => notImplemented(`getUser(${id})`)
}
