<script setup lang="ts">
import { ref, computed } from 'vue'
import { useForm, useT, route, formatDate, type Serialized } from '@cslug/vue'
import type { Todo } from '#app/tables/todo-table'

const props = defineProps<{ todo: Serialized<Todo> }>()
defineOptions({ lang: ['todos'] })
const { t } = useT()

const todo = ref(props.todo)
const done = computed(() => todo.value.completedAt !== null)
const overdue = computed(() => !done.value && todo.value.dueOn !== null && todo.value.dueOn < new Date().toISOString().slice(0, 10))

const toggleForm = useForm({})
const deleteForm = useForm({})
const removed = ref(false)

async function toggle() {
  if (await toggleForm.post(route('todos.toggle', { todo: todo.value.id }))) todo.value = toggleForm.response.todo
}

async function remove() {
  if (!confirm(t('todos.confirm_delete'))) return
  if (await deleteForm.delete(route('todos.destroy', { todo: todo.value.id }))) removed.value = true
}
</script>

<template>
  <li v-if="!removed" class="todo" :class="{ done, overdue }" :data-priority="todo.priority">
    <label>
      <input type="checkbox" :checked="done" :disabled="toggleForm.processing" @change="toggle" />
      <span class="title">{{ todo.title }}</span>
    </label>
    <span v-if="todo.dueOn" class="due">{{ formatDate(todo.dueOn, 'short') }}</span>
    <button type="button" class="link danger" :aria-label="t('todos.delete')" @click="remove">×</button>
  </li>
</template>

<style scoped lang="scss">
@use '@/styles/tokens' as *;
.todo { display: flex; align-items: center; gap: $space-3; padding: $space-2 0; border-bottom: 1px solid $border; }
.todo label { flex: 1; display: flex; gap: $space-2; align-items: center; }
.done .title { text-decoration: line-through; color: $muted; }
.overdue .due { color: $danger; font-weight: 600; }
.todo[data-priority='high'] .title { font-weight: 600; }
</style>
