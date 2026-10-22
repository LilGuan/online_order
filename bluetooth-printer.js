/* BLE transport for encoded text and raster receipts. */
class BluetoothReceiptPrinter {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.device = null;
    this.characteristic = null;
    this.busy = false;
    this.speed = 'continuous';
    this.profile = 'web';
    this.writeMode = 'auto';
    this.packetDelay = 0;
    this.connectionPromise = null;
    this.connectionVersion = 0;
    this.scanAbort = null;
    this.disconnectHandler = null;
    this.cancelStep = null;
  }

  configure(profile, writeMode = 'auto', packetDelay = 0) {
    if (this.busy) throw new Error('列印中，請完成後再調整參數');
    if (!['web', 'android'].includes(profile) || !['auto', 'response', 'noResponse'].includes(writeMode)) throw new Error('列印參數不正確');
    const delay = Number(packetDelay);
    if (!Number.isInteger(delay) || delay < 0 || delay > 50) throw new Error('傳送間隔需為 0 到 50 毫秒');
    this.profile = profile;
    this.writeMode = writeMode;
    this.packetDelay = delay;
  }

  setSpeed(speed) {
    if (this.busy) throw new Error('列印中，請完成後再調整速度');
    this.speed = ['balanced', 'stable'].includes(speed) ? speed : 'continuous';
  }

  get connected() { return Boolean(this.device?.gatt?.connected && this.characteristic); }

  connect(customService = '', options = {}) {
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = this.openConnection(customService, options).finally(() => { this.connectionPromise = null; });
    return this.connectionPromise;
  }

  async openConnection(customService, options) {
    if (!window.isSecureContext || !navigator.bluetooth) {
      throw new Error('請用電腦或 Android 的 Chrome 開啟 HTTPS 後台；iPhone Safari 和 LINE 內建瀏覽器無法使用此藍牙連線');
    }
    if (this.busy) throw new Error('列印中，請稍候');
    this.disconnect();
    const version = this.connectionVersion;
    const services = [0xffe0, 0xfff0, 0xae30, 0x18f0, 0xff00,
      '49535343-fe7d-4ae5-8fa9-9fafd205e455'];
    const custom = customService.trim().toLowerCase();
    if (custom) {
      let uuid;
      if (/^(?:0x)?[0-9a-f]{4}$/.test(custom)) uuid = parseInt(custom.replace(/^0x/, ''), 16);
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(custom)) uuid = custom;
      else throw new Error('BLE Service UUID 格式不正確，請填入 4 位十六進位短碼或完整 UUID');
      if (!services.includes(uuid)) services.push(uuid);
    }
    const printerName = options.name || 'XL-58BL_BD9A_BLE';
    const printerNamePrefix = printerName.replace(/_BLE$/, '');
    this.onChange(options.auto ? '正在自動連接出單機' : '正在搜尋 BLE 印表機');
    try {
      if (options.auto) {
        // A live page can reuse its selected device even without getDevices support.
        const devices = this.device ? [this.device] : navigator.bluetooth.getDevices
          ? await this.connectionStep(navigator.bluetooth.getDevices(), '讀取已授權裝置', version, 8000) : [];
        if (!this.device && !navigator.bluetooth.getDevices) {
          const error = new Error('此 Chrome 不支援重新整理後自動恢復藍牙，請按「連接印表機」重新選取');
          error.code = 'manual_required';
          throw error;
        }
        this.device = devices.find(device => options.deviceId ? device.id === options.deviceId
          : device.name?.startsWith(printerNamePrefix));
        if (!this.device) {
          const error = new Error('Chrome 未提供已授權的印表機，請按「連接印表機」重新選取');
          error.code = 'manual_required';
          throw error;
        }
      } else {
        this.device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: printerNamePrefix }], optionalServices: services });
      }
      if (version !== this.connectionVersion) throw new Error('連線已取消');
    } catch (error) {
      const message = error.name === 'NotFoundError'
        ? `未選取 ${printerNamePrefix} 出單機。請確認印表機電源、未連接其他裝置及 Chrome 藍牙權限，再重新搜尋`
        : error.message;
      if (version === this.connectionVersion) this.onChange(message);
      const failure = new Error(message);
      failure.code = error.code;
      throw failure;
    }
    this.disconnectHandler = () => {
      this.characteristic = null;
      this.onChange('藍牙已斷線');
    };
    this.device.addEventListener('gattserverdisconnected', this.disconnectHandler);
    const deadline = Date.now() + 15000;
    try {
      this.onChange(`正在連接 ${this.device.name || '出單機'}`);
      let server;
      try {
        server = await this.connectionStep(this.device.gatt.connect(), '藍牙連線', version, 8000);
      } catch (error) {
        if (error.code === 'connection_timeout' || !options.auto || !this.device.watchAdvertisements || version !== this.connectionVersion) throw error;
        // Some hosts need a fresh advertisement before reconnecting a granted device.
        await this.waitForAdvertisement(this.device);
        server = await this.connectionStep(this.device.gatt.connect(), '藍牙重連', version, Math.max(1, deadline - Date.now()));
      }
      if (version !== this.connectionVersion) throw new Error('連線已取消');
      this.onChange('藍牙已連接，正在讀取列印通道');
      const candidates = [];
      let foundServices = 0;
      for (const uuid of services) {
        let service;
        try {
          service = await this.connectionStep(server.getPrimaryService(uuid), '讀取 BLE 服務', version, Math.max(1, deadline - Date.now()));
        } catch (error) {
          if (error.code === 'connection_timeout' || version !== this.connectionVersion) throw error;
          continue;
        }
        foundServices++;
        for (const characteristic of await this.connectionStep(service.getCharacteristics(), '讀取列印通道', version, Math.max(1, deadline - Date.now()))) {
          if (characteristic.properties.write || characteristic.properties.writeWithoutResponse) candidates.push(characteristic);
        }
      }
      if (!candidates.length) throw new Error(foundServices
        ? '找到 BLE 服務但沒有可寫入通道，需確認印表機的列印 Service UUID'
        : '已連接 BLE，但尚未找到列印服務；請用 Chrome 藍牙檢查頁確認 Service UUID');
      if (version !== this.connectionVersion) throw new Error('連線已取消');
      this.onChange(`已連線：${this.device.name || '藍牙印表機'}，請選擇列印通道並試印`);
      return candidates;
    } catch (error) {
      if (version === this.connectionVersion) {
        this.disconnect();
        this.onChange(error.message);
      }
      throw error;
    }
  }

  disconnect() {
    if (this.busy) throw new Error('列印中，請稍候');
    this.connectionVersion++;
    this.cancelStep?.();
    this.scanAbort?.abort();
    if (this.device && this.disconnectHandler) this.device.removeEventListener('gattserverdisconnected', this.disconnectHandler);
    this.disconnectHandler = null;
    this.characteristic = null;
    this.device?.gatt?.disconnect();
  }

  async connectionStep(operation, label, version, timeout) {
    let timer;
    let cancel;
    try {
      return await Promise.race([operation, new Promise((resolve, reject) => {
        cancel = () => reject(new Error('連線已取消'));
        this.cancelStep = cancel;
        timer = setTimeout(() => {
          const error = new Error(`${label}逾時，請關閉其他裝置的連線、重開出單機，再按「連接印表機」`);
          error.code = 'connection_timeout';
          reject(error);
        }, timeout);
        if (version !== this.connectionVersion) cancel();
      })]);
    } finally {
      clearTimeout(timer);
      if (this.cancelStep === cancel) this.cancelStep = null;
    }
  }

  async waitForAdvertisement(device) {
    const controller = new AbortController();
    this.scanAbort = controller;
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          device.removeEventListener('advertisementreceived', received);
          controller.signal.removeEventListener('abort', cancelled);
          error ? reject(error) : resolve();
        };
        const received = () => finish();
        const cancelled = () => finish(new Error('連線已取消'));
        const timer = setTimeout(() => finish(new Error('未收到出單機訊號，請確認電源及是否被其他裝置連接')), 8000);
        device.addEventListener('advertisementreceived', received);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        device.watchAdvertisements({ signal: controller.signal }).catch(finish);
      });
    } finally { controller.abort(); this.scanAbort = null; }
  }

  async printEncoded(base64) {
    if (!this.connected) throw new Error('請先連接藍牙印表機並選擇列印通道');
    if (this.busy) throw new Error('另一張單據正在列印，請稍候再試');
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (!bytes.length) throw new Error('單據資料是空白');
    this.busy = true;
    try { await this.write(bytes); } finally { this.busy = false; }
  }

  async print(text) {
    if (!this.connected) throw new Error('請先連接藍牙印表機並選擇列印通道');
    if (this.busy) throw new Error('另一張單據正在列印，請稍候再試');
    this.busy = true;
    try {
      await document.fonts.ready;
      const canvas = BluetoothReceiptPrinter.raster(text);
      const ctx = canvas.getContext('2d');
      await this.write(Uint8Array.of(0x1b, 0x40));
      if (canvas.height > 65535) throw new Error('單據過長，請拆分列印');
      // Continuous mode sends one raster command rather than stopping at each band.
      const bandHeight = this.speed === 'continuous' ? canvas.height : 24;
      for (let y = 0; y < canvas.height; y += bandHeight) {
        const height = Math.min(bandHeight, canvas.height - y);
        const pixels = ctx.getImageData(0, y, 384, height).data;
        const bytes = new Uint8Array(8 + 48 * height);
        bytes.set([0x1d, 0x76, 0x30, 0, 48, 0, height & 255, height >> 8]);
        for (let i = 0; i < 384 * height; i++) {
          if (pixels[i * 4] < 160) bytes[8 + (i >> 3)] |= 0x80 >> (i & 7);
        }
        await this.write(bytes);
        if (this.speed !== 'continuous') await new Promise(resolve => setTimeout(resolve, 35));
      }
      await this.write(Uint8Array.of(0x1b, 0x64, 4));
    } finally { this.busy = false; }
  }

  async write(bytes) {
    const properties = this.characteristic?.properties;
    let noResponse = properties?.writeWithoutResponse
      && (this.profile === 'android' && this.speed !== 'stable' || this.speed === 'balanced' || !properties.write);
    if (this.writeMode === 'response') {
      if (!properties?.write) throw new Error('此通道不支援等待回覆，請改用自動模式');
      noResponse = false;
    } else if (this.writeMode === 'noResponse') {
      if (!properties?.writeWithoutResponse) throw new Error('此通道不支援免回覆，請改用自動模式');
      noResponse = true;
    }
    const delay = Math.max(this.packetDelay, { continuous: 0, balanced: 6, stable: 12 }[this.speed], noResponse ? 2 : 0);
    for (let offset = 0; offset < bytes.length; offset += 20) {
      if (!this.connected) throw new Error('藍牙中斷，單據可能只印出一部分；請檢查後補印');
      const chunk = bytes.slice(offset, offset + 20);
      if (noResponse) await this.characteristic.writeValueWithoutResponse(chunk);
      else await this.characteristic.writeValueWithResponse(chunk);
      // Response writes provide pacing. No-response-only devices still need a buffer margin.
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  static raster(text) {
    if (Array.isArray(text)) return BluetoothReceiptPrinter.rasterRows(text);
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    const ctx = canvas.getContext('2d');
    ctx.font = '18px monospace';
    const lines = [];
    for (const source of String(text).replace(/\f/g, '').split('\n')) {
      let line = '';
      for (const char of source) {
        if (ctx.measureText(line + char).width > 360 && line) { lines.push(line); line = ''; }
        line += char;
      }
      lines.push(line);
    }
    canvas.height = Math.max(48, lines.length * 26 + 24);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = '18px monospace';
    ctx.textBaseline = 'top';
    lines.forEach((line, index) => ctx.fillText(line, 12, 12 + index * 26));
    return canvas;
  }

  static rasterRows(rows) {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = rows.reduce((sum, row) => sum + 24 * row.height + 6, 0) + 24;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    let y = 12;
    for (const row of rows) {
      ctx.save();
      ctx.font = `${row.bold ? 'bold ' : ''}24px monospace`;
      // Browser fonts differ from printer fonts; constrain the measured width to the paper.
      const sx = Math.min(row.scale, 384 / Math.max(1, ctx.measureText(row.text).width));
      const width = ctx.measureText(row.text).width * sx;
      const x = row.align === 'center' ? (384 - width) / 2 : row.align === 'right' ? 384 - width : 0;
      ctx.translate(x, y);
      ctx.scale(sx, row.height);
      ctx.fillText(row.text, 0, 0);
      ctx.restore();
      y += 24 * row.height + 6;
    }
    return canvas;
  }
}
window.BluetoothReceiptPrinter = BluetoothReceiptPrinter;
