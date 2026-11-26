type Rule = { selector: string; declarations: string; specificity: number; order: number }

const specificity = (selector: string) => {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const types = (selector.replace(/[#.][\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? [])
    .length
  return ids * 10_000 + classes * 100 + types
}

/** Rules a style attribute can take (no pseudo-classes or elements, no at-rules). */
const inlinable = (selector: string) => !/::?[a-z-]+/i.test(selector) && !selector.includes('@')

/**
 * Inline `<style>` rules into `style` attributes (email clients drop `<style>`). Rules apply in specificity order,
 * then source order; an element's own `style` wins. `@media` rules and pseudo-selectors stay in a `<style>` block.
 * Uses Bun's HTMLRewriter, so selectors are real CSS selectors.
 */
export async function inlineCss(html: string): Promise<string> {
  const rules: Rule[] = []
  const kept: string[] = []
  let order = 0
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
  if (!css.trim()) return html
  // at-rules (with nested braces) are kept as they are
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, (at) => {
    kept.push(at)
    return ''
  })
  for (const [, selectors, declarations] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of (selectors as string).split(',').map((s) => s.trim())) {
      if (!selector) continue
      if (inlinable(selector))
        rules.push({
          selector,
          declarations: (declarations as string).trim(),
          specificity: specificity(selector),
          order: order++,
        })
      else kept.push(`${selector}{${(declarations as string).trim()}}`)
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order)

  const OWN = 'data-cslug-own-style'
  let rewriter = new HTMLRewriter()
    .on('style', {
      element(el) {
        el.remove()
      },
    })
    .on('*', {
      element(el) {
        const style = el.getAttribute('style')
        if (style === null) return
        el.setAttribute(OWN, style)
        el.removeAttribute('style')
      },
    })
  // handlers run in registration order for an element: specificity, then source order
  for (const rule of rules) {
    try {
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          const before = el.getAttribute('style')
          el.setAttribute('style', [before, rule.declarations.replace(/;\s*$/, '')].filter(Boolean).join('; '))
        },
      })
    } catch {
      kept.push(`${rule.selector}{${rule.declarations}}`) // a selector HTMLRewriter does not support
    }
  }
  rewriter = rewriter.on('*', {
    element(el) {
      const own = el.getAttribute(OWN)
      if (own === null) return
      el.removeAttribute(OWN)
      el.setAttribute('style', [el.getAttribute('style'), own].filter(Boolean).join('; '))
    },
  })
  let out = rewriter.transform(html)
  if (kept.length) {
    const block = `<style>${kept.join('\n')}</style>`
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${block}</head>`) : block + out
  }
  return out
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A readable plain-text version of an HTML email: blocks on their own lines, links as `text (url)`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !href || href === text || href.startsWith('#') ? text : `${text} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
