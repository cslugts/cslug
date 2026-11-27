import { join } from 'node:path'
import { arg, COMMANDS, Command, type CommandClass, flag, names, parseArgs } from '@cslug/core'
import { HttpKernel } from './kernel'
import { Router } from './router'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug serve`: the HTTP server; SIGTERM drains in-flight requests (`http.shutdownTimeout`), then exits. */
export class ServeCommand extends Command {
  static signature = 'serve'
  static description = 'Start the HTTP server'
  static longRunning = true
  static args = {
    port: flag.number().optional().describe('Port (default: config http.port, PORT, or 3000)'),
    host: flag.string().optional().describe('Interface to bind (default: all)'),
    reusePort: flag.boolean().describe('Share the port between several processes (cslug start with web instances > 1)'),
    withWorker: flag.boolean().describe('Also run queue:work in this process (needs @cslug/queue)'),
    withScheduler: flag.boolean().describe('Also run schedule:work in this process (needs ScheduleProvider)'),
  }

  async handle({ port, host, reusePort, withWorker, withScheduler }: Command.Args<typeof ServeCommand>) {
    // http does not import the queue: the other roles run through their own commands, found by signature
    const roles = [withWorker && 'queue:work', withScheduler && 'schedule:work'].filter((r): r is string => !!r)
    const found = this.app.taggedTokens(COMMANDS) as CommandClass[]
    for (const signature of roles) {
      if (!found.some((c) => c.signature === signature)) {
        this.error(
          `--with-${signature === 'queue:work' ? 'worker' : 'scheduler'}: no ${signature} command (is its provider listed?)`,
        )
        return 1
      }
    }
    const envPort = process.env.PORT ? Number(process.env.PORT) : undefined
    const server = this.app.resolve(HttpKernel).listen({ port: port ?? envPort, hostname: host, reusePort })
    this.log.info('http.listening', { url: server.url.toString() })
    if (process.stdout.isTTY) this.info(`Listening on ${server.url}`)
    for (const signature of roles) {
      const cmd = found.find((c) => c.signature === signature) as CommandClass
      const instance = this.app.createScope().build(cmd as never) as { handle(args: unknown): unknown }
      await instance.handle(parseArgs(cmd.args ?? {}, []))
    }
    return 0
  }
}

/** `cslug routes`: every route with its name and middleware. */
export class RoutesCommand extends Command {
  static signature = 'routes'
  static description = 'List the routes'
  static args = {
    json: flag.boolean(),
    filter: arg.string().optional().describe('Only paths or names containing this'),
  }

  handle({ json, filter }: Command.Args<typeof RoutesCommand>) {
    const rows = routeRows(this.app.resolve(Router)).filter(
      (r) => !filter || r.path.includes(filter) || r.name.includes(filter),
    )
    if (json) this.line(JSON.stringify(rows))
    else this.table(rows.map((r) => ({ ...r, middleware: r.middleware.join(', ') })))
  }
}

/** The routes as `cslug routes` and `cslug describe routes` show them. */
export const routeRows = (router: Router) =>
  router.routes.map((r) => ({
    method: r.method,
    path: `${r.domain ? `//${r.domain}` : ''}${r.path}`,
    name: r.name ?? '',
    action: actionName(r.action),
    middleware: r.middleware.map((m) => (typeof m === 'function' ? m.name || 'fn' : String(m))),
  }))

const actionName = (action: unknown): string => {
  if (Array.isArray(action)) return `${(action[0] as { name?: string })?.name}.${String(action[1])}`
  return typeof action === 'function' ? action.name || 'closure' : 'closure'
}

const makeArgs = { name: arg.string().describe('Name, optionally in a folder: admin/Claim'), force: flag.boolean() }

/** `cslug make:controller Claim [--resource]` → app/controllers/claim-controller.ts. */
export class MakeControllerCommand extends Command {
  static signature = 'make:controller'
  static description = 'Create a controller (--resource for the REST actions)'
  static boot = false
  static args = { ...makeArgs, resource: flag.boolean().describe('index, show, create, store, edit, update, destroy') }

  handle({ name, force, resource }: Command.Args<typeof MakeControllerCommand>) {
    const n = names(name, 'controller')
    const ok = this.generate(
      STUBS,
      resource ? 'controller.resource.stub' : 'controller.stub',
      `app/controllers/${n.file}.ts`,
      { ...n, plural: `${n.kebab}s` },
      force,
    )
    if (ok)
      this.line(
        `  route: r.${resource ? `resource('${n.kebab}s', ${n.class})` : `get('/${n.kebab}s', [${n.class}, 'index'])`}`,
      )
    return ok ? 0 : 1
  }
}

/** `cslug make:validator StoreClaim` → app/validators/store-claim-validator.ts. */
export class MakeValidatorCommand extends Command {
  static signature = 'make:validator'
  static description = 'Create a request validator'
  static boot = false
  static args = makeArgs
  handle({ name, force }: Command.Args<typeof MakeValidatorCommand>) {
    const n = names(name, 'validator')
    return this.generate(STUBS, 'validator.stub', `app/validators/${n.file}.ts`, n, force) ? 0 : 1
  }
}

/** `cslug make:middleware EnsureOperator` → app/middleware/ensure-operator-middleware.ts. */
export class MakeMiddlewareCommand extends Command {
  static signature = 'make:middleware'
  static description = 'Create a middleware class'
  static boot = false
  static args = makeArgs
  handle({ name, force }: Command.Args<typeof MakeMiddlewareCommand>) {
    const n = names(name, 'middleware')
    return this.generate(STUBS, 'middleware.stub', `app/middleware/${n.file}.ts`, n, force) ? 0 : 1
  }
}

export const httpCommands = [
  ServeCommand,
  RoutesCommand,
  MakeControllerCommand,
  MakeValidatorCommand,
  MakeMiddlewareCommand,
]
