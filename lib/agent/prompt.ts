export type IssueDetail = {
  key: string
  summary: string
  description: string
  url: string
  /** Target applications/repos for this ticket, parsed from `app:<name>` Jira labels. */
  apps?: string[]
}

/** Parse an AGENT_REPOS value `repo` or `repo@branch` into its parts (branch defaults to main). */
export function parseRepoSpec(value: string): { repo: string; baseBranch: string } {
  const [repo, branch] = value.split('@')
  return { repo: repo.trim(), baseBranch: (branch ?? '').trim() || 'main' }
}

/** 'NBDE-817' -> 'NBDE'. Jira project key is the part before the first dash. */
export function projectKeyOf(issueKey: string): string {
  const i = issueKey.indexOf('-')
  return i === -1 ? issueKey : issueKey.slice(0, i)
}

/** Kebab-case slug for a branch name, capped (default 40 chars), no trailing dash. */
export function slugify(summary: string, max = 40): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

/** The instruction handed to the headless Claude agent. */
export function buildAgentPrompt(
  detail: IssueDetail,
  opts: { branch: string; baseBranch: string },
): string {
  const { branch, baseBranch } = opts
  return [
    `You are implementing Jira ticket ${detail.key} autonomously in this repository.`,
    ``,
    `## Ticket`,
    `Key: ${detail.key}`,
    `Summary: ${detail.summary}`,
    `URL: ${detail.url}`,
    ``,
    `Description:`,
    detail.description || '(no description provided)',
    ``,
    `## How to work`,
    `1. You are in a fresh git worktree already checked out on a NEW branch \`${branch}\` (created off \`${baseBranch}\`). Do NOT create or switch branches. NEVER commit to \`${baseBranch}\` or any other branch.`,
    `2. Implement the ticket. Follow the repository's existing conventions and AGENTS.md/CLAUDE.md if present.`,
    `3. If the repo has a build or test script, run it and make it pass before committing.`,
    `4. Commit your work. Use the \`bas-merge-commit-messages\` skill for the commit/MR message (BAS ADR-6 standard).`,
    `5. Push and open a merge request, since no \`glab\`/\`gh\` CLI is installed, with GitLab push options:`,
    `   \`git push -u origin ${branch} -o merge_request.create -o merge_request.target=${baseBranch} -o merge_request.remove_source_branch\``,
    `6. Set the MR title/description per the BAS standard, referencing ${detail.key}.`,
    `7. End your final message with the merge request URL on its own line.`,
    ``,
    `Work end-to-end without asking for confirmation.`,
  ].join('\n')
}
