<template>
  <AppHeader title="我的訂單" back :show-orders="false" />

  <main class="page narrow">
    <section v-if="loading" class="empty">訂單讀取中...</section>
    <section v-else-if="error" class="empty danger">
      {{ error }}
      <button class="text-link" @click="loadOrders">重新整理</button>
    </section>
    <section v-else-if="!orders.length" class="empty">目前沒有訂單紀錄</section>

    <template v-else>
      <article v-if="currentOrder" class="current-order">
        <div class="order-hero">
          <div>
            <span>訂單編號</span>
            <h1>#{{ currentOrder.orderNumber }}</h1>
          </div>
          <strong>${{ currentOrder.totalAmount }}</strong>
        </div>
        <div class="progress">
          <div class="progress-line"><span :style="{ width: progressWidth }"></span></div>
          <div v-for="step in steps" :key="step.key" class="progress-step" :class="{ active: step.active, done: step.done }">
            <span></span>
            {{ step.label }}
          </div>
        </div>
        <div class="order-body">
          <p>{{ statusText }}</p>
          <p>取餐時間：{{ currentOrder.pickupTime || '待確認' }}</p>
          <ul>
            <li v-for="item in currentOrder.items" :key="item.key">
              {{ item.name }} x{{ item.qty }} <strong>${{ item.subtotal }}</strong>
            </li>
          </ul>
          <p v-if="currentOrder.notes">備註：{{ currentOrder.notes }}</p>
        </div>
      </article>

      <h2 class="section-heading">歷史訂單</h2>
      <button
        v-for="order in orders"
        :key="order.id"
        class="history-card"
        :class="{ selected: order.id === selectedId }"
        @click="selectedId = order.id"
      >
        <span>#{{ order.orderNumber }}</span>
        <small>{{ new Date(order.createdAt).toLocaleString('zh-TW') }}</small>
        <strong>${{ order.totalAmount }}</strong>
      </button>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import { requestJson } from '../lib/api';
import { initLiff } from '../lib/liff';

const route = useRoute();
const loading = ref(true);
const error = ref('');
const orders = ref([]);
const selectedId = ref(route.query.order || '');

function decodeLineUserParam(value) {
  if (!value) return '';
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return atob(padded);
  } catch (error) {
    return '';
  }
}

const currentOrder = computed(() => orders.value.find(order => order.id === selectedId.value) || orders.value[0] || null);
const statusText = computed(() => ({
  pending: '等待店家接單',
  preparing: '餐點製作中',
  completed: '訂單已備妥，可以來取餐',
  cancelled: '訂單已取消'
}[currentOrder.value?.status] || '等待店家接單'));
const progressWidth = computed(() => ({
  pending: '8%',
  preparing: '50%',
  completed: '100%',
  cancelled: '100%'
}[currentOrder.value?.status] || '8%'));
const steps = computed(() => {
  const order = currentOrder.value;
  const index = { pending: 0, preparing: 1, completed: 2, cancelled: -1 }[order?.status] ?? 0;
  return [
    { key: 'pending', label: '已送出' },
    { key: 'preparing', label: '製作中' },
    { key: 'completed', label: '已完成' }
  ].map((step, stepIndex) => ({ ...step, active: stepIndex === index, done: stepIndex < index }));
});

async function loadOrders() {
  loading.value = true;
  error.value = '';
  try {
    const state = await initLiff();
    const lineUserId = state.lineUserId || decodeLineUserParam(route.query.u) || localStorage.getItem('lineUserId') || '';
    const data = await requestJson('/api/customer/orders/history', {
      method: 'POST',
      body: JSON.stringify({ lineUserId })
    });
    orders.value = data.orders || [];
    if (!selectedId.value && orders.value[0]) selectedId.value = orders.value[0].id;
  } catch (err) {
    error.value = err.message || '訂單讀取失敗';
  } finally {
    loading.value = false;
  }
}

onMounted(loadOrders);
</script>
