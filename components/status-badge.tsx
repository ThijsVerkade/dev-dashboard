import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Style = { label: string; className: string }

// Bracketed terminal labels, color-coded via primary / destructive / muted.
const STYLES: Record<string, Style> = {
  success: { label: '  OK  ', className: 'text-primary border-primary/40' },
  running: { label: ' .... ', className: 'text-primary border-primary/40 animate-pulse' },
  pending: { label: ' .... ', className: 'text-amber-500 border-amber-500/40' },
  failed: { label: ' FAIL ', className: 'text-destructive border-destructive/40' },
  canceled: { label: ' SKIP ', className: 'text-muted-foreground border-border' },
  skipped: { label: ' SKIP ', className: 'text-muted-foreground border-border' },
}

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? {
    label: status.slice(0, 6).toUpperCase().padStart(5).padEnd(6),
    className: 'text-muted-foreground border-border',
  }
  return (
    <Badge
      variant="outline"
      title={status}
      className={cn('rounded-none bg-transparent px-1 font-mono text-[11px] tabular-nums', style.className)}
    >
      [{style.label}]
    </Badge>
  )
}
