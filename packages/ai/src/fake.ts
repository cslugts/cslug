import { type Application, Logger } from '@cslug/core'
import type { Agent, AgentSettings, RunOptions } from './agent'
import { Ai } from './ai'

type AgentClass<A extends Agent = Agent> = abstract new (...args: never[]) => A
/** A recorded run: the agent, its input and context. */
export type AiRun = { agent: AgentSettings } & Required<RunOptions>

/**
 * AI in tests (`testApp({ fakes: ['ai'] })` → `t.ai`): no provider is called. `respond(Agent, output)` gives an agent
 * its answer (checked against its `output` schema, so fixtures stay valid); every run is recorded.
 */
export class AiFake extends Ai {
  readonly runs: AiRun[] = []
  private readonly answers = new Map<AgentClass, (run: AiRun) => unknown>()

  constructor(app: Application) {
    super(app, {}, Logger.null())
  }

  respond<A extends Agent>(agent: AgentClass<A>, output: unknown | ((run: AiRun) => unknown)): this {
    this.answers.set(agent, typeof output === 'function' ? (output as (run: AiRun) => unknown) : () => output)
    return this
  }

  override async run(agent: AgentSettings, { input, context = {} }: RunOptions): Promise<unknown> {
    const run: AiRun = { agent, input, context }
    this.runs.push(run)
    const answer = [...this.answers].find(([cls]) => agent instanceof cls)?.[1]
    if (!answer)
      throw new Error(`No fake answer for ${agent.constructor.name}: t.ai.respond(${agent.constructor.name}, …)`)
    const value = answer(run)
    return agent.output ? this.validate(agent, value) : String(value)
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
