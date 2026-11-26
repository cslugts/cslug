import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { checkGraph, importSpecifiers } from './check-graph'
import { graph, topoOrder } from './package-graph'
import { isVersion, pinWorkspacePeers } from './release'

describe('package graph', () => {
  test('the repository matches the documented graph', () => {
    expect(checkGraph(join(import.meta.dir, '..'))).toEqual([])
  })

  test('publish order puts every package after the packages it depends on', () => {
    const order = topoOrder()
    expect(order).toHaveLength(Object.keys(graph).length)
    for (const [name, spec] of Object.entries(graph)) {
      for (const dep of [...spec.requires, ...(spec.optional ?? [])]) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(name))
      }
    }
    expect(order[0]).toBe('validation')
  })

  test('import specifiers are found in static, dynamic, type and side-effect imports', () => {
    const code = `
      import { a } from '@cslug/core'
      import type { B } from "@cslug/http"
      export { c } from './c'
      const d = await import('@cslug/queue')
      import 'vue/server-renderer'
    `
    expect(importSpecifiers(code)).toEqual(['@cslug/core', '@cslug/http', './c', '@cslug/queue', 'vue/server-renderer'])
  })
})

describe('release', () => {
  test('versions are validated', () => {
    expect(isVersion('0.1.0')).toBe(true)
    expect(isVersion('1.0.0-beta.1')).toBe(true)
    expect(isVersion('v0.1.0')).toBe(false)
    expect(isVersion(undefined)).toBe(false)
  })

  test('workspace peers are pinned to the release version, others kept', () => {
    const pkg = {
      name: '@cslug/vue',
      version: '0.2.0',
      peerDependencies: { '@cslug/http': 'workspace:*', vue: '^3.5.0' },
    }
    expect(pinWorkspacePeers(pkg, '0.2.0').peerDependencies).toEqual({ '@cslug/http': '0.2.0', vue: '^3.5.0' })
  })
})
