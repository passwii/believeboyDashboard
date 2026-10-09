import type { components } from '@/types/api-generated/api'

export type ShipmentHistory = components['schemas']['ShipmentHistoryResponse']

export type ShipmentHistoryPoint = {
  month: string
  shipment_count: number
  quantity: number
  sales_quantity: number | null
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
      const quantity = shipment?.quantity ?? 0

      return {
        month: sales.month,
        shipment_count: shipment?.shipment_count ?? 0,
        quantity,
        sales_quantity: salesQuantity,
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
      covered: false,
      gap: null,
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return points
}
