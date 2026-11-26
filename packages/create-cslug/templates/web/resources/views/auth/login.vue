<script setup lang="ts">
import { route, useRequest, useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'

const { t } = useT()
const { csrfToken, errors, old } = useRequest()
</script>

<template>
  <Layout :title="t('auth.login')">
    <h1>{{ t('auth.login') }}</h1>
    <form class="stack" :action="route('login.store')" method="post">
      <input type="hidden" name="_token" :value="csrfToken" />

      <label for="email">{{ t('auth.email') }}</label>
      <input id="email" name="email" type="email" :value="old.email" :aria-invalid="!!errors.email" required autofocus />
      <p v-if="errors.email" class="error">{{ errors.email }}</p>

      <label for="password">{{ t('auth.password') }}</label>
      <input id="password" name="password" type="password" required />

      <button>{{ t('auth.login') }}</button>
    </form>
    <p>{{ t('auth.no_account') }} <a :href="route('register')">{{ t('auth.register') }}</a></p>
  </Layout>
</template>
