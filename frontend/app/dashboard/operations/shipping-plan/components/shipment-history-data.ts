import type { components } from '@/types/api-generated/api'

export type ShipmentHistory = components['schemas']['ShipmentHistoryResponse']

export type ShipmentHistoryPoint = {
  month: string
  shipment_count: number
  quantity: number
}

export function buildShipmentHistoryPoints(history: ShipmentHistory): ShipmentHistoryPoint[] {
  const byMonth = new Map(history.months.map((item) => [item.month, item]))
  const start = new Date(`${history.etd_from}T00:00:00Z`)
  const end = new Date(`${history.etd_to}T00:00:00Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return history.months

  const points: ShipmentHistoryPoint[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const lastMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)
  while (cursor.getTime() <= lastMonth) {
    const month = cursor.toISOString().slice(0, 7)
    const recorded = byMonth.get(month)
    points.push({ month, shipment_count: recorded?.shipment_count ?? 0, quantity: recorded?.quantity ?? 0 })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return points
}
