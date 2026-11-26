<script setup lang="ts">
import Counter from '../components/counter.vue'
</script>

<template>
  <Counter :start="1" hydrate="load">slot content is not allowed on an island</Counter>
</template>
