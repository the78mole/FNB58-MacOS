# FNB58 Web Monitor (Browser-Edition)

Statische, server-lose Variante des FNB58 Web Monitors. Kommuniziert direkt
aus dem Browser per **Web Bluetooth** oder **WebUSB** mit dem FNIRSI FNB58.

Diese Variante wird über GitHub Pages publiziert (siehe
`.github/workflows/pages.yml`) und benötigt weder Python noch Docker.

## Lokale Vorschau

```bash
# Einfacher statischer Server (Python 3)
python3 -m http.server -d web 8000
# Anschließend http://localhost:8000 öffnen.
```

> Web Bluetooth und WebUSB funktionieren nur in einem *secure context*,
> also über HTTPS oder `localhost`.

## Browser-Unterstützung

| API           | Chrome / Edge / Opera | Firefox | Safari |
| ------------- | --------------------- | ------- | ------ |
| Web Bluetooth | ✅                    | ❌      | ❌     |
| WebUSB        | ✅                    | ❌      | ❌     |

Unter Linux benötigt WebUSB ggf. eine udev-Regel für die Vendor-ID `0x0716`.
Unter Windows kann WinUSB als Treiber benötigt werden (z. B. via Zadig).

## Implementierung

Die Protokoll-Parser sind direkte Ports der Python-Referenzimplementierung:

- BLE-Frames → `device/bluetooth_reader.py::_parse_data`
- USB-HID-Pakete → `device/usb_reader.py::_decode_packet`
