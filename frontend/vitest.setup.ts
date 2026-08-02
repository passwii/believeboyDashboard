import '@testing-library/jest-dom'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {}
}

// jsdom 未实现 Element.prototype.scrollTo（与 scrollIntoView 同类的缺口）。
// layout.tsx 在路由变化时对 #main-content 调 scrollTo 复位滚动位置，
// ai-chat-window.tsx 也对会话滚动容器调 scrollTo；jsdom 下会抛
// “scrollTo is not a function”。补 no-op 桩，避免测试环境误报。
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {}
}

// jsdom v29 在当前环境不暴露 window.localStorage，导致 mock-crm-client.test.ts
// 的 beforeEach `window.localStorage.clear()` 抛 "Cannot read properties of
// undefined (reading 'clear')"，连带 MockCrmClient 的持久化读写也无存储可用。
// 补一个内存版 localStorage 桩（与上面 ResizeObserver/scrollTo 同类的 jsdom 缺口
// 修补）；仅当 jsdom 未提供时才注入，已有真实实现则保持不动。
if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  const store = new Map<string, string>()
  const localStorageMock = {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      store.set(key, String(value))
    },
    removeItem: (key: string): void => {
      store.delete(key)
    },
    clear: (): void => {
      store.clear()
    },
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size
    },
  }
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: false,
  })
}
