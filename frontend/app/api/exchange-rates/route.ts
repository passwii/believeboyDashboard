// 使用 Node.js 运行时（支持 SQLite）
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { requireAdminSession, requireUserSession } from "@/lib/auth/server"
import { exchangeRateDb, ExchangeRateFilters, ExchangeRateNoteImage } from "@/lib/db"

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
    noteImages: Array.isArray(rate.note_images) ? rate.note_images : [],
    createdAt: rate.created_at,
    updatedAt: rate.updated_at,
  }
}

function normalizeNoteImages(value: unknown): ExchangeRateNoteImage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      id: String(item.id || ""),
      url: String(item.url || ""),
      thumbnailUrl: item.thumbnailUrl ? String(item.thumbnailUrl) : undefined,
      filename: String(item.filename || ""),
      contentType: String(item.contentType || ""),
      size: Number(item.size || 0),
      uploadedAt: String(item.uploadedAt || ""),
    }))
    .filter((item) => item.id && item.url && item.filename)
}

// GET: Fetch all exchange rates with optional filtering
export async function GET(request: NextRequest) {
  try {
    const session = await requireUserSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const currency = searchParams.get("currency") || undefined
    const year = searchParams.get("year") || undefined
    const month = searchParams.get("month") || undefined
    const year_month = searchParams.get("year_month") || undefined
    const page = Math.max(1, Number(searchParams.get("page") || "1"))
    const pageSize = Math.max(1, Number(searchParams.get("pageSize") || "12"))

    const filters: ExchangeRateFilters = {}
    if (currency) filters.currency = currency
    if (year) filters.year = year
    if (month) filters.month = month
    if (year_month) filters.year_month = year_month

    const result = await exchangeRateDb.getAll(filters, { page, pageSize })
    const totalPages = Math.ceil(result.total / pageSize)
    return NextResponse.json({
      success: true,
      data: result.data.map(toClientModel),
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages,
      },
    })
  } catch (error) {
    console.error("Error fetching exchange rates:", error)
    return NextResponse.json(
      { success: false, error: "Failed to fetch exchange rates" },
      { status: 500 }
    )
  }
}

// POST: Create a new exchange rate
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { currency, currencyName, year, month, year_month, rate, description, noteImages } = body
    const parsedRate = Number(rate)

    // Validation
    if (!currency || (!year_month && (year === undefined || month === undefined)) || Number.isNaN(parsedRate)) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: currency, year/month (or year_month), rate" },
        { status: 400 }
      )
    }

    if (parsedRate <= 0) {
      return NextResponse.json(
        { success: false, error: "Rate must be a positive number" },
        { status: 400 }
      )
    }

    const normalizedYearMonth = year_month || `${year}-${String(month).padStart(2, "0")}`

    // Check for existing record
    const existing = await exchangeRateDb.getByCurrencyAndMonth(currency, normalizedYearMonth)
    if (existing) {
      return NextResponse.json(
        { success: false, error: "Exchange rate for this currency and month already exists" },
        { status: 409 }
      )
    }

    const newExchangeRate = await exchangeRateDb.create({
      currency,
      currency_name: currencyName || null,
      year_month: normalizedYearMonth,
      rate: parsedRate,
      description: description || null,
      note_images: normalizeNoteImages(noteImages),
    })
    return NextResponse.json({ success: true, data: toClientModel(newExchangeRate) }, { status: 201 })
  } catch (error) {
    console.error("Error creating exchange rate:", error)
    return NextResponse.json(
      { success: false, error: "Failed to create exchange rate" },
      { status: 500 }
    )
  }
}
