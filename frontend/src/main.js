import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import MenuPage from './pages/MenuPage.vue';
import CartPage from './pages/CartPage.vue';
import OrdersPage from './pages/OrdersPage.vue';
import './styles/app.css';

const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    { path: '/', name: 'menu', component: MenuPage },
    { path: '/cart', name: 'cart', component: CartPage },
    { path: '/orders', name: 'orders', component: OrdersPage }
  ]
});

createApp(App).use(router).mount('#app');
