import { afterEach, describe, expect, test } from 'bun:test'
import { isNewer, latestRelease, newerRelease } from '../src/update'

const registry = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('create-cslug runs the latest release', () => {
  afterEach(() => {
    delete process.env.CSLUG_NO_UPDATE_CHECK
  })

  test('isNewer compares x.y.z, then pre-releases', () => {
    expect(isNewer('0.13.0', '0.4.1')).toBe(true) // not a string comparison
    expect(isNewer('0.4.1', '0.13.0')).toBe(false)
    expect(isNewer('1.0.0', '0.99.9')).toBe(true)
    expect(isNewer('0.13.0', '0.13.0')).toBe(false)
    expect(isNewer('0.13.0', '0.13.0-rc.1')).toBe(true)
    expect(isNewer('0.13.0-rc.1', '0.13.0')).toBe(false)
  })

  test('a newer release on npm is the one to run; the same or an older one is not', async () => {
    expect(await newerRelease('0.4.1', registry({ version: '0.13.0' }))).toBe('0.13.0')
    expect(await newerRelease('0.13.0', registry({ version: '0.13.0' }))).toBeUndefined()
    expect(await newerRelease('0.14.0', registry({ version: '0.13.0' }))).toBeUndefined()
  })

  test('offline or a registry error: go on with this version', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await latestRelease(offline)).toBeUndefined()
    expect(await newerRelease('0.4.1', registry({}, 500))).toBeUndefined()
    expect(await newerRelease('0.4.1', registry({ nope: true }))).toBeUndefined()
  })

  test('the child it starts does not check again', async () => {
    process.env.CSLUG_NO_UPDATE_CHECK = '1'
    expect(await newerRelease('0.4.1', registry({ version: '0.13.0' }))).toBeUndefined()
  })

  test('asks the configured registry for create-cslug/latest', async () => {
    let asked = ''
    const spy = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ version: '1.0.0' }))
    }) as unknown as typeof fetch
    await latestRelease(spy, 'https://registry.example.test/')
    expect(asked).toBe('https://registry.example.test/create-cslug/latest')
  })
})
