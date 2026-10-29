import type { Root } from 'hast'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import mermaid from 'mermaid'
import { unified } from 'unified'
import { VFile } from 'vfile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoizedMathPlugin } from './katex-memo'

function renderMath(source: string, display = false): { tree: Root; file: VFile } {
  const tree = fromHtmlIsomorphic(`<code class="${display ? 'math-display' : 'math-inline'}"></code>`, {
    fragment: true
  })

  const code = tree.children[0]

  if (code.type !== 'element') {
    throw new Error('Expected math code element')
  }

  code.children = [{ type: 'text', value: source }]
  const file = new VFile()
  const plugin = createMemoizedMathPlugin()

  return { tree: unified().use(plugin.rehypePlugin).runSync(tree, file), file }
}

describe('patched KaTeX renderer compatibility and trust boundary', () => {
  it.each([
    ['inline equation', String.raw`E = mc^2`, false],
    ['display equation', String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`, true],
    ['matrix', String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`, true]
  ])('renders %s through the actual memoized math plugin', (_, expression, display) => {
    const first = renderMath(expression as string, display as boolean)
    const cached = renderMath(expression as string, display as boolean)
    const content = JSON.stringify(first.tree)
    expect(first.file.messages).toHaveLength(0)
    expect(content).toContain('katex')
    expect(content).toContain('MathML')
    expect(content).toContain(JSON.stringify(expression).slice(1, -1))
    expect(cached.tree).toEqual(first.tree)
    expect(cached.tree.children[0]).not.toBe(first.tree.children[0])
  })

  it('keeps malformed expressions visible without crashing the transcript', () => {
    const { tree, file } = renderMath(String.raw`\notARealMathCommand{`)
    expect(file.messages).toHaveLength(1)
    expect(JSON.stringify(tree)).toContain('notARealMathCommand')
  })

  it('does not inherit trust from polluted renderer options or Object.prototype', () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, 'trust')
    let link = ''
    let image = ''

    try {
      Object.defineProperty(Object.prototype, 'trust', { configurable: true, value: true, writable: true })
      link = katex.renderToString(String.raw`\href{javascript:alert(1)}{open}`)
      image = katex.renderToString(String.raw`\includegraphics{https://untrusted.invalid/pixel.png}`)
    } finally {
      if (before) {
        Object.defineProperty(Object.prototype, 'trust', before)
      } else {
        Reflect.deleteProperty(Object.prototype, 'trust')
      }
    }

    expect(link).not.toContain('<a ')
    expect(image).not.toContain('<img ')
    const inheritedOptions = Object.create({ trust: true })
    expect(katex.renderToString(String.raw`\href{javascript:alert(1)}{open}`, inheritedOptions)).not.toContain('<a ')
  })
})

describe('patched Mermaid parent compatibility', () => {
  beforeEach(() => {
    // jsdom has no SVG text layout. Only those measurement primitives are
    // supplied; parsing, diagram construction, sanitizing and SVG output are real.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 120, height: 24 })
    })
    Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
      configurable: true,
      value: () => 100
    })
    mermaid.initialize({
      fontFamily: 'inherit',
      layout: 'dagre',
      look: 'classic',
      securityLevel: 'strict',
      startOnLoad: false,
      theme: 'default'
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
    Reflect.deleteProperty(SVGElement.prototype, 'getComputedTextLength')
  })

  it.each([
    ['flowchart', 'flowchart LR\n A[Customer] --> B[Youtab]'],
    ['sequence', 'sequenceDiagram\n Customer->>Youtab: Hello\n Youtab-->>Customer: Ready'],
    ['class', 'classDiagram\n class Customer\n Customer : +name'],
    ['state', 'stateDiagram-v2\n [*] --> Ready\n Ready --> [*]'],
    ['gantt', 'gantt\n dateFormat YYYY-MM-DD\n section Work\n Install :2026-10-16, 1d'],
    ['pie', 'pie\n "Ready" : 2\n "Pending" : 1'],
    ['math label', 'flowchart LR\n A["$$x^2 + y^2$$"] --> B[Done]']
  ])('preserves real %s SVG rendering', async (name, source) => {
    const result = await mermaid.render(`compat-${name.replaceAll(' ', '-')}`, source)
    const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
    expect(svg.querySelector('parsererror')).toBeNull()
    expect(svg.documentElement.tagName).toBe('svg')
    expect(result.svg.length).toBeGreaterThan(500)

    if (name === 'math label') {
      expect(result.svg).toContain('katex')
    }
  })

  it('retains strict-mode sanitization of hostile labels', async () => {
    const result = await mermaid.render(
      'compat-hostile-label',
      'flowchart LR\n A["<span onclick=alert(1)>Untrusted</span>"] --> B[Done]'
    )

    const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
    expect(svg.querySelector('[onclick], script')).toBeNull()
  })
})
