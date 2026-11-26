<script setup lang="ts">
import { type Serialized, useT } from '@cslug/vue'
import { ref } from 'vue'

type Day = { id: string; title: string; date: Date; priceMinor: bigint }
defineProps<{ day: Serialized<Day> }>()
const { formatDate } = useT()
const open = ref(false)
</script>

<template>
  <li class="day-card" @click="open = !open">
    <strong>{{ day.title }}</strong> <time>{{ day.date }}</time> <span class="price">{{ day.priceMinor }}</span>
  </li>
</template>

<style scoped lang="scss">
@use '@/styles/tokens' as *;
.day-card { padding: $space-3; color: $brand; }
</style>
