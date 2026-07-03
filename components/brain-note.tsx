"use client"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"

type NoteProps = {
  title: string
  frontmatter: Record<string, string>
  body: string
}

const META_KEYS = ["type", "tier", "last-synced"] as const

export function BrainNote({ title, frontmatter, body }: NoteProps) {
  const meta = META_KEYS.filter((k) => frontmatter[k]).map((k) => `${k}: ${frontmatter[k]}`)

  return (
    <article className="min-w-0 max-w-3xl">
      <h1 className="mb-1 font-mono text-2xl text-primary">{title}</h1>
      {meta.length > 0 && (
        <p className="mb-6 font-mono text-xs text-muted-foreground">{meta.join(" · ")}</p>
      )}
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) =>
              href?.startsWith("/") ? (
                <Link href={href} className="text-primary underline underline-offset-2">
                  {children}
                </Link>
              ) : (
                <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                  {children}
                </a>
              ),
            h1: ({ children }) => <h2 className="mt-4 font-mono text-xl text-foreground">{children}</h2>,
            h2: ({ children }) => <h2 className="mt-4 font-mono text-lg text-foreground">{children}</h2>,
            h3: ({ children }) => <h3 className="mt-2 font-mono text-base text-foreground">{children}</h3>,
            ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
            blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
            code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>,
            table: ({ children }) => <table className="w-full border-collapse text-left">{children}</table>,
            th: ({ children }) => <th className="border border-border px-2 py-1 font-mono text-xs">{children}</th>,
            td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          } satisfies Components}
        >
          {body}
        </ReactMarkdown>
      </div>
    </article>
  )
}
