export type AcceptanceDetail = {
  key: string
  summary: string
  description: string
  url: string
  status: string
  assignee: { displayName: string; accountId: string } | null
  acceptanceCriteria: string | null
}

export type AdfDoc = { type: 'doc'; version: 1; content: unknown[] }
export type Verdict = { result: 'pass' | 'fail' | 'unknown'; findings: string }

const ERROR_MARKER = /error|exception|fatal|panic|crash|traceback|unhandled/i

/** Pull the text under an "Acceptance Criteria" heading up to the next blank-line block. */
export function extractCriteriaFromDescription(description: string): string | null {
  const lines = description.split('\n')
  const start = lines.findIndex((l) => /^\s*#*\s*acceptance criteria\s*:?\s*$/i.test(l))
  if (start === -1) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (body.length > 0 && line.trim() === '') break // stop at first blank line after content starts
    if (body.length === 0 && line.trim() === '') continue // skip leading blanks
    body.push(line)
  }
  const text = body.join('\n').trim()
  return text || null
}

/** Returns the list of missing prerequisites; empty array means ready to test. */
export function checkReadiness(detail: AcceptanceDetail): string[] {
  const missing: string[] = []
  if (!/accept/i.test(detail.status))
    missing.push(`ticket is not in the Acceptance stage (status: ${detail.status || 'unknown'})`)
  if (!detail.acceptanceCriteria)
    missing.push(
      "no acceptance criteria found (add an 'Acceptance Criteria' section to the description, or set ACCEPTANCE_CRITERIA_FIELD)",
    )
  return missing
}

/** Parse the agent's structured verdict from its log; last marker wins. */
export function parseVerdict(log: string): Verdict {
  const matches = [...log.matchAll(/ACCEPTANCE-RESULT:\s*(PASS|FAIL)/gi)]
  const last = matches.at(-1)
  if (!last) return { result: 'unknown', findings: '' }
  const result = last[1].toUpperCase() === 'PASS' ? 'pass' : 'fail'
  const after = log.slice((last.index ?? 0) + last[0].length).trim()
  return { result, findings: after.slice(0, 1000) }
}

/** A clean startup: we saw log events and none look like an error/crash. */
export function isCleanStartup(events: { message: string }[]): boolean {
  if (events.length === 0) return false
  return !events.some((e) => ERROR_MARKER.test(e.message))
}

/** Instruction handed to the headless browser-testing agent. */
export function buildAcceptancePrompt(detail: AcceptanceDetail, opts: { stagingUrl: string }): string {
  return [
    `You are acceptance-testing Jira ticket ${detail.key} on the STAGING environment.`,
    `Do NOT modify code, create branches, or commit. You only test and report.`,
    ``,
    `## Ticket`,
    `Key: ${detail.key}`,
    `Summary: ${detail.summary}`,
    `URL: ${detail.url}`,
    ``,
    `## Acceptance criteria`,
    detail.acceptanceCriteria || '(none provided)',
    ``,
    `## Staging`,
    `Base URL: ${opts.stagingUrl}`,
    `If a login is required, use this repository's own local credentials (its .env/config in this checkout).`,
    `No credentials are provided in this prompt.`,
    ``,
    `## How to test`,
    `1. Use the chrome-devtools MCP to open the staging base URL.`,
    `2. Walk through each acceptance criterion in a real browser, observing actual behavior.`,
    `3. Capture concrete evidence (what you did, what you saw) for each criterion.`,
    ``,
    `## Report (REQUIRED, last line)`,
    `End your final message with exactly one line: \`ACCEPTANCE-RESULT: PASS\` if every criterion`,
    `is satisfied, otherwise \`ACCEPTANCE-RESULT: FAIL\`, followed by a one-paragraph summary of findings.`,
  ].join('\n')
}

function assigneeNode(detail: AcceptanceDetail): unknown {
  return detail.assignee
    ? { type: 'mention', attrs: { id: detail.assignee.accountId, text: `@${detail.assignee.displayName}` } }
    : { type: 'text', text: 'Assignee' }
}

export function buildMissingInfoComment(detail: AcceptanceDetail, missing: string[]): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          assigneeNode(detail),
          { type: 'text', text: ' — this ticket cannot be acceptance-tested yet. Missing:' },
        ],
      },
      {
        type: 'bulletList',
        content: missing.map((m) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: m }] }],
        })),
      },
    ],
  }
}

export function buildResultComment(verdict: Verdict): AdfDoc {
  const headline =
    verdict.result === 'pass'
      ? 'Acceptance test PASSED ✅ on staging.'
      : 'Acceptance test FAILED ❌ on staging.'
  const content: unknown[] = [
    { type: 'paragraph', content: [{ type: 'text', text: headline, marks: [{ type: 'strong' }] }] },
  ]
  if (verdict.findings)
    content.push({ type: 'paragraph', content: [{ type: 'text', text: verdict.findings }] })
  return { type: 'doc', version: 1, content }
}
