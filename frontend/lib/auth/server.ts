import { auth } from '@/lib/auth/options'

export async function getServerAuthSession() {
  return auth()
}

export async function requireUserSession() {
  const session = await getServerAuthSession()
  if (!session?.user?.id) {
    return null
  }
  return session
}

export async function requireAdminSession() {
  const session = await getServerAuthSession()
  if (!session?.user?.id || session.user.roleType !== 'admin') {
    return null
  }
  return session
}
