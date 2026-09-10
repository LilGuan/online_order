require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getSupabaseClient, isEnabled, STATE_KEYS, upsertState } = require('../supabase-state');
const { syncNormalizedSnapshot } = require('../supabase-normalized');
const { buildCustomersFromOrders } = require('../customer-utils');

const root = path.join(__dirname, '..');

function readJson(fileName, fallback) {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
    if (!isEnabled()) {
        throw new Error('請先設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY，再執行 npm run migrate:supabase');
    }

    const client = getSupabaseClient();
    const rows = [];
    const snapshot = {};

    const customersPath = path.join(root, 'customers.json');
    if (!fs.existsSync(customersPath)) {
        fs.writeFileSync(
            customersPath,
            JSON.stringify(buildCustomersFromOrders(readJson('orders.json', [])), null, 2)
        );
    }

    for (const [fileName, key] of STATE_KEYS) {
        const filePath = path.join(root, fileName);
        if (!fs.existsSync(filePath)) continue;
        rows.push({
            key,
            value: readJson(fileName, null),
            updated_at: new Date(fs.statSync(filePath).mtimeMs).toISOString()
        });
        const snapshotKey = {
            'orders': 'orders',
            'menu': 'menu',
            'settings': 'settings',
            'store-status': 'storeStatus',
            'audit-log': 'auditLog',
            'users': 'users',
            'customers': 'customers',
            'push-subscriptions': 'pushSubscriptions',
            'order-counter': 'orderCounter',
            'print-queue': 'printQueue'
        }[key];
        if (snapshotKey) snapshot[snapshotKey] = rows[rows.length - 1].value;
    }

    if (!rows.length) {
        console.log('[Supabase] 找不到可搬移的 JSON 資料。');
        return;
    }

    const { error } = await client
        .from('online_order_state')
        .upsert(rows, { onConflict: 'key' });

    if (error) throw error;
    await syncNormalizedSnapshot(snapshot);
    console.log(`[Supabase] 已搬移 ${rows.length} 個資料區塊：${rows.map(row => row.key).join(', ')}`);
    console.log('[Supabase] 已同步到正規化功能資料表');
}

main().catch(error => {
    console.error('[Supabase] 搬移失敗:', error.message);
    process.exitCode = 1;
});
