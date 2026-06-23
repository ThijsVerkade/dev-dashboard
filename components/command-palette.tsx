"use client"
import { useCallback, useEffect, useState } from "react"
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

  const go = useCallback((id: string) => {
    setOpen(false)
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

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
        <span className="hidden sm:inline">jump to…</span>
        <CommandShortcut className="hidden sm:inline">⌘K</CommandShortcut>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Jump to panel"
        description="Scroll to a dashboard panel"
        className="font-mono"
      >
        <CommandInput placeholder="jump to panel…" />
        <CommandList>
          <CommandEmpty>No panel found.</CommandEmpty>
          <CommandGroup heading="panels">
            {navItems.map((item) => (
              <CommandItem key={item.id} value={item.title} onSelect={() => go(item.id)}>
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
