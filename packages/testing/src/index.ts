/**
 * @cslug/testing: `testApp()` (the app per test file, isolated per test), HTTP requests without a port and
 * their assertions, database helpers, the fake clock, and the fake registry other packages plug into.
 */
export { EventFake, type FakeInstaller, registerFake, type TestFakes } from './fakes'
export { CookieJar, PendingRequest, TestResponse } from './request'
export { type TestApp, type TestAppOptions, testApp } from './test-app'
