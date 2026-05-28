'use client'

export function RayBackground({ arcsUp }: { arcsUp?: boolean }) {
  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none select-none">
      <div className="absolute inset-0 bg-[#0f0f0f]" />

      {/* Primary glow — blue core */}
      <div
        className="absolute left-1/2 w-[4000px] h-[1800px] sm:w-[6000px] bb-glow-pulse"
        style={{
          background: `radial-gradient(circle at center 800px, rgba(20, 136, 252, 0.9) 0%, rgba(20, 136, 252, 0.4) 14%, rgba(20, 136, 252, 0.2) 18%, rgba(20, 136, 252, 0.1) 22%, rgba(17, 17, 20, 0.2) 28%)`
        }}
      />

      {/* Secondary glow — violet wash */}
      <div
        className="absolute left-1/2 w-[4000px] h-[1600px] sm:w-[5500px] bb-glow-pulse-secondary"
        style={{
          background: `radial-gradient(ellipse at center 700px, rgba(99, 102, 241, 0.35) 0%, rgba(139, 92, 246, 0.15) 12%, rgba(20, 136, 252, 0.08) 20%, transparent 30%)`
        }}
      />

      {/* Horizon glow */}
      <div
        className="absolute left-1/2 w-[5000px] h-[300px] sm:w-[7000px] bb-glow-pulse"
        style={{
          top: '48%',
          background: `radial-gradient(ellipse at center, rgba(56, 189, 248, 0.18) 0%, rgba(20, 136, 252, 0.08) 40%, transparent 70%)`,
          animationDelay: '2s',
        }}
      />

      {/* Concentric arcs — translate upward on arcsUp to expand black fill */}
      <div
        className="absolute left-1/2 w-[1600px] h-[1600px] sm:w-[3043px] sm:h-[2865px] bb-arcs-entrance"
        style={{
          transform: 'translateX(-50%) rotate(180deg)',
          top: arcsUp ? '-30%' : '50%',
          transition: 'top 0.8s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="absolute w-full h-full rounded-full -mt-[13px]" style={{ background: 'radial-gradient(43.89% 25.74% at 50.02% 97.24%, #111114 0%, #0f0f0f 100%)', border: '16px solid white', transform: 'rotate(180deg)', zIndex: 5 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[11px]" style={{ border: '23px solid #b7d7f6', transform: 'rotate(180deg)', zIndex: 4 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[8px]" style={{ border: '23px solid #8fc1f2', transform: 'rotate(180deg)', zIndex: 3 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[4px]" style={{ border: '23px solid #64acf6', transform: 'rotate(180deg)', zIndex: 2 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f]" style={{ border: '20px solid #1172e2', boxShadow: '0 -15px 24.8px rgba(17, 114, 226, 0.6)', transform: 'rotate(180deg)', zIndex: 1 }} />
      </div>
    </div>
  )
}
