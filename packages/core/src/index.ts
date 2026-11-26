/**
 * @cslug/core: application, container and `@inject`, service providers, ambient context, config and env,
 * typed errors, Clock, Money, events, logger. (i18n and the cache/lock/rate-limit contracts come next.)
 */

/** Re-exported so apps can `import { v, ValidationError } from '@cslug/core'` in config/env.ts. */
export { ValidationError, v } from '@cslug/validation'
export { Application, type ApplicationOptions, sortProviders } from './application'
export { Clock, FakeClock } from './clock'
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
export { inject, type Lifetime } from './inject'
export { DEFAULT_REDACT, type LogFields, Logger, type LoggerOptions, type LogLevel } from './logger'
export { Money, minorDigits } from './money'
export { type ProviderClass, type ProviderHooks, ServiceProvider } from './provider'
export { type Class, InjectionToken, type Resolved, type Token, token } from './token'
