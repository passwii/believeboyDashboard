/**
 * 强制暗色展示页（数字大屏 / 投屏）在挂载期间把根节点固定为暗色。
 * next-themes 用 html 的 light / dark class 表达主题；仅 add('dark') 会留下
 * `class="light dark"`，使 html.light .warm-ledger 的浅色 token 继续命中。
 * 因此这里同时移除 light，并在卸载时恢复进入前的 class 与 color-scheme。
 */
export function forceDarkDocument(): () => void {
  if (typeof document === 'undefined') return () => {}

  const root = document.documentElement
  const previousClass = root.getAttribute('class')
  const previousColorScheme = root.style.colorScheme

  root.classList.remove('light')
  root.classList.add('dark')
  root.style.colorScheme = 'dark'

  return () => {
    root.classList.remove('dark')
    if (previousClass === null) root.removeAttribute('class')
    else root.setAttribute('class', previousClass)
    root.style.colorScheme = previousColorScheme
  }
}
