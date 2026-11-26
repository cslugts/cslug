<script setup lang="ts">
// Negative control: renders different text on the server and in the browser, so Vue MUST warn on hydration.
const where = typeof window === 'undefined' ? 'server' : 'browser'
</script>

<template><p class="mismatch">rendered on the {{ where }}</p></template>
