/**
 * @cslug/cli: the `cslug` binary. Runs built-in commands, those your installed packages contribute
 * (`migrate` with @cslug/database, `serve` with @cslug/http …) and yours in `app/commands/`; generators;
 * `start` (a supervisor for web, workers and scheduler) and `dev`.
 *
 * `Command`, `arg` and `flag` live in @cslug/core (so packages can contribute commands) and are re-exported here.
 */
export { arg, Command, type CommandClass, ConsoleIO, flag, names } from '@cslug/core'
export { generator, STUBS } from './commands/builtin'
export { type CslugConfig, defineCslugConfig } from './config'
export { BufferedIO, commandHelp } from './io'
export { CliKernel } from './kernel'
export { type ProcessSpec, plannedProcesses, Supervisor } from './supervisor'
