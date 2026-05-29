"use client";

import React, { useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight } from "lucide-react";

interface AnimatedButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  children?: React.ReactNode;
}

const AnimatedButton = ({ isLoading, children, className = "", ...props }: AnimatedButtonProps) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const sweepRef = useRef<HTMLSpanElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  useGSAP(
    () => {
      const btn = btnRef.current;
      if (!btn) return;

      const onEnter = () => {
        gsap.to(btn, { scale: 1.015, duration: 0.2, ease: "power2.out" });
        setIsHovered(true);
      };

      const onLeave = () => {
        gsap.to(btn, { scale: 1, duration: 0.25, ease: "power2.inOut" });
        setIsHovered(false);
      };

      const onDown = () => {
        gsap.to(btn, { scale: 0.98, duration: 0.08 });
      };

      const onUp = () => {
        gsap.to(btn, { scale: 1.015, duration: 0.15, ease: "back.out(2)" });
      };

      btn.addEventListener("mouseenter", onEnter);
      btn.addEventListener("mouseleave", onLeave);
      btn.addEventListener("mousedown", onDown);
      btn.addEventListener("mouseup", onUp);

      return () => {
        btn.removeEventListener("mouseenter", onEnter);
        btn.removeEventListener("mouseleave", onLeave);
        btn.removeEventListener("mousedown", onDown);
        btn.removeEventListener("mouseup", onUp);
      };
    },
    { scope: btnRef }
  );

  // Light sweep animation — runs continuously but visibility controlled by hover
  useGSAP(
    () => {
      const sweep = sweepRef.current;
      if (!sweep) return;

      const tween = gsap.fromTo(
        sweep,
        { x: "-100%" },
        { x: "300%", duration: 1.2, ease: "power1.inOut", repeat: -1, repeatDelay: 4 }
      );

      return () => tween.kill();
    },
    { scope: btnRef }
  );

  return (
    <div className="login-btn pt-2">
      <button
        ref={btnRef}
        type="submit"
        disabled={isLoading}
        className={`relative inline-flex w-full items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 py-2.5 text-sm font-medium text-white transition-shadow transition-colors duration-300 hover:from-blue-600 hover:to-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
          isHovered ? "shadow-lg shadow-blue-200 dark:shadow-black/30" : ""
        } ${className}`}
        {...props}
      >
        <span className="flex items-center justify-center">
          {children}
          <ArrowRight className="ml-2 h-4 w-4" />
        </span>
        <span
          ref={sweepRef}
          className="pointer-events-none absolute bottom-0 top-0 left-0 w-20 bg-gradient-to-r from-transparent via-white/30 to-transparent"
          style={{
            filter: "blur(8px)",
            opacity: isHovered ? 1 : 0,
            transition: "opacity 0.2s",
          }}
        />
      </button>
    </div>
  );
};

export default AnimatedButton;
