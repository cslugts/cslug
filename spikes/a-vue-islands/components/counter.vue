<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ start: number; label?: string }>()
const count = ref(props.start)
const hydrated = ref(false)
onMounted(() => {
  hydrated.value = true
  count.value++ // proves reactivity works after hydration
})
</script>

<template>
  <button type="button" class="counter" :data-label="label" :data-hydrated="hydrated" @click="count++">{{ count }}</button>
</template>
