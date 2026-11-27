import { type Application, Clock, ConflictError, CslugError, currentContext, NotFoundError } from '@cslug/core'
import type { Agent, AgentOutput } from './agent'
import { Ai, type AiResult, type RunRecord } from './ai'
import { AiStream } from './ai-stream'
import type { Message } from './model'

type AgentClass<A extends Agent> = abstract new (...args: never[]) => A

/** Who a conversation belongs to: a user row (`{ id }`), or another kind of owner with `ownerType`. */
export type OwnerRef = { id: string | number }

export type ConversationRow = {
  id: string
  agent: string
  ownerType: string | null
  ownerId: string | null
  title: string | null
  metadata: Record<string, unknown>
  messageCount: number
  createdAt: Date
  updatedAt: Date
}

/** Where conversations, messages and runs are kept (`cslug_ai_*` tables, set by `AiProvider` with @cslug/database). */
export interface ConversationStore {
  create(
    row: Pick<ConversationRow, 'id' | 'agent' | 'ownerType' | 'ownerId' | 'title' | 'metadata' | 'createdAt'>,
  ): Promise<void>
  find(id: string): Promise<ConversationRow | null>
  list(where: {
    ownerType: string | null
    ownerId: string | null
    agent?: string
    limit: number
  }): Promise<ConversationRow[]>
  messages(id: string): Promise<Message[]>
  /** Append after exactly `after` messages; false when another turn was stored first. */
  append(id: string, after: number, messages: Message[], runId: string): Promise<boolean>
  update(id: string, changes: { title?: string | null; metadata?: Record<string, unknown> }): Promise<void>
  delete(id: string): Promise<void>
  recordRun(run: RunRecord): Promise<void>
}

export type StartOptions = {
  /** The owner: the signed-in user by default; `null` for none (anyone with the id can continue it). */
  owner?: OwnerRef | null
  /** The kind of owner (default `user`; only `user` owners are matched with the signed-in user). */
  ownerType?: string
  title?: string
  metadata?: Record<string, unknown>
}

export type FindOptions = {
  /** Check against this owner instead of the signed-in user (a job, another kind of owner). */
  owner?: OwnerRef
  ownerType?: string
}

/** A stored conversation with one agent: each `send` continues it and stores the new messages. */
export class Conversation<A extends Agent = Agent> {
  constructor(
    private row: ConversationRow,
    readonly agent: A,
    private readonly store: ConversationStore,
    private readonly ai: Ai,
  ) {}

  get id(): string {
    return this.row.id
  }
  get title(): string | null {
    return this.row.title
  }
  get metadata(): Record<string, unknown> {
    return this.row.metadata
  }
  get owner(): { type: string; id: string } | null {
    return this.row.ownerType && this.row.ownerId ? { type: this.row.ownerType, id: this.row.ownerId } : null
  }
  get createdAt(): Date {
    return this.row.createdAt
  }

  /** Every stored message, oldest first (provider blocks included; send them back unchanged). */
  messages(): Promise<Message[]> {
    return this.store.messages(this.id)
  }

  /** Continue the conversation; the new messages are stored with the run's id. */
  async send(input: string, options: { context?: Record<string, unknown> } = {}): Promise<AiResult<AgentOutput<A>>> {
    const history = await this.messages()
    const result = await this.ai.result(this.agent, { input, history, ...options }, this.meta())
    await this.storeTurn(history.length, result)
    return result as AiResult<AgentOutput<A>>
  }

  /** `send` as a stream: the text as it arrives; the messages are stored once it has been read. */
  stream(input: string, options: { context?: Record<string, unknown> } = {}): AiStream<AgentOutput<A>> {
    const self = this
    return new AiStream(
      (async function* () {
        const history = await self.messages()
        const inner = self.ai.stream(self.agent, { input, history, ...options }, self.meta())
        for await (const text of inner) yield { type: 'text' as const, text }
        const result = await inner.result
        await self.storeTurn(history.length, result)
        yield { type: 'result' as const, result }
      })(),
    )
  }

  /** Change the title or replace the metadata. */
  async update(changes: { title?: string | null; metadata?: Record<string, unknown> }): Promise<void> {
    await this.store.update(this.id, changes)
    this.row = { ...this.row, ...changes } as ConversationRow
  }

  /** Delete the conversation and its messages (its run records stay, without the link). */
  delete(): Promise<void> {
    return this.store.delete(this.id)
  }

  private meta() {
    return { conversationId: this.id, compact: true }
  }

  private async storeTurn(after: number, result: AiResult): Promise<void> {
    const stored = await this.store.append(this.id, after, result.messages.slice(after), result.runId)
    if (!stored)
      throw new ConflictError(
        'ai.conversation_changed',
        { id: this.id },
        'Another message was added to this conversation during the run; reload it and send again',
      )
    this.row = { ...this.row, messageCount: result.messages.length }
  }
}

const ownerKey = (owner: OwnerRef | null | undefined, type = 'user') =>
  owner ? { ownerType: type, ownerId: String(owner.id) } : { ownerType: null, ownerId: null }

const signedIn = (): OwnerRef | undefined => {
  const id = currentContext()?.userId
  return id === undefined || id === null ? undefined : { id: String(id) }
}

/**
 * Stored conversations (`@inject(Conversations)`), with @cslug/database: `start(Agent, { owner })`, `find(Agent, id)`
 * (owner checked), `list()`.
 */
export class Conversations {
  /** Set by `AiProvider` when @cslug/database is installed. */
  store?: ConversationStore

  constructor(private readonly app: Application) {}

  private get db(): ConversationStore {
    if (!this.store)
      throw new CslugError(
        'ai.no_database',
        'Stored conversations need @cslug/database (cslug add database); without it, pass `history` to run()',
      )
    return this.store
  }

  private open<A extends Agent>(row: ConversationRow, agent: AgentClass<A>): Conversation<A> {
    return new Conversation(row, this.app.resolve(agent as never) as A, this.db, this.app.resolve(Ai))
  }

  /** A new conversation with `agent`, owned by the signed-in user unless `owner` says otherwise. */
  async start<A extends Agent>(agent: AgentClass<A>, options: StartOptions = {}): Promise<Conversation<A>> {
    const owner = options.owner === undefined ? signedIn() : options.owner
    const row = {
      id: Bun.randomUUIDv7(),
      agent: agent.name,
      ...ownerKey(owner, options.ownerType),
      title: options.title ?? null,
      metadata: options.metadata ?? {},
      createdAt: this.app.resolve(Clock).now(),
    }
    await this.db.create(row)
    return this.open({ ...row, messageCount: 0, updatedAt: row.createdAt }, agent)
  }

  /**
   * A conversation with `agent`, if its owner is the signed-in user (or `options.owner`); a conversation without an
   * owner is open to anyone with its id. Anything else is a `NotFoundError`, so ids are not confirmed to strangers.
   */
  async find<A extends Agent>(agent: AgentClass<A>, id: string, options: FindOptions = {}): Promise<Conversation<A>> {
    const row = UUID.test(id) ? await this.db.find(id) : null
    if (!row || row.agent !== agent.name || !this.allowed(row, options)) throw new NotFoundError('conversation', id)
    return this.open(row, agent)
  }

  /** The owner's conversations, most recent first (default: the signed-in user's). */
  async list<A extends Agent>(
    options: FindOptions & { agent?: AgentClass<A>; limit?: number } = {},
  ): Promise<ConversationRow[]> {
    const owner = options.owner ?? signedIn()
    if (!owner) return []
    return this.db.list({
      ...ownerKey(owner, options.ownerType),
      ...(options.agent ? { agent: options.agent.name } : {}),
      limit: options.limit ?? 50,
    })
  }

  private allowed(row: ConversationRow, { owner, ownerType = 'user' }: FindOptions): boolean {
    if (row.ownerId === null) return true
    const expected = owner ?? (row.ownerType === 'user' ? signedIn() : undefined)
    return !!expected && row.ownerType === (owner ? ownerType : 'user') && row.ownerId === String(expected.id)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
