import { createClient } from "@supabase/supabase-js"

function getServerEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")
  }

  if (!anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }

  return { url, anonKey }
}

export function createSupabaseServerClient() {
  const { url, anonKey } = getServerEnv()

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
