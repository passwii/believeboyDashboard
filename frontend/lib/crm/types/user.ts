export interface User {
  id: string
  name: string
  email: string
  avatarUrl?: string
  roleType: 'admin' | 'businessdev' | 'operator'
  isActive: boolean
}
