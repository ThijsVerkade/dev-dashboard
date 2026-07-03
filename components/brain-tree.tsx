"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import type { VaultNode } from "@/lib/brain/types"

function TreeNode({ node, depth }: { node: VaultNode; depth: number }) {
  const pathname = usePathname()
  const active = pathname === node.href
  const hasChildren = node.children.length > 0
  const [open, setOpen] = useState(true)

  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button onClick={() => setOpen((o) => !o)} className="text-muted-foreground" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Link
          href={node.href}
          className={cn(
            "truncate rounded px-1.5 py-0.5 font-mono text-xs hover:bg-muted",
            active ? "text-primary" : "text-foreground",
          )}
        >
          {node.title}
        </Link>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.slug} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function BrainTree({ nodes }: { nodes: VaultNode[] }) {
  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border pr-2">
      <ul className="flex flex-col gap-0.5">
        {nodes.map((n) => (
          <TreeNode key={n.slug} node={n} depth={0} />
        ))}
      </ul>
    </nav>
  )
}
