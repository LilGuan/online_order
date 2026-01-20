const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 綠界測試環境參數
const MerchantID = '2000132';
const HashKey = '5294y06JbISpM5x9';
const HashIV = 'v77hoKGq4kWxNNIS';
const ECPayURL = 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOutV5';

function pad(n) {
    return n < 10 ? '0' + n : n;
}

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
    // Node.js 的 encodeURIComponent 不會編碼 ! * ( )
    // 但綠界要求這些符號要轉成 %xx 格式
    encoded = encoded.replace(/%20/g, '+')
                     .replace(/%2d/g, '-')
                     .replace(/%5f/g, '_')
                     .replace(/%2e/g, '.')
                     .replace(/!/g, '%21')
                     .replace(/\*/g, '%2a')
                     .replace(/\(/g, '%28')
                     .replace(/\)/g, '%29');
                     
    // 5. SHA256 加密並轉大寫
    const sha256 = crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
    return sha256;
}

app.post('/api/createOrder', (req, res) => {
    const { totalAmount, items, tradeDesc } = req.body;
    
    const tradeNo = 'Ord' + new Date().getTime();
    
    // 產生格式正確的時間 yyyy/MM/dd HH:mm:ss
    const now = new Date();
    const formattedDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let baseParams = {
        MerchantID: MerchantID,
        MerchantTradeNo: tradeNo,
        MerchantTradeDate: formattedDate, // 使用修正後的日期
        PaymentType: 'aio',
        TotalAmount: Math.round(totalAmount), // 確保整數
        TradeDesc: tradeDesc || 'ShopOrder',
        ItemName: items.join('#').substring(0, 200), // 避免太長
        ReturnURL: 'https://developers.line.biz', // 暫時填一個有效網址
        ClientBackURL: 'https://developers.line.biz', // 付款後跳轉回哪
        ChoosePayment: 'ALL',
        EncryptType: '1',
    };

    console.log('Params before hash:', baseParams); // Debug 用

    baseParams.CheckMacValue = genCheckMacValue(baseParams);

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