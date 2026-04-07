'use client'

import { Loader2, MessageCirclePlus, PanelLeftClose, Pin, Search, Sparkles, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type ConversationItem = {
  id: number
  title: string
  updated_at: string
}

type GroupedConversation = {
  label: string
  items: ConversationItem[]
}

type AIChatSidebarProps = {
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

export function AIChatSidebar({
  activeConversationId,
  groupedConversations,
  filteredConversationCount,
  loadingConversations,
  busyConversationAction,
  submitting,
  searchQuery,
  pinnedConversationIds,
  editingConversationId,
  editingTitle,
  onSearchQueryChange,
  onCreateConversation,
  onSelectConversation,
  onTogglePin,
  onRegenerateTitle,
  onDeleteConversation,
  onStartRename,
  onEditingTitleChange,
  onRenameConversation,
  onCancelRename,
  formatMessageTime,
}: AIChatSidebarProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-[hsl(var(--sidebar-foreground)/0.08)] px-3 pb-3 pt-4">
        <div className="mb-3">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/42">AI Workspace</p>
          <div className="mt-2">
            <p className="text-[1rem] font-semibold tracking-tight text-sidebar-foreground">会话管理栏</p>
            <p className="mt-1 text-[0.72rem] leading-5 text-sidebar-foreground/56">AI 会话列表直接占用原 Sidebar 区域。</p>
          </div>
        </div>
        <Button
          type="button"
          className="h-10 w-full justify-start rounded-[0.9rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.05)] px-3 text-sm font-medium text-sidebar-foreground shadow-none transition hover:bg-[hsl(var(--sidebar-foreground)/0.08)]"
          onClick={() => void onCreateConversation()}
        >
          <MessageCirclePlus className="mr-2 h-4 w-4" />
          新建会话
        </Button>
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/42" />
          <Input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="搜索会话..."
            className="h-10 rounded-[0.9rem] border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] pl-9 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/32 focus-visible:ring-sidebar-ring"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 py-3">
          {loadingConversations ? (
            <div className="flex items-center gap-2 rounded-[0.9rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] px-3 py-3 text-sm text-sidebar-foreground/68">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>加载会话中</span>
            </div>
          ) : null}

          {groupedConversations.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/34">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const titleActionBusy = busyConversationAction === `title-${item.id}`
                  const deleteActionBusy = busyConversationAction === `delete-${item.id}`
                  const renameActionBusy = busyConversationAction === `rename-${item.id}`
                  const active = activeConversationId === item.id
                  const isPinned = pinnedConversationIds.has(item.id)
                  const isEditing = editingConversationId === item.id

                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'group rounded-md border px-1 py-1 transition-all',
                        active
                          ? 'border-[hsl(var(--sidebar-foreground)/0.12)] bg-[hsl(var(--sidebar-foreground)/0.08)]'
                          : 'border-transparent bg-transparent hover:border-[hsl(var(--sidebar-foreground)/0.08)] hover:bg-[hsl(var(--sidebar-foreground)/0.04)]'
                      )}
                    >
                      <div className="flex items-start gap-1">
                        {isEditing ? (
                          <Input
                            value={editingTitle}
                            onChange={(event) => onEditingTitleChange(event.target.value)}
                            onBlur={() => void onRenameConversation(item.id, editingTitle)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                void onRenameConversation(item.id, editingTitle)
                              } else if (event.key === 'Escape') {
                                onCancelRename()
                              }
                            }}
                            className="h-5 flex-1 rounded-[0.5rem] border-[hsl(var(--sidebar-foreground)/0.1)] bg-[hsl(var(--sidebar-foreground)/0.04)] px-1 text-xs text-sidebar-foreground focus-visible:ring-sidebar-ring"
                            autoFocus
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => onSelectConversation(item.id)}
                            onDoubleClick={() => onStartRename(item.id, item.title)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className="truncate text-[0.75rem] font-medium leading-4 text-sidebar-foreground">{item.title}</p>
                          </button>
                        )}

                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className={cn(
                              'flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/42 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.08)] hover:text-sidebar-foreground',
                              isPinned && 'text-primary'
                            )}
                            disabled={titleActionBusy || deleteActionBusy || renameActionBusy || submitting}
                            onClick={() => onTogglePin(item.id)}
                            title={isPinned ? '取消置顶' : '置顶'}
                          >
                            <Pin className={cn('h-3 w-3', isPinned && 'fill-current')} />
                          </button>
                          <button
                            type="button"
                            className="flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/42 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.08)] hover:text-sidebar-foreground"
                            disabled={titleActionBusy || deleteActionBusy || renameActionBusy || submitting}
                            onClick={() => void onRegenerateTitle(item.id)}
                            title="重新生成标题"
                          >
                            {titleActionBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Sparkles className="h-3 w-3" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/42 transition-colors hover:bg-red-500/12 hover:text-red-500"
                            disabled={titleActionBusy || deleteActionBusy || renameActionBusy || submitting}
                            onClick={() => void onDeleteConversation(item.id)}
                            title="删除会话"
                          >
                            {deleteActionBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {!loadingConversations && filteredConversationCount === 0 ? (
            <div className="rounded-[0.9rem] border border-dashed border-[hsl(var(--sidebar-foreground)/0.1)] bg-[hsl(var(--sidebar-foreground)/0.02)] px-3 py-3 text-sm text-sidebar-foreground/56">
              {searchQuery ? '未找到匹配的会话。' : '暂无会话，请先创建一个。'}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
