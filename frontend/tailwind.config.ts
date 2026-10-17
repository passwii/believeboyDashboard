import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: '1rem',
        sm: '1.25rem',
        lg: '1.5rem',
        xl: '2rem',
        '2xl': '2.5rem',
      },
      screens: {
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1536px',
        '3xl': '1920px',
      },
    },
    extend: {
      fontFamily: {
        sans: [
          'var(--font-sans)',
          /* 中文回退（BLF-809 字体族规范）：走系统默认，不引中文 webfont */
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'sans-serif',
        ],
        display: [
          'var(--font-display)',
          'var(--font-sans)',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          /* mono 场景里的中文（如 Footer 标签）稳定回退到系统黑体，不靠浏览器碰运气 */
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'monospace',
        ],
      },
      screens: {
        xs: '375px',
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1536px',
        '3xl': '1920px',
        tablet: '768px',
        'tablet-lg': '1024px',
        laptop: '1280px',
        'laptop-lg': '1440px',
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '128': '32rem',
      },
      minHeight: {
        'screen-dvh': '100dvh',
        touch: '44px',
        'touch-lg': '48px',
      },
      maxHeight: {
        'screen-dvh': '100dvh',
      },
      minWidth: {
        touch: '44px',
        'touch-lg': '48px',
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
        'collapsible-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-collapsible-content-height)',
          },
        },
        'collapsible-up': {
          from: {
            height: 'var(--radix-collapsible-content-height)',
          },
          to: {
            height: '0',
          },
        },
        /* `dialog-in` / `dialog-out` 已移除（Phase B）：Radix dialog / alert-dialog 的开合动效
         * 迁到 globals.css 的 `.ui-modal-motion` + `@keyframes ui-modal-in/out`，读 transitions.dev
         * 的 `--modal-open-dur` / `--modal-close-dur` / `--modal-scale` / `--modal-scale-close` /
         * `--modal-ease` 语义变量（见 frontend/docs/motion-system.md §7 Phase B）。 */
        /* `popup-in` / `tooltip-in` 已移除（Phase B）：Radix dropdown / popover / select / tooltip
         * 的开合动效迁到 globals.css 的 `.ui-floating-motion`（transitions.dev 05-menu-dropdown）
         * 与 `.ui-tooltip-motion`（17-tooltip）。 */
        /* `sheet-in-from-*` 已移除（Phase B）：Radix sheet 的滑入/滑出迁到 globals.css 的
         * `.ui-panel-motion`（transitions.dev 07-panel-reveal），按 `data-side` 选位移方向，
         * 读 `--panel-open-dur` / `--panel-close-dur` / `--panel-blur` / `--panel-ease`。
         * 旧的方向性过冲（ 70% -1.5% / 85% 0.4%）属历史自定义，按 snippet 不保留。 */
        /* ── Switch thumb overshoot ── */
        'switch-snap': {
          '0%': { transform: 'translateX(var(--switch-from))' },
          '60%': { transform: 'translateX(calc(var(--switch-to) + 3px))' },
          '80%': { transform: 'translateX(calc(var(--switch-to) - 0.5px))' },
          '100%': { transform: 'translateX(var(--switch-to))' },
        },
        /* [BEL-81.B] 搜索结果卡片入场动画 */
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        /* transitions.dev 21-accordion：展开 / 收起走 --acc-expand(250ms) / --acc-collapse(250ms)
         * / --acc-ease。snippet 本体用 grid-template-rows 0fr↔1fr；此处的 keyframe 等价地动
         * height（Radix 已提供 --radix-accordion-content-height，同样无需 JS 量高），故只换调参。 */
        'accordion-down': 'accordion-down var(--acc-expand) var(--acc-ease)',
        'accordion-up': 'accordion-up var(--acc-collapse) var(--acc-ease)',
        'collapsible-down': 'collapsible-down var(--duration-fast) var(--ease-smooth-out)',
        'collapsible-up': 'collapsible-up var(--duration-fast) var(--ease-smooth-out)',
        'switch-snap': 'switch-snap 280ms ease-out',
        'fade-in-up': 'fade-in-up 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        /* Terminal 高密度交易终端令牌（BLF-809），变量见 globals.css --term-* */
        term: {
          bg: 'var(--term-bg)',
          panel: 'var(--term-panel)',
          raised: 'var(--term-raised)',
          hover: 'var(--term-hover)',
          border: 'var(--term-border)',
          'border-strong': 'var(--term-border-strong)',
          text: 'var(--term-text)',
          muted: 'var(--term-muted)',
          placeholder: 'var(--term-placeholder)',
          faint: 'var(--term-faint)',
          pos: 'var(--term-pos)',
          action: 'var(--term-action)',
          'action-text': 'var(--term-action-text)',
          warn: 'var(--term-warn)',
          neg: 'var(--term-neg)',
          accent: 'var(--term-accent)',
          /* BLF-978 Stage 1：图表数据色 8 色（变量见 globals.css --term-chart-N） */
          'chart-1': 'var(--term-chart-1)',
          'chart-2': 'var(--term-chart-2)',
          'chart-3': 'var(--term-chart-3)',
          'chart-4': 'var(--term-chart-4)',
          'chart-5': 'var(--term-chart-5)',
          'chart-6': 'var(--term-chart-6)',
          'chart-7': 'var(--term-chart-7)',
          'chart-8': 'var(--term-chart-8)',
        },
      },
      borderRadius: {
        xl: 'var(--radius-xl)',
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
        xs: 'var(--radius-xs)',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
        'level-1': 'var(--shadow-level-1)',
        'level-2': 'var(--shadow-level-2)',
        'level-3': 'var(--shadow-level-3)',
        'level-4': 'var(--shadow-level-4)',
        'level-5': 'var(--shadow-level-5)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
