const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const STATE_KEYS = new Map([
    ['orders.json', 'orders'],
    ['menu.json', 'menu'],
    ['settings.json', 'settings'],
    ['store-status.json', 'store-status'],
    ['audit-log.json', 'audit-log'],
    ['users.json', 'users'],
    ['customers.json', 'customers'],
    ['push-subscriptions.json', 'push-subscriptions'],
    ['order-counter.json', 'order-counter'],
    ['print-queue.json', 'print-queue']
]);

const FILE_NAMES_BY_KEY = new Map(
    [...STATE_KEYS].map(([fileName, key]) => [key, fileName])
);

const supabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    })
    : null;

const syncQueues = new Map();
let missingConfigLogged = false;
let lastErrorAt = 0;

function stateKeyForFile(filePath) {
    return STATE_KEYS.get(path.basename(filePath)) || null;
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

async function upsertState(key, value) {
    if (!supabaseEnabled) return { skipped: true, reason: 'missing_config' };

    const { error } = await supabase
        .from('online_order_state')
        .upsert({
            key,
            value,
            updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

    if (error) throw error;
    return { synced: true, key };
}

async function hydrateStateFiles(rootDir) {
    if (!supabaseEnabled) return { hydrated: 0, skipped: true };

    const keys = [...FILE_NAMES_BY_KEY.keys()];
    const { data, error } = await supabase
        .from('online_order_state')
        .select('key, value')
        .in('key', keys);

    if (error) throw error;

    let hydrated = 0;
    for (const row of data || []) {
        const fileName = FILE_NAMES_BY_KEY.get(row.key);
        if (!fileName) continue;
        fs.writeFileSync(
            path.join(rootDir, fileName),
            JSON.stringify(row.value, null, 2)
        );
        hydrated += 1;
    }

    return { hydrated, skipped: false };
}

function queueStateSync(filePath, value) {
    const key = stateKeyForFile(filePath);
    if (!key) return;

    if (!supabaseEnabled) {
        if (!missingConfigLogged) {
            missingConfigLogged = true;
            console.warn('[Supabase] 尚未設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY，先使用本機 JSON。');
        }
        return;
    }

    const snapshot = cloneValue(value);
    const previous = syncQueues.get(key) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => upsertState(key, snapshot))
        .catch(error => {
            const now = Date.now();
            if (now - lastErrorAt > 10000) {
                lastErrorAt = now;
                console.error(`[Supabase] 同步 ${key} 失敗:`, error.message);
            }
        });

    syncQueues.set(key, next);
}

function getSupabaseClient() {
    if (!supabaseEnabled) {
        throw new Error('請設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY');
    }
    return supabase;
}

module.exports = {
    STATE_KEYS,
    getSupabaseClient,
    hydrateStateFiles,
    isEnabled: () => supabaseEnabled,
    stateKeyForFile,
    queueStateSync,
    upsertState
};
