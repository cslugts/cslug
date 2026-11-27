/**
 * The package graph, as documented in docs/packages.md. Single source of truth for:
 * - scripts/check-graph.ts (package.json and imports must match it)
 * - scripts/release.ts (publish order)
 *
 * `requires`: @cslug packages this package may import unconditionally (peer dependencies).
 * `optional`: @cslug packages it may integrate with when present (optional peers; detected at runtime).
 * `externalPeers`: the only non-@cslug packages allowed, always as peers.
 */
export type PackageSpec = {
  description: string
  /** The npm name, when it is not `@cslug/<folder>` (create-cslug: `bun create cslug` needs that name). */
  npmName?: string
  requires: string[]
  optional?: string[]
  externalPeers?: Record<string, { range: string; optional?: boolean }>
}

export const graph: Record<string, PackageSpec> = {
  validation: {
    description: 'Schemas and validators (Zod-like API, Standard Schema, JSON Schema export).',
    requires: [],
  },
  core: {
    description:
      'Application, container and @inject, providers, config, events, logger, errors, context, Clock, Money, i18n, contracts.',
    requires: ['validation'],
  },
  http: {
    description: 'Router, middleware, HttpContext, sessions, CSRF, error rendering on Bun.serve.',
    requires: ['core', 'validation'],
  },
  vue: {
    description: 'Vue views rendered on the server, components hydrated as islands, composables and asset build.',
    requires: ['core', 'http', 'validation'],
    externalPeers: {
      vue: { range: '^3.5.0' },
      sass: { range: '^1.80.0', optional: true },
      tailwindcss: { range: '^4.0.0', optional: true },
      'bun-plugin-tailwind': { range: '>=0.1.0', optional: true },
    },
  },
  database: {
    description: 'PostgreSQL on Bun.sql: typed tables, query builder, sql tag, repositories, migrations.',
    requires: ['core'],
  },
  redis: {
    description: 'Redis connections and Redis drivers for cache, locks, rate limits and sessions.',
    requires: ['core'],
  },
  queue: {
    description: 'Jobs and workers on Redis Streams, after-commit and durable dispatch, and the scheduler.',
    requires: ['core', 'redis'],
    optional: ['database'],
  },
  auth: {
    description: 'Session and token guards, password hashing, magic links, policies and gates.',
    requires: ['core', 'http', 'database'],
  },
  mail: {
    description: 'Mailer and mailables, CSS inlining, SMTP and HTTP API transports.',
    requires: ['core'],
    optional: ['vue', 'queue'],
  },
  notification: {
    description: 'Notifications over mail, database, WhatsApp and SMS channels.',
    requires: ['core'],
    optional: ['mail', 'queue', 'database'],
  },
  storage: {
    description: 'Local and S3 disks, signed URLs, upload type sniffing.',
    requires: ['core'],
    optional: ['http'],
  },
  webhook: {
    description: 'Webhook signature verification and an exactly-once inbox.',
    requires: ['core', 'http', 'database'],
  },
  search: {
    description: 'Full-text search over any table on PostgreSQL: weighted, multilingual, accent-insensitive, ranked.',
    requires: ['core', 'database'],
  },
  telemetry: {
    description: 'Traces, metrics and logs to any OpenTelemetry collector (OTLP/HTTP), and /metrics for Prometheus.',
    requires: ['core'],
    optional: ['http'],
  },
  ai: {
    description: 'Agents, tools, structured output, conversations and MCP.',
    requires: ['core', 'validation'],
    optional: ['queue', 'http', 'database', 'search'],
  },
  cli: {
    description: 'The cslug command: generators, dev server, start supervisor, REPL, dev MCP server.',
    requires: ['core'],
    optional: ['database'],
  },
  testing: {
    description: 'Test kit: testApp(), HTTP and HTML assertions, database isolation, fakes, time travel.',
    requires: ['core'],
    optional: [
      'validation',
      'http',
      'vue',
      'database',
      'redis',
      'queue',
      'auth',
      'mail',
      'notification',
      'storage',
      'webhook',
      'ai',
      'cli',
    ],
  },
  // published last: it pins the version of everything above
  'create-cslug': {
    description: 'Create a cslug app: bun create cslug <dir>.',
    npmName: 'create-cslug',
    requires: [],
  },
}

/** Packages in dependency order (required + optional edges), for publishing. Throws on cycles. */
export function topoOrder(): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === 'done') return
    if (state.get(name) === 'visiting') throw new Error(`Cycle in package graph: ${[...path, name].join(' → ')}`)
    state.set(name, 'visiting')
    const spec = graph[name]
    if (!spec) throw new Error(`Unknown package in graph: ${name}`)
    for (const dep of [...spec.requires, ...(spec.optional ?? [])]) visit(dep, [...path, name])
    state.set(name, 'done')
    order.push(name)
  }
  for (const name of Object.keys(graph)) visit(name, [])
  return order
}

/** The npm name of a package folder. */
export const npmName = (name: string): string => graph[name]?.npmName ?? `@cslug/${name}`
