'use client'

import type { ComponentProps } from 'react'

import { UploadZone } from '@/components/ui/upload-zone'
import { cn } from '@/lib/utils'

import styles from './tools-upload-zone.module.css'

export type ToolsUploadZoneProps = ComponentProps<typeof UploadZone>

/**
 * The shared UploadZone behavior stays intact; this boundary only overrides its
 * legacy Terminal surfaces inside Tools pages.
 */
export function ToolsUploadZone({ className, ...props }: ToolsUploadZoneProps) {
  return (
    <div
      className={cn(styles.uploadZone, className)}
      data-tools-upload-zone="true"
    >
      <UploadZone {...props} />
    </div>
  )
}
