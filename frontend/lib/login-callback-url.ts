export function buildLoginCallbackUrl(currentPath: string) {
  return `/login?callbackUrl=${encodeURIComponent(currentPath)}`
}
