'use client'

import { createContext, ReactNode, useContext, useMemo, useState } from 'react'

type ConversationItem = {
  id: number
  title: string
  updated_at: string
}

type GroupedConversation = {
  label: string
  items: ConversationItem[]
}

export type DashboardAISidebarState = {
  activeConversationId: number | null
  groupedConversations: GroupedConversation[]
  filteredConversationCount: number
  loadingConversations: boolean
  busyConversationAction: string | null
  submitting: boolean
  searchQuery: string
  pinnedConversationIds: Set<number>
  editingConversationId: number | null
  editingTitle: string
  onSearchQueryChange: (value: string) => void
  onCreateConversation: () => void | Promise<void>
  onSelectConversation: (conversationId: number) => void
  onTogglePin: (conversationId: number) => void
  onRegenerateTitle: (conversationId: number) => void | Promise<void>
  onDeleteConversation: (conversationId: number) => void | Promise<void>
  onStartRename: (conversationId: number, currentTitle: string) => void
  onEditingTitleChange: (value: string) => void
  onRenameConversation: (conversationId: number, newTitle: string) => void | Promise<void>
  onCancelRename: () => void
  formatMessageTime: (isoString: string) => string
}

type DashboardAISidebarContextValue = {
  sidebarState: DashboardAISidebarState | null
  setSidebarState: (state: DashboardAISidebarState | null) => void
}

const DashboardAISidebarContext = createContext<DashboardAISidebarContextValue | null>(null)

export function DashboardAISidebarProvider({ children }: { children: ReactNode }) {
  const [sidebarState, setSidebarState] = useState<DashboardAISidebarState | null>(null)

  const value = useMemo(
    () => ({
      sidebarState,
      setSidebarState,
    }),
    [sidebarState]
  )

  return <DashboardAISidebarContext.Provider value={value}>{children}</DashboardAISidebarContext.Provider>
}

export function useDashboardAISidebar() {
  const context = useContext(DashboardAISidebarContext)
  if (!context) {
    throw new Error('useDashboardAISidebar must be used within DashboardAISidebarProvider.')
  }

  return context
}
