<script setup lang="ts">
import Counter from '#components/counter.vue'
import DayCard from '#components/day-card.vue'
import Layout from './layouts/default.vue'

defineProps<{ day: { id: string; title: string; date: string; priceMinor: string } }>()
</script>

<template>
  <Layout title="Islands">
    <Counter :start="1" label="clicks" hydrate="load" />
    <ul><DayCard :day="day" hydrate="idle" /></ul>
  </Layout>
</template>
