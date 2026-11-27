import { type Cache, type Clock, CslugError, Event, type Logger } from '@cslug/core'
import type { Usage } from './model'

/** USD per million tokens. Cache reads cost 0.1× input and cache writes 1.25× input (5-minute cache). */
export type ModelPrice = { input: number; output: number }

/** Anthropic first-party prices (2026-11); `ai.prices` overrides or adds models. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** `config/ai.ts` → `budget`: a daily spending limit for the whole app (every process sharing the cache). */
export type BudgetConfig = {
  perDay: { usd: number }
  /** Share of the limit at which `AiBudgetAlert` is emitted once a day (default 0.8). */
  alertAt?: number
}

/** The estimated cost of one call in USD, or `undefined` when the model has no price. */
export function costOf(model: string, usage: Usage, prices: Record<string, ModelPrice> = {}): number | undefined {
  const price = prices[model] ?? MODEL_PRICES[model]
  if (!price) return undefined
  const input = usage.inputTokens + 0.1 * (usage.cacheReadTokens ?? 0) + 1.25 * (usage.cacheWriteTokens ?? 0)
  return (input * price.input + usage.outputTokens * price.output) / 1e6
}

/** Today's AI spend reached the daily limit: no model is called until tomorrow (app time zone). */
export class AiBudgetError extends CslugError {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      'ai.budget',
      `The daily AI budget is spent ($${spentUsd.toFixed(2)} of $${limitUsd}); raise ai.budget.perDay or wait until tomorrow`,
    )
  }
}

/** Emitted once a day when the spend crosses `ai.budget.alertAt` of the limit (listen to warn someone). */
export class AiBudgetAlert extends Event<{ day: string; spentUsd: number; limitUsd: number }>('ai.budget_alert') {}

const MICROS = 1e6 // spend is counted in micro-dollars: cache counters are integers

/**
 * The daily budget: checked before each model call, charged after it. Spend lives in the app's `Cache` (Redis when
 * @cslug/redis is installed, so every process shares it) under `ai:spend:<day>`.
 */
export class Budget {
  private readonly unpriced = new Set<string>()

  constructor(
    private readonly config: BudgetConfig,
    private readonly prices: Record<string, ModelPrice>,
    private readonly cache: Cache,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  private key = () => `ai:spend:${this.clock.today()}`

  /** Spent today, in USD. */
  async spent(): Promise<number> {
    return ((await this.cache.get<number>(this.key())) ?? 0) / MICROS
  }

  /** `AiBudgetError` when today's limit is reached. */
  async check(): Promise<void> {
    const spent = await this.spent()
    if (spent >= this.config.perDay.usd) throw new AiBudgetError(spent, this.config.perDay.usd)
  }

  async charge(model: string, usage: Usage): Promise<void> {
    const cost = costOf(model, usage, this.prices)
    if (cost === undefined) {
      if (!this.unpriced.has(model)) this.log.warn('ai.budget_unpriced', { model, fix: `add ai.prices['${model}']` })
      this.unpriced.add(model)
      return
    }
    const micros = Math.round(cost * MICROS)
    if (!micros) return
    const total = await this.cache.increment(this.key(), micros, '2d')
    const limit = this.config.perDay.usd
    const threshold = (this.config.alertAt ?? 0.8) * limit * MICROS
    if (total - micros < threshold && total >= threshold) {
      const payload = { day: this.clock.today(), spentUsd: total / MICROS, limitUsd: limit }
      this.log.warn('ai.budget_alert', payload)
      await AiBudgetAlert.emit(payload)
    }
  }
}
