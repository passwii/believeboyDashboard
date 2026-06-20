import { cn } from "@/lib/utils";

/**
 * Custom BLF loading animation.
 *
 * 思路移植自"circle / triangle / rect"loader-2 套件，但把三段动画
 * 迁移到字母 B / L / F 上。B 走"左竖 + 双弧"轮廓，L 走"直角折线"，
 * F 走"顶横 + 左竖 + 中横"三笔。三段动画时长一致、循环同步，
 * 颜色走 --clr / --bkg 适配 dark mode。
 *
 * 注意：这是 demo 组件，仅用于在某个具体页面/区块展示动画效果。
 * 不要替换项目里已有的 GlobalLoadingOverlay 等全局 loading 组件。
 */
export const Component = ({ className }: { className?: string }) => {
  return (
    <div
      className={cn("blf-loader-row", className)}
      role="status"
      aria-label="加载中"
    >
      <div className="blf-loader">
        <svg viewBox="0 0 80 80" className="blf-svg" aria-hidden="true">
          {/* B 轮廓：左竖 + 下弧 + 中横回描 + 上弧 + 顶横回起点 */}
          <path
            d="M 14 8 L 14 72 L 36 72 C 56 72 56 40 36 40 L 14 40 L 36 40 C 56 40 56 8 36 8 L 14 8 Z"
            className="blf-path blf-path-b"
          />
          <circle cx="14" cy="8" r="3" className="blf-dot blf-dot-b" />
        </svg>
      </div>

      <div className="blf-loader">
        <svg viewBox="0 0 80 80" className="blf-svg" aria-hidden="true">
          {/* L 折线：上→下→右下 */}
          <path d="M 24 8 L 24 72 L 64 72" className="blf-path blf-path-l" />
          <circle cx="24" cy="8" r="3" className="blf-dot blf-dot-l" />
        </svg>
      </div>

      <div className="blf-loader">
        <svg viewBox="0 0 80 80" className="blf-svg" aria-hidden="true">
          {/* F 笔画：右上→左上→左下（主笔），M 子路径跳到中横右上→中横左 */}
          <path
            d="M 64 8 L 16 8 L 16 72 M 48 40 L 16 40"
            className="blf-path blf-path-f"
          />
          <circle cx="64" cy="8" r="3" className="blf-dot blf-dot-f" />
        </svg>
      </div>
    </div>
  );
};

export const BLFLoader = Component;
export default Component;
