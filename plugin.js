/* Lampa DLNA Bridge 0.4.2
 * Native Lampa.Reguest transport + ContentDirectory Browse + DIDL-Lite navigation.
 * No SSDP discovery: the router server is configured by address.
 */
(function () {
    'use strict';

    var GUARD = 'lampa_dlna_bridge_042';
    if (window[GUARD]) return;
    window[GUARD] = true;

    var COMPONENT = 'dlna_bridge';
    var PREFIX = 'dlna_bridge_';
    var DEFAULT_BASE = 'http://192.168.1.1:8200';
    var SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    var PAGE_SIZE = 200;
    var MAX_ITEMS = 5000;
    var cache = {};
    var currentRequest = null;

    function errorText(error) {
        if (error === null || error === undefined) return 'неизвестная ошибка (пустой ответ обработчика)';
        if (typeof error === 'string') return error;
        if (error.message) return error.message;
        try { return JSON.stringify(error); } catch (e) { return String(error); }
    }

    function notify(message, style) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
            Lampa.Noty.show(message, { style: style || 'default', time: 7000 });
        } else if (window.console) console.log('[DLNA Bridge] ' + message);
    }

    function setting(name, fallback) {
        try {
            var value = Lampa.Storage.field(PREFIX + name);
            return value === undefined || value === null || value === '' ? fallback : value;
        } catch (e) { return fallback; }
    }

    function baseUrl() {
        return String(setting('server_url', DEFAULT_BASE)).replace(/\/+$/, '');
    }

    function requestNative(url, body, headers, success, failure) {
        if (!Lampa.Reguest) {
            failure(new Error('Lampa.Reguest недоступен'));
            return;
        }
        var req = new Lampa.Reguest();
        currentRequest = req;
        try { if (req.timeout) req.timeout(20000); } catch (e) {}
        req.native(url, function (raw) {
            if (currentRequest === req) currentRequest = null;
            if (req.clear) req.clear();
            success(typeof raw === 'string' ? raw : String(raw || ''));
        }, function (xhr, error) {
            if (currentRequest === req) currentRequest = null;
            if (req.clear) req.clear();
            failure(new Error((xhr && xhr.status ? 'HTTP ' + xhr.status + ': ' : '') + (errorText(error) || 'ошибка запроса')));
        }, body || null, {
            dataType: 'text',
            timeout: 20000,
            headers: headers || {}
        });
    }

    function xmlEscape(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function textOf(node, tag) {
        var list = node.getElementsByTagName(tag);
        if (!list || !list.length) {
            var all = node.getElementsByTagName('*');
            for (var i = 0; i < all.length; i++) {
                if (all[i].localName === tag) return all[i].textContent || '';
            }
            return '';
        }
        return list[0].textContent || '';
    }

    function parseXml(raw) {
        if (!window.DOMParser) throw new Error('DOMParser недоступен в WebView');
        var doc = new DOMParser().parseFromString(raw, 'text/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('Ответ не является корректным XML: ' + String(raw).slice(0, 180));
        return doc;
    }

    function decodeDidl(encoded) {
        var doc = parseXml('<root>' + encoded + '</root>');
        var nodes = doc.getElementsByTagName('*');
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var kind = node.localName || node.nodeName.split(':').pop();
            if (kind !== 'container' && kind !== 'item') continue;
            var entry = {
                id: node.getAttribute('id') || '',
                parentID: node.getAttribute('parentID') || '',
                title: '',
                isFolder: kind === 'container',
                childCount: parseInt(node.getAttribute('childCount') || '0', 10),
                url: '',
                protocolInfo: '',
                mime: '',
                duration: '',
                size: 0
            };
            for (var j = 0; j < node.childNodes.length; j++) {
                var child = node.childNodes[j];
                if (child.nodeType !== 1) continue;
                var name = child.localName || child.nodeName.split(':').pop();
                if (name === 'title') entry.title = child.textContent || '';
                if (name === 'res') {
                    entry.url = child.textContent || '';
                    entry.protocolInfo = child.getAttribute('protocolInfo') || '';
                    entry.duration = child.getAttribute('duration') || '';
                    entry.size = parseInt(child.getAttribute('size') || '0', 10);
                }
            }
            var p = entry.protocolInfo.split(':');
            entry.mime = p.length > 2 ? p[2] : '';
            if (entry.title) items.push(entry);
        }
        return items;
    }

    function soapBrowse(objectId, start, count, success, failure) {
        var body = '<?xml version="1.0" encoding="utf-8"?>' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:Browse xmlns:u="' + SERVICE + '">' +
            '<ObjectID>' + xmlEscape(objectId) + '</ObjectID>' +
            '<BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>' +
            '<StartingIndex>' + start + '</StartingIndex><RequestedCount>' + count + '</RequestedCount>' +
            '<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>';
        requestNative(baseUrl() + '/ctl/ContentDir', body, {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': '"' + SERVICE + '#Browse"'
        }, function (raw) {
            try {
                var doc = parseXml(raw);
                var faults = doc.getElementsByTagName('Fault');
                if (faults.length) throw new Error(textOf(faults[0], 'faultstring') || 'SOAP Fault');
                var result = '';
                var resultNodes = doc.getElementsByTagName('Result');
                if (!resultNodes.length) {
                    var all = doc.getElementsByTagName('*');
                    for (var i = 0; i < all.length; i++) {
                        if (all[i].localName === 'Result') { result = all[i].textContent || ''; break; }
                    }
                } else result = resultNodes[0].textContent || '';
                var total = parseInt(textOf(doc.documentElement, 'TotalMatches') || '0', 10);
                var update = textOf(doc.documentElement, 'UpdateID') || '';
                success(decodeDidl(result), total, update);
            } catch (e) {
                if (window.console && console.error) console.error('[DLNA Bridge] Browse response parse failed', e, raw);
                failure(new Error('Разбор ответа SOAP/DIDL: ' + errorText(e)));
            }
        }, failure);
    }

    function browseAll(objectId, callback) {
        if (cache[objectId]) { callback(null, cache[objectId].slice()); return; }
        var collected = [];
        var offset = 0;
        function page() {
            soapBrowse(objectId, offset, PAGE_SIZE, function (items, total) {
                collected = collected.concat(items);
                offset += items.length;
                if (offset < total && items.length && offset < MAX_ITEMS) page();
                else {
                    cache[objectId] = collected.slice();
                    callback(null, collected);
                }
            }, function (error) { callback(error); });
        }
        page();
    }

    function openSelect(title, entries, onSelect, onBack) {
        if (!Lampa.Select || !Lampa.Select.show) {
            notify('В этой версии Lampa не найден интерфейс Select.', 'error');
            return;
        }
        Lampa.Select.show({
            title: title,
            items: entries,
            onSelect: onSelect,
            onBack: onBack || function () {}
        });
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        var gb = bytes / 1073741824;
        return gb >= 1 ? gb.toFixed(2) + ' ГБ' : (bytes / 1048576).toFixed(0) + ' МБ';
    }

    function play(entry) {
        if (!entry.url) {
            notify('У этого элемента нет прямого URL ресурса.', 'warning');
            return;
        }
        if (!Lampa.Player || !Lampa.Player.play) {
            notify('Lampa.Player.play недоступен в этой сборке.', 'error');
            return;
        }
        try {
            Lampa.Player.play({
                url: entry.url,
                title: entry.title,
                quality: 'DLNA'
            });
        } catch (e) {
            notify('Не удалось запустить видео: ' + e.message, 'error');
        }
    }

    function showFolder(objectId, title, parents) {
        notify('Загрузка: ' + title);
        browseAll(objectId, function (error, items) {
            if (error) {
                notify('Ошибка Browse: ' + errorText(error), 'error');
                return;
            }
            if (!items.length) {
                notify('Папка пуста.');
                return;
            }
            var rows = items.map(function (entry) {
                var subtitle = entry.isFolder ? ('Папка' + (entry.childCount ? ' · ' + entry.childCount : '')) :
                    [entry.mime, entry.duration, formatSize(entry.size)].filter(Boolean).join(' · ');
                return {
                    title: entry.title,
                    subtitle: subtitle,
                    template: 'select',
                    entry: entry
                };
            });
            openSelect(title, rows, function (selected) {
                var entry = selected.entry || selected;
                if (entry.isFolder) showFolder(entry.id, entry.title, (parents || []).concat([{ id: objectId, title: title }]));
                else play(entry);
            }, function () {
                if (parents && parents.length) {
                    var parent = parents[parents.length - 1];
                    showFolder(parent.id, parent.title, parents.slice(0, -1));
                }
            });
        });
    }

    function openCatalog() {
        cache = {};
        showFolder('0', 'DLNA — ' + baseUrl(), []);
    }

    function init() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.Storage) return;
        Lampa.Lang.add({
            dlna_bridge_title: { ru: 'DLNA Bridge 0.4.2', en: 'DLNA Bridge 0.4.2' },
            dlna_bridge_server: { ru: 'Адрес DLNA-сервера', en: 'DLNA server address' },
            dlna_bridge_open: { ru: 'Открыть каталог DLNA', en: 'Open DLNA catalog' },
            dlna_bridge_clear: { ru: 'Очистить кеш каталога', en: 'Clear catalog cache' },
            dlna_bridge_about: { ru: 'MiniDLNA: SOAP Browse через Lampa.Reguest.native. SSDP discovery пока не реализован.', en: 'MiniDLNA SOAP Browse via Lampa.Reguest.native. SSDP discovery is not implemented yet.' }
        });
        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: 'DLNA Bridge 0.4.2',
            icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'server_url', type: 'input', values: '', default: DEFAULT_BASE, placeholder: DEFAULT_BASE },
            field: { name: Lampa.Lang.translate('dlna_bridge_server'), description: Lampa.Lang.translate('dlna_bridge_about') }
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'open_catalog', type: 'trigger', default: false },
            field: { name: Lampa.Lang.translate('dlna_bridge_open') },
            onChange: function () { openCatalog(); }
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'clear_cache', type: 'trigger', default: false },
            field: { name: Lampa.Lang.translate('dlna_bridge_clear') },
            onChange: function () { cache = {}; notify('Кеш каталога очищен.', 'success'); }
        });
    }

    if (window.appready) init();
    else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') init();
        });
    }
})();