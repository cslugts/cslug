<script setup lang="ts">
const props = defineProps<{ status: number; title: string; requestId: string }>()
</script>

<template>
  <main class="not-found">
    <h1>Lost? ({{ props.status }})</h1>
    <p>{{ props.title }}</p>
    <small>{{ props.requestId }}</small>
  </main>
</template>
