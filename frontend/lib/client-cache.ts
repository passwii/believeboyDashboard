type CacheEnvelope<T> = {
  updatedAt: number
  value: T
}

const MEMORY_CACHE = new Map<string, CacheEnvelope<unknown>>()
const STORAGE_PREFIX = 'bb-dashboard-cache:'

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

function readFromSessionStorage<T>(key: string): CacheEnvelope<T> | null {
  if (typeof window === 'undefined') return null
  const raw = window.sessionStorage.getItem(storageKey(key))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope<T>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.updatedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writeToSessionStorage<T>(key: string, value: CacheEnvelope<T>): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(value))
  } catch {
    // Ignore storage quota or serialization errors.
  }
}

function removeFromSessionStorage(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(storageKey(key))
  } catch {
    // Ignore storage errors.
  }
}

export function getClientCache<T>(key: string, maxAgeMs: number): T | null {
  const now = Date.now()
  const memoryValue = MEMORY_CACHE.get(key) as CacheEnvelope<T> | undefined
  if (memoryValue) {
    if (now - memoryValue.updatedAt <= maxAgeMs) return memoryValue.value
    MEMORY_CACHE.delete(key)
  }

  const sessionValue = readFromSessionStorage<T>(key)
  if (!sessionValue) return null
  if (now - sessionValue.updatedAt > maxAgeMs) {
    removeFromSessionStorage(key)
    return null
  }

  MEMORY_CACHE.set(key, sessionValue as CacheEnvelope<unknown>)
  return sessionValue.value
}

export function setClientCache<T>(
  key: string,
  value: T,
  options?: { persist?: boolean }
): void {
  const envelope: CacheEnvelope<T> = {
    updatedAt: Date.now(),
    value,
  }
  MEMORY_CACHE.set(key, envelope as CacheEnvelope<unknown>)
  if (options?.persist === false) return
  writeToSessionStorage(key, envelope)
}

export function clearClientCache(key: string): void {
  MEMORY_CACHE.delete(key)
  removeFromSessionStorage(key)
}
