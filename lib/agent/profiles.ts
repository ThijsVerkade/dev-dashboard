export type AgentProfile = 'implement' | 'acceptance'

export const AGENT_PROFILES: Record<AgentProfile, { label: string }> = {
  implement: { label: 'Implement' },
  acceptance: { label: 'Acceptance test' },
}

export function isAgentProfile(x: unknown): x is AgentProfile {
  return x === 'implement' || x === 'acceptance'
}
