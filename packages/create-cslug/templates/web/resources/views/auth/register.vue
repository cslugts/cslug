<script setup lang="ts">
import { route, useRequest, useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'

const { t } = useT()
const { csrfToken, errors, old } = useRequest()
</script>

<template>
  <Layout :title="t('auth.register')">
    <h1>{{ t('auth.register') }}</h1>
    <form class="stack" :action="route('register.store')" method="post">
      <input type="hidden" name="_token" :value="csrfToken" />

      <label for="name">{{ t('auth.name') }}</label>
      <input id="name" name="name" :value="old.name" :aria-invalid="!!errors.name" required />
      <p v-if="errors.name" class="error">{{ errors.name }}</p>

      <label for="email">{{ t('auth.email') }}</label>
      <input id="email" name="email" type="email" :value="old.email" :aria-invalid="!!errors.email" required />
      <p v-if="errors.email" class="error">{{ errors.email }}</p>

      <label for="password">{{ t('auth.password') }}</label>
      <input id="password" name="password" type="password" minlength="12" required />
      <p v-if="errors.password" class="error">{{ errors.password }}</p>

      <label for="passwordConfirmation">{{ t('auth.password_confirmation') }}</label>
      <input id="passwordConfirmation" name="passwordConfirmation" type="password" required />
      <p v-if="errors.passwordConfirmation" class="error">{{ errors.passwordConfirmation }}</p>

      <button>{{ t('auth.register') }}</button>
    </form>
  </Layout>
</template>
