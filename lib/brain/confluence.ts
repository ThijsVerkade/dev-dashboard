import { type Result, ok, failure } from '@/lib/result'

export interface ConfluenceCreds {
  host: string
  email: string
  token: string
}

export type FetchLike = typeof fetch

export function confluenceCreds(): ConfluenceCreds | null {
  const host = process.env.CONFLUENCE_HOST ?? process.env.JIRA_HOST
  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_TOKEN
  if (!host || !email || !token) return null
  return { host, email, token }
}

export function parsePageId(idOrUrl: string): string | null {
  const trimmed = idOrUrl.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  const m = trimmed.match(/\/pages\/(\d+)/)
  return m ? m[1] : null
}

export async function fetchConfluencePage(
  creds: ConfluenceCreds,
  idOrUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>> {
  const id = parsePageId(idOrUrl)
  if (!id) return failure(`Not a Confluence page id or URL: ${idOrUrl}`)
  const base = creds.host.replace(/\/+$/, '')
  const url = `${base}/wiki/api/v2/pages/${id}?body-format=storage`
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64'),
        Accept: 'application/json',
      },
    })
    if (!res.ok) return failure(`Confluence page ${id} fetch failed (HTTP ${res.status}).`)
    const json = (await res.json()) as {
      title?: string
      body?: { storage?: { value?: string } }
      _links?: { webui?: string }
    }
    return ok({
      id,
      title: json.title ?? `Page ${id}`,
      html: json.body?.storage?.value ?? '',
      sourceUrl: json._links?.webui ? `${base}/wiki${json._links.webui}` : url,
    })
  } catch (e) {
    return failure(e instanceof Error ? `Could not reach Confluence: ${e.message}` : 'Could not reach Confluence.')
  }
}
