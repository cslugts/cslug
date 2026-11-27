import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Application, CslugError, Logger } from '@cslug/core'
import type { Agent, AgentSettings, RunOptions } from './agent'
import { Ai, type AiConfig, type AiResult, type RunMeta } from './ai'
import { AiStream } from './ai-stream'
import type { Message } from './model'

type AgentClass<A extends Agent = Agent> = abstract new (...args: never[]) => A
/** A recorded run: the agent, its input and context. */
export type AiRun = { agent: AgentSettings } & Required<RunOptions>

/** `tests/fixtures/ai/<name>.json`: a real run, written by `cslug ai:record`, replayed by `t.ai.fixture()`. */
export type AiFixture = {
  agent: string
  input: string
  context: Record<string, unknown>
  /** The conversation before this run, when it continued one. */
  history?: Message[]
  /** The model's answer before validation (parsed JSON, or the text). */
  output: unknown
  model: string
  recordedAt: string
}

/** The folder fixtures live in, under the app root. */
export const FIXTURES_DIR = 'tests/fixtures/ai'

const textOf = (raw: unknown) => (typeof raw === 'string' ? raw : JSON.stringify(raw))

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

  /** An agent's answer: a value, or a function of the run (its input, context, history). */
  respond<A extends Agent>(agent: AgentClass<A>, answer: (run: AiRun) => unknown): this
  respond<A extends Agent>(agent: AgentClass<A>, output: unknown): this
  respond<A extends Agent>(agent: AgentClass<A>, output: unknown): this {
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
      ...(run.history.length ? { history: run.history } : {}),
      output: result.raw,
      model: result.model,
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stderr.write(`recorded ${path} (${result.model}, $${(result.costUsd ?? 0).toFixed(4)})\n`)
    return result.raw
  }

  /** The fake's answer as a run result: no provider call, no cost; `messages` continue the `history`. */
  override async result(
    agent: AgentSettings,
    { input, context = {}, history = [] }: RunOptions,
    _meta?: RunMeta,
  ): Promise<AiResult> {
    const run: AiRun = { agent, input, context, history }
    this.runs.push(run)
    const answer = [...this.answers].find(([cls]) => agent instanceof cls)?.[1]
    if (!answer)
      throw new Error(`No fake answer for ${agent.constructor.name}: t.ai.respond(${agent.constructor.name}, …)`)
    const raw = await answer(run)
    const value = agent.output ? this.validate(agent, raw) : String(raw)
    return {
      runId: Bun.randomUUIDv7(),
      value,
      raw,
      model: 'fake',
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      messages: [
        ...history,
        { role: 'user', content: [{ type: 'text', text: input }] },
        { role: 'assistant', content: [{ type: 'text', text: textOf(raw) }] },
      ],
    }
  }

  /** The whole answer as one piece of text, then the result. */
  override stream(agent: AgentSettings, options: RunOptions, _meta?: RunMeta): AiStream {
    const result = this.result(agent, options)
    return new AiStream(
      (async function* () {
        const done = await result
        yield { type: 'text' as const, text: textOf(done.raw) }
        yield { type: 'result' as const, result: done }
      })(),
    )
  }

  override async close(): Promise<void> {
    await this.real?.close()
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
