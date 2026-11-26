import { describe, expect, test } from 'bun:test'
import { arg, type Command, flag, names, parseArgs, UsageError } from '../src'

const spec = {
  name: arg.string().describe('Who'),
  before: arg.date().optional(),
  dryRun: flag.boolean().alias('n'),
  queues: flag.list(),
  concurrency: flag.number().default(5),
  mode: flag.string().choices('fast', 'safe').optional(),
}

describe('command arguments (guide 20)', () => {
  test('positionals, kebab-case flags, aliases, --no-, lists, defaults', () => {
    expect(
      parseArgs(spec, ['Ada', '2027-01-02', '--dry-run', '--queues=a,b', '--queues', 'c', '--concurrency', '2']),
    ).toEqual({
      name: 'Ada',
      before: '2027-01-02',
      dryRun: true,
      queues: ['a', 'b', 'c'],
      concurrency: 2,
    })
    expect(parseArgs(spec, ['-n', 'Bo'])).toMatchObject({ name: 'Bo', dryRun: true, queues: [], concurrency: 5 })
    expect(parseArgs(spec, ['Bo', '--no-dry-run']).dryRun).toBe(false)
    expect(parseArgs(spec, ['--', '--weird-name']).name).toBe('--weird-name')
  })

  test('usage errors say what is wrong', () => {
    const fails = (argv: string[]) => {
      try {
        parseArgs(spec, argv)
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError)
        return (e as Error).message
      }
      throw new Error('expected a usage error')
    }
    expect(fails([])).toBe('Missing argument <name>')
    expect(fails(['a', 'b'])).toContain('must be a date')
    expect(fails(['a', '2027-01-01', 'c'])).toBe('Unexpected argument "c"')
    expect(fails(['a', '--nope'])).toBe('Unknown option --nope')
    expect(fails(['a', '--concurrency', 'x'])).toContain('must be a number')
    expect(fails(['a', '--mode=slow'])).toContain('one of: fast, safe')
    expect(fails(['a', '--mode'])).toBe('--mode needs a value')
  })

  test('typed: Command.Args infers each argument', () => {
    const C = { args: spec }
    const args: Command.Args<typeof C> = {
      name: 'x',
      before: undefined,
      dryRun: false,
      queues: [],
      concurrency: 1,
      mode: 'fast',
    }
    // @ts-expect-error: concurrency is a number
    const bad: Command.Args<typeof C> = { ...args, concurrency: '1' }
    expect(bad).toBeDefined()
  })

  test('names(): folders, suffixes, cases', () => {
    expect(names('admin/Claim', 'controller')).toEqual({
      dir: 'admin',
      base: 'Claim',
      class: 'ClaimController',
      file: 'admin/claim-controller',
      kebab: 'claim',
      snake: 'claim',
      camel: 'claim',
    })
    expect(names('SendCheckinJob', 'job')).toMatchObject({ class: 'SendCheckinJob', file: 'send-checkin-job' })
    expect(names('store-claim', 'validator')).toMatchObject({
      class: 'StoreClaimValidator',
      file: 'store-claim-validator',
    })
    expect(names('OperatorDocument').snake).toBe('operator_document')
  })
})
