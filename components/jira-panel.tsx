'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import type { Issue } from '@/lib/sources/jira'

type Tab = 'mine' | 'sprint' | 'recent'

const TAB_URLS: Record<Tab, string> = {
  mine: '/api/jira/my',
  sprint: '/api/jira/sprint',
  recent: '/api/jira/recent',
}

function statusCategoryClass(cat: string): string {
  if (cat === 'new') return 'bg-gray-500'
  if (cat === 'indeterminate') return 'bg-blue-600'
  if (cat === 'done') return 'bg-green-600'
  return 'bg-gray-500'
}

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div key={issue.key} className="flex items-start gap-2 text-sm">
          <span
            className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-white ${statusCategoryClass(issue.statusCategory)}`}
          >
            {issue.status || issue.statusCategory}
          </span>
          <div className="min-w-0 flex-1">
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {issue.key}
            </a>{' '}
            <span className="max-w-xs truncate">{issue.summary}</span>
            <div className="text-xs text-gray-500 dark:text-gray-400">{issue.assignee}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-gray-200 dark:bg-gray-700'
          : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

export function JiraPanel() {
  const [tab, setTab] = useState<Tab>('mine')

  const mine = usePoll<Issue[]>('/api/jira/my', 60000)
  const sprint = usePoll<Issue[]>('/api/jira/sprint', 60000)
  const recent = usePoll<Issue[]>('/api/jira/recent', 60000)

  const active = tab === 'mine' ? mine : tab === 'sprint' ? sprint : recent

  return (
    <PanelShell title="Jira" result={active.data} loading={active.loading}>
      {(issues) => (
        <div>
          <div className="mb-3 flex gap-2">
            <TabButton active={tab === 'mine'} onClick={() => setTab('mine')}>Mine</TabButton>
            <TabButton active={tab === 'sprint'} onClick={() => setTab('sprint')}>Sprint</TabButton>
            <TabButton active={tab === 'recent'} onClick={() => setTab('recent')}>Recent</TabButton>
          </div>
          <IssueList issues={issues} />
        </div>
      )}
    </PanelShell>
  )
}
