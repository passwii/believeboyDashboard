import type { Lead } from '@/lib/crm/types'
import { generateCustomers, generateLeads, generateUsers } from './_generator'

const USERS = generateUsers(10)
const CUSTOMERS = generateCustomers(100, 2002, USERS)
export const LEADS_FIXTURE: Lead[] = generateLeads(50, 3003, USERS, CUSTOMERS)