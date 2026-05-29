"use client";

import React from "react";
import { ArrowRight } from "lucide-react";
import DotMapCanvas from "./dot-map-canvas";

interface LeftBrandPanelProps {
  theme: "light" | "dark";
}

const LeftBrandPanel = ({ theme }: LeftBrandPanelProps) => {
  const leftPanelGradient = theme === "dark"
    ? "from-[hsl(220_25%_8%)] to-[hsl(233_30%_12%)]"
    : "from-blue-50 to-indigo-100";

  return (
    <div className="relative hidden h-[clamp(400px,70vh,600px)] w-1/2 overflow-hidden border-r border-gray-100 dark:border-[hsl(var(--border))] lg:block">
      <div className={`absolute inset-0 bg-gradient-to-br ${leftPanelGradient}`}>
        <DotMapCanvas theme={theme} />
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-8">
          <div className="left-brand-logo mb-6 opacity-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-200 dark:shadow-black/40">
              <ArrowRight className="h-6 w-6 text-white" />
            </div>
          </div>
          <h2 className="left-brand-title mb-2 bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-center text-3xl font-bold text-transparent opacity-0 dark:from-blue-400 dark:to-indigo-400">
            彼励扶跨境
          </h2>
          <p className="left-brand-subtitle max-w-xs text-center text-sm text-gray-600 opacity-0 dark:text-[hsl(var(--muted-foreground))]">
            我们专注跨境品牌服务，帮助企业做好跨境销售与全球推广
          </p>
        </div>
      </div>
    </div>
  );
};

export default LeftBrandPanel;
