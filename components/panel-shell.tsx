import type { Result } from '@/lib/result'

export function PanelShell<T>({
  title, result, loading, children,
}: {
  title: string
  result: Result<T> | null
  loading: boolean
  children: (data: T) => React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {loading && !result && <p className="text-sm text-gray-500">Loading…</p>}
      {result && !result.ok && result.reason === 'unconfigured' && (
        <p className="text-sm text-amber-600">Not configured: {result.message}</p>
      )}
      {result && !result.ok && result.reason === 'error' && (
        <p className="text-sm text-red-600">Error: {result.message}</p>
      )}
      {result && result.ok && children(result.data)}
    </section>
  )
}
