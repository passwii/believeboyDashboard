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
        'dialog-in': {
          '0%': {
            opacity: '0',
            transform: 'translate(-50%, -48%) scale(0.96)',
          },
          '60%': {
            opacity: '1',
            transform: 'translate(-50%, -50.4%) scale(1.012)',
          },
          '80%': {
            transform: 'translate(-50%, -49.8%) scale(0.998)',
          },
          '100%': {
            opacity: '1',
            transform: 'translate(-50%, -50%) scale(1)',
          },
        },
        'dialog-out': {
          from: {
            opacity: '1',
            transform: 'translate(-50%, -50%) scale(1)',
          },
          to: {
            opacity: '0',
            transform: 'translate(-50%, -48%) scale(0.96)',
          },
        },
        /* ── Dropdown / generic popup spring ── */
        'popup-in': {
          '0%': { opacity: '0', transform: 'scale(0.95) translateY(-2px)' },
          '60%': { opacity: '1', transform: 'scale(1.012) translateY(0.5px)' },
          '80%': { transform: 'scale(0.997) translateY(0)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        /* ── Tooltip micro-spring (shorter, tighter) ── */
        'tooltip-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '50%': { opacity: '1', transform: 'scale(1.008)' },
          '75%': { transform: 'scale(0.998)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        /* ── Sheet directional overshoots ── */
        'sheet-in-from-right': {
          '0%': { transform: 'translateX(100%)' },
          '70%': { transform: 'translateX(-1.5%)' },
          '85%': { transform: 'translateX(0.4%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'sheet-in-from-left': {
          '0%': { transform: 'translateX(-100%)' },
          '70%': { transform: 'translateX(1.5%)' },
          '85%': { transform: 'translateX(-0.4%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'sheet-in-from-top': {
          '0%': { transform: 'translateY(-100%)' },
          '70%': { transform: 'translateY(1.5%)' },
          '85%': { transform: 'translateY(-0.4%)' },
          '100%': { transform: 'translateY(0)' },
        },
        'sheet-in-from-bottom': {
          '0%': { transform: 'translateY(100%)' },
          '70%': { transform: 'translateY(-1.5%)' },
          '85%': { transform: 'translateY(0.4%)' },
          '100%': { transform: 'translateY(0)' },
        },
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
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'collapsible-down': 'collapsible-down 260ms cubic-bezier(0.22, 1, 0.36, 1)',
        'collapsible-up': 'collapsible-up 220ms cubic-bezier(0.4, 0, 0.2, 1)',
        'dialog-in': 'dialog-in 340ms ease-out',
        'dialog-out': 'dialog-out 200ms cubic-bezier(0.4, 0, 1, 1)',
        'popup-in': 'popup-in 260ms ease-out',
        'tooltip-in': 'tooltip-in 160ms ease-out',
        'sheet-in-from-right': 'sheet-in-from-right 400ms ease-out',
        'sheet-in-from-left': 'sheet-in-from-left 400ms ease-out',
        'sheet-in-from-top': 'sheet-in-from-top 400ms ease-out',
        'sheet-in-from-bottom': 'sheet-in-from-bottom 400ms ease-out',
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
