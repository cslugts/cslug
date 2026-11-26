<script setup lang="ts">
import { useT, route } from '@cslug/vue'
import Layout from '../layouts/default.vue'
const { t } = useT()
</script>

<template>
  <Layout :title="t('errors.not_found')">
    <h1>{{ t('errors.not_found') }}</h1>
    <p><a :href="route('home')">{{ t('errors.back_home') }}</a></p>
  </Layout>
</template>
