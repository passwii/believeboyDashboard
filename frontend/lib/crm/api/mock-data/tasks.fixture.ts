import type { Task } from '@/lib/crm/types'
import { CUSTOMERS_FIXTURE } from './customers.fixture'
import { LEADS_FIXTURE } from './leads.fixture'
import { USERS_FIXTURE } from './users.fixture'
import { generateTasks } from './_generator'

export const TASKS_FIXTURE: Task[] = generateTasks(24, 7007, USERS_FIXTURE, CUSTOMERS_FIXTURE, LEADS_FIXTURE)
