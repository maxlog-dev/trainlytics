import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import indexHtml from '../../index.html?raw'
import { BootSplash } from '../components/BootSplash'

/** The #boot-splash element of an HTML string, without whitespace-only text nodes. */
function splashOf(html: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const el = doc.getElementById('boot-splash')
  if (!el) throw new Error('no #boot-splash')
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const blank: Node[] = []
  while (walker.nextNode()) if (!walker.currentNode.textContent?.trim()) blank.push(walker.currentNode)
  blank.forEach((n) => n.parentNode?.removeChild(n))
  return el
}

describe('BootSplash', () => {
  it('renders the same markup as the inline placeholder in index.html', () => {
    const inline = splashOf(indexHtml)
    const react = splashOf(`<body>${renderToStaticMarkup(<BootSplash />)}</body>`)
    expect(react.outerHTML.length).toBeGreaterThan(100)
    expect(react.isEqualNode(inline)).toBe(true)
  })
})
