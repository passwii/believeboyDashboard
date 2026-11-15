'use client'

import React from 'react'

import { cn } from '@/lib/utils'
import {
  GlassIconReveal,
  type GlassTuning,
  type GlassIconRevealProps,
} from '@/components/ui/liquid-glass-logo-reveal'

import { believeboyMarkSvg, type BelieveboyMarkDirection } from './believeboy-marks'

export type BelieveboyRevealVariant = 'wing-cut' | 'prism' | 'bare'

/**
 * BLF-1553 · 基于 `liquid-glass-logo-reveal` 的 Believeboy 变化效果。
 *
 * 与上游默认「水滴长成、logo 靠着边停留、玻璃松手留下裸标」的区别：
 * - `wing-cut`：落点即应用图标（`keepPlate`），收束时先出现钴蓝圆角方片，
 *   再补上白色 B；没有「玻璃松手」那一段，节奏更短、更像品牌资产落地。
 * - `prism`：不放收束，改用更高的边缘色散与沿边拖影，让 B 的两道翼切口
 *   被棱边折成光谱 —— 这是「为这个字形调」而非换配色。
 * - `bare`：极简，只把玻璃当作一次擦亮，最后停在裸标上。
 */
export interface BelieveboyGlassRevealProps
  extends Omit<GlassIconRevealProps, 'logo' | 'look' | 'background' | 'logoColor' | 'plateColor' | 'iconPlate' | 'keepPlate' | 'originalColors' | 'logoScale' | 'finalScale' | 'tuning'> {
  variant?: BelieveboyRevealVariant
  /** 传入哪个方向的 mark；默认 `wing`（推荐方向）。 */
  mark?: BelieveboyMarkDirection
  /** 页面底色（hex）。组件本身用 canvas 涂抹底色，必须与所在表面一致 */
  background?: string
  tone?: 'light' | 'dark'
  /** 覆盖调好的光学参数 */
  tuning?: Partial<GlassTuning>
}

interface Preset {
  background: string
  plateColor: string
  logoColor: string
  iconPlate: boolean
  keepPlate: boolean
  logoScale: number
  finalScale: number
  tuning: Partial<GlassTuning>
}

const BRAND_BLUE = '#2755d9'

/** 收束成应用图标：钴蓝圆角方片 + 白 B */
const WING_CUT: Record<'light' | 'dark', Preset> = {
  light: {
    background: '#e9e9eb',
    plateColor: BRAND_BLUE,
    logoColor: '#ffffff',
    iconPlate: true,
    keepPlate: true,
    logoScale: 0.78,
    finalScale: 0.62,
    tuning: {
      corner: 5,
      startSize: 0.1,
      // 3.2 时字形涨到只剩两道横条，18px 以下会读不出 B；2.2 能在 t≈0.35s 就认出字形，
      // 同时保留「贴着棱边停留、被玻璃折弯」的原始意图。
      startZoom: 2.2,
      glide: 1.25,
      present: 2.1,
      response: 0.46,
      bounce: 0.18,
      drift: 0.03,
      swell: 1,
      sheen: 0.9,
      lightTurn: 1.15,
      stretch: 0.8,
      tilt: 0.55,
      cornerPull: 2.5,
      cornerWidth: 2.6,
      edgeSmear: 3.2,
      cornerFocus: 0.5,
      dispersion: 1.9,
      colorBleed: 1.5,
      opticalDepth: 0.95,
      bulge: 0.75,
      halo: 0,
      shadow: 1,
      ripple: 0.8,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.16,
    },
  },
  dark: {
    background: '#101319',
    plateColor: BRAND_BLUE,
    logoColor: '#ffffff',
    iconPlate: true,
    keepPlate: true,
    logoScale: 0.78,
    finalScale: 0.62,
    tuning: {
      corner: 5,
      startSize: 0.1,
      startZoom: 2.2,
      glide: 1.25,
      present: 2.1,
      response: 0.46,
      bounce: 0.18,
      drift: 0.03,
      swell: 1,
      sheen: 0.55,
      lightTurn: 1.15,
      stretch: 0.8,
      tilt: 0.55,
      cornerPull: 2.5,
      cornerWidth: 2.6,
      edgeSmear: 3.2,
      cornerFocus: 0.5,
      dispersion: 1.4,
      colorBleed: 0.9,
      opticalDepth: 0.7,
      bulge: 0.6,
      halo: 0.35,
      shadow: 0,
      ripple: 0.6,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.2,
    },
  },
}

/** 不改收束，只放大边缘棱镜：翼切口被折成光谱 */
const PRISM: Record<'light' | 'dark', Preset> = {
  light: {
    background: '#e9e9eb',
    plateColor: '#ffffff',
    logoColor: '#0e1428',
    iconPlate: false,
    keepPlate: false,
    logoScale: 0.66,
    finalScale: 0.86,
    tuning: {
      corner: 4.8,
      startSize: 0.14,
      startZoom: 2.9,
      glide: 1.9,
      present: 2.4,
      response: 0.48,
      bounce: 0.06,
      drift: 0.1,
      swell: 1,
      sheen: 1,
      lightTurn: 1.4,
      stretch: 0.6,
      tilt: 0.45,
      cornerPull: 2.7,
      cornerWidth: 3.2,
      edgeSmear: 4.2,
      cornerFocus: 0.62,
      dispersion: 2.3,
      colorBleed: 1.8,
      opticalDepth: 1.3,
      bulge: 1,
      halo: 0,
      shadow: 1,
      ripple: 1,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.12,
    },
  },
  dark: {
    background: '#101319',
    plateColor: '#101319',
    logoColor: '#f3efe6',
    iconPlate: false,
    keepPlate: false,
    logoScale: 0.66,
    finalScale: 0.86,
    tuning: {
      corner: 4.8,
      startSize: 0.14,
      startZoom: 2.9,
      glide: 1.9,
      present: 2.4,
      response: 0.48,
      bounce: 0.06,
      drift: 0.06,
      swell: 1,
      sheen: 0.5,
      lightTurn: 1.4,
      stretch: 0.6,
      tilt: 0.45,
      cornerPull: 2.7,
      cornerWidth: 3.2,
      edgeSmear: 4.2,
      cornerFocus: 0.62,
      dispersion: 1.7,
      colorBleed: 1.0,
      opticalDepth: 1.0,
      bulge: 0.85,
      halo: 0.5,
      shadow: 0,
      ripple: 0.7,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.16,
    },
  },
}

/** 极简：玻璃只擦亮一次，最后停在裸标 */
const BARE: Record<'light' | 'dark', Preset> = {
  light: {
    background: '#e9e9eb',
    plateColor: '#ffffff',
    logoColor: '#0e1428',
    iconPlate: false,
    keepPlate: false,
    logoScale: 0.7,
    finalScale: 0.95,
    tuning: {
      corner: 4.8,
      startSize: 0.1,
      startZoom: 2.2,
      glide: 1.1,
      present: 1.5,
      response: 0.42,
      bounce: 0,
      drift: 0.05,
      swell: 1,
      sheen: 0.8,
      lightTurn: 0.9,
      stretch: 0.55,
      tilt: 0.4,
      cornerPull: 2.2,
      cornerWidth: 2.4,
      edgeSmear: 3.0,
      cornerFocus: 0.55,
      dispersion: 2.0,
      colorBleed: 1.4,
      opticalDepth: 1.2,
      bulge: 1,
      halo: 0,
      shadow: 1,
      ripple: 1,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.14,
    },
  },
  dark: {
    background: '#101319',
    plateColor: '#101319',
    logoColor: '#f3efe6',
    iconPlate: false,
    keepPlate: false,
    logoScale: 0.7,
    finalScale: 0.95,
    tuning: {
      corner: 4.8,
      startSize: 0.1,
      startZoom: 2.2,
      glide: 1.1,
      present: 1.5,
      response: 0.42,
      bounce: 0,
      drift: 0.03,
      swell: 1,
      sheen: 0.4,
      lightTurn: 0.9,
      stretch: 0.55,
      tilt: 0.4,
      cornerPull: 2.2,
      cornerWidth: 2.4,
      edgeSmear: 3.0,
      cornerFocus: 0.55,
      dispersion: 1.3,
      colorBleed: 0.7,
      opticalDepth: 0.8,
      bulge: 0.8,
      halo: 0.4,
      shadow: 0,
      ripple: 0.6,
      focus: 1,
      doubleBevel: 1,
      bevelWidth: 0.18,
    },
  },
}

const PRESETS: Record<BelieveboyRevealVariant, Record<'light' | 'dark', Preset>> = {
  'wing-cut': WING_CUT,
  prism: PRISM,
  bare: BARE,
}

/**
 * 需要 `logo` 的组件封装：mark 按方向取用，其余 props 透传给上游。
 * 上游自己处理 WebGL2 缺失（回退为 CSS mask 静态图）、reduced-motion（停在玻璃上）与
 * 不可见时暂停，这里不重复实现。
 */
export function BelieveboyGlassReveal({
  variant = 'wing-cut',
  mark = 'wing',
  tone = 'light',
  background,
  tuning,
  className,
  label = 'Believeboy',
  ...props
}: BelieveboyGlassRevealProps) {
  const preset = PRESETS[variant][tone]
  // `tuningKey` 在父级保持稳定：内联对象每次渲染都会换引用，上游已用 JSON 归一。
  const mergedTuning = React.useMemo(
    () => ({ ...preset.tuning, ...tuning }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tuning 按 JSON 归一，避免内联字面量反复重启动画
    [variant, tone, JSON.stringify(tuning ?? {})],
  )

  return (
    <GlassIconReveal
      logo={believeboyMarkSvg(mark)}
      look={tone}
      background={background ?? preset.background}
      logoColor={preset.logoColor}
      plateColor={preset.plateColor}
      iconPlate={preset.iconPlate}
      keepPlate={preset.keepPlate}
      logoScale={preset.logoScale}
      finalScale={preset.finalScale}
      tuning={mergedTuning}
      label={label}
      className={cn('h-full w-full', className)}
      {...props}
    />
  )
}
