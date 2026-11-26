<script setup lang="ts">
import type { Serialized } from '../src/island'
// The whole props type is a mapped/conditional type: can Vue's compile-time resolver handle it?
defineProps<Serialized<{ total: bigint; currency: string }>>()
</script>

<template><span>{{ total }} {{ currency }}</span></template>
