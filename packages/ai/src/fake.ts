import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Application, CslugError, Logger } from '@cslug/core'
import type { Agent, AgentSettings, RunOptions } from './agent'
import { Ai, type AiConfig } from './ai'

type AgentClass<A extends Agent = Agent> = abstract new (...args: never[]) => A
/** A recorded run: the agent, its input and context. */
export type AiRun = { agent: AgentSettings } & Required<RunOptions>

/** `tests/fixtures/ai/<name>.json`: a real run, written by `cslug ai:record`, replayed by `t.ai.fixture()`. */
export type AiFixture = {
  agent: string
  input: string
  context: Record<string, unknown>
  /** The model's answer before validation (parsed JSON, or the text). */
  output: unknown
  model: string
  recordedAt: string
}

/** The folder fixtures live in, under the app root. */
export const FIXTURES_DIR = 'tests/fixtures/ai'

export const readFixture = (path: string): AiFixture => JSON.parse(readFileSync(path, 'utf8')) as AiFixture

/**
 * AI in tests (`testApp({ fakes: ['ai'] })` → `t.ai`): no provider is called. `respond(Agent, output)` gives an agent
 * its answer (checked against its `output` schema, so fixtures stay valid); every run is recorded.
 */
export class AiFake extends Ai {
  readonly runs: AiRun[] = []
  private readonly answers = new Map<AgentClass, (run: AiRun) => unknown>()
  private real?: Ai

  constructor(app: Application) {
    super(app, {}, Logger.null())
  }

  respond<A extends Agent>(agent: AgentClass<A>, output: unknown | ((run: AiRun) => unknown)): this {
    this.answers.set(agent, typeof output === 'function' ? (output as (run: AiRun) => unknown) : () => output)
    return this
  }

  /**
   * Answer an agent with a recorded fixture, `tests/fixtures/ai/<name>.json`. `cslug ai:record` runs the test against
   * the real provider and writes the fixtures that are missing (`--all`: every one).
   */
  fixture<A extends Agent>(agent: AgentClass<A>, name: string): this {
    const path = join(this.app.rootDir, FIXTURES_DIR, `${name}.json`)
    return this.respond(agent, async (run: AiRun) => {
      const mode = process.env.CSLUG_AI_RECORD
      if (mode === 'all' || (mode && !existsSync(path))) return this.record(run, path)
      if (!existsSync(path))
        throw new CslugError(
          'ai.no_fixture',
          `No AI fixture ${FIXTURES_DIR}/${name}.json: record it with \`cslug ai:record <this test file>\``,
        )
      return readFixture(path).output
    })
  }

  /** Run against the real provider (config `ai`) and write the fixture. */
  private async record(run: AiRun, path: string): Promise<unknown> {
    this.real ??= new Ai(this.app, this.app.config<AiConfig | undefined>('ai') ?? {}, Logger.null())
    const result = await this.real.result(run.agent, run)
    const fixture: AiFixture = {
      agent: run.agent.constructor.name,
      input: run.input,
      context: run.context,
      output: result.raw,
      model: result.model,
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stderr.write(`recorded ${path} (${result.model}, $${(result.costUsd ?? 0).toFixed(4)})\n`)
    return result.raw
  }

  override async run(agent: AgentSettings, { input, context = {} }: RunOptions): Promise<unknown> {
    const run: AiRun = { agent, input, context }
    this.runs.push(run)
    const answer = [...this.answers].find(([cls]) => agent instanceof cls)?.[1]
    if (!answer)
      throw new Error(`No fake answer for ${agent.constructor.name}: t.ai.respond(${agent.constructor.name}, …)`)
    const value = await answer(run)
    return agent.output ? this.validate(agent, value) : String(value)
  }

  override async close(): Promise<void> {
    await this.real?.close()
  }

  override async *stream(agent: AgentSettings, options: RunOptions): AsyncIterable<string> {
    const value = await this.run(agent, options)
    yield typeof value === 'string' ? value : JSON.stringify(value)
  }

  ran<A extends Agent>(agent: AgentClass<A>): AiRun[] {
    return this.runs.filter((r) => r.agent instanceof agent)
  }

  assertRan<A extends Agent>(agent: AgentClass<A>, where?: (run: AiRun) => boolean): void {
    if (!this.ran(agent).some((r) => !where || where(r)))
      throw new Error(
        `Expected ${agent.name} to run${where ? ' (matching)' : ''}; ran: ${this.runs.map((r) => r.agent.constructor.name).join(', ') || 'none'}`,
      )
  }

  assertNotRan<A extends Agent>(agent: AgentClass<A>): void {
    if (this.ran(agent).length) throw new Error(`Expected ${agent.name} not to run`)
  }
}

export function installAiFake(app: Application): AiFake {
  const fake = new AiFake(app)
  app.swap(Ai, fake)
  return fake
}
