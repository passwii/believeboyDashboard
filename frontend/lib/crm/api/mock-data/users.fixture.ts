import type { User } from '@/lib/crm/types'
import { generateUsers } from './_generator'

export const USERS_FIXTURE: User[] = generateUsers(10)
