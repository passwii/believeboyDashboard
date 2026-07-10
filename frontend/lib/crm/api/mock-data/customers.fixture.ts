import type { Customer } from '@/lib/crm/types'
import { generateCustomers, generateUsers } from './_generator'

const USERS = generateUsers(10)
export const CUSTOMERS_FIXTURE: Customer[] = generateCustomers(100, 2002, USERS)