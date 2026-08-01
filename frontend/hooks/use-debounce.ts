import { useEffect, useState } from 'react'

/** 返回 value 的防抖版本：value 变化后 delay ms 内不再变化才更新。 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
