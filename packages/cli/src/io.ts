import { type ArgSpec, type CommandClass, ConsoleIO, kebab } from '@cslug/core'

/** Help text for one command. */
export function commandHelp(cmd: CommandClass): string {
  const entries = Object.entries(cmd.args ?? {})
  const usage = entries
    .filter(([, s]) => s.positional)
    .map(([k, s]) => (s.opts.optional ? `[${kebab(k)}]` : `<${kebab(k)}>`))
  const lines = [
    cmd.description ?? '',
    '',
    `Usage: cslug ${cmd.signature} ${usage.join(' ')}${entries.some(([, s]) => !s.positional) ? ' [options]' : ''}`,
  ]
  const row = (left: string, s: ArgSpec) =>
    `  ${left.padEnd(26)}${s.opts.description ?? ''}${s.opts.choices ? ` (${s.opts.choices.join('|')})` : ''}${s.opts.fallback !== undefined && s.kind !== 'boolean' && s.kind !== 'list' ? ` [default: ${s.opts.fallback}]` : ''}`
  const args = entries.filter(([, s]) => s.positional)
  if (args.length) lines.push('', 'Arguments:', ...args.map(([k, s]) => row(kebab(k), s)))
  const flags = entries.filter(([, s]) => !s.positional)
  if (flags.length) {
    lines.push(
      '',
      'Options:',
      ...flags.map(([k, s]) =>
        row(`${s.opts.alias ? `-${s.opts.alias}, ` : ''}--${kebab(k)}${s.kind === 'boolean' ? '' : ' <value>'}`, s),
      ),
    )
  }
  return lines.join('\n').trim()
}

/** Captures output; answers questions from a list. */
export class BufferedIO extends ConsoleIO {
  override readonly color = false
  override readonly interactive: boolean
  out = ''
  constructor(private readonly answers: string[] = []) {
    super()
    this.interactive = answers.length > 0
  }
  override write(text: string): void {
    this.out += text
  }
  override error(text: string): void {
    this.out += text
  }
  override async ask(question: string): Promise<string> {
    this.out += question
    return this.answers.shift() ?? ''
  }
}
