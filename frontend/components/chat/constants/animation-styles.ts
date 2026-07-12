export const animationStyles = `
  @keyframes bb-fade-up {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes bb-scale-in {
    from { opacity: 0; transform: scale(0.92); }
    to   { opacity: 1; transform: scale(1); }
  }
  @keyframes bb-glow-pulse {
    0%, 100% { opacity: 1;   transform: translateX(-50%) scale(1);    }
    50%      { opacity: 0.45; transform: translateX(-50%) scale(1.06); }
  }
  @keyframes bb-glow-pulse-secondary {
    0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1.03); }
    50%      { opacity: 1;    transform: translateX(-50%) scale(0.97); }
  }
  @keyframes bb-cursor-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0; }
  }
  @keyframes bb-border-rotate {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes bb-glow-intensity {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.7; }
  }
  @keyframes bb-arcs-entrance {
    0%   { opacity: 0; transform: translateX(-50%) rotate(180deg) scale(0.85); }
    60%  { opacity: 1; transform: translateX(-50%) rotate(180deg) scale(1.02); }
    100% { opacity: 1; transform: translateX(-50%) rotate(180deg) scale(1); }
  }
  @keyframes bb-chat-enter {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes bb-sidebar-in {
    from { opacity: 0; transform: translateX(-100%); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes bb-stop-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
    50%      { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
  }

  .bb-anim-fade-up {
    opacity: 0;
    animation: bb-fade-up 0.8s var(--motion-ease-standard) forwards;
  }
  .bb-anim-scale-in {
    opacity: 0;
    animation: bb-scale-in 0.6s var(--motion-ease-standard) forwards;
  }
  .bb-glow-pulse {
    animation: bb-glow-pulse 4s ease-in-out infinite;
    will-change: opacity, transform;
  }
  .bb-glow-pulse-secondary {
    animation: bb-glow-pulse-secondary 4.8s ease-in-out infinite;
    will-change: opacity, transform;
  }
  .bb-border-rotate {
    animation: bb-border-rotate 15s linear infinite;
  }
  .bb-glow-intensity {
    animation: bb-glow-intensity 2s ease-in-out infinite;
  }
  .bb-cursor-blink {
    animation: bb-cursor-blink 0.8s step-end infinite;
  }
  .bb-arcs-entrance {
    animation: bb-arcs-entrance 1.2s var(--motion-ease-standard) 0.2s both;
  }
  .bb-chat-enter {
    animation: bb-chat-enter 0.5s var(--motion-ease-standard) forwards;
  }
  .bb-anim-sidebar {
    animation: bb-sidebar-in 0.35s var(--motion-ease-standard) forwards;
  }
  .bb-stop-pulse {
    animation: bb-stop-pulse 1.5s ease-in-out infinite;
  }

  /* Message list entrance */
  @keyframes bb-fade-slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-slide-up {
    animation: bb-fade-slide-up 0.4s var(--motion-ease-standard) forwards;
  }

  /* Mobile Safe Area Support */
  .safe-area-inset-top {
    padding-top: env(safe-area-inset-top);
  }
  .safe-area-inset-bottom {
    padding-bottom: env(safe-area-inset-bottom);
  }
  .safe-area-inset-left {
    padding-left: env(safe-area-inset-left);
  }
  .safe-area-inset-right {
    padding-right: env(safe-area-inset-right);
  }

  /* Mobile-specific adjustments */
  @media (max-width: 640px) {
    .bb-mobile-full {
      height: 100dvh;
      height: 100vh;
    }
    .bb-mobile-input {
      max-height: 60vh;
    }
  }
`
