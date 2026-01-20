const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 綠界測試環境參數 (正式環境請換成您的)
const MerchantID = '2000132';
const HashKey = '5294y06JbISpM5x9';
const HashIV = 'v77hoKGq4kWxNNIS';
const ECPayURL = 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOutV5'; // 測試環境網址

// 計算 CheckMacValue 的函式
function genCheckMacValue(params) {
    // 1. 參數按字母排序
    const keys = Object.keys(params).sort();
    
    // 2. 串接字串
    let str = `HashKey=${HashKey}`;
    keys.forEach(key => {
        str += `&${key}=${params[key]}`;
    });
    str += `&HashIV=${HashIV}`;
    
    // 3. URL Encode
    let encoded = encodeURIComponent(str).toLowerCase();
    
    // 4. 針對特殊字元修正 (綠界規則)
    encoded = encoded.replace(/%20/g, '+')
                     .replace(/%2d/g, '-')
                     .replace(/%5f/g, '_')
                     .replace(/%2e/g, '.')
                     .replace(/%21/g, '!')
                     .replace(/%2a/g, '*')
                     .replace(/%28/g, '(')
                     .replace(/%29/g, ')');
                     
    // 5. SHA256 加密並轉大寫
    const sha256 = crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
    return sha256;
}

// 建立訂單 API
app.post('/api/createOrder', (req, res) => {
    const { totalAmount, items, tradeDesc } = req.body;
    
    // 產生訂單編號 (需唯一)
    const tradeNo = 'Ord' + new Date().getTime();
    
    // 綠界參數
    let baseParams = {
        MerchantID: MerchantID,
        MerchantTradeNo: tradeNo,
        MerchantTradeDate: new Date().toLocaleString('zh-TW', { hour12: false }).replace(/\//g, '/'),
        PaymentType: 'aio',
        TotalAmount: totalAmount,
        TradeDesc: tradeDesc || '線上購物',
        ItemName: items.join('#'), // 商品名稱用 # 分隔
        ReturnURL: 'https://your-backend.com/api/payment_notify', // 綠界通知您的網址
        ClientBackURL: 'https://your-frontend.com/order-detail.html', // 使用者付款後跳轉回哪
        ChoosePayment: 'ALL', // 包含 Apple Pay, Google Pay, 信用卡
        EncryptType: '1',
    };

    // 加入檢查碼
    baseParams.CheckMacValue = genCheckMacValue(baseParams);

    // 產生 HTML Form 自動送出
    let formHtml = `<form id="ecpay-form" action="${ECPayURL}" method="POST">`;
    for (const key in baseParams) {
        formHtml += `<input type="hidden" name="${key}" value="${baseParams[key]}" />`;
    }
    formHtml += `<script>document.getElementById("ecpay-form").submit();</script></form>`;

    res.send(formHtml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});