import path from "path"

export const EXCHANGE_RATE_IMAGE_DIR = path.join(
  process.cwd(),
  "..",
  "storage",
  "uploads",
  "exchange-rate-notes"
)
export const EXCHANGE_RATE_THUMB_DIR = path.join(EXCHANGE_RATE_IMAGE_DIR, "thumbs")

export const EXCHANGE_RATE_IMAGE_URL_BASE = "/api/exchange-rates/images"

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_")
}
