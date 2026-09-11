const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const webpush = require('web-push');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const { hydrateStateFiles, queueStateSync } = require('./supabase-state');
const { hydrateNormalizedStateFiles, queueNormalizedSync } = require('./supabase-normalized');
const {
    buildCustomersFromOrders,
    customerStatsForOrder,
    normalizePhone,
    safeCustomer,
    upsertCustomerProfile
} = require('./customer-utils');

const app = express();
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const STORE_FILE = path.join(__dirname, 'store-status.json');
const MENU_FILE = path.join(__dirname, 'menu.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const AUDIT_FILE = path.join(__dirname, 'audit-log.json');
const AUDIT_LIMIT = 500;
const UPLOAD_DIR = path.join(__dirname, 'images', 'uploads');
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const COUNTER_FILE = path.join(__dirname, 'order-counter.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const CUSTOMERS_FILE = path.join(__dirname, 'customers.json');
const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');
const PUSH_SUBS_FILE = path.join(__dirname, 'push-subscriptions.json');
const PRINT_QUEUE_FILE = path.join(__dirname, 'print-queue.json');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'UOk7R1DiDvRXXUxHwy/nDjspTVgC3ZzAYYRTWMO96rHgOycTbmPXUV/qtLwNa0r5+lCXvBGCcc3WHVHesgHxUd8gxwaoPMwaQuPuOT/PpzyCVMCgQdAboLV8waAZHmIXPRaeq6iMYHuECM+WY2jghQdB04t89/1O/w1cDnyilFU=';
const LINE_LOGIN_CHANNEL_ID = String(process.env.LINE_LOGIN_CHANNEL_ID || '2007831775').trim();
const LINE_LIFF_ID = String(process.env.LINE_LIFF_ID || '2007831775-ojeB1qbw').trim();
const adminSessions = new Map(); // token -> { username, role }
const lineCustomerSessions = new Map(); // LINE ID token -> { userId, displayName, expiresAt }

app.use(cors());
// 菜單照片是以 base64 夾在 JSON 裡上傳，所以要放寬預設的 100kb 上限
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '8mb' }));
// HTML 頁面（尤其是加到 iPhone 主畫面的後台）絕對不能被瀏覽器快取住舊版本，
// 這裡強制每次都要重新跟伺服器要最新內容；圖片/CSS/JS 這類靜態資源則維持原本的快取行為。
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
app.use(express.static(__dirname));

// ==========================================
// 🟢 LINE Pay 設定區
// ==========================================
const LINEPAY_CHANNEL_ID = '2008931183'; // 請確認這串數字是否正確
const LINEPAY_CHANNEL_SECRET = 'e461fe2765ab6bf8187dd0f76c54f27b'; // 請確認這串亂碼是否正確
const LINEPAY_SITE = 'https://sandbox-api-pay.line.me'; 
const LINEPAY_VERSION = '/v3/payments/request'; // Request API URI

// 出單先走店內電腦的系統列印佇列。Mac 配對藍牙印表機後，若已設成預設印表機，
// 不用設定 PRINTER_NAME；若有多台印表機，再用環境變數指定名稱。
const PRINTER_NAME = String(process.env.PRINTER_NAME || '').trim();
const PRINTER_RAW = process.env.PRINTER_RAW === 'true';
const AUTO_PRINT_ON_ACCEPT = process.env.AUTO_PRINT_ON_ACCEPT !== 'false';
const RECEIPT_WIDTH = 32; // 58mm 熱感紙使用一般字體時約 32 個半形字元

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
    queueStateSync(filePath, data);
    queueNormalizedSync(filePath, data);
}

function readOrders() {
    return readJsonFile(ORDERS_FILE, []);
}

// 測試訂單只是拿來驗證推播/聲音/滿版卡片，不該算進營業額、報表、排行榜
function readRealOrders() {
    return readOrders().filter(order => !order.isTest);
}

function writeOrders(orders) {
    writeJsonFile(ORDERS_FILE, orders);
    const savedCustomers = readJsonFile(CUSTOMERS_FILE, []);
    writeCustomers(buildCustomersFromOrders(orders, savedCustomers));
}

function readCustomers() {
    const customers = readJsonFile(CUSTOMERS_FILE, null);
    if (customers) return customers;

    const generated = buildCustomersFromOrders(readOrders());
    writeCustomers(generated);
    return generated;
}

function writeCustomers(customers) {
    writeJsonFile(CUSTOMERS_FILE, customers);
}

function decorateOrderCustomer(order, customers = readCustomers()) {
    return { ...order, ...customerStatsForOrder(order, customers) };
}

function decorateOrdersCustomer(orders) {
    const customers = readCustomers();
    return orders.map(order => decorateOrderCustomer(order, customers));
}

function readPrintJobs() {
    return readJsonFile(PRINT_QUEUE_FILE, []);
}

function writePrintJobs(jobs) {
    writeJsonFile(PRINT_QUEUE_FILE, jobs.slice(-200));
}

function charWidth(char) {
    return /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
}

function textWidth(text) {
    return [...String(text)].reduce((width, char) => width + charWidth(char), 0);
}

function wrapReceiptText(text, width = RECEIPT_WIDTH) {
    const result = [];
    let line = '';
    let lineWidth = 0;

    for (const char of String(text ?? '')) {
        if (char === '\n') {
            result.push(line);
            line = '';
            lineWidth = 0;
            continue;
        }
        const nextWidth = charWidth(char);
        if (line && lineWidth + nextWidth > width) {
            result.push(line);
            line = '';
            lineWidth = 0;
        }
        line += char;
        lineWidth += nextWidth;
    }

    if (line || !result.length) result.push(line);
    return result;
}

function centerReceiptText(text, width = RECEIPT_WIDTH) {
    const value = String(text);
    const padding = Math.max(0, Math.floor((width - textWidth(value)) / 2));
    return `${' '.repeat(padding)}${value}`;
}

function receiptColumns(left, right, width = RECEIPT_WIDTH) {
    const leftText = String(left);
    const rightText = String(right);
    const spaces = Math.max(1, width - textWidth(leftText) - textWidth(rightText));
    return `${leftText}${' '.repeat(spaces)}${rightText}`;
}

function formatReceiptTime(value) {
    return new Date(value || Date.now()).toLocaleString('zh-TW', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
}

// 把字元之間插入空白，讓訂單號碼在一堆等寬字裡跳出來
function spacedReceiptText(text) {
    return [...String(text)].join(' ');
}

function receiptSection(title) {
    return `【 ${title} 】`;
}

// 出單上不能出現 linepay_online 這種內部代號；線上付款還必須明確標示已付款，
// 否則店員看到單子會再跟客人收一次錢。
const PAYMENT_LABELS = {
    cash: { name: '現金', paid: false },
    linepay_online: { name: 'LINE Pay', paid: true },
    online_payment: { name: '線上付款', paid: true }
};

function paymentReceiptLabel(order) {
    const info = PAYMENT_LABELS[order.paymentMethod];
    if (!info) return String(order.paymentMethod || '未指定');
    return info.paid ? `${info.name}（已付款）` : `${info.name}（現場收款）`;
}

// 58mm 熱感紙只有 32 個半形字元、等寬字型，沒有粗體大小可用，
// 所以「美編」全靠分隔線層級（=／-）、置中、字距、全角空格對齊做出視覺層次。
// 刻意只用 ASCII 分隔線與中文字型必有的【】，避免某些出單機在 Big5 模式下
// 把 box-drawing 或特殊符號印成亂碼。
function receiptText(order, kind = 'accept') {
    const settings = readSettings();
    const thick = '='.repeat(RECEIPT_WIDTH);
    const thin = '-'.repeat(RECEIPT_WIDTH);

    const statusLabel = order.status === 'completed'
        ? '已完成'
        : order.status === 'cancelled' ? '已取消' : '製作中';
    const typeLabel = order.orderType === 'reserve' ? '預約單' : '即時單';

    const lines = [
        thick,
        centerReceiptText(settings.storeName || '邱媽媽美食'),
        centerReceiptText('外帶訂單'),
        thick
    ];

    // 測試單要放在最醒目的位置，否則廚房會照著做出一份不存在的餐
    if (order.isTest) {
        lines.push(
            '',
            centerReceiptText('*** 測 試 單 ***'),
            centerReceiptText('請勿製作、請勿出餐'),
            '',
            thin
        );
    }

    // 補印要標記，避免廚房把同一張單做兩次
    if (kind === 'reprint') {
        lines.push(centerReceiptText('※ 補 印 ※'), thin);
    }

    // 訂單號碼是廚房與取餐時最常掃的資訊，用字距拉開＋前後留白讓它最醒目
    lines.push(
        '',
        centerReceiptText('訂 單 號 碼'),
        centerReceiptText(spacedReceiptText(`#${order.orderNumber}`)),
        '',
        centerReceiptText(`${typeLabel}  ・  ${statusLabel}`),
        ''
    );

    // 取餐資訊：標籤一律補成 8 半形寬（4 個全角字），值才會對齊成整齊一欄
    const infoRows = [
        ['取餐時間', order.pickupTime || '未指定'],
        ['姓　　名', order.name || ''],
        ['電　　話', order.phone || ''],
        ['付款方式', paymentReceiptLabel(order)],
        ['下單時間', formatReceiptTime(order.createdAt)]
    ];

    lines.push(thick, receiptSection('取餐資訊'));
    infoRows.forEach(([label, value]) => {
        // 值太長就換行，續行縮排到與值同一欄，不要跑回最左邊
        const wrapped = wrapReceiptText(value, RECEIPT_WIDTH - 10);
        lines.push(` ${label} ${wrapped[0]}`);
        wrapped.slice(1).forEach(part => lines.push(`${' '.repeat(10)}${part}`));
    });

    lines.push(thin, receiptSection('餐點明細'), '');

    let totalQty = 0;
    (order.items || []).forEach((item, index) => {
        const qty = Number(item.qty || 0);
        const subtotal = Number(item.subtotal || 0);
        const unitPrice = qty > 0 ? Math.round(subtotal / qty) : subtotal;
        totalQty += qty;

        // 品名含加購選項時會很長，讓它獨佔整行，數量與金額另一行右對齊
        wrapReceiptText(`${String(index + 1).padStart(2, ' ')} ${item.name || '未命名商品'}`, RECEIPT_WIDTH)
            .forEach((part, partIndex) => lines.push(partIndex === 0 ? part : `    ${part}`));

        lines.push(receiptColumns(`    x${qty}  @$${unitPrice}`, `$${subtotal}`, RECEIPT_WIDTH - 1));
        lines.push('');
    });

    // 打包時可以用這行快速核對有沒有漏東西
    lines.push(
        thin,
        receiptColumns(` 共 ${(order.items || []).length} 項`, `合計 ${totalQty} 份`, RECEIPT_WIDTH - 1),
        thick,
        receiptColumns(' 應付金額', `$${Number(order.totalAmount || 0)}`, RECEIPT_WIDTH - 1),
        thick
    );

    // 交餐當下最容易出錯的就是「該收沒收」或「收兩次」，所以直接寫清楚
    const payment = PAYMENT_LABELS[order.paymentMethod];
    if (payment && payment.paid) {
        lines.push(centerReceiptText('*** 已付款・請勿收款 ***'), thick);
    } else {
        lines.push(centerReceiptText(`*** 請收現金 $${Number(order.totalAmount || 0)} ***`), thick);
    }

    if (order.notes) {
        lines.push(receiptSection('客人備註'));
        wrapReceiptText(order.notes, RECEIPT_WIDTH - 2).forEach(part => lines.push(` ${part}`));
        lines.push(thin);
    }

    // 客人拿到收據要找得到店家；出單時間可以分辨原始單與補印
    if (settings.phone) lines.push(centerReceiptText(`電話 ${settings.phone}`));
    if (settings.address) {
        wrapReceiptText(settings.address).forEach(part => lines.push(centerReceiptText(part)));
    }
    lines.push(
        centerReceiptText(`出單 ${formatReceiptTime()}`),
        '',
        centerReceiptText('謝謝您的訂購'),
        thick,
        '',
        ''
    );

    return `${lines.join('\n')}\n\f`;
}

function updatePrintJob(jobId, changes) {
    const jobs = readPrintJobs();
    const job = jobs.find(entry => entry.id === jobId);
    if (!job) return null;
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    writePrintJobs(jobs);
    return job;
}

function sendToSystemPrinter(job, order) {
    return new Promise(resolve => {
        if (!['darwin', 'linux'].includes(process.platform)) {
            resolve({ status: 'waiting_printer', message: '目前先支援 Mac/Linux 系統列印，Windows 出單橋接程式稍後接上' });
            return;
        }

        const args = [];
        if (PRINTER_NAME) args.push('-d', PRINTER_NAME);
        if (PRINTER_RAW) args.push('-o', 'raw');
        args.push('-');

        const printer = spawn('lp', args);
        let stderr = '';
        printer.stderr.on('data', chunk => { stderr += chunk.toString(); });
        printer.on('error', error => resolve({ status: 'failed', message: error.message }));
        printer.on('close', code => {
            if (code === 0) {
                resolve({ status: 'printed', message: PRINTER_NAME ? `已送到 ${PRINTER_NAME}` : '已送到預設印表機' });
            } else {
                resolve({ status: 'failed', message: stderr.trim() || `lp 結束碼 ${code}` });
            }
        });
        printer.stdin.end(receiptText(order, job && job.kind), 'utf8');
    });
}

async function processPrintJob(job, order) {
    updatePrintJob(job.id, { status: 'printing', attempts: Number(job.attempts || 0) + 1 });
    const result = await sendToSystemPrinter(job, order);
    updatePrintJob(job.id, { status: result.status, message: result.message, printedAt: result.status === 'printed' ? new Date().toISOString() : undefined });
    return { ...result, jobId: job.id };
}

async function queueOrderPrint(order, kind = 'accept') {
    const jobs = readPrintJobs();
    if (kind === 'accept') {
        const existing = jobs.find(job => job.orderId === String(order.id) && job.kind === 'accept');
        if (existing) return { status: existing.status, message: '這張訂單已建立過出單工作', jobId: existing.id, duplicate: true };
    }

    const job = {
        id: uuidv4(),
        orderId: String(order.id),
        orderNumber: String(order.orderNumber || ''),
        kind,
        status: AUTO_PRINT_ON_ACCEPT ? 'queued' : 'disabled',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    jobs.push(job);
    writePrintJobs(jobs);

    if (!AUTO_PRINT_ON_ACCEPT) return { status: 'disabled', message: '自動列印已關閉', jobId: job.id };
    return processPrintJob(job, order);
}

const DEFAULT_SETTINGS = {
    isOpen: true,
    storeName: '邱媽媽美食',
    phone: '',
    address: '桃園市大園區皇家六街12號',
    businessHours: {
        lunch: { enabled: true, start: '10:30', end: '14:00' },
        dinner: { enabled: true, start: '16:00', end: '20:00' }
    },
    prepTimeMinutes: 15,
    minOrderAmount: 0,
    allowReserveOrders: true,
    optionPrices: { large: 20, doubleEgg: 15, doubleShrimp: 35 },
    optionLabels: { large: '加大', doubleEgg: '雙蛋', doubleShrimp: '加蝦' },
    alerts: {
        // 新訂單未接單時的提醒行為
        takeoverEnabled: true,        // 後台跳出滿版接單卡片
        soundRepeatSeconds: 3,        // 頁面在前景時，警報聲每幾秒重響
        pushRepeatEnabled: true,      // 未接單時持續重送推播
        pushRepeatSeconds: 3,         // 推播重送間隔
        pushRepeatMaxMinutes: 10      // 重送上限，避免無限轟炸
    },
    updatedAt: new Date().toISOString()
};

function readSettings() {
    const settings = readJsonFile(SETTINGS_FILE, null);

    if (!settings) {
        // 舊版只有 store-status.json，把上線狀態接過來後改用 settings.json 當單一來源。
        const legacyStatus = readJsonFile(STORE_FILE, null);
        const migrated = {
            ...DEFAULT_SETTINGS,
            isOpen: legacyStatus ? Boolean(legacyStatus.isOpen) : DEFAULT_SETTINGS.isOpen
        };
        writeJsonFile(SETTINGS_FILE, migrated);
        return migrated;
    }

    return {
        ...DEFAULT_SETTINGS,
        ...settings,
        alerts: { ...DEFAULT_SETTINGS.alerts, ...(settings.alerts || {}) }
    };
}

function writeSettings(settings) {
    writeJsonFile(SETTINGS_FILE, settings);
    // 保留 store-status.json，讓仍在讀舊檔的流程不會壞掉。
    writeJsonFile(STORE_FILE, { isOpen: settings.isOpen, updatedAt: settings.updatedAt });
}

function readStoreStatus() {
    const settings = readSettings();
    return { isOpen: settings.isOpen, updatedAt: settings.updatedAt };
}

function writeStoreStatus(status) {
    const settings = readSettings();
    settings.isOpen = Boolean(status.isOpen);
    settings.updatedAt = status.updatedAt || new Date().toISOString();
    writeSettings(settings);
}

function timeToMinutes(value) {
    const [hour, minute] = String(value || '').split(':').map(Number);
    return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function businessWindowsFromSettings(settings) {
    const hours = settings && settings.businessHours;
    if (!hours) return [];
    return ['lunch', 'dinner']
        .map(slot => hours[slot])
        .filter(slot => slot && slot.enabled)
        .map(slot => ({ start: timeToMinutes(slot.start), end: timeToMinutes(slot.end) }))
        .filter(slot => slot.end > slot.start);
}

function isBusinessHoursOpen(settings, at = new Date()) {
    const minutes = at.getHours() * 60 + at.getMinutes();
    return businessWindowsFromSettings(settings).some(window => minutes >= window.start && minutes < window.end);
}

function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readMenu() {
    const menu = readJsonFile(MENU_FILE, { categories: [], items: [] });
    const today = todayKey();
    let changed = false;

    // 每日限量：跨日就把當日已售數量歸零，並自動解除「賣完」狀態。
    menu.items = (menu.items || []).map(item => {
        if (item.stockDate !== today) {
            changed = true;
            return {
                ...item,
                stockDate: today,
                soldToday: 0,
                soldOut: item.dailyStock ? false : item.soldOut
            };
        }
        return item;
    });

    if (changed) writeJsonFile(MENU_FILE, menu);
    return menu;
}

function writeMenu(menu) {
    writeJsonFile(MENU_FILE, menu);
}

function isItemOrderable(item) {
    if (item.status !== 'available') return false;
    if (item.soldOut) return false;
    if (item.dailyStock && Number(item.soldToday || 0) >= Number(item.dailyStock)) return false;
    return true;
}

function readAuditLog() {
    return readJsonFile(AUDIT_FILE, []);
}

function logAudit(action, target, detail, user) {
    const entries = readAuditLog();
    entries.unshift({
        id: uuidv4(),
        at: new Date().toISOString(),
        user: user || 'system',
        action,
        target: String(target || ''),
        detail: String(detail || '')
    });
    writeJsonFile(AUDIT_FILE, entries.slice(0, AUDIT_LIMIT));
}

// ==========================================
// 🟢 每日流水號
// ==========================================
// 店家要的是好記好管理的 1、2、3、4，每天 00:00 重新從 1 開始。
// 但流水號每天重複，不能拿來當訂單的唯一鍵，所以另外用 `id`（日期-序號）當主鍵。
function nextOrderSequence() {
    const today = todayKey();
    const counter = readJsonFile(COUNTER_FILE, { date: '', seq: 0 });

    const seq = counter.date === today ? Number(counter.seq || 0) + 1 : 1;
    writeJsonFile(COUNTER_FILE, { date: today, seq });

    return { seq, date: today };
}

function nextTestSequence() {
    const today = todayKey();
    const counter = readJsonFile(COUNTER_FILE, { date: '', seq: 0, testDate: '', testSeq: 0 });

    const testSeq = counter.testDate === today ? Number(counter.testSeq || 0) + 1 : 1;
    writeJsonFile(COUNTER_FILE, { ...counter, testDate: today, testSeq });

    return { seq: testSeq, date: today };
}

// 舊訂單的 id 就是隨機碼，新訂單是「日期-序號」，兩種都要找得到
function findOrder(orders, key) {
    const target = String(key);
    return orders.find(order => String(order.id) === target)
        || orders.find(order => String(order.orderNumber) === target);
}

// ==========================================
// 🟢 帳號管理
// ==========================================
function hashPassword(password, salt) {
    const useSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
    return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(String(expectedHash || ''), 'hex');
    // 長度不同時 timingSafeEqual 會直接丟例外，先擋掉
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readUsers() {
    const users = readJsonFile(USERS_FILE, null);
    if (users && users.length) return users;

    // 第一次啟動：把原本寫死的 admin 帳密轉成正式帳號（密碼經過雜湊，不再明文比對）
    const { salt, hash } = hashPassword(ADMIN_PASSWORD);
    const seeded = [{
        username: ADMIN_USERNAME,
        salt,
        hash,
        role: 'owner',
        displayName: '店長',
        createdAt: new Date().toISOString()
    }];
    writeJsonFile(USERS_FILE, seeded);
    console.log(`[Auth] 已建立預設帳號 ${ADMIN_USERNAME}，請盡快到後台修改密碼`);
    return seeded;
}

function writeUsers(users) {
    writeJsonFile(USERS_FILE, users);
}

// owner 可以管理帳號，staff 只能接單
const ROLES = { owner: '店長（可管理帳號與設定）', staff: '員工（僅接單）' };

// ==========================================
// 🟢 Web Push（背景／鎖屏通知）
// ==========================================
// 手機瀏覽器切到背景或鎖屏後，頁面的 setInterval 會被凍結、AudioContext 會被暫停，
// 所以後台頁面自己的鈴聲在背景是完全靠不住的。唯一能在那些狀態把手機叫醒的機制
// 就是由伺服器主動發 Web Push，交給 Service Worker 顯示系統通知。
const vapid = readJsonFile(VAPID_FILE, null);
const pushEnabled = Boolean(vapid && vapid.publicKey && vapid.privateKey);

if (pushEnabled) {
    webpush.setVapidDetails(vapid.subject || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
} else {
    console.warn('[Push] 找不到 vapid-keys.json，背景推播功能停用');
}

function readPushSubscriptions() {
    const subscriptions = readJsonFile(PUSH_SUBS_FILE, []);

    // 舊資料沒有 id，補上後存回去，之後命名／指定測試裝置都用這個 id 定位
    let changed = false;
    subscriptions.forEach(entry => {
        if (!entry.id) {
            entry.id = uuidv4();
            changed = true;
        }
    });
    if (changed) writePushSubscriptions(subscriptions);

    return subscriptions;
}

function writePushSubscriptions(subscriptions) {
    writeJsonFile(PUSH_SUBS_FILE, subscriptions);
}

// 推播給所有已登記的裝置（或用 deviceIds 只推給指定的幾台）；
// 訂閱失效（410/404）就自動清掉，避免無效訂閱越積越多
async function sendPushToAll(payload, deviceIds) {
    const result = { at: new Date().toISOString(), sent: 0, failed: 0, removed: 0, reason: '' };

    if (!pushEnabled) {
        result.reason = '尚未設定 VAPID 金鑰';
        return result;
    }

    const all = readPushSubscriptions();
    const subscriptions = Array.isArray(deviceIds) && deviceIds.length
        ? all.filter(entry => deviceIds.includes(entry.id))
        : all;

    if (!subscriptions.length) {
        result.reason = all.length ? '指定的裝置找不到（可能已被移除）' : '還沒有裝置登記背景推播';
        return result;
    }

    const body = JSON.stringify(payload);
    const stale = [];

    await Promise.all(subscriptions.map(async entry => {
        try {
            await webpush.sendNotification(entry.subscription, body, { TTL: 600, urgency: 'high' });
            result.sent += 1;
        } catch (error) {
            result.failed += 1;
            const status = error.statusCode;
            if (status === 404 || status === 410) {
                stale.push(entry.endpoint);
            } else {
                console.error('[Push] 發送失敗:', status, error.body || error.message);
            }
        }
    }));

    if (stale.length) {
        writePushSubscriptions(all.filter(entry => !stale.includes(entry.endpoint)));
        result.removed = stale.length;
    }

    return result;
}

// ---------- 未接單時持續重送推播 ----------
// 一則通知很容易在忙碌時被滑掉，所以只要訂單還沒被接，就依設定的間隔一直重送，
// 直到店家接單／取消，或達到重送上限為止。
const pendingPushTimers = new Map();

function stopOrderReminder(orderId) {
    const timer = pendingPushTimers.get(String(orderId));
    if (!timer) return;
    clearInterval(timer.handle);
    pendingPushTimers.delete(String(orderId));
}

function orderPushPayload(order, round) {
    const typeLabel = order.orderType === 'reserve' ? '預約單' : '即時單';
    return {
        title: round > 0 ? `尚未接單 #${order.orderNumber}（第 ${round + 1} 次提醒）` : `新訂單 #${order.orderNumber}`,
        body: `${typeLabel}　${order.name}　${order.items.length} 項　共 $${order.totalAmount}`,
        tag: `order-${order.id}`,
        url: '/merchant.html?view=orders&status=pending',
        orderId: order.id
    };
}

function startOrderReminder(order) {
    const settings = readSettings();
    const alerts = settings.alerts || {};
    // 測試訂單可以指定只推給某台裝置（例如只想吵自己的手機）；一般訂單一律推全部
    const deviceIds = Array.isArray(order.pushDeviceIds) && order.pushDeviceIds.length ? order.pushDeviceIds : undefined;

    sendPushToAll(orderPushPayload(order, 0), deviceIds)
        .then(result => logPushResult(order, result))
        .catch(error => console.error('[Push] 通知失敗:', error.message));

    if (!alerts.pushRepeatEnabled) return;

    const intervalMs = Math.max(3, Number(alerts.pushRepeatSeconds) || 3) * 1000;
    const maxMs = Math.max(1, Number(alerts.pushRepeatMaxMinutes) || 10) * 60 * 1000;
    const maxRounds = Math.floor(maxMs / intervalMs);

    stopOrderReminder(order.id);
    let round = 0;

    const handle = setInterval(() => {
        round += 1;

        // 每次重送前都重新讀檔確認狀態，店家在別台裝置接單也要能停下來
        const current = findOrder(readOrders(), order.id);
        if (!current || current.status !== 'pending') {
            console.log(`[Push] #${order.orderNumber} 已處理，停止提醒`);
            stopOrderReminder(order.id);
            return;
        }

        if (round > maxRounds) {
            console.warn(`[Push] #${order.orderNumber} 已提醒 ${maxRounds} 次仍未接單，停止重送`);
            stopOrderReminder(order.id);
            return;
        }

        sendPushToAll(orderPushPayload(current, round), deviceIds)
            .catch(error => console.error('[Push] 重送失敗:', error.message));
    }, intervalMs);

    pendingPushTimers.set(String(order.id), { handle, startedAt: Date.now() });
}

function logPushResult(order, result) {
    // 每一種結果都要留下紀錄：推播是店家唯一的漏單防線，靜默失敗最危險
    const parts = [`成功 ${result.sent}`];
    if (result.failed) parts.push(`失敗 ${result.failed}`);
    if (result.removed) parts.push(`清除失效訂閱 ${result.removed}`);
    if (result.reason) parts.push(result.reason);

    const summary = `[Push] 新訂單 #${order.orderNumber} → ${parts.join('、')}`;
    if (result.sent) console.log(summary);
    else console.warn(`${summary}（沒有任何裝置收到通知）`);
}

// 伺服器重啟後，記憶體裡的計時器會全部消失，要幫還沒接的單重新掛上提醒
function rearmPendingReminders() {
    const pending = readOrders().filter(order => order.status === 'pending');
    pending.forEach(order => startOrderReminder(order));
    if (pending.length) console.log(`[Push] 重啟後重新掛上 ${pending.length} 筆未接單的提醒`);
}

function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const session = adminSessions.get(token);

    if (!session) {
        return res.status(401).json({ message: '請先登入 admin' });
    }

    req.session = session;
    next();
}

// 帳號管理、門店設定這類設定面的操作只開放給店長
function requireOwner(req, res, next) {
    if (!req.session || req.session.role !== 'owner') {
        return res.status(403).json({ message: '只有店長可以執行這個操作' });
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

function getStatusLabel(status) {
    const labels = { pending: '待接單', preparing: '製作中', completed: '已完成', cancelled: '已取消' };
    return labels[status] || status;
}

function getStatusMessage(status) {
    if (status === 'preparing') return '店家已接單，正在製作您的餐點。';
    if (status === 'completed') return '您的訂單已備妥，可以來取餐了。';
    if (status === 'cancelled') return '店家已拒絕訂單，如有疑問請直接聯絡店家。';
    return '';
}

async function pushLineMessages(lineUserId, messages) {
    const result = {
        at: new Date().toISOString(),
        sent: false,
        reason: ''
    };

    if (!lineUserId) {
        result.reason = '訂單沒有 LINE userId';
        return result;
    }

    if (!LINE_CHANNEL_ACCESS_TOKEN) {
        result.reason = '尚未設定 LINE_CHANNEL_ACCESS_TOKEN';
        return result;
    }

    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages
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

async function verifyLineCustomer(req, res, next) {
    const authorization = String(req.headers.authorization || '');
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

    if (!idToken) {
        return res.status(401).json({ message: '請先使用 LINE 登入' });
    }

    const cached = lineCustomerSessions.get(idToken);
    if (cached && cached.expiresAt > Date.now()) {
        req.lineCustomer = { userId: cached.userId, displayName: cached.displayName };
        next();
        return;
    }

    try {
        const params = new URLSearchParams({
            id_token: idToken,
            client_id: LINE_LOGIN_CHANNEL_ID
        });
        const response = await axios.post('https://api.line.me/oauth2/v2.1/verify', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });

        if (!response.data || !response.data.sub) {
            return res.status(401).json({ message: 'LINE 登入資料無效，請重新登入' });
        }

        req.lineCustomer = {
            userId: String(response.data.sub),
            displayName: String(response.data.name || '')
        };
        const tokenExpiresAt = Number(response.data.exp || 0) * 1000;
        lineCustomerSessions.set(idToken, {
            ...req.lineCustomer,
            expiresAt: tokenExpiresAt > Date.now() ? tokenExpiresAt : Date.now() + 5 * 60 * 1000
        });
        if (lineCustomerSessions.size > 500) {
            for (const [token, session] of lineCustomerSessions) {
                if (session.expiresAt <= Date.now()) lineCustomerSessions.delete(token);
            }
            while (lineCustomerSessions.size > 500) {
                lineCustomerSessions.delete(lineCustomerSessions.keys().next().value);
            }
        }
        next();
    } catch (error) {
        const isRejectedToken = Boolean(error.response && error.response.status >= 400 && error.response.status < 500);
        console.error('[LINE Login] ID token 驗證失敗:', error.response?.data?.error_description || error.message);
        res.status(isRejectedToken ? 401 : 502).json({
            message: isRejectedToken ? 'LINE 登入已失效，請重新開啟頁面' : '暫時無法驗證 LINE 登入，請稍後再試'
        });
    }
}

function customerOrderView(order) {
    return {
        id: String(order.id || ''),
        orderNumber: String(order.orderNumber || ''),
        orderDate: String(order.orderDate || ''),
        orderType: order.orderType === 'reserve' ? 'reserve' : 'instant',
        pickupTime: String(order.pickupTime || ''),
        paymentMethod: String(order.paymentMethod || 'cash'),
        notes: String(order.notes || ''),
        items: Array.isArray(order.items) ? order.items.map(item => ({
            key: String(item.key || ''),
            name: String(item.name || ''),
            qty: Number(item.qty || 0),
            price: Number(item.price || 0),
            subtotal: Number(item.subtotal || 0)
        })) : [],
        totalAmount: Number(order.totalAmount || 0),
        status: String(order.status || 'pending'),
        statusHistory: Array.isArray(order.statusHistory) ? order.statusHistory.map(entry => ({
            status: String(entry.status || ''),
            note: String(entry.note || ''),
            at: String(entry.at || '')
        })) : [],
        createdAt: String(order.createdAt || ''),
        updatedAt: String(order.updatedAt || ''),
        completedAt: String(order.completedAt || ''),
        cancelledAt: String(order.cancelledAt || '')
    };
}

function orderBelongsToCustomer(order, customer) {
    if (customer.lineUserId && order.lineUserId === customer.lineUserId) return true;
    const customerPhone = normalizePhone(customer.phone);
    return Boolean(customerPhone && customerPhone === normalizePhone(order.phone));
}

function orderDetailUrl(order) {
    return `https://liff.line.me/${LINE_LIFF_ID}/order-detail.html?order=${encodeURIComponent(String(order.id || ''))}`;
}

async function notifyCustomer(order, message) {
    if (!message) {
        return { at: new Date().toISOString(), message, sent: false, reason: '沒有通知內容' };
    }

    const result = await pushLineMessages(order.lineUserId, [
        { type: 'text', text: `邱媽媽美食通知\n訂單 #${order.orderNumber}\n${message}` }
    ]);

    return { ...result, message };
}

function buildOrderFlexMessage(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const totalQty = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
    const itemSummary = items.slice(0, 2).map(item => `${item.name} x${item.qty}`).join('、');
    const remainingCount = Math.max(0, items.length - 2);

    return {
        type: 'flex',
        altText: `訂單 #${order.orderNumber}｜總金額 $${order.totalAmount}｜等待店家接單`,
        contents: {
            type: 'bubble',
            header: {
                type: 'box',
                layout: 'horizontal',
                backgroundColor: '#FFF4F2',
                paddingAll: '14px',
                contents: [
                    { type: 'text', text: '邱媽媽美食', color: '#222222', weight: 'bold', size: 'md', flex: 7 },
                    { type: 'text', text: '等待接單', color: '#D94F4F', weight: 'bold', size: 'sm', align: 'end', flex: 5 }
                ]
            },
            body: {
                type: 'box',
                layout: 'vertical',
                paddingAll: '18px',
                contents: [
                    { type: 'text', text: '訂單編號', size: 'xs', color: '#777777' },
                    { type: 'text', text: `#${order.orderNumber}`, size: 'xxl', weight: 'bold', color: '#202020', margin: 'xs' },
                    { type: 'separator', margin: 'lg', color: '#EEEEEE' },
                    {
                        type: 'box', layout: 'horizontal', margin: 'lg', alignItems: 'flex-end', contents: [
                            { type: 'text', text: `${items.length} 項／${totalQty} 份`, size: 'sm', color: '#666666', flex: 5 },
                            { type: 'text', text: `$${order.totalAmount}`, size: 'xxl', weight: 'bold', color: '#D94F4F', align: 'end', flex: 7 }
                        ]
                    },
                    { type: 'text', text: itemSummary + (remainingCount ? `，另 ${remainingCount} 項` : ''), size: 'sm', color: '#444444', wrap: true, margin: 'lg', maxLines: 2 },
                    { type: 'text', text: order.pickupTime || '取餐時間待確認', size: 'sm', color: '#777777', margin: 'md', wrap: true }
                ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                paddingAll: '14px',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        color: '#D94F4F',
                        height: 'sm',
                        action: { type: 'uri', label: '查看訂單狀態', uri: orderDetailUrl(order) }
                    }
                ]
            }
        }
    };
}

async function pushOrderCard(order) {
    const result = await pushLineMessages(order.lineUserId, [buildOrderFlexMessage(order)]);
    return { ...result, message: '訂單卡片' };
}

function menuItemIdFromOrderItem(orderItem, menuItems) {
    const idFromKey = parseInt(String(orderItem.key || '').split('-')[0], 10);
    if (Number.isInteger(idFromKey) && menuItems.some(item => item.id === idFromKey)) {
        return idFromKey;
    }

    // 舊訂單可能沒有 key，退而用品項名稱開頭比對（名稱後面會帶「(加大、雙蛋)」）。
    const matched = menuItems.find(item => String(orderItem.name || '').startsWith(item.name));
    return matched ? matched.id : null;
}

// 訂單成立時累加當日已售數量，達到每日限量就自動標示賣完。
function applyStockForOrder(order) {
    const menu = readMenu();
    const soldOutNames = [];
    let changed = false;

    (order.items || []).forEach(orderItem => {
        const id = menuItemIdFromOrderItem(orderItem, menu.items);
        if (id === null) return;

        const item = menu.items.find(entry => entry.id === id);
        if (!item) return;

        item.soldToday = Number(item.soldToday || 0) + Number(orderItem.qty || 0);
        changed = true;

        if (item.dailyStock && item.soldToday >= Number(item.dailyStock) && !item.soldOut) {
            item.soldOut = true;
            soldOutNames.push(item.name);
        }
    });

    if (changed) writeMenu(menu);
    if (soldOutNames.length) {
        logAudit('stock.auto_sold_out', soldOutNames.join('、'), `達每日限量，訂單 #${order.orderNumber} 後自動標示賣完`, '系統');
    }
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
        // 編號留空，等確認是新訂單才配號 —— 重送同一張單不該吃掉一個流水號
        id: '',
        orderNumber: '',
        orderDate: '',
        clientRef: String(body.orderNumber || '').trim(), // 前端產的隨機碼，用來去重
        orderType: body.orderType === 'reserve' ? 'reserve' : 'instant',
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
    const password = String(req.body.password || '');

    const user = readUsers().find(entry => entry.username === username);

    if (!user || !verifyPassword(password, user.salt, user.hash)) {
        return res.status(401).json({ message: '帳號或密碼錯誤' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, { username: user.username, role: user.role, at: new Date().toISOString() });
    res.json({ ok: true, token, username: user.username, role: user.role, displayName: user.displayName || user.username });
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

// LINE 使用者開啟點餐頁就先登記成會員；尚未下單也會出現在後台會員名單。
app.post('/api/customers/register', (req, res) => {
    const profile = {
        lineUserId: String(req.body.lineUserId || '').trim(),
        displayName: String(req.body.displayName || '').trim(),
        name: String(req.body.name || '').trim(),
        phone: String(req.body.phone || '').trim()
    };
    if (!profile.lineUserId && !profile.phone) {
        return res.status(400).json({ message: '缺少會員識別資料' });
    }

    const customers = readCustomers();
    const customer = upsertCustomerProfile(customers, profile);
    writeCustomers(customers);
    res.json({ ok: true, memberId: customer && customer.id });
});

app.post('/api/customer/orders/history', verifyLineCustomer, (req, res) => {
    const orders = readRealOrders()
        .filter(order => order.lineUserId === req.lineCustomer.userId)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .map(customerOrderView);

    res.json({
        customer: { displayName: req.lineCustomer.displayName },
        orders
    });
});

app.post('/api/customer/orders/:orderId/reorder-preview', verifyLineCustomer, (req, res) => {
    const order = findOrder(readRealOrders(), req.params.orderId);
    if (!order || order.lineUserId !== req.lineCustomer.userId) {
        return res.status(404).json({ message: '找不到這筆訂單' });
    }

    const menu = readMenu();
    const settings = readSettings();
    const cart = {};
    const unavailable = [];
    const adjustments = [];

    (order.items || []).forEach(orderItem => {
        const menuId = menuItemIdFromOrderItem(orderItem, menu.items);
        const menuItem = menuId === null ? null : menu.items.find(item => item.id === menuId);
        const oldName = String(orderItem.name || '原訂單商品');

        if (!menuItem) {
            unavailable.push({ name: oldName, reason: '商品已刪除' });
            return;
        }
        if (menuItem.status !== 'available') {
            unavailable.push({ name: oldName, reason: '商品已下架' });
            return;
        }
        if (!isItemOrderable(menuItem)) {
            unavailable.push({ name: oldName, reason: '商品目前已售完' });
            return;
        }

        const tokens = String(orderItem.key || '').split('-').slice(1);
        const selectedOptions = [
            { token: 'large', key: 'large', label: '加大' },
            { token: 'egg', key: 'doubleEgg', label: '雙蛋' },
            { token: 'shrimp', key: 'doubleShrimp', label: '加蝦' }
        ].filter(option => tokens.includes(option.token));
        const disabledOption = selectedOptions.find(option => !menuItem.options?.[option.key]);

        if (disabledOption) {
            unavailable.push({ name: oldName, reason: `${disabledOption.label}加購目前未供應` });
            return;
        }

        const requestedQty = Math.max(1, Number(orderItem.qty || 1));
        const remaining = menuItem.dailyStock
            ? Math.max(0, Number(menuItem.dailyStock) - Number(menuItem.soldToday || 0))
            : requestedQty;
        const qty = Math.min(requestedQty, remaining);

        if (qty <= 0) {
            unavailable.push({ name: oldName, reason: '商品目前已售完' });
            return;
        }
        if (qty < requestedQty) {
            adjustments.push({ name: menuItem.name, message: `庫存只剩 ${qty} 份，數量已調整` });
        }

        const optionKey = selectedOptions.map(option => option.token).join('-');
        const key = optionKey ? `${menuItem.id}-${optionKey}` : `${menuItem.id}-normal`;
        cart[key] = Number(cart[key] || 0) + qty;

        const currentPrice = Number(menuItem.price || 0) + selectedOptions.reduce(
            (sum, option) => sum + Number(settings.optionPrices?.[option.key] || 0),
            0
        );
        if (Number(orderItem.price || 0) !== currentPrice) {
            adjustments.push({ name: menuItem.name, message: `價格已更新為 $${currentPrice}` });
        }
    });

    res.json({
        sourceOrderId: order.id,
        cart,
        notes: String(order.notes || ''),
        unavailable,
        adjustments,
        availableCount: Object.keys(cart).length
    });
});

app.post('/api/orders', async (req, res) => {
    const settings = readSettings();
    const storeStatus = { isOpen: settings.isOpen, updatedAt: settings.updatedAt };

    if (!storeStatus.isOpen) {
        return res.status(403).json({ message: '店家目前未開放點餐' });
    }

    if (!isBusinessHoursOpen(settings)) {
        return res.status(403).json({ message: '目前非營業時間，暫停接單' });
    }

    const order = normalizeOrder(req.body);

    if (order.orderType === 'reserve' && !settings.allowReserveOrders) {
        return res.status(400).json({ message: '目前未開放預約單，請改用即時單' });
    }

    if (!order.name || !order.phone || order.items.length === 0 || order.totalAmount <= 0) {
        return res.status(400).json({ message: '訂單資料不完整' });
    }

    const minOrderAmount = Number(settings.minOrderAmount || 0);
    if (minOrderAmount > 0 && order.totalAmount < minOrderAmount) {
        return res.status(400).json({
            code: 'MIN_ORDER_NOT_MET',
            message: `最低消費為 $${minOrderAmount}，目前訂單金額為 $${order.totalAmount}，還差 $${minOrderAmount - order.totalAmount}`,
            minOrderAmount,
            totalAmount: order.totalAmount
        });
    }

    const orders = readOrders();
    // 用前端的隨機碼去重（例如網路重試重送同一張單），流水號每天重複不能當去重依據
    const existingIndex = order.clientRef
        ? orders.findIndex(item => item.clientRef && item.clientRef === order.clientRef)
        : -1;

    if (existingIndex >= 0) {
        orders[existingIndex] = {
            ...orders[existingIndex],
            ...order,
            // 沿用原本的編號，避免重送把流水號吃掉一個
            id: orders[existingIndex].id,
            orderNumber: orders[existingIndex].orderNumber,
            orderDate: orders[existingIndex].orderDate,
            status: orders[existingIndex].status || 'pending',
            createdAt: orders[existingIndex].createdAt,
            updatedAt: new Date().toISOString()
        };
        writeOrders(orders);
        return res.json({ ok: true, order: decorateOrderCustomer(orders[existingIndex]) });
    }

    // 到這裡才確定是全新的訂單，配一個當日流水號。
    // 顯示用的是每天從 1 重新開始的號碼；唯一鍵另外用「日期-序號」，
    // 否則今天的 #1 會跟昨天的 #1 撞在一起。
    let { seq, date } = nextOrderSequence();

    // 保險：萬一 order-counter.json 遺失或被還原，計數器會從 1 重來而撞到既有訂單，
    // 這裡往後找到第一個沒被用過的號碼，避免兩張單共用同一個 id。
    while (orders.some(item => item.id === `${date}-${seq}`)) {
        console.warn(`[Order] 編號 ${date}-${seq} 已存在，往後遞補`);
        ({ seq } = nextOrderSequence());
    }

    order.id = `${date}-${seq}`;
    order.orderNumber = String(seq);
    order.orderDate = date;

    orders.unshift(order);
    writeOrders(orders);
    applyStockForOrder(order);

    // LINE App 內建瀏覽器由前端以使用者身份把卡片送進官方帳號聊天室。
    // 外部瀏覽器無法呼叫 liff.sendMessages()，改由官方帳號推播同款卡片給客人。
    // 一定要等正式流水號與 id 建立後再送，卡片連結才能精準開到這筆訂單。
    if (!req.body.isInClient) {
        const cardNotification = await pushOrderCard(order);
        order.customerNotifications.push(cardNotification);
        writeOrders(orders);
    }

    // 通知店家：手機切到背景或鎖屏時，後台頁面的鈴聲不會響，只有這個推播叫得動手機。
    // 未接單會依設定持續重送，直到接單或達重送上限。
    startOrderReminder(order);

    res.status(201).json({ ok: true, order: decorateOrderCustomer(order) });
});

app.get('/api/orders', requireAdmin, (req, res) => {
    const status = req.query.status;
    let orders = readOrders();

    if (status && status !== 'all') {
        const statuses = String(status).split(',').map(item => item.trim());
        orders = orders.filter(order => statuses.includes(order.status));
    }

    const search = String(req.query.search || '').trim().toLowerCase();
    if (search) {
        orders = orders.filter(order => [order.orderNumber, order.name, order.phone]
            .some(field => String(field || '').toLowerCase().includes(search)));
    }

    if (req.query.from) {
        const from = startOfDay(new Date(req.query.from));
        orders = orders.filter(order => getOrderDate(order) >= from);
    }

    if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        orders = orders.filter(order => getOrderDate(order) <= to);
    }

    res.json({ orders: decorateOrdersCustomer(orders) });
});

app.get('/api/admin/customers', requireAdmin, (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    let customers = readCustomers().map(safeCustomer);

    if (search) {
        customers = customers.filter(customer => [customer.name, customer.displayName, customer.phone]
            .some(value => String(value || '').toLowerCase().includes(search)));
    }

    res.json({ customers });
});

app.get('/api/admin/customers/:customerId/orders', requireAdmin, (req, res) => {
    const customer = readCustomers().find(entry => entry.id === req.params.customerId);
    if (!customer) return res.status(404).json({ message: '找不到會員' });

    const orders = readRealOrders()
        .filter(order => orderBelongsToCustomer(order, customer))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .map(customerOrderView);

    res.json({ customer: safeCustomer(customer), orders });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    res.json({ summary: summarizeRevenue(readRealOrders()) });
});

// ==========================================
// 🟢 菜單 API
// ==========================================

// 前台用：只回傳可販售的品項
app.get('/api/menu', (req, res) => {
    const menu = readMenu();
    const settings = readSettings();

    const items = menu.items
        .filter(item => item.status === 'available')
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
        .map(item => ({
            id: item.id,
            name: item.name,
            price: item.price,
            image: item.image,
            description: item.description || '',
            category: item.category,
            options: item.options || {},
            soldOut: !isItemOrderable(item)
        }));

    res.json({
        items,
        categories: [...menu.categories].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0)),
        optionPrices: settings.optionPrices,
        optionLabels: settings.optionLabels
    });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => {
    const menu = readMenu();
    const items = [...menu.items].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    res.json({ items, categories: menu.categories });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
    const menu = readMenu();
    const name = String(req.body.name || '').trim();
    const price = Number(req.body.price);

    if (!name || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ message: '品名與價格為必填' });
    }

    const nextId = menu.items.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1;
    const nextSort = menu.items.reduce((max, item) => Math.max(max, Number(item.sortOrder || 0)), 0) + 1;

    const item = {
        id: nextId,
        name,
        price,
        image: String(req.body.image || '').trim(),
        description: String(req.body.description || '').trim(),
        category: String(req.body.category || 'rice').trim(),
        options: {
            large: Boolean(req.body.options && req.body.options.large),
            doubleEgg: Boolean(req.body.options && req.body.options.doubleEgg),
            doubleShrimp: Boolean(req.body.options && req.body.options.doubleShrimp)
        },
        status: req.body.status === 'hidden' ? 'hidden' : 'available',
        soldOut: false,
        dailyStock: req.body.dailyStock ? Number(req.body.dailyStock) : null,
        soldToday: 0,
        stockDate: todayKey(),
        sortOrder: nextSort
    };

    menu.items.push(item);
    writeMenu(menu);
    logAudit('menu.created', item.name, `新增商品，售價 $${item.price}`, req.session && req.session.username);
    res.status(201).json({ ok: true, item });
});

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
    const menu = readMenu();
    const item = menu.items.find(entry => entry.id === Number(req.params.id));

    if (!item) return res.status(404).json({ message: '找不到商品' });

    const changes = [];

    if (req.body.name !== undefined && String(req.body.name).trim() !== item.name) {
        changes.push(`品名 ${item.name} → ${String(req.body.name).trim()}`);
        item.name = String(req.body.name).trim();
    }

    if (req.body.price !== undefined && Number(req.body.price) !== item.price) {
        changes.push(`價格 $${item.price} → $${Number(req.body.price)}`);
        item.price = Number(req.body.price);
    }

    if (req.body.status !== undefined && req.body.status !== item.status) {
        changes.push(`狀態 ${item.status} → ${req.body.status}`);
        item.status = req.body.status === 'hidden' ? 'hidden' : 'available';
    }

    if (req.body.image !== undefined) item.image = String(req.body.image).trim();
    if (req.body.description !== undefined) item.description = String(req.body.description).trim();
    if (req.body.category !== undefined) item.category = String(req.body.category).trim();
    if (req.body.options !== undefined) {
        item.options = {
            large: Boolean(req.body.options.large),
            doubleEgg: Boolean(req.body.options.doubleEgg),
            doubleShrimp: Boolean(req.body.options.doubleShrimp)
        };
    }

    writeMenu(menu);
    if (changes.length) logAudit('menu.updated', item.name, changes.join('、'), req.session && req.session.username);
    res.json({ ok: true, item });
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
    const menu = readMenu();
    const index = menu.items.findIndex(entry => entry.id === Number(req.params.id));

    if (index < 0) return res.status(404).json({ message: '找不到商品' });

    const [removed] = menu.items.splice(index, 1);
    writeMenu(menu);
    logAudit('menu.deleted', removed.name, `刪除商品，原售價 $${removed.price}`, req.session && req.session.username);
    res.json({ ok: true });
});

// 菜單照片上傳：前端已先用 canvas 裁切成客人端顯示規格，這裡只負責存檔
app.post('/api/admin/menu/upload', requireAdmin, (req, res) => {
    const dataUrl = String(req.body.image || '');
    const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);

    if (!match) {
        return res.status(400).json({ message: '圖片格式不支援，請上傳 JPG、PNG 或 WebP' });
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) {
        return res.status(400).json({ message: '圖片內容是空的' });
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({ message: '圖片超過 3MB，請換一張' });
    }

    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const extension = match[1] === 'png' ? 'png' : match[1] === 'webp' ? 'webp' : 'jpg';
        const filename = `${todayKey()}-${uuidv4().slice(0, 8)}.${extension}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

        const relativePath = `images/uploads/${filename}`;
        logAudit('menu.image_uploaded', relativePath, `上傳菜單照片（${Math.round(buffer.length / 1024)} KB）`, req.session && req.session.username);
        res.status(201).json({ ok: true, path: relativePath });
    } catch (error) {
        console.error('[Upload] 儲存失敗:', error.message);
        res.status(500).json({ message: '圖片儲存失敗' });
    }
});

// ==========================================
// 🟢 庫存 API
// ==========================================
app.patch('/api/admin/menu/:id/stock', requireAdmin, (req, res) => {
    const menu = readMenu();
    const item = menu.items.find(entry => entry.id === Number(req.params.id));

    if (!item) return res.status(404).json({ message: '找不到商品' });

    const changes = [];

    if (req.body.soldOut !== undefined) {
        item.soldOut = Boolean(req.body.soldOut);
        changes.push(item.soldOut ? '標示為賣完' : '恢復供應');
    }

    if (req.body.dailyStock !== undefined) {
        const stock = req.body.dailyStock === null || req.body.dailyStock === '' ? null : Number(req.body.dailyStock);
        item.dailyStock = stock;
        changes.push(stock ? `每日限量設為 ${stock}` : '取消每日限量');
    }

    if (req.body.resetSold) {
        item.soldToday = 0;
        item.soldOut = false;
        changes.push('重設當日已售數量');
    }

    item.stockDate = todayKey();
    writeMenu(menu);
    if (changes.length) logAudit('stock.updated', item.name, changes.join('、'), req.session && req.session.username);
    res.json({ ok: true, item });
});

// ==========================================
// 🟢 門店設定 API
// ==========================================
app.get('/api/settings/public', (req, res) => {
    const settings = readSettings();
    res.json({
        isOpen: settings.isOpen,
        storeName: settings.storeName,
        address: settings.address,
        phone: settings.phone,
        businessHours: settings.businessHours,
        prepTimeMinutes: settings.prepTimeMinutes,
        minOrderAmount: settings.minOrderAmount,
        allowReserveOrders: settings.allowReserveOrders,
        optionPrices: settings.optionPrices,
        optionLabels: settings.optionLabels
    });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
    res.json({ settings: readSettings() });
});

app.patch('/api/admin/settings', requireAdmin, requireOwner, (req, res) => {
    const settings = readSettings();
    const changes = [];

    const scalarFields = ['storeName', 'phone', 'address'];
    scalarFields.forEach(field => {
        if (req.body[field] !== undefined && String(req.body[field]) !== settings[field]) {
            changes.push(`${field} → ${req.body[field]}`);
            settings[field] = String(req.body[field]);
        }
    });

    if (req.body.prepTimeMinutes !== undefined) {
        const value = Number(req.body.prepTimeMinutes);
        if (Number.isFinite(value) && value >= 0) {
            if (value !== settings.prepTimeMinutes) changes.push(`備餐時間 ${settings.prepTimeMinutes} → ${value} 分鐘`);
            settings.prepTimeMinutes = value;
        }
    }

    if (req.body.minOrderAmount !== undefined) {
        const value = Number(req.body.minOrderAmount);
        if (Number.isFinite(value) && value >= 0) {
            if (value !== settings.minOrderAmount) changes.push(`低消 $${settings.minOrderAmount} → $${value}`);
            settings.minOrderAmount = value;
        }
    }

    if (req.body.allowReserveOrders !== undefined) {
        const value = Boolean(req.body.allowReserveOrders);
        if (value !== settings.allowReserveOrders) changes.push(value ? '開啟預約單' : '關閉預約單');
        settings.allowReserveOrders = value;
    }

    if (req.body.businessHours) {
        settings.businessHours = {
            lunch: { ...settings.businessHours.lunch, ...(req.body.businessHours.lunch || {}) },
            dinner: { ...settings.businessHours.dinner, ...(req.body.businessHours.dinner || {}) }
        };
        changes.push('調整營業時間');
    }

    if (req.body.optionPrices) {
        const next = {
            large: Number(req.body.optionPrices.large ?? settings.optionPrices.large),
            doubleEgg: Number(req.body.optionPrices.doubleEgg ?? settings.optionPrices.doubleEgg),
            doubleShrimp: Number(req.body.optionPrices.doubleShrimp ?? settings.optionPrices.doubleShrimp)
        };
        if (JSON.stringify(next) !== JSON.stringify(settings.optionPrices)) changes.push('調整加購價格');
        settings.optionPrices = next;
    }

    if (req.body.isOpen !== undefined) {
        settings.isOpen = Boolean(req.body.isOpen);
        changes.push(settings.isOpen ? '店家上線' : '店家下線');
    }

    if (req.body.alerts) {
        const incoming = req.body.alerts;
        const next = { ...settings.alerts };

        if (incoming.takeoverEnabled !== undefined) next.takeoverEnabled = Boolean(incoming.takeoverEnabled);
        if (incoming.pushRepeatEnabled !== undefined) next.pushRepeatEnabled = Boolean(incoming.pushRepeatEnabled);

        // 間隔太短會被推播服務限流、也會把手機電池吃光，所以設下限
        if (incoming.soundRepeatSeconds !== undefined) {
            next.soundRepeatSeconds = Math.min(60, Math.max(2, Number(incoming.soundRepeatSeconds) || 3));
        }
        if (incoming.pushRepeatSeconds !== undefined) {
            next.pushRepeatSeconds = Math.min(300, Math.max(3, Number(incoming.pushRepeatSeconds) || 3));
        }
        if (incoming.pushRepeatMaxMinutes !== undefined) {
            next.pushRepeatMaxMinutes = Math.min(60, Math.max(1, Number(incoming.pushRepeatMaxMinutes) || 10));
        }

        if (JSON.stringify(next) !== JSON.stringify(settings.alerts)) changes.push('調整提醒設定');
        settings.alerts = next;
    }

    settings.updatedAt = new Date().toISOString();
    writeSettings(settings);
    if (changes.length) logAudit('settings.updated', '門店設定', changes.join('、'), req.session && req.session.username);
    res.json({ ok: true, settings });
});

// ==========================================
// 🟢 儀表板 / 報表 API
// ==========================================
function aggregateProducts(orders) {
    const map = new Map();

    orders.forEach(order => {
        (order.items || []).forEach(item => {
            const name = String(item.name || '未命名');
            const current = map.get(name) || { name, qty: 0, revenue: 0 };
            current.qty += Number(item.qty || 0);
            current.revenue += Number(item.subtotal || 0);
            map.set(name, current);
        });
    });

    return [...map.values()].sort((a, b) => b.qty - a.qty);
}

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
    const orders = readRealOrders();
    const menu = readMenu();
    const summary = summarizeRevenue(orders);
    const today = startOfDay(new Date());

    const todayOrders = orders.filter(order => getOrderDate(order) >= today);
    const completedToday = todayOrders.filter(order => order.status === 'completed');
    const cancelledToday = todayOrders.filter(order => order.status === 'cancelled');

    const statusCounts = orders.reduce((result, order) => {
        result[order.status] = (result[order.status] || 0) + 1;
        return result;
    }, {});

    // 近 7 日營業額趨勢（含今天）
    const trend = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
        const dayStart = startOfDay(new Date());
        dayStart.setDate(dayStart.getDate() - offset);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const dayOrders = orders.filter(order => {
            const date = getOrderDate(order);
            return order.status === 'completed' && date >= dayStart && date < dayEnd;
        });

        trend.push({
            date: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
            revenue: dayOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
            count: dayOrders.length
        });
    }

    const last30 = startOfDay(new Date());
    last30.setDate(last30.getDate() - 30);
    const topProducts = aggregateProducts(
        orders.filter(order => order.status === 'completed' && getOrderDate(order) >= last30)
    ).slice(0, 5);

    const stockAlerts = menu.items
        .filter(item => item.status === 'available' && (item.soldOut || item.dailyStock))
        .map(item => ({
            id: item.id,
            name: item.name,
            soldOut: !isItemOrderable(item),
            dailyStock: item.dailyStock,
            soldToday: Number(item.soldToday || 0),
            remaining: item.dailyStock ? Math.max(0, Number(item.dailyStock) - Number(item.soldToday || 0)) : null
        }))
        .filter(item => item.soldOut || (item.remaining !== null && item.remaining <= Math.max(3, Number(item.dailyStock) * 0.2)));

    const avgOrderValue = completedToday.length
        ? Math.round(completedToday.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) / completedToday.length)
        : 0;

    res.json({
        summary,
        today: {
            orders: todayOrders.length,
            completed: completedToday.length,
            cancelled: cancelledToday.length,
            revenue: summary.today.revenue,
            avgOrderValue
        },
        statusCounts,
        trend,
        topProducts,
        stockAlerts
    });
});

function parseRange(req) {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : (() => {
        const date = startOfDay(new Date());
        date.setDate(date.getDate() - 29);
        return date;
    })();

    const toEnd = new Date(to);
    toEnd.setHours(23, 59, 59, 999);
    return { from: startOfDay(from), to: toEnd };
}

function buildReport(req) {
    const { from, to } = parseRange(req);
    const orders = readRealOrders().filter(order => {
        const date = getOrderDate(order);
        return date >= from && date <= to;
    });

    const completed = orders.filter(order => order.status === 'completed');

    const dailyMap = new Map();
    completed.forEach(order => {
        const date = getOrderDate(order);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const current = dailyMap.get(key) || { date: key, orders: 0, revenue: 0 };
        current.orders += 1;
        current.revenue += Number(order.totalAmount || 0);
        dailyMap.set(key, current);
    });

    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const products = aggregateProducts(completed);
    const revenue = completed.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);

    return {
        from: from.toISOString(),
        to: to.toISOString(),
        daily,
        products,
        totals: {
            orders: orders.length,
            completed: completed.length,
            cancelled: orders.filter(order => order.status === 'cancelled').length,
            revenue,
            avgOrderValue: completed.length ? Math.round(revenue / completed.length) : 0
        }
    };
}

app.get('/api/admin/reports', requireAdmin, (req, res) => {
    res.json({ report: buildReport(req) });
});

app.get('/api/admin/reports/export', requireAdmin, (req, res) => {
    const report = buildReport(req);
    const type = req.query.type === 'products' ? 'products' : 'daily';

    const rows = type === 'products'
        ? [['商品', '數量', '銷售額'], ...report.products.map(item => [item.name, item.qty, item.revenue])]
        : [['日期', '完成訂單數', '營業額'], ...report.daily.map(row => [row.date, row.orders, row.revenue])];

    const csv = rows
        .map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(','))
        .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${type}-${todayKey()}.csv"`);
    res.send('﻿' + csv); // BOM 讓 Excel 正確辨識 UTF-8
});

// ==========================================
// 🟢 測試訂單（後台用，驗證推播/聲音/滿版卡片）
// ==========================================
const TEST_SAMPLE_ITEMS = [
    { key: '1-large-egg', name: '蛋炒飯 (加大、雙蛋)', qty: 1, price: 115, subtotal: 115 },
    { key: '10', name: '海帶芽蛋花湯', qty: 1, price: 25, subtotal: 25 }
];

app.post('/api/admin/orders/test', requireAdmin, (req, res) => {
    const { seq, date } = nextTestSequence();
    const now = new Date().toISOString();
    const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.filter(Boolean) : [];

    const order = {
        id: `${date}-T${seq}`,
        orderNumber: `T${seq}`,
        orderDate: date,
        clientRef: '',
        orderType: req.body.orderType === 'reserve' ? 'reserve' : 'instant',
        isTest: true,
        pushDeviceIds: deviceIds, // 空陣列表示推全部裝置
        name: '測試訂單',
        phone: '0900000000',
        pickupTime: req.body.orderType === 'reserve' ? '明天 12:00' : '約 15 分鐘後取餐',
        paymentMethod: 'cash',
        notes: '這是後台建立的測試訂單，用來確認推播、聲音、滿版接單卡片正常運作。',
        lineUserId: '',
        items: TEST_SAMPLE_ITEMS,
        totalAmount: TEST_SAMPLE_ITEMS.reduce((sum, item) => sum + item.subtotal, 0),
        status: 'pending',
        statusHistory: [{ status: 'pending', note: '測試訂單建立', at: now }],
        customerNotifications: [],
        createdAt: now,
        updatedAt: now
    };

    const orders = readOrders();
    orders.unshift(order);
    writeOrders(orders);

    // 測試單不扣庫存、不推播給客人（本來就沒有 lineUserId），只觸發店家端的推播/提醒
    startOrderReminder(order);

    logAudit(
        'order.test_created',
        `#${order.orderNumber}`,
        deviceIds.length ? `推播對象：${deviceIds.length} 台指定裝置` : '推播對象：全部裝置',
        req.session.username
    );

    res.status(201).json({ ok: true, order });
});

app.delete('/api/admin/orders/test', requireAdmin, (req, res) => {
    const orders = readOrders();
    const testOrders = orders.filter(order => order.isTest);

    testOrders.forEach(order => stopOrderReminder(order.id));

    const remaining = orders.filter(order => !order.isTest);
    writeOrders(remaining);

    logAudit('order.test_cleared', '測試訂單', `清除 ${testOrders.length} 張測試訂單`, req.session.username);
    res.json({ ok: true, removed: testOrders.length });
});

// ==========================================
// 🟢 背景推播 API
// ==========================================
app.get('/api/push/public-key', (req, res) => {
    res.json({ enabled: pushEnabled, publicKey: pushEnabled ? vapid.publicKey : '' });
});

app.get('/api/admin/push/status', requireAdmin, (req, res) => {
    const subscriptions = readPushSubscriptions();
    res.json({
        enabled: pushEnabled,
        devices: subscriptions.map(entry => ({
            id: entry.id,
            endpoint: entry.endpoint.slice(-12), // 只回傳尾碼，前端用來比對是不是自己這台
            label: entry.label || '',
            createdAt: entry.createdAt
        }))
    });
});

app.patch('/api/admin/push/devices/:id', requireAdmin, (req, res) => {
    const subscriptions = readPushSubscriptions();
    const device = subscriptions.find(entry => entry.id === req.params.id);

    if (!device) return res.status(404).json({ message: '找不到這台裝置' });

    const label = String(req.body.label || '').trim();
    device.label = label;
    writePushSubscriptions(subscriptions);
    logAudit('push.renamed', label || '未命名裝置', '重新命名推播裝置', req.session && req.session.username);
    res.json({ ok: true });
});

app.delete('/api/admin/push/devices/:id', requireAdmin, (req, res) => {
    const subscriptions = readPushSubscriptions();
    const device = subscriptions.find(entry => entry.id === req.params.id);
    const remaining = subscriptions.filter(entry => entry.id !== req.params.id);

    writePushSubscriptions(remaining);
    logAudit('push.unsubscribed', device ? (device.label || '未命名裝置') : req.params.id, `手動移除裝置，剩下 ${remaining.length} 台`, req.session && req.session.username);
    res.json({ ok: true, devices: remaining.length });
});

app.post('/api/admin/push/subscribe', requireAdmin, (req, res) => {
    const subscription = req.body.subscription;

    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ message: '訂閱資料不完整' });
    }

    const subscriptions = readPushSubscriptions();
    const existing = subscriptions.findIndex(entry => entry.endpoint === subscription.endpoint);

    const entry = {
        id: existing >= 0 ? subscriptions[existing].id : uuidv4(),
        endpoint: subscription.endpoint,
        subscription,
        label: String(req.body.label || '').trim(),
        createdAt: existing >= 0 ? subscriptions[existing].createdAt : new Date().toISOString()
    };

    if (existing >= 0) subscriptions[existing] = { ...subscriptions[existing], ...entry };
    else subscriptions.push(entry);

    writePushSubscriptions(subscriptions);
    logAudit('push.subscribed', entry.label || '未命名裝置', `登記背景推播，目前共 ${subscriptions.length} 台裝置`, req.session && req.session.username);
    res.status(201).json({ ok: true, devices: subscriptions.length });
});

app.post('/api/admin/push/unsubscribe', requireAdmin, (req, res) => {
    const endpoint = String(req.body.endpoint || '');
    const subscriptions = readPushSubscriptions();
    const remaining = subscriptions.filter(entry => entry.endpoint !== endpoint);

    writePushSubscriptions(remaining);
    logAudit('push.unsubscribed', '裝置', `取消背景推播，剩下 ${remaining.length} 台裝置`, req.session && req.session.username);
    res.json({ ok: true, devices: remaining.length });
});

app.post('/api/admin/push/test', requireAdmin, async (req, res) => {
    const result = await sendPushToAll({
        title: '推播測試',
        body: '如果你看到這則通知，背景推播就設定成功了。',
        tag: 'push-test',
        url: '/merchant.html'
    });
    res.json({ ok: result.sent > 0, result });
});

// ==========================================
// 🟢 帳號管理 API（僅店長）
// ==========================================
const safeUser = user => ({
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    createdAt: user.createdAt
});

app.get('/api/admin/users', requireAdmin, requireOwner, (req, res) => {
    res.json({ users: readUsers().map(safeUser), roles: ROLES });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    const user = readUsers().find(entry => entry.username === req.session.username);
    res.json({ user: user ? safeUser(user) : { username: req.session.username, role: req.session.role } });
});

app.post('/api/admin/users', requireAdmin, requireOwner, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.role === 'owner' ? 'owner' : 'staff';

    if (!username || password.length < 6) {
        return res.status(400).json({ message: '帳號必填，密碼至少 6 碼' });
    }

    const users = readUsers();
    if (users.some(entry => entry.username === username)) {
        return res.status(409).json({ message: '這個帳號已經存在' });
    }

    const { salt, hash } = hashPassword(password);
    users.push({
        username,
        salt,
        hash,
        role,
        displayName: String(req.body.displayName || username).trim(),
        createdAt: new Date().toISOString()
    });

    writeUsers(users);
    logAudit('user.created', username, `新增帳號，權限：${ROLES[role]}`, req.session.username);
    res.status(201).json({ ok: true });
});

app.patch('/api/admin/users/:username', requireAdmin, (req, res) => {
    const target = String(req.params.username);
    const isSelf = req.session.username === target;

    // 店長可以改所有人；員工只能改自己的密碼與顯示名稱
    if (!isSelf && req.session.role !== 'owner') {
        return res.status(403).json({ message: '只能修改自己的帳號' });
    }

    const users = readUsers();
    const user = users.find(entry => entry.username === target);
    if (!user) return res.status(404).json({ message: '找不到帳號' });

    const changes = [];

    if (req.body.password) {
        const password = String(req.body.password);
        if (password.length < 6) return res.status(400).json({ message: '密碼至少 6 碼' });
        const { salt, hash } = hashPassword(password);
        user.salt = salt;
        user.hash = hash;
        changes.push('更改密碼');
    }

    if (req.body.displayName !== undefined) {
        user.displayName = String(req.body.displayName).trim() || user.username;
        changes.push(`顯示名稱改為 ${user.displayName}`);
    }

    if (req.body.role !== undefined && req.session.role === 'owner') {
        const nextRole = req.body.role === 'owner' ? 'owner' : 'staff';

        // 不能把最後一位店長降級，否則沒人能再管理帳號
        if (user.role === 'owner' && nextRole !== 'owner'
            && users.filter(entry => entry.role === 'owner').length <= 1) {
            return res.status(400).json({ message: '至少要保留一位店長' });
        }

        if (nextRole !== user.role) changes.push(`權限改為 ${ROLES[nextRole]}`);
        user.role = nextRole;
    }

    writeUsers(users);
    if (changes.length) logAudit('user.updated', target, changes.join('、'), req.session.username);
    res.json({ ok: true, user: safeUser(user) });
});

app.delete('/api/admin/users/:username', requireAdmin, requireOwner, (req, res) => {
    const target = String(req.params.username);

    if (target === req.session.username) {
        return res.status(400).json({ message: '不能刪除自己正在使用的帳號' });
    }

    const users = readUsers();
    const user = users.find(entry => entry.username === target);
    if (!user) return res.status(404).json({ message: '找不到帳號' });

    if (user.role === 'owner' && users.filter(entry => entry.role === 'owner').length <= 1) {
        return res.status(400).json({ message: '至少要保留一位店長' });
    }

    writeUsers(users.filter(entry => entry.username !== target));

    // 該帳號目前登入中的 session 一併作廢
    [...adminSessions.entries()]
        .filter(([, session]) => session.username === target)
        .forEach(([token]) => adminSessions.delete(token));

    logAudit('user.deleted', target, '刪除帳號', req.session.username);
    res.json({ ok: true });
});

// ==========================================
// 🟢 操作紀錄 API
// ==========================================
app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, AUDIT_LIMIT);
    res.json({ entries: readAuditLog().slice(0, limit) });
});

app.patch('/api/orders/:orderNumber/status', requireAdmin, async (req, res) => {
    const allowedStatuses = ['pending', 'preparing', 'accepted', 'completed', 'cancelled'];
    let status = String(req.body.status || '').trim();
    if (status === 'accepted') status = 'preparing';

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: '狀態不正確' });
    }

    const orders = readOrders();
    const order = findOrder(orders, req.params.orderNumber);

    if (!order) {
        return res.status(404).json({ message: '找不到訂單' });
    }

    const previousStatus = order.status;

    // 一旦離開待接單狀態就停止重送提醒
    if (status !== 'pending') stopOrderReminder(order.id);

    order.status = status;
    if (status === 'completed') order.completedAt = new Date().toISOString();
    if (status === 'cancelled') order.cancelledAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    addStatusHistory(order, status, String(req.body.note || ''));

    const notification = await notifyCustomer(order, getStatusMessage(status));
    order.customerNotifications = Array.isArray(order.customerNotifications) ? order.customerNotifications : [];
    order.customerNotifications.push(notification);

    writeOrders(orders);
    let print = null;
    // 只有真正由「待接單」變成「製作中」才自動出單，避免重複點擊或重整頁面重印。
    if (previousStatus === 'pending' && status === 'preparing') {
        try {
            print = await queueOrderPrint(order, 'accept');
        } catch (error) {
            print = { status: 'failed', message: error.message };
            console.error('[Print] 自動出單失敗:', error.message);
        }
    }
    logAudit('order.status_changed', `#${order.orderNumber}`, `狀態改為 ${getStatusLabel(status)}${notification.sent ? '，已通知客人' : ''}`, req.session && req.session.username);
    if (print) {
        logAudit('print.order', `#${order.orderNumber}`, `${print.status}：${print.message || ''}`, req.session && req.session.username);
    }
    res.json({ ok: true, order, notification, print });
});

// 後台手動補印。補印一定建立新工作，但不會改變訂單狀態。
app.post('/api/admin/orders/:orderNumber/print', requireAdmin, async (req, res) => {
    const order = findOrder(readOrders(), req.params.orderNumber);
    if (!order) return res.status(404).json({ message: '找不到訂單' });

    try {
        const print = await queueOrderPrint(order, 'reprint');
        logAudit('print.reprint', `#${order.orderNumber}`, `${print.status}：${print.message || ''}`, req.session && req.session.username);
        res.json({ ok: print.status === 'printed', order, print });
    } catch (error) {
        console.error('[Print] 補印失敗:', error.message);
        res.status(500).json({ message: `補印失敗：${error.message}` });
    }
});

app.get('/api/admin/orders/:orderNumber/receipt', requireAdmin, (req, res) => {
    const order = findOrder(readOrders(), req.params.orderNumber);
    if (!order) return res.status(404).json({ message: '找不到訂單' });
    res.json({ width: '58mm', text: receiptText(order, req.query.kind === 'reprint' ? 'reprint' : 'accept') });
});

app.get('/api/admin/print/status', requireAdmin, (req, res) => {
    const jobs = readPrintJobs();
    res.json({
        enabled: AUTO_PRINT_ON_ACCEPT,
        printerName: PRINTER_NAME || '系統預設印表機',
        raw: PRINTER_RAW,
        jobs: jobs.slice(-30).reverse()
    });
});

app.patch('/api/admin/orders/:orderNumber/note', requireAdmin, (req, res) => {
    const orders = readOrders();
    const order = findOrder(orders, req.params.orderNumber);

    if (!order) return res.status(404).json({ message: '找不到訂單' });

    order.adminNote = String(req.body.note || '').trim();
    order.updatedAt = new Date().toISOString();
    writeOrders(orders);
    logAudit('order.note_updated', `#${order.orderNumber}`, order.adminNote || '清除備註', req.session && req.session.username);
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

async function startServer() {
    try {
        const result = await hydrateNormalizedStateFiles(__dirname);
        if (result.hydrated) {
            console.log(`[Supabase] 已從正規化資料表還原 ${result.hydrated} 個資料區塊`);
        } else {
            const legacyResult = await hydrateStateFiles(__dirname);
            if (legacyResult.hydrated) {
                console.log(`[Supabase] 已從備份總表還原 ${legacyResult.hydrated} 個資料區塊`);
            }
        }
    } catch (error) {
        console.error('[Supabase] 啟動還原失敗，繼續使用本機 JSON:', error.message);
    }

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        readUsers();              // 首次啟動時建立預設帳號
        rearmPendingReminders();  // 重啟前還沒接的單要繼續提醒
    });
}

if (require.main === module) startServer();

module.exports = {
    app,
    buildOrderFlexMessage,
    customerOrderView
};
