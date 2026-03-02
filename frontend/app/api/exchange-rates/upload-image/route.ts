export const runtime = "nodejs"
export const dynamic = "force-dynamic"

import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import sharp from "sharp"
import { NextResponse } from "next/server"
import { requireAdminSession } from "@/lib/auth/server"
import {
  EXCHANGE_RATE_IMAGE_DIR,
  EXCHANGE_RATE_THUMB_DIR,
  EXCHANGE_RATE_IMAGE_URL_BASE,
} from "@/lib/exchange-rate-images"

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 })
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 })
    }

    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File size exceeds 10MB" }, { status: 400 })
    }

    await fs.mkdir(EXCHANGE_RATE_IMAGE_DIR, { recursive: true })
    await fs.mkdir(EXCHANGE_RATE_THUMB_DIR, { recursive: true })

    const uploadedAt = new Date().toISOString()
    const imageId = randomUUID()
    const fileName = `${imageId}.webp`
    const thumbFileName = `${imageId}_thumb.webp`
    const filePath = path.join(EXCHANGE_RATE_IMAGE_DIR, fileName)
    const thumbPath = path.join(EXCHANGE_RATE_THUMB_DIR, thumbFileName)
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const optimizedBuffer = await sharp(buffer)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    const thumbBuffer = await sharp(optimizedBuffer)
      .resize({ width: 320, height: 320, fit: "cover", position: "centre" })
      .webp({ quality: 72 })
      .toBuffer()

    await fs.writeFile(filePath, optimizedBuffer)
    await fs.writeFile(thumbPath, thumbBuffer)

    return NextResponse.json({
      success: true,
      data: {
        id: imageId,
        url: `${EXCHANGE_RATE_IMAGE_URL_BASE}/${encodeURIComponent(fileName)}`,
        thumbnailUrl: `${EXCHANGE_RATE_IMAGE_URL_BASE}/${encodeURIComponent(`thumbs/${thumbFileName}`)}`,
        filename: file.name || `${imageId}.webp`,
        contentType: "image/webp",
        size: optimizedBuffer.byteLength,
        uploadedAt,
      },
    })
  } catch (error) {
    console.error("Error uploading exchange rate image:", error)
    return NextResponse.json(
      { error: "Failed to upload image" },
      { status: 500 }
    )
  }
}
