import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, Command } from '@cslug/core'

type Scope = Record<string, unknown>
export type Evaluated = { value?: unknown; error?: unknown; incomplete?: boolean }

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (scope: Scope) => Promise<unknown>
const transpiler = new Bun.Transpiler({ loader: 'ts', trimUnusedImports: false })

/** Everything `app/tables/` and `app/repositories/` export, plus `app`, `resolve` and `config`. */
export async function replScope(app: Application): Promise<Scope> {
  const scope: Scope = {
    app,
    resolve: app.resolve.bind(app),
    config: (path: string) => app.config(path),
  }
  for (const folder of ['app/tables', 'app/repositories']) {
    const dir = join(app.rootDir, folder)
    if (!existsSync(dir)) continue
    for (const file of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /(?<!\.test)\.ts$/.test(f)))
      Object.assign(scope, await import(join(dir, file)))
  }
  return scope
}

/**
 * Run one input in the scope: TypeScript, top-level `await`; `const` / `let` / `var x = …`, functions and classes
 * declared at the start of a line are kept for the next inputs. An expression's value is returned; input that ends
 * early (an open brace) is `incomplete`.
 */
const DECLARATION = /^\s*(?:const|let|var|class|function|async\s+function|import|export)\b/

export async function evaluate(code: string, scope: Scope): Promise<Evaluated> {
  let run: (scope: Scope) => Promise<unknown>
  try {
    run = (DECLARATION.test(code) ? undefined : asExpression(code)) ?? asStatements(code)
  } catch (error) {
    return /end of file|unexpected end/i.test(String(error)) ? { incomplete: true } : { error }
  }
  try {
    return { value: await run(scope) }
  } catch (error) {
    return { error }
  }

  // an expression's value is kept by assigning it (the transpiler drops expression statements without effects)
  function asExpression(input: string) {
    let js: string
    try {
      js = transpiler.transformSync(`__value = (${input}\n)`).trim()
    } catch {
      return undefined
    }
    const body = js.replace(/^__value\s*=\s*/, '').replace(/;\s*$/, '')
    return new AsyncFunction('scope', `with (scope) { return (${body}\n) }`)
  }

  // a declaration at the start of a line becomes an assignment to the scope, so later inputs see it
  function asStatements(input: string) {
    const keep = (name: string) => {
      scope[name] = undefined
      return name
    }
    const js = transpiler
      .transformSync(input)
      .replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, (_m, name: string) => `${keep(name)} =`)
      .replace(
        /^((?:async\s+)?function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
        (m, _kind, name: string) => `${keep(name)} = ${m}`,
      )
    return new AsyncFunction('scope', `with (scope) { ${js}\n}`)
  }
}

/** `cslug repl`: a TypeScript shell with the app booted. `.help` lists the names in scope, `.exit` leaves. */
export class ReplCommand extends Command {
  static signature = 'repl'
  static description = 'A TypeScript shell with the app booted (tables and repositories in scope)'

  /** Where lines come from (stdin; tests pass their own). */
  input: AsyncIterable<string> = console

  async handle() {
    const scope = await replScope(this.app)
    const names = () => Object.keys(scope).sort().join(', ')
    this.line(`cslug repl: top-level await; in scope: ${names()}. .help, .exit`)
    let buffer = ''
    this.io.write('cslug> ')
    for await (const line of this.input) {
      const command = buffer ? undefined : line.trim()
      if (command === '.exit') break
      if (command === '.help') this.line(`In scope: ${names()}. Other modules: await import(path).`)
      else if (command !== '') {
        buffer = buffer ? `${buffer}\n${line}` : line
        const result = await evaluate(buffer, scope)
        if (result.incomplete) {
          this.io.write('...    ')
          continue
        }
        buffer = ''
        if ('error' in result) this.error(result.error instanceof Error ? result.error.message : String(result.error))
        else this.line(Bun.inspect(result.value, { colors: this.io.color }))
      }
      this.io.write('cslug> ')
    }
    return 0
  }
}
