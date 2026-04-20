"use client";

import React, { useRef, useEffect, useState, useMemo, useCallback, type FormEvent } from "react";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useGlobalLoading } from "@/components/global-loading-provider";

const SIGNIN_LOADING_WATCHDOG_MS = 30000;

const cn = (...classes: string[]) => {
  return classes.filter(Boolean).join(" ");
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: "default" | "outline";
  className?: string;
}

const Button = ({ children, variant = "default", className = "", ...props }: ButtonProps) => {
  const baseStyles =
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

  const variantStyles = {
    default:
      "bg-primary bg-gradient-to-r from-blue-500 to-indigo-600 text-white hover:from-blue-600 hover:to-indigo-700",
    outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
  };

  return (
    <button className={`${baseStyles} ${variantStyles[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

const Input = ({ className = "", ...props }: InputProps) => {
  return (
    <input
      className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm text-gray-800 ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
};

type RoutePoint = {
  x: number;
  y: number;
  delay: number;
};

const routes: { start: RoutePoint; end: RoutePoint; color: string }[] = [
  {
    start: { x: 100, y: 150, delay: 0 },
    end: { x: 200, y: 80, delay: 2 },
    color: "#2563eb",
  },
  {
    start: { x: 200, y: 80, delay: 2 },
    end: { x: 260, y: 120, delay: 4 },
    color: "#2563eb",
  },
  {
    start: { x: 50, y: 50, delay: 1 },
    end: { x: 150, y: 180, delay: 3 },
    color: "#2563eb",
  },
  {
    start: { x: 280, y: 60, delay: 0.5 },
    end: { x: 180, y: 180, delay: 2.5 },
    color: "#2563eb",
  },
];

const DotMap = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const generateDots = (width: number, height: number) => {
    const dots = [];
    const gap = 12;
    const dotRadius = 1;

    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const isInMapShape =
          ((x < width * 0.25 && x > width * 0.05) && (y < height * 0.4 && y > height * 0.1)) ||
          ((x < width * 0.25 && x > width * 0.15) && (y < height * 0.8 && y > height * 0.4)) ||
          ((x < width * 0.45 && x > width * 0.3) && (y < height * 0.35 && y > height * 0.15)) ||
          ((x < width * 0.5 && x > width * 0.35) && (y < height * 0.65 && y > height * 0.35)) ||
          ((x < width * 0.7 && x > width * 0.45) && (y < height * 0.5 && y > height * 0.1)) ||
          ((x < width * 0.8 && x > width * 0.65) && (y < height * 0.8 && y > height * 0.6));

        if (isInMapShape && Math.random() > 0.3) {
          dots.push({
            x,
            y,
            radius: dotRadius,
            opacity: Math.random() * 0.5 + 0.2,
          });
        }
      }
    }
    return dots;
  };

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

  useEffect(() => {
    if (!dimensions.width || !dimensions.height) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ctxRef = ctx; // Store in a local variable for closures

    const dots = generateDots(dimensions.width, dimensions.height);
    let animationFrameId: number;
    let startTime = Date.now();

    function drawDots() {
      ctxRef.clearRect(0, 0, dimensions.width, dimensions.height);
      dots.forEach((dot) => {
        ctxRef.beginPath();
        ctxRef.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        ctxRef.fillStyle = `rgba(37, 99, 235, ${dot.opacity})`;
        ctxRef.fill();
      });
    }

    function drawRoutes() {
      const currentTime = (Date.now() - startTime) / 1000;
      routes.forEach((route) => {
        const elapsed = currentTime - route.start.delay;
        if (elapsed <= 0) return;

        const duration = 3;
        const progress = Math.min(elapsed / duration, 1);
        const x = route.start.x + (route.end.x - route.start.x) * progress;
        const y = route.start.y + (route.end.y - route.start.y) * progress;

        ctxRef.beginPath();
        ctxRef.moveTo(route.start.x, route.start.y);
        ctxRef.lineTo(x, y);
        ctxRef.strokeStyle = route.color;
        ctxRef.lineWidth = 1.5;
        ctxRef.stroke();

        ctxRef.beginPath();
        ctxRef.arc(route.start.x, route.start.y, 3, 0, Math.PI * 2);
        ctxRef.fillStyle = route.color;
        ctxRef.fill();

        ctxRef.beginPath();
        ctxRef.arc(x, y, 3, 0, Math.PI * 2);
        ctxRef.fillStyle = "#3b82f6";
        ctxRef.fill();

        ctxRef.beginPath();
        ctxRef.arc(x, y, 6, 0, Math.PI * 2);
        ctxRef.fillStyle = "rgba(59, 130, 246, 0.4)";
        ctxRef.fill();

        if (progress === 1) {
          ctxRef.beginPath();
          ctxRef.arc(route.end.x, route.end.y, 3, 0, Math.PI * 2);
          ctxRef.fillStyle = route.color;
          ctxRef.fill();
        }
      });
    }

    function animate() {
      drawDots();
      drawRoutes();

      const currentTime = (Date.now() - startTime) / 1000;
      if (currentTime > 15) {
        startTime = Date.now();
      }
      animationFrameId = requestAnimationFrame(animate);
    }

    animate();
    return () => cancelAnimationFrame(animationFrameId);
  }, [dimensions]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
};

const SignInCard = () => {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isHovered, setIsHovered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingPendingRef = useRef(false);
  const loadingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = useMemo(() => searchParams.get("callbackUrl") || "/dashboard", [searchParams]);
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading();

  const finishNavigationLoading = useCallback(() => {
    if (!loadingPendingRef.current) return;
    loadingPendingRef.current = false;
    if (loadingWatchdogRef.current) {
      clearTimeout(loadingWatchdogRef.current);
      loadingWatchdogRef.current = null;
    }
    endGlobalLoading('navigation');
  }, [endGlobalLoading]);

  const beginNavigationLoading = useCallback(() => {
    if (loadingPendingRef.current) return;
    loadingPendingRef.current = true;
    startGlobalLoading('navigation');
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
    beginNavigationLoading();

    try {
      const result = await signIn("credentials", {
        email,
        password,
        callbackUrl,
        redirect: false,
      });
      if (!result || result.error) {
        setSubmitting(false);
        finishNavigationLoading();
        setError("邮箱或密码错误，或账号已停用。");
        return;
      }

      const fallbackPath = callbackUrl.startsWith("/") ? callbackUrl : "/dashboard";
      let nextPath = fallbackPath;
      if (result.url) {
        try {
          const target = new URL(result.url, window.location.origin);
          // Prevent wrong NEXTAUTH_URL (e.g. localhost in production) from forcing cross-origin redirects.
          if (target.origin === window.location.origin) {
            nextPath = `${target.pathname}${target.search}${target.hash}`;
          }
        } catch {
          nextPath = fallbackPath;
        }
      }
      router.push(nextPath);
      router.refresh();
    } catch {
      setSubmitting(false);
      finishNavigationLoading();
      setError("邮箱或密码错误，或账号已停用。");
      return;
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center px-2 sm:px-0">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="flex w-full max-w-[min(90vw,56rem)] overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="relative hidden h-[clamp(400px,70vh,600px)] w-1/2 overflow-hidden border-r border-gray-100 lg:block">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-indigo-100">
            <DotMap />
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-8">
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6, duration: 0.5 }}
                className="mb-6"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-200">
                  <ArrowRight className="h-6 w-6 text-white" />
                </div>
              </motion.div>
              <motion.h2
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="mb-2 bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-center text-3xl font-bold text-transparent"
              >
                彼励扶跨境
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8, duration: 0.5 }}
                className="max-w-xs text-center text-sm text-gray-600"
              >
                我们专注跨境品牌服务，帮助企业做好跨境销售与全球推广
              </motion.p>
            </div>
          </div>
        </div>

        <div className="flex w-full flex-col justify-center bg-white p-6 sm:p-8 lg:p-10 xl:w-1/2">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <h1 className="mb-1 text-2xl font-bold text-gray-800 md:text-3xl">欢迎登录</h1>
            <p className="mb-8 text-gray-500">为跨境销售与全球推广团队提供高效、可执行的品牌增长支持</p>

            <form className="space-y-5" onSubmit={handleSignIn}>
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
                  企业邮箱 <span className="text-blue-500">*</span>
                </label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="请输入企业邮箱"
                  required
                  autoComplete="email"
                  className="w-full border-gray-200 bg-gray-50 text-gray-800 placeholder:text-gray-400 focus:border-blue-500 focus:ring-blue-500"
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
                  登录密码 <span className="text-blue-500">*</span>
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type={isPasswordVisible ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入登录密码"
                    required
                    autoComplete="current-password"
                    className="w-full border-gray-200 bg-gray-50 pr-10 text-gray-800 placeholder:text-gray-400 focus:border-blue-500 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-700"
                    onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                    aria-label={isPasswordVisible ? "隐藏密码" : "显示密码"}
                  >
                    {isPasswordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <AnimatePresence>
                {error ? (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600"
                  >
                    {error}
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <motion.div
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onHoverStart={() => setIsHovered(true)}
                onHoverEnd={() => setIsHovered(false)}
                className="pt-2"
              >
                <Button
                  type="submit"
                  disabled={submitting}
                  className={cn(
                    "relative w-full overflow-hidden rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 py-2 text-white transition-all duration-300 hover:from-blue-600 hover:to-indigo-700",
                    isHovered ? "shadow-lg shadow-blue-200" : ""
                  )}
                >
                  <span className="flex items-center justify-center">
                    {submitting ? "登录中..." : "立即登录"}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </span>
                  {isHovered && !submitting ? (
                    <motion.span
                      initial={{ left: "-100%" }}
                      animate={{ left: "100%" }}
                      transition={{ duration: 1, ease: "easeInOut" }}
                      className="absolute bottom-0 top-0 left-0 w-20 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                      style={{ filter: "blur(8px)" }}
                    />
                  ) : null}
                </Button>
              </motion.div>

              <p className="pt-1 text-center text-sm font-medium text-blue-700">品牌跨境，连接全球</p>
            </form>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
};

const Index = () => {
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:px-6 md:px-8"
      style={{
        backgroundImage:
          "linear-gradient(to bottom right, rgba(239,246,255,0.95), rgba(224,231,255,0.95)), url('https://images.unsplash.com/photo-1488085061387-422e29b40080?auto=format&fit=crop&w=1800&q=80')",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <SignInCard />
    </div>
  );
};

export default Index;
