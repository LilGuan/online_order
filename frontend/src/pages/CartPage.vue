<template>
  <AppHeader title="購物車" back :show-orders="false" />

  <main class="page narrow">
    <section v-if="!items.length" class="empty">
      購物車是空的
      <RouterLink class="text-link" to="/">回菜單</RouterLink>
    </section>

    <template v-else>
      <article v-for="item in items" :key="item.key" class="cart-item">
        <div>
          <h2>{{ item.name }}</h2>
          <strong>${{ item.price }}</strong>
        </div>
        <div class="qty">
          <button @click="changeQty(item.key, -1)">−</button>
          <strong>{{ item.qty }}</strong>
          <button @click="changeQty(item.key, 1)">＋</button>
        </div>
      </article>

      <section class="form-card">
        <div class="field">
          <label>姓名 *</label>
          <input v-model.trim="form.name" placeholder="請輸入您的姓名" />
        </div>
        <div class="field">
          <label>電話 *</label>
          <input v-model.trim="form.phone" inputmode="numeric" maxlength="10" placeholder="09xxxxxxxx" />
          <small v-if="phoneError">請輸入 09 開頭的 10 碼手機號碼</small>
        </div>
        <label class="check">
          <input v-model="form.utensils" type="checkbox" />
          需要餐具
        </label>
        <div class="field">
          <label>備註</label>
          <textarea v-model.trim="form.notes" rows="3" placeholder="例如：少油、飯少一點..." />
        </div>
      </section>
    </template>
  </main>

  <footer v-if="items.length" class="checkout">
    <div>
      <span>總計</span>
      <strong>${{ total }}</strong>
    </div>
    <button :disabled="submitting" @click="submitOrder">
      {{ submitting ? '送出中...' : '送出訂單' }}
    </button>
  </footer>

  <div v-if="loginPrompt" class="sheet-backdrop" @click.self="loginPrompt = false">
    <section class="login-modal">
      <div class="line-icon">LINE</div>
      <h2>請先登入 LINE</h2>
      <p>登入後會回到購物車。請再次確認資料，然後再按一次「送出訂單」才會正式送出。</p>
      <div class="modal-actions">
        <button @click="loginPrompt = false">稍後</button>
        <button class="line" @click="goLineLogin">登入 LINE</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import { requestJson } from '../lib/api';
import { cartTotal, clearCart, loadCart, updateQty } from '../lib/cart';
import { encodedLineUserId, initLiff, loginWithLine } from '../lib/liff';

const router = useRouter();
const items = ref(loadCart());
const submitting = ref(false);
const loginPrompt = ref(false);
const lineUserId = ref(localStorage.getItem('lineUserId') || '');
const form = reactive({
  name: '',
  phone: localStorage.getItem('userPhone') || '',
  utensils: false,
  notes: ''
});

const total = computed(() => cartTotal(items.value));
const phoneError = computed(() => Boolean(form.phone) && !/^09\d{8}$/.test(form.phone));

function changeQty(key, delta) {
  updateQty(key, delta);
  items.value = loadCart();
}

async function ensureLine() {
  const state = await initLiff();
  lineUserId.value = state.lineUserId || localStorage.getItem('lineUserId') || '';
  if (lineUserId.value) return true;
  loginPrompt.value = true;
  return false;
}

function goLineLogin() {
  localStorage.setItem('vueCheckoutDraft', JSON.stringify({ ...form }));
  loginWithLine();
}

async function submitOrder() {
  if (submitting.value) return;
  if (!items.value.length) return;
  if (!form.name.trim()) return alert('請輸入姓名');
  if (!/^09\d{8}$/.test(form.phone)) return alert('請輸入 09 開頭的 10 碼手機號碼');
  if (!(await ensureLine())) return;
  if (!(await window.LineStartGate.ensure())) return;

  submitting.value = true;
  try {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 15);
    const pickupTime = `約 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 取餐`;
    const payload = {
      name: form.name.trim().length <= 5 ? `${form.name.trim()} 先生/小姐` : form.name.trim(),
      phone: form.phone,
      pickupTime,
      paymentMethod: 'cash',
      notes: form.notes,
      utensils: form.utensils ? 'yes' : 'none',
      lineUserId: lineUserId.value,
      orderType: 'instant',
      orderNumber: `VUE-${Date.now()}`,
      items: items.value,
      totalAmount: total.value
    };
    const data = await requestJson('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${window.liff.getIDToken()}` },
      body: JSON.stringify(payload)
    });
    localStorage.setItem('userPhone', form.phone);
    clearCart();
    items.value = [];
    const u = encodedLineUserId();
    router.push({ path: '/orders', query: { order: data.order?.id || '', ...(u ? { u } : {}) } });
  } catch (error) {
    alert(error.message || '訂單送出失敗');
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  const draft = JSON.parse(localStorage.getItem('vueCheckoutDraft') || 'null');
  if (draft) {
    Object.assign(form, draft);
    localStorage.removeItem('vueCheckoutDraft');
  }
  const state = await initLiff();
  lineUserId.value = state.lineUserId || localStorage.getItem('lineUserId') || '';
  if (state.profile?.displayName && !form.name) form.name = state.profile.displayName;
  await window.LineStartGate.ensure();
});
</script>
