export type ProfileRoleType = 'admin' | 'operator' | 'businessdev'

export interface Profile {
  id: string
  email: string
  name: string
  full_name: string | null
  operator_name_zh: string | null
  is_admin: boolean
  is_active: boolean
  role_type: ProfileRoleType
  avatar_url: string | null
  password_changed_at: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type ProfileUpdate = {
  name?: string
  full_name?: string | null
  operator_name_zh?: string | null
}
