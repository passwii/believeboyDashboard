// 使用 Node.js 运行时（支持 SQLite）
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { requireAdminSession } from "@/lib/auth/server"
import { exchangeRateDb } from "@/lib/db"

function toClientModel(rate: any) {
  const [yearText, monthText] = String(rate.year_month ?? "").split("-")
  const year = Number(yearText)
  const month = Number(monthText)
  return {
    id: rate.id,
    currency: rate.currency,
    currencyName: rate.currency_name || rate.currency,
    year: Number.isFinite(year) ? year : null,
    month: Number.isFinite(month) ? month : null,
    year_month: rate.year_month,
    rate: Number(rate.rate),
    description: rate.description ?? null,
    createdAt: rate.created_at,
    updatedAt: rate.updated_at,
  }
}

// GET: Fetch a single exchange rate by ID
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const id = parseInt(params.id)
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
    }

    const rate = await exchangeRateDb.getById(id)
    if (!rate) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    return NextResponse.json({ data: toClientModel(rate) })
  } catch (error) {
    console.error("Error fetching exchange rate:", error)
    return NextResponse.json(
      { error: "Failed to fetch exchange rate" },
      { status: 500 }
    )
  }
}

// PUT: Update an exchange rate
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const id = parseInt(params.id)
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
    }

    const body = await request.json()
    const { currency, currencyName, year, month, year_month, rate, description } = body

    // Check if record exists
    const existing = await exchangeRateDb.getById(id)
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const normalizedYearMonth =
      year_month ||
      (year !== undefined || month !== undefined
        ? `${year ?? existing.year_month.slice(0, 4)}-${String(month ?? existing.year_month.slice(5, 7)).padStart(2, "0")}`
        : existing.year_month)

    // If changing currency or year_month, check for conflicts
    if (
      (currency && currency !== existing.currency) ||
      (normalizedYearMonth && normalizedYearMonth !== existing.year_month)
    ) {
      const newCurrency = currency || existing.currency
      const newYearMonth = normalizedYearMonth || existing.year_month
      
      const duplicate = await exchangeRateDb.getByCurrencyAndMonth(newCurrency, newYearMonth)
      if (duplicate && duplicate.id !== id) {
        return NextResponse.json(
          { error: "Exchange rate for this currency and month already exists" },
          { status: 409 }
        )
      }
    }

    const parsedRate = rate === undefined || rate === null || rate === "" ? undefined : Number(rate)
    if (parsedRate !== undefined && (Number.isNaN(parsedRate) || parsedRate <= 0)) {
      return NextResponse.json({ error: "Rate must be a positive number" }, { status: 400 })
    }

    const updated = await exchangeRateDb.update(id, {
      currency,
      currency_name: currencyName,
      year_month: normalizedYearMonth,
      rate: parsedRate,
      description,
    })

    if (!updated) {
      return NextResponse.json({ error: "Failed to update" }, { status: 500 })
    }

    return NextResponse.json({ data: toClientModel(updated) })
  } catch (error) {
    console.error("Error updating exchange rate:", error)
    return NextResponse.json(
      { error: "Failed to update exchange rate" },
      { status: 500 }
    )
  }
}

// DELETE: Delete an exchange rate
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const id = parseInt(params.id)
    if (isNaN(id)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
    }

    // Check if record exists
    const existing = await exchangeRateDb.getById(id)
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const deleted = await exchangeRateDb.delete(id)
    if (!deleted) {
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting exchange rate:", error)
    return NextResponse.json(
      { error: "Failed to delete exchange rate" },
      { status: 500 }
    )
  }
}
