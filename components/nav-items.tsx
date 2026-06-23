import { Bot, GitBranch, Rocket, ScrollText, SquareKanban } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type NavItem = {
  /** Route for this destination. */
  href: string
  title: string
  icon: LucideIcon
}

/**
 * Dashboard destinations. Each is its own page; Release Flow is the home page.
 * Shared by the sidebar, the breadcrumb, and the Cmd+K command palette so they
 * never drift.
 */
export const navItems: NavItem[] = [
  { href: "/", title: "Release Flow", icon: Rocket },
  { href: "/pipelines", title: "Pipelines", icon: GitBranch },
  { href: "/logs", title: "Logs", icon: ScrollText },
  { href: "/claude", title: "Claude", icon: Bot },
  { href: "/jira", title: "Jira", icon: SquareKanban },
]
