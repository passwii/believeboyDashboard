import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Client } = pg
const DEFAULT_BATCH_SIZE = 500

function parseCsvLine(line) {
  const result = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === "," && !inQuotes) {
      result.push(current)
      current = ""
      continue
    }

    current += char
  }

  result.push(current)
  return result
}

function parseCsv(content) {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    return []
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim())

  return lines.slice(1).map((line) => {
    const columns = parseCsvLine(line)
    const row = {}
    headers.forEach((header, index) => {
      row[header] = (columns[index] ?? "").trim()
    })
    return row
  })
}

function parseCost(rawValue) {
  if (rawValue === "") {
    return 0
  }

  const value = Number(rawValue)
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid cost value: "${rawValue}"`)
  }
  return value
}

function buildConnectionStringFromParts() {
  const host = process.env.SUPABASE_DB_HOST
  const port = process.env.SUPABASE_DB_PORT ?? "5432"
  const database = process.env.SUPABASE_DB_NAME ?? "postgres"
  const user = process.env.SUPABASE_DB_USER ?? "postgres"
  const password = process.env.SUPABASE_DB_PASSWORD

  if (!host || !password) {
    return null
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

function getConnectionString() {
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || buildConnectionStringFromParts()
}

function getCsvPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const fileArg = process.argv.find((arg) => arg.startsWith("--file="))
  const inputPath = fileArg ? fileArg.slice("--file=".length) : process.argv[2]

  if (inputPath) {
    return path.resolve(process.cwd(), inputPath)
  }

  return path.resolve(__dirname, "../../../Docs/ModelFiles/BLF_Basic_Info.csv")
}

async function upsertBatch(client, rows, sourceFileName) {
  const values = []
  const placeholders = rows.map((row, index) => {
    const base = index * 6
    values.push(
      row.projectName,
      row.sku,
      row.asin,
      row.firstLegUnitCost,
      row.fobUnitCost,
      sourceFileName
    )
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
  })

  const sql = `
    insert into public.product_costs (
      project_name,
      sku,
      asin,
      first_leg_unit_cost,
      fob_unit_cost,
      source_file
    ) values ${placeholders.join(",")}
    on conflict (project_name, sku, asin)
    do update set
      first_leg_unit_cost = excluded.first_leg_unit_cost,
      fob_unit_cost = excluded.fob_unit_cost,
      source_file = excluded.source_file,
      updated_at = now()
  `

  await client.query(sql, values)
}

async function main() {
  const csvPath = getCsvPath()
  const sourceFileName = path.basename(csvPath)
  const connectionString = getConnectionString()

  if (!connectionString) {
    throw new Error(
      "Missing DB connection. Set SUPABASE_DB_URL / DATABASE_URL or SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD."
    )
  }

  const content = await fs.readFile(csvPath, "utf8")
  const rows = parseCsv(content)
  const normalizedRows = rows
    .map((row) => ({
      projectName: (row.project_name ?? "").trim(),
      sku: (row.SKU ?? "").trim(),
      asin: (row.ASIN ?? "").trim(),
      firstLegUnitCost: parseCost((row.头程单价 ?? "").trim()),
      fobUnitCost: parseCost((row.FOB单价 ?? "").trim()),
    }))
    .filter((row) => row.projectName && row.sku && row.asin)

  if (normalizedRows.length === 0) {
    throw new Error(`No valid rows found in ${csvPath}`)
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  })

  await client.connect()
  try {
    await client.query("begin")
    for (let i = 0; i < normalizedRows.length; i += DEFAULT_BATCH_SIZE) {
      const batch = normalizedRows.slice(i, i + DEFAULT_BATCH_SIZE)
      await upsertBatch(client, batch, sourceFileName)
    }
    await client.query("commit")
    console.log(`Imported ${normalizedRows.length} rows from ${csvPath}`)
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error("Failed to import product costs:", error.message)
  process.exit(1)
})
