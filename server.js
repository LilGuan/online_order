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

// 補零函式
function pad(n) {
    return n < 10 ? '0' + n : n;
}

// ★★★ 修正後的檢查碼計算函式 ★★★
function genCheckMacValue(params) {
    // 1. 參數按字母排序 (A-Z)
    const keys = Object.keys(params).sort();
    
    // 2. 串接字串: HashKey + 參數 + HashIV
    let str = `HashKey=${HashKey}`;
    keys.forEach(key => {
        str += `&${key}=${params[key]}`;
    });
    str += `&HashIV=${HashIV}`;
    
    // 3. URL Encode 並轉小寫
    // 注意：encodeURIComponent 會把中文、空白、符號都編碼
    let encoded = encodeURIComponent(str).toLowerCase();
    
    // 4. 依照綠界規則，將特定的「編碼後字元」替換回「原字元」
    // (例如 %2d 換回 -，%20 換回 +)
    encoded = encoded.replace(/%2d/g, '-')
                     .replace(/%5f/g, '_')
                     .replace(/%2e/g, '.')
                     .replace(/%21/g, '!')
                     .replace(/%2a/g, '*')
                     .replace(/%28/g, '(')
                     .replace(/%29/g, ')')
                     .replace(/%20/g, '+'); // 空白轉成 +
                     
    // 5. SHA256 加密並轉大寫
    const sha256 = crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
    return sha256;
}

app.post('/api/createOrder', (req, res) => {
    const { totalAmount, items, tradeDesc } = req.body;
    
    const tradeNo = 'Ord' + new Date().getTime();
    
    // 產生時間 yyyy/MM/dd HH:mm:ss
    const now = new Date();
    const formattedDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    // 基本參數
    let baseParams = {
        MerchantID: MerchantID,
        MerchantTradeNo: tradeNo,
        MerchantTradeDate: formattedDate,
        PaymentType: 'aio',
        TotalAmount: Math.round(totalAmount), // 金額須為整數
        TradeDesc: tradeDesc || 'ShopOrder',
        ItemName: items.join('#'), // 商品名稱用 # 連接
        ReturnURL: 'https://developers.line.biz', // 付款完成通知網址 (測試用)
        ClientBackURL: 'https://developers.line.biz', // 付款完成跳轉網址 (測試用)
        ChoosePayment: 'ALL',
        EncryptType: '1',
    };

    console.log('Params:', baseParams);

    // 計算檢查碼
    baseParams.CheckMacValue = genCheckMacValue(baseParams);

    // 產生自動送出的 HTML Form
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