"use client";

import React, { useRef, useEffect, useState, useMemo, useCallback, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useGlobalLoading } from "@/components/global-loading-provider";
import { useLoginAnimations } from "./use-login-animations";
import LeftBrandPanel from "./left-brand-panel";
import RightFormPanel from "./right-form-panel";

const SIGNIN_LOADING_WATCHDOG_MS = 10000;

interface SignInCardProps {
  theme: "light" | "dark";
}

const SignInCard = ({ theme }: SignInCardProps) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingPendingRef = useRef(false);
  const loadingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = useMemo(() => searchParams.get("callbackUrl") || "/dashboard", [searchParams]);
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading();

  // GSAP entrance timeline
  useLoginAnimations(cardRef);

  // Warm the dashboard route's RSC payload + client chunks while the user is
  // still typing their credentials. `router.push` after a successful signIn
  // will hit the prefetched bundle, shaving 200–500ms off the navigation
  // transition — the time the user is staring at the spinner.
  useEffect(() => {
    router.prefetch(callbackUrl);
  }, [router, callbackUrl]);

  const finishNavigationLoading = useCallback(() => {
    if (!loadingPendingRef.current) return;
    loadingPendingRef.current = false;
    if (loadingWatchdogRef.current) {
      clearTimeout(loadingWatchdogRef.current);
      loadingWatchdogRef.current = null;
    }
    endGlobalLoading("navigation");
  }, [endGlobalLoading]);

  const beginNavigationLoading = useCallback(() => {
    if (loadingPendingRef.current) return;
    loadingPendingRef.current = true;
    startGlobalLoading("navigation");
    loadingWatchdogRef.current = setTimeout(() => {
      finishNavigationLoading();
    }, SIGNIN_LOADING_WATCHDOG_MS);
  }, [finishNavigationLoading, startGlobalLoading]);

  useEffect(() => {
    return () => {
      finishNavigationLoading();
    };
  }, [finishNavigationLoading]);

  const handleSignIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // NOTE: We intentionally do NOT start the global "navigation" spinner
    // here. The login HTTP round-trip itself is fast (~150–400ms server
    // side) and the button's local loading state is enough feedback for
    // that phase. Starting the navigation spinner now would cover the
    // upcoming `router.push` AND the preceding login — making the spinner
    // feel longer than it actually is. We start the navigation spinner
    // only at the moment we hand off to the router (see below).
    try {
      const result = await signIn("credentials", {
        email,
        password,
        callbackUrl,
        redirect: false,
      });

      const signInError = typeof result === "string" ? result : result?.error;
      if (signInError) {
        setSubmitting(false);
        const errorCode = signInError.toLowerCase();
        if (errorCode === "network_error") {
          setError("无法连接到服务器，请检查后端服务是否启动。");
        } else {
          setError("邮箱或密码错误，或账号已停用。");
        }
        return;
      }

      const fallbackPath = callbackUrl.startsWith("/") ? callbackUrl : "/dashboard";
      let nextPath = fallbackPath;
      if (result.url) {
        try {
          const target = new URL(result.url, window.location.origin);
          if (target.origin === window.location.origin) {
            nextPath = `${target.pathname}${target.search}${target.hash}`;
          }
        } catch {
          nextPath = fallbackPath;
        }
      }
      // Hand off to the router. Start the navigation spinner only now —
      // its job is to cover the dashboard RSC / client chunk load, not the
      // login HTTP we already finished.
      beginNavigationLoading();
      router.push(nextPath);
    } catch (err) {
      setSubmitting(false);
      setError("无法连接到服务器，请检查后端服务是否启动。");
      console.error("登录请求失败:", err);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center sm:px-2 md:px-4 lg:px-0">
      <div
        ref={cardRef}
        className="login-card flex w-full max-w-[min(92vw,56rem)] overflow-hidden rounded-none bg-white shadow-none sm:rounded-2xl sm:shadow-xl dark:bg-[hsl(var(--card))]"
        style={{ perspective: "1000px" }}
      >
        <LeftBrandPanel theme={theme} />
        <RightFormPanel
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          submitting={submitting}
          error={error}
          onSubmit={handleSignIn}
        />
      </div>
    </div>
  );
};

export default SignInCard;
