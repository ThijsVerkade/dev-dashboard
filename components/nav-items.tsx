import { FolderGit2, GitBranch, LayoutDashboard, Rocket, SquareKanban, Workflow } from "lucide-react"
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
  { href: "/dashboard", title: "Dashboard", icon: LayoutDashboard },
  { href: "/", title: "Release Flow", icon: Rocket },
  { href: "/pipelines", title: "Pipelines", icon: GitBranch },
  { href: "/agents", title: "Agents", icon: Workflow },
  { href: "/jira", title: "Jira", icon: SquareKanban },
  { href: "/setup", title: "Setup", icon: FolderGit2 },
]
