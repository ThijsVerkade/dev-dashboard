import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

/**
 * Remove Confluence storage-format namespaced tags (`<ac:...>`, `<ri:...>`, and their
 * self-closing forms) but keep any inner text, then convert the remaining standard
 * HTML to markdown.
 */
export function htmlToMarkdown(html: string): string {
  const cleaned = html
    .replace(/<\/?(?:ac|ri):[^>]*>/g, '') // opening/closing/self-closing namespaced tags
    .replace(/\s+\n/g, '\n')
  return turndown.turndown(cleaned).trim()
}
