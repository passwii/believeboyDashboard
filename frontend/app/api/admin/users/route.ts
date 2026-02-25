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

export async function GET() {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const pool = getDbPool()
  const result = await pool.query<UserRow>(
    `
    select
      id::text as id,
      name,
      email,
      is_admin,
      is_active,
      created_at,
      updated_at
    from public.user_accounts
    order by created_at desc
    `
  )

  return NextResponse.json({
    items: result.rows.map((row: UserRow) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      isAdmin: row.is_admin,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  })
}

export async function POST(request: Request) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as {
    name?: string
    email?: string
    password?: string
    isAdmin?: boolean
  }

  const name = body.name?.trim() ?? ''
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''
  const isAdmin = Boolean(body.isAdmin)

  if (!name || !email || !password) {
    return NextResponse.json({ message: '缺少必要字段' }, { status: 400 })
  }

  if (password.length < 8) {
    return NextResponse.json({ message: '密码长度至少 8 位' }, { status: 400 })
  }

  const pool = getDbPool()

  try {
    const result = await pool.query<UserRow>(
      `
      insert into public.user_accounts (name, email, password_hash, is_admin, is_active)
      values ($1, $2, crypt($3, gen_salt('bf', 12)), $4, true)
      returning
        id::text as id,
        name,
        email,
        is_admin,
        is_active,
        created_at,
        updated_at
      `,
      [name, email, password, isAdmin]
    )

    const row = result.rows[0]
    return NextResponse.json(
      {
        item: {
          id: row.id,
          name: row.name,
          email: row.email,
          isAdmin: row.is_admin,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      return NextResponse.json({ message: '邮箱已存在' }, { status: 409 })
    }
    return NextResponse.json({ message: '创建用户失败' }, { status: 500 })
  }
}
