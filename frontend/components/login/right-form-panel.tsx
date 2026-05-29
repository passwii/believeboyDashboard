"use client";

import React, { useRef, useCallback, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import AnimatedButton from "./animated-button";
import AnimatedError from "./animated-error";

interface RightFormPanelProps {
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

const RightFormPanel = ({
  email,
  setEmail,
  password,
  setPassword,
  submitting,
  error,
  onSubmit,
}: RightFormPanelProps) => {
  const formRef = useRef<HTMLDivElement>(null);
  const [isPasswordVisible, setIsPasswordVisible] = React.useState(false);

  // Input focus micro-animation: label color shift + border highlight
  useGSAP(
    () => {
      const form = formRef.current;
      if (!form) return;

      const inputs = form.querySelectorAll<HTMLInputElement>("input");

      const cleanups: (() => void)[] = [];

      inputs.forEach((input) => {
        const label = input.closest("div")?.querySelector("label");

        const onFocus = () => {
          gsap.to(input, {
            borderColor: "hsl(214, 89%, 53%)",
            duration: 0.25,
            ease: "power2.out",
          });
          if (label) {
            gsap.to(label, { color: "hsl(214, 89%, 43%)", duration: 0.2 });
          }
        };

        const onBlur = () => {
          gsap.to(input, {
            borderColor: "",
            duration: 0.3,
            ease: "power2.inOut",
          });
          if (label) {
            gsap.to(label, { color: "", duration: 0.3 });
          }
        };

        input.addEventListener("focus", onFocus);
        input.addEventListener("blur", onBlur);

        cleanups.push(() => {
          input.removeEventListener("focus", onFocus);
          input.removeEventListener("blur", onBlur);
        });
      });

      return () => cleanups.forEach((fn) => fn());
    },
    { scope: formRef }
  );

  return (
    <div
      ref={formRef}
      className="flex w-full flex-col justify-center bg-white p-6 sm:p-8 lg:p-10 xl:w-1/2 dark:bg-[hsl(var(--card))]"
      style={{ perspective: "800px" }}
    >
      <div>
        <h1 className="right-heading mb-1 text-2xl font-bold text-gray-800 opacity-0 dark:text-[hsl(var(--card-foreground))] md:text-3xl">
          欢迎登录
        </h1>
        <p className="right-subheading mb-8 text-gray-500 opacity-0 dark:text-[hsl(var(--muted-foreground))]">
          为跨境销售与全球推广团队提供高效、可执行的品牌增长支持
        </p>

        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="login-form-field opacity-0">
            <label
              htmlFor="email"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-[hsl(var(--foreground))]"
            >
              企业邮箱 <span className="text-blue-500">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="请输入企业邮箱"
              required
              autoComplete="email"
              className="flex h-10 w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[hsl(var(--border))] dark:bg-[hsl(var(--muted))] dark:text-[hsl(var(--foreground))] dark:placeholder:text-[hsl(var(--muted-foreground))]"
            />
          </div>

          <div className="login-form-field opacity-0">
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-[hsl(var(--foreground))]"
            >
              登录密码 <span className="text-blue-500">*</span>
            </label>
            <div className="relative">
              <input
                id="password"
                type={isPasswordVisible ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入登录密码"
                required
                autoComplete="current-password"
                className="flex h-10 w-full rounded-md border border-gray-200 bg-gray-50 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[hsl(var(--border))] dark:bg-[hsl(var(--muted))] dark:text-[hsl(var(--foreground))] dark:placeholder:text-[hsl(var(--muted-foreground))]"
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700 dark:text-[hsl(var(--muted-foreground))] dark:hover:text-[hsl(var(--foreground))]"
                onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                aria-label={isPasswordVisible ? "隐藏密码" : "显示密码"}
              >
                {isPasswordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="login-form-field opacity-0">
            <AnimatedError message={error} />
          </div>

          <AnimatedButton type="submit" isLoading={submitting}>
            {submitting ? "登录中..." : "立即登录"}
          </AnimatedButton>

          <p className="login-form-field pt-1 text-center text-sm font-medium text-blue-700 opacity-0 dark:text-blue-400">
            品牌跨境，连接全球
          </p>
        </form>
      </div>
    </div>
  );
};

export default RightFormPanel;
