export const DEFAULT_BLOB_URL_REVOKE_DELAY_MS = 1000

export function downloadBlob(
  blob: Blob,
  filename: string,
  revokeDelayMs = DEFAULT_BLOB_URL_REVOKE_DELAY_MS
) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs)
}
