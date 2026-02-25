import { createClient } from "@supabase/supabase-js"

function getAdminEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY

  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")
  }

  if (!secretKey) {
    throw new Error("Missing SUPABASE_SECRET_KEY")
  }

  return { url, secretKey }
}

export function createSupabaseAdminClient() {
  const { url, secretKey } = getAdminEnv()

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
