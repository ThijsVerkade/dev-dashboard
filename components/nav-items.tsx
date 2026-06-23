import { Bot, GitBranch, Rocket, ScrollText, SquareKanban } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type NavItem = {
  /** Anchor id of the panel's <section> on the single page. */
  id: string
  title: string
  icon: LucideIcon
}

/**
 * The dashboard is one page; every destination scrolls to a panel anchor.
 * Shared by the sidebar and the Cmd+K command palette so they never drift.
 */
export const navItems: NavItem[] = [
  { id: "board", title: "Release Flow", icon: Rocket },
  { id: "pipelines", title: "Pipelines", icon: GitBranch },
  { id: "logs", title: "Logs", icon: ScrollText },
  { id: "claude", title: "Claude", icon: Bot },
  { id: "jira", title: "Jira", icon: SquareKanban },
]
