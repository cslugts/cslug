<script setup lang="ts">
const props = defineProps<{ status: number; code: string }>()
</script>

<template>
  <main><h1>Client error {{ props.status }} ({{ props.code }})</h1></main>
</template>
