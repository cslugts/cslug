import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command, flag, Logger, ServiceProvider } from '@cslug/core'
import { Ai, type AiConfig } from './ai'

/** `cslug ai:prompts`: the prompt files and the variables each one needs. */
export class AiPromptsCommand extends Command {
  static signature = 'ai:prompts'
  static description = 'List resources/prompts/*.md and their {{ variables }}'
  static boot = false
  static args = { json: flag.boolean() }

  handle({ json }: Command.Args<typeof AiPromptsCommand>) {
    const dir = join(this.app.rootDir, 'resources/prompts')
    const rows = existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[])
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => ({
            prompt: f.replace(/\.md$/, ''),
            variables: [
              ...new Set([...readFileSync(join(dir, f), 'utf8').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])),
            ].join(', '),
          }))
      : []
    if (json) this.line(JSON.stringify(rows))
    else if (rows.length) this.table(rows)
    else this.info('No prompts in resources/prompts')
  }
}

/** Binds `Ai` from `config/ai.ts` (`default`, `providers`, `models`); contributes `ai:prompts`. */
export class AiProvider extends ServiceProvider {
  register() {
    this.commands([AiPromptsCommand])
    this.app.singleton(
      Ai,
      (c) => new Ai(this.app, this.app.config<AiConfig | undefined>('ai') ?? {}, c.resolve(Logger)),
    )
  }
}
