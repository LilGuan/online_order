const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==========================================
// 🟢 LINE Pay 設定區 (請填入後台查到的資料)
// ==========================================
const LINEPAY_CHANNEL_ID = '2008931183'; 
const LINEPAY_CHANNEL_SECRET = 'e461fe2765ab6bf8187dd0f76c54f27b';
const LINEPAY_VERSION = 'v3';
const LINEPAY_SITE = 'https://sandbox-api-pay.line.me'; // 測試環境網址

// 您的 ngrok 網址 (每次重開 ngrok 都要換)
const MY_DOMAIN = 'https://35e4107acd64.ngrok-free.app'; 

// 暫存訂單資訊 (為了在 callback 時知道要扣多少錢)
// 在正式環境建議存資料庫，這裡用記憶體暫存
const ordersCache = {};

// 產生 LINE Pay 簽章 (Signature)
function createSignature(uri, body) {
    const nonce = uuidv4();
    const stringToSign = `${LINEPAY_CHANNEL_SECRET}/${LINEPAY_VERSION}${uri}${body}${nonce}`;
    const signature = crypto
        .createHmac('sha256', LINEPAY_CHANNEL_SECRET)
        .update(stringToSign)
        .digest('base64');
    return { signature, nonce };
}

// 1. 建立付款請求 API
app.post('/api/linepay/request', async (req, res) => {
    const { totalAmount, items, orderNumber } = req.body;

    // 整理商品列表格式
    const products = items.map(item => ({
        name: item.name,
        quantity: item.qty,
        price: item.price
    }));

    const orderData = {
        amount: Math.round(totalAmount),
        currency: 'TWD',
        orderId: orderNumber, // 使用前端傳來的訂單編號
        packages: [
            {
                id: 'pkg-1',
                amount: Math.round(totalAmount),
                name: '邱媽媽美食',
                products: products
            }
        ],
        redirectUrls: {
            // 使用者在 LINE Pay 付款完會跳轉回這裡
            confirmUrl: `${MY_DOMAIN}/api/linepay/confirm`,
            cancelUrl: `${MY_DOMAIN}/cancel.html`
        }
    };

    // 存入暫存，供 Confirm 使用
    ordersCache[orderNumber] = { amount: Math.round(totalAmount) };

    const uri = '/v3/payments/request';
    const body = JSON.stringify(orderData);
    const { signature, nonce } = createSignature(uri, body);

    console.log(`[LINE Pay] 建立訂單: ${orderNumber}, 金額: ${totalAmount}`);

    try {
        const response = await axios.post(`${LINEPAY_SITE}${uri}`, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
                'X-LINE-Authorization-Signature': signature,
                'X-LINE-Authorization-Nonce': nonce
            }
        });

        if (response.data.returnCode === '0000') {
            // 回傳付款網址給前端
            res.json({ paymentUrl: response.data.info.paymentUrl.web });
        } else {
            console.error('LINE Pay Error:', response.data);
            res.status(400).send('LINE Pay 請求失敗');
        }

    } catch (error) {
        console.error('API Error:', error);
        res.status(500).send('Server Error');
    }
});

// 2. 確認付款 API (Confirm)
// LINE Pay 跳轉回來會帶上 transactionId 和 orderId
app.get('/api/linepay/confirm', async (req, res) => {
    const { transactionId, orderId } = req.query;

    console.log(`[LINE Pay] 收到回調: OrderID=${orderId}, TransID=${transactionId}`);

    // 從暫存取出金額
    const orderInfo = ordersCache[orderId];
    if (!orderInfo) {
        return res.status(400).send('訂單資訊遺失或已過期');
    }

    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = JSON.stringify({
        amount: orderInfo.amount,
        currency: 'TWD'
    });
    const { signature, nonce } = createSignature(uri, body);

    try {
        const response = await axios.post(`${LINEPAY_SITE}${uri}`, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
                'X-LINE-Authorization-Signature': signature,
                'X-LINE-Authorization-Nonce': nonce
            }
        });

        if (response.data.returnCode === '0000') {
            console.log('✅ 付款成功！');
            // 清除暫存
            delete ordersCache[orderId];
            
            // 跳轉回前端的訂單明細頁 (我們帶上參數讓前端知道成功了)
            // 這裡假設您的前端網址是 GitHub Pages，請修改下面網址
            // 如果是在本機測試，就用 Live Server 的網址
            // ★★★ 重要：請改成您的前端網址 ★★★
            res.redirect(`https://你的github帳號.github.io/你的專案名/order-detail.html?status=success`);
            
        } else {
            console.error('付款確認失敗:', response.data);
            res.send('付款確認失敗，請聯繫店家。');
        }

    } catch (error) {
        console.error('Confirm API Error:', error);
        res.status(500).send('Server Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});