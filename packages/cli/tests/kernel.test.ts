import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { arg, flag } from '@cslug/core'
import { commandHelp } from '../src'
import { cli } from './support'

const spec = {
  name: arg.string().describe('Who'),
  before: arg.date().optional(),
  dryRun: flag.boolean().alias('n'),
  concurrency: flag.number().default(5),
  mode: flag.string().choices('fast', 'safe').optional(),
}

describe('the cslug kernel (guide 20)', () => {
  test('help text', () => {
    const help = commandHelp({ signature: 'demo', description: 'A demo', args: spec } as never)
    expect(help).toContain('Usage: cslug demo <name> [before] [options]')
    expect(help).toContain('-n, --dry-run')
    expect(help).toContain('--concurrency <value>')
    expect(help).toContain('[default: 5]')
    expect(help).toContain('(fast|safe)')
  })

  test('list shows built-in, package-contributed and app commands', async () => {
    const { code, out } = await cli(['list'])
    expect(code).toBe(0)
    for (const name of [
      'about',
      'config:show',
      'key:generate',
      'key:rotate',
      'start',
      'dev',
      'make:command',
      'serve',
      'routes',
      'make:controller',
      'greet',
    ]) {
      expect(out).toContain(name)
    }
    // @cslug/database is not in this app (no database url): its commands are absent
    expect(out).not.toContain('migrate')
  })

  test('an app command: DI, typed args, exit code, help', async () => {
    const r = await cli(['greet', 'ada', '--shout', '--times=2'])
    expect([r.code, r.out]).toEqual([0, expect.stringMatching(/^HELLO ADA\nHELLO ADA\ntoday \d{4}-\d{2}-\d{2}\n$/)])
    expect((await cli(['greet', 'fail'])).code).toBe(3)
    const help = await cli(['greet', '--help'])
    expect(help.out).toContain('Usage: cslug greet <name> [options]')
  })

  test('usage errors exit 2 with the help; unknown commands suggest close ones', async () => {
    const missing = await cli(['greet'])
    expect(missing.code).toBe(2)
    expect(missing.out).toContain('Missing argument <name>')
    expect(missing.out).toContain('Usage: cslug greet')
    const unknown = await cli(['rotes'])
    expect([unknown.code, unknown.out]).toEqual([2, expect.stringContaining('Did you mean: routes')])
  })

  test('routes lists the app routes (booted); config:show hides secrets', async () => {
    const routes = await cli(['routes', '--json'])
    expect(JSON.parse(routes.out)).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'POST', path: '/api/todos', name: 'todos.store' })]),
    )
    const config = await cli(['config:show', 'app'])
    expect(JSON.parse(config.out)).toEqual({ env: 'test', key: '••••••', url: 'http://localhost' })
    expect((await cli(['config:show', 'nope'])).code).toBe(1)
  })
})

describe('generators', () => {
  const root = mkdtempSync(join(tmpdir(), 'cslug-gen-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const transpiles = (path: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(path, 'utf8'))

  test('make:* writes hyphenated files with the right class names, never overwrites without --force', async () => {
    const cases: [string[], string, string][] = [
      [
        ['make:controller', 'admin/Claim', '--resource'],
        'app/controllers/admin/claim-controller.ts',
        'export class ClaimController',
      ],
      [['make:validator', 'StoreClaim'], 'app/validators/store-claim-validator.ts', 'export const StoreClaimValidator'],
      [
        ['make:middleware', 'EnsureOperator'],
        'app/middleware/ensure-operator-middleware.ts',
        'export class EnsureOperatorMiddleware',
      ],
      [
        ['make:command', 'ExpireDocuments'],
        'app/commands/expire-documents-command.ts',
        "static signature = 'expire-documents'",
      ],
      [['make:provider', 'Payment'], 'app/providers/payment-provider.ts', 'export class PaymentProvider'],
      [['make:event', 'BookingPaid'], 'app/events/booking-paid-event.ts', "('booking_paid')"],
      [['make:service', 'Escrow'], 'app/services/escrow-service.ts', 'export class EscrowService'],
      [
        ['make:exception', 'PaymentDeclined'],
        'app/exceptions/payment-declined-handler.ts',
        'export class PaymentDeclinedHandler extends ErrorHandler',
      ],
      // what `bun test` runs: *.test.ts
      [['make:test', 'Claims'], 'tests/claims.test.ts', "describe('Claims'"],
      [
        ['make:test', 'feature/BookingDepositTest'],
        'tests/feature/booking-deposit.test.ts',
        "describe('BookingDeposit'",
      ],
    ]
    for (const [argv, file, contains] of cases) {
      const r = await cli(argv, { root })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`created ${file}`)
      expect(readFileSync(join(root, file), 'utf8')).toContain(contains)
      expect(() => transpiles(join(root, file))).not.toThrow()
    }
    const again = await cli(['make:service', 'Escrow'], { root })
    expect([again.code, again.out]).toEqual([1, expect.stringContaining('exists (use --force to overwrite)')])
    expect((await cli(['make:service', 'Escrow', '--force'], { root })).code).toBe(0)
  })

  test('make:crud needs the web packages (it writes views, a policy and uses the users table)', async () => {
    const r = await cli(['make:crud', 'Claim'], { root })
    expect(r.code).toBe(1)
    expect(r.out).toContain('make:crud needs @cslug/vue, @cslug/auth, @cslug/database')
    expect(existsSync(join(root, 'app/tables/claim-table.ts'))).toBe(false)
  })

  test("the app's stubs/ override the package's", async () => {
    mkdirSync(join(root, 'stubs'), { recursive: true })
    writeFileSync(join(root, 'stubs/service.stub'), '// house style\nexport class {{ class }} {}\n')
    await cli(['make:service', 'Ledger'], { root })
    expect(readFileSync(join(root, 'app/services/ledger-service.ts'), 'utf8')).toBe(
      '// house style\nexport class LedgerService {}\n',
    )
  })

  test('database generators (with @cslug/database installed): migration name and stamp, table, repository', async () => {
    const r = await cli(['make:migration', 'create_claims'], { root, databaseUrl: 'postgres://unused/x' })
    expect(r.code, r.out).toBe(0)
    const file = /created (database\/migrations\/\d{8}_\d{6}_create_claims\.sql)/.exec(r.out)?.[1] as string
    expect(readFileSync(join(root, file), 'utf8')).toContain('create table claims (')
    await cli(['make:table', 'Claim'], { root, databaseUrl: 'postgres://unused/x' })
    expect(readFileSync(join(root, 'app/tables/claim-table.ts'), 'utf8')).toContain(
      "export const claims = table('claims'",
    )
    await cli(['make:repository', 'Claim'], { root, databaseUrl: 'postgres://unused/x' })
    expect(readFileSync(join(root, 'app/repositories/claim-repository.ts'), 'utf8')).toContain(
      "import { claims } from '#app/tables/claim-table'",
    )
    expect(existsSync(join(root, 'app/repositories/claim-repository.ts'))).toBe(true)
  })

  test('a broken file in app/commands is skipped with a warning; the other commands still run', async () => {
    writeFileSync(join(root, 'app/commands/broken-command.ts'), "import 'not-installed'\nexport class X {}\n")
    const list = await cli(['list'], { root })
    expect([list.code, list.out]).toEqual([0, expect.stringContaining('! skipped app/commands/broken-command.ts')])
    expect((await cli(['make:service', 'Other'], { root })).out).not.toContain('skipped')
  })

  test('key:generate prints a key, or writes it to .env', async () => {
    const printed = await cli(['key:generate'], { root })
    expect(printed.out).toMatch(/^base64:[A-Za-z0-9+/]{43}=\n$/)
    writeFileSync(join(root, '.env'), 'APP_ENV=local\nAPP_KEY=old\n')
    await cli(['key:generate', '--write'], { root })
    expect(readFileSync(join(root, '.env'), 'utf8')).toMatch(/^APP_ENV=local\nAPP_KEY=base64:\S{44}\n$/)
  })

  test('key:rotate: a new APP_KEY, the old one first in APP_PREVIOUS_KEYS; the next steps', async () => {
    writeFileSync(join(root, '.env'), 'APP_ENV=local\nAPP_KEY=k2\n')
    const first = await cli(['key:rotate', '--write'], { root })
    expect(first.out).toContain('cslug db:reencrypt')
    const env = readFileSync(join(root, '.env'), 'utf8')
    expect(env).toMatch(/^APP_ENV=local\nAPP_KEY=base64:\S{44}\nAPP_PREVIOUS_KEYS=k2\n$/)
    const newest = /APP_KEY=(\S+)/.exec(env)?.[1]
    await cli(['key:rotate', '--write'], { root })
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`APP_PREVIOUS_KEYS=${newest},k2\n`)
    const printed = await cli(['key:rotate'], { root })
    expect(printed.out).toMatch(/^APP_KEY=base64:\S{44}\nAPP_PREVIOUS_KEYS=base64:/)
    writeFileSync(join(root, '.env'), 'APP_ENV=local\n')
    const missing = await cli(['key:rotate'], { root })
    expect(missing.code).toBe(1)
  })
})
