import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'

export type Preset = 'api' | 'web' | 'full'
export type ScaffoldOptions = { dir: string; preset?: Preset; tailwind?: boolean; version?: string }

const TEMPLATES = join(import.meta.dir, '../templates')
/** Each preset is a layer on top of the previous ones (then `tailwind`); a later layer replaces a file of the same path. */
const LAYERS: Record<Preset, Preset[]> = { api: ['api'], web: ['api', 'web'], full: ['api', 'web', 'full'] }
const PACKAGES: Record<Preset, string[]> = {
  api: ['core', 'validation', 'http', 'database', 'redis', 'cli'],
  web: ['vue', 'auth'],
  full: ['queue', 'mail', 'storage'],
}

/** This package's version: every @cslug/* package of a release has the same one. */
export const VERSION: string = (await Bun.file(join(import.meta.dir, '../package.json')).json()).version

const words = (name: string) => name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
const randomKey = () => `base64:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`

/** `my-app` → `{ name: 'my-app', title: 'My App', db: 'my_app' }`. Names start with a letter. */
export function names(dir: string) {
  const parts = words(basename(resolve(dir)))
  if (!parts.length || !/^[a-z]/i.test(parts[0] as string))
    throw new Error(`"${basename(dir)}" is not a usable app name (letters, digits and dashes; start with a letter)`)
  return {
    name: parts.join('-').toLowerCase(),
    title: parts.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' '),
    db: parts.join('_').toLowerCase(),
  }
}

/** The app's package.json: exact @cslug/* versions for the preset, the `#app/*` import aliases, scripts. */
export type AppPackageJson = {
  name: string
  private: true
  type: 'module'
  scripts: Record<string, string>
  imports: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

export function packageJson(name: string, preset: Preset, tailwind: boolean, version: string): AppPackageJson {
  const web = preset !== 'api'
  const cslug = LAYERS[preset].flatMap((layer) => PACKAGES[layer])
  return {
    name,
    private: true,
    type: 'module',
    scripts: {
      dev: 'cslug dev',
      start: 'cslug start',
      ...(web ? { build: 'cslug build' } : {}),
      typecheck: web ? 'cslug typecheck' : 'tsc --noEmit',
      test: 'bun test',
      lint: 'biome check .',
    },
    imports: {
      '#app/*': './app/*.ts',
      '#config/*': './config/*.ts',
      '#routes/*': './routes/*.ts',
      '#database/*': './database/*.ts',
      ...(web
        ? {
            '#views/*': './resources/views/*',
            '#components/*': './resources/components/*',
            '#resources/*': './resources/*',
          }
        : {}),
    },
    dependencies: {
      ...Object.fromEntries(cslug.map((p) => [`@cslug/${p}`, version])),
      ...(web ? { vue: '^3.5.0' } : {}),
    },
    devDependencies: {
      '@biomejs/biome': '^2.0.0',
      '@cslug/testing': version,
      '@types/bun': '^1.3.14',
      typescript: '^5.9.0',
      ...(web ? { sass: '^1.80.0', 'vue-tsc': '^3.0.0' } : {}),
      ...(tailwind ? { tailwindcss: '^4.0.0', 'bun-plugin-tailwind': '>=0.1.0' } : {}),
    },
  }
}

/**
 * Write a new app into `dir` (missing or empty). Template files are copied layer by layer with `{{placeholders}}`
 * filled; a leading `_` in a file name becomes a dot (npm does not publish `.gitignore`) and a `.tpl` suffix is dropped
 * (template tests must not run in this repository). `.env` gets a fresh APP_KEY.
 * Returns the paths written, relative to `dir`.
 */
export async function scaffold(options: ScaffoldOptions): Promise<string[]> {
  const preset = options.preset ?? 'web'
  const tailwind = options.tailwind ?? false
  if (tailwind && preset === 'api') throw new Error('--tailwind needs pages: use it with --web or --full')
  const dir = resolve(options.dir)
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`)
  const { name, title, db } = names(dir)
  const vars: Record<string, string> = {
    name,
    title,
    db,
    tailwind: String(tailwind),
    testKey: randomKey(),
    styles: `import './styles/app.scss'${tailwind ? "\nimport './styles/tailwind.css'" : ''}`,
  }
  const files = new Map<string, string>()
  for (const layer of [...LAYERS[preset], ...(tailwind ? ['tailwind'] : [])])
    for await (const path of new Glob('**/*').scan({ cwd: join(TEMPLATES, layer), dot: true })) {
      const text = await Bun.file(join(TEMPLATES, layer, path)).text()
      const target = path.replace(/(^|\/)_(?=[^/]*$)/, '$1.').replace(/\.tpl$/, '')
      files.set(
        target,
        text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match),
      )
    }
  files.set(
    'package.json',
    `${JSON.stringify(packageJson(name, preset, tailwind, options.version ?? VERSION), null, 2)}\n`,
  )
  const example = files.get('.env.example') ?? ''
  files.set('.env', example.replace(/^APP_KEY=.*$/m, `APP_KEY=${randomKey()}`))

  for (const [path, text] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await Bun.write(join(dir, path), text)
  }
  return [...files.keys()].sort()
}
