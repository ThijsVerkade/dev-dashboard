"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { navItems } from "@/components/nav-items"
import { Search } from "lucide-react"

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2 font-mono text-muted-foreground"
        aria-label="Open command palette"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">go to…</span>
        <CommandShortcut className="hidden sm:inline">⌘K</CommandShortcut>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Go to page"
        description="Navigate to a dashboard page"
        className="font-mono"
      >
        <CommandInput placeholder="go to page…" />
        <CommandList>
          <CommandEmpty>No page found.</CommandEmpty>
          <CommandGroup heading="pages">
            {navItems.map((item) => (
              <CommandItem key={item.href} value={item.title} onSelect={() => go(item.href)}>
                <item.icon />
                <span>{item.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
