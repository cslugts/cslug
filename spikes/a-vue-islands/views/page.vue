<script setup lang="ts">
import Counter from '../components/counter.vue'
import DayCard from '../components/day-card.vue'
import { serialize } from '../src/island'
import type { Day } from '../src/types'

const props = defineProps<{ title: string; days: Day[] }>()
</script>

<template>
  <main>
    <h1>{{ title }}</h1>
    <ul class="days">
      <!-- static: HTML only -->
      <DayCard v-for="d in days" :key="d.id" :day="serialize(d)" />
      <!-- the same component as an island -->
      <DayCard :day="serialize(props.days[0]!)" hydrate="visible" />
    </ul>
    <Counter :start="3" label="load" hydrate="load" />
    <Counter :start="10" label="idle" hydrate="idle" />
    <Counter :start="20" label="media" hydrate="media:(min-width: 1px)" />
    <div style="height: 6000px"></div>
    <!-- far below the fold: must NOT hydrate during the test -->
    <Counter :start="100" label="offscreen" hydrate="visible" />
  </main>
</template>
