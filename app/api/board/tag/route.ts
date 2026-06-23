import { NextRequest, NextResponse } from 'next/server'
import { createTag, getTags, isValidNewTag } from '@/lib/sources/gitlab'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { project?: string; name?: string }
  try { body = await req.json() } catch { return NextResponse.json(failure('Invalid JSON body')) }
  const { project, name } = body ?? {}
  if (!project || !name) return NextResponse.json(failure('project and name are required'))

  const tags = await getTags(project)
  if (!tags.ok) return NextResponse.json(tags)
  const valid = isValidNewTag(name, tags.data)
  if (!valid.ok) return NextResponse.json(failure(valid.message))

  // Production tags are always cut from main (per workflow).
  return NextResponse.json(await createTag(project, name, 'main'))
}
