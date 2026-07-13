'use client'

import { useRef } from 'react'

export function FloatingParticles() {
  const particles = useRef([
    {
      size: 2,
      x: '15%',
      y: '20%',
      dur: 6,
      delay: 0,
      opacity: 0.3,
      dx: [8, -6, 4],
      dy: [-12, 10, 6],
    },
    {
      size: 1.5,
      x: '80%',
      y: '15%',
      dur: 8,
      delay: 1,
      opacity: 0.2,
      dx: [11, -8, 6],
      dy: [-14, 13, 8],
    },
    {
      size: 1,
      x: '25%',
      y: '70%',
      dur: 7,
      delay: 2,
      opacity: 0.25,
      dx: [14, -10, 8],
      dy: [-16, 16, 10],
    },
    {
      size: 2,
      x: '70%',
      y: '75%',
      dur: 9,
      delay: 0.5,
      opacity: 0.15,
      dx: [17, -12, 10],
      dy: [-18, 19, 12],
    },
    {
      size: 1.5,
      x: '50%',
      y: '30%',
      dur: 10,
      delay: 3,
      opacity: 0.2,
      dx: [20, -14, 12],
      dy: [-20, 22, 14],
    },
    {
      size: 1,
      x: '90%',
      y: '50%',
      dur: 6.5,
      delay: 1.5,
      opacity: 0.3,
      dx: [23, -16, 14],
      dy: [-22, 25, 16],
    },
    {
      size: 1.5,
      x: '10%',
      y: '55%',
      dur: 7.5,
      delay: 2.5,
      opacity: 0.2,
      dx: [26, -18, 16],
      dy: [-24, 28, 18],
    },
  ]).current

  const keyframesCSS = particles
    .map(
      (p, i) => `
      @keyframes bb-float-${i} {
        0%, 100% { transform: translate(0, 0); opacity: ${p.opacity}; }
        25%  { transform: translate(${p.dx[0]}px, ${p.dy[0]}px); opacity: ${p.opacity * 1.5}; }
        50%  { transform: translate(${p.dx[1]}px, ${p.dy[1]}px); opacity: ${p.opacity * 0.7}; }
        75%  { transform: translate(${p.dx[2]}px, ${p.dy[2]}px); opacity: ${p.opacity * 1.2}; }
      }
    `
    )
    .join('\n')

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <style dangerouslySetInnerHTML={{ __html: keyframesCSS }} />
      {particles.map((p, i) => (
        <div
          key={i}
          className="absolute rounded-full bg-blue-400"
          style={{
            width: p.size,
            height: p.size,
            left: p.x,
            top: p.y,
            opacity: p.opacity,
            animation: `bb-float-${i} ${p.dur}s ease-in-out ${p.delay}s infinite`,
          }}
        />
      ))}
    </div>
  )
}
