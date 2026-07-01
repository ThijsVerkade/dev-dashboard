'use client'
import Link from 'next/link'
import { usePoll } from '@/lib/use-poll'
import type { SetupStatus } from '@/lib/setup/repos'

export function ReposBanner() {
  const { data } = usePoll<SetupStatus>('/api/setup/repos', 30000)
  if (!data || !data.ok) return null
  const missing = data.data.repos.filter((r) => r.state === 'missing').length
  if (missing === 0) return null
  return (
    <Link
      href="/setup"
      className="block border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-center font-mono text-xs text-amber-500 hover:bg-amber-500/20"
    >
      ⚠ {missing} configured repo{missing > 1 ? 's' : ''} not installed — click to install
    </Link>
  )
}
