import { currentContext, resolve } from '@cslug/core'
import { v } from '@cslug/validation'
import type { RunnableTool } from './agent'
import { Ai } from './ai'
import type { Message } from './model'

/** What the tools use of a `@cslug/search` index (structural: this package does not import search). */
export type SearchableIndex = {
  readonly name: string
  search(
    term: string,
    options: {
      page?: number
      perPage?: number
      filter?: Record<string, unknown>
      highlight?: { words?: number; fragments?: number }
    },
  ): Promise<{
    data: {
      key: string
      title: string
      metadata: Record<string, unknown>
      rank: number
      highlight?: { body: string }
    }[]
    meta: { page: number; total: number; lastPage: number }
  }>
  upsertMany(
    documents: { key: string; title?: string; body?: string; metadata?: Record<string, unknown> }[],
  ): Promise<void>
  removeWhere(filter: Record<string, unknown>): Promise<number>
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }
/** A highlight as plain text for a model: marks dropped, entities decoded. */
const plain = (html = '') => html.replace(/<\/?mark>/g, '').replace(/&(amp|lt|gt|quot);/g, (e) => ENTITIES[e] ?? e)

const searchInput = v.object({
  query: v.string().min(1).max(300).describe('What to look for, in the words of the question'),
  page: v.int().min(1).optional().describe('Result page, from 1'),
})

export type SearchToolOptions = {
  /** The tool's name for the model (default `search_<index>`). */
  name?: string
  /** What the index holds, for the model to know when to search it. */
  description?: string
  /** Results per call (default 5). */
  perPage?: number
  /** Always applied: `{ published: true }`, a tenant… */
  filter?: Record<string, unknown>
  /** Snippet length in words (default 40). */
  words?: number
}

/**
 * A tool an agent searches an index with: `tools = [searchTool(helpIndex, { description: 'The help center' })]`.
 * The model sends `{ query, page? }` and reads `{ results: [{ key, title, snippet, metadata }], total, page,
 * lastPage }`, snippets in plain text.
 */
export function searchTool(index: SearchableIndex, options: SearchToolOptions = {}): RunnableTool {
  const name = options.name ?? `search_${index.name.replace(/[^a-zA-Z0-9_]/g, '_')}`
  return {
    name,
    description: `${options.description ?? `Search the "${index.name}" index`}. Returns the best matches with a snippet each.`,
    input: searchInput,
    async handle(input: never) {
      const { query, page } = input as v.infer<typeof searchInput>
      const found = await index.search(query, {
        page: page ?? 1,
        perPage: options.perPage ?? 5,
        highlight: { words: options.words ?? 40, fragments: 2 },
        ...(options.filter ? { filter: options.filter } : {}),
      })
      return {
        results: found.data.map((d) => ({
          key: d.key,
          title: d.title,
          snippet: plain(d.highlight?.body),
          metadata: d.metadata,
        })),
        total: found.meta.total,
        page: found.meta.page,
        lastPage: found.meta.lastPage,
      }
    },
  }
}

/** The conversation a run belongs to (set by `Conversation.send` / `stream` in the ambient context). */
export type ConversationScope = { id: string; owner: { type: string; id: string } | null }
export const CONVERSATION_KEY = 'aiConversation'
export const currentConversation = (): ConversationScope | undefined =>
  currentContext()?.[CONVERSATION_KEY] as ConversationScope | undefined

/** The text of a message (its text blocks), or '' for tool rounds and provider blocks. */
export const messageText = (m: Message) =>
  m.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim()

/**
 * Store a turn's text messages in the recall index (`ai.recall`), keyed `<conversation>:<position>`, with the
 * owner in the metadata so recall stays within one owner's conversations.
 */
export async function remember(index: SearchableIndex, scope: ConversationScope, after: number, messages: Message[]) {
  if (!scope.owner) return // an unowned conversation is nobody's to recall
  const owner = scope.owner
  const documents = messages.flatMap((m, i) => {
    const body = messageText(m)
    return body
      ? [
          {
            key: `${scope.id}:${after + i}`,
            body,
            metadata: { ownerType: owner.type, ownerId: owner.id, conversationId: scope.id, role: m.role },
          },
        ]
      : []
  })
  if (documents.length) await index.upsertMany(documents)
}

const recallInput = v.object({
  query: v.string().min(1).max(300).describe('What the user said or was told before, in their words'),
})

/**
 * A tool for a stored conversation's agent to look up what the same owner said in their earlier conversations
 * (needs `ai.recall`). It only ever searches the current conversation's owner, never the model's choice.
 */
export function recallTool(options: { perPage?: number } = {}): RunnableTool {
  return {
    name: 'recall_conversations',
    description:
      "Search this user's earlier conversations (not the current one) for something they said or were told. " +
      'Returns matching messages with their role and conversation.',
    input: recallInput,
    async handle(input: never) {
      const { query } = input as v.infer<typeof recallInput>
      const scope = currentConversation()
      const recall = resolve(Ai).recallIndex
      if (!recall) return 'Recall is not enabled (ai.recall).'
      if (!scope?.owner) return 'There is no earlier conversation to search: this conversation has no owner.'
      const perPage = options.perPage ?? 5
      const found = await recall.search(query, {
        perPage: perPage * 2,
        filter: { ownerType: scope.owner.type, ownerId: scope.owner.id },
        highlight: { words: 60, fragments: 0 }, // the message from its start: messages are short
      })
      const results = found.data
        .filter((d) => d.metadata.conversationId !== scope.id)
        .slice(0, perPage)
        .map((d) => ({
          conversationId: d.metadata.conversationId,
          role: d.metadata.role,
          text: plain(d.highlight?.body),
        }))
      return { results }
    },
  }
}
