const crypto = require('crypto');

const START_TEXT = '開始使用';

function validSignature(rawBody, signature, secret) {
    if (!Buffer.isBuffer(rawBody) || !signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const received = Buffer.from(signature, 'base64');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function onboardingCard({ ready, liffUrl, baseUrl = 'https://order.chiufood.com' }) {
    const accent = ready ? '#087F5B' : '#D94B48';
    return {
        type: 'flex',
        altText: ready ? '邱媽媽美食｜已完成開始使用，歡迎線上點餐' : '邱媽媽美食｜歡迎加入，請按「開始使用」',
        contents: {
            type: 'bubble', size: 'mega',
            header: {
                type: 'box', layout: 'horizontal', spacing: 'lg', paddingAll: '20px', backgroundColor: '#292D2C', alignItems: 'center',
                contents: [
                    { type: 'box', layout: 'vertical', width: '60px', height: '60px', cornerRadius: '30px', backgroundColor: '#FFFFFF', flex: 0,
                        contents: [{ type: 'image', url: new URL('/images/logo.jpg', baseUrl).href, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' }] },
                    { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
                        { type: 'text', text: '邱媽媽美食', weight: 'bold', size: 'xl', color: '#FFFFFF', wrap: true },
                        { type: 'text', text: '家常好味道，現點現做', size: 'xs', color: '#D0D9D5', wrap: true }
                    ] }
                ]
            },
            body: {
                type: 'box', layout: 'vertical', paddingAll: '24px', spacing: 'lg', contents: [
                    { type: 'box', layout: 'horizontal', contents: [
                        { type: 'box', layout: 'vertical', backgroundColor: ready ? '#E7F5EF' : '#FFF0EF', cornerRadius: '6px', paddingAll: '8px', flex: 0,
                            contents: [{ type: 'text', text: ready ? '已完成驗證' : '歡迎加入', size: 'xs', weight: 'bold', color: accent }] }
                    ] },
                    { type: 'text', text: ready ? '今天想吃點什麼？' : '一頓好飯，\n從這裡開始。', size: 'xxl', weight: 'bold', color: '#252B28', wrap: true },
                    { type: 'text', text: ready ? '已為您開通線上訂餐，\n選好喜歡的餐點，剩下交給邱媽媽。' : '按下「開始使用」完成開通，\n就能線上點餐、查看訂單進度。', size: 'sm', color: '#66706A', wrap: true },
                    { type: 'separator', color: '#E8ECE9' },
                    { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
                        { type: 'text', text: ready ? '營業時間內接單' : '01 開通', size: 'xs', color: accent, weight: 'bold', flex: 1, wrap: true },
                        { type: 'text', text: ready ? '到店取餐' : '02 點餐', size: 'xs', color: '#66706A', flex: 1, wrap: true },
                        ...(ready ? [] : [{ type: 'text', text: '03 取餐', size: 'xs', color: '#66706A', flex: 1, wrap: true }])
                    ] }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', spacing: 'md', paddingTop: '0px', paddingBottom: '20px', paddingStart: '24px', paddingEnd: '24px', contents: [
                    { type: 'button', style: 'primary', height: 'md', color: accent,
                        action: ready ? { type: 'uri', label: '線上點餐', uri: liffUrl } : { type: 'message', label: START_TEXT, text: START_TEXT } },
                    { type: 'text', text: ready ? '餐點準備好，會再透過 LINE 通知您' : '點一下開通，開始享用家常美味', size: 'xxs', align: 'center', color: '#88918B', wrap: true }
                ]
            }
        }
    };
}

function startMessage(baseUrl) { return onboardingCard({ ready: false, baseUrl }); }

function readyMessage(liffUrl, baseUrl) { return onboardingCard({ ready: true, liffUrl, baseUrl }); }

function createWebhookHandler({ secret, readCustomers, writeCustomers, upsertCustomerProfile, reply, liffUrl, baseUrl }) {
    return async (req, res) => {
        if (!secret) return res.status(503).json({ message: '尚未設定 LINE_MESSAGING_CHANNEL_SECRET' });
        if (!validSignature(req.body, req.headers['x-line-signature'], secret)) {
            return res.status(401).json({ message: 'LINE webhook 簽章不正確' });
        }
        let events;
        try {
            events = JSON.parse(req.body.toString('utf8')).events;
            if (!Array.isArray(events)) throw new Error('Invalid events');
        } catch {
            return res.status(400).json({ message: 'Webhook 格式不正確' });
        }
        try {
            for (const event of events) {
                const userId = event.source?.type === 'user' && event.source.userId;
                if (!userId) continue;
                const text = event.type === 'message' && event.message?.type === 'text' ? String(event.message.text).trim() : '';
                if (!['follow', 'unfollow'].includes(event.type) && !text) continue;
                const customers = readCustomers();
                const customer = upsertCustomerProfile(customers, { lineUserId: userId });
                if (event.webhookEventId && customer.lastOnboardingEventId === event.webhookEventId) continue;
                if (event.type === 'unfollow') {
                    customer.lineStartedAt = '';
                    customer.lineBlockedAt = new Date(event.timestamp || Date.now()).toISOString();
                    writeCustomers(customers);
                    continue;
                }
                if (text === START_TEXT) {
                    customer.lineStartedAt = customer.lineStartedAt || new Date().toISOString();
                    customer.lineBlockedAt = '';
                    writeCustomers(customers);
                }
                const messages = text === START_TEXT || customer.lineStartedAt && text === '線上點餐'
                    ? [readyMessage(liffUrl, baseUrl)]
                    : !customer.lineStartedAt ? [startMessage(baseUrl)] : [];
                if (messages.length && event.replyToken) await reply(event.replyToken, messages);
                const latestCustomers = readCustomers();
                const latestCustomer = upsertCustomerProfile(latestCustomers, { lineUserId: userId });
                if (event.webhookEventId) latestCustomer.lastOnboardingEventId = event.webhookEventId;
                writeCustomers(latestCustomers);
            }
            res.json({ ok: true });
        } catch (error) {
            console.error('[LINE onboarding]', error.message);
            res.status(500).json({ message: 'LINE 開始使用處理失敗，請稍後重試' });
        }
    };
}

module.exports = { START_TEXT, validSignature, startMessage, readyMessage, createWebhookHandler };
