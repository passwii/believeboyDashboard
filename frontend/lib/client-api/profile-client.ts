'use client'

import type { Profile, ProfileUpdate } from '@/types/profile'
import { normalizeErrorMessage } from '@/lib/error-utils'

const PROFILE_CACHE_KEY = 'profile:current'
const PROFILE_CACHE_TTL_MS = 60 * 1000

type CacheEntry = { updatedAt: number; value: Profile }

const memoryCache = new Map<string, CacheEntry>()

function readCache<T>(key: string): T | null {
  const entry = memoryCache.get(key) as CacheEntry | undefined
  if (!entry) return null
  if (Date.now() - entry.updatedAt > 60 * 1000) {
    memoryCache.delete(key)
    return null
  }
  return entry.value as unknown as T
}

function writeCache<T>(key: string, value: T): void {
  memoryCache.set(key, { updatedAt: Date.now(), value: value as unknown as CacheEntry['value'] })
}

export function clearProfileClientCache(): void {
  memoryCache.delete(PROFILE_CACHE_KEY)
}

export async function fetchProfile(): Promise<Profile> {
  const cached = readCache<Profile>(PROFILE_CACHE_KEY)
  if (cached) return cached

  const response = await fetch('/api/user/profile', { cache: 'no-store' })
  const body = (await response.json()) as Partial<Profile> & { message?: string }
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(body.message, '加载失败'))
  }
  const profile = body as Profile
  writeCache(PROFILE_CACHE_KEY, profile)
  return profile
}

export async function updateProfile(patch: ProfileUpdate): Promise<Profile> {
  const response = await fetch('/api/user/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = (await response.json()) as Partial<Profile> & { message?: string }
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(body.message, '保存失败'))
  }
  const profile = body as Profile
  writeCache(PROFILE_CACHE_KEY, profile)
  return profile
}

export async function uploadAvatar(file: File): Promise<{ avatar_url: string }> {
  const formData = new FormData()
  formData.append('file', file, file.name)
  const response = await fetch('/api/user/avatar', {
    method: 'POST',
    body: formData,
  })
  const body = (await response.json()) as
    | { avatar_url: string; size: number; content_type: string }
    | { message?: string }
  if (!response.ok || !('avatar_url' in body) || !body.avatar_url) {
    throw new Error('message' in body && body.message ? body.message : '上传失败')
  }
  // avatar_url has changed — invalidate cache so the next fetchProfile call
  // returns fresh data.
  clearProfileClientCache()
  return { avatar_url: body.avatar_url }
}

export async function deleteAvatar(): Promise<void> {
  const response = await fetch('/api/user/avatar', { method: 'DELETE' })
  const body = (await response.json()) as { ok?: boolean; message?: string }
  if (!response.ok || !body.ok) {
    throw new Error(body.message || '删除失败')
  }
  clearProfileClientCache()
}
