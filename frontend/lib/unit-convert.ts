const CM_PER_INCH = 2.54
const LB_PER_KG = 2.20462

export function cmToInch(cm: number): number {
  return cm / CM_PER_INCH
}

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG
}

export function formatInch(cm: number): string {
  return `${cmToInch(cm).toFixed(2)} in`
}

export function formatLb(kg: number): string {
  return `${kgToLb(kg).toFixed(2)} lb`
}
