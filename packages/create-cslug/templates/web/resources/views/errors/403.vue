<script setup lang="ts">
import { route, useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'

const { t } = useT()
</script>

<template>
  <Layout :title="t('errors.forbidden')">
    <h1>{{ t('errors.forbidden') }}</h1>
    <p><a :href="route('home')">{{ t('errors.back_home') }}</a></p>
  </Layout>
</template>
