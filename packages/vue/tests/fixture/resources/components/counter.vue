<script setup lang="ts">
import { route, useForm, useT } from '@cslug/vue'
import { onMounted, ref } from 'vue'

const props = defineProps<{ start: number; label: string }>()
defineOptions({ lang: ['counter'] })
const { t } = useT()
const count = ref(props.start)
const echoed = ref('')
const form = useForm({ message: 'hello' })

onMounted(async () => {
  count.value++
  if (await form.post(route('echo'))) echoed.value = form.response.message
})
</script>

<template>
  <div class="counter" :data-count="count">
    <span class="label">{{ t('counter.label', { count }) }}</span>
    <output class="echo">{{ echoed }}</output>
  </div>
</template>
