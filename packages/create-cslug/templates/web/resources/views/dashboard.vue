<script setup lang="ts">
import { useT } from '@cslug/vue'
import Layout from './layouts/default.vue'

defineProps<{ name: string }>()
const { t } = useT()
</script>

<template>
  <Layout :title="t('dashboard.title')">
    <h1>{{ t('dashboard.hello', { name }) }}</h1>
  </Layout>
</template>
