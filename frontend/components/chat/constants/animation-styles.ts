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

  .bb-anim-fade-up {
    opacity: 0;
    animation: bb-fade-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .bb-anim-scale-in {
    opacity: 0;
    animation: bb-scale-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
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
    animation: bb-arcs-entrance 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both;
  }
  .bb-chat-enter {
    animation: bb-chat-enter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
`
