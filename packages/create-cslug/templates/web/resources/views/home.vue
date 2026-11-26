<script setup lang="ts">
import { useT } from '@cslug/vue'
import Layout from './layouts/default.vue'

const { t } = useT()
</script>

<template>
  <Layout :title="t('home.title')">
    <h1>{{ t('app.name') }}</h1>
    <p>{{ t('home.intro') }}</p>
  </Layout>
</template>
