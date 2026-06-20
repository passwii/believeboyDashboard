'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import type { Profile, ProfileUpdate } from '@/types/profile'
import {
  clearProfileClientCache,
  fetchProfile,
  updateProfile,
} from '@/lib/client-api/profile-client'

export interface UseProfileResult {
  profile: Profile | null
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  update: (patch: ProfileUpdate) => Promise<Profile>
}

export function useProfile(): UseProfileResult {
  const { status, update: updateSession } = useSession()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState<boolean>(status !== 'authenticated')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (status !== 'authenticated') return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchProfile()
      setProfile(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const refetch = useCallback(async () => {
    clearProfileClientCache()
    await load()
  }, [load])

  const update = useCallback(
    async (patch: ProfileUpdate) => {
      const next = await updateProfile(patch)
      setProfile(next)
      // Keep the JWT-derived session in sync so the sidebar reflects
      // name / avatar changes immediately.
      await updateSession({
        user: {
          name: next.name,
          image: next.avatar_url ?? undefined,
        },
      })
      return next
    },
    [updateSession],
  )

  return { profile, loading, error, refetch, update }
}