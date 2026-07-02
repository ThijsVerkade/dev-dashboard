type FrontmatterValue = string | number | string[]

export function buildFrontmatter(data: Record<string, FrontmatterValue>): string {
  const lines = Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`
    return `${key}: ${value}`
  })
  return `---\n${lines.join('\n')}\n---\n`
}

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith('---\n')) return { frontmatter: null, body: content }
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: null, body: content }
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5),
  }
}
