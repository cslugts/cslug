<script setup lang="ts">
import { useT, route, formatDate } from '@cslug/vue'
import MailLayout from './layout.vue'
import type { DueItem } from '#app/mail/todo-due-mail'

defineProps<{ name: string; items: DueItem[] }>()
const { t } = useT()
</script>

<template>
  <MailLayout :preview="t('mail.todo_due.preview', { count: items.length })">
    <h1>{{ t('mail.todo_due.greeting', { name }) }}</h1>
    <p>{{ t('mail.todo_due.intro', { count: items.length }) }}</p>
    <ul>
      <li v-for="item in items" :key="item.title">
        <strong>{{ item.title }}</strong> — {{ formatDate(item.dueOn, 'long') }}
      </li>
    </ul>
    <a class="button" :href="route('todos.index', {}, { absolute: true })">{{ t('mail.todo_due.cta') }}</a>
  </MailLayout>
</template>
