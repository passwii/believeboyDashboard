'use client'

import * as SwitchPrimitive from '@radix-ui/react-switch'

import styles from '../alerts-warm.module.css'

export function AlertWarmSwitch({
  checked,
  onCheckedChange,
  labelledBy,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  labelledBy?: string
  label?: string
  disabled?: boolean
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      className={styles.switchRoot}
    >
      <SwitchPrimitive.Thumb className={styles.switchThumb} />
    </SwitchPrimitive.Root>
  )
}
