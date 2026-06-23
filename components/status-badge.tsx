const COLORS: Record<string, string> = {
  success: 'bg-green-600', running: 'bg-blue-600', pending: 'bg-yellow-600',
  failed: 'bg-red-600', canceled: 'bg-gray-500', skipped: 'bg-gray-400',
}
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs text-white ${COLORS[status] ?? 'bg-gray-500'}`}>
      {status}
    </span>
  )
}
