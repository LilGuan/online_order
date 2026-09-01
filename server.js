const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const STORE_FILE = path.join(__dirname, 'store-status.json');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'UOk7R1DiDvRXXUxHwy/nDjspTVgC3ZzAYYRTWMO96rHgOycTbmPXUV/qtLwNa0r5+lCXvBGCcc3WHVHesgHxUd8gxwaoPMwaQuPuOT/PpzyCVMCgQdAboLV8waAZHmIXPRaeq6iMYHuECM+WY2jghQdB04t89/1O/w1cDnyilFU=';
const adminSessions = new Set();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ==========================================
// 🟢 LINE Pay 設定區
// ==========================================
const LINEPAY_CHANNEL_ID = '2008931183'; // 請確認這串數字是否正確
const LINEPAY_CHANNEL_SECRET = 'e461fe2765ab6bf8187dd0f76c54f27b'; // 請確認這串亂碼是否正確
const LINEPAY_SITE = 'https://sandbox-api-pay.line.me'; 
const LINEPAY_VERSION = '/v3/payments/request'; // Request API URI

// ★★★ 請務必更新您的 ngrok 網址 ★★★
const MY_DOMAIN = 'https://person-solid-resolution-unified.trycloudflare.com';

const ordersCache = {};

function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const data = fs.readFileSync(filePath, 'utf8');
        return data ? JSON.parse(data) : fallback;
    } catch (error) {
        console.error(`[File] 讀取失敗 ${filePath}:`, error.message);
        return fallback;
    }
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readOrders() {
    return readJsonFile(ORDERS_FILE, []);
}

function writeOrders(orders) {
    writeJsonFile(ORDERS_FILE, orders);
}

function readStoreStatus() {
    return readJsonFile(STORE_FILE, {
        isOpen: true,
        updatedAt: new Date().toISOString()
    });
}

function writeStoreStatus(status) {
    writeJsonFile(STORE_FILE, status);
}

function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!adminSessions.has(token)) {
        return res.status(401).json({ message: '請先登入 admin' });
    }

    next();
}

function addStatusHistory(order, status, note) {
    order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
    order.statusHistory.push({
        status,
        note,
        at: new Date().toISOString()
    });
}

function getStatusMessage(status) {
    if (status === 'preparing') return '店家已接單，正在製作您的餐點。';
    if (status === 'completed') return '您的訂單已備妥，可以來取餐了。';
    if (status === 'cancelled') return '店家已拒絕訂單，如有疑問請直接聯絡店家。';
    return '';
}

async function notifyCustomer(order, message) {
    const result = {
        at: new Date().toISOString(),
        message,
        sent: false,
        reason: ''
    };

    if (!message) {
        result.reason = '沒有通知內容';
        return result;
    }

    if (!order.lineUserId) {
        result.reason = '訂單沒有 LINE userId';
        return result;
    }

    if (!LINE_CHANNEL_ACCESS_TOKEN) {
        result.reason = '尚未設定 LINE_CHANNEL_ACCESS_TOKEN';
        return result;
    }

    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: order.lineUserId,
            messages: [{ type: 'text', text: `邱媽媽美食通知\n訂單 #${order.orderNumber}\n${message}` }]
        }, {
            headers: {
                Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        result.sent = true;
    } catch (error) {
        result.reason = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('[LINE Push] 發送失敗:', result.reason);
    }

    return result;
}

function getOrderDate(order) {
    return new Date(order.completedAt || order.createdAt || order.updatedAt);
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
    const result = startOfDay(date);
    const day = result.getDay();
    const diff = day === 0 ? 6 : day - 1;
    result.setDate(result.getDate() - diff);
    return result;
}

function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function summarizeRevenue(orders) {
    const now = new Date();
    const today = startOfDay(now);
    const week = startOfWeek(now);
    const month = startOfMonth(now);

    const completed = orders.filter(order => order.status === 'completed');

    function sumSince(startDate) {
        const filtered = completed.filter(order => getOrderDate(order) >= startDate);
        return {
            count: filtered.length,
            revenue: filtered.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0)
        };
    }

    return {
        today: sumSince(today),
        week: sumSince(week),
        month: sumSince(month),
        all: {
            count: completed.length,
            revenue: completed.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0)
        },
        totalOrders: orders.length
    };
}

function normalizeOrder(body) {
    const now = new Date().toISOString();
    const items = Array.isArray(body.items) ? body.items : [];
    const totalAmount = Number(body.totalAmount || 0);

    return {
        id: body.orderNumber || uuidv4(),
        orderNumber: body.orderNumber || uuidv4().slice(0, 8).toUpperCase(),
        name: String(body.name || '').trim(),
        phone: String(body.phone || '').trim(),
        pickupTime: String(body.pickupTime || '').trim(),
        paymentMethod: String(body.paymentMethod || 'cash').trim(),
        notes: String(body.notes || '').trim(),
        lineUserId: String(body.lineUserId || '').trim(),
        items,
        totalAmount,
        status: 'pending',
        statusHistory: [{ status: 'pending', note: '訂單建立', at: now }],
        customerNotifications: [],
        createdAt: now,
        updatedAt: now
    };
}

app.post('/api/admin/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ message: '帳號或密碼錯誤' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.add(token);
    res.json({ ok: true, token, username: ADMIN_USERNAME });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
    const token = req.headers.authorization.slice(7);
    adminSessions.delete(token);
    res.json({ ok: true });
});

app.get('/api/store/status', (req, res) => {
    res.json(readStoreStatus());
});

app.patch('/api/store/status', requireAdmin, (req, res) => {
    const status = {
        isOpen: Boolean(req.body.isOpen),
        updatedAt: new Date().toISOString()
    };

    writeStoreStatus(status);
    res.json({ ok: true, status });
});

app.post('/api/orders', (req, res) => {
    const storeStatus = readStoreStatus();

    if (!storeStatus.isOpen) {
        return res.status(403).json({ message: '店家目前未開放點餐' });
    }

    const order = normalizeOrder(req.body);

    if (!order.name || !order.phone || order.items.length === 0 || order.totalAmount <= 0) {
        return res.status(400).json({ message: '訂單資料不完整' });
    }

    const orders = readOrders();
    const existingIndex = orders.findIndex(item => item.orderNumber === order.orderNumber);

    if (existingIndex >= 0) {
        orders[existingIndex] = {
            ...orders[existingIndex],
            ...order,
            status: orders[existingIndex].status || 'pending',
            createdAt: orders[existingIndex].createdAt,
            updatedAt: new Date().toISOString()
        };
        writeOrders(orders);
        return res.json({ ok: true, order: orders[existingIndex] });
    }

    orders.unshift(order);
    writeOrders(orders);
    res.status(201).json({ ok: true, order });
});

app.get('/api/orders', (req, res) => {
    const status = req.query.status;
    let orders = readOrders();

    if (status && status !== 'all') {
        const statuses = String(status).split(',').map(item => item.trim());
        orders = orders.filter(order => statuses.includes(order.status));
    }

    res.json({ orders });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    res.json({ summary: summarizeRevenue(readOrders()) });
});

app.patch('/api/orders/:orderNumber/status', requireAdmin, async (req, res) => {
    const allowedStatuses = ['pending', 'preparing', 'accepted', 'completed', 'cancelled'];
    let status = String(req.body.status || '').trim();
    if (status === 'accepted') status = 'preparing';

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: '狀態不正確' });
    }

    const orders = readOrders();
    const order = orders.find(item => item.orderNumber === req.params.orderNumber);

    if (!order) {
        return res.status(404).json({ message: '找不到訂單' });
    }

    order.status = status;
    if (status === 'completed') order.completedAt = new Date().toISOString();
    if (status === 'cancelled') order.cancelledAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    addStatusHistory(order, status, String(req.body.note || ''));

    const notification = await notifyCustomer(order, getStatusMessage(status));
    order.customerNotifications = Array.isArray(order.customerNotifications) ? order.customerNotifications : [];
    order.customerNotifications.push(notification);

    writeOrders(orders);
    res.json({ ok: true, order, notification });
});

// ★★★ 修正後的簽章產生函式 ★★★
function createSignature(uri, body, nonce) {
    const stringToSign = LINEPAY_CHANNEL_SECRET + uri + body + nonce;
    const signature = crypto
        .createHmac('sha256', LINEPAY_CHANNEL_SECRET)
        .update(stringToSign)
        .digest('base64');
    return signature;
}

// 1. 建立付款請求 API
app.post('/api/linepay/request', async (req, res) => {
    const { totalAmount, items, orderNumber } = req.body;

    // 格式化商品列表 (確保無非法字元)
    const products = items.map(item => ({
        name: item.name.substring(0, 80), // 限制長度
        quantity: parseInt(item.qty),
        price: parseInt(item.price),
        imageUrl: '' // 可留空
    }));

    // 建立訂單物件
    const orderData = {
        amount: parseInt(totalAmount),
        currency: 'TWD',
        orderId: orderNumber,
        packages: [
            {
                id: 'pkg-1',
                amount: parseInt(totalAmount),
                name: 'ChiuMamaFood', // 建議先用英文
                products: products
            }
        ],
        redirectUrls: {
            confirmUrl: `${MY_DOMAIN}/api/linepay/confirm`,
            cancelUrl: `${MY_DOMAIN}/cancel.html`
        }
    };

    const requestBody = JSON.stringify(orderData);
    const nonce = uuidv4();
    const uri = LINEPAY_VERSION; // /v3/payments/request

    // 計算簽章
    const signature = createSignature(uri, requestBody, nonce);

    console.log(`[LINE Pay] 請求 URL: ${LINEPAY_SITE}${uri}`);
    console.log(`[LINE Pay] Nonce: ${nonce}`);
    console.log(`[LINE Pay] Signature: ${signature}`);

    try {
        const response = await axios.post(`${LINEPAY_SITE}${uri}`, orderData, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
                'X-LINE-Authorization': signature, // ★★★ 注意：V3 文件標頭是這個
                'X-LINE-Authorization-Nonce': nonce
            }
        });

        console.log('[LINE Pay] 回應:', response.data);

        if (response.data.returnCode === '0000') {
            ordersCache[orderNumber] = { amount: parseInt(totalAmount) };
            res.json({ paymentUrl: response.data.info.paymentUrl.web });
        } else {
            res.status(400).send(`LINE Pay Error: ${response.data.returnMessage}`);
        }

    } catch (error) {
        console.error('[API Error]', error.response ? error.response.data : error.message);
        res.status(500).send('Server Error');
    }
});

// 2. 確認付款 API
app.get('/api/linepay/confirm', async (req, res) => {
    const { transactionId, orderId } = req.query;
    console.log(`[Confirm] TransID: ${transactionId}, OrderID: ${orderId}`);

    const orderInfo = ordersCache[orderId];
    if (!orderInfo) {
        return res.status(400).send('訂單已過期或不存在');
    }

    const uri = `/v3/payments/${transactionId}/confirm`;
    const confirmData = {
        amount: orderInfo.amount,
        currency: 'TWD'
    };
    const requestBody = JSON.stringify(confirmData);
    const nonce = uuidv4();
    const signature = createSignature(uri, requestBody, nonce);

    try {
        const response = await axios.post(`${LINEPAY_SITE}${uri}`, confirmData, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
                'X-LINE-Authorization': signature,
                'X-LINE-Authorization-Nonce': nonce
            }
        });

        if (response.data.returnCode === '0000') {
            console.log('✅ 付款成功');
            // 清除暫存
            delete ordersCache[orderId];
            
            // ★★★ 修改這裡：帶上參數 ★★★
            // 請換成您的 GitHub Pages 網址
            const frontendUrl = `https://chiufood.netlify.app/order-detail.html`;
            
            // 加上 Query Parameters
            res.redirect(`${frontendUrl}?status=success&orderId=${orderId}`);
        } else {
            console.error('付款失敗:', response.data);
            res.send('付款失敗');
        }

    } catch (error) {
        console.error('[Confirm Error]', error.response ? error.response.data : error.message);
        res.status(500).send('Confirm Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
