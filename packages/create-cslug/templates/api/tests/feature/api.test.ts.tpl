import { test } from 'bun:test'
import { testApp } from '@cslug/testing'

const app = testApp()

test('the API answers', async () => {
  await app.get('/api/v1/hello').assertOk().assertJson({ message: 'Hello from {{title}}' })
})

test('the health endpoint is up', async () => {
  await app.get('/health/live').assertOk()
})
