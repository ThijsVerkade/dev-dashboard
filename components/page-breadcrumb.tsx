"use client"
import { usePathname } from "next/navigation"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { navItems } from "@/components/nav-items"

export function PageBreadcrumb() {
  const pathname = usePathname()
  // Longest-prefix match so deep routes (e.g. /brain/standards/api) resolve to their section nav item.
  const item =
    [...navItems]
      .sort((a, b) => b.href.length - a.href.length)
      .find((n) => pathname === n.href || (n.href !== "/" && pathname.startsWith(n.href + "/"))) ?? navItems[0]
  const rest = item.href !== "/" && pathname.startsWith(item.href + "/") ? pathname.slice(item.href.length + 1) : ""
  const sub = rest ? rest.split("/").pop()! : ""
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/" className="font-mono text-muted-foreground">
            ~/ops $ dev-dashboard
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="text-muted-foreground" />
        <BreadcrumbItem>
          <BreadcrumbPage className="font-mono text-primary">
            {item.title}
            {!sub && <span className="terminal-cursor" aria-hidden>█</span>}
          </BreadcrumbPage>
        </BreadcrumbItem>
        {sub && (
          <>
            <BreadcrumbSeparator className="text-muted-foreground" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono text-primary">
                {sub}
                <span className="terminal-cursor" aria-hidden>█</span>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
