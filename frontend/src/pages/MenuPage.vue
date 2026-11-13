<template>
  <AppHeader :title="settings.storeName || '邱媽媽美食'" subtitle="Vue 新版前台" />

  <main class="page">
    <div v-if="closedMessage" class="banner">{{ closedMessage }}</div>

    <nav class="tabs">
      <button :class="{ active: category === 'all' }" @click="category = 'all'">全部</button>
      <button
        v-for="item in categories"
        :key="item.key"
        :class="{ active: category === item.key }"
        @click="category = item.key"
      >
        {{ item.name }}
      </button>
    </nav>

    <section v-if="loading" class="empty">菜單載入中...</section>
    <section v-else-if="error" class="empty danger">{{ error }}</section>
    <section v-else class="menu-grid">
      <article v-for="item in filteredItems" :key="item.id" class="menu-card" @click="openItem(item)">
        <img :src="assetUrl(item.image)" :alt="item.name" loading="lazy" />
        <div class="menu-card-body">
          <h2>{{ item.name }}</h2>
          <p v-if="item.description">{{ item.description }}</p>
          <strong>${{ item.price }}</strong>
          <button type="button" :disabled="item.soldOut" @click.stop="openItem(item)">
            {{ item.soldOut ? '已售完' : '加入購物車' }}
          </button>
        </div>
      </article>
    </section>

    <section class="store-info">
      <h1>{{ settings.storeName || '邱媽媽美食' }}｜桃園大園線上訂餐</h1>
      <p>營業時間內可直接線上點餐，店家收到訂單後會盡快準備，歡迎自取。</p>
      <div class="info-row">
        <span>地址：{{ settings.address || '桃園市大園區皇家六街12號' }}</span>
        <a class="round-action blue" :href="mapUrl" target="_blank" rel="noopener" aria-label="Google 地圖">⌖</a>
      </div>
      <div class="info-row">
        <span>電話：{{ settings.phone || '03-381-2828' }}</span>
        <a class="round-action" :href="`tel:${settings.phone || '033812828'}`" aria-label="撥打電話">☎</a>
      </div>
    </section>
  </main>

  <RouterLink class="cart-fab" to="/cart" aria-label="前往購物車">
    🛒
    <span v-if="count">{{ count }}</span>
  </RouterLink>

  <div v-if="selected" class="sheet-backdrop" @click.self="selected = null">
    <section class="sheet">
      <img :src="assetUrl(selected.image)" :alt="selected.name" />
      <div class="sheet-body">
        <h2>{{ selected.name }}</h2>
        <p>{{ selected.description || '邱媽媽家常料理，現點現做。' }}</p>
        <label v-for="option in itemOptions" :key="option.key" class="check">
          <input v-model="selectedOptions[option.key]" type="checkbox" />
          {{ option.label }} <span v-if="option.price">+${{ option.price }}</span>
        </label>
      </div>
      <div class="sheet-bottom">
        <div class="qty">
          <button @click="qty = Math.max(1, qty - 1)">−</button>
          <strong>{{ qty }}</strong>
          <button @click="qty += 1">＋</button>
        </div>
        <button class="primary" @click="addSelected">加入 ${{ selectedTotal }}</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import AppHeader from '../components/AppHeader.vue';
import { assetUrl, requestJson } from '../lib/api';
import { addCartItem, cartCount, loadCart } from '../lib/cart';
import { initLiff } from '../lib/liff';

const loading = ref(true);
const error = ref('');
const category = ref('all');
const items = ref([]);
const categories = ref([]);
const settings = ref({});
const optionPrices = ref({});
const count = ref(cartCount());
const selected = ref(null);
const qty = ref(1);
const selectedOptions = ref({});

const filteredItems = computed(() => (
  category.value === 'all'
    ? items.value
    : items.value.filter(item => item.category === category.value)
));

const closedMessage = computed(() => settings.value.isOpen === false ? '店家目前未開放點餐，請稍後再試。' : '');
const mapUrl = computed(() => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(settings.value.address || '桃園市大園區皇家六街12號')}`);
const itemOptions = computed(() => {
  if (!selected.value) return [];
  const options = selected.value.options || {};
  return [
    { key: 'large', label: '加大', price: optionPrices.value.large || 0 },
    { key: 'doubleEgg', label: '雙蛋', price: optionPrices.value.doubleEgg || 0 },
    { key: 'doubleShrimp', label: '加蝦', price: optionPrices.value.doubleShrimp || 0 },
    { key: 'spicyPacket', label: '辣包', price: 0 }
  ].filter(option => options[option.key]);
});
const selectedTotal = computed(() => {
  if (!selected.value) return 0;
  const extra = itemOptions.value.reduce((sum, option) => selectedOptions.value[option.key] ? sum + Number(option.price || 0) : sum, 0);
  return (Number(selected.value.price || 0) + extra) * qty.value;
});

async function openItem(item) {
  if (!(await window.LineStartGate.ensure())) return;
  if (item.soldOut) return;
  selected.value = item;
  qty.value = 1;
  selectedOptions.value = {};
}

async function addSelected() {
  if (!(await window.LineStartGate.ensure())) return;
  const optionLabels = itemOptions.value.filter(option => selectedOptions.value[option.key]).map(option => option.label);
  const displayName = optionLabels.length ? `${selected.value.name}（${optionLabels.join('、')}）` : selected.value.name;
  const optionKey = optionLabels.join('-') || 'normal';
  addCartItem({
    key: `${selected.value.id}-${optionKey}`,
    menuId: selected.value.id,
    name: displayName,
    price: selectedTotal.value / qty.value,
    qty: qty.value,
    subtotal: selectedTotal.value,
    options: { ...selectedOptions.value }
  });
  count.value = cartCount();
  selected.value = null;
}

onMounted(async () => {
  try {
    await initLiff();
    await window.LineStartGate.ensure();
    const [menu, publicSettings] = await Promise.all([
      requestJson('/api/menu', { cache: 'no-store' }),
      requestJson('/api/settings/public', { cache: 'no-store' })
    ]);
    items.value = menu.items || [];
    categories.value = menu.categories || [];
    optionPrices.value = menu.optionPrices || {};
    settings.value = publicSettings || {};
  } catch (err) {
    error.value = err.message || '菜單載入失敗';
  } finally {
    loading.value = false;
  }
  window.addEventListener('vue-cart-updated', () => { count.value = cartCount(loadCart()); });
});
</script>
