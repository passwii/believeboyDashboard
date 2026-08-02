import { describe, it, expect } from 'vitest'
import {
  AI_CHAT_CONFIG_BACKEND_DEFAULTS,
  degradedAIChatConfig,
} from './ai-chat-config-defaults'

describe('AI_CHAT_CONFIG_BACKEND_DEFAULTS', () => {
  it('与后端 pydantic AIChatConfigResponse 默认值对齐', () => {
    // backend/app/schemas/ai_chat.py:
    //   default_reasoning_effort = "medium"
    //   timeout_seconds          = 90
    //   max_conversation_turns   = 10
    //   web_search_max_results   = 5
    expect(AI_CHAT_CONFIG_BACKEND_DEFAULTS).toEqual({
      defaultReasoningEffort: 'medium',
      timeoutSeconds: 90,
      maxConversationTurns: 10,
      webSearchMaxResults: 5,
    })
  })
})

describe('degradedAIChatConfig', () => {
  it('携带面向用户的失败原因并关闭 provider/webSearch', () => {
    const cfg = degradedAIChatConfig('缺少后端 API Key 配置')
    expect(cfg.message).toBe('缺少后端 API Key 配置')
    expect(cfg.providerConfigured).toBe(false)
    expect(cfg.webSearchConfigured).toBe(false)
    expect(cfg.models).toEqual([])
    expect(cfg.defaultModel).toBe('')
  })

  it('数值默认值取自后端对齐常量', () => {
    const cfg = degradedAIChatConfig('x')
    expect(cfg.defaultReasoningEffort).toBe(AI_CHAT_CONFIG_BACKEND_DEFAULTS.defaultReasoningEffort)
    expect(cfg.timeoutSeconds).toBe(AI_CHAT_CONFIG_BACKEND_DEFAULTS.timeoutSeconds)
    expect(cfg.maxConversationTurns).toBe(AI_CHAT_CONFIG_BACKEND_DEFAULTS.maxConversationTurns)
    expect(cfg.webSearchMaxResults).toBe(AI_CHAT_CONFIG_BACKEND_DEFAULTS.webSearchMaxResults)
  })

  it('附带 prompt preset 与 scenario 列表（前端 AIChatConfig 契约字段）', () => {
    const cfg = degradedAIChatConfig('x')
    expect(Array.isArray(cfg.overviewOptions)).toBe(true)
    expect(Array.isArray(cfg.detailOptions)).toBe(true)
    expect(Array.isArray(cfg.scenarios)).toBe(true)
  })
})
