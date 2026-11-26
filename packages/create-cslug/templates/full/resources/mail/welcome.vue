<script setup lang="ts">
import { useT } from '@cslug/vue'
import Layout from './layout.vue'

defineProps<{ name: string }>()
const { t } = useT()
</script>

<template>
  <Layout :preview="t('mail.welcome.subject')">
    <p>{{ t('mail.welcome.greeting', { name }) }}</p>
    <p>{{ t('mail.welcome.body') }}</p>
  </Layout>
</template>
