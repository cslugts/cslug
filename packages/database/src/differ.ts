import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './database'
import { sql } from './sql'
import { Table } from './table'

/** The tables `app/tables/` exports (subfolders included), in file order. */
export async function loadTables(rootDir: string): Promise<Table[]> {
  const dir = join(rootDir, 'app/tables')
  const tables: Table[] = []
  if (existsSync(dir))
    for (const file of (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /(?<!\.test)\.ts$/.test(f))
      .sort())
      for (const value of Object.values(await import(join(dir, file))))
        if (value instanceof Table && !tables.includes(value)) tables.push(value)
  return tables
}

// ── one shape for both sides: what the tables want and what the database has ─────────────────────────

export type ColumnSpec = { name: string; type: string; nullable: boolean; default?: string; primary?: boolean }
/** Constraints and indexes by name. Names follow PostgreSQL's defaults (`t_col_key`, `t_col_fkey`, `t_col_check`). */
export type TableSpec = {
  name: string
  columns: ColumnSpec[]
  uniques: { name: string; column: string }[]
  checks: { name: string; column: string; values: string[] }[]
  foreignKeys: { name: string; column: string; table: string; references: string; onDelete?: string }[]
  indexes: { name: string; columns: string[]; unique: boolean }[]
}

/** `timestamptz` → `timestamp with time zone`, as `format_type()` reports it. */
const TYPES: [RegExp, string][] = [
  [/^timestamptz$/, 'timestamp with time zone'],
  [/^timestamp$/, 'timestamp without time zone'],
  [/^varchar\((\d+)\)$/, 'character varying($1)'],
  [/^char\((\d+)\)$/, 'character($1)'],
  [/^int$/, 'integer'],
  [/^bool$/, 'boolean'],
]
const pgType = (type: string) => TYPES.reduce((t, [re, to]) => t.replace(re, to), type.toLowerCase())
/** `'draft'::text` → `'draft'`, so defaults compare as written. */
const plainDefault = (expr: string) =>
  expr.replace(/::[a-z ]+(\(\d+(,\d+)?\))?(\[\])?/g, '').replace(/^\((.*)\)$/, '$1')
const literal = (v: unknown) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v === null ? 'null' : String(v))

export function tableSpec(t: Table): TableSpec {
  const spec: TableSpec = {
    name: t.name,
    columns: [],
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [...t.indexes],
  }
  for (const [key, { def }] of Object.entries(t.columns)) {
    const name = t.sqlNames.get(key) as string
    const value = def.defaultSql ?? (def.defaultValue === undefined ? undefined : literal(def.defaultValue))
    spec.columns.push({
      name,
      type: pgType(def.sqlType),
      nullable: def.nullable,
      ...(value === undefined ? {} : { default: value }),
      ...(def.primary ? { primary: true } : {}),
    })
    if (def.unique) spec.uniques.push({ name: `${t.name}_${name}_key`, column: name })
    if (def.oneOf) spec.checks.push({ name: `${t.name}_${name}_check`, column: name, values: [...def.oneOf] })
    if (def.references)
      spec.foreignKeys.push({
        name: `${t.name}_${name}_fkey`,
        column: name,
        table: def.references.table().name,
        references: def.references.column,
        ...(def.references.onDelete ? { onDelete: def.references.onDelete.toLowerCase() } : {}),
      })
  }
  return spec
}

/** The app's tables in the `public` schema (not `cslug_*`, which packages migrate), as the catalog has them. */
export async function introspect(db: Database): Promise<TableSpec[]> {
  const own = sql`n.nspname = 'public' and left(c.relname, 6) <> 'cslug_'`
  const columns = await db.many<{
    table: string
    name: string
    type: string
    nullable: boolean
    default: string | null
  }>(
    sql`select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
          not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where c.relkind = 'r' and ${own} order by c.relname, a.attnum`,
  )
  const constraints = await db.many<{ table: string; name: string; type: string; def: string; columns: string[] }>(
    sql`select c.relname as table, k.conname as name, k.contype::text as type, pg_get_constraintdef(k.oid) as def,
          array(select a.attname::text from unnest(k.conkey) with ordinality x(n, o)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n order by x.o) as columns
        from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
        where ${own}`,
  )
  const indexes = await db.many<{ table: string; name: string; unique: boolean; columns: string[] }>(
    sql`select c.relname as table, i.relname as name, x.indisunique as unique,
          array(select a.attname::text from unnest(x.indkey::int2[]) with ordinality k(n, o)
            join pg_attribute a on a.attrelid = c.oid and a.attnum = k.n order by k.o) as columns
        from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid
        join pg_namespace n on n.oid = c.relnamespace
        where ${own} and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid)`,
  )
  const tables = new Map<string, TableSpec>()
  const of = (name: string) => {
    const t = tables.get(name) ?? { name, columns: [], uniques: [], checks: [], foreignKeys: [], indexes: [] }
    tables.set(name, t)
    return t
  }
  for (const c of columns)
    of(c.table).columns.push({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      ...(c.default === null ? {} : { default: c.default }),
    })
  for (const k of constraints) {
    const t = of(k.table)
    const column = k.columns[0] as string
    if (k.type === 'p') for (const c of t.columns) if (k.columns.includes(c.name)) c.primary = true
    if (k.type === 'u') t.uniques.push({ name: k.name, column })
    if (k.type === 'c')
      t.checks.push({
        name: k.name,
        column,
        values: [...k.def.matchAll(/'((?:[^']|'')*)'::/g)].map((m) => m[1] as string),
      })
    const fk = /REFERENCES (\S+)\((\w+)\)(?: ON DELETE ([A-Z ]+))?/.exec(k.def)
    if (k.type === 'f' && fk)
      t.foreignKeys.push({
        name: k.name,
        column,
        table: (fk[1] as string).replace(/"/g, ''),
        references: fk[2] as string,
        ...(fk[3] ? { onDelete: fk[3].toLowerCase() } : {}),
      })
  }
  for (const i of indexes) of(i.table).indexes.push({ name: i.name, columns: i.columns, unique: i.unique })
  return [...tables.values()]
}

// ── the diff ─────────────────────────────────────────────────────────────────────────────────────────

/** One change: what it does, the SQL to apply it and to revert it, and a warning to review. */
export type Change = { table: string; label: string; up: string[]; down: string[]; warning?: string }
/** A column that may have been renamed: `from` is in the database only, `to` in the tables only, same type. */
export type RenameCandidate = { table: string; from: string; to: string }

const columnSql = (t: TableSpec, c: ColumnSpec) => {
  const check = t.checks.find((k) => k.column === c.name)
  const fk = t.foreignKeys.find((k) => k.column === c.name)
  return [
    `${c.name} ${c.type}`,
    c.primary ? 'primary key' : c.nullable ? '' : 'not null',
    c.default === undefined ? '' : `default ${c.default}`,
    t.uniques.some((u) => u.column === c.name) ? 'unique' : '',
    check ? `check (${c.name} in (${check.values.map(literal).join(', ')}))` : '',
    fk ? `references ${fk.table} (${fk.references})${fk.onDelete ? ` on delete ${fk.onDelete}` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
const indexSql = (t: string, i: TableSpec['indexes'][number]) =>
  `create ${i.unique ? 'unique ' : ''}index ${i.name} on ${t} (${i.columns.join(', ')});`
const createTable = (t: TableSpec) => [
  `create table ${t.name} (\n${t.columns.map((c) => `  ${columnSql(t, c)}`).join(',\n')}\n);`,
  ...t.indexes.map((i) => indexSql(t.name, i)),
]
const byName = <T extends { name: string }>(list: T[]) => new Map(list.map((x) => [x.name, x]))
const sameDefault = (a?: string, b?: string) =>
  (a === undefined ? undefined : plainDefault(a)) === (b === undefined ? undefined : plainDefault(b))

/** Columns dropped and added in one table with the same type: maybe a rename (the command asks). */
export function renameCandidates(desired: TableSpec[], actual: TableSpec[]): RenameCandidate[] {
  const found: RenameCandidate[] = []
  for (const want of desired) {
    const have = actual.find((t) => t.name === want.name)
    if (!have) continue
    const added = want.columns.filter((c) => !have.columns.some((h) => h.name === c.name))
    for (const old of have.columns.filter((h) => !want.columns.some((c) => c.name === h.name))) {
      const to = added.find((c) => c.type === old.type && !found.some((f) => f.table === want.name && f.to === c.name))
      if (to) found.push({ table: want.name, from: old.name, to: to.name })
    }
  }
  return found
}

/** What turns `actual` into `desired`. `renames` are the candidates confirmed as renames. */
export function diffSchemas(desired: TableSpec[], actual: TableSpec[], renames: RenameCandidate[] = []): Change[] {
  const changes: Change[] = []
  const have = byName(actual)
  const want = byName(desired)
  // new tables, referenced ones first
  const created = desired.filter((t) => !have.has(t.name))
  const order = (t: TableSpec, seen = new Set<string>()): number =>
    seen.has(t.name)
      ? 0
      : 1 +
        Math.max(
          0,
          ...t.foreignKeys
            .map((f) => created.find((c) => c.name === f.table && c.name !== t.name))
            .filter((c): c is TableSpec => !!c)
            .map((c) => order(c, new Set([...seen, t.name]))),
        )
  for (const t of [...created].sort((a, b) => order(a) - order(b)))
    changes.push({ table: t.name, label: `+ table   ${t.name}`, up: createTable(t), down: [`drop table ${t.name};`] })

  for (const t of desired) {
    const old = have.get(t.name)
    if (!old) continue
    const a = `alter table ${t.name}`
    const renamed = renames.filter((r) => r.table === t.name)
    for (const r of renamed) {
      // PostgreSQL keeps constraint and index names on a column rename: rename them to the default names too
      const affected = [
        ...[...old.uniques, ...old.checks, ...old.foreignKeys].map((x) => ({ name: x.name, index: false })),
        ...old.indexes.map((x) => ({ name: x.name, index: true })),
      ].filter((x) => x.name.includes(`_${r.from}_`))
      const to = (n: string) => n.replace(`_${r.from}_`, `_${r.to}_`)
      const rename = (index: boolean, from: string, into: string) =>
        index ? `alter index ${from} rename to ${into};` : `${a} rename constraint ${from} to ${into};`
      changes.push({
        table: t.name,
        label: `~ column  ${t.name}.${r.from} → ${r.to}`,
        up: [`${a} rename column ${r.from} to ${r.to};`, ...affected.map((x) => rename(x.index, x.name, to(x.name)))],
        down: [...affected.map((x) => rename(x.index, to(x.name), x.name)), `${a} rename column ${r.to} to ${r.from};`],
      })
    }
    const current = (name: string) =>
      old.columns.find((c) => c.name === (renamed.find((r) => r.to === name)?.from ?? name))
    for (const c of t.columns) {
      const was = current(c.name)
      if (!was) {
        changes.push({
          table: t.name,
          label: `+ column  ${t.name}.${c.name} ${c.type}`,
          up: [`${a} add column ${columnSql(t, c)};`],
          down: [`${a} drop column ${c.name};`],
          ...(!c.nullable && c.default === undefined
            ? { warning: `${t.name}.${c.name} is not null without a default: fails if the table has rows` }
            : {}),
        })
        continue
      }
      const col = `${a} alter column ${c.name}`
      if (was.type !== c.type)
        changes.push({
          table: t.name,
          label: `~ column  ${t.name}.${c.name} ${c.type} (was ${was.type})`,
          up: [`${col} type ${c.type};`],
          down: [`${col} type ${was.type};`],
          warning: `${t.name}.${c.name}: a type change may need \`using ${c.name}::${c.type}\``,
        })
      if (was.nullable !== c.nullable && !c.primary)
        changes.push({
          table: t.name,
          label: `~ column  ${t.name}.${c.name} ${c.nullable ? 'nullable' : 'not null'}`,
          up: [`${col} ${c.nullable ? 'drop' : 'set'} not null;`],
          down: [`${col} ${c.nullable ? 'set' : 'drop'} not null;`],
        })
      if (!sameDefault(was.default, c.default))
        changes.push({
          table: t.name,
          label: `~ column  ${t.name}.${c.name} default ${c.default ?? 'none'}`,
          up: [c.default === undefined ? `${col} drop default;` : `${col} set default ${c.default};`],
          down: [
            was.default === undefined ? `${col} drop default;` : `${col} set default ${plainDefault(was.default)};`,
          ],
        })
    }
    for (const c of old.columns)
      if (!t.columns.some((w) => w.name === c.name) && !renamed.some((r) => r.from === c.name))
        changes.push({
          table: t.name,
          label: `- column  ${t.name}.${c.name}`,
          up: [`${a} drop column ${c.name};`],
          down: [`${a} add column ${columnSql(old, c)};`],
          warning: `${t.name}.${c.name} is dropped with its data`,
        })
    changes.push(...constraintChanges(t, renamed.length ? renamedSpec(old, renamed) : old))
  }

  for (const t of actual)
    if (!want.has(t.name))
      changes.push({
        table: t.name,
        label: `- table   ${t.name}`,
        up: [`drop table ${t.name};`],
        down: createTable(t),
        warning: `table ${t.name} is dropped with its data (not in app/tables/)`,
      })
  return changes
}

/** `old` as it is after the renames: columns, and the constraint and index names derived from them. */
function renamedSpec(old: TableSpec, renamed: RenameCandidate[]): TableSpec {
  const col = (c: string) => renamed.find((r) => r.from === c)?.to ?? c
  const name = (n: string) => renamed.reduce((x, r) => x.replace(`_${r.from}_`, `_${r.to}_`), n)
  return {
    name: old.name,
    columns: old.columns.map((c) => ({ ...c, name: col(c.name) })),
    uniques: old.uniques.map((u) => ({ name: name(u.name), column: col(u.column) })),
    checks: old.checks.map((k) => ({ ...k, name: name(k.name), column: col(k.column) })),
    foreignKeys: old.foreignKeys.map((f) => ({ ...f, name: name(f.name), column: col(f.column) })),
    indexes: old.indexes.map((i) => ({ ...i, name: name(i.name), columns: i.columns.map(col) })),
  }
}

/** A table's unique, check and foreign-key constraints as `name → definition`. */
const constraintsOf = (t: TableSpec) =>
  new Map<string, string>([
    ...t.uniques.map((u) => [u.name, `unique (${u.column})`] as const),
    ...t.checks.map((k) => [k.name, `check (${k.column} in (${k.values.map(literal).join(', ')}))`] as const),
    ...t.foreignKeys.map(
      (f) =>
        [
          f.name,
          `foreign key (${f.column}) references ${f.table} (${f.references})${f.onDelete ? ` on delete ${f.onDelete}` : ''}`,
        ] as const,
    ),
  ])

/** Constraints and indexes, compared by name and definition. */
function constraintChanges(t: TableSpec, old: TableSpec): Change[] {
  const changes: Change[] = []
  const a = `alter table ${t.name}`
  const [now, was] = [constraintsOf(t), constraintsOf(old)]
  for (const [name, def] of now) {
    const before = was.get(name)
    if (before === def) continue
    changes.push({
      table: t.name,
      label: `${before ? '~' : '+'} constraint ${name}`,
      up: [...(before ? [`${a} drop constraint ${name};`] : []), `${a} add constraint ${name} ${def};`],
      down: [`${a} drop constraint ${name};`, ...(before ? [`${a} add constraint ${name} ${before};`] : [])],
    })
  }
  for (const [name, def] of was)
    if (!now.has(name))
      changes.push({
        table: t.name,
        label: `- constraint ${name}`,
        up: [`${a} drop constraint ${name};`],
        down: [`${a} add constraint ${name} ${def};`],
      })
  const wasIndex = byName(old.indexes)
  for (const i of t.indexes) {
    const y = wasIndex.get(i.name)
    if (y && y.unique === i.unique && y.columns.join() === i.columns.join()) continue
    changes.push({
      table: t.name,
      label: `${y ? '~' : '+'} index   ${i.name}`,
      up: [...(y ? [`drop index ${i.name};`] : []), indexSql(t.name, i)],
      down: [`drop index ${i.name};`, ...(y ? [indexSql(t.name, y)] : [])],
    })
  }
  for (const y of old.indexes)
    if (!t.indexes.some((i) => i.name === y.name))
      changes.push({
        table: t.name,
        label: `- index   ${y.name}`,
        up: [`drop index ${y.name};`],
        down: [indexSql(t.name, y)],
      })
  return changes
}

/** The migration file: `-- up` in order, `-- down` in reverse. */
export const migrationSql = (changes: Change[]) =>
  `-- up\n${changes.flatMap((c) => c.up).join('\n')}\n\n-- down\n${[...changes]
    .reverse()
    .flatMap((c) => c.down)
    .join('\n')}\n`
