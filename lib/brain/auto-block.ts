export const AUTO_START = '<!-- AUTO:start — regenerated each run, do not edit by hand -->'
export const AUTO_END = '<!-- AUTO:end -->'

function block(autoInner: string): string {
  return `${AUTO_START}\n${autoInner}\n${AUTO_END}`
}

export function mergeAutoBlock(
  existingBody: string | null,
  autoInner: string,
  stub: string,
): { body: string; warned: boolean } {
  if (existingBody === null) {
    return { body: `${block(autoInner)}\n\n${stub}`, warned: false }
  }

  const start = existingBody.indexOf(AUTO_START)
  const end = existingBody.indexOf(AUTO_END)
  if (start !== -1 && end !== -1 && end > start) {
    const before = existingBody.slice(0, start)
    const after = existingBody.slice(end + AUTO_END.length)
    return { body: `${before}${block(autoInner)}${after}`, warned: false }
  }

  // Existing content but no usable markers: don't guess — prepend, keep prose.
  return { body: `${block(autoInner)}\n\n${existingBody}`, warned: true }
}
