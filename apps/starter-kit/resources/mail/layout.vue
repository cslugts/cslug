<script setup lang="ts">
import { useT } from '@cslug/vue'
defineProps<{ preview?: string }>()
const { t } = useT()
</script>

<template>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { margin: 0; background: #f4f4f5; font-family: system-ui, sans-serif; color: #18181b; }
        .card { max-width: 560px; margin: 24px auto; background: #ffffff; padding: 24px; border-radius: 8px; }
        .button { display: inline-block; background: #0f766e; color: #ffffff; padding: 10px 16px; border-radius: 6px; text-decoration: none; }
        .muted { color: #71717a; font-size: 13px; }
      </style>
    </head>
    <body>
      <span v-if="preview" style="display: none">{{ preview }}</span>
      <table role="presentation" width="100%"><tr><td>
        <div class="card">
          <slot />
          <p class="muted">{{ t('app.name') }}</p>
        </div>
      </td></tr></table>
    </body>
  </html>
</template>
