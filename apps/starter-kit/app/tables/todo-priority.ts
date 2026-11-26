/**
 * The priorities of a todo. Its own file, with no imports, so islands can import the values: `todo-table.ts`
 * imports @cslug/database, which must never reach a browser bundle.
 */
export const TodoPriority = ['low', 'normal', 'high'] as const
export type TodoPriority = (typeof TodoPriority)[number]
