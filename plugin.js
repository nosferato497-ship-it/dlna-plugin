/* Lampa DLNA Bridge — Kodi Renderer Probe 0.3.3
 * ES5-compatible diagnostic scaffold. No APK, PC, NAS or external bridge required.
 * This build deliberately does NOT claim SSDP discovery or SOAP control until the
 * AndroidJS/network capabilities and CORS behaviour are verified on the target box.
 */
(function () {
    'use strict';

    if (window.lampa_dlna_bridge_033) return;
    window.lampa_dlna_bridge_033 = true;

    var COMPONENT = 'dlna_bridge';
    var PREFIX = 'dlna_bridge_';

    function notify(message, style) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
            Lampa.Noty.show(message, { style: style || 'default', time: 30000 });
        } else if (window.console) {
            console.log('[DLNA Bridge] ' + message);
        }
    }

    function getValue(key, fallback) {
        try {
            var value = Lampa.Storage.field(PREFIX + key);
            return value === undefined || value === null ? fallback : value;
        } catch (e) {
            return fallback;
        }
    }

    function inspectRuntime() {
        var result = {
            userAgent: navigator.userAgent || 'unknown',
            androidJS: typeof window.AndroidJS !== 'undefined',
            androidGetLampaURL: false,
            fetch: typeof window.fetch === 'function',
            xhr: typeof window.XMLHttpRequest === 'function',
            webSocket: typeof window.WebSocket === 'function',
            udpSocket: false,
            ssdp: 'not available in standard browser JavaScript'
        };

        try {
            result.androidGetLampaURL = !!(window.AndroidJS && typeof window.AndroidJS.getLampaURL === 'function');
        } catch (e) {}

        return result;
    }

    function showDiagnostics() {
        var r = inspectRuntime();
        var lines = [
            'Lampa DLNA Bridge 0.3.3 — Kodi test',
            'AndroidJS: ' + (r.androidJS ? 'есть' : 'нет'),
            'AndroidJS.getLampaURL: ' + (r.androidGetLampaURL ? 'есть' : 'нет'),
            'Fetch: ' + (r.fetch ? 'есть' : 'нет'),
            'XMLHttpRequest: ' + (r.xhr ? 'есть' : 'нет'),
            'WebSocket: ' + (r.webSocket ? 'есть' : 'нет'),
            'SSDP UDP multicast: не подтверждён',
            'Kodi IP: 192.168.1.68; тест URL: порт 1234 / upnpms/device.xml'
        ];
        notify(lines.join('\n'));
        if (window.console && console.log) console.log('[DLNA Bridge diagnostics]', r);
    }

    function validateHttpUrl(value) {
        return /^https?:\/\//i.test(value || '');
    }

    function probeDescription() {
        var url = getValue('description_url', 'http://192.168.1.68:1234/upnpms/device.xml');
        if (!url || !validateHttpUrl(url)) {
            notify('Укажите полный HTTP/HTTPS URL XML-описания DLNA-устройства.', 'warning');
            return;
        }

        if (!Lampa.Reguest) {
            notify('В этой сборке Lampa не найден HTTP-клиент Reguest.', 'error');
            return;
        }

        var request = new Lampa.Reguest();
        if (request.timeout) request.timeout(10000);

        request.native(url, function (raw) {
            var responseText = typeof raw === 'string' ? raw : String(raw || '');
            var isXml = /<\s*(?:\w+:)?root\b/i.test(responseText) || /<\?xml/i.test(responseText);
            var hasAvTransport = /AVTransport/i.test(responseText);
            var hasContentDirectory = /ContentDirectory/i.test(responseText);
            var summary = 'HTTP-ответ получен; XML: ' + (isXml ? 'похоже на XML' : 'не распознан') +
                '; AVTransport: ' + (hasAvTransport ? 'есть' : 'нет') +
                '; ContentDirectory: ' + (hasContentDirectory ? 'есть' : 'нет') +\n                '; Адрес: ' + url;
            notify(summary, 'success');
            if (window.console && console.log) console.log('[DLNA Bridge description]', responseText);
            if (request.clear) request.clear();
        }, function (xhr, error) {
            var status = xhr && xhr.status ? xhr.status : 'нет HTTP-статуса';
            notify('Не удалось прочитать описание устройства (' + status + '). Возможны CORS, HTTP/HTTPS или сетевые ограничения.', 'error');
            if (window.console && console.warn) console.warn('[DLNA Bridge probe failed]', error, xhr);
            if (request.clear) request.clear();
        }, null, { dataType: 'text', timeout: 10000 });
    }

    function init() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.Storage) return;

        Lampa.Lang.add({
            dlna_bridge_title: { ru: 'DLNA Bridge — автономный режим', en: 'DLNA Bridge — standalone mode' },
            dlna_bridge_info: { ru: 'Проверяем Kodi на 192.168.1.68. Автопоиск SSDP пока не подтверждён.', en: 'Testing Kodi at 192.168.1.68. SSDP discovery is not yet verified.' },
            dlna_bridge_url: { ru: 'URL XML-описания устройства', en: 'Device description XML URL' },
            dlna_bridge_test: { ru: 'Проверить HTTP-доступ', en: 'Test HTTP access' },
            dlna_bridge_runtime: { ru: 'Диагностика среды', en: 'Runtime diagnostics' }
        });

        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: Lampa.Lang.translate('dlna_bridge_title'),
            icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 9h10M7 12h6"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'description_url', type: 'input', values: '', default: 'http://192.168.1.68:1234/upnpms/device.xml', placeholder: 'http://192.168.1.68:1234/upnpms/device.xml' },
            field: { name: Lampa.Lang.translate('dlna_bridge_url'), description: Lampa.Lang.translate('dlna_bridge_info') }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'runtime_check', type: 'trigger', default: false },
            field: { name: Lampa.Lang.translate('dlna_bridge_runtime') },
            onChange: function () { showDiagnostics(); }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'http_check', type: 'trigger', default: false },
            field: { name: Lampa.Lang.translate('dlna_bridge_test') },
            onChange: function () { probeDescription(); }
        });

        showDiagnostics();
    }

    if (window.appready) init();
    else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') init();
        });
    }
})();
