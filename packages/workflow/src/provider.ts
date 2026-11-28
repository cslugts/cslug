import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceProvider, type Token } from '@cslug/core'
import { addMigrations, DatabaseProvider } from '@cslug/database'
import { QueueProvider, registerJob } from '@cslug/queue'
import { workflowCommands } from './commands'
import { isWorkflowClass, registeredWorkflows, starter, workflowName } from './workflow'
import { WorkflowResumeJob, Workflows } from './workflows'

/** @cslug/security, as far as workflows use it (loaded at runtime: it is optional). */
type SecurityModule = {
  Audit: Token<{
    store?: unknown
    record(action: string, options: { subject: { type: string; id: string }; data: Record<string, unknown> }): unknown
  }>
}
const importOptional = <M>(name: string): Promise<M> => import(name)

/** The workflows migration: `cslug_workflow_runs`, `cslug_workflow_steps`, `cslug_workflow_signals`. */
export const WORKFLOW_MIGRATIONS = join(import.meta.dir, '../migrations')

/**
 * Binds `Workflows`, registers the migration and the resume job, and loads `app/workflows/` (so every process
 * knows every workflow and watches the events they wait for).
 */
export class WorkflowProvider extends ServiceProvider {
  static dependsOn = [DatabaseProvider, QueueProvider]

  register() {
    addMigrations(WORKFLOW_MIGRATIONS)
    registerJob(WorkflowResumeJob)
    this.app.singleton(Workflows, () => new Workflows(this.app))
    this.commands(workflowCommands)
    this.describe('workflows', () =>
      registeredWorkflows().map((w) => ({
        name: workflowName(w),
        class: w.name,
        waitsFor: (w.waitsFor ?? []).map((e) => e.eventName).join(', '),
      })),
    )
  }

  async boot() {
    const workflows = this.app.resolve(Workflows)
    starter.start = (workflow, input, options) => this.app.resolve(Workflows).start(workflow, input, options)
    const dir = join(this.app.rootDir, 'app/workflows')
    if (existsSync(dir)) {
      const files = (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
        .sort()
      for (const file of files)
        for (const value of Object.values((await import(join(dir, file))) as Record<string, unknown>))
          if (isWorkflowClass(value)) workflows.register(value)
    }
    for (const workflow of registeredWorkflows()) workflows.register(workflow)
    await this.auditWith(workflows)
  }

  /** With @cslug/security: runs' starts and ends go to its audit log (once it has a store). */
  private async auditWith(workflows: Workflows) {
    const security = await importOptional<SecurityModule>('@cslug/security').catch(() => undefined)
    if (!security || !this.app.has(security.Audit)) return
    const audit = this.app.resolve(security.Audit)
    workflows.audit = { record: (action, options) => (audit.store ? audit.record(action, options) : undefined) }
  }
}
