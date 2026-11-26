<script setup lang="ts">
import { useT, route, serialize } from '@cslug/vue'
import Layout from '../layouts/default.vue'
import NewTodoForm from '#components/new-todo-form.vue'
import TodoItem from '#components/todo-item.vue'
import type { Todo } from '#app/tables/todo-table'
import type { TodoFilter } from '#app/repositories/todo-repository'

defineProps<{
  todos: Todo[]
  stats: { open: number; done: number; overdue: number }
  filter: TodoFilter
}>()
const { t } = useT()
const filters: TodoFilter[] = ['all', 'open', 'done']
</script>

<template>
  <Layout :title="t('todos.title')">
    <h1>{{ t('todos.title') }}</h1>

    <p class="stats">
      {{ t('todos.stats', { open: stats.open, done: stats.done }) }}
      <strong v-if="stats.overdue" class="overdue">{{ t('todos.overdue', { count: stats.overdue }) }}</strong>
    </p>

    <!-- Island: submits with fetch and reloads the list. Server-rendered as a normal form first. -->
    <NewTodoForm hydrate="visible" />

    <nav class="filters">
      <a v-for="f in filters" :key="f" :href="route('todos.index', {}, { query: { filter: f } })" :aria-current="f === filter">
        {{ t(`todos.filter.${f}`) }}
      </a>
    </nav>

    <ul v-if="todos.length" class="todo-list">
      <!-- Island per item: checkbox toggles with fetch. Props are serialized (Date → string). -->
      <TodoItem v-for="todo in todos" :key="todo.id" :todo="serialize(todo)" hydrate="idle" />
    </ul>
    <p v-else class="empty">{{ t('todos.empty') }}</p>
  </Layout>
</template>
