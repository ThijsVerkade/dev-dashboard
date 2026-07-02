import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from './html-to-md'

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis, and lists', () => {
    const md = htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>a</li><li>b</li></ul>')
    expect(md).toContain('# Title')
    expect(md).toContain('Hello **world**')
    expect(md).toContain('a')
  })

  it('keeps inner text of Confluence-namespaced macros', () => {
    const md = htmlToMarkdown('<p>See <ac:link><ri:page ri:content-title="Foo" />the page</ac:link>.</p>')
    expect(md).toContain('the page')
    expect(md).not.toContain('ac:link')
  })
})
