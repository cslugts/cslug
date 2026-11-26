<script setup lang="ts">
import { useRequest } from '@cslug/vue'
import Layout from './layouts/default.vue'

const { csrfToken, errors, old } = useRequest()
</script>

<template>
  <Layout title="Login">
    <form action="/login" method="post">
      <input type="hidden" name="_token" :value="csrfToken" />
      <input name="email" :value="old.email" />
      <p v-if="errors.email" class="error">{{ errors.email }}</p>
    </form>
  </Layout>
</template>
