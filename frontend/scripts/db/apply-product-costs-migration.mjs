import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Client } = pg

function buildConnectionStringFromParts() {
  const host = process.env.PGHOST || process.env.SUPABASE_DB_HOST
  const port = process.env.PGPORT || process.env.SUPABASE_DB_PORT || "5432"
  const database = process.env.PGDATABASE || process.env.SUPABASE_DB_NAME || "postgres"
  const user = process.env.PGUSER || process.env.SUPABASE_DB_USER || "postgres"
  const password = process.env.PGPASSWORD || process.env.SUPABASE_DB_PASSWORD

  if (!host || !password) {
    return null
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.PG_DATABASE_URL || process.env.SUPABASE_DB_URL || buildConnectionStringFromParts()
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const migrationPath = path.resolve(
    __dirname,
    "../../supabase/migrations/20260224_001_create_product_costs.sql"
  )
  const sql = await fs.readFile(migrationPath, "utf8")

  const connectionString = getConnectionString()
  if (!connectionString) {
    throw new Error(
      "Missing DB connection. Set DATABASE_URL (or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD)."
    )
  }

  const lower = connectionString.toLowerCase()
  const useSsl = lower.includes("supabase.co") || lower.includes("sslmode=require")

  const client = new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  })

  await client.connect()
  try {
    await client.query("begin")
    await client.query(sql)
    await client.query("commit")
    console.log("Migration applied:", migrationPath)
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error("Failed to apply migration:", error.message)
  process.exit(1)
})
