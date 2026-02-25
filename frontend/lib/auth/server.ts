import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth/options'

export async function getServerAuthSession() {
  return getServerSession(authOptions)
}

export async function requireAdminSession() {
  const session = await getServerAuthSession()
  if (!session?.user?.id || !session.user.isAdmin) {
    return null
  }
  return session
}
