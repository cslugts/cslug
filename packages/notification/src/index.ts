/**
 * @cslug/notification: notifications over mail, database, WhatsApp, SMS and custom channels, one job per
 * delivery, delivery records, and a fake for tests.
 */
export { installNotificationFake, NotificationFake, type SentNotification } from './fake'
export { Notification, type Recipient, recipient, routeOf } from './notification'
export {
  type Channel,
  type Delivery,
  type DeliveryStatus,
  LogChannel,
  ManualChannel,
  type NotificationConfig,
  type NotificationStore,
  Notifier,
} from './notifier'
export { NOTIFICATION_MIGRATIONS, NotificationProvider } from './provider'
