import { arg, Clock, Command, flag, inject } from '@cslug/core'

@inject(Clock)
export class GreetCommand extends Command {
  static signature = 'greet'
  static description = 'Say hello'
  static boot = false
  static args = { name: arg.string(), shout: flag.boolean(), times: flag.number().default(1) }

  constructor(private readonly clock_: Clock) {
    super()
  }

  handle({ name, shout, times }: Command.Args<typeof GreetCommand>) {
    for (let i = 0; i < times; i++) this.line(shout ? `HELLO ${name.toUpperCase()}` : `Hello ${name}`)
    this.line(`today ${this.clock_.today()}`)
    return name === 'fail' ? 3 : 0
  }
}
