<script setup lang="ts">
import { Assets, useRequest } from '@cslug/vue'

defineProps<{ title: string }>()
const { locale, flash, alternates } = useRequest()
</script>

<template>
  <html :lang="locale">
    <head>
      <meta charset="utf-8" />
      <title>{{ title }}</title>
      <link v-for="alt in alternates" :key="alt.locale" rel="alternate" :hreflang="alt.locale" :href="alt.url" />
      <Assets entry="client" />
      <slot name="head" />
    </head>
    <body>
      <p v-for="(message, type) in flash" :key="type" class="flash" :data-type="type">{{ message }}</p>
      <main><slot /></main>
    </body>
  </html>
</template>
