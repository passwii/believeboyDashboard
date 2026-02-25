import { NextResponse } from 'next/server'

import { requireAdminSession } from '@/lib/auth/server'
import { getDbPool } from '@/lib/server/db'

type UserRow = {
  id: string
  name: string
  email: string
  is_admin: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as {
    name?: string
    isAdmin?: boolean
    isActive?: boolean
    password?: string
  }

  const name = typeof body.name === 'string' ? body.name.trim() : null
  const isAdmin = typeof body.isAdmin === 'boolean' ? body.isAdmin : null
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : null
  const password = typeof body.password === 'string' && body.password ? body.password : null

  if (password && password.length < 8) {
    return NextResponse.json({ message: '密码长度至少 8 位' }, { status: 400 })
  }

  if (params.id === session.user.id && (isAdmin === false || isActive === false)) {
    return NextResponse.json({ message: '不能禁用或降级当前登录管理员' }, { status: 400 })
  }

  const pool = getDbPool()
  const result = await pool.query<UserRow>(
    `
    update public.user_accounts
    set
      name = coalesce($2, name),
      is_admin = coalesce($3, is_admin),
      is_active = coalesce($4, is_active),
      password_hash = case
        when $5 is null then password_hash
        else crypt($5, gen_salt('bf', 12))
      end,
      updated_at = now()
    where id::text = $1
    returning
      id::text as id,
      name,
      email,
      is_admin,
      is_active,
      created_at,
      updated_at
    `,
    [params.id, name, isAdmin, isActive, password]
  )

  if (!result.rowCount) {
    return NextResponse.json({ message: '用户不存在' }, { status: 404 })
  }

  const row = result.rows[0]
  return NextResponse.json({
    item: {
      id: row.id,
      name: row.name,
      email: row.email,
      isAdmin: row.is_admin,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  })
}
