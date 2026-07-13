/**
 * Browser-side avatar cache.
 *
 * Stores the binary blob of the user's profile picture in sessionStorage as a
 * base64-encoded payload, indexed by user_id + R2 URL. The motivation is to
 * skip the network round-trip to R2 on every page load: after the first fetch
 * the avatar is served from sessionStorage via a same-origin Blob URL.
 *
 * Failure modes are handled gracefully — quota errors, parse failures and
 * corrupted blobs all fall through to a fresh fetch. Callers MUST call
 * ``revokeObjectUrl`` for any URL returned from this module when they no
 * longer need it, otherwise the browser leaks memory until tab close.
 *
 * TTL is intentionally long (24h): the blob is keyed by the exact URL it
 * was downloaded from, so uploading a new avatar will produce a new URL and
 * naturally bypass the cache. Manual invalidation is exposed via
 * ``clearUserAvatarCache``.
 */

const AVATAR_STORAGE_PREFIX = 'bb-avatar-cache:'
const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface AvatarCacheEntry {
  updatedAt: number
  userId: string
  url: string
  contentType: string
  /** Base64-encoded blob body. */
  data: string
}

const memoryBlobs = new Map<string, Blob>()
const memoryMeta = new Map<string, { url: string; contentType: string; updatedAt: number }>()

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function compositeKey(userId: string, url: string): string {
  return `${userId}::${url}`
}

function readEntry(userId: string, url: string): AvatarCacheEntry | null {
  const storage = safeStorage()
  if (!storage) return null
  const raw = storage.getItem(`${AVATAR_STORAGE_PREFIX}${compositeKey(userId, url)}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AvatarCacheEntry
    if (!parsed || typeof parsed.updatedAt !== 'number') return null
    if (Date.now() - parsed.updatedAt > AVATAR_CACHE_TTL_MS) {
      storage.removeItem(`${AVATAR_STORAGE_PREFIX}${compositeKey(userId, url)}`)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeEntry(entry: AvatarCacheEntry): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(
      `${AVATAR_STORAGE_PREFIX}${compositeKey(entry.userId, entry.url)}`,
      JSON.stringify(entry)
    )
  } catch {
    // Storage quota exceeded or disabled — degrade gracefully.
  }
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: contentType })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export interface CachedAvatar {
  /** A blob URL you can assign to <img src>; revoke when done. */
  objectUrl: string
  contentType: string
  /** True when served from cache, false when freshly fetched. */
  fromCache: boolean
}

/**
 * Returns a blob URL for the given avatar URL, caching the body on first
 * download. When ``url`` is empty the function returns null — the caller
 * should fall back to its default avatar.
 */
export async function loadUserAvatar(
  userId: string,
  url: string,
  options?: { fetchImpl?: typeof fetch }
): Promise<CachedAvatar | null> {
  if (!userId || !url) return null

  const cachedMeta = memoryMeta.get(compositeKey(userId, url))
  const cachedBlob = memoryBlobs.get(compositeKey(userId, url))
  if (cachedBlob && cachedMeta) {
    return {
      objectUrl: URL.createObjectURL(cachedBlob),
      contentType: cachedMeta.contentType,
      fromCache: true,
    }
  }

  const entry = readEntry(userId, url)
  if (entry) {
    const blob = base64ToBlob(entry.data, entry.contentType)
    memoryBlobs.set(compositeKey(userId, url), blob)
    memoryMeta.set(compositeKey(userId, url), {
      url: entry.url,
      contentType: entry.contentType,
      updatedAt: entry.updatedAt,
    })
    return {
      objectUrl: URL.createObjectURL(blob),
      contentType: entry.contentType,
      fromCache: true,
    }
  }

  const fetchImpl = options?.fetchImpl ?? fetch
  const response = await fetchImpl(url, { cache: 'force-cache' })
  if (!response.ok) return null

  const blob = await response.blob()
  const contentType = blob.type || response.headers.get('content-type') || 'image/png'

  memoryBlobs.set(compositeKey(userId, url), blob)
  memoryMeta.set(compositeKey(userId, url), { url, contentType, updatedAt: Date.now() })

  // Only persist small avatars to sessionStorage to avoid blowing past the
  // 5MB origin quota on the first load.
  if (blob.size <= 4 * 1024 * 1024) {
    try {
      const data = await blobToBase64(blob)
      writeEntry({ userId, url, contentType, data, updatedAt: Date.now() })
    } catch {
      // Non-fatal — we already have the in-memory blob.
    }
  }

  return {
    objectUrl: URL.createObjectURL(blob),
    contentType,
    fromCache: false,
  }
}

/**
 * Invalidates the cached entry for a specific URL and the in-memory blob.
 * Call this when the user uploads a new avatar so the next ``loadUserAvatar``
 * call returns the fresh image instead of the stale one.
 */
export function invalidateUserAvatar(userId: string, url: string): void {
  memoryBlobs.delete(compositeKey(userId, url))
  memoryMeta.delete(compositeKey(userId, url))
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.removeItem(`${AVATAR_STORAGE_PREFIX}${compositeKey(userId, url)}`)
  } catch {
    // Ignore.
  }
}

/**
 * Drops every cached avatar for the user. Cheaper than enumerating because
 * we only care about clearing one user's avatar at a time.
 */
export function clearUserAvatarCache(userId: string): void {
  const prefix = `${userId}::`
  Array.from(memoryBlobs.keys())
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => {
      memoryBlobs.delete(key)
      memoryMeta.delete(key)
    })
  const storage = safeStorage()
  if (!storage) return
  try {
    const matched: string[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (!key || !key.startsWith(AVATAR_STORAGE_PREFIX)) continue
      const rawKey = key.slice(AVATAR_STORAGE_PREFIX.length)
      if (rawKey.startsWith(prefix)) matched.push(key)
    }
    matched.forEach((key) => storage.removeItem(key))
  } catch {
    // Ignore.
  }
}
