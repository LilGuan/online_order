function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function findCustomer(customers, profile) {
    const lineUserId = String(profile.lineUserId || '').trim();
    const phone = normalizePhone(profile.phone);

    return customers.find(customer => lineUserId && customer.lineUserId === lineUserId)
        || customers.find(customer => phone && normalizePhone(customer.phone) === phone)
        || null;
}

function customerIdFor(profile) {
    const lineUserId = String(profile.lineUserId || '').trim();
    const phone = normalizePhone(profile.phone);
    if (lineUserId) return `line:${lineUserId}`;
    if (phone) return `phone:${phone}`;
    return '';
}

function createCustomer(profile, now) {
    const id = customerIdFor(profile);
    if (!id) return null;

    return {
        id,
        name: String(profile.name || profile.displayName || '').trim(),
        displayName: String(profile.displayName || profile.name || '').trim(),
        phone: String(profile.phone || '').trim(),
        lineUserId: String(profile.lineUserId || '').trim(),
        memberSince: now,
        lastSeenAt: now,
        firstOrderId: '',
        lastOrderAt: '',
        lastOrderNumber: '',
        orderCount: 0,
        completedOrderCount: 0,
        cancelledOrderCount: 0,
        totalSpent: 0,
        status: 'active'
    };
}

function upsertCustomerProfile(customers, profile, now = new Date().toISOString()) {
    let customer = findCustomer(customers, profile);
    if (!customer) {
        customer = createCustomer(profile, now);
        if (!customer) return null;
        customers.push(customer);
    }

    const name = String(profile.name || '').trim();
    const displayName = String(profile.displayName || '').trim();
    const phone = String(profile.phone || '').trim();
    const lineUserId = String(profile.lineUserId || '').trim();

    if (name) customer.name = name;
    if (displayName) customer.displayName = displayName;
    if (phone) customer.phone = phone;
    if (lineUserId) customer.lineUserId = lineUserId;
    customer.lastSeenAt = now;
    customer.status = 'active';
    return customer;
}

function resetCustomerStats(customer) {
    customer.firstOrderId = '';
    customer.lastOrderAt = '';
    customer.lastOrderNumber = '';
    customer.orderCount = 0;
    customer.completedOrderCount = 0;
    customer.cancelledOrderCount = 0;
    customer.totalSpent = 0;
}

function buildCustomersFromOrders(orders, seedCustomers = []) {
    const customers = seedCustomers.map(seed => ({ ...seed }));
    customers.forEach(resetCustomerStats);

    const sortedOrders = (orders || [])
        .filter(order => !order.isTest)
        .filter(order => order.name || order.phone || order.lineUserId)
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    sortedOrders.forEach(order => {
        const customer = upsertCustomerProfile(customers, {
            name: order.name,
            phone: order.phone,
            lineUserId: order.lineUserId
        }, order.createdAt || new Date().toISOString());
        if (!customer) return;

        customer.orderCount += 1;
        if (!customer.firstOrderId) customer.firstOrderId = String(order.id || '');
        if (order.status === 'completed') {
            customer.completedOrderCount += 1;
            customer.totalSpent += Number(order.totalAmount || 0);
        }
        if (order.status === 'cancelled') customer.cancelledOrderCount += 1;

        const orderAt = order.createdAt || order.updatedAt || '';
        if (!customer.lastOrderAt || new Date(orderAt) >= new Date(customer.lastOrderAt)) {
            customer.lastOrderAt = orderAt;
            customer.lastOrderNumber = String(order.orderNumber || '');
        }
    });

    return customers.sort((a, b) => new Date(b.lastSeenAt || b.memberSince || 0) - new Date(a.lastSeenAt || a.memberSince || 0));
}

function customerStatsForOrder(order, customers) {
    const customer = findCustomer(customers, order);
    if (!customer) return { customerId: '', customerOrderCount: 0, customerIsNew: true };
    return {
        customerId: customer.id,
        customerOrderCount: Number(customer.orderCount || 0),
        customerIsNew: customer.firstOrderId === String(order.id || '')
    };
}

function safeCustomer(customer) {
    return {
        id: customer.id,
        name: customer.name || customer.displayName || '未命名會員',
        displayName: customer.displayName || customer.name || '',
        phone: customer.phone || '',
        lineUserId: customer.lineUserId || '',
        memberSince: customer.memberSince || '',
        lastSeenAt: customer.lastSeenAt || '',
        lastOrderAt: customer.lastOrderAt || '',
        lastOrderNumber: customer.lastOrderNumber || '',
        orderCount: Number(customer.orderCount || 0),
        completedOrderCount: Number(customer.completedOrderCount || 0),
        cancelledOrderCount: Number(customer.cancelledOrderCount || 0),
        totalSpent: Number(customer.totalSpent || 0),
        status: customer.status || 'active'
    };
}

module.exports = {
    buildCustomersFromOrders,
    customerStatsForOrder,
    findCustomer,
    normalizePhone,
    safeCustomer,
    upsertCustomerProfile
};
