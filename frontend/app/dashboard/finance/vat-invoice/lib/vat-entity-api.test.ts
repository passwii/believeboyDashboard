import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchEntities,
  upsertEntity,
  updateEntity,
  deleteEntity,
} from './vat-entity-api'

describe('vat-entity-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchEntities hits GET /vat-entities?project_id=', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    await fetchEntities(7)
    expect(spy.mock.calls[0][0]).toContain(
      '/api/backend/api/v1/vat-entities?project_id=7',
    )
  })

  it('upsertEntity POSTs with required fields', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }))
    await upsertEntity({
      project_id: 7,
      country: 'DE',
      company_name: 'ACME',
      vat_id: '',
      address_line: '',
      postal_code: '',
      city: '',
      email: '',
      is_default: false,
    })
    const call = spy.mock.calls[0]
    expect(call[1]?.method).toBe('POST')
    const body = JSON.parse(call[1]!.body as string)
    expect(body.country).toBe('DE')
    expect(body.project_id).toBe(7)
  })

  it('updateEntity PATCHes the given id', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await updateEntity(11, { company_name: 'ACME New' })
    const call = spy.mock.calls[0]
    expect(call[1]?.method).toBe('PATCH')
    expect(call[0]).toContain('/vat-entities/11')
    expect(JSON.parse(call[1]!.body as string).company_name).toBe('ACME New')
  })

  it('deleteEntity sends DELETE and tolerates 204', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteEntity(13)).resolves.toBeUndefined()
    expect(spy.mock.calls[0][1]?.method).toBe('DELETE')
  })
})
