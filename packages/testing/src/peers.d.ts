/**
 * Types of the optional packages @cslug/testing works with. A `.d.ts` on purpose: apps type-check with
 * `skipLibCheck`, so when one of them is not installed (an API without @cslug/queue, a web app without mail) its
 * types become `any` instead of a "cannot find module" error. Installed, they are the real types.
 */
export type DatabaseModule = typeof import('@cslug/database')
export type HttpModule = typeof import('@cslug/http')
export type QueueModule = typeof import('@cslug/queue')
export type MailModule = typeof import('@cslug/mail')
export type StorageModule = typeof import('@cslug/storage')
export type NotificationModule = typeof import('@cslug/notification')
export type QueueFake = import('@cslug/queue').QueueFake
export type ScheduleRun = import('@cslug/queue').ScheduleRun
export type MailFake = import('@cslug/mail').MailFake
export type StorageFake = import('@cslug/storage').StorageFake
export type NotificationFake = import('@cslug/notification').NotificationFake
