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
      // BLF-1441：`fullName` 是全局显示名与 `X-Operator` 的唯一来源，改完
      // 「姓名」要立刻生效，所以这里触发一次会话刷新。
      //
      // 注意**不传**姓名 / 登录名：`update(data)` 是客户端可自行构造的
      // `POST /api/auth/session`，把姓名塞进 body 会诱导 jwt 回调信任客户端
      // 输入（review P1 的越权路径）。服务端在 `trigger === 'update'` 时用
      // token 里的身份回源 `/api/v1/auth/me` 取权威姓名，这里传什么都不会
      // 进 token；留空是为了让「客户端说了不算」这件事在调用点就看得见。
      await updateSession({})
      return next
    },
    [updateSession]
  )

  return { profile, loading, error, refetch, update }
}
