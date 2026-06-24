import { NextRequest, NextResponse } from 'next/server'
import { getMrNotes } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ iid: string }> },
) {
  const { iid } = await params
  const project = req.nextUrl.searchParams.get('project') ?? ''
  return NextResponse.json(await getMrNotes(project, Number(iid)))
}
