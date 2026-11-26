<script setup lang="ts">
import { useT } from '@cslug/vue'
import DayCard from '#components/day-card.vue'
import MapWidget from '#components/map-widget.vue'
import Layout from './layouts/default.vue'

type Day = { id: string; title: string; date: Date; priceMinor: bigint }
defineProps<{ days: Day[]; withMap?: boolean }>()
const { t } = useT()
</script>

<template>
  <Layout :title="t('days.title')">
    <h1>{{ t('days.title') }} · {{ t('days.count', { count: days.length }) }}</h1>
    <ol>
      <DayCard v-for="day in days" :key="day.id" :day="{ ...day, date: day.date.toISOString(), priceMinor: String(day.priceMinor) }" />
    </ol>
    <DayCard v-if="days[0]" :day="days[0]" hydrate="visible" />
    <MapWidget v-if="withMap" :lat="-18.9" :lng="47.5" hydrate="load" :ssr="false">
      <template #fallback><p class="loading">Loading map…</p></template>
    </MapWidget>
    <MapWidget :lat="1" :lng="2" hydrate="none" />
    <img src="/img/dot.png" alt="" />
  </Layout>
</template>
