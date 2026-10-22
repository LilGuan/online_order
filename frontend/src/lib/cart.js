const CART_KEY = 'vueCart';

export function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  } catch (error) {
    return [];
  }
}

export function saveCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('vue-cart-updated'));
}

export function clearCart() {
  saveCart([]);
}

export function cartCount(items = loadCart()) {
  return items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
}

export function cartTotal(items = loadCart()) {
  return items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
}

export function addCartItem(nextItem) {
  const items = loadCart();
  const existing = items.find(item => item.key === nextItem.key);
  if (existing) {
    existing.qty += nextItem.qty;
    existing.subtotal = existing.qty * existing.price;
  } else {
    items.push(nextItem);
  }
  saveCart(items);
}

export function updateQty(key, delta) {
  const items = loadCart()
    .map(item => item.key === key
      ? { ...item, qty: Math.max(0, Number(item.qty || 0) + delta) }
      : item)
    .filter(item => item.qty > 0)
    .map(item => ({ ...item, subtotal: item.qty * item.price }));
  saveCart(items);
}
