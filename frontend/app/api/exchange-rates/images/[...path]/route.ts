export const runtime = "nodejs"
export const dynamic = "force-dynamic"

import { promises as fs } from "fs"
import path from "path"
import { NextRequest, NextResponse } from "next/server"
import { requireUserSession } from "@/lib/auth/server"
import { EXCHANGE_RATE_IMAGE_DIR } from "@/lib/exchange-rate-images"

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const session = await requireUserSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const joinedPath = Array.isArray(params.path) ? params.path.join("/") : ""
    if (!joinedPath) {
      return NextResponse.json({ error: "Invalid image path" }, { status: 400 })
    }

    const decodedPath = decodeURIComponent(joinedPath)
    const fullPath = path.resolve(EXCHANGE_RATE_IMAGE_DIR, decodedPath)
    const rootPath = path.resolve(EXCHANGE_RATE_IMAGE_DIR)
    if (!fullPath.startsWith(rootPath)) {
      return NextResponse.json({ error: "Invalid image path" }, { status: 400 })
    }

    const data = await fs.readFile(fullPath)
    const ext = path.extname(fullPath).toLowerCase()
    const contentType = CONTENT_TYPE_MAP[ext] || "application/octet-stream"

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    })
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return NextResponse.json({ error: "Image not found" }, { status: 404 })
    }
    console.error("Error reading exchange rate image:", error)
    return NextResponse.json(
      { error: "Failed to read image" },
      { status: 500 }
    )
  }
}
