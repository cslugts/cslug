<script setup lang="ts">
import DayCard from '../components/day-card.vue'
import { serialize } from '../src/island'
import type { Day } from '../src/types'

defineProps<{ days: Day[] }>()
</script>

<template>
  <ul><DayCard v-for="d in days" :key="d.id" :day="serialize(d)" /></ul>
</template>
