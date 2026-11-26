<script setup lang="ts">
defineProps<{ lat: number; lng: number }>()
</script>

<template>
  <div class="map">map {{ lat }},{{ lng }}</div>
</template>
