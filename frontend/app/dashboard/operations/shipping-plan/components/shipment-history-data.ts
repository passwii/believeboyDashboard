import type { components } from '@/types/api-generated/api'

type ApiShipmentHistory = components['schemas']['ShipmentHistoryResponse']
type ShipmentHistorySalesMonth = NonNullable<ApiShipmentHistory['sales_months']>[number] & {
  provisional_sales_quantity?: number | null
  provisional_sales_through?: string | null
  coverage_through?: string | null
}

export type ShipmentHistory = Omit<ApiShipmentHistory, 'sales_months'> & {
  sales_months?: ShipmentHistorySalesMonth[]
}

export type ShipmentHistoryPoint = {
  month: string
  shipment_count: number
  quantity: number
  sales_quantity: number | null
  provisional_sales_quantity: number | null
  provisional_sales_through: string | null
  coverage_through: string | null
  covered: boolean
  gap: number | null
}

export function buildShipmentHistoryPoints(history: ShipmentHistory): ShipmentHistoryPoint[] {
  const shipmentsByMonth = new Map(history.months.map((item) => [item.month, item]))
  const salesMonths = history.sales_months ?? []

  if (salesMonths.length > 0) {
    return salesMonths.map((sales) => {
      const shipment = shipmentsByMonth.get(sales.month)
      const covered = sales.covered && sales.sales_quantity !== null
      const salesQuantity = covered ? sales.sales_quantity : null
      const provisionalSalesQuantity = covered ? null : sales.provisional_sales_quantity ?? null
      const quantity = shipment?.quantity ?? 0

      return {
        month: sales.month,
        shipment_count: shipment?.shipment_count ?? 0,
        quantity,
        sales_quantity: salesQuantity,
        provisional_sales_quantity: provisionalSalesQuantity,
        provisional_sales_through: sales.provisional_sales_through ?? null,
        coverage_through: sales.coverage_through ?? null,
        covered,
        gap: salesQuantity === null ? null : salesQuantity - quantity,
      }
    })
  }

  const start = new Date(`${history.etd_from}T00:00:00Z`)
  const end = new Date(`${history.etd_to}T00:00:00Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return history.months.map((shipment) => ({
      ...shipment,
      sales_quantity: null,
      provisional_sales_quantity: null,
      provisional_sales_through: null,
      coverage_through: null,
      covered: false,
      gap: null,
    }))
  }

  const points: ShipmentHistoryPoint[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const lastMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)
  while (cursor.getTime() <= lastMonth) {
    const month = cursor.toISOString().slice(0, 7)
    const shipment = shipmentsByMonth.get(month)
    points.push({
      month,
      shipment_count: shipment?.shipment_count ?? 0,
      quantity: shipment?.quantity ?? 0,
      sales_quantity: null,
      provisional_sales_quantity: null,
      provisional_sales_through: null,
      coverage_through: null,
      covered: false,
      gap: null,
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return points
}
