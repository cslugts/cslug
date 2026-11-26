import { expect, test } from 'bun:test'
import { registerFake, type TestApp } from '../src'

class DemoFake {
  sent = 0
}
declare module '../src' {
  interface TestFakes {
    demo: DemoFake
  }
}
registerFake('demo', () => new DemoFake())

test('packages extend TestFakes by module augmentation', () => {
  const read = (t: TestApp) => t.demo?.sent
  expect(typeof read).toBe('function')
})
