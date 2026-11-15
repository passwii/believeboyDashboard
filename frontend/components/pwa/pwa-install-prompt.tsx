'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'

import {
  isIosSafari,
  isMobileOrTabletDevice,
  isStandalonePwa,
} from '@/lib/pwa/device'

import styles from './pwa-install-prompt.module.css'

export const PWA_PROMPT_AVAILABLE_EVENT = 'believeboy:pwa-prompt-available'
export const PWA_INSTALLED_EVENT = 'believeboy:pwa-installed'
export const PWA_INSTALL_DISMISSED_KEY = 'believeboy:pwa-install-dismissed'

type PromptMode = 'chromium' | 'ios'

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(PWA_INSTALL_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberDismissed(): void {
  try {
    sessionStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1')
  } catch {}
}

export function PwaInstallPrompt() {
  const [mode, setMode] = useState<PromptMode | null>(null)
  const [promptEvent, setPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const nav = window.navigator
    const matches = (query: string) => window.matchMedia(query).matches

    if (!isMobileOrTabletDevice(nav, matches)) return
    if (isStandalonePwa(nav, matches)) return
    if (readDismissed()) return

    let active = true

    const showChromiumPrompt = () => {
      const nextPrompt = window.__believeboyPwaPrompt
      if (!active || !nextPrompt) return
      setPromptEvent(nextPrompt)
      setMode('chromium')
    }

    const hidePrompt = () => {
      if (!active) return
      setPromptEvent(null)
      setMode(null)
    }

    showChromiumPrompt()
    if (!window.__believeboyPwaPrompt && isIosSafari(nav)) {
      setMode('ios')
    }

    window.addEventListener(PWA_PROMPT_AVAILABLE_EVENT, showChromiumPrompt)
    window.addEventListener(PWA_INSTALLED_EVENT, hidePrompt)

    if ('serviceWorker' in nav) {
      void nav.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch(() => undefined)
    }

    return () => {
      active = false
      window.removeEventListener(PWA_PROMPT_AVAILABLE_EVENT, showChromiumPrompt)
      window.removeEventListener(PWA_INSTALLED_EVENT, hidePrompt)
    }
  }, [])

  if (!mode) return null

  const dismiss = () => {
    rememberDismissed()
    setMode(null)
    setPromptEvent(null)
  }

  const install = async () => {
    if (!promptEvent || installing) return

    setInstalling(true)
    try {
      await promptEvent.prompt()
      const choice = await promptEvent.userChoice
      if (choice.outcome === 'accepted') {
        setMode(null)
        setPromptEvent(null)
      } else {
        dismiss()
      }
    } catch {
      dismiss()
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={`warm-ledger ${styles.shell}`}>
      <section
        className={styles.prompt}
        aria-label="安装应用"
        data-testid="pwa-install-prompt"
      >
        <Image
          className={styles.icon}
          src="/pwa/icon-192.png"
          alt=""
          width={40}
          height={40}
        />
        <div className={styles.copy}>
          <p className={styles.title}>安装彼励扶 Dashboard</p>
          {mode === 'ios' ? (
            <p className={styles.help}>
              在 Safari 中点「分享」，再选择「添加到主屏幕」
            </p>
          ) : null}
        </div>
        {mode === 'chromium' ? (
          <button
            type="button"
            className={styles.install}
            onClick={() => void install()}
            disabled={installing}
          >
            {installing ? '安装中…' : '安装'}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.close}
          onClick={dismiss}
          aria-label="关闭安装提示"
        >
          <span aria-hidden="true">×</span>
        </button>
      </section>
    </div>
  )
}
