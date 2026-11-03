# Changelog

## 0.5.6 — Android bridge diagnostics

- Verify registration outcomes through SettingsApi getters, keep uncertain steps from duplicating entries, isolate optional AndroidJS registration, and use the correct 0.5.6 component label.
- Added a Lampa settings action to inspect only the known Android bridge globals.
- Report property and method types plus bounded prototype information without invoking bridge methods or reading accessor properties.
- Added bounded diagnostics with exception handling; no network or UDP probes are performed.

## 0.5.5 — Restore DLNA settings focus after playback

- Restore the controller that opened the Select after folder selection and Back, so folder navigation keeps its Lampa context.
- Use `Lampa.Player.callback()` to return to the originating controller when playback closes, with a player-close listener fallback.
- Keep the catalog cache across menu openings; users can still clear it with the existing cache action.
- Bump the plugin version and load guard.

## 0.5.4 — Native Lampa Select menu

- Replaced the primary hand-built catalog menu with `Lampa.Select.show()` using its documented `{ title, items, onSelect, onBack }` contract.
- Back inside a folder opens its parent; Back at the catalog root closes Select and lets Lampa restore the prior controller focus.
- Kept the previous DOM menu as a fallback when the Select/Controller APIs are missing or incompatible.
- Preserved the Back API diagnostic panel in the native Select menu and bumped the plugin guard/version.
- Run the native Select item callback immediately after Lampa closes the menu; avoid broad `closeAll()` cleanup if Select initialization throws.
- Left SOAP Browse, pagination/cache, DIDL-Lite parsing, and playback unchanged.

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
