// 使用 Node.js 运行时（支持 SQLite）
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { requireAdminSession } from "@/lib/auth/server"
import { exchangeRateDb } from "@/lib/db"

// 获取筛选选项（货币列表、年份列表等）
export async function GET(request: NextRequest) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 获取所有货币列表
    const allRates = (await exchangeRateDb.getAll()).data
    
    // 提取唯一的货币
    const currencyMap = new Map()
    allRates.forEach(rate => {
      if (!currencyMap.has(rate.currency)) {
        currencyMap.set(rate.currency, {
          value: rate.currency,
          label: `${rate.currency} - ${rate.currency_name || rate.currency}`
        })
      }
    })
    const currencyOptions = Array.from(currencyMap.values())

    // 提取唯一的年份
    const yearSet = new Set<number>()
    allRates.forEach(rate => {
      // 从 year_month 格式 "2024-01" 中提取年份
      const year = parseInt(rate.year_month.split('-')[0])
      if (!isNaN(year)) {
        yearSet.add(year)
      }
    })
    const yearOptions = Array.from(yearSet)
      .sort((a, b) => b - a) // 降序排列
      .map(year => ({
        value: year,
        label: `${year}年`
      }))

    // 月份选项（固定）
    const monthOptions = Array.from({ length: 12 }, (_, i) => ({
      value: i + 1,
      label: `${i + 1}月`,
    }))

    return NextResponse.json({
      currencies: currencyOptions,
      years: yearOptions,
      months: monthOptions,
    })
  } catch (error) {
    console.error("Error fetching exchange rate options:", error)
    return NextResponse.json(
      { error: "Failed to fetch options" },
      { status: 500 }
    )
  }
}
