import { Pool } from 'pg'

function buildConnectionStringFromParts(): string | null {
  const host = process.env.SUPABASE_DB_HOST
  const port = process.env.SUPABASE_DB_PORT ?? '5432'
  const database = process.env.SUPABASE_DB_NAME ?? 'postgres'
  const user = process.env.SUPABASE_DB_USER ?? 'postgres'
  const password = process.env.SUPABASE_DB_PASSWORD

  if (!host || !password) {
    return null
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

function getDatabaseUrl(): string {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || buildConnectionStringFromParts()
  if (!url) {
    throw new Error(
      'Missing DB connection. Set SUPABASE_DB_URL / DATABASE_URL or SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD.'
    )
  }
  return url
}

declare global {
  // eslint-disable-next-line no-var
  var __believeboy_pg_pool: Pool | undefined
}

export function getDbPool(): Pool {
  if (!global.__believeboy_pg_pool) {
    const connectionString = getDatabaseUrl()
    const useSsl = connectionString.includes('supabase.co') || connectionString.includes('sslmode=require')

    global.__believeboy_pg_pool = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    })
  }

  return global.__believeboy_pg_pool
}
