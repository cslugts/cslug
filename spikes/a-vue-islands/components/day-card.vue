<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Serialized } from '../src/island'
import type { Day } from '../src/types'

defineProps<{ day: Serialized<Day> }>()
const open = ref(false)
const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
})
</script>

<template>
  <li class="day" :data-hydrated="hydrated">
    <button type="button" @click="open = !open">{{ day.title }}</button>
    <span class="date">{{ day.date.slice(0, 10) }}</span>
    <span class="price">{{ day.priceMinor }}</span>
    <p v-show="open">details</p>
  </li>
</template>

<style scoped>
.day { color: rgb(15, 118, 110); }
</style>
