import { describe, expect, test } from 'bun:test'
import { compileSfc, rewriteIslands } from '../src'
import { FIXTURE } from './support'

const sfc = (template: string) =>
  `<script setup lang="ts">\nimport X from './x.vue'\n</script>\n<template>${template}</template>`

describe('island rewrite (spike a, finding 1)', () => {
  test('hydrate="…" becomes CslugIsland, in the source', () => {
    const out = rewriteIslands(sfc('<day-card :day="d" hydrate="visible" />'), 'p.vue')
    expect(out).toContain('<CslugIsland :day="d" :island-component="DayCard" island-hydrate="visible" />')
    expect(rewriteIslands(sfc('<X hydrate></X>'), 'p.vue')).toContain(
      '<CslugIsland :island-component="X" island-hydrate="load"></CslugIsland>',
    )
    expect(rewriteIslands(sfc('<X :a="1" />'), 'p.vue')).toContain('<X :a="1" />')
  })

  test('slot content is an error (except #fallback); bad modes and :hydrate are errors', () => {
    expect(() => rewriteIslands(sfc('<X hydrate>text</X>'), 'p.vue')).toThrow('cannot receive slot content')
    expect(() =>
      rewriteIslands(sfc('<X hydrate :ssr="false"><template #fallback>…</template></X>'), 'p.vue'),
    ).not.toThrow()
    expect(() => rewriteIslands(sfc('<X hydrate="soon" />'), 'p.vue')).toThrow(
      'use load, idle, visible, none or media:(…)',
    )
    expect(() => rewriteIslands(sfc('<X :hydrate="mode" />'), 'p.vue')).toThrow('must be a literal')
    expect(() => rewriteIslands(sfc('<X hydrate="media:(max-width: 48rem)" />'), 'p.vue')).not.toThrow()
  })

  test('compiled components carry their id; scoped SCSS with @/ resolves; ids are stable', () => {
    const c = compileSfc(`${FIXTURE}/resources/components/day-card.vue`, { root: FIXTURE, ssr: true })
    expect(c.id).toBe('components/day-card')
    expect(c.code).toContain('_sfc_main.__cslugId = "components/day-card"')
    expect(c.css).toMatch(/\.day-card\[data-v-[0-9a-f]{8}\]\s*\{\s*padding: 0\.75rem;\s*color: #0f766e;/)
    const client = compileSfc(`${FIXTURE}/resources/components/day-card.vue`, { root: FIXTURE, ssr: false })
    expect(client.code.match(/data-v-[0-9a-f]{8}/)?.[0]).toBe(c.css.match(/data-v-[0-9a-f]{8}/)?.[0]) // same scope id both sides
  })
})
