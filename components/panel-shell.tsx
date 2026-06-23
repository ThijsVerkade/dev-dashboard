import type { Result } from '@/lib/result'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function PanelShell<T>({
  title, result, loading, children,
}: {
  title: string
  result: Result<T> | null
  loading: boolean
  children: (data: T) => React.ReactNode
}) {
  return (
    <Card className="h-full gap-0">
      <CardHeader className="border-b border-border [.border-b]:pb-4">
        <CardTitle className="font-mono text-sm tracking-tight">
          <span className="text-muted-foreground">$ </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 text-sm">
        {loading && !result && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        )}
        {result && !result.ok && result.reason === 'unconfigured' && (
          <p className="font-mono text-sm text-amber-500">[ ---- ] not configured: {result.message}</p>
        )}
        {result && !result.ok && result.reason === 'error' && (
          <p className="font-mono text-sm text-destructive">[ FAIL ] error: {result.message}</p>
        )}
        {result && result.ok && children(result.data)}
      </CardContent>
    </Card>
  )
}
