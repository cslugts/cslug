import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setEnvValue } from '../src/commands/builtin'
import { cli } from './support'

// a fake mkcert on PATH: records its arguments, writes the two files it is asked for
const tmp = mkdtempSync(join(tmpdir(), 'cslug-dev-cert-'))
const bin = join(tmp, 'bin')
const root = join(tmp, 'app')
const calls = join(tmp, 'calls.log')
const PATH = process.env.PATH

beforeAll(() => {
  mkdirSync(bin)
  mkdirSync(root)
  writeFileSync(
    join(bin, 'mkcert'),
    `#!/bin/sh
echo "$*" >> ${calls}
while [ $# -gt 0 ]; do
  case "$1" in -cert-file|-key-file) echo pem > "$2"; shift ;; esac
  shift
done
`,
  )
  chmodSync(join(bin, 'mkcert'), 0o755)
})
afterAll(() => {
  process.env.PATH = PATH
  rmSync(tmp, { recursive: true, force: true })
})

describe('cslug dev:cert', () => {
  test('creates the certificate with mkcert and points .env at it; APP_URL keeps its port', async () => {
    process.env.PATH = `${bin}:${PATH}`
    writeFileSync(join(root, '.env'), 'APP_ENV=local\nAPP_URL=http://localhost:3000\nTLS_CERT=old.pem\n')
    const { code, out } = await cli(['dev:cert', 'myapp.brg,*.myapp.brg'], { root })
    expect(code).toBe(0)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      '-install',
      '-cert-file storage/certs/dev.pem -key-file storage/certs/dev-key.pem myapp.brg *.myapp.brg localhost 127.0.0.1 ::1',
    ])
    expect(existsSync(join(root, 'storage/certs/dev-key.pem'))).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'APP_ENV=local\nAPP_URL=https://myapp.brg:3000\nTLS_CERT=storage/certs/dev.pem\nTLS_KEY=storage/certs/dev-key.pem\n',
    )
    expect(out).toContain('127.0.0.1 myapp.brg')
  })

  test('--no-install skips mkcert -install; --no-app-url leaves APP_URL', async () => {
    process.env.PATH = `${bin}:${PATH}`
    rmSync(calls, { force: true })
    writeFileSync(join(root, '.env'), 'APP_URL=http://localhost:3000\n')
    expect((await cli(['dev:cert', 'other.brg', '--no-install', '--no-app-url'], { root })).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).not.toContain('-install\n')
    expect(readFileSync(join(root, '.env'), 'utf8')).toStartWith('APP_URL=http://localhost:3000\n')
  })

  test('refuses a wildcard directly under a top-level domain', async () => {
    process.env.PATH = `${bin}:${PATH}`
    const { code, out } = await cli(['dev:cert', '*.brg'], { root })
    expect(code).toBe(1)
    expect(out).toContain('*.myapp.brg')
  })

  test('without mkcert: how to install it, exit 1', async () => {
    process.env.PATH = join(tmp, 'empty')
    const { code, out } = await cli(['dev:cert', 'myapp.brg'], { root })
    process.env.PATH = PATH
    expect(code).toBe(1)
    expect(out).toContain('mkcert is not installed')
  })
})

test('setEnvValue replaces a line or appends one', () => {
  expect(setEnvValue('A=1\nB=2\n', 'B', '3')).toBe('A=1\nB=3\n')
  expect(setEnvValue('A=1', 'C', '$&x')).toBe('A=1\nC=$&x\n')
  expect(setEnvValue('', 'C', '1')).toBe('C=1\n')
})
