"use client";

import React, { useRef, useEffect, useState, useMemo } from "react";

type RouteMapStyle = "light" | "dark";

interface Dot {
  x: number;
  y: number;
  radius: number;
  baseOpacity: number;
  phase: number;
  color: number[];
}

interface Route {
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
  delay: number;
  color: string;
  glowColor: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

function getRoutes(width: number, height: number, style: RouteMapStyle): Route[] {
  const c = style === "dark"
    ? { primary: "#60a5fa", glow: "rgba(96, 165, 250, 0.35)" }
    : { primary: "#2563eb", glow: "rgba(59, 130, 246, 0.35)" };

  const s = (rx: number, ry: number) => ({ x: width * rx, y: height * ry });

  const routeDefs = [
    { start: s(0.12, 0.45), end: s(0.28, 0.2), delay: 0 },
    { start: s(0.28, 0.2), end: s(0.42, 0.38), delay: 2 },
    { start: s(0.08, 0.18), end: s(0.22, 0.55), delay: 1 },
    { start: s(0.5, 0.15), end: s(0.35, 0.55), delay: 0.5 },
    { start: s(0.55, 0.3), end: s(0.72, 0.2), delay: 1.5 },
    { start: s(0.7, 0.65), end: s(0.85, 0.4), delay: 2.5 },
    { start: s(0.4, 0.7), end: s(0.6, 0.45), delay: 3 },
  ];

  return routeDefs.map((r) => {
    const mx = (r.start.x + r.end.x) / 2;
    const my = (r.start.y + r.end.y) / 2;
    const dx = r.end.x - r.start.x;
    const dy = r.end.y - r.start.y;
    const offset = (Math.random() - 0.5) * 60;
    return {
      start: r.start,
      control: { x: mx - dy * 0.2 + offset, y: my + dx * 0.2 + offset },
      end: r.end,
      delay: r.delay,
      color: c.primary,
      glowColor: c.glow,
    };
  });
}

function generateDots(width: number, height: number, dark: boolean): Dot[] {
  const dots: Dot[] = [];
  const gap = 12;
  const baseColor = dark ? [96, 165, 250] : [37, 99, 235];

  for (let x = 0; x < width; x += gap) {
    for (let y = 0; y < height; y += gap) {
      const isInMapShape =
        (x < width * 0.25 && x > width * 0.05 && y < height * 0.4 && y > height * 0.1) ||
        (x < width * 0.25 && x > width * 0.15 && y < height * 0.8 && y > height * 0.4) ||
        (x < width * 0.45 && x > width * 0.3 && y < height * 0.35 && y > height * 0.15) ||
        (x < width * 0.5 && x > width * 0.35 && y < height * 0.65 && y > height * 0.35) ||
        (x < width * 0.7 && x > width * 0.45 && y < height * 0.5 && y > height * 0.1) ||
        (x < width * 0.8 && x > width * 0.65 && y < height * 0.8 && y > height * 0.6);

      if (isInMapShape && Math.random() > 0.3) {
        dots.push({
          x,
          y,
          radius: 1,
          baseOpacity: Math.random() * 0.5 + 0.2,
          phase: Math.random() * Math.PI * 2,
          color: baseColor,
        });
      }
    }
  }
  return dots;
}

function quadBezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number }
) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

const DotMapCanvas = ({ theme = "light" }: { theme?: "light" | "dark" }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const isDark = theme === "dark";

  // Store stable references to avoid re-creating animation on theme change
  const stateRef = useRef({
    dots: [] as Dot[],
    routes: [] as Route[],
    particles: [] as Particle[],
    startTime: 0,
    lastRouteCompleted: new Set<number>(),
  });

  // Regenerate dots and routes when dimensions or theme change
  useEffect(() => {
    if (!dimensions.width || !dimensions.height) return;
    stateRef.current.dots = generateDots(dimensions.width, dimensions.height, isDark);
    stateRef.current.routes = getRoutes(dimensions.width, dimensions.height, isDark ? "dark" : "light");
    stateRef.current.lastRouteCompleted.clear();
  }, [dimensions, isDark]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
      canvas.width = width;
      canvas.height = height;
    });

    resizeObserver.observe(canvas.parentElement as Element);
    return () => resizeObserver.disconnect();
  }, []);

  // Animation loop
  useEffect(() => {
    if (!dimensions.width || !dimensions.height) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const state = stateRef.current;
    if (!state.startTime) state.startTime = performance.now();

    let animationFrameId: number;

    const colors = isDark
      ? {
          dotColor: (o: number) => `rgba(96, 165, 250, ${o})`,
          movingDot: "#93c5fd",
          routeColor: "#60a5fa",
        }
      : {
          dotColor: (o: number) => `rgba(37, 99, 235, ${o})`,
          movingDot: "#3b82f6",
          routeColor: "#2563eb",
        };

    function animate() {
      const { width, height } = dimensions;
      ctx!.clearRect(0, 0, width, height);

      const now = performance.now();
      const elapsed = (now - state.startTime) / 1000;
      const breathSpeed = 0.3;
      const breathAmp = 0.05;

      // Draw dots with breathing effect
      for (const dot of state.dots) {
        const opacity = dot.baseOpacity + breathAmp * Math.sin(elapsed * breathSpeed + dot.phase);
        ctx!.beginPath();
        ctx!.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        ctx!.fillStyle = colors.dotColor(Math.max(0, Math.min(1, opacity)));
        ctx!.fill();
      }

      // Draw routes with curved paths
      const routeDuration = 3;
      const cycleDuration = 12;

      for (let i = 0; i < state.routes.length; i++) {
        const route = state.routes[i];
        const cycleElapsed = ((elapsed - route.delay) % cycleDuration + cycleDuration) % cycleDuration;
        if (cycleElapsed > routeDuration + 1) continue;

        const progress = Math.min(cycleElapsed / routeDuration, 1);
        const pos = quadBezierPoint(progress, route.start, route.control, route.end);

        // Draw trail (series of short segments with decreasing opacity)
        const trailSegments = 20;
        for (let t = 0; t < trailSegments; t++) {
          const t0 = Math.max(0, progress - (t + 1) * (progress / trailSegments));
          const t1 = Math.max(0, progress - t * (progress / trailSegments));
          if (t0 >= t1) continue;

          const p0 = quadBezierPoint(t0, route.start, route.control, route.end);
          const p1 = quadBezierPoint(t1, route.start, route.control, route.end);

          ctx!.beginPath();
          ctx!.moveTo(p0.x, p0.y);
          ctx!.lineTo(p1.x, p1.y);
          ctx!.strokeStyle = route.color;
          ctx!.globalAlpha = (1 - t / trailSegments) * 0.6;
          ctx!.lineWidth = 1.5;
          ctx!.stroke();
        }
        ctx!.globalAlpha = 1;

        // Origin dot
        ctx!.beginPath();
        ctx!.arc(route.start.x, route.start.y, 3, 0, Math.PI * 2);
        ctx!.fillStyle = route.color;
        ctx!.fill();

        // Moving dot with pulsing glow
        const glowRadius = 6 + 3 * Math.sin(elapsed * 2 + i);
        ctx!.beginPath();
        ctx!.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
        ctx!.fillStyle = route.glowColor;
        ctx!.fill();

        ctx!.beginPath();
        ctx!.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
        ctx!.fillStyle = colors.movingDot;
        ctx!.fill();

        // Endpoint dot when reached
        if (progress >= 1) {
          ctx!.beginPath();
          ctx!.arc(route.end.x, route.end.y, 3, 0, Math.PI * 2);
          ctx!.fillStyle = route.color;
          ctx!.fill();

          // Spawn particles on route completion (once per cycle)
          if (!state.lastRouteCompleted.has(i)) {
            state.lastRouteCompleted.add(i);
            const particleCount = 5 + Math.floor(Math.random() * 4);
            for (let p = 0; p < particleCount; p++) {
              const angle = (Math.PI * 2 * p) / particleCount + Math.random() * 0.5;
              const speed = 30 + Math.random() * 20;
              state.particles.push({
                x: route.end.x,
                y: route.end.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 0,
                maxLife: 0.6 + Math.random() * 0.3,
                color: route.color,
              });
            }
          }
        }
      }

      // Reset route completion tracking on new cycle
      if (elapsed % cycleDuration < 0.05) {
        state.lastRouteCompleted.clear();
      }

      // Draw particles
      const dt = 1 / 60;
      for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.life += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;

        const lifeRatio = p.life / p.maxLife;
        if (lifeRatio >= 1) {
          state.particles.splice(i, 1);
          continue;
        }

        const alpha = 1 - lifeRatio;
        const size = 2 * (1 - lifeRatio * 0.5);
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx!.fillStyle = p.color;
        ctx!.globalAlpha = alpha * 0.7;
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      animationFrameId = requestAnimationFrame(animate);
    }

    animate();
    return () => cancelAnimationFrame(animationFrameId);
  }, [dimensions, isDark]);

  return (
    <div className="dot-map-canvas absolute inset-0 h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
};

export default DotMapCanvas;
