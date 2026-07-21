import { createElement, forwardRef } from 'react'

const anthropicSvgPath = (
  <>
    {/* Left diagonal of A */}
    <path d="M6 18 L12 6" />
    {/* Right diagonal of A */}
    <path d="M18 18 L12 6" />
    {/* Crossbar of A */}
    <path d="M8 12 L16 12" />
  </>
)

/**
 * Anthropic logo icon - custom SVG implementation
 * Inspired by the official Anthropic "A" logo: geometric, minimalist design
 * Feature: sharp angles, clean lines, distinctive triangular form
 */
export const AnthropicIcon = forwardRef<
  SVGSVGElement,
  React.SVGProps<SVGSVGElement>
>((props, ref) => (
  <svg
    ref={ref}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {anthropicSvgPath}
  </svg>
))

AnthropicIcon.displayName = 'AnthropicIcon'

export default AnthropicIcon