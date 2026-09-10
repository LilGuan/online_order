const fs = require('fs');
const path = require('path');
const { getSupabaseClient, isEnabled } = require('./supabase-state');

const syncQueues = new Map();
let lastErrorAt = 0;

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function withoutItems(order) {
    const { items, ...data } = order || {};
    return data;
}

function orderRow(order) {
    return {
        id: String(order.id),
        order_number: String(order.orderNumber || ''),
        order_date: order.orderDate || null,
        client_ref: order.clientRef || null,
        order_type: order.orderType || null,
        is_test: Boolean(order.isTest),
        push_device_ids: order.pushDeviceIds || [],
        name: order.name || '',
        phone: order.phone || '',
        pickup_time: order.pickupTime || '',
        payment_method: order.paymentMethod || null,
        notes: order.notes || '',
        line_user_id: order.lineUserId || null,
        total_amount: Number(order.totalAmount || 0),
        status: order.status || null,
        status_history: order.statusHistory || [],
        customer_notifications: order.customerNotifications || [],
        completed_at: order.completedAt || null,
        cancelled_at: order.cancelledAt || null,
        created_at: order.createdAt || new Date().toISOString(),
        updated_at: order.updatedAt || new Date().toISOString(),
        data: withoutItems(order)
    };
}

function orderItemRows(order) {
    return (order.items || []).map((item, index) => ({
        order_id: String(order.id),
        line_number: index + 1,
        item_key: item.key == null ? null : String(item.key),
        name: item.name || '',
        quantity: Number(item.qty || 0),
        unit_price: Number(item.price || 0),
        subtotal: Number(item.subtotal || 0),
        data: item
    }));
}

async function assertResult(result) {
    if (result.error) throw result.error;
    return result.data || [];
}

async function removeStaleRows(client, table, key, rows) {
    const current = await assertResult(await client.from(table).select(key));
    const wanted = new Set(rows.map(row => String(row[key])));
    const stale = current
        .map(row => row[key])
        .filter(value => !wanted.has(String(value)));

    if (stale.length) {
        await assertResult(await client.from(table).delete().in(key, stale));
    }
}

async function replaceRows(client, table, key, rows, onConflict = key) {
    await removeStaleRows(client, table, key, rows);
    if (rows.length) {
        await assertResult(await client.from(table).upsert(rows, { onConflict }));
    }
}

async function syncOrders(client, orders) {
    const rows = orders.map(orderRow);
    await replaceRows(client, 'online_order_orders', 'id', rows);

    const orderIds = rows.map(row => row.id);
    if (orderIds.length) {
        await assertResult(await client.from('online_order_order_items').delete().in('order_id', orderIds));
    }

    const items = orders.flatMap(orderItemRows);
    if (items.length) {
        await assertResult(await client.from('online_order_order_items').insert(items));
    }
}

async function syncMenu(client, menu) {
    const categories = (menu.categories || []).map(category => ({
        key: String(category.key),
        name: category.name || '',
        sort_order: Number(category.sortOrder || 0),
        data: category
    }));
    const items = (menu.items || []).map(item => ({
        id: Number(item.id),
        name: item.name || '',
        price: Number(item.price || 0),
        image: item.image || null,
        description: item.description || '',
        category: item.category || null,
        options: item.options || {},
        status: item.status || null,
        sold_out: Boolean(item.soldOut),
        daily_stock: item.dailyStock == null ? null : Number(item.dailyStock),
        sold_today: Number(item.soldToday || 0),
        stock_date: item.stockDate || null,
        sort_order: Number(item.sortOrder || 0),
        data: item
    }));

    await replaceRows(client, 'online_order_menu_categories', 'key', categories);
    await replaceRows(client, 'online_order_menu_items', 'id', items);
}

async function syncSettings(client, settings) {
    await assertResult(await client.from('online_order_settings').upsert({
        key: 'default',
        data: settings,
        updated_at: settings.updatedAt || new Date().toISOString()
    }, { onConflict: 'key' }));
}

async function syncStoreStatus(client, status) {
    await assertResult(await client.from('online_order_store_status').upsert({
        id: 1,
        is_open: Boolean(status.isOpen),
        updated_at: status.updatedAt || new Date().toISOString()
    }, { onConflict: 'id' }));
}

async function syncUsers(client, users) {
    const rows = users.map(user => ({
        username: String(user.username),
        salt: user.salt || '',
        password_hash: user.hash || '',
        role: user.role || 'staff',
        display_name: user.displayName || '',
        created_at: user.createdAt || new Date().toISOString(),
        data: user
    }));
    await replaceRows(client, 'online_order_admin_users', 'username', rows);
}

async function syncCustomers(client, customers) {
    const rows = customers.map(customer => ({
        id: String(customer.id),
        name: customer.name || '',
        display_name: customer.displayName || '',
        phone: customer.phone || '',
        line_user_id: customer.lineUserId || null,
        member_since: customer.memberSince || new Date().toISOString(),
        last_seen_at: customer.lastSeenAt || new Date().toISOString(),
        first_order_id: customer.firstOrderId || null,
        last_order_at: customer.lastOrderAt || null,
        last_order_number: customer.lastOrderNumber || null,
        order_count: Number(customer.orderCount || 0),
        completed_order_count: Number(customer.completedOrderCount || 0),
        cancelled_order_count: Number(customer.cancelledOrderCount || 0),
        total_spent: Number(customer.totalSpent || 0),
        status: customer.status || 'active',
        data: customer
    }));
    await replaceRows(client, 'online_order_customers', 'id', rows);
}

async function syncAuditLog(client, entries) {
    const rows = entries.map(entry => ({
        id: String(entry.id),
        at: entry.at || new Date().toISOString(),
        username: entry.user || 'system',
        action: entry.action || '',
        target: entry.target || '',
        detail: entry.detail || '',
        data: entry
    }));
    await replaceRows(client, 'online_order_audit_log', 'id', rows);
}

async function syncPushSubscriptions(client, subscriptions) {
    const rows = subscriptions.map(entry => ({
        id: String(entry.id),
        endpoint: entry.endpoint || '',
        subscription: entry.subscription || {},
        label: entry.label || '',
        created_at: entry.createdAt || new Date().toISOString(),
        data: entry
    }));
    await replaceRows(client, 'online_order_push_subscriptions', 'id', rows);
}

async function syncCounter(client, counter) {
    await assertResult(await client.from('online_order_order_counter').upsert({
        key: 'current',
        order_date: counter.date || null,
        sequence: Number(counter.seq || 0),
        test_date: counter.testDate || null,
        test_sequence: Number(counter.testSeq || 0),
        data: counter
    }, { onConflict: 'key' }));
}

async function syncPrintQueue(client, jobs) {
    const rows = jobs.map(job => ({
        id: String(job.id),
        order_id: job.orderId || null,
        order_number: job.orderNumber || '',
        kind: job.kind || null,
        status: job.status || null,
        attempts: Number(job.attempts || 0),
        message: job.message || '',
        created_at: job.createdAt || new Date().toISOString(),
        updated_at: job.updatedAt || new Date().toISOString(),
        printed_at: job.printedAt || null,
        data: job
    }));
    await replaceRows(client, 'online_order_print_jobs', 'id', rows);
}

async function syncNormalizedSnapshot(snapshot) {
    if (!isEnabled()) return { skipped: true };
    const client = getSupabaseClient();

    if (snapshot.orders) await syncOrders(client, snapshot.orders);
    if (snapshot.menu) await syncMenu(client, snapshot.menu);
    if (snapshot.settings) await syncSettings(client, snapshot.settings);
    if (snapshot.storeStatus) await syncStoreStatus(client, snapshot.storeStatus);
    if (snapshot.users) await syncUsers(client, snapshot.users);
    if (snapshot.customers) await syncCustomers(client, snapshot.customers);
    if (snapshot.auditLog) await syncAuditLog(client, snapshot.auditLog);
    if (snapshot.pushSubscriptions) await syncPushSubscriptions(client, snapshot.pushSubscriptions);
    if (snapshot.orderCounter) await syncCounter(client, snapshot.orderCounter);
    if (snapshot.printQueue) await syncPrintQueue(client, snapshot.printQueue);

    return { synced: true };
}

const FILE_TO_SNAPSHOT_KEY = {
    'orders.json': 'orders',
    'menu.json': 'menu',
    'settings.json': 'settings',
    'store-status.json': 'storeStatus',
    'users.json': 'users',
    'customers.json': 'customers',
    'audit-log.json': 'auditLog',
    'push-subscriptions.json': 'pushSubscriptions',
    'order-counter.json': 'orderCounter',
    'print-queue.json': 'printQueue'
};

function queueNormalizedSync(filePath, value) {
    const fileName = path.basename(filePath);
    const snapshotKey = FILE_TO_SNAPSHOT_KEY[fileName];
    if (!snapshotKey || !isEnabled()) return;

    const snapshot = { [snapshotKey]: cloneValue(value) };
    const previous = syncQueues.get(snapshotKey) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => syncNormalizedSnapshot(snapshot))
        .catch(error => {
            const now = Date.now();
            if (now - lastErrorAt > 10000) {
                lastErrorAt = now;
                console.error(`[Supabase] 正規化資料同步失敗:`, error.message);
            }
        });
    syncQueues.set(snapshotKey, next);
}

async function selectRows(client, table, columns = '*') {
    return assertResult(await client.from(table).select(columns));
}

async function hydrateNormalizedStateFiles(rootDir) {
    if (!isEnabled()) return { hydrated: 0, skipped: true };
    const client = getSupabaseClient();
    const [orders, items, categories, menuItems, settings, storeStatus, users, customers, auditLog, subscriptions, counter, printQueue] = await Promise.all([
        selectRows(client, 'online_order_orders'),
        selectRows(client, 'online_order_order_items'),
        selectRows(client, 'online_order_menu_categories'),
        selectRows(client, 'online_order_menu_items'),
        selectRows(client, 'online_order_settings'),
        selectRows(client, 'online_order_store_status'),
        selectRows(client, 'online_order_admin_users'),
        selectRows(client, 'online_order_customers'),
        selectRows(client, 'online_order_audit_log'),
        selectRows(client, 'online_order_push_subscriptions'),
        selectRows(client, 'online_order_order_counter'),
        selectRows(client, 'online_order_print_jobs')
    ]);

    const hasData = [orders, items, categories, menuItems, settings, storeStatus, users, customers, auditLog, subscriptions, counter, printQueue]
        .some(rows => rows.length > 0);
    if (!hasData) return { hydrated: 0, skipped: false };

    const itemsByOrder = new Map();
    items.forEach(item => {
        const list = itemsByOrder.get(item.order_id) || [];
        list.push({
            ...(item.data || {}),
            key: item.item_key || (item.data || {}).key,
            name: item.name,
            qty: Number(item.quantity || 0),
            price: Number(item.unit_price || 0),
            subtotal: Number(item.subtotal || 0)
        });
        itemsByOrder.set(item.order_id, list);
    });

    const orderData = orders.map(order => ({
        ...(order.data || {}),
        id: order.id,
        orderNumber: order.order_number,
        orderDate: order.order_date,
        clientRef: order.client_ref || '',
        orderType: order.order_type,
        isTest: order.is_test,
        pushDeviceIds: order.push_device_ids || [],
        name: order.name,
        phone: order.phone,
        pickupTime: order.pickup_time,
        paymentMethod: order.payment_method,
        notes: order.notes,
        lineUserId: order.line_user_id || '',
        totalAmount: Number(order.total_amount || 0),
        status: order.status,
        statusHistory: order.status_history || [],
        customerNotifications: order.customer_notifications || [],
        completedAt: order.completed_at,
        cancelledAt: order.cancelled_at,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        items: itemsByOrder.get(order.id) || []
    }));

    const menu = {
        categories: categories.map(category => ({
            ...(category.data || {}),
            key: category.key,
            name: category.name,
            sortOrder: Number(category.sort_order || 0)
        })),
        items: menuItems.map(item => ({
            ...(item.data || {}),
            id: Number(item.id),
            name: item.name,
            price: Number(item.price || 0),
            image: item.image,
            description: item.description,
            category: item.category,
            options: item.options || {},
            status: item.status,
            soldOut: item.sold_out,
            dailyStock: item.daily_stock,
            soldToday: Number(item.sold_today || 0),
            stockDate: item.stock_date,
            sortOrder: Number(item.sort_order || 0)
        }))
    };

    const files = [
        ['orders.json', orderData],
        ['menu.json', menu],
        ['settings.json', settings[0]?.data || {}],
        ['store-status.json', storeStatus[0] ? { isOpen: storeStatus[0].is_open, updatedAt: storeStatus[0].updated_at } : { isOpen: false }],
        ['users.json', users.map(user => ({ ...(user.data || {}), username: user.username, salt: user.salt, hash: user.password_hash, role: user.role, displayName: user.display_name, createdAt: user.created_at }))],
        ['customers.json', customers.map(customer => ({ ...(customer.data || {}), id: customer.id, name: customer.name, displayName: customer.display_name, phone: customer.phone, lineUserId: customer.line_user_id || '', memberSince: customer.member_since, lastSeenAt: customer.last_seen_at, firstOrderId: customer.first_order_id || '', lastOrderAt: customer.last_order_at || '', lastOrderNumber: customer.last_order_number || '', orderCount: Number(customer.order_count || 0), completedOrderCount: Number(customer.completed_order_count || 0), cancelledOrderCount: Number(customer.cancelled_order_count || 0), totalSpent: Number(customer.total_spent || 0), status: customer.status || 'active' }))],
        ['audit-log.json', auditLog.map(entry => ({ ...(entry.data || {}), id: entry.id, at: entry.at, user: entry.username, action: entry.action, target: entry.target, detail: entry.detail }))],
        ['push-subscriptions.json', subscriptions.map(entry => ({ ...(entry.data || {}), id: entry.id, endpoint: entry.endpoint, subscription: entry.subscription, label: entry.label, createdAt: entry.created_at }))],
        ['order-counter.json', counter[0]?.data || { date: '', seq: 0, testDate: '', testSeq: 0 }],
        ['print-queue.json', printQueue.map(job => ({ ...(job.data || {}), id: job.id, orderId: job.order_id, orderNumber: job.order_number, kind: job.kind, status: job.status, attempts: job.attempts, message: job.message, createdAt: job.created_at, updatedAt: job.updated_at, printedAt: job.printed_at }))]
    ];

    files.forEach(([fileName, data]) => {
        fs.writeFileSync(path.join(rootDir, fileName), JSON.stringify(data, null, 2));
    });

    return { hydrated: files.length, skipped: false };
}

module.exports = {
    hydrateNormalizedStateFiles,
    queueNormalizedSync,
    syncNormalizedSnapshot
};
