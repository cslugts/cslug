<script setup lang="ts">
import { Assets, route, useRequest, useT } from '@cslug/vue'

defineProps<{ title: string }>()
const { locale, user, csrfToken, flash } = useRequest()
const { t } = useT()
</script>

<template>
  <html :lang="locale">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{{ title }} · {{ t('app.name') }}</title>
      <Assets entry="client" />
      <slot name="head" />
    </head>
    <body>
      <header class="site-header">
        <a class="brand" :href="route('home')">{{ t('app.name') }}</a>
        <nav v-if="user">
          <a :href="route('dashboard')">{{ user.name }}</a>
          <form :action="route('logout')" method="post">
            <input type="hidden" name="_token" :value="csrfToken" />
            <button class="link">{{ t('auth.logout') }}</button>
          </form>
        </nav>
        <nav v-else>
          <a :href="route('login')">{{ t('auth.login') }}</a>
          <a :href="route('register')">{{ t('auth.register') }}</a>
        </nav>
      </header>

      <p v-for="(message, type) in flash" :key="type" class="flash" :data-type="type">{{ message }}</p>

      <main class="container"><slot /></main>
    </body>
  </html>
</template>
