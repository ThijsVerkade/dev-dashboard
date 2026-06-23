'use client'
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { Card } from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { ClaudeSummary, ClaudeSession } from '@/lib/sources/claude'

const chartConfig = {
  cost: { label: 'cost ($)', color: 'var(--chart-1)' },
} satisfies ChartConfig

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex-1 gap-1 rounded-none border-border bg-muted/40 p-3">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</div>
    </Card>
  )
}

export function ClaudePanel() {
  const summary = usePoll<ClaudeSummary>('/api/claude/summary', 60000)
  const sessions = usePoll<ClaudeSession[]>('/api/claude/sessions', 60000)
  return (
    <PanelShell title="Claude Activity" result={summary.data} loading={summary.loading}>
      {(s) => (
        <div className="space-y-4 text-sm">
          <div className="flex gap-3">
            <StatTile label="total cost" value={`$${s.totalCost.toFixed(2)}`} />
            <StatTile label="total tokens" value={s.totalTokens.toLocaleString()} />
          </div>

          {s.days.length > 0 ? (
            <ChartContainer config={chartConfig} className="h-40 w-full">
              <AreaChart data={s.days} margin={{ left: 4, right: 4, top: 4 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.15} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(v: string) => v.slice(5)}
                  className="font-mono text-[10px]"
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <defs>
                  <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-cost)" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="var(--color-cost)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <Area
                  dataKey="cost"
                  type="monotone"
                  stroke="var(--color-cost)"
                  strokeWidth={2}
                  fill="url(#fillCost)"
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">no daily data</p>
          )}

          {sessions.data?.ok && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>project</TableHead>
                  <TableHead>last activity</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.data.slice(0, 15).map((row, i) => (
                  <TableRow key={`${row.sessionId}-${i}`}>
                    <TableCell className="font-mono">{row.project || row.sessionId.slice(0, 8)}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{row.lastActivity}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{row.tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">${row.cost.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </PanelShell>
  )
}
