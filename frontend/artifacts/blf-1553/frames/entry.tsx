import React from 'react'
import { createRoot } from 'react-dom/client'
import { BelieveboyGlassReveal } from '@/components/brand/believeboy-glass-reveal'

/** 用组件自带的 `time` prop 冻结露出动画，得到确定性（可复现）的关键帧。 */
const TIMES = [0.3, 0.55, 0.85, 1.2, 1.7, 2.2, 2.65]

function Frames() {
  return (
    <div className="grid">
      {TIMES.map((t) => (
        <div className="cell" key={t}>
          <div className="frame">
            <BelieveboyGlassReveal
              variant="wing-cut"
              tone="light"
              time={t}
              loop={false}
              label={`Believeboy at ${t}s`}
            />
          </div>
          <span className="cap">t = {t}s</span>
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Frames />)
