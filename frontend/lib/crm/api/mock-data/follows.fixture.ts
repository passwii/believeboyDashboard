import type { Follow } from '@/lib/crm/types'
import {
  generateCustomers,
  generateFollows,
  generateLeads,
  generateOpportunities,
  generateUsers,
} from './_generator'

const USERS = generateUsers(10)
const CUSTOMERS = generateCustomers(100, 2002, USERS)
const LEADS = generateLeads(50, 3003, USERS, CUSTOMERS)
const OPPORTUNITIES = generateOpportunities(20, 4004, USERS, CUSTOMERS)
export const FOLLOWS_FIXTURE: Follow[] = generateFollows(
  200,
  5005,
  USERS,
  CUSTOMERS,
  LEADS,
  OPPORTUNITIES
)
