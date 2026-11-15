export type PwaNavigator = {
  userAgent: string
  maxTouchPoints?: number
  standalone?: boolean
  userAgentData?: {
    mobile?: boolean
  }
}

export type PwaMediaQuery = (query: string) => boolean

function isIpadDesktopUserAgent(nav: PwaNavigator): boolean {
  return /Macintosh/i.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1
}

export function isMobileOrTabletDevice(
  nav: PwaNavigator,
  matchMedia: PwaMediaQuery
): boolean {
  if (nav.userAgentData?.mobile === true) return true
  if (/Android|iPhone|iPad|iPod/i.test(nav.userAgent)) return true
  if (isIpadDesktopUserAgent(nav)) return true

  return matchMedia('(pointer: coarse)') && matchMedia('(hover: none)')
}

export function isStandalonePwa(
  nav: PwaNavigator,
  matchMedia: PwaMediaQuery
): boolean {
  return matchMedia('(display-mode: standalone)') || nav.standalone === true
}

export function isIosSafari(nav: PwaNavigator): boolean {
  const isIos =
    /iPhone|iPad|iPod/i.test(nav.userAgent) || isIpadDesktopUserAgent(nav)
  if (!isIos) return false

  return (
    /Safari/i.test(nav.userAgent) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(nav.userAgent)
  )
}
