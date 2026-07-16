import type { WorkflowResult } from '../types/cargoflow'

interface ActionResultProps {
  result?: WorkflowResult
}

export function ActionResult({ result }: ActionResultProps) {
  if (!result) return null

  return <div className={`action-result ${result.level}`}>{result.message}</div>
}
