/** 联系人（一个客户多个联系人，isPrimary 标记主联系人，后端保证唯一）。 */
export interface Contact {
  id: string
  customerId: string
  name: string
  phone?: string
  email?: string
  wechat?: string
  /** 职务 */
  title?: string
  isPrimary: boolean
  remark?: string
  createdAt: string
  updatedAt: string
}

export interface ContactInput {
  name: string
  phone?: string
  email?: string
  wechat?: string
  title?: string
  isPrimary?: boolean
  remark?: string
}
