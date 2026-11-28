import { join } from 'node:path'
import { defineGenerator } from '@cslug/core'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:agent OfferExtractor` → `app/agents/offer-extractor-agent.ts`. */
export const MakeAgentCommand = defineGenerator({
  kind: 'agent',
  description: 'Create an AI agent',
  stubs: STUBS,
  files: (n) => [{ stub: 'agent.stub', target: `app/agents/${n.file}.ts` }],
})

/** `cslug make:tool FindOperators` → `app/tools/find-operators-tool.ts` (its model-facing name: find_operators). */
export const MakeToolCommand = defineGenerator({
  kind: 'tool',
  description: 'Create an AI tool',
  stubs: STUBS,
  files: (n) => [{ stub: 'tool.stub', target: `app/tools/${n.file}.ts` }],
})
