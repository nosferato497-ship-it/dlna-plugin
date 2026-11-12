# Changelog

## 0.6.5 — Android return permission (2026-11-07)

- Published for limited Xiaomi testing, with manual device verification pending.
- Allow a subsequent separate selection after matching external, a full hidden/visible cycle, document focus and ownership of the original folder in the same catalog instance.
- Invalidate the cycle on folder/Activity changes and UI coverage. Keep manual recovery available.
- Require fresh input, rejecting residual keyup, held OK and stale clicks. Allow resource selection after permission through OK and pointer.
- Record auto-return-unconfirmed abandonment. Preserve the late native p2 → p1 launch risk and accepted Home-return behavior.
- Validate 435 tests against the release copy, Node syntax, Acorn 8.18.0 ES5 and version-normalized source equality.

## 0.6.4 — Return diagnostics

- Add bounded observation of visibility, document focus, controller ownership and catalog/folder generations around Android playback.
- Keep playback lock and manual recovery rules during observation.

## 0.6.3 — Catalog Back and Android recovery

- Return from catalog root to DLNA Bridge settings after leaving the catalog Activity. Preserve nested-folder and resource Back navigation.
- Restore usability when backward produces no transition, subject to catalog ownership.
- Preserve explicit recovery confirmation and a separate subsequent video selection.
- Limited Xiaomi observations confirmed root/nested Back, repeated catalog/settings cycles and recovery behavior. See docs/architecture.md for evidence boundaries.

## 0.6.0–0.6.2 — Component UI and lifecycle development

- Introduce a catalog Activity and playback ownership independent of component lifetime.
- Add Android pending-launch protection, recovery, lifecycle diagnostics and regression coverage.
- Share the lampa_dlna_bridge_060 GUARD across the 0.6.x copies.

## 0.5.9 — Multiple DLNA resources

- Preserve every distinct valid HTTP(S) `res` resource and its available protocol, MIME, size, duration, resolution, and bitrate metadata.
- Open the native Lampa Select menu only when an item has multiple resources; play a single resource directly and retain legacy URL fallback.
- Show the resource count in the catalog row of a multi-resource item instead of the metadata of only one resource.
- Skip auxiliary `res` entries (`image/*`, `text/*`, subtitle MIME types such as MiniDLNA captions and `JPEG_TN` thumbnails) so they are never offered as playable resources; legacy `url`/`mime`/`size`/`duration` fields now describe the first playable resource.
- Add resource parsing, validation, selection, Back, and playback regression tests.

## 0.5.8 — Network reliability

- Guard native request completion so success or error is delivered no more than once, including synchronous transport exceptions and cleanup failures.
- Ignore stale Browse responses after DLNA navigation, closing the catalog, or leaving its Lampa Settings component.
- Validate `TotalMatches` on every page and reject changing counts or incomplete results without caching them.
- Keep the 200-item page size, 5000-item safety cap, SOAP request format, and direct player URL handoff.
- Add network reliability and Settings lifecycle regression tests.

## 0.5.7 — AndroidJS API inspection

- Extend the read-only AndroidJS diagnostics with metadata and bounded function source for `httpReq`, `get`, `getResp`, and `dump`; the methods are never invoked.
- Report missing methods and accessor properties without reading them. No network or UDP probes are performed.

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
