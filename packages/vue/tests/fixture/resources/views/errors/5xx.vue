<script setup lang="ts">
const props = defineProps<{ status: number; title: string; detail?: string }>()
</script>

<template>
  <main>
    <h1>Our fault ({{ props.status }}): {{ props.title }}</h1>
    <pre v-if="props.detail">{{ props.detail }}</pre>
  </main>
</template>
