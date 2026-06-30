export type LogLine = { service: string; timestamp: number; message: string; id: string }

/** Insert `incoming` into a timestamp-sorted buffer, deduping on service+id and capping length. */
export function mergeLine(buffer: LogLine[], incoming: LogLine, cap: number): LogLine[] {
  if (incoming.id && buffer.some((l) => l.service === incoming.service && l.id === incoming.id)) {
    return buffer
  }
  // Find insert point: first index from the end whose timestamp is <= incoming.
  let i = buffer.length
  while (i > 0 && buffer[i - 1].timestamp > incoming.timestamp) i--
  const next = [...buffer.slice(0, i), incoming, ...buffer.slice(i)]
  return next.length > cap ? next.slice(next.length - cap) : next
}
