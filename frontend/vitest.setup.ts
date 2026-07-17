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
