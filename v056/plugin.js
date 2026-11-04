/* Lampa DLNA Bridge 0.5.6
 * Native Lampa.Reguest transport + ContentDirectory Browse + DIDL-Lite navigation.
 * No SSDP discovery: the router server is configured by address.
 */
(function () {
    'use strict';

    var GUARD = 'lampa_dlna_bridge_056';
    var initialGuard = window[GUARD];
    var guardState = initialGuard && typeof initialGuard === 'object' ? initialGuard : {};
    if (guardState && (guardState.initialized || guardState.initializing)) return;
    window[GUARD] = guardState;
    if (initialGuard === true) {
        if (!guardState.registrations) guardState.registrations = {};
        // The previous boolean guard cannot reveal whether this listener ran.
        guardState.registrations.playerCloseListener = 'uncertain';
        guardState.migratedFromBooleanGuard = true;
    }

    var COMPONENT = 'dlna_bridge';
    var PREFIX = 'dlna_bridge_';
    var DEFAULT_BASE = 'http://192.168.1.1:8200';
    var SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    var PAGE_SIZE = 200;
    var MAX_ITEMS = 5000;
    var cache = {};
    var currentRequest = null;
    var activeMenuClose = null;
    var playerReturnController = null;
    var keypadBackHandlerAttached = false;
    var keypadBackHandlerActive = false;
    var keypadBackListener = null;
    var keypadBackDiagnostic = 'Lampa.Keypad back: событие ещё не получено';
    var keypadApiDiagnostic = 'Lampa API: проверка ещё не выполнена';
    var domKeyDiagnostic = 'DOM-пульт: ожидаю нажатия кнопки…';
    var backDiagnosticElement = null;

    function renderBackDiagnostics() {
        if (backDiagnosticElement) {
            backDiagnosticElement.textContent = keypadApiDiagnostic + '\n' + keypadBackDiagnostic + '\n' + domKeyDiagnostic;
        }
    }

    function keypadBackHandler(event) {
        if (!keypadBackHandlerActive) return;
        var data = event || {};
        var source = data.event || null;
        var code = data.code === undefined || data.code === null ? '(нет)' : data.code;
        var keyCode = source && source.keyCode !== undefined ? source.keyCode :
            (data.keyCode !== undefined ? data.keyCode : '(нет)');
        var controllerName = '(недоступен)';
        try {
            if (window.Lampa && Lampa.Controller && typeof Lampa.Controller.enabled === 'function') {
                var activeController = Lampa.Controller.enabled();
                if (activeController && activeController.name) controllerName = activeController.name;
            }
        } catch (e) {}
        keypadBackDiagnostic = 'Lampa.Keypad back: получено; code=' + code +
            '; keyCode=' + keyCode + '; DOM=' + (source ? 'да' : 'нет') +
            '; controller=' + controllerName;
        renderBackDiagnostics();
    }

    function checkKeypadApi() {
        var keypad = window.Lampa && Lampa.Keypad;
        var listener = keypad && keypad.listener;
        var controller = window.Lampa && Lampa.Controller;
        var status = [
            'Keypad=' + (keypad ? 'да' : 'нет'),
            'Keypad.listener=' + (listener ? 'да' : 'нет'),
            'listener.follow=' + (listener && typeof listener.follow === 'function' ? 'да' : 'нет'),
            'Controller=' + (controller ? 'да' : 'нет'),
            'Controller.add=' + (controller && typeof controller.add === 'function' ? 'да' : 'нет'),
            'toggle=' + (controller && typeof controller.toggle === 'function' ? 'да' : 'нет'),
            'enabled=' + (controller && typeof controller.enabled === 'function' ? 'да' : 'нет'),
            'back=' + (controller && typeof controller.back === 'function' ? 'да' : 'нет')
        ];
        keypadApiDiagnostic = 'Lampa API: ' + status.join(' | ');
        keypadBackListener = listener || null;
        renderBackDiagnostics();
    }

    function activateKeypadBackDiagnostic() {
        checkKeypadApi();
        if (!keypadBackListener || typeof keypadBackListener.follow !== 'function') return;
        keypadBackHandlerActive = true;
        if (keypadBackHandlerAttached) return;
        // Set first to avoid duplicate subscriptions if a nonstandard follow() throws after adding.
        keypadBackHandlerAttached = true;
        try {
            keypadBackListener.follow('back', keypadBackHandler);
        } catch (e) {
            keypadBackDiagnostic = 'Lampa.Keypad back: ошибка подписки: ' + errorText(e);
            keypadBackHandlerActive = false;
            if (typeof keypadBackListener.remove === 'function') {
                try {
                    keypadBackListener.remove('back', keypadBackHandler);
                    keypadBackHandlerAttached = false;
                } catch (removeError) {}
            }
            renderBackDiagnostics();
        }
    }

    function deactivateKeypadBackDiagnostic() {
        keypadBackHandlerActive = false;
        if (keypadBackHandlerAttached && keypadBackListener && typeof keypadBackListener.remove === 'function') {
            try {
                keypadBackListener.remove('back', keypadBackHandler);
                keypadBackHandlerAttached = false;
            } catch (e) {}
        }
        backDiagnosticElement = null;
    }

    function errorText(error) {
        if (error === null || error === undefined) return 'неизвестная ошибка (пустой ответ обработчика)';
        if (typeof error === 'string') return error;
        if (error.message) return error.message;
        try { return JSON.stringify(error); } catch (e) { return String(error); }
    }

    function registrationState(name) {
        if (!guardState.registrations) guardState.registrations = {};
        return guardState.registrations[name] || 'pending';
    }

    function setRegistrationState(name, state) {
        if (!guardState.registrations) guardState.registrations = {};
        guardState.registrations[name] = state;
    }

    function logRegistrationError(message, error) {
        var detail = message;
        if (error !== undefined) detail += ': ' + errorText(error);
        try {
            if (!guardState.registrationErrors) guardState.registrationErrors = [];
            if (guardState.registrationErrors.length < 50) guardState.registrationErrors.push(detail);
        } catch (stateError) {}
        try {
            if (window.console && typeof window.console.error === 'function') {
                window.console.error('[DLNA Bridge] ' + detail);
            } else if (window.console && typeof window.console.log === 'function') {
                window.console.log('[DLNA Bridge] ' + detail);
            }
        } catch (logError) {}
    }

    function componentIsPresent() {
        try {
            if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.getComponent !== 'function') return null;
            return !!Lampa.SettingsApi.getComponent(COMPONENT);
        } catch (e) { return null; }
    }

    function paramIsPresent(name) {
        try {
            if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.getParam !== 'function') return null;
            var params = Lampa.SettingsApi.getParam(COMPONENT);
            if (!params || typeof params.length !== 'number') return false;
            for (var i = 0; i < params.length; i++) {
                if (params[i] && params[i].param && params[i].param.name === name) return true;
            }
            return false;
        } catch (e) { return null; }
    }

    function registerComponent() {
        var name = 'component';
        var state = registrationState(name);
        if (state === 'registered') return true;
        var present = componentIsPresent();
        if (state === 'pending' && present === true) {
            // Avoid adding a component already registered by an earlier script.
            setRegistrationState(name, 'registered');
            return true;
        }
        if (state === 'uncertain' && present !== false) return false;
        try {
            Lampa.SettingsApi.addComponent({
                component: COMPONENT,
                name: 'DLNA Bridge 0.5.6',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'
            });
            setRegistrationState(name, 'registered');
            return true;
        } catch (error) {
            logRegistrationError('Ошибка регистрации компонента DLNA', error);
            present = componentIsPresent();
            setRegistrationState(name, present === false ? 'pending' : 'uncertain');
            return false;
        }
    }

    function registerParam(name, data) {
        var state = registrationState(name);
        if (state === 'registered') return true;

        var settingName = data.param.name;
        var present = paramIsPresent(settingName);
        if (state === 'uncertain') {
            if (present !== false) return false;
            setRegistrationState(name, 'pending');
        } else if (present === true) {
            // The parameter record exists, but Lampa may have thrown before
            // initializing Params.values/defaults. Do not treat it as complete.
            setRegistrationState(name, 'uncertain');
            logRegistrationError('Параметр ' + settingName + ' присутствует, но его инициализация не подтверждена');
            return false;
        }

        try {
            Lampa.SettingsApi.addParam(data);
            setRegistrationState(name, 'registered');
            return true;
        } catch (error) {
            logRegistrationError('Ошибка регистрации параметра ' + settingName, error);
            present = paramIsPresent(settingName);
            setRegistrationState(name, present === false ? 'pending' : 'uncertain');
            return false;
        }
    }

    function addTranslations() {
        var name = 'translations';
        if (registrationState(name) !== 'pending') return;
        if (!Lampa.Lang || typeof Lampa.Lang.add !== 'function') {
            setRegistrationState(name, 'pending');
            if (!guardState.langAddWarning) {
                guardState.langAddWarning = true;
                logRegistrationError('Lampa.Lang.add недоступен; будут использованы подписи по умолчанию');
            }
            return;
        }
        try {
            Lampa.Lang.add({
                dlna_bridge_title: { ru: 'DLNA Bridge 0.5.6', en: 'DLNA Bridge 0.5.6' },
                dlna_bridge_server: { ru: 'Адрес DLNA-сервера', en: 'DLNA server address' },
                dlna_bridge_open: { ru: 'Открыть каталог DLNA', en: 'Open DLNA catalog' },
                dlna_bridge_clear: { ru: 'Очистить кеш каталога', en: 'Clear catalog cache' },
                dlna_bridge_androidjs: { ru: 'Проверить AndroidJS', en: 'Inspect AndroidJS' },
                dlna_bridge_about: { ru: 'MiniDLNA: SOAP Browse через Lampa.Reguest.native. SSDP discovery пока не реализован.', en: 'MiniDLNA SOAP Browse via Lampa.Reguest.native. SSDP discovery is not implemented yet.' }
            });
            setRegistrationState(name, 'registered');
        } catch (error) {
            setRegistrationState(name, 'uncertain');
            logRegistrationError('Ошибка добавления переводов DLNA; будут использованы подписи по умолчанию', error);
        }
    }

    function translated(key, fallback) {
        try {
            if (Lampa.Lang && typeof Lampa.Lang.translate === 'function') {
                var value = Lampa.Lang.translate(key);
                if (value !== undefined && value !== null && value !== '' &&
                    (registrationState('translations') === 'registered' || value !== key)) return value;
            } else if (!guardState.langTranslateWarning) {
                guardState.langTranslateWarning = true;
                logRegistrationError('Lampa.Lang.translate недоступен; используются подписи по умолчанию');
            }
        } catch (error) {
            if (!guardState.langTranslateWarning) {
                guardState.langTranslateWarning = true;
                logRegistrationError('Ошибка Lampa.Lang.translate; используются подписи по умолчанию', error);
            }
        }
        return fallback;
    }

    function notify(message, style) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
            Lampa.Noty.show(message, { style: style || 'default', time: 7000 });
        } else if (window.console) console.log('[DLNA Bridge] ' + message);
    }

    function androidBridgeType(value) {
        if (value === null) return 'null';
        return typeof value;
    }

    function androidBridgePropertySummary(target, limit) {
        var names;
        var result = [];
        try {
            names = Object.getOwnPropertyNames(target);
        } catch (error) {
            return '[ошибка перечисления: ' + errorText(error) + ']';
        }
        var count = Math.min(names.length, limit);
        for (var i = 0; i < count; i++) {
            var name = String(names[i]);
            if (name.length > 48) name = name.slice(0, 45) + '...';
            try {
                var descriptor = Object.getOwnPropertyDescriptor(target, names[i]);
                if (!descriptor) result.push(name + ': недоступно');
                else if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    result.push(name + ': ' + androidBridgeType(descriptor.value));
                } else result.push(name + ': accessor (не прочитан)');
            } catch (error) {
                result.push(name + ': ошибка дескриптора');
            }
        }
        if (names.length > count) result.push('... ещё свойств: ' + (names.length - count));
        return result.join(', ');
    }

    function androidBridgeGlobalDescriptor(name) {
        var target = window;
        for (var depth = 0; target && depth < 6; depth++) {
            try {
                var descriptor = Object.getOwnPropertyDescriptor(target, name);
                if (descriptor) return descriptor;
                target = Object.getPrototypeOf(target);
            } catch (error) {
                return { inspectionError: error };
            }
        }
        return null;
    }

    function androidBridgeObjectSummary(name, value) {
        var lines = [name + ' (' + androidBridgeType(value) + ')'];
        lines.push('  свойства: ' + androidBridgePropertySummary(value, 12));
        var prototype = value;
        for (var depth = 1; depth <= 2; depth++) {
            try {
                prototype = Object.getPrototypeOf(prototype);
            } catch (error) {
                lines.push('  прототип ' + depth + ': ошибка: ' + errorText(error));
                break;
            }
            if (!prototype) {
                lines.push('  прототип ' + depth + ': null');
                break;
            }
            lines.push('  прототип ' + depth + ' (' + androidBridgeType(prototype) + '): ' +
                androidBridgePropertySummary(prototype, 8));
        }
        return lines.join('\n');
    }

    function diagnoseAndroidBridges() {
        var names = ['AndroidJS', 'androidJS', 'Android', 'AndroidBridge', 'WebViewBridge', 'JSInterface'];
        var lines = ['AndroidJS bridge diagnostics (только чтение дескрипторов)'];
        for (var i = 0; i < names.length; i++) {
            var descriptor = androidBridgeGlobalDescriptor(names[i]);
            if (!descriptor) {
                lines.push(names[i] + ': отсутствует');
            } else if (descriptor.inspectionError) {
                lines.push(names[i] + ': ошибка доступа к дескриптору: ' + errorText(descriptor.inspectionError));
            } else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                lines.push(names[i] + ': accessor глобального свойства (не прочитан)');
            } else if (descriptor.value === undefined) {
                lines.push(names[i] + ': undefined');
            } else if (descriptor.value === null) {
                lines.push(names[i] + ': null');
            } else {
                try {
                    lines.push(androidBridgeObjectSummary(names[i], descriptor.value));
                } catch (error) {
                    lines.push(names[i] + ': ошибка инспекции: ' + errorText(error));
                }
            }
        }
        var report = lines.join('\n');
        if (report.length > 3000) report = report.slice(0, 2980) + '\n... отчёт сокращён';
        notify(report, 'default');
        return report;
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
            var attempts = 0;
            function requestPage() {
                attempts++;
                soapBrowse(objectId, offset, PAGE_SIZE, function (items, total) {
                    // Some DLNA servers return an empty/unfinished first response while waking up.
                    // Retry instead of caching an incomplete catalog.
                    if (!items.length && total > offset && attempts < 3) {
                        setTimeout(requestPage, attempts * 700);
                        return;
                    }
                    collected = collected.concat(items);
                    offset += items.length;
                    if (offset < total && items.length && offset < MAX_ITEMS) page();
                    else {
                        cache[objectId] = collected.slice();
                        callback(null, collected);
                    }
                }, function (error) {
                    if (attempts < 3) {
                        setTimeout(requestPage, attempts * 700);
                        return;
                    }
                    callback(error);
                });
            }
            requestPage();
        }
        page();
    }

    function hasNativeSelectApi() {
        var select = window.Lampa && Lampa.Select;
        var controller = window.Lampa && Lampa.Controller;
        return !!(select && typeof select.show === 'function' && controller &&
            typeof controller.add === 'function' && typeof controller.toggle === 'function' &&
            typeof controller.enabled === 'function' &&
            typeof controller.windowOpen === 'function' && typeof controller.windowClose === 'function' &&
            typeof controller.collectionSet === 'function' && typeof controller.collectionFocus === 'function' &&
            typeof window.$ === 'function');
    }

    function openSelect(title, entries, onSelect, onBack) {
        var previousController = '';
        try {
            var enabledController = Lampa.Controller.enabled();
            if (enabledController && enabledController.name) previousController = enabledController.name;
        } catch (controllerError) {}

        function restoreController() {
            if (!previousController || !Lampa.Controller || typeof Lampa.Controller.toggle !== 'function') return;
            try {
                var currentController = Lampa.Controller.enabled();
                if (!currentController || currentController.name !== previousController) {
                    Lampa.Controller.toggle(previousController);
                }
            } catch (controllerError) {}
        }

        function selectItem(selected) {
            restoreController();
            if (onSelect) onSelect(selected);
        }

        function backFromSelect() {
            restoreController();
            if (onBack) onBack();
        }

        if (!hasNativeSelectApi()) {
            openSelectDom(title, entries, selectItem, backFromSelect);
            return;
        }

        try {
            var items = entries.map(function (entry) {
                return {
                    title: entry.title || (entry.entry && entry.entry.title) || '',
                    subtitle: entry.subtitle || '',
                    entry: entry.entry || entry,
                    onSelect: function () {
                        activeMenuClose = null;
                        deactivateKeypadBackDiagnostic();
                        selectItem(entry);
                    }
                };
            });
            var diagnostic = document.createElement('div');
            diagnostic.style.cssText = 'white-space:pre-wrap;font-size:14px;color:#ffd27a;opacity:.95;padding:12px 4px;';
            backDiagnosticElement = diagnostic;
            renderBackDiagnostics();

            activeMenuClose = function () {
                activeMenuClose = null;
                deactivateKeypadBackDiagnostic();
                if (Lampa.Select && typeof Lampa.Select.closeAll === 'function') Lampa.Select.closeAll();
                else if (Lampa.Select && typeof Lampa.Select.close === 'function') Lampa.Select.close();
            };
            activateKeypadBackDiagnostic();
            Lampa.Select.show({
                title: title,
                items: items,
                onFullDraw: function (scroll) {
                    try { scroll.append(window.$(diagnostic)); } catch (e) {}
                },
                onBack: function () {
                    activeMenuClose = null;
                    deactivateKeypadBackDiagnostic();
                    backFromSelect();
                }
            });
        } catch (e) {
            activeMenuClose = null;
            deactivateKeypadBackDiagnostic();
            try {
                if (Lampa.Select && typeof Lampa.Select.opened === 'function' && Lampa.Select.opened()) {
                    notify('Ошибка при открытии Lampa.Select: ' + errorText(e), 'error');
                    return;
                }
            } catch (openedError) {}
            notify('Lampa.Select недоступен, открываю резервное меню: ' + errorText(e), 'warning');
            openSelectDom(title, entries, selectItem, backFromSelect);
        }
    }

    function openSelectDom(title, entries, onSelect, onBack) {
        var old = document.getElementById('dlna-bridge-menu');
        if (old) {
            if (activeMenuClose) activeMenuClose();
            if (old.parentNode) old.parentNode.removeChild(old);
        }

        var overlay = document.createElement('div');
        overlay.id = 'dlna-bridge-menu';
        overlay.style.cssText = 'position:fixed;z-index:1000;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.94);color:#fff;padding:5vh 6vw;box-sizing:border-box;font-family:Arial,sans-serif;overflow:auto;';
        var heading = document.createElement('div');
        heading.textContent = title;
        heading.style.cssText = 'font-size:26px;font-weight:bold;margin:0 0 22px;';
        overlay.appendChild(heading);

        var list = document.createElement('div');
        list.style.cssText = 'max-width:1000px;margin:auto;';
        overlay.appendChild(list);

        var buttons = [];
        var diagnostic = document.createElement('div');
        diagnostic.style.cssText = 'position:fixed;left:6vw;right:6vw;bottom:16px;max-height:22vh;overflow:auto;white-space:pre-wrap;font-size:14px;color:#ffd27a;opacity:.95;';
        overlay.appendChild(diagnostic);
        backDiagnosticElement = diagnostic;
        renderBackDiagnostics();
        function showKeyEvent(type, event) {
            var key = event.key || '(пусто)';
            var code = event.keyCode || 0;
            var which = event.which || 0;
            domKeyDiagnostic = 'DOM-пульт ' + type + ': key=' + key + ', keyCode=' + code + ', which=' + which;
            renderBackDiagnostics();
        }
        function close() {
            window.removeEventListener('keydown', keyHandler, true);
            window.removeEventListener('keyup', keyUpHandler, true);
            deactivateKeypadBackDiagnostic();
            overlay.style.display = 'none';
            overlay.style.visibility = 'hidden';
            overlay.style.pointerEvents = 'none';
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            if (activeMenuClose === close) activeMenuClose = null;
        }
        activeMenuClose = close;
        var choosing = false;
        function choose(index) {
            if (choosing || index < 0 || index >= entries.length) return;
            choosing = true;
            var selected = entries[index];
            close();
            // Give Lampa/WebView time to finish the remote-control key event
            // and remove the menu before starting navigation or playback.
            setTimeout(function () {
                onSelect(selected);
            }, 600);
        }
        function isBackKey(event) {
            var key = event.key || '';
            var code = event.keyCode || event.which;
            return key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || key === 'GoBack' ||
                code === 4 || code === 8 || code === 27 || code === 111 || code === 166 || code === 461 || code === 10009;
        }
        function swallow(event) {
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
        function keyUpHandler(event) {
            showKeyEvent('keyup', event);
            if (isBackKey(event)) swallow(event);
        }
        function keyHandler(event) {
            showKeyEvent('keydown', event);
            var key = event.key || '';
            var code = event.keyCode || event.which;
            if (isBackKey(event)) {
                swallow(event);
                close();
                if (onBack) onBack();
            } else if (key === 'ArrowDown' || code === 40) {
                swallow(event);
                focusIndex(Math.min(buttons.length - 1, active + 1));
            } else if (key === 'ArrowUp' || code === 38) {
                swallow(event);
                focusIndex(Math.max(0, active - 1));
            } else if (key === 'Enter' || key === ' ' || code === 13 || code === 23 || code === 66 || code === 96) {
                swallow(event);
                choose(active);
            }
        }
        var active = 0;
        function focusIndex(index) {
            if (!buttons.length) return;
            active = index;
            buttons.forEach(function (button, i) {
                button.style.background = i === active ? '#315b86' : 'rgba(255,255,255,.08)';
                button.style.outline = i === active ? '2px solid #8fc7ff' : 'none';
            });
            buttons[active].focus();
            buttons[active].scrollIntoView({ block: 'nearest' });
        }

        entries.forEach(function (entry, index) {
            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = (entry.entry && entry.entry.isFolder || entry.isFolder ? '📁  ' : '▶  ') +
                (entry.title || (entry.entry && entry.entry.title) || 'Без названия') +
                (entry.subtitle ? '    ' + entry.subtitle : '');
            button.style.cssText = 'display:block;width:100%;text-align:left;color:#fff;background:rgba(255,255,255,.08);border:0;border-radius:7px;padding:17px 20px;margin:8px 0;font-size:20px;';
            button.addEventListener('click', function () { choose(index); });
            button.addEventListener('focus', function () { active = index; });
            list.appendChild(button);
            buttons.push(button);
        });

        if (!entries.length) {
            var empty = document.createElement('div');
            empty.textContent = 'Папка пуста';
            list.appendChild(empty);
        }
        document.body.appendChild(overlay);
        window.addEventListener('keydown', keyHandler, true);
        window.addEventListener('keyup', keyUpHandler, true);
        activateKeypadBackDiagnostic();
        focusIndex(0);
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        var gb = bytes / 1073741824;
        return gb >= 1 ? gb.toFixed(2) + ' ГБ' : (bytes / 1048576).toFixed(0) + ' МБ';
    }

    function play(entry) {
        var menu = document.getElementById('dlna-bridge-menu');
        if (menu) {
            menu.style.display = 'none';
            menu.style.visibility = 'hidden';
            menu.style.pointerEvents = 'none';
            if (menu.parentNode) menu.parentNode.removeChild(menu);
        }
        notify('Выбран файл: ' + (entry.title || 'без названия'), 'default');
        if (!entry.url) {
            notify('У этого элемента нет прямого URL ресурса.', 'warning');
            return;
        }
        if (!Lampa.Player || !Lampa.Player.play) {
            notify('Файл найден, но Lampa.Player.play недоступен в этой сборке.', 'error');
            return;
        }
        try {
            var currentController = Lampa.Controller && typeof Lampa.Controller.enabled === 'function' ? Lampa.Controller.enabled() : null;
            playerReturnController = currentController && currentController.name ? currentController.name : null;
            if (playerReturnController && typeof Lampa.Player.callback === 'function') {
                Lampa.Player.callback(function () {
                    var returnTo = playerReturnController;
                    if (returnTo && Lampa.Controller && typeof Lampa.Controller.toggle === 'function') {
                        try {
                            Lampa.Controller.toggle(returnTo);
                            playerReturnController = null;
                        } catch (controllerError) {
                            playerReturnController = returnTo;
                        }
                    }
                });
            }
        } catch (controllerError) {}
        try {
            Lampa.Player.play({
                url: entry.url,
                title: entry.title,
                quality: 'DLNA'
            });
        } catch (e) {
            playerReturnController = null;
            try {
                if (typeof Lampa.Player.callback === 'function') Lampa.Player.callback(null);
            } catch (callbackError) {}
            notify('Ошибка запуска плеера: ' + errorText(e), 'error');
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
        showFolder('0', 'DLNA — ' + baseUrl(), []);
    }

    function registerPlayerCloseListener(retryAfterConfirmedMissing) {
        retryAfterConfirmedMissing = !!retryAfterConfirmedMissing;
        var name = 'playerCloseListener';
        var state = registrationState(name);
        var listener = Lampa.Player && Lampa.Player.listener;
        var handler = guardState.playerCloseHandler;
        if (typeof handler !== 'function') {
            handler = function () {
                if (activeMenuClose) activeMenuClose();
                var staleMenu = document.getElementById('dlna-bridge-menu');
                if (staleMenu && staleMenu.parentNode) staleMenu.parentNode.removeChild(staleMenu);
                if (playerReturnController) {
                    var returnTo = playerReturnController;
                    if (Lampa.Controller && typeof Lampa.Controller.toggle === 'function') {
                        try {
                            Lampa.Controller.toggle(returnTo);
                            playerReturnController = null;
                        } catch (controllerError) {}
                    }
                }
            };
            guardState.playerCloseHandler = handler;
        }
        if (!listener || typeof listener.follow !== 'function') return;
        if (state === 'registered') return;
        if (state === 'uncertain') {
            if (guardState.migratedFromBooleanGuard) return;
            if (typeof listener.has !== 'function') return;
            try {
                if (listener.has('close', handler)) {
                    setRegistrationState(name, 'registered');
                    return;
                }
                setRegistrationState(name, 'pending');
            } catch (hasError) {
                return;
            }
        }
        setRegistrationState(name, 'uncertain');
        try {
            listener.follow('close', handler);
            setRegistrationState(name, 'registered');
        } catch (error) {
            logRegistrationError('Подписка Player.close завершилась исключением; проверяю её состояние', error);
            if (typeof listener.has === 'function') {
                try {
                    if (listener.has('close', handler)) {
                        setRegistrationState(name, 'registered');
                        return;
                    }
                    setRegistrationState(name, 'pending');
                    if (!retryAfterConfirmedMissing) registerPlayerCloseListener(true);
                    return;
                } catch (hasError) {}
            }
            setRegistrationState(name, 'uncertain');
        }
    }

    function init() {
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.Storage) {
            guardState.loading = false;
            return;
        }
        if (guardState.initialized || guardState.initializing) return;
        guardState.loading = true;
        guardState.initializing = true;

        try {
            registerPlayerCloseListener();
            addTranslations();

            registerComponent();
            registerParam('serverUrlParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'server_url', type: 'input', values: '', default: DEFAULT_BASE, placeholder: DEFAULT_BASE },
                field: {
                    name: translated('dlna_bridge_server', 'Адрес DLNA-сервера'),
                    description: translated('dlna_bridge_about', 'SOAP Browse через Lampa.Reguest.native.')
                }
            });
            registerParam('openCatalogParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'open_catalog', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_open', 'Открыть каталог DLNA') },
                onChange: function () { openCatalog(); }
            });
            registerParam('clearCacheParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'clear_cache', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_clear', 'Очистить кеш каталога') },
                onChange: function () { cache = {}; notify('Кеш каталога очищен.', 'success'); }
            });

            registerParam('androidDiagnosticParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'androidjs_diag', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_androidjs', 'Проверить AndroidJS') },
                onChange: function () { diagnoseAndroidBridges(); }
            });

            var required = ['component', 'serverUrlParam', 'openCatalogParam', 'clearCacheParam'];
            var ready = true;
            for (var i = 0; i < required.length; i++) {
                if (registrationState(required[i]) !== 'registered') ready = false;
            }
            guardState.initialized = ready;
        } catch (initError) {
            guardState.initialized = false;
            logRegistrationError('Ошибка инициализации; повторный запуск разрешён', initError);
        }

        guardState.loading = false;
        guardState.initializing = false;
    }

    if (window.appready) init();
    else if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
        if (registrationState('appReadyListener') === 'pending') {
            setRegistrationState('appReadyListener', 'uncertain');
            try {
                Lampa.Listener.follow('app', function (event) {
                    if (event.type === 'ready') init();
                });
                setRegistrationState('appReadyListener', 'registered');
            } catch (listenerError) {
                guardState.loading = false;
                guardState.initializing = false;
                logRegistrationError('Подписка на app ready имеет неопределённый результат; повторно не добавляется', listenerError);
                setRegistrationState('appReadyListener', 'uncertain');
            }
        }
    } else {
        if (registrationState('appReadyListener') === 'pending') {
            setRegistrationState('appReadyListener', 'pending');
        }
        guardState.loading = false;
    }
})();
