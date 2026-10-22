<template>
  <header class="app-header">
    <button v-if="back" class="icon-btn" type="button" aria-label="返回" @click="$router.back()">
      <span aria-hidden="true">‹</span>
    </button>
    <div>
      <strong>{{ title }}</strong>
      <small v-if="subtitle">{{ subtitle }}</small>
    </div>
    <RouterLink v-if="showOrders" class="icon-btn" :to="ordersLink" aria-label="訂單紀錄">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>
    </RouterLink>
    <span v-else class="icon-space"></span>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { encodedLineUserId } from '../lib/liff';

defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  back: { type: Boolean, default: false },
  showOrders: { type: Boolean, default: true }
});

const ordersLink = computed(() => {
  const u = encodedLineUserId();
  return u ? { path: '/orders', query: { u } } : { path: '/orders' };
});
</script>
