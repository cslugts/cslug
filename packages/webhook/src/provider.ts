import { arg, Command, ServiceProvider } from '@cslug/core'
import { addMigrations, DatabaseProvider } from '@cslug/database'
import { WEBHOOK_MIGRATIONS, WebhookInbox } from './inbox'

/** `cslug webhooks:replay <source> <externalId>`: run the source's processor again for one stored event. */
export class WebhooksReplayCommand extends Command {
  static signature = 'webhooks:replay'
  static description = 'Process a stored webhook event again'
  static args = { source: arg.string(), externalId: arg.string() }

  async handle({ source, externalId }: Command.Args<typeof WebhooksReplayCommand>) {
    await this.app.resolve(WebhookInbox).replay(source, externalId)
    this.success(`Replayed ${source} ${externalId}`)
    return 0
  }
}

/** Registers the `cslug_webhook_inbox` migration and `webhooks:replay`. `WebhookInbox` is an `@inject` class. */
export class WebhookProvider extends ServiceProvider {
  static dependsOn = [DatabaseProvider]

  register() {
    addMigrations(WEBHOOK_MIGRATIONS)
    this.commands([WebhooksReplayCommand])
  }
}
