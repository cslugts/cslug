<script setup lang="ts">
import { useT } from '@cslug/vue'

defineProps<{ name: string; items: { title: string }[] }>()
const { t } = useT()
</script>

<template>
  <html>
    <head>
      <style>
        .card { padding: 16px; color: #0f766e; }
        h1 { font-size: 20px; }
        a:hover { color: red; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>{{ t('mail.due.hello', { name }) }}</h1>
        <ul><li v-for="item in items" :key="item.title">{{ item.title }}</li></ul>
        <a href="https://starter.test/todos">Open</a>
      </div>
    </body>
  </html>
</template>
