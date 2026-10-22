const iconv = require('iconv-lite');

function encodeTextReceipt(text) {
    // Strip control characters in customer input so it cannot inject printer commands.
    const clean = String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(/・/g, '/');
    return Buffer.concat([
        Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0, 0x1b, 0x21, 0, 0x1c, 0x26]),
        iconv.encode(clean, 'gb18030'),
        Buffer.from([0x0a, 0x1b, 0x64, 4])
    ]);
}

function cleanText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(/・/g, '/');
}

function characterWidth(char) {
    return char.codePointAt(0) < 128 ? 1 : 2;
}

function widthOf(text) {
    return [...text].reduce((sum, char) => sum + characterWidth(char), 0);
}

function buildLargeReceipt(order, settings = {}, kind = 'accept') {
    const rows = [];
    function add(value, { scale = 1, height = 2, bold = false, align = 'left' } = {}) {
        const capacity = Math.floor(32 / scale);
        for (const source of cleanText(value).split('\n')) {
            let line = '';
            for (const char of source) {
                if (widthOf(line + char) > capacity) {
                    rows.push({ text: line, scale, height, bold, align });
                    line = '';
                }
                line += char;
            }
            rows.push({ text: line, scale, height, bold, align });
        }
    }
    function prominent(value, maxScale, align = 'left') {
        const scale = Math.max(1, Math.min(maxScale, Math.floor(32 / Math.max(1, widthOf(cleanText(value))))));
        add(value, { scale, height: Math.max(2, scale), bold: true, align });
    }
    function rule() { add('-'.repeat(32), { height: 1 }); }
    const time = value => new Date(value || Date.now()).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    prominent(settings.storeName || '邱媽媽美食', 2, 'center');
    if (order.isTest) { prominent('測試單', 2, 'center'); add('請勿製作、請勿出餐', { bold: true, align: 'center' }); }
    if (kind === 'reprint') prominent('補印', 2, 'center');
    add('訂單編號', { align: 'center', bold: true });
    prominent(`#${order.orderNumber || ''}`, 8, 'center');
    const status = { pending: '待接單', preparing: '製作中', completed: '已完成', cancelled: '已取消' };
    add(`${order.orderType === 'reserve' ? '預約單' : '即時單'} / ${status[order.status] || '製作中'}`, { align: 'center' });
    rule();
    add(`取餐：${order.pickupTime || '未指定'}`, { bold: true });
    add(`姓名：${order.name || ''}`);
    add(`電話：${order.phone || ''}`);
    add(`餐具：${order.utensils === 'yes' ? '需要' : '不需要'}`, { bold: true });
    add(`下單：${time(order.createdAt)}`);
    rule();
    let qty = 0;
    (order.items || []).forEach((item, index) => {
        add(`${index + 1}.`, { bold: true });
        const name = item.name || '未命名商品';
        const scale = Math.max(2, Math.min(3, Math.floor(32 / Math.max(1, widthOf(cleanText(name))))));
        add(name, { scale, height: scale, bold: true });
        qty += Number(item.qty || 0);
        prominent(`x${Number(item.qty || 0)}  $${Number(item.subtotal || 0)}`, 2);
        rule();
    });
    add(`共 ${(order.items || []).length} 項 / ${qty} 份`, { bold: true });
    add('應付金額', { bold: true });
    prominent(`$${Number(order.totalAmount || 0)}`, 4, 'right');
    rule();
    const paid = ['linepay_online', 'online_payment'].includes(order.paymentMethod);
    add(paid ? '已付款 / 請勿收款' : order.paymentMethod === 'cash' ? `請收現金 $${Number(order.totalAmount || 0)}` : `付款：${order.paymentMethod || '未指定'}`, { bold: true });
    if (order.notes) { rule(); add('客人備註', { bold: true }); add(order.notes, { bold: true }); }
    rule();
    if (settings.phone) add(`店家：${settings.phone}`);
    if (settings.address) add(settings.address);
    add(`出單：${time()}`);
    add('謝謝您的訂購', { align: 'center' });
    const parts = [Buffer.from([0x1b, 0x40, 0x1b, 0x4d, 0, 0x1c, 0x26])];
    for (const row of rows) {
        parts.push(Buffer.from([0x1b, 0x61, { left: 0, center: 1, right: 2 }[row.align],
            0x1b, 0x45, row.bold ? 1 : 0, 0x1d, 0x21, ((row.scale - 1) << 4) | (row.height - 1)]));
        parts.push(iconv.encode(row.text + '\n', 'gb18030'));
    }
    parts.push(Buffer.from([0x1d, 0x21, 0, 0x1b, 0x45, 0, 0x1b, 0x61, 0, 0x1b, 0x64, 4]));
    return { width: '58mm', rows, text: rows.map(row => row.text).join('\n'), encoding: 'gb18030', bytesBase64: Buffer.concat(parts).toString('base64') };
}

module.exports = { encodeTextReceipt, buildLargeReceipt, widthOf };
