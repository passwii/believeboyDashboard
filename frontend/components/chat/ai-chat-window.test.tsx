import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listConversationsMock, getMessagesMock, ensureConfigLoadedMock, headerRefreshRef } = vi.hoisted(() => ({
  listConversationsMock: vi.fn(),
  getMessagesMock: vi.fn(),
  ensureConfigLoadedMock: vi.fn(),
  headerRefreshRef: { current: null as null | (() => void | Promise<void>) },
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    headerRefreshRef.current = handler
    return { setLoading: vi.fn() }
  },
}))

vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: ensureConfigLoadedMock,
  getConfig: () => ({ defaultModel: '', reasoningModels: [] }),
}))

vi.mock('@/lib/api/ai-chat', () => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  deleteMessage: vi.fn(),
  editMessage: vi.fn(),
  getMessages: getMessagesMock,
  listConversations: listConversationsMock,
  renameConversation: vi.fn(),
}))

vi.mock('@/lib/hooks/use-mobile', () => ({ useMobile: () => false }))
vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }))
vi.mock('gsap', () => ({ default: { fromTo: vi.fn(), to: vi.fn() } }))
vi.mock('./typewriter-text', () => ({ TypewriterText: () => null }))
vi.mock('./chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('./ray-background', () => ({ RayBackground: () => null }))
vi.mock('./announcement-badge', () => ({ AnnouncementBadge: () => null }))
vi.mock('./floating-particles', () => ({ FloatingParticles: () => null }))
vi.mock('./suggestion-chips', () => ({ SuggestionChips: () => null }))
vi.mock('./conversation-sidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./chat-message-list', () => ({
  ChatMessageList: ({ messages }: { messages: Array<{ id: string; content: string }> }) => (
    <div>{messages.map((message) => <p key={message.id}>{message.content}</p>)}</div>
  ),
}))
vi.mock('./hooks/use-chat-stream-v2', () => ({
  useChatStreamV2: () => ({
    send: vi.fn(),
    stop: vi.fn(),
    error: null,
    toolState: null,
    pendingSources: [],
    pendingUsage: null,
  }),
}))

import { AIChatWindow } from './ai-chat-window'

const config = {
  providerConfigured: true,
  defaultModel: '',
  scenarios: [],
}

function conversation(id: number) {
  return {
    id,
    title: `会话 ${id}`,
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
  }
}

function message(id: number, content: string) {
  return {
    id,
    conversation_id: 1,
    role: 'assistant',
    content,
    search_sources: [],
    is_complete: true,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    duration_ms: null,
    created_at: '2026-10-10T00:00:00.000Z',
  }
}

describe('AIChatWindow Head 刷新', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    headerRefreshRef.current = null
    ensureConfigLoadedMock.mockResolvedValue(config)
    listConversationsMock.mockResolvedValue([conversation(1)])
    getMessagesMock.mockResolvedValue([message(1, '旧消息')])
  })

  it('重新请求会话、当前消息与 AI 配置，并保留当前对话', async () => {
    render(<AIChatWindow />)
    expect(await screen.findByText('旧消息')).toBeInTheDocument()

    listConversationsMock.mockResolvedValueOnce([conversation(1)])
    getMessagesMock.mockResolvedValueOnce([message(2, '更新后的消息')])
    const refresh = headerRefreshRef.current
    expect(refresh).toBeTruthy()
    await act(async () => refresh?.())

    expect(listConversationsMock).toHaveBeenCalledTimes(2)
    expect(getMessagesMock).toHaveBeenLastCalledWith(1)
    expect(ensureConfigLoadedMock).toHaveBeenLastCalledWith(true)
    expect(await screen.findByText('更新后的消息')).toBeInTheDocument()
  })

  it('会话刷新失败时保留已有内容并显示错误反馈', async () => {
    render(<AIChatWindow />)
    expect(await screen.findByText('旧消息')).toBeInTheDocument()
    listConversationsMock.mockRejectedValueOnce(new Error('会话服务暂时不可用'))

    await act(async () => headerRefreshRef.current?.())

    expect(screen.getByRole('alert')).toHaveTextContent('会话服务暂时不可用')
    expect(screen.getByText('旧消息')).toBeInTheDocument()
  })
})
