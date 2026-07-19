export const FRONTEND_BUILD_REVISION =
  typeof __CARGOFLOW_BUILD_REVISION__ === 'string'
    ? __CARGOFLOW_BUILD_REVISION__
    : 'unknown'

export function buildRevisionMismatch(
  frontendRevision: string | undefined,
  backendRevision: string | undefined,
): boolean {
  if (
    !frontendRevision ||
    !backendRevision ||
    frontendRevision === 'unknown' ||
    backendRevision === 'unknown'
  ) {
    return false
  }
  return frontendRevision !== backendRevision
}
