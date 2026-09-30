import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth', () => ({
  CredentialsSignin: class CredentialsSignin extends Error {
    type = 'CredentialsSignin'
    code = 'credentials'
  },
}))

import { CredentialsSignin } from 'next-auth'
import { NetworkAuthError } from './network-auth-error'

describe('NetworkAuthError', () => {
  it('uses the Auth.js credentials error type with a recoverable network code', () => {
    const error = new NetworkAuthError()

    expect(error).toBeInstanceOf(CredentialsSignin)
    expect(error.type).toBe('CredentialsSignin')
    expect(error.code).toBe('network_error')
  })
})
