'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react'
import {
  Notification,
  NotifyOptions,
  NOTIFICATION_CHANGE_EVENT,
  NOTIFICATION_HISTORY_KEY,
  DEFAULT_NOTIFY_DURATION,
  MAX_HISTORY_SIZE,
} from '@/lib/notifications'

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

type State = {
  history: Notification[]
  toasts: Notification[]
}

type Action =
  | { type: 'ADD_NOTIFICATION'; payload: Notification }
  | { type: 'DISMISS_TOAST'; payload: string }
  | { type: 'MARK_READ'; payload: string }
  | { type: 'CLEAR_ALL' }
  | { type: 'HYDRATE'; payload: Notification[] }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, history: action.payload }
    case 'ADD_NOTIFICATION':
      return {
        ...state,
        toasts: [action.payload, ...state.toasts],
        history: [action.payload, ...state.history].slice(0, MAX_HISTORY_SIZE),
      }
    case 'DISMISS_TOAST':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.payload) }
    case 'MARK_READ':
      return {
        ...state,
        history: state.history.map((n) =>
          n.id === action.payload ? { ...n, read: true } : n
        ),
      }
    case 'CLEAR_ALL':
      return { ...state, history: [] }
    default:
      return state
  }
}

function loadHistory(): Notification[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(NOTIFICATION_HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(history: Notification[]) {
  try {
    localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(history))
  } catch {
    // ignore quota errors
  }
}

type NotificationsContextValue = {
  notify: (opts: NotifyOptions, duration?: number) => string
  dismissToast: (id: string) => void
  markRead: (id: string) => void
  clearAll: () => void
  unreadCount: number
  history: Notification[]
  toasts: Notification[]
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { history: [], toasts: [] })
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Hydrate from localStorage on mount
  useEffect(() => {
    const saved = loadHistory()
    dispatch({ type: 'HYDRATE', payload: saved })
  }, [])

  // Persist history whenever it changes
  useEffect(() => {
    saveHistory(state.history)
    window.dispatchEvent(new CustomEvent(NOTIFICATION_CHANGE_EVENT))
  }, [state.history])

  const notify = useCallback(
    (opts: NotifyOptions, duration = DEFAULT_NOTIFY_DURATION): string => {
      const notification: Notification = {
        ...opts,
        id: genId(),
        createdAt: Date.now(),
        read: false,
      }

      dispatch({ type: 'ADD_NOTIFICATION', payload: notification })

      // Auto-dismiss
      const timer = setTimeout(() => {
        dispatch({ type: 'DISMISS_TOAST', payload: notification.id })
        timerRefs.current.delete(notification.id)
      }, duration)
      timerRefs.current.set(notification.id, timer)

      return notification.id
    },
    []
  )

  const dismissToast = useCallback((id: string) => {
    const timer = timerRefs.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timerRefs.current.delete(id)
    }
    dispatch({ type: 'DISMISS_TOAST', payload: id })
  }, [])

  const markRead = useCallback((id: string) => {
    dispatch({ type: 'MARK_READ', payload: id })
  }, [])

  const clearAll = useCallback(() => {
    dispatch({ type: 'CLEAR_ALL' })
  }, [])

  const unreadCount = state.history.filter((n) => !n.read).length

  return (
    <NotificationsContext.Provider
      value={{ notify, dismissToast, markRead, clearAll, unreadCount, history: state.history, toasts: state.toasts }}
    >
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider')
  }
  return ctx
}
