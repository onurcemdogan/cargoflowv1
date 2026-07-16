export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}

export function createTrackingNumber(index = 0): string {
  const base = Date.now().toString().slice(-8)
  const suffix = (100 + index + Math.floor(Math.random() * 899)).toString()
  return `SR${base}${suffix}`
}
