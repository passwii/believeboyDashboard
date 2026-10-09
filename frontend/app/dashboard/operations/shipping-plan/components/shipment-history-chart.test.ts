import { describe, expect, it } from 'vitest'

import { buildShipmentHistoryPoints, type ShipmentHistory } from './shipment-history-data'

const history: ShipmentHistory = {
  project_id: 42,
  country: 'US',
  etd_from: '2025-10-15',
  etd_to: '2026-10-09',
  months: [
    { month: '2025-10', shipment_count: 1, quantity: 12 },
    { month: '2026-09', shipment_count: 2, quantity: 40 },
  ],
  missing_etd_shipment_count: 0,
  missing_etd_quantity: 0,
  included_statuses: ['in_transit', 'completed'],
  date_basis: 'ETD',
}

describe('buildShipmentHistoryPoints', () => {
  it('returns every calendar month in range, filling missing months with zero', () => {
    const points = buildShipmentHistoryPoints(history)

    expect(points).toHaveLength(13)
    expect(points[0]).toEqual({ month: '2025-10', shipment_count: 1, quantity: 12 })
    expect(points[1]).toEqual({ month: '2025-11', shipment_count: 0, quantity: 0 })
    expect(points[11]).toEqual({ month: '2026-09', shipment_count: 2, quantity: 40 })
    expect(points[12]).toEqual({ month: '2026-10', shipment_count: 0, quantity: 0 })
  })

  it('falls back to returned rows when the date range is invalid', () => {
    expect(buildShipmentHistoryPoints({ ...history, etd_from: 'invalid' })).toEqual(history.months)
  })
})
