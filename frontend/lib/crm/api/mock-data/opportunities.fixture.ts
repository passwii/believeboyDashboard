import type { Opportunity } from '@/lib/crm/types'
import { generateCustomers, generateOpportunities, generateUsers } from './_generator'

const USERS = generateUsers(10)
const CUSTOMERS = generateCustomers(100, 2002, USERS)
export const OPPORTUNITIES_FIXTURE: Opportunity[] = generateOpportunities(
  20,
  4004,
  USERS,
  CUSTOMERS
)
