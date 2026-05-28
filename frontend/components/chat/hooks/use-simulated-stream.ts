import { useRef, useCallback, useEffect } from 'react'

const DEMO_REPLY = `## 构建计划

很高兴为你规划！基于你的需求，我建议分三步走：

### 第一步：基础架构
- 搭建项目脚手架
- 配置路由与状态管理
- 设计组件层次

### 第二步：核心功能
- 实现数据流管道
- 对接 API 接口
- 添加错误边界处理

### 第三步：优化上线
- 性能调优与懒加载
- 单元测试覆盖
- CI/CD 部署

需要我先从哪一步开始？`

export function useSimulatedStream(onChunk: (delta: string) => void, onDone: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idxRef = useRef(0)
  const activeRef = useRef(false)

  const start = useCallback(() => {
    idxRef.current = 0
    activeRef.current = true

    const tick = () => {
      if (!activeRef.current || idxRef.current >= DEMO_REPLY.length) {
        activeRef.current = false
        onDone()
        return
      }
      const chunkSize = Math.random() < 0.1 ? 2 : 1
      const chunk = DEMO_REPLY.slice(idxRef.current, idxRef.current + chunkSize)
      idxRef.current += chunkSize
      onChunk(chunk)
      timerRef.current = setTimeout(tick, 25 + Math.random() * 15)
    }

    timerRef.current = setTimeout(tick, 500)
  }, [onChunk, onDone])

  const stop = useCallback(() => {
    activeRef.current = false
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  useEffect(() => () => stop(), [stop])

  return { start, stop }
}
