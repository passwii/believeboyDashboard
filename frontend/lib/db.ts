import { getDbPool } from "@/lib/server/db"

export interface ExchangeRate {
  id?: number
  currency: string
  currency_name?: string | null
  year_month: string
  rate: number
  description?: string | null
  created_at?: string
  updated_at?: string
}

export interface ExchangeRateFilters {
  currency?: string
  year?: string
  month?: string
  year_month?: string
}

export interface ExchangeRatePagination {
  page: number
  pageSize: number
}

interface ExchangeRateListResult {
  data: ExchangeRate[]
  total: number
}

let initPromise: Promise<void> | null = null

function normalizeYearMonth(value: string): string {
  const m = /^(\d{4})-(\d{1,2})$/.exec(value)
  if (!m) {
    throw new Error("Invalid year_month format; expected YYYY-MM")
  }
  const year = m[1]
  const month = Number(m[2])
  if (month < 1 || month > 12) {
    throw new Error("Invalid month value")
  }
  return `${year}-${String(month).padStart(2, "0")}`
}

function composeYearMonth(year?: string | number, month?: string | number): string {
  const y = Number(year)
  const m = Number(month)
  if (!Number.isInteger(y) || y < 1900 || y > 9999) {
    throw new Error("Invalid year value")
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error("Invalid month value")
  }
  return `${y}-${String(m).padStart(2, "0")}`
}

async function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      const pool = getDbPool()
      await pool.query(`
        CREATE TABLE IF NOT EXISTS exchange_rates (
          id BIGSERIAL PRIMARY KEY,
          currency TEXT NOT NULL,
          currency_name TEXT,
          year_month TEXT NOT NULL,
          rate NUMERIC(18, 8) NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await pool.query(`ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS currency_name TEXT`)
      await pool.query(`ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS description TEXT`)
      await pool.query(`ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
      await pool.query(`ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rates_currency_month_unique
        ON exchange_rates (currency, year_month)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_exchange_rates_month_currency
        ON exchange_rates (year_month DESC, currency ASC)
      `)
    })().catch((error) => {
      initPromise = null
      throw error
    })
  }

  await initPromise
}

function rowToExchangeRate(row: any): ExchangeRate {
  return {
    id: Number(row.id),
    currency: row.currency,
    currency_name: row.currency_name,
    year_month: row.year_month,
    rate: Number(row.rate),
    description: row.description,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  }
}

export const exchangeRateDb = {
  async getAll(
    filters?: ExchangeRateFilters,
    pagination?: ExchangeRatePagination
  ): Promise<ExchangeRateListResult> {
    await ensureInitialized()

    const pool = getDbPool()
    const clauses: string[] = []
    const values: Array<string | number> = []

    if (filters?.currency) {
      values.push(filters.currency)
      clauses.push(`currency = $${values.length}`)
    }

    const yearMonth =
      filters?.year_month ||
      (filters?.year && filters?.month ? composeYearMonth(filters.year, filters.month) : undefined)

    if (yearMonth) {
      values.push(normalizeYearMonth(yearMonth))
      clauses.push(`year_month = $${values.length}`)
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const countQuery = `SELECT COUNT(*)::int AS total FROM exchange_rates ${whereSql}`
    const countResult = await pool.query(countQuery, values)
    const total = countResult.rows[0]?.total ?? 0

    let listQuery = `
      SELECT id, currency, currency_name, year_month, rate, description, created_at, updated_at
      FROM exchange_rates
      ${whereSql}
      ORDER BY year_month DESC, currency ASC
    `

    const listValues = [...values]
    if (pagination) {
      const page = Math.max(1, pagination.page)
      const pageSize = Math.max(1, Math.min(200, pagination.pageSize))
      const offset = (page - 1) * pageSize

      listValues.push(pageSize)
      listValues.push(offset)
      listQuery += ` LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`
    }

    const listResult = await pool.query(listQuery, listValues)
    return {
      data: listResult.rows.map(rowToExchangeRate),
      total,
    }
  },

  async getById(id: number): Promise<ExchangeRate | null> {
    await ensureInitialized()

    const pool = getDbPool()
    const result = await pool.query(
      `SELECT id, currency, currency_name, year_month, rate, description, created_at, updated_at
       FROM exchange_rates
       WHERE id = $1`,
      [id]
    )
    return result.rowCount ? rowToExchangeRate(result.rows[0]) : null
  },

  async getByCurrencyAndMonth(currency: string, year_month: string): Promise<ExchangeRate | null> {
    await ensureInitialized()

    const pool = getDbPool()
    const result = await pool.query(
      `SELECT id, currency, currency_name, year_month, rate, description, created_at, updated_at
       FROM exchange_rates
       WHERE currency = $1 AND year_month = $2`,
      [currency, normalizeYearMonth(year_month)]
    )
    return result.rowCount ? rowToExchangeRate(result.rows[0]) : null
  },

  async create(data: {
    currency: string
    currency_name?: string | null
    year_month?: string
    year?: string | number
    month?: string | number
    rate: number
    description?: string | null
  }): Promise<ExchangeRate> {
    await ensureInitialized()

    const yearMonth = data.year_month
      ? normalizeYearMonth(data.year_month)
      : composeYearMonth(data.year, data.month)

    const pool = getDbPool()
    const result = await pool.query(
      `
        INSERT INTO exchange_rates (currency, currency_name, year_month, rate, description, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id, currency, currency_name, year_month, rate, description, created_at, updated_at
      `,
      [data.currency, data.currency_name ?? null, yearMonth, data.rate, data.description ?? null]
    )

    return rowToExchangeRate(result.rows[0])
  },

  async update(
    id: number,
    data: Partial<{
      currency: string
      currency_name: string | null
      year_month: string
      year: string | number
      month: string | number
      rate: number
      description: string | null
    }>
  ): Promise<ExchangeRate | null> {
    const current = await this.getById(id)
    if (!current) return null

    const yearMonth =
      data.year_month !== undefined
        ? normalizeYearMonth(data.year_month)
        : data.year !== undefined || data.month !== undefined
          ? composeYearMonth(data.year ?? current.year_month.slice(0, 4), data.month ?? current.year_month.slice(5, 7))
          : current.year_month

    const pool = getDbPool()
    const result = await pool.query(
      `
        UPDATE exchange_rates
        SET
          currency = $1,
          currency_name = $2,
          year_month = $3,
          rate = $4,
          description = $5,
          updated_at = NOW()
        WHERE id = $6
        RETURNING id, currency, currency_name, year_month, rate, description, created_at, updated_at
      `,
      [
        data.currency ?? current.currency,
        data.currency_name !== undefined ? data.currency_name : current.currency_name ?? null,
        yearMonth,
        data.rate ?? current.rate,
        data.description !== undefined ? data.description : current.description ?? null,
        id,
      ]
    )

    return result.rowCount ? rowToExchangeRate(result.rows[0]) : null
  },

  async delete(id: number): Promise<boolean> {
    await ensureInitialized()

    const pool = getDbPool()
    const result = await pool.query("DELETE FROM exchange_rates WHERE id = $1", [id])
    return (result.rowCount ?? 0) > 0
  },
}
