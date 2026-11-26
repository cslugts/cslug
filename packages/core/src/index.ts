/**
 * @cslug/core: application, container and `@inject`, service providers, ambient context, config and env,
 * typed errors, Clock, Money, events, logger, i18n, and the Cache/Lock/RateLimiter/SessionStore contracts.
 */

/** Re-exported so apps can `import { v, ValidationError } from '@cslug/core'` in config/env.ts. */
export { ValidationError, v } from '@cslug/validation'
export { Application, type ApplicationOptions, sortProviders } from './application'
export { Clock, FakeClock } from './clock'
export {
  ArgSpec,
  type ArgsSpec,
  arg,
  COMMANDS,
  Command,
  type CommandClass,
  ConsoleIO,
  flag,
  kebab,
  names,
  parseArgs,
  UsageError,
} from './command'
export {
  type Config,
  type ConfigPath,
  type ConfigValue,
  config,
  defineConfig,
  defineEnv,
  EnvError,
  secretKeys,
  type Typed,
} from './config'
export { Container, type Factory } from './container'
export {
  afterCommit,
  type Context,
  currentApp,
  currentContext,
  resolve,
  runInContext,
  type TransactionHooks,
} from './context'
export {
  type AuthUser,
  Cache,
  Lock,
  type LockHandle,
  LockTimeoutError,
  MemoryCache,
  MemoryLock,
  MemoryRateLimiter,
  MemorySessionStore,
  parseRate,
  type RateLimit,
  RateLimiter,
  type RateLimitResult,
  type SessionData,
  SessionStore,
} from './contracts'
export { type Duration, parseDuration } from './duration'
export {
  AppError,
  BadRequestError,
  BindingNotFoundError,
  CircularDependencyError,
  ConflictError,
  CslugError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  ProviderError,
  ScopeViolationError,
  TooManyRequestsError,
  UnauthorizedError,
} from './errors'
export {
  type AnyEventClass,
  Event,
  EventBus,
  type EventClass,
  type EventHandler,
  type EventInstance,
  type ListenerOptions,
  listener,
  type QueuedListenerDispatcher,
  registeredListeners,
} from './events'
export { HEALTH_CHECKS, type HealthCheck, healthCheck } from './health'
export {
  currentLocale,
  formatDate,
  formatMoney,
  type I18nConfig,
  Translator,
  t,
  tr,
  validationTranslator,
  withLocale,
} from './i18n'
export { inject, type Lifetime } from './inject'
export { DEFAULT_REDACT, type LogFields, Logger, type LoggerOptions, type LogLevel } from './logger'
export { Money, minorDigits } from './money'
export { type ProviderClass, type ProviderHooks, ServiceProvider } from './provider'
export { type Class, InjectionToken, type Resolved, type Token, token } from './token'
