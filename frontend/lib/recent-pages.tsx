'use client'

import { useEffect, useState } from 'react'

export interface RecentPage {
  path: string
  title: string
  visitedAt: number
}

const MAX_RECENT = 5
const STORAGE_KEY = 'recent-pages'

// Module-level singleton — shared across all hook calls, survives re-renders
let _recentPages: RecentPage[] = []
let _listeners: Array<(pages: RecentPage[]) => void> = []
let _initialized = false

function loadFromStorage(): RecentPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(pages: RecentPage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
  } catch {
    // ignore quota errors
  }
}

function notifyListeners() {
  for (const listener of _listeners) {
    listener(_recentPages)
  }
}

function pushPage(path: string, title: string) {
  const filtered = _recentPages.filter((p) => p.path !== path)
  _recentPages = [{ path, title, visitedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT)
  saveToStorage(_recentPages)
  notifyListeners()
}

function clearHistory() {
  _recentPages = []
  saveToStorage(_recentPages)
  notifyListeners()
}

function init() {
  if (_initialized) return
  _initialized = true
  _recentPages = loadFromStorage()
}

export function useRecentPages() {
  const [recentPages, setRecentPages] = useState<RecentPage[]>(() => {
    init()
    return [..._recentPages]
  })

  // Keep state in sync with singleton
  useEffect(() => {
    const listener = (pages: RecentPage[]) => {
      setRecentPages([...pages])
    }
    _listeners.push(listener)
    return () => {
      _listeners = _listeners.filter((l) => l !== listener)
    }
  }, [])

  return {
    recentPages,
    pushPage,
    clearHistory,
  }
}

/** Short path segments for display (strips /dashboard prefix) */
export function shortPath(path: string): string {
  return path.replace(/^\/dashboard/, '') || '/'
}
