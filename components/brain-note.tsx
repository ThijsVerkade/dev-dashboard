"use client"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ComponentPropsWithoutRef } from "react"

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
            a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) =>
              href?.startsWith("/") ? (
                <Link href={href} className="text-primary underline underline-offset-2">
                  {children}
                </Link>
              ) : (
                <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" {...rest}>
                  {children}
                </a>
              ),
            h1: (p) => <h2 className="mt-4 font-mono text-xl text-foreground" {...p} />,
            h2: (p) => <h2 className="mt-4 font-mono text-lg text-foreground" {...p} />,
            h3: (p) => <h3 className="mt-2 font-mono text-base text-foreground" {...p} />,
            ul: (p) => <ul className="list-disc pl-5" {...p} />,
            ol: (p) => <ol className="list-decimal pl-5" {...p} />,
            blockquote: (p) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...p} />,
            code: (p) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...p} />,
            table: (p) => <table className="w-full border-collapse text-left" {...p} />,
            th: (p) => <th className="border border-border px-2 py-1 font-mono text-xs" {...p} />,
            td: (p) => <td className="border border-border px-2 py-1" {...p} />,
          }}
        >
          {body}
        </ReactMarkdown>
      </div>
    </article>
  )
}
