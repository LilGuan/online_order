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
const MY_DOMAIN = 'https://print-writer-restrict-jenny.trycloudflare.com'; 

const ordersCache = {};

function readOrders() {
    try {
        if (!fs.existsSync(ORDERS_FILE)) return [];
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error('[Orders] 讀取失敗:', error.message);
        return [];
    }
}

function writeOrders(orders) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
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
        items,
        totalAmount,
        status: 'pending',
        createdAt: now,
        updatedAt: now
    };
}

app.post('/api/orders', (req, res) => {
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
        orders = orders.filter(order => order.status === status);
    }

    res.json({ orders });
});

app.patch('/api/orders/:orderNumber/status', (req, res) => {
    const allowedStatuses = ['pending', 'accepted', 'completed', 'cancelled'];
    const status = String(req.body.status || '').trim();

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: '狀態不正確' });
    }

    const orders = readOrders();
    const order = orders.find(item => item.orderNumber === req.params.orderNumber);

    if (!order) {
        return res.status(404).json({ message: '找不到訂單' });
    }

    order.status = status;
    order.updatedAt = new Date().toISOString();
    writeOrders(orders);
    res.json({ ok: true, order });
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
