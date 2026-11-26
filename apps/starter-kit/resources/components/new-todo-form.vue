<script setup lang="ts">
import { useForm, useT, route } from '@cslug/vue'
import type { v } from '@cslug/validation'
import type { StoreTodoValidator } from '#app/validators/store-todo-validator'
import { TodoPriority } from '#app/tables/todo-priority'   // not todo-table: that one imports the database

defineOptions({ lang: ['todos', 'validation'] })
const { t } = useT()

const form = useForm<v.input<typeof StoreTodoValidator>>({ title: '', priority: 'normal', dueOn: undefined })

async function submit() {
  if (await form.post(route('todos.store'))) window.location.reload()    // simplest refresh of the list
}
</script>

<template>
  <!-- action/method make it work before hydration too (plain POST + redirect back) -->
  <form class="new-todo" :action="route('todos.store')" method="post" @submit.prevent="submit">
    <input name="title" v-model="form.data.title" :placeholder="t('todos.new_placeholder')" required />
    <select name="priority" v-model="form.data.priority">
      <option v-for="p in TodoPriority" :key="p" :value="p">{{ t(`todos.priority.${p}`) }}</option>
    </select>
    <input name="dueOn" type="date" v-model="form.data.dueOn" />
    <button :disabled="form.processing">{{ t('todos.add') }}</button>
    <p v-if="form.errors.title" class="error">{{ form.errors.title }}</p>
  </form>
</template>

<style scoped lang="scss">
@use '@/styles/tokens' as *;
.new-todo { display: grid; grid-template-columns: 1fr auto auto auto; gap: $space-2; margin-block: $space-4; }
.error { grid-column: 1 / -1; }
</style>
