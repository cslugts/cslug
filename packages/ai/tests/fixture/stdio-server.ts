/** `cslug mcp:serve` as a child process: the fixture app's @mcp() tools over stdio. */
import { Application, Logger, runInContext } from '@cslug/core'
import { AiProvider, McpServeCommand } from '../../src'

const app = new Application({ root: import.meta.dir, configs: { app: { name: 'Fixture' } } }).useProviders([AiProvider])
app.singleton(Logger, () => Logger.null())
await app.start()
await runInContext({ app, scope: app.createScope() }, () => new McpServeCommand().handle())
