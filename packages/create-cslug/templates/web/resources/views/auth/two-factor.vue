<script setup lang="ts">
import { route, useRequest, useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'

const { t } = useT()
const { csrfToken, errors } = useRequest()
</script>

<template>
  <Layout :title="t('auth.two_factor')">
    <h1>{{ t('auth.two_factor') }}</h1>
    <p>{{ t('auth.two_factor_intro') }}</p>
    <form class="stack" :action="route('two-factor.store')" method="post">
      <input type="hidden" name="_token" :value="csrfToken" />

      <label for="code">{{ t('auth.code') }}</label>
      <input
        id="code"
        name="code"
        autocomplete="one-time-code"
        :aria-invalid="!!errors.code"
        required
        autofocus
      />
      <p v-if="errors.code" class="error">{{ errors.code }}</p>
      <p class="hint">{{ t('auth.recovery_hint') }}</p>

      <button>{{ t('auth.verify') }}</button>
    </form>
  </Layout>
</template>
