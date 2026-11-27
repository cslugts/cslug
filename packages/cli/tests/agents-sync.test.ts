import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeAgents } from '../src'
import { cli } from './support'

const sections = [
  { name: 'stack', body: '## Stack\n\nv2' },
  { name: 'rules', body: '## Rules\n\n- one' },
]

describe('mergeAgents', () => {
  test('a new file: a hand-editable header, then the generated sections between markers', () => {
    const text = mergeAgents(undefined, sections, '`albastr`')
    expect(text).toStartWith(
      '# AGENTS.md\n\nInstructions for AI coding agents working on `albastr`.\n\n## Project notes',
    )
    expect(text).toContain('<!-- cslug:begin stack -->\n## Stack\n\nv2\n<!-- cslug:end stack -->')
    expect(text.indexOf('cslug:begin stack')).toBeLessThan(text.indexOf('cslug:begin rules'))
    expect(mergeAgents(text, sections)).toBe(text) // stable: a second sync changes nothing
  })

  test('hand-written text is kept; generated sections are replaced in place; missing ones are appended', () => {
    const existing = [
      '# AGENTS.md — Albastr',
      '',
      'Glossary: a *circuit* is a multi-day route.',
      '',
      '<!-- cslug:begin stack -->',
      '## Stack',
      '',
      'v1 (old)',
      '<!-- cslug:end stack -->',
      '',
      "Don't: send WhatsApp messages from controllers.",
      '',
    ].join('\n')
    const text = mergeAgents(existing, sections)
    expect(text).toContain('Glossary: a *circuit* is a multi-day route.')
    expect(text).toContain("Don't: send WhatsApp messages from controllers.")
    expect(text).not.toContain('v1 (old)')
    // replaced where it was, between the two hand-written paragraphs
    expect(text.indexOf('Glossary')).toBeLessThan(text.indexOf('v2'))
    expect(text.indexOf('v2')).toBeLessThan(text.indexOf("Don't"))
    expect(text.trimEnd()).toEndWith('<!-- cslug:end rules -->')
  })

  test('<!-- cslug:off name --> keeps a section out; $ in a body is literal', () => {
    const text = mergeAgents('# Mine\n\n<!-- cslug:off rules -->\n', [
      { name: 'stack', body: 'costs $1 and $& stays' },
      ...sections.slice(1),
    ])
    expect(text).not.toContain('cslug:begin rules')
    expect(text).toContain('costs $1 and $& stays')
  })
})

describe('cslug agents:sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cslug-agents-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'AGENTS.md')

  test('creates, then keeps up to date; --check fails only when it is stale', async () => {
    const created = await cli(['agents:sync', `--file=${file}`])
    expect(created.code).toBe(0)
    expect(created.out).toContain('Created')
    const text = readFileSync(file, 'utf8')
    for (const name of ['stack', 'rules', 'layout', 'commands', 'app', 'tools'])
      expect(text).toContain(`<!-- cslug:begin ${name} -->`)
    expect(text).toContain('`agents:sync`') // commands, from the kernel
    expect(text).toContain('`mcp:dev`')
    expect(text).toContain('Routes (') // the fixture's http routes
    expect(text).toContain('{ "mcpServers": { "cslug"')

    expect((await cli(['agents:sync', '--check', `--file=${file}`])).code).toBe(0)
    writeFileSync(file, text.replace('## Project notes', '## Project notes\n\nOur glossary.'))
    expect((await cli(['agents:sync', '--check', `--file=${file}`])).code).toBe(0) // hand edits are fine

    writeFileSync(file, readFileSync(file, 'utf8').replace('## Rules', '## Rules (edited inside the markers)'))
    const stale = await cli(['agents:sync', '--check', `--file=${file}`])
    expect(stale.code).toBe(1)
    expect(stale.out).toContain('out of date')
    expect(readFileSync(file, 'utf8')).toContain('(edited inside the markers)') // --check writes nothing

    expect((await cli(['agents:sync', `--file=${file}`])).out).toContain('Updated')
    const synced = readFileSync(file, 'utf8')
    expect(synced).not.toContain('(edited inside the markers)')
    expect(synced).toContain('Our glossary.')
  })
})
