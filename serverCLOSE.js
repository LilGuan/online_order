const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const ecpay_payment = require('ecpay_aio_nodejs'); // 引入官方 SDK
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 綠界測試參數 (SDK 會自動處理 HashKey/HashIV)
const options = {
    "OperationMode": "Test", // Test or Production
    "MercProfile": {
        "MerchantID": "2000132",
        "HashKey": "5294y06JbISpM5x9",
        "HashIV": "v77hoKGq4kWxNNIS"
    },
    "IgnorePayment": [],
    "IsProjectContractor": false,
};

// 初始化 SDK
const create = new ecpay_payment(options);

app.post('/api/createOrder', (req, res) => {
    const { totalAmount, items, tradeDesc } = req.body;
    
    // 產生不重複的訂單編號 (時間戳 + 3位亂數)
    const tradeNo = 'Ord' + new Date().getTime() + Math.floor(Math.random() * 1000);
    
    // 產生正確的時間格式 yyyy/MM/dd HH:mm:ss
    const date = new Date();
    const formattedDate = date.getFullYear() + '/' + 
                          ('0' + (date.getMonth() + 1)).slice(-2) + '/' + 
                          ('0' + date.getDate()).slice(-2) + ' ' + 
                          ('0' + date.getHours()).slice(-2) + ':' + 
                          ('0' + date.getMinutes()).slice(-2) + ':' + 
                          ('0' + date.getSeconds()).slice(-2);

    // 處理商品名稱 (轉字串、過濾特殊符號)
    let safeItemName = '';
    if (items && items.length > 0) {
        safeItemName = items.join('#').replace(/[^\u4e00-\u9fa5a-zA-Z0-9# ]/g, '');
    }
    if (!safeItemName) safeItemName = "Item";

    // 訂單參數
    let base_param = {
        "MerchantTradeNo": tradeNo,
        "MerchantTradeDate": formattedDate,
        "TotalAmount": Math.round(totalAmount).toString(), // 轉字串
        "TradeDesc": tradeDesc || "OnlineOrder",
        "ItemName": safeItemName,
        "ReturnURL": "https://developers.line.biz", // 測試用
        "ClientBackURL": "https://developers.line.biz", // 測試用
        "ChoosePayment": "ALL",
        "EncryptType": "1",
    };

    console.log('SDK 產生訂單:', base_param);

    try {
        // 使用 SDK 產生 HTML 表單
        const html = create.payment_client.aio_check_out_all(base_param);
        res.send(html);
    } catch (error) {
        console.error('SDK 錯誤:', error);
        res.status(500).send('建立訂單失敗');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (Using Official SDK)`);
});