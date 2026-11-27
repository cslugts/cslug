import { join } from 'node:path'
import { type Application, Clock } from '@cslug/core'
import type { ConversationRow, ConversationStore } from './conversations'
import type { Message } from './model'

/** The `cslug_ai_conversations`, `cslug_ai_messages` and `cslug_ai_runs` migration (registered with @cslug/database). */
export const AI_MIGRATIONS = join(import.meta.dir, '../migrations')

/** The tables through @cslug/database (ambient transaction when there is one), or undefined without it. */
export async function databaseStore(app: Application): Promise<ConversationStore | undefined> {
  const db = await import('@cslug/database').catch(() => undefined)
  if (!db || !app.has(db.Database)) return undefined
  db.addMigrations(AI_MIGRATIONS)
  const { sql } = db
  const database = () => app.resolve(db.Database)
  const now = () => app.resolve(Clock).now()
  const row = (r: ConversationRow) => ({ ...r, metadata: r.metadata ?? {} })
  return {
    async create(c) {
      await database().exec(sql`insert into cslug_ai_conversations
          (id, agent, owner_type, owner_id, title, metadata, created_at, updated_at)
        values (${c.id}, ${c.agent}, ${c.ownerType}, ${c.ownerId}, ${c.title}, ${sql.json(c.metadata)}, ${c.createdAt},
          ${c.createdAt})`)
    },
    async find(id) {
      const found = await database().maybeOne<ConversationRow>(
        sql`select * from cslug_ai_conversations where id = ${id}`,
      )
      return found && row(found)
    },
    async list({ ownerType, ownerId, agent, limit }) {
      const rows = await database().many<ConversationRow>(sql`select * from cslug_ai_conversations
        where owner_type is not distinct from ${ownerType} and owner_id is not distinct from ${ownerId}
        ${agent ? sql`and agent = ${agent}` : sql.empty}
        order by updated_at desc, id desc limit ${limit}`)
      return rows.map(row)
    },
    async messages(id) {
      const rows = await database().many<{ role: Message['role']; content: Message['content'] }>(
        sql`select role, content from cslug_ai_messages where conversation_id = ${id} order by position`,
      )
      return rows.map(({ role, content }) => ({ role, content }))
    },
    async append(id, after, messages, runId) {
      if (!messages.length) return true
      return database().transaction(async (tx) => {
        // the count moves only if no other turn was stored since this one read the history
        const moved = await tx.exec(sql`update cslug_ai_conversations
          set message_count = message_count + ${messages.length}, updated_at = ${now()}
          where id = ${id} and message_count = ${after}`)
        if (!moved) return false
        const at = now()
        const values = messages.map(
          (m, i) => sql`(${id}, ${after + i}, ${m.role}, ${sql.json(m.content)}, ${runId}, ${at})`,
        )
        await tx.exec(sql`insert into cslug_ai_messages (conversation_id, position, role, content, run_id, created_at)
          values ${sql.join(values)}`)
        return true
      })
    },
    async update(id, { title, metadata }) {
      await database().exec(sql`update cslug_ai_conversations set
        title = ${title === undefined ? sql`title` : title},
        metadata = ${metadata === undefined ? sql`metadata` : sql.json(metadata)},
        updated_at = ${now()}
        where id = ${id}`)
    },
    async delete(id) {
      await database().exec(sql`delete from cslug_ai_conversations where id = ${id}`)
    },
    async recordRun(r) {
      await database().exec(sql`insert into cslug_ai_runs (id, agent, model, conversation_id, user_id, status, steps,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, started_at, finished_at)
        values (${r.id}, ${r.agent}, ${r.model}, ${r.conversationId ?? null}, ${r.userId ?? null}, ${r.status},
          ${r.steps}, ${r.usage.inputTokens}, ${r.usage.outputTokens}, ${r.usage.cacheReadTokens},
          ${r.usage.cacheWriteTokens}, ${r.costUsd ?? null}, ${r.error ?? null}, ${r.startedAt}, ${r.finishedAt})`)
    },
  }
}
