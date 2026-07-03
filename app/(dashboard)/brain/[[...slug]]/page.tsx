import { BrainTree } from "@/components/brain-tree"
import { BrainNote } from "@/components/brain-note"
import { readNote, readVaultTree, resolveWikiLinks } from "@/lib/brain/vault-read"

// Read the vault from disk on every request so `npm run brain` refreshes show up.
// Valid because Cache Components is not enabled (see plan Task 5, Step 1).
export const dynamic = "force-dynamic"

function brainDir() {
  return process.env.BRAIN_DIR || "brain"
}

export default async function BrainPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const dir = brainDir()
  const tree = readVaultTree(dir)

  if (tree.nodes.length === 0) {
    return (
      <div className="font-mono text-sm text-muted-foreground">
        No vault found. Run <code className="rounded bg-muted px-1">npm run brain</code> to generate it.
      </div>
    )
  }

  const note = readNote(dir, slug ?? [])

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <BrainTree nodes={tree.nodes} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        {note ? (
          <BrainNote title={note.title} frontmatter={note.frontmatter} body={resolveWikiLinks(note.body, tree.notePaths)} />
        ) : (
          <p className="font-mono text-sm text-muted-foreground">Note not found. Pick one from the tree.</p>
        )}
      </div>
    </div>
  )
}
