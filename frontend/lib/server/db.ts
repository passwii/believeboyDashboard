import { Pool } from 'pg'

function buildConnectionStringFromParts(): string | null {
  const host = process.env.PGHOST || process.env.SUPABASE_DB_HOST
  const port = process.env.PGPORT || process.env.SUPABASE_DB_PORT || '5432'
  const database = process.env.PGDATABASE || process.env.SUPABASE_DB_NAME || 'postgres'
  const user = process.env.PGUSER || process.env.SUPABASE_DB_USER || 'postgres'
  const password = process.env.PGPASSWORD || process.env.SUPABASE_DB_PASSWORD

  if (!host || !password) {
    return null
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

function getDatabaseUrl(): string {
  const url =
    process.env.DATABASE_URL ||
    process.env.PG_DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    buildConnectionStringFromParts()
  if (!url) {
    throw new Error(
      'Missing DB connection. Set DATABASE_URL (or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD).'
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
    const lower = connectionString.toLowerCase()
    const useSsl = lower.includes('supabase.co') || lower.includes('sslmode=require')

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
