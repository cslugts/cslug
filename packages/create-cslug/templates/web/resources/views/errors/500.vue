<script setup lang="ts">
import { route, useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'

// detail is set in development only (APP_ENV is not production)
const props = defineProps<{ requestId: string; detail?: string }>()
const { t } = useT()
</script>

<template>
  <Layout :title="t('errors.server_error')">
    <h1>{{ t('errors.server_error') }}</h1>
    <p>{{ t('errors.server_error_body') }}</p>
    <p><small>{{ t('errors.request_id', { id: props.requestId }) }}</small></p>
    <pre v-if="props.detail">{{ props.detail }}</pre>
    <p><a :href="route('home')">{{ t('errors.back_home') }}</a></p>
  </Layout>
</template>
