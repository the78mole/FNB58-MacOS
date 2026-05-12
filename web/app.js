/*
 * FNB58 Web Monitor – Browser-only edition
 *
 * Talks to a FNIRSI FNB58 directly from the browser using:
 *   - Web Bluetooth API (BLE)
 *   - WebUSB API (USB)
 *
 * Protocol parsing is ported from the Python reference implementation in
 *   device/bluetooth_reader.py
 *   device/usb_reader.py
 */

// ---------------------------------------------------------------------------
// Constants (kept in sync with the Python implementation)
// ---------------------------------------------------------------------------

// Bluetooth LE
const BLE_SERVICE_UUID = 0xffe0; // FNB58 uses a 16-bit service that contains the two 128-bit characteristics
const BLE_WRITE_UUID  = '0000ffe9-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_UUID = '0000ffe4-0000-1000-8000-00805f9b34fb';
const BLE_INIT_COMMANDS = [
  new Uint8Array([0xaa, 0x81, 0x00, 0xf4]),
  new Uint8Array([0xaa, 0x82, 0x00, 0xa7]),
];

// USB
const USB_VENDOR_ID = 0x0716;
const USB_PRODUCT_IDS = [0x5030, 0x5031]; // FNB48S, FNB58
const USB_KEEPALIVE = (() => {
  // b"\xaa\x83" + b"\x00" * 61 + b"\x9e"
  const buf = new Uint8Array(64);
  buf[0] = 0xaa;
  buf[1] = 0x83;
  buf[63] = 0x9e;
  return buf;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_POINTS = 500;
const $ = (id) => document.getElementById(id);

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function setConnected(connected, mode = '') {
  $('btn-disconnect').disabled = !connected;
  $('btn-ble').disabled = connected;
  $('btn-usb').disabled = connected;
  $('mode-label').textContent = connected ? `Verbunden (${mode})` : 'Nicht verbunden';
}

function fmt(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

function logError(prefix, err) {
  console.error(prefix, err);
  setStatus(`${prefix}: ${err.message || err}`, 'error');
}

// ---------------------------------------------------------------------------
// Chart setup
// ---------------------------------------------------------------------------

const charts = {};

function makeChart(canvasId, label, color, yLabel) {
  const ctx = $(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + '33',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: 'linear',
          ticks: { color: '#9ca3af', maxTicksLimit: 6, callback: (v) => `${v.toFixed(1)}s` },
          grid: { color: '#1f2937' },
        },
        y: {
          ticks: { color: '#9ca3af' },
          grid: { color: '#1f2937' },
          title: { display: true, text: yLabel, color: '#9ca3af' },
        },
      },
      plugins: {
        legend: { labels: { color: '#e5e7eb' } },
      },
    },
  });
}

function initCharts() {
  charts.voltage = makeChart('chart-voltage', 'Spannung (V)', '#60a5fa', 'V');
  charts.current = makeChart('chart-current', 'Strom (A)',    '#f87171', 'A');
  charts.power   = makeChart('chart-power',   'Leistung (W)', '#34d399', 'W');
}

let firstTimestamp = null;

function pushReading(reading) {
  const now = performance.now() / 1000;
  if (firstTimestamp === null) firstTimestamp = now;
  const t = now - firstTimestamp;

  const pairs = [
    ['voltage', reading.voltage],
    ['current', reading.current],
    ['power', reading.power],
  ];

  for (const [key, value] of pairs) {
    const ds = charts[key].data.datasets[0].data;
    ds.push({ x: t, y: value });
    if (ds.length > MAX_POINTS) ds.shift();
    charts[key].update('none');
  }

  $('value-voltage').textContent     = fmt(reading.voltage, 4) + ' V';
  $('value-current').textContent     = fmt(reading.current, 4) + ' A';
  $('value-power').textContent       = fmt(reading.power, 4) + ' W';
  $('value-dp').textContent          = fmt(reading.dp, 3) + ' V';
  $('value-dn').textContent          = fmt(reading.dn, 3) + ' V';
  $('value-temp').textContent        = fmt(reading.temperature, 1) + ' °C';
}

// ---------------------------------------------------------------------------
// Bluetooth driver
// ---------------------------------------------------------------------------

class BleDriver {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  static available() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  async connect(onReading) {
    if (!BleDriver.available()) {
      throw new Error('Web Bluetooth wird von diesem Browser nicht unterstützt');
    }

    setStatus('Scanne nach FNB58 …');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'FNB' }],
      optionalServices: [BLE_SERVICE_UUID, BLE_WRITE_UUID, BLE_NOTIFY_UUID],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      setStatus('Bluetooth getrennt', 'warn');
      setConnected(false);
    });

    setStatus(`Verbinde zu ${this.device.name || this.device.id} …`);
    const server = await this.device.gatt.connect();

    // Find the service that contains the characteristics. Different firmware
    // revisions of the FNB58 advertise the characteristics under different
    // 128-bit services, so try the well-known 0xffe0 service first and then
    // fall back to scanning all primary services.
    let service;
    try {
      service = await server.getPrimaryService(BLE_SERVICE_UUID);
    } catch (_) {
      const services = await server.getPrimaryServices();
      for (const s of services) {
        try {
          await s.getCharacteristic(BLE_NOTIFY_UUID);
          service = s;
          break;
        } catch (_) { /* keep looking */ }
      }
      if (!service) throw new Error('FNB58 GATT service nicht gefunden');
    }

    this.writeChar  = await service.getCharacteristic(BLE_WRITE_UUID);
    this.notifyChar = await service.getCharacteristic(BLE_NOTIFY_UUID);

    this.notifyChar.addEventListener('characteristicvaluechanged', (evt) => {
      const reading = this._parse(evt.target.value);
      if (reading) onReading(reading);
    });
    await this.notifyChar.startNotifications();

    for (const cmd of BLE_INIT_COMMANDS) {
      await this.writeChar.writeValue(cmd);
      await new Promise((r) => setTimeout(r, 100));
    }

    setStatus(`Bluetooth verbunden: ${this.device.name || this.device.id}`, 'ok');
    setConnected(true, 'Bluetooth');
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      try { await this.notifyChar.stopNotifications(); } catch (_) {}
      this.device.gatt.disconnect();
    }
    this.device = this.writeChar = this.notifyChar = null;
  }

  /**
   * Parse a notification packet.
   *
   * Mirrors device/bluetooth_reader.py::_parse_data:
   *   offset 21, 3 × signed little-endian int32, scale 1/10000.
   */
  _parse(dataView) {
    const OFFSET = 21;
    const SCALE = 10000;
    if (dataView.byteLength < OFFSET + 12) return null;

    const voltage = dataView.getInt32(OFFSET + 0, true) / SCALE;
    const current = dataView.getInt32(OFFSET + 4, true) / SCALE;
    const power   = dataView.getInt32(OFFSET + 8, true) / SCALE;

    if (voltage < 0 || voltage > 150) return null;

    return {
      timestamp: Date.now(),
      voltage,
      current,
      power,
      dp: 0,
      dn: 0,
      temperature: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// USB driver
// ---------------------------------------------------------------------------

class UsbDriver {
  constructor() {
    this.device = null;
    this.epIn = null;
    this.epOut = null;
    this.interfaceNumber = 0;
    this.reading = false;
    this.isFnb58 = false;
  }

  static available() {
    return !!(navigator.usb && navigator.usb.requestDevice);
  }

  async connect(onReading) {
    if (!UsbDriver.available()) {
      throw new Error('WebUSB wird von diesem Browser nicht unterstützt');
    }

    setStatus('Wähle FNB58 USB-Gerät …');
    this.device = await navigator.usb.requestDevice({
      filters: USB_PRODUCT_IDS.map((productId) => ({ vendorId: USB_VENDOR_ID, productId })),
    });

    await this.device.open();
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    // Locate the interface and bulk/interrupt endpoints.
    const cfg = this.device.configuration;
    let chosen = null;
    for (const intf of cfg.interfaces) {
      const alt = intf.alternates[0];
      const epIn  = alt.endpoints.find((e) => e.direction === 'in');
      const epOut = alt.endpoints.find((e) => e.direction === 'out');
      if (epIn && epOut) {
        chosen = { interfaceNumber: intf.interfaceNumber, epIn, epOut };
        break;
      }
    }
    if (!chosen) throw new Error('Keine USB-Endpoints gefunden');

    this.interfaceNumber = chosen.interfaceNumber;
    this.epIn = chosen.epIn.endpointNumber;
    this.epOut = chosen.epOut.endpointNumber;

    await this.device.claimInterface(this.interfaceNumber);
    this.isFnb58 = this.device.productId === 0x5031;

    setStatus(`USB verbunden: ${this.device.productName || 'FNIRSI'}`, 'ok');
    setConnected(true, 'USB');

    this.reading = true;
    this._readLoop(onReading).catch((err) => logError('USB Lesefehler', err));
  }

  async disconnect() {
    this.reading = false;
    if (this.device) {
      try { await this.device.releaseInterface(this.interfaceNumber); } catch (_) {}
      try { await this.device.close(); } catch (_) {}
    }
    this.device = null;
  }

  async _readLoop(onReading) {
    // Refresh interval depends on device type (mirrors usb_reader.py)
    const refreshMs = this.isFnb58 ? 1000 : 3;
    let nextSend = performance.now();

    while (this.reading) {
      try {
        const result = await this.device.transferIn(this.epIn, 64);
        if (result.status === 'ok' && result.data && result.data.byteLength >= 1) {
          const readings = this._decodePacket(result.data);
          for (const r of readings) onReading(r);
        }

        const now = performance.now();
        if (now >= nextSend) {
          nextSend = now + refreshMs;
          await this.device.transferOut(this.epOut, USB_KEEPALIVE);
        }
      } catch (err) {
        if (this.reading) {
          console.warn('USB Transferfehler:', err);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }

  /**
   * Decode a 64-byte HID packet into up to 4 readings.
   * Mirrors device/usb_reader.py::_decode_packet.
   */
  _decodePacket(dataView) {
    const readings = [];
    const offsets = [1, 17, 33, 49];

    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i];
      if (off + 14 >= dataView.byteLength) break;

      const voltage = dataView.getUint32(off + 0, true) / 100000.0;
      const current = dataView.getUint32(off + 4, true) / 100000.0;
      const dp      = dataView.getUint16(off + 8, true) / 1000.0;
      const dn      = dataView.getUint16(off + 10, true) / 1000.0;
      const temp    = dataView.getUint16(off + 13, true) / 10.0;
      const power   = voltage * current;

      readings.push({
        timestamp: Date.now(),
        voltage,
        current,
        power,
        dp,
        dn,
        temperature: temp,
        sample: i,
      });
    }
    return readings;
  }
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

let activeDriver = null;

async function connectBle() {
  if (activeDriver) return;
  const driver = new BleDriver();
  try {
    await driver.connect(pushReading);
    activeDriver = driver;
  } catch (err) {
    logError('Bluetooth-Verbindung fehlgeschlagen', err);
  }
}

async function connectUsb() {
  if (activeDriver) return;
  const driver = new UsbDriver();
  try {
    await driver.connect(pushReading);
    activeDriver = driver;
  } catch (err) {
    logError('USB-Verbindung fehlgeschlagen', err);
  }
}

async function disconnect() {
  if (!activeDriver) return;
  try {
    await activeDriver.disconnect();
  } catch (err) {
    console.warn(err);
  }
  activeDriver = null;
  firstTimestamp = null;
  setStatus('Getrennt', 'info');
  setConnected(false);
}

function checkSupport() {
  const bleOk = BleDriver.available();
  const usbOk = UsbDriver.available();

  $('btn-ble').disabled = !bleOk;
  $('btn-usb').disabled = !usbOk;

  const notes = [];
  if (!bleOk) notes.push('Web Bluetooth nicht verfügbar');
  if (!usbOk) notes.push('WebUSB nicht verfügbar');
  if (!window.isSecureContext) notes.push('Seite muss über HTTPS oder localhost geöffnet werden');

  if (notes.length) {
    $('support-note').textContent = notes.join(' · ');
    $('support-note').classList.remove('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  checkSupport();
  $('btn-ble').addEventListener('click', connectBle);
  $('btn-usb').addEventListener('click', connectUsb);
  $('btn-disconnect').addEventListener('click', disconnect);
});
