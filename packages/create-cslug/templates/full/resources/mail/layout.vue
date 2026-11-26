<script setup lang="ts">
defineProps<{ preview?: string }>()
</script>

<template>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: system-ui, sans-serif; background: #fafafa; margin: 0; padding: 24px; color: #18181b; }
        .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; }
        .button { display: inline-block; background: #0f766e; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; }
      </style>
    </head>
    <body>
      <span v-if="preview" style="display: none">{{ preview }}</span>
      <div class="card"><slot /></div>
    </body>
  </html>
</template>
