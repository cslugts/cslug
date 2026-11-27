/**
 * @cslug/cli: the `cslug` binary. Runs built-in commands, those your installed packages contribute
 * (`migrate` with @cslug/database, `serve` with @cslug/http …) and yours in `app/commands/`; generators;
 * `start` (a supervisor for web, workers and scheduler) and `dev`.
 *
 * `Command`, `arg` and `flag` live in @cslug/core (so packages can contribute commands) and are re-exported here.
 */
export { arg, Command, type CommandClass, ConsoleIO, flag, names } from '@cslug/core'
export { ADDITIONS, AddCommand } from './commands/add'
export { type AgentsSection, AgentsSyncCommand, agentsSections, mergeAgents } from './commands/agents-sync'
export { generator, STUBS } from './commands/builtin'
export { DescribeCommand } from './commands/describe'
export { devTools, McpDevCommand } from './commands/mcp-dev'
export { type Evaluated, evaluate, ReplCommand, replScope } from './commands/repl'
export { type CslugConfig, defineCslugConfig } from './config'
export { BufferedIO, commandHelp } from './io'
export { CliKernel } from './kernel'
export { DEV_LOG, type ProcessSpec, plannedProcesses, Supervisor } from './supervisor'
