# Changelog

## 0.5.3 — Lampa Back API diagnostics

- Added capability diagnostics for `Lampa.Keypad` and `Lampa.Controller` while the DLNA menu is open.
- Subscribed to `Lampa.Keypad.listener`'s `back` event and display its code, source DOM event, and active controller when available.
- Prevented duplicate subscriptions and remove the listener on menu close when `listener.remove()` is available; otherwise the inactive callback is safely ignored.
- Kept the existing DOM key diagnostics and DLNA behavior unchanged.

## 0.3.1 — Settings compatibility fix

- Added the required empty `values` property to the Lampa `input` setting definition.
- Bumped the plugin load guard and diagnostic version.
- Addresses a likely settings-rendering failure seen on Xiaomi Mi Box S 4K. Device confirmation is still required.

## 0.3.0 — Diagnostic scaffold

- Added Lampa settings component.
- Added runtime capability diagnostics.
- Added manual HTTP device-description probe using Lampa.Reguest.native().
- Explicitly documented that SSDP, SOAP, catalog browsing, casting and track selection are not implemented.

This remains a diagnostic development snapshot, not a feature-complete DLNA plugin.
