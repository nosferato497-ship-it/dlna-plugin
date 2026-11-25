/* Lampa DLNA Bridge 1.0.2
 * Native Lampa.Reguest transport + ContentDirectory Browse + DIDL-Lite navigation
 * + UPnP MediaRenderer AVTransport playback & remote control.
 */
(function () {
    'use strict';

    var PLUGIN_VERSION = '1.0.2';
    var INSTANCE_KEY = '__LAMPA_DLNA_BRIDGE_INSTANCE__';
    var LEGACY_GUARDS = ['lampa_dlna_bridge_100', 'lampa_dlna_bridge_101', 'lampa_dlna_bridge_102', 'lampa_dlna_bridge'];

    function inspectLegacyGuards() {
        var found = {
            hasBooleanTrue: false,
            activeObject: null,
            partialObject: null,
            legacyVersion: ''
        };
        for (var i = 0; i < LEGACY_GUARDS.length; i++) {
            var key = LEGACY_GUARDS[i];
            var val;
            try { val = window[key]; } catch (e) { val = undefined; }
            if (val === true) {
                found.hasBooleanTrue = true;
                if (!found.legacyVersion) found.legacyVersion = key;
            } else if (val && typeof val === 'object') {
                if (val.initialized || val.initializing) {
                    found.activeObject = val;
                    if (!found.legacyVersion) found.legacyVersion = val.version || key;
                } else if (!found.partialObject) {
                    found.partialObject = val;
                    if (!found.legacyVersion) found.legacyVersion = val.version || key;
                }
            }
        }
        return found;
    }

    var existingInstance = null;
    try { existingInstance = window[INSTANCE_KEY]; } catch (e) {}
    var legacyInfo = inspectLegacyGuards();

    if ((existingInstance && typeof existingInstance === 'object' &&
        (existingInstance.initialized || existingInstance.initializing)) ||
        legacyInfo.activeObject) {
        var activeInst = (existingInstance && typeof existingInstance === 'object' &&
            (existingInstance.initialized || existingInstance.initializing))
            ? existingInstance : legacyInfo.activeObject;
        try {
            window[INSTANCE_KEY] = activeInst;
            for (var g = 0; g < LEGACY_GUARDS.length; g++) {
                window[LEGACY_GUARDS[g]] = activeInst;
            }
        } catch (syncErr) {}
        try {
            if (window.console && typeof window.console.warn === 'function') {
                window.console.warn('[DLNA Bridge] Экземпляр плагина уже загружен (v' +
                    (activeInst.version || legacyInfo.legacyVersion || 'unknown') +
                    '), повторная инициализация v' + PLUGIN_VERSION + ' заблокирована.');
            }
        } catch (warnErr) {}
        return;
    }

    var guardState = (existingInstance && typeof existingInstance === 'object')
        ? existingInstance
        : (legacyInfo.partialObject || {});
    if (!guardState.registrations) guardState.registrations = {};
    if (legacyInfo.hasBooleanTrue) {
        // Legacy boolean guard cannot confirm whether Player.close listener was attached.
        guardState.registrations.playerCloseListener = 'uncertain';
        guardState.migratedFromBooleanGuard = true;
    }
    guardState.version = PLUGIN_VERSION;
    window[INSTANCE_KEY] = guardState;
    for (var k = 0; k < LEGACY_GUARDS.length; k++) {
        window[LEGACY_GUARDS[k]] = guardState;
    }

    var COMPONENT = 'dlna_bridge';
    var BROWSER_COMPONENT = 'dlna_bridge_browser';
    var activeBrowser = null;
    // A Player.play call remains owned until completion or an explicit external recovery decision.
    var pendingPlayback = null;
    var androidRecoveryConfirmation = null;
    var abandonedPlaybackExists = false;
    var androidReturnState = null;
    var androidReturnInput = null;
    var androidEnterDown = false;

    function androidReturnLog(event, session, reason) {
        try { playbackDiagnosticRecord(event, session, reason); } catch (error) {}
    }

    function androidReturnContext() {
        try { return activeBrowser && activeBrowser.playbackContext(); } catch (error) { return null; }
    }

    function androidReturnCovered() {
        try {
            if (Lampa.Controller.enabled().name !== 'content' ||
                /(?:^|\s)(settings|menu|search)--open(?:\s|$)/.test(document.body.className) ||
                Lampa.Controller.windowTop() || !document.querySelector) return true;
            return !!document.querySelector('.modal,.selectbox--open,.youtube-player,.player,.search-box,.search,.console');
        } catch (error) { return true; }
    }

    function androidReturnForeground() {
        try { return document.hidden === false && document.visibilityState !== 'hidden' && document.hasFocus() === true; }
        catch (error) { return false; }
    }

    function androidReturnReady(context) {
        return androidInputReady(context) && !context.resources;
    }

    function androidInputReady(context) {
        return !!context && context.current && context.content && context.ready && context.navigationFocus &&
            !context.loading && !context.error && !androidReturnCovered();
    }

    function resetAndroidReturnCycle() {
        if (androidReturnState) {
            if (androidReturnState.queued) clearTimeout(androidReturnState.timer);
            androidReturnState.queued = false;
            androidReturnState.away = false; androidReturnState.returned = false;
        }
    }

    function beginAndroidReturn(session) {
        resetAndroidReturnCycle();
        androidReturnState = null;
        androidReturnInput = null;
        var context = androidReturnContext();
        try {
            if (!Lampa.Platform || typeof Lampa.Platform.is !== 'function' || !Lampa.Platform.is('android')) return;
        } catch (error) { return; }
        if (!androidReturnReady(context) || !androidReturnForeground()) return;
        if (guardState.settingsLifecycleState !== 'registered') return;
        var required = ['Visibility', 'Focus', 'Blur', 'Controller', 'Activity', 'Modal', 'Select', 'Internal', 'Down', 'Up'];
        for (var i = 0; i < required.length; i++) if (registrationState('androidReturn' + required[i]) !== 'registered') return;
        androidReturnState = { id: session.diagnosticId, catalog: context.catalog, folder: context.folder,
            external: false, away: false, returned: false, queued: false, timer: 0 };
    }

    function observeAndroidReturn(type) {
        if (androidReturnInput && (!androidReturnForeground() || !androidInputReady(androidReturnContext()))) resetAndroidReturnGesture();
        var state = androidReturnState;
        var session = pendingPlayback;
        if (!state || !session || session.diagnosticId !== state.id || session.internalStarted) return;
        var context = androidReturnContext();
        if (!androidReturnReady(context) || context.catalog !== state.catalog || context.folder !== state.folder) {
            resetAndroidReturnCycle(); return;
        }
        if (type === 'visibility') {
            if (document.hidden === true) {
                if (!state.away) resetAndroidReturnCycle();
                state.away = true; state.returned = false; return;
            }
            if (document.hidden === false && state.away) {
                state.away = false;
                state.returned = state.external && session.phase === 'external';
                if (!state.returned) androidReturnLog('return-cycle-rejected', session, 'visible-before-external');
            }
        }
        if (!state.returned || !state.external || session.phase !== 'external' || !androidReturnForeground()) return;
        if (type !== 'commit') {
            if (!state.queued) {
                state.queued = true;
                // End-of-dispatch validation, never elapsed-time evidence of return/completion.
                state.timer = setTimeout(function () {
                    if (androidReturnState !== state) return;
                    state.queued = false;
                    observeAndroidReturn('commit');
                }, 0);
            }
            return;
        }
        // Consume before diagnostics or owner callbacks can reenter. This is permission, not completion.
        androidReturnState = null;
        androidReturnInput = { ready: !androidEnterDown, down: false, ticket: false, catalog: 0, folder: 0 };
        if (abandonPlaybackSession(session, 'auto-return-unconfirmed')) {
            androidReturnLog('recovery-auto-accepted', session, 'auto-return-unconfirmed');
        }
    }

    function androidReturnKey(event, down) {
        var code = event && event.code;
        if (code !== 13 && code !== 29443 && code !== 117 && code !== 65385) return;
        var held = androidEnterDown;
        androidEnterDown = down;
        var gate = androidReturnInput;
        if (!gate) return;
        gate.ticket = false;
        if (down) {
            var context = androidReturnContext();
            gate.down = event.enabled !== false && gate.ready && !held && !(event.event && (event.event.repeat || event.event.defaultPrevented)) &&
                androidReturnForeground() && androidInputReady(context);
            if (gate.down) { gate.catalog = context.catalog; gate.folder = context.folder; }
        } else {
            gate.ticket = event.enabled !== false && gate.down && !(event.event && event.event.defaultPrevented);
            gate.down = false;
            gate.ready = true;
        }
    }

    function resetAndroidReturnGesture() {
        if (androidReturnInput) { androidReturnInput.down = false; androidReturnInput.ticket = false; }
    }

    function androidReturnPointer() {
        var gate = androidReturnInput;
        var context = androidReturnContext();
        if (gate && androidReturnForeground() && androidInputReady(context)) {
            gate.ticket = true; gate.catalog = context.catalog; gate.folder = context.folder;
        }
    }

    function consumeAndroidReturnInput() {
        var gate = androidReturnInput;
        if (!gate) return true;
        var context = androidReturnContext();
        var allow = gate.ticket && androidReturnForeground() && androidInputReady(context) &&
            context.catalog === gate.catalog && context.folder === gate.folder;
        gate.ticket = false;
        return !!allow;
    }

    function bindAndroidReturn() {
        function bind(target, type, name, handler, dom) {
            if (!target || typeof target[dom ? 'addEventListener' : 'follow'] !== 'function' ||
                registrationState(name) !== 'pending') return;
            var callback = guardState[name] || handler;
            guardState[name] = callback;
            setRegistrationState(name, 'uncertain');
            try {
                if (dom) target.addEventListener(type, callback, false); else target.follow(type, callback);
                setRegistrationState(name, 'registered');
            } catch (error) {} // Fail closed; uncertain subscriptions are never duplicated.
        }
        bind(typeof document === 'undefined' ? null : document, 'visibilitychange', 'androidReturnVisibility', function () { observeAndroidReturn('visibility'); }, true);
        bind(window, 'focus', 'androidReturnFocus', function () { observeAndroidReturn('focus'); }, true);
        bind(window, 'blur', 'androidReturnBlur', resetAndroidReturnGesture, true);
        bind(Lampa.Controller && Lampa.Controller.listener, 'toggle', 'androidReturnController', function () { observeAndroidReturn('context'); });
        bind(Lampa.Listener, 'activity', 'androidReturnActivity', function (event) {
            if (event && event.type === 'init') resetAndroidReturnCycle(); else observeAndroidReturn('context');
        });
        bind(Lampa.Modal && Lampa.Modal.listener, 'preshow', 'androidReturnModal', resetAndroidReturnCycle);
        bind(Lampa.Select && Lampa.Select.listener, 'preshow', 'androidReturnSelect', resetAndroidReturnCycle);
        bind(Lampa.Player && Lampa.Player.listener, 'start', 'androidReturnInternal', function (data) {
            if (pendingPlayback && data === pendingPlayback.data) { pendingPlayback.internalStarted = true; androidReturnState = null; }
        });
        bind(Lampa.Keypad && Lampa.Keypad.listener, 'keydown', 'androidReturnDown', function (event) { androidReturnKey(event, true); });
        bind(Lampa.Keypad && Lampa.Keypad.listener, 'keyup', 'androidReturnUp', function (event) { androidReturnKey(event, false); });
    }
    var PLAYBACK_DIAGNOSTIC_MARKER = 'DLNA PLAYBACK DIAGNOSTICS (LOCAL)';
    var PLAYBACK_DIAGNOSTIC_LIMIT = 100;
    var PLAYBACK_DIAGNOSTIC_PAGE_SIZE = 6;
    var playbackDiagnosticViewSnapshot = null;
    var playbackDiagnosticViewEnd = 0;
    var playbackDiagnosticStartedAt = (new Date()).getTime();
    var playbackDiagnosticSequence = 0;
    var playbackDiagnosticAttemptSequence = 0;
    var playbackDiagnosticRecords = [];
    var browserRegistered = false;
    var PREFIX = 'dlna_bridge_';
    var DEFAULT_BASE = 'http://192.168.1.1:8200';
    var SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    var PAGE_SIZE = 200;
    var MAX_ITEMS = 5000;
    var cache = {};
    var currentRequest = null;
    var browseToken = 0;
    var activeMenuClose = null;
    var activeNativeMenu = null;
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

    function playbackDiagnosticLabel(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,48}$/.test(value)) return 'other';
        return value;
    }

    var returnDiagnosticCatalogSequence = 0;
    var returnDiagnosticFolderSequence = 0;
    var returnDiagnosticAttempt = null;

    function returnDiagnosticFlag(value) { return value === true ? '1' : value === false ? '0' : '?'; }

    function recordReturnDiagnostic(kind) {
        try {
            var session = pendingPlayback;
            var origin = returnDiagnosticAttempt;
            var context = activeBrowser && typeof activeBrowser.playbackContext === 'function' ?
                activeBrowser.playbackContext() : null;
            var visibility = document.visibilityState;
            if (visibility !== 'hidden' && visibility !== 'visible') {
                visibility = typeof document.hidden === 'boolean' ? (document.hidden ? 'hidden' : 'visible') : '?';
            }
            var focused;
            try { if (typeof document.hasFocus === 'function') focused = document.hasFocus(); } catch (focusReadError) {}
            var other;
            try {
                var enabled = Lampa.Controller.enabled();
                var settingsOpen = /(?:^|\s)(settings|menu|search)--open(?:\s|$)/.test(document.body.className);
                if (enabled.name !== 'content' || settingsOpen) other = true;
                else if (typeof document.querySelector === 'function') {
                    other = !!document.querySelector('.modal,.selectbox--open,.youtube-player,.player,.search-box,.search,.console');
                }
            } catch (interfaceReadError) {}
            var sameAttempt = session && origin && session.diagnosticId === origin.id;
            var sameCatalog = !!(sameAttempt && context && context.current && context.catalog === origin.catalog);
            var sample = {
                external: sameAttempt ? returnDiagnosticFlag(origin.external) : '?',
                visibility: visibility, documentFocus: returnDiagnosticFlag(focused),
                catalog: context ? context.catalog : 0, folder: context ? context.folder : 0,
                originCatalog: sameCatalog ? '1' : '0',
                originFolder: sameCatalog && context.folder === origin.folder ? '1' : '0',
                content: returnDiagnosticFlag(context ? context.content : false), other: returnDiagnosticFlag(other),
                loading: returnDiagnosticFlag(context ? context.loading : undefined),
                error: returnDiagnosticFlag(context ? context.error : undefined),
                resources: returnDiagnosticFlag(context ? context.resources : undefined),
                navigationFocus: returnDiagnosticFlag(context ? context.navigationFocus : undefined),
                hooks: ['blur', 'focus', 'visibility', 'controller', 'activity'].map(function (name) {
                    var state = registrationState('returnDiagnostic_' + name);
                    return state === 'registered' ? '1' : state === 'pending' ? '0' : '?';
                }).join('')
            };
            playbackDiagnosticRecord('return-' + kind, session, 'pending-context-not-causation', undefined, undefined, sample);
        } catch (returnDiagnosticError) {}
    }

    function registerReturnDiagnostics() {
        function register(target, type, name, dom) {
            if (!target || typeof target[dom ? 'addEventListener' : 'follow'] !== 'function') return;
            if (registrationState(name) !== 'pending') return;
            var handler = guardState[name];
            if (typeof handler !== 'function') {
                handler = function () { recordReturnDiagnostic(name.substring(17)); };
                guardState[name] = handler;
            }
            setRegistrationState(name, 'uncertain');
            try {
                if (dom) target.addEventListener(type, handler, false);
                else target.follow(type, handler);
                setRegistrationState(name, 'registered');
            } catch (returnRegistrationError) {} // Never repeat an uncertain registration.
        }
        register(window, 'blur', 'returnDiagnostic_blur', true);
        register(window, 'focus', 'returnDiagnostic_focus', true);
        register(document, 'visibilitychange', 'returnDiagnostic_visibility', true);
        register(Lampa.Controller && Lampa.Controller.listener, 'toggle', 'returnDiagnostic_controller', false);
        register(Lampa.Listener, 'activity', 'returnDiagnostic_activity', false);
    }

    function playbackDiagnosticRecord(eventName, session, reason, dataPresent, identityMatch, observation) {
        try {
            var now = (new Date()).getTime();
            var controller = 'unknown';
            var activityName = 'unknown';
            try {
                var enabled = Lampa.Controller && typeof Lampa.Controller.enabled === 'function' ? Lampa.Controller.enabled() : null;
                if (enabled && enabled.name) controller = playbackDiagnosticLabel(enabled.name);
            } catch (controllerError) {}
            try {
                var activity = Lampa.Activity && typeof Lampa.Activity.active === 'function' ? Lampa.Activity.active() : null;
                if (activity && activity.component) activityName = playbackDiagnosticLabel(activity.component);
            } catch (activityError) {}

            var record = {
                n: ++playbackDiagnosticSequence,
                ms: Math.max(0, now - playbackDiagnosticStartedAt),
                id: session && session.diagnosticId ? session.diagnosticId : 'none',
                event: playbackDiagnosticLabel(eventName),
                controller: controller,
                activity: activityName
            };
            if (reason) record.reason = playbackDiagnosticLabel(reason);
            if (typeof dataPresent === 'boolean') record.data = dataPresent;
            if (typeof identityMatch === 'boolean' || identityMatch === 'not-checked-no-pending') record.sameData = identityMatch;
            if (session) {
                record.phase = playbackDiagnosticLabel(session.phase || 'unknown');
                record.owner = session.restoreOwner ? (session.restoreOwner === activeBrowser ? 'active' : 'other') : 'none';
            }
            if (observation) record.observation = observation;
            while (playbackDiagnosticRecords.length >= PLAYBACK_DIAGNOSTIC_LIMIT) playbackDiagnosticRecords.shift();
            playbackDiagnosticRecords.push(record);
            if (eventName === 'pending-set') {
                var context = activeBrowser && activeBrowser.playbackContext();
                returnDiagnosticAttempt = {
                    id: session.diagnosticId, catalog: context ? context.catalog : 0,
                    folder: context ? context.folder : 0, external: false
                };
                recordReturnDiagnostic('request');
            } else if (eventName === 'player-external') {
                if (identityMatch === true && session && returnDiagnosticAttempt &&
                    returnDiagnosticAttempt.id === session.diagnosticId) returnDiagnosticAttempt.external = true;
                recordReturnDiagnostic(identityMatch === true ? 'external-match' : 'external-other');
            } else if (eventName === 'player-start') recordReturnDiagnostic('player-start');
            else if (eventName === 'pending-cleared' || eventName === 'playback-abandoned') returnDiagnosticAttempt = null;
        } catch (diagnosticError) {}
    }

    function playbackDiagnosticLine(record) {
        var parts = [];
        if (record.reason) parts.push('reason=' + record.reason);
        if (record.data !== undefined) parts.push('data=' + (record.data ? 'yes' : 'no'));
        if (record.sameData !== undefined) {
            parts.push('sameData=' + (record.sameData === true ? 'yes' : record.sameData === false ? 'no' : record.sameData));
        }
        if (record.phase) parts.push('phase=' + record.phase);
        if (record.owner) parts.push('owner=' + record.owner);
        if (record.observation) {
            var sample = record.observation;
            parts.push('E=' + sample.external, 'vis=' + sample.visibility, 'df=' + sample.documentFocus,
                'cat=' + sample.catalog, 'dir=' + sample.folder,
                'origin=' + sample.originCatalog + '/' + sample.originFolder,
                'content=' + sample.content, 'other=' + sample.other,
                'load=' + sample.loading, 'err=' + sample.error, 'res=' + sample.resources, 'nav=' + sample.navigationFocus,
                'hooks=' + sample.hooks);
        }
        parts.push('ctrl=' + record.controller, 'activity=' + record.activity);
        return '#' + record.n + ' +' + record.ms + 'ms ' + record.event + ' [' + record.id + '] | ' + parts.join(' | ');
    }

    function showPlaybackDiagnosticPage(previous) {
        try {
            if (previous) {
                if (!playbackDiagnosticViewSnapshot) {
                    Lampa.Noty.show('Show the playback diagnostic log first.', { time: 30000 });
                    return;
                }
                if (!playbackDiagnosticViewSnapshot.length) {
                    Lampa.Noty.show('Playback diagnostic log is empty.', { time: 30000 });
                    return;
                }
                if (playbackDiagnosticViewEnd <= 0) {
                    Lampa.Noty.show('No older playback diagnostic events remain.', { time: 30000 });
                    return;
                }
            } else {
                playbackDiagnosticViewSnapshot = playbackDiagnosticRecords.slice(0);
                playbackDiagnosticViewEnd = playbackDiagnosticViewSnapshot.length;
            }

            if (!playbackDiagnosticViewSnapshot.length) {
                Lampa.Noty.show('Playback diagnostic log is empty.', { time: 30000 });
                return;
            }

            var end = playbackDiagnosticViewEnd;
            var start = Math.max(0, end - PLAYBACK_DIAGNOSTIC_PAGE_SIZE);
            var page = playbackDiagnosticViewSnapshot.slice(start, end);
            playbackDiagnosticViewEnd = start;
            var lines = [];
            lines.push('DLNA playback log #' + page[0].n + '-' + page[page.length - 1].n + ' (oldest first)');
            lines.push('Use Previous events for older records.');
            lines.push('');
            page.forEach(function (record) { lines.push(playbackDiagnosticLine(record)); });
            Lampa.Noty.show(lines.join('<br>'), { time: 30000 });
        } catch (diagnosticViewError) {
            try { Lampa.Noty.show('Playback diagnostic log is unavailable.', { style: 'error', time: 30000 }); } catch (diagnosticNoticeError) {}
        }
    }

    function showPlaybackDiagnosticLog() {
        showPlaybackDiagnosticPage(false);
    }

    function showPreviousPlaybackDiagnosticLog() {
        showPlaybackDiagnosticPage(true);
    }

    function clearPlaybackDiagnosticLog() {
        try { playbackDiagnosticRecords.length = 0; } catch (diagnosticClearError) {}
        playbackDiagnosticViewSnapshot = null;
        playbackDiagnosticViewEnd = 0;
        try {
            if (Lampa.Noty && typeof Lampa.Noty.show === 'function') {
                Lampa.Noty.show('Playback diagnostic log cleared (memory only)', { style: 'success' });
            }
        } catch (diagnosticNoticeError) {}
    }

    function registerPlaybackDiagnosticListener(type) {
        var name = 'playbackDiagnostic_' + type;
        var state = registrationState(name);
        var listener = Lampa.Player && Lampa.Player.listener;
        var handler = guardState[name];
        if (typeof handler !== 'function') {
            handler = (function (eventType) {
                return function (event) {
                    try {
                        var data = eventType === 'create' ? (event && event.data) : event;
                        var session = pendingPlayback;
                        var sameData = session && session.data ? session.data === data : null;
                        playbackDiagnosticRecord('player-' + eventType, session, 'observed', !!data, sameData);
                        if (eventType === 'start' && sameData && session) session.internalStarted = true;
                        if ((eventType === 'start' || eventType === 'create') && abandonedPlaybackExists && !sameData) {
                            playbackDiagnosticRecord('playback-event-rejected', session, 'unowned-' + eventType, !!data, sameData);
                        }
                    } catch (diagnosticHandlerError) {}
                };
            })(type);
            guardState[name] = handler;
        }
        if (!listener || typeof listener.follow !== 'function' || state === 'registered') return;
        if (state === 'uncertain') {
            if (typeof listener.has !== 'function') return;
            try {
                if (listener.has(type, handler)) {
                    setRegistrationState(name, 'registered');
                    return;
                }
                setRegistrationState(name, 'pending');
            } catch (hasError) { return; }
        }
        setRegistrationState(name, 'uncertain');
        try {
            listener.follow(type, handler);
            setRegistrationState(name, 'registered');
        } catch (followError) {
            if (typeof listener.has === 'function') {
                try {
                    if (listener.has(type, handler)) setRegistrationState(name, 'registered');
                    else setRegistrationState(name, 'pending');
                } catch (hasError) {}
            }
        }
    }

    function registerPlaybackDiagnosticListeners() {
        try { registerPlaybackDiagnosticListener('create'); } catch (createRegistrationError) {}
        try { registerPlaybackDiagnosticListener('start'); } catch (startRegistrationError) {}
        try { registerReturnDiagnostics(); } catch (returnRegistrationError) {}
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
                name: 'DLNA Bridge 1.0.2',
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
            // Parameter already registered in SettingsApi; mark as registered to avoid duplicate entries.
            setRegistrationState(name, 'registered');
            return true;
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
                dlna_bridge_title: { ru: 'DLNA Bridge 1.0.2', en: 'DLNA Bridge 1.0.2' },
                dlna_bridge_server: { ru: 'Адрес DLNA-сервера', en: 'DLNA server address' },
                dlna_bridge_open: { ru: 'Открыть каталог DLNA', en: 'Open DLNA catalog' },
                dlna_bridge_clear: { ru: 'Очистить кеш каталога', en: 'Clear catalog cache' },
                dlna_bridge_androidjs: { ru: 'Проверить AndroidJS', en: 'Inspect AndroidJS' },
                dlna_bridge_renderer_url: { ru: 'URL описания UPnP Renderer', en: 'UPnP Renderer description URL' },
                dlna_bridge_renderer_desc: { ru: 'Ссылка на XML-описание устройства (device.xml / rootDesc.xml) для определения endpoint AVTransport.', en: 'URL to device description XML (device.xml / rootDesc.xml) to resolve AVTransport endpoint.' },
                dlna_bridge_renderer_check: { ru: 'Проверить UPnP Renderer', en: 'Inspect UPnP Renderer' },
                dlna_bridge_renderer_av_check: { ru: 'Проверить AVTransport SOAP', en: 'Verify AVTransport SOAP' },
                dlna_bridge_ssdp_discover: { ru: 'SSDP-поиск устройств (UDP)', en: 'SSDP Device Discovery (UDP)' },
                dlna_bridge_renderer_select: { ru: 'Выбрать активный Renderer', en: 'Select Active Renderer' },
                dlna_bridge_playback_target: { ru: 'Куда отправлять воспроизведение', en: 'Playback Output Target' },
                dlna_bridge_playback_target_desc: { ru: 'Локальный плеер Lampa или внешний UPnP/DLNA Renderer через AVTransport.', en: 'Local Lampa player or external UPnP/DLNA Renderer via AVTransport.' },
                dlna_bridge_renderer_remote: { ru: 'Пульт управления Renderer (Play/Pause/Stop/Seek)', en: 'Renderer Remote Control (Play/Pause/Stop/Seek)' },
                dlna_bridge_about: { ru: 'SOAP Browse и UPnP/DLNA Renderer через Lampa.Reguest.native. SSDP поддерживается только при наличии явного UDP/AndroidJS API.', en: 'SOAP Browse and UPnP/DLNA Renderer via Lampa.Reguest.native. SSDP requires explicit UDP/AndroidJS API.' }
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
            return '[ошибка перечисления свойств]';
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

    function androidBridgeMethodDescriptor(target, name) {
        for (var depth = 0; target && depth <= 2; depth++) {
            try {
                var descriptor = Object.getOwnPropertyDescriptor(target, name);
                if (descriptor) return { descriptor: descriptor, depth: depth };
                target = Object.getPrototypeOf(target);
            } catch (error) {
                return { inspectionError: error };
            }
        }
        return null;
    }

    function androidBridgeMethodSummary(target) {
        var names = ['httpReq', 'get', 'getResp', 'dump'];
        var lines = ['  API methods:'];
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var found = androidBridgeMethodDescriptor(target, name);
            if (!found) {
                lines.push('    ' + name + ': absent; type=undefined; length=unavailable; source=unavailable');
            } else if (found.inspectionError) {
                lines.push('    ' + name + ': inspection error (details omitted)');
            } else if (!Object.prototype.hasOwnProperty.call(found.descriptor, 'value')) {
                lines.push('    ' + name + ': present; type=accessor (not read); length=unavailable; source=unavailable');
            } else {
                var method = found.descriptor.value;
                var methodType = androidBridgeType(method);
                if (methodType !== 'function') {
                    lines.push('    ' + name + ': present; type=' + methodType + '; length=unavailable; source=unavailable');
                } else {
                    var length = 'unavailable';
                    var source = 'unavailable';
                    try {
                        var lengthDescriptor = Object.getOwnPropertyDescriptor(method, 'length');
                        if (lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') &&
                            typeof lengthDescriptor.value === 'number') {
                            length = String(lengthDescriptor.value);
                        }
                    } catch (lengthError) {}
                    try {
                        var methodSource = Function.prototype.toString.call(method);
                        if (typeof methodSource === 'string') {
                            source = methodSource.length > 180 ? methodSource.slice(0, 177) + '...' : methodSource;
                        }
                    } catch (sourceError) {}
                    lines.push('    ' + name + ': present; type=function; length=' + length + '; source=' + source);
                }
            }
        }
        return lines.join('\n');
    }

    function androidBridgeObjectSummary(name, value) {
        var lines = [name + ' (' + androidBridgeType(value) + ')'];
        lines.push('  свойства: ' + androidBridgePropertySummary(value, 12));
        if (name === 'AndroidJS' || name === 'androidJS') lines.push(androidBridgeMethodSummary(value));
        var prototype = value;
        for (var depth = 1; depth <= 2; depth++) {
            try {
                prototype = Object.getPrototypeOf(prototype);
            } catch (error) {
                lines.push('  прототип ' + depth + ': ошибка получения прототипа');
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
                if (names[i] === 'AndroidJS' || names[i] === 'androidJS') lines.push(androidBridgeMethodSummary(null));
            } else if (descriptor.inspectionError) {
                lines.push(names[i] + ': ошибка доступа к дескриптору (подробности опущены)');
            } else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                lines.push(names[i] + ': accessor глобального свойства (не прочитан)');
            } else if (descriptor.value === undefined) {
                lines.push(names[i] + ': undefined');
                if (names[i] === 'AndroidJS' || names[i] === 'androidJS') lines.push(androidBridgeMethodSummary(null));
            } else if (descriptor.value === null) {
                lines.push(names[i] + ': null');
                if (names[i] === 'AndroidJS' || names[i] === 'androidJS') lines.push(androidBridgeMethodSummary(null));
            } else {
                try {
                    lines.push(androidBridgeObjectSummary(names[i], descriptor.value));
                } catch (error) {
                    lines.push(names[i] + ': ошибка инспекции (подробности опущены)');
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
        var req = null;
        var settled = false;

        function clearRequest() {
            if (currentRequest === req) currentRequest = null;
            try { if (req && req.clear) req.clear(); } catch (clearError) {}
        }

        function failRequest(xhr, error) {
            if (settled) return;
            settled = true;
            clearRequest();
            if (xhr && xhr.status) {
                failure(new Error('HTTP ' + xhr.status + ': ' + errorText(error)));
            } else {
                failure(error instanceof Error ? error : new Error(errorText(error || xhr)));
            }
        }

        function completeRequest(raw) {
            if (settled) return;
            var response;
            try {
                response = typeof raw === 'string' ? raw : String(raw || '');
            } catch (responseError) {
                failRequest(null, responseError);
                return;
            }
            settled = true;
            clearRequest();
            success(response);
        }

        try {
            if (!Lampa.Reguest) {
                failRequest(null, new Error('Lampa.Reguest недоступен'));
                return;
            }
            req = new Lampa.Reguest();
            currentRequest = req;
            try { if (req.timeout) req.timeout(20000); } catch (timeoutError) {}
            req.native(url, completeRequest, failRequest, body || null, {
                dataType: 'text',
                timeout: 20000,
                headers: headers || {}
            });
        } catch (requestError) {
            failRequest(null, requestError);
        }
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

    function isValidIpv4(value) {
        var parts = value.split('.');
        if (parts.length !== 4) return false;
        var i;
        for (i = 0; i < parts.length; i++) {
            // Reject ambiguous octal/short forms as well as out-of-range octets.
            if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i]) || Number(parts[i]) > 255) return false;
        }
        return true;
    }

    function isValidIpv6(value) {
        if (value.indexOf(':') < 0) return false;
        if (value.indexOf('.') >= 0) {
            var lastColon = value.lastIndexOf(':');
            if (!isValidIpv4(value.slice(lastColon + 1))) return false;
            // An IPv4 tail occupies two IPv6 groups.
            value = value.slice(0, lastColon + 1) + '0:0';
        }
        var halves = value.split('::');
        if (halves.length > 2) return false;
        var groups = [];
        var i;
        for (i = 0; i < halves.length; i++) {
            if (halves[i]) groups = groups.concat(halves[i].split(':'));
        }
        if (halves.length === 1 ? groups.length !== 8 : groups.length >= 8) return false;
        for (i = 0; i < groups.length; i++) {
            if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return false;
        }
        return true;
    }

    function isValidResourceUrl(value) {
        // 8192 characters leaves ample room for DLNA paths and signed queries while bounding input.
        if (typeof value !== 'string' || value.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(value)) return false;
        if (/%(?![0-9a-f]{2})/i.test(value)) return false;
        var match = /^(https?):\/\/([^\/?#]+)(?:[\/?#].*)?$/i.exec(value);
        if (!match) return false;
        var authority = match[2];
        var at = authority.indexOf('@');
        if (at >= 0) {
            if (!/^(?:[a-z0-9._~!$&'()*+,;=:\-]|%[0-9a-f]{2})+$/i.test(authority.slice(0, at))) return false;
            authority = authority.slice(at + 1);
        }
        var host;
        var port = null;
        if (authority.charAt(0) === '[') {
            var bracket = authority.indexOf(']');
            if (bracket < 0 || !isValidIpv6(authority.slice(1, bracket))) return false;
            var suffix = authority.slice(bracket + 1);
            if (suffix && suffix.charAt(0) !== ':') return false;
            if (suffix) port = suffix.slice(1);
        } else {
            var parts = authority.split(':');
            if (parts.length > 2) return false;
            host = parts[0];
            if (parts.length === 2) port = parts[1];
            if (!host || host.length > 253) return false;
            // Numeric final labels can be interpreted as nonstandard IPv4 by URL parsers.
            if (/^[0-9.]+$/.test(host) || /(?:^|\.)(?:[0-9]+|0x[0-9a-f]+)\.?$/i.test(host)) {
                if (!isValidIpv4(host)) return false;
            } else {
                var labels = host.replace(/\.$/, '').split('.');
                var i;
                for (i = 0; i < labels.length; i++) {
                    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(labels[i])) return false;
                }
            }
        }
        return port === null || (/^[0-9]+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
    }

    // Auxiliary DIDL-Lite resources (thumbnails, subtitles) are not playable media.
    // MiniDLNA may attach them to a video item as extra res elements.
    function isAuxiliaryResourceMime(mime) {
        var value = String(mime || '').toLowerCase();
        if (value.indexOf('image/') === 0 || value.indexOf('text/') === 0) return true;
        return value === 'application/x-subrip' || value === 'application/ttml+xml' ||
            value === 'application/x-ass' || value === 'application/x-ssa';
    }

    function decodeDidl(encoded) {
        var doc = parseXml('<root>' + encoded + '</root>');
        var nodes = doc.getElementsByTagName('*');
        var items = [];
        var returnedCount = 0;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var kind = node.localName || node.nodeName.split(':').pop();
            if (kind !== 'container' && kind !== 'item') continue;
            returnedCount++;
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
                size: 0,
                resources: []
            };
            for (var j = 0; j < node.childNodes.length; j++) {
                var child = node.childNodes[j];
                if (child.nodeType !== 1) continue;
                var name = child.localName || child.nodeName.split(':').pop();
                if (name === 'title') entry.title = child.textContent || '';
                if (name === 'res') {
                    var resourceUrl = String(child.textContent || '').replace(/^\s+|\s+$/g, '');
                    var protocolInfo = child.getAttribute('protocolInfo') || '';
                    if (!resourceUrl || !isValidResourceUrl(resourceUrl)) continue;
                    var duplicate = false;
                    for (var resourceIndex = 0; resourceIndex < entry.resources.length; resourceIndex++) {
                        if (entry.resources[resourceIndex].url === resourceUrl) {
                            duplicate = true;
                            break;
                        }
                    }
                    if (duplicate) continue;
                    var protocolParts = protocolInfo.split(':');
                    var resourceMime = protocolParts.length > 2 ? protocolParts[2] : '';
                    if (isAuxiliaryResourceMime(resourceMime)) continue;
                    var resource = {
                        url: resourceUrl,
                        protocolInfo: protocolInfo,
                        mime: resourceMime,
                        duration: child.getAttribute('duration') || '',
                        size: parseInt(child.getAttribute('size') || '0', 10) || 0,
                        resolution: child.getAttribute('resolution') || '',
                        bitrate: parseInt(child.getAttribute('bitrate') || '0', 10) || 0
                    };
                    entry.resources.push(resource);
                    // Legacy fields describe the first playable resource.
                    if (entry.resources.length > 1) continue;
                    entry.url = resource.url;
                    entry.protocolInfo = resource.protocolInfo;
                    entry.duration = resource.duration;
                    entry.size = resource.size;
                    entry.mime = resource.mime;
                }
            }
            if (entry.title) items.push(entry);
        }
        items.returnedCount = returnedCount;
        return items;
    }

    function soapBrowse(objectId, start, count, success, failure, isCurrent) {
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
            if (isCurrent && !isCurrent()) return;
            var items;
            var total;
            var update;
            var hasUpdate;
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
                var totalText = textOf(doc.documentElement, 'TotalMatches');
                if (typeof totalText !== 'string' || !/^\s*\d+\s*$/.test(totalText)) {
                    throw new Error('Некорректный или отсутствующий TotalMatches');
                }
                total = Number(totalText);
                if (!isFinite(total) || total < 0 || Math.floor(total) !== total || total > 9007199254740991) {
                    throw new Error('Некорректный или слишком большой TotalMatches');
                }
                var updateNodes = doc.getElementsByTagName('UpdateID');
                if (!updateNodes.length) {
                    var updateAll = doc.getElementsByTagName('*');
                    for (var updateIndex = 0; updateIndex < updateAll.length; updateIndex++) {
                        var updateName = updateAll[updateIndex].localName || updateAll[updateIndex].nodeName.split(':').pop();
                        if (updateName === 'UpdateID') {
                            updateNodes = [updateAll[updateIndex]];
                            break;
                        }
                    }
                }
                hasUpdate = !!updateNodes.length;
                update = null;
                if (hasUpdate) {
                    var updateText = updateNodes[0].textContent;
                    if (typeof updateText !== 'string' || !/^\s*\d+\s*$/.test(updateText)) {
                        var invalidUpdateError = new Error('Некорректный UpdateID');
                        invalidUpdateError.noRetry = true;
                        throw invalidUpdateError;
                    }
                    update = Number(updateText);
                    if (!isFinite(update) || update < 0 || Math.floor(update) !== update || update > 4294967295) {
                        var rangeUpdateError = new Error('Некорректный UpdateID');
                        rangeUpdateError.noRetry = true;
                        throw rangeUpdateError;
                    }
                }
                items = decodeDidl(result);
            } catch (e) {
                if (window.console && console.error) console.error('[DLNA Bridge] Browse response parse failed', e, raw);
                var browseError = new Error('Разбор ответа SOAP/DIDL: ' + errorText(e));
                if (e && e.noRetry) browseError.noRetry = true;
                failure(browseError);
                return;
            }
                success(items, total, update, items.returnedCount, hasUpdate);
        }, failure);
    }

    function browseAll(objectId, callback, token) {
        token = token === undefined ? browseToken : token;
        function isCurrent() {
            return token === browseToken;
        }
        if (!isCurrent()) return;
        if (cache[objectId]) { callback(null, cache[objectId].slice()); return; }
        var collected = [];
        var offset = 0;
        var expectedTotal = null;
        var expectedUpdateKnown = false;
        var expectedHasUpdate = false;
        var expectedUpdate = null;
        function page() {
            if (!isCurrent()) return;
            var attempts = 0;
            function requestPage() {
                if (!isCurrent()) return;
                attempts++;
                soapBrowse(objectId, offset, PAGE_SIZE, function (items, total, update, returnedCount, hasUpdate) {
                    if (!isCurrent()) return;
                    returnedCount = typeof returnedCount === 'number' ? returnedCount : items.length;
                    if (expectedTotal === null) expectedTotal = total;
                    else if (total !== expectedTotal) {
                        callback(new Error('TotalMatches изменился во время Browse'));
                        return;
                    }
                    if (!expectedUpdateKnown) {
                        expectedUpdateKnown = true;
                        expectedHasUpdate = hasUpdate === true;
                        expectedUpdate = update;
                        // Compatibility: accept UpdateID only when every page omits it; in that case
                        // concurrent catalog changes cannot be detected for this Browse operation.
                    } else if ((hasUpdate === true) !== expectedHasUpdate ||
                        (expectedHasUpdate && update !== expectedUpdate)) {
                        callback(new Error('UpdateID изменился или отсутствует на одной из страниц Browse'));
                        return;
                    }
                    // Some DLNA servers return an empty/unfinished first response while waking up.
                    // Retry instead of caching an incomplete catalog.
                    if (!returnedCount && total > offset) {
                        if (attempts < 3) {
                            setTimeout(requestPage, attempts * 700);
                            return;
                        }
                        callback(new Error('Browse вернул пустую страницу при наличии элементов'));
                        return;
                    }
                    if (offset + returnedCount > total) {
                        callback(new Error('Browse вернул больше элементов, чем указано в TotalMatches'));
                        return;
                    }
                    collected = collected.concat(items);
                    offset += returnedCount;
                    if (offset < total) {
                        if (offset < MAX_ITEMS) page();
                        else callback(new Error('Каталог превышает лимит элементов; неполный результат не кэширован'));
                        return;
                    }
                    if (offset !== total) {
                        callback(new Error('Не удалось подтвердить полноту каталога'));
                        return;
                    }
                    if (!isCurrent()) return;
                    cache[objectId] = collected.slice();
                    callback(null, collected);
                }, function (error) {
                    if (!isCurrent()) return;
                    if (error && error.noRetry) {
                        callback(error);
                        return;
                    }
                    if (attempts < 3) {
                        setTimeout(requestPage, attempts * 700);
                        return;
                    }
                    callback(error);
                }, isCurrent);
            }
            requestPage();
        }
        page();
    }

    // Legacy UI below is isolated for regression/rollback; openCatalog() uses only DlnaBrowser.
    function nativeSelectVisibility() {
        var select = window.Lampa && Lampa.Select;
        try {
            if (!select || typeof select.opened !== 'function') return null;
            var visible = select.opened();
            return typeof visible === 'boolean' ? visible : null;
        } catch (visibilityError) { return null; }
    }

    function dismissNativeSelect() {
        if (Lampa.Select && typeof Lampa.Select.closeAll === 'function') Lampa.Select.closeAll();
        else if (Lampa.Select && typeof Lampa.Select.close === 'function') Lampa.Select.close();
    }

    function hasNativeSelectApi() {
        var select = window.Lampa && Lampa.Select;
        var controller = window.Lampa && Lampa.Controller;
        return !!(select && typeof select.show === 'function' && nativeSelectVisibility() !== null &&
            (typeof select.closeAll === 'function' || typeof select.close === 'function') && controller &&
            typeof controller.add === 'function' && typeof controller.toggle === 'function' &&
            typeof controller.enabled === 'function' &&
            typeof controller.windowOpen === 'function' && typeof controller.windowClose === 'function' &&
            typeof controller.collectionSet === 'function' && typeof controller.collectionFocus === 'function' &&
            typeof window.$ === 'function');
    }

    function openSelect(title, entries, onSelect, onBack) {
        var previousController = '';
        var nativeState = 'open';
        var nativeMenu = { suspend: suspendNative, resume: resumeNative, retire: retireNative };
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
            invalidateBrowseRequests();
            restoreController();
            if (onSelect) onSelect(selected);
        }

        function backFromSelect() {
            invalidateBrowseRequests();
            restoreController();
            if (onBack) onBack();
        }

        function ownsNative() {
            return (nativeState === 'open' || nativeState === 'pending') &&
                activeNativeMenu === nativeMenu &&
                activeMenuClose === (nativeState === 'pending' ? closePendingNative : closeNative);
        }

        function isCurrentNative() {
            return nativeState === 'open' && ownsNative();
        }

        // Menu ownership is independent of asynchronous Browse generations.
        function finishNative(state) {
            if (!ownsNative()) return false;
            nativeState = state;
            activeNativeMenu = null;
            activeMenuClose = null;
            deactivateKeypadBackDiagnostic();
            return true;
        }

        function suspendNative() {
            if (isCurrentNative()) {
                nativeState = 'pending';
                activeMenuClose = closePendingNative;
            }
        }

        function resumeNative() {
            if (!ownsNative()) return;
            var recoveryToken = browseToken;
            // Never revive a suspended instance: opened() may report stale visibility.
            if (!finishNative('closed')) return;
            var useDom = false;
            try { dismissNativeSelect(); } catch (closeError) { useDom = true; }
            if (activeMenuClose || recoveryToken !== browseToken) return;
            restoreController();
            if (activeMenuClose || recoveryToken !== browseToken) return;
            // Reuse the loaded rows, not the old callbacks; recovery needs no Browse.
            if (useDom || !hasNativeSelectApi()) openSelectDom(title, entries, selectItem, backFromSelect);
            else openSelect(title, entries, onSelect, onBack);
        }

        function retireNative() {
            finishNative('closed');
        }

        function closeNative() {
            if (isCurrentNative()) closeOwnedNative();
        }

        function closePendingNative() {
            if (nativeState === 'pending' && ownsNative()) closeOwnedNative();
        }

        function closeOwnedNative() {
            // The active close handle remains usable during a pending Browse.
            if (!finishNative('closed')) return;
            invalidateBrowseRequests();
            // Programmatic dismissal must not navigate through onBack.
            dismissNativeSelect();
        }

        if (!hasNativeSelectApi()) {
            if (activeNativeMenu) activeNativeMenu.retire();
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
                        if (!isCurrentNative() || !validateMenuSelection(entry)) return;
                        if (!finishNative('selected')) return;
                        selectItem(entry);
                    }
                };
            });
            var diagnostic = document.createElement('div');
            diagnostic.style.cssText = 'white-space:pre-wrap;font-size:14px;color:#ffd27a;opacity:.95;padding:12px 4px;';
            backDiagnosticElement = diagnostic;
            renderBackDiagnostics();

            if (activeNativeMenu) activeNativeMenu.retire();
            activeNativeMenu = nativeMenu;
            activeMenuClose = closeNative;
            activateKeypadBackDiagnostic();
            Lampa.Select.show({
                title: title,
                items: items,
                onFullDraw: function (scroll) {
                    try { scroll.append(window.$(diagnostic)); } catch (e) {}
                },
                onBack: function () {
                    if (!isCurrentNative() || !finishNative('back')) return;
                    backFromSelect();
                }
            });
        } catch (e) {
            if (!ownsNative()) return;
            finishNative('closed');
            try { dismissNativeSelect(); } catch (closeError) {}
            if (activeMenuClose) return;
            restoreController();
            if (activeMenuClose) return;
            openSelectDom(title, entries, selectItem, backFromSelect);
        }
    }

    function playbackUrl(entry, selectedResource) {
        var resource = selectedResource || (entry && entry.resources && entry.resources.length === 1 ? entry.resources[0] : null);
        return resource ? resource.url : (entry && entry.url ? entry.url : '');
    }

    function validatePlaybackUrl(url) {
        if (isValidResourceUrl(url)) return true;
        notify('Недопустимый URL ресурса DLNA.', 'error');
        return false;
    }

    function validateMenuSelection(selected) {
        var entry = selected.entry || selected;
        if (!selected.resource && (entry.isFolder || (entry.resources && entry.resources.length > 1))) return true;
        return validatePlaybackUrl(playbackUrl(entry, selected.resource));
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
        var closed = false;
        var pendingChoice = null;
        function close() {
            if (closed) return;
            closed = true;
            if (pendingChoice !== null) clearTimeout(pendingChoice);
            pendingChoice = null;
            invalidateBrowseRequests();
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
            if (closed || choosing || index < 0 || index >= entries.length) return;
            focusIndex(index);
            var selected = entries[index];
            if (!validateMenuSelection(selected)) return;
            choosing = true;
            // Keep Back and focus available during the remote-control debounce delay.
            pendingChoice = setTimeout(function () {
                pendingChoice = null;
                if (closed) return;
                choosing = false;
                // Cached entries may have changed while the choice was pending.
                if (!validateMenuSelection(selected)) return;
                close();
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
            } else if (choosing) {
                swallow(event);
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
        if (bytes > 0 && bytes < 1024) return Math.round(bytes) + ' Б';
        if (bytes > 0 && bytes < 1048576) return Math.round(bytes / 1024) + ' КБ';
        var gb = bytes / 1073741824;
        return gb >= 1 ? gb.toFixed(2) + ' ГБ' : (bytes / 1048576).toFixed(0) + ' МБ';
    }

    function formatResourceSubtitle(resource) {
        var details = [];
        if (resource.mime) details.push(resource.mime);
        if (resource.resolution) details.push(resource.resolution);
        if (resource.bitrate > 0) details.push(Math.round(resource.bitrate / 1000) + ' кбит/с');
        if (resource.duration) details.push(resource.duration);
        if (resource.size > 0) details.push(formatSize(resource.size));
        return details.join(' · ') || 'Характеристики не указаны';
    }

    function showResourceSelect(entry, objectId, title, parents) {
        var rows = entry.resources.map(function (resource, index) {
            return {
                title: (entry.title || 'Видео') + ' — ресурс ' + (index + 1),
                subtitle: formatResourceSubtitle(resource),
                entry: entry,
                resource: resource
            };
        });
        openSelect('Выберите ресурс: ' + (entry.title || 'Видео'), rows, function (selected) {
            if (selected && selected.resource && selected.resource.url) play(entry, selected.resource);
        }, function () {
            showFolder(objectId, title, parents);
        });
    }

    function play(entry, selectedResource, playbackLifecycle) {
        var playUrl = playbackUrl(entry, selectedResource);
        // Final validation is mandatory even after a menu preflight.
        if (!validatePlaybackUrl(playUrl)) return;
        if (String(setting('playback_target', 'local') || 'local') === 'renderer') {
            if (playbackLifecycle) {
                completePlaybackSession(playbackLifecycle, false, 'routed-to-upnp-renderer');
            }
            playOnActiveRenderer(entry, selectedResource);
            return;
        }
        var menu = document.getElementById('dlna-bridge-menu');
        if (menu) {
            menu.style.display = 'none';
            menu.style.visibility = 'hidden';
            menu.style.pointerEvents = 'none';
            if (menu.parentNode) menu.parentNode.removeChild(menu);
        }
        notify('Выбран файл: ' + (entry.title || 'без названия'), 'default');
        if (!Lampa.Player || !Lampa.Player.play) {
            notify('Файл найден, но Lampa.Player.play недоступен в этой сборке.', 'error');
            return;
        }
        try {
            var currentController = Lampa.Controller && typeof Lampa.Controller.enabled === 'function' ? Lampa.Controller.enabled() : null;
            if (playbackLifecycle) {
                if (typeof Lampa.Player.callback === 'function') {
                    playbackDiagnosticRecord('callback-register', playbackLifecycle, 'attempt');
                    Lampa.Player.callback(playbackLifecycle.returned);
                    playbackDiagnosticRecord('callback-register', playbackLifecycle, 'setter-returned');
                } else playbackDiagnosticRecord('callback-register', playbackLifecycle, 'api-unavailable');
            } else {
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
            }
        } catch (controllerError) {}
        try {
            var playData = {
                url: playUrl,
                title: entry.title,
                quality: 'DLNA'
            };
            if (playbackLifecycle) playbackLifecycle.data = playData;
            if (playbackLifecycle) playbackDiagnosticRecord('player-play-before', playbackLifecycle, 'call');
            Lampa.Player.play(playData);
            if (playbackLifecycle) playbackDiagnosticRecord('player-play-after', playbackLifecycle, 'returned');
        } catch (e) {
            if (playbackLifecycle) completePlaybackSession(playbackLifecycle, false, 'player-play-threw');
            playerReturnController = null;
            try {
                if (typeof Lampa.Player.callback === 'function') Lampa.Player.callback(null);
            } catch (callbackError) {}
            notify('Ошибка запуска плеера: ' + errorText(e), 'error');
        }
    }

    function invalidateBrowseRequests(skipMenuRecovery) {
        browseToken++;
        if (!skipMenuRecovery && activeNativeMenu) activeNativeMenu.resume();
    }

    function bindSettingsLifecycle() {
        var settings = window.Lampa && Lampa.Settings;
        var listener = settings && settings.listener;
        if (!listener || typeof listener.follow !== 'function') return;

        var handler = guardState.settingsLifecycleHandler;
        if (typeof handler !== 'function') {
            handler = function (event) {
                resetAndroidReturnCycle();
                recordReturnDiagnostic(event && event.name ? 'settings-open' : 'settings-close');
                // Settings emits open for its main screen and each component.
                // Leaving this plugin's settings component invalidates an in-flight Browse.
                // The Activity owns cancellation while the component exists.
                if (!activeBrowser && (!event || event.name !== COMPONENT)) invalidateBrowseRequests();
            };
            guardState.settingsLifecycleHandler = handler;
        }

        if (guardState.settingsLifecycleState === 'registered') return;
        if (guardState.settingsLifecycleState === 'uncertain') {
            if (typeof listener.has !== 'function') return;
            try {
                if (listener.has('open', handler) && listener.has('close', handler)) {
                    guardState.settingsLifecycleState = 'registered';
                    return;
                }
            } catch (hasError) { return; }
        }

        guardState.settingsLifecycleState = 'uncertain';
        try {
            listener.follow('open,close', handler);
            guardState.settingsLifecycleState = 'registered';
        } catch (followError) {
            if (typeof listener.has === 'function') {
                try {
                    if (listener.has('open', handler) && listener.has('close', handler)) {
                        guardState.settingsLifecycleState = 'registered';
                        return;
                    }
                } catch (hasError) {}
            }
            guardState.settingsLifecycleState = 'uncertain';
        }
    }

    function showFolder(objectId, title, parents) {
        var suspendedMenu = activeNativeMenu;
        if (suspendedMenu) suspendedMenu.suspend();
        var token = ++browseToken;
        function recoverMenu() {
            if (suspendedMenu) { suspendedMenu.resume(); return; }
            // Native/DOM selection may already have hidden the previous menu.
            if (!activeMenuClose && parents && parents.length) {
                var parent = parents[parents.length - 1];
                showFolder(parent.id, parent.title, parents.slice(0, -1));
            }
        }
        notify('Загрузка: ' + title);
        browseAll(objectId, function (error, items) {
            if (token !== browseToken) return;
            if (error) {
                recoverMenu();
                notify('Ошибка Browse: ' + errorText(error), 'error');
                return;
            }
            if (!items.length) {
                recoverMenu();
                notify('Папка пуста.');
                return;
            }
            var rows = items.map(function (entry) {
                var subtitle = entry.isFolder ? ('Папка' + (entry.childCount ? ' · ' + entry.childCount : '')) :
                    (entry.resources && entry.resources.length > 1 ? 'Ресурсов: ' + entry.resources.length :
                        [entry.mime, entry.duration, formatSize(entry.size)].filter(Boolean).join(' · '));
                return {
                    title: entry.title,
                    subtitle: subtitle,
                            entry: entry
                };
            });
            openSelect(title, rows, function (selected) {
                var entry = selected.entry || selected;
                if (entry.isFolder) showFolder(entry.id, entry.title, (parents || []).concat([{ id: objectId, title: title }]));
                else if (entry.resources && entry.resources.length > 1) showResourceSelect(entry, objectId, title, parents || []);
                else play(entry, entry.resources && entry.resources.length ? entry.resources[0] : null);
            }, function () {
                if (parents && parents.length) {
                    var parent = parents[parents.length - 1];
                    showFolder(parent.id, parent.title, parents.slice(0, -1));
                }
            });
        }, token);
    }

    function openLegacyCatalog() {
        bindSettingsLifecycle();
        showFolder('0', 'DLNA — ' + baseUrl(), []);
    }

    // Recovery authorizes another attempt; it cannot cancel a queued native Android request.
    // Keep only one confirmation and a scalar tombstone, never an unbounded list of payloads/owners.
    function recoveryRecord(eventName, state, reason) {
        playbackDiagnosticRecord(eventName, state && state.summary, reason);
    }

    function invalidateAndroidRecovery(reason) {
        var state = androidRecoveryConfirmation;
        if (!state) return;
        recoveryRecord('recovery-confirm-stale', state, reason);
        state.cancelOnly = true;
        state.session = null;
        if (reason === 'activity-changed') { state.activity = null; state.exitActivity = null; }
    }

    function retireAndroidRecovery(state) {
        if (androidRecoveryConfirmation === state) androidRecoveryConfirmation = null;
        state.closed = true;
        state.session = null;
        state.activity = null;
        state.node = null;
        state.frame = null;
        state.below = null;
        state.exitActivity = null;
    }

    // Closing our window does not require permission to abandon a playback attempt.
    function closeAndroidRecovery(state) {
        if (state.closed || state.opening || state.foreignOpening || !state.node) return false;
        try {
            if (Lampa.Modal.render()[0] !== state.node || !state.node.parentNode ||
                Lampa.Controller.windowTop() !== (state.frame || state.below)) return false;
        } catch (error) { return false; }
        var activity = state.exitActivity || state.activity;
        var origin = state.exitActivity ? state.exitOrigin : state.origin;
        retireAndroidRecovery(state); // Consume before close() sends synchronous events.
        Lampa.Modal.close();
        if (activity && Lampa.Activity.active() === activity && !Lampa.Modal.opened() &&
            !Lampa.Controller.windowTop() && Lampa.Controller.enabled().name === 'modal') {
            Lampa.Controller.toggle(origin);
        }
        return true;
    }

    function bindAndroidRecoveryContext() {
        if (registrationState('androidRecoveryContext') === 'registered') return true;
        if (registrationState('androidRecoveryContext') !== 'pending') return false;
        var events = Lampa.Listener;
        var modal = Lampa.Modal;
        var controller = Lampa.Controller;
        if (!events || typeof events.follow !== 'function' || !modal || !modal.listener ||
            typeof modal.listener.follow !== 'function' || !controller.listener ||
            typeof controller.listener.follow !== 'function') return false;
        setRegistrationState('androidRecoveryContext', 'uncertain');
        try {
            events.follow('activity', function () { invalidateAndroidRecovery('activity-changed'); });
            controller.listener.follow('toggle', function (event) {
                var state = androidRecoveryConfirmation;
                if (!state) return;
                if (event.name !== 'modal') {
                    invalidateAndroidRecovery('controller-changed');
                    if (state.opening) { state.exitActivity = Lampa.Activity.active(); state.exitOrigin = event.name; }
                }
                else if (state.node && modal.render()[0] === state.node) state.frame = controller.windowTop();
            });
            modal.listener.follow('preshow', function (event) {
                var state = androidRecoveryConfirmation;
                if (state && event.active !== state.params) {
                    state.foreignOpening = true;
                    invalidateAndroidRecovery('modal-changed');
                }
            });
            modal.listener.follow('fullshow', function (event) {
                var state = androidRecoveryConfirmation;
                if (!state) return;
                if (event.active === state.params) state.node = event.html[0];
                else state.foreignOpening = false;
            });
            modal.listener.follow('close', function (event) {
                var state = androidRecoveryConfirmation;
                if (!state) return;
                if (event.active === state.params) retireAndroidRecovery(state);
                else state.foreignOpening = false;
            });
            setRegistrationState('androidRecoveryContext', 'registered');
            return true;
        } catch (error) { return false; }
    }

    function ownsAndroidRecovery(state) {
        try {
            return !state.closed && !state.cancelOnly && androidRecoveryConfirmation === state && Lampa.Activity.active() === state.activity &&
                Lampa.Controller.enabled().name === 'modal' && Lampa.Modal.opened() &&
                Lampa.Modal.render()[0] === state.node && Lampa.Controller.windowTop() === state.frame;
        } catch (error) { return false; }
    }

    function resolveAndroidRecovery(state, allow, reason) {
        if (!allow) {
            if (closeAndroidRecovery(state)) recoveryRecord('recovery-cancelled', state, reason || 'user-cancel');
            else recoveryRecord('recovery-confirm-stale', state, 'confirmation-not-current');
            return;
        }
        if (!ownsAndroidRecovery(state) || pendingPlayback !== state.session || !state.session ||
            (allow && (state.cancelOnly || state.session.phase !== 'external' || state.session.internalStarted))) {
            recoveryRecord('recovery-confirm-stale', state, 'confirmation-not-current');
            return;
        }
        var session = state.session;
        recoveryRecord(allow ? 'recovery-accepted' : 'recovery-cancelled', state, reason || (allow ? 'user-permission' : 'user-cancel'));
        state.cancelOnly = true; // Consume permission before any reentrant event.
        state.session = null;
        if (allow) {
            abandonPlaybackSession(session, 'user-permission-not-completion');
        }
        closeAndroidRecovery(state);
    }

    function abandonPlaybackSession(session, reason) {
        if (!session || pendingPlayback !== session) return false;
        pendingPlayback = null;
        resetAndroidReturnCycle();
        androidReturnState = null;
        session.phase = 'abandoned';
        var owner = session.restoreOwner;
        session.restoreOwner = null;
        abandonedPlaybackExists = true;
        androidReturnLog('playback-abandoned', session, reason);
        if (owner && typeof owner.playbackAbandoned === 'function') owner.playbackAbandoned(session);
        if (activeBrowser && activeBrowser !== owner) activeBrowser.playbackAbandoned(session);
        return true;
    }

    function requestAndroidRecovery() {
        var session = pendingPlayback;
        playbackDiagnosticRecord('recovery-request', session, 'settings-action');
        var reason = !session ? 'no-pending' : session.internalStarted ? 'internal-player' :
            session.phase !== 'external' ? 'external-not-observed' : '';
        if (!reason && (!Lampa.Platform || typeof Lampa.Platform.is !== 'function' || !Lampa.Platform.is('android'))) reason = 'not-android';
        if (reason) {
            playbackDiagnosticRecord('recovery-refused', session, reason);
            notify(!session ? 'Незавершённого запуска нет' : reason === 'internal-player' ?
                'Текущая попытка относится к встроенному плееру. Android-восстановление неприменимо.' :
                reason === 'not-android' ? 'Восстановление доступно только в Android-оболочке.' :
                'Передача запуска Android ещё не наблюдалась. Новая попытка остаётся заблокированной.', 'error');
            return;
        }
        var modal = Lampa.Modal;
        var controller = Lampa.Controller;
        var origin = controller && typeof controller.enabled === 'function' ? controller.enabled().name : '';
        if (!modal || typeof modal.open !== 'function' || typeof modal.close !== 'function' ||
            typeof modal.opened !== 'function' || typeof modal.render !== 'function' ||
            !Lampa.Activity || typeof Lampa.Activity.active !== 'function' ||
            !controller || typeof controller.windowTop !== 'function' || typeof controller.toggle !== 'function' ||
            (origin !== 'settings' && origin !== 'settings_component') || modal.opened() ||
            !window.$ || !bindAndroidRecoveryContext()) {
            playbackDiagnosticRecord('recovery-refused', session, 'confirmation-unavailable');
            notify('Штатное подтверждение Lampa недоступно. Запуск остаётся заблокированным.', 'error');
            return;
        }
        var state = {
            session: session, activity: Lampa.Activity.active(), origin: origin, opening: true,
            below: controller.windowTop(), exitActivity: Lampa.Activity.active(), exitOrigin: origin,
            summary: { diagnosticId: session.diagnosticId, phase: session.phase }
        };
        state.params = {
            title: 'Разрешить новую попытку — Android',
            html: window.$('<div></div>').text('Предыдущий Android-запрос нельзя гарантированно отменить. Разрешение новой попытки может привести к дополнительному позднему запуску. Подтверждайте только после возврата из плеера.'),
            buttons: [
                { name: 'Отмена', onSelect: function () { resolveAndroidRecovery(state, false); } },
                { name: 'Разрешить новую попытку', onSelect: function () { resolveAndroidRecovery(state, true); } }
            ],
            onBack: function () { resolveAndroidRecovery(state, false); }
        };
        androidRecoveryConfirmation = state;
        try {
            modal.open(state.params);
            if (!state.node) throw new Error('confirmation unavailable');
        } catch (error) {
            invalidateAndroidRecovery('confirmation-open-failed');
            notify('Не удалось открыть подтверждение. Запуск остаётся заблокированным.', 'error');
        }
        state.opening = false;
        // open() may complete a session, displace this window, or throw after DOM insertion.
        if (!state.closed) {
            var rendered = modal.render() && modal.render()[0];
            var content = state.params.html[0];
            while (content && content !== rendered) content = content.parentNode;
            if (!state.node && rendered && rendered.parentNode && content === rendered) state.node = rendered;
            var top = controller.windowTop();
            if (state.node && rendered === state.node && top && top !== state.below && top.name === 'modal') state.frame = top;
            if (!ownsAndroidRecovery(state) || pendingPlayback !== state.session) {
                invalidateAndroidRecovery('confirmation-not-current');
                if (!closeAndroidRecovery(state) && !state.node) retireAndroidRecovery(state);
            }
        }
    }

    function completePlaybackSession(session, restore, reason) {
        if (!session || pendingPlayback !== session) {
            playbackDiagnosticRecord('completion-rejected', session, reason || 'session-not-current');
            return;
        }
        var confirmation = androidRecoveryConfirmation;
        if (confirmation && confirmation.session === session) {
            if (ownsAndroidRecovery(confirmation)) resolveAndroidRecovery(confirmation, false, 'session-completed');
            else invalidateAndroidRecovery('session-completed');
        }
        var target = session.restoreOwner;
        playbackDiagnosticRecord('completion-accepted', session, reason || 'unspecified');
        pendingPlayback = null;
        session.phase = 'finished';
        session.restoreOwner = null;
        playbackDiagnosticRecord('pending-cleared', session, reason || 'unspecified');
        if (target && typeof target.playbackFinished === 'function') target.playbackFinished(session, restore);
    }

    function handlePlayerExternal(data) {
        var session = pendingPlayback;
        playbackDiagnosticRecord('player-external', session, session ? 'observed' : 'no-pending', !!data,
            session && session.data ? session.data === data : null);
        if (!session || session.data !== data || session.phase === 'finished' || session.internalStarted) {
            if (abandonedPlaybackExists) playbackDiagnosticRecord('playback-event-rejected', session, 'unowned-external', !!data, false);
            return;
        }
        session.phase = 'external';
        if (androidReturnState && androidReturnState.id === session.diagnosticId) androidReturnState.external = true;
        if (session.restoreOwner && typeof session.restoreOwner.playbackChanged === 'function') {
            session.restoreOwner.playbackChanged(session);
        }
    }

    // Global Player lifecycle listeners are intentionally plugin-lifetime subscriptions.
    // They are registered once per GUARD and are not removed, so listener.remove is not required.
    function registerPlayerExternalListener() {
        var name = 'playerExternalListener';
        var state = registrationState(name);
        var listener = Lampa.Player && Lampa.Player.listener;
        var handler = guardState.playerExternalHandler;
        if (typeof handler !== 'function') {
            handler = function (data) { handlePlayerExternal(data); };
            guardState.playerExternalHandler = handler;
        }
        if (!listener || typeof listener.follow !== 'function') return;
        if (state === 'registered') return;
        if (state === 'uncertain') {
            if (typeof listener.has !== 'function') return;
            try {
                if (listener.has('external', handler)) {
                    setRegistrationState(name, 'registered');
                    return;
                }
                setRegistrationState(name, 'pending');
            } catch (hasError) { return; }
        }
        setRegistrationState(name, 'uncertain');
        try {
            listener.follow('external', handler);
            setRegistrationState(name, 'registered');
        } catch (error) {
            logRegistrationError('Подписка Player.external завершилась исключением', error);
            if (typeof listener.has === 'function') {
                try {
                    if (listener.has('external', handler)) setRegistrationState(name, 'registered');
                    else setRegistrationState(name, 'pending');
                } catch (hasError) {}
            }
        }
    }

    // Callback identity belongs to one playback, never a mutable component or controller.
    function playbackReturnCallback(session) {
        return function () {
            playbackDiagnosticRecord('callback-enter', session, 'dlna-return-callback');
            completePlaybackSession(session, true, 'callback');
        };
    }

    // Original ES5 Activity implementation; no third-party component source is embedded.
    function DlnaBrowser(options) {
        options = options || {};
        var self = this;
        var root = null;
        var viewport = null;
        var list = null;
        var heading = null;
        var status = null;
        var rows = [];
        var destroyed = false;
        var exiting = false;
        var running = false;
        var loading = false;
        var playback = null;
        var generation = 0;
        var renderGeneration = 0;
        var restoringFocus = false;
        var error = '';
        var parents = [];
        var frame = { id: options.objectId || '0', title: options.title || 'DLNA', items: null, index: 0, scroll: 0 };
        var resourceEntry = null;
        var resourceIndex = 0;
        var resourceScroll = 0;
        var diagnosticCatalog = ++returnDiagnosticCatalogSequence;
        var diagnosticController = null;
        frame.diagnosticFolder = ++returnDiagnosticFolderSequence;

        this.playbackContext = function () {
            var enabled = Lampa.Controller.enabled();
            var selected = rows[selectedIndex()];
            return {
                catalog: diagnosticCatalog, folder: frame.diagnosticFolder, current: current() && running && !exiting,
                ready: !!root && !!root.parentNode && frame.items !== null,
                content: !!diagnosticController && enabled.name === 'content' && enabled.controller === diagnosticController,
                loading: loading, error: !!error, resources: !!resourceEntry,
                navigationFocus: !!selected && /(?:^|\s)focus(?:\s|$)/.test(selected.className)
            };
        };

        function current() {
            if (destroyed || activeBrowser !== self) return false;
            var activity = Lampa.Activity && typeof Lampa.Activity.active === 'function' ? Lampa.Activity.active() : null;
            return Lampa.Activity && typeof Lampa.Activity.active === 'function' ?
                !!activity && activity.activity === self.activity : true;
        }

        function save() {
            if (!viewport) return;
            if (resourceEntry) resourceScroll = viewport.scrollTop || 0;
            else frame.scroll = viewport.scrollTop || 0;
        }

        function selectedIndex() { return resourceEntry ? resourceIndex : frame.index; }

        function remember(index) {
            if (resourceEntry) resourceIndex = index;
            else frame.index = index;
        }

        function highlight(index) {
            var i;
            for (i = 0; i < rows.length; i++) {
                rows[i].style.background = i === index ? 'rgba(80,145,220,.38)' : 'rgba(128,128,128,.14)';
                rows[i].style.outline = i === index ? '2px solid #8fc7ff' : 'none';
            }
        }

        function focus(index, restore) {
            if (!running || !current() || !rows.length) return;
            index = Math.max(0, Math.min(index, rows.length - 1));
            remember(index);
            highlight(index);
            var position = resourceEntry ? resourceScroll : frame.scroll;
            restoringFocus = !!restore;
            try {
                Lampa.Controller.collectionSet(window.$(root));
                Lampa.Controller.collectionFocus(rows[index], window.$(root));
                if (restore) viewport.scrollTop = position;
                else if (rows[index].offsetTop < viewport.scrollTop) viewport.scrollTop = rows[index].offsetTop;
                else if (rows[index].offsetTop + rows[index].offsetHeight > viewport.scrollTop + viewport.clientHeight) {
                    viewport.scrollTop = rows[index].offsetTop + rows[index].offsetHeight - viewport.clientHeight;
                }
            } finally { restoringFocus = false; }
        }

        function drawStatus() {
            if (!status) return;
            status.textContent = loading ? '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430\u2026' :
                (playback && playback.phase === 'external' ? '\u0412\u043d\u0435\u0448\u043d\u0438\u0439 \u043f\u043b\u0435\u0435\u0440: \u0412\u044b\u0445\u043e\u0434\u0438\u0442\u0435 \u0438\u0437 \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0430 \u043a\u043d\u043e\u043f\u043a\u043e\u0439 Back; \u0437\u0430\u043f\u0443\u0441\u043a \u043e\u0441\u0442\u0430\u0451\u0442\u0441\u044f \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043e \u0434\u043e \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d\u043d\u043e\u0433\u043e \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u044f' :
                    (playback && playback.phase === 'launching' ? '\u0417\u0430\u043f\u0443\u0441\u043a \u043f\u043b\u0435\u0435\u0440\u0430: Back \u2014 \u0432 \u043a\u0430\u0442\u0430\u043b\u043e\u0433; \u043f\u043e\u0432\u0442\u043e\u0440\u043d\u044b\u0439 \u0437\u0430\u043f\u0443\u0441\u043a \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d' : error));
            status.style.color = error && !loading ? '#ffb080' : '';
            root.setAttribute('aria-busy', loading ? 'true' : 'false');
            observeAndroidReturn('context');
        }

        function renderRows() {
            if (!root || destroyed) return;
            var view = ++renderGeneration;
            while (list.firstChild) {
                window.$(list.firstChild).off();
                list.removeChild(list.firstChild);
            }
            rows = [];
            heading.textContent = resourceEntry ? resourceEntry.title : frame.title;
            var items = resourceEntry ? resourceEntry.resources : (frame.items || []);
            var empty = !items.length;
            var count = empty ? 1 : items.length;
            var i;
            for (i = 0; i < count; i++) {
                (function (index) {
                    var item = items[index];
                    var row = document.createElement('div');
                    row.className = 'selector dlna-browser-row';
                    row.tabIndex = 0;
                    row.style.cssText = 'padding:16px 20px;margin:6px 0;border-radius:8px;background:rgba(128,128,128,.14);white-space:pre-wrap;';
                    if (empty) row.textContent = frame.items === null ? '\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c' : '\u041f\u0443\u0441\u0442\u0430\u044f \u043f\u0430\u043f\u043a\u0430. \u041d\u0430\u0437\u0430\u0434';
                    else if (resourceEntry) row.textContent = '\u0420\u0435\u0441\u0443\u0440\u0441 ' + (index + 1) + '\n' + formatResourceSubtitle(item);
                    else row.textContent = (item.isFolder ? '\u25a3 ' : '\u25b6 ') + item.title + (item.isFolder ? '' : '\n' + formatResourceSubtitle(item));
                    window.$(row).on('hover:enter click', function () {
                        if (view === renderGeneration) self.select(index);
                    });
                    window.$(row).on('mousedown touchstart', androidReturnPointer);
                    window.$(row).on('hover:focus', function () {
                        if (view !== renderGeneration || destroyed || !running || !current()) return;
                        remember(index);
                        highlight(index);
                        if (!restoringFocus) save();
                    });
                    list.appendChild(row);
                    rows.push(row);
                })(i);
            }
            drawStatus();
            focus(selectedIndex(), true);
            recordReturnDiagnostic('folder');
        }

        function cancelLoad() {
            if (!loading) return;
            generation++;
            loading = false;
            if (activeBrowser === self) browseToken++;
            error = '';
            drawStatus();
        }

        function load(id, title, forward) {
            if (!current()) return;
            save();
            cancelLoad();
            loading = true;
            error = '';
            var requestGeneration = ++generation;
            var token = ++browseToken;
            drawStatus();
            browseAll(id, function (browseError, items) {
                if (!current() || destroyed || requestGeneration !== generation || token !== browseToken) return;
                loading = false;
                if (browseError) {
                    error = '\u041e\u0448\u0438\u0431\u043a\u0430 Browse: ' + errorText(browseError);
                    drawStatus();
                    focus(selectedIndex(), true);
                    return;
                }
                var diagnosticFolder = forward ? ++returnDiagnosticFolderSequence : frame.diagnosticFolder;
                if (forward) parents.push(frame);
                frame = { id: id, title: title, items: items, index: 0, scroll: 0 };
                frame.diagnosticFolder = diagnosticFolder;
                resourceEntry = null;
                error = '';
                renderRows();
            }, token);
        }

        function launch(entry, resource) {
            if (!validatePlaybackUrl(playbackUrl(entry, resource))) return;
            if (String(setting('playback_target', 'local') || 'local') === 'renderer') {
                save();
                playOnActiveRenderer(entry, resource);
                return;
            }
            if (!Lampa.Player || typeof Lampa.Player.play !== 'function') {
                notify('Lampa.Player.play unavailable', 'error');
                return;
            }
            if (pendingPlayback) {
                playbackDiagnosticRecord('launch-blocked', pendingPlayback, 'previous-launch-pending');
                notify('DLNA: previous player launch has not completed', 'error');
                return;
            }
            var listener = Lampa.Player.listener;
            if (!listener || typeof listener.follow !== 'function' ||
                registrationState('playerCloseListener') !== 'registered' ||
                registrationState('playerExternalListener') !== 'registered') {
                notify('DLNA: Player listener API unavailable; cannot safely track playback lifecycle', 'error');
                return;
            }
            save();
            var session = {
                diagnosticId: 'p' + (++playbackDiagnosticAttemptSequence),
                phase: 'launching',
                data: null,
                restoreOwner: self
            };
            session.returned = playbackReturnCallback(session);
            playback = session;
            pendingPlayback = session;
            playbackDiagnosticRecord('pending-set', session, 'launch-approved');
            beginAndroidReturn(session);
            play(entry, resource, session);
            drawStatus();
        }

        function controllerName() {
            var enabled = Lampa.Controller && typeof Lampa.Controller.enabled === 'function' ? Lampa.Controller.enabled() : null;
            return enabled && enabled.name;
        }

        this.playbackChanged = function (session) {
            if (playback !== session || destroyed) return;
            playbackDiagnosticRecord('browser-playback-changed', session, 'session-update');
            drawStatus();
        };

        this.playbackFinished = function (session, restore) {
            if (playback !== session) return;
            playbackDiagnosticRecord('browser-playback-finished', session, restore ? 'restore-requested' : 'no-restore');
            playback = null;
            drawStatus();
            if (!restore || !running || !current()) return;
            var name = controllerName();
            // Never dismiss Settings or another overlay to restore a player session.
            if (name === 'content') focus(selectedIndex(), true);
            else if (name === 'player' || name === 'player-loading' || name === 'player_panel' ||
                name === 'player_rewind' || name === 'player_footer') Lampa.Controller.toggle('content');
        };

        this.playbackAbandoned = function (session) {
            if (playback !== session) return;
            playback = null;
            if (!destroyed) drawStatus();
        };

        this.playerClosed = function (event) {
            if (playback && event && event.data === playback.data && playback.data) completePlaybackSession(playback, true, 'owner-close-data-identity');
        };

        this.create = function () {
            if (root || destroyed) return;
            root = document.createElement('div');
            root.className = 'dlna-browser';
            root.style.cssText = 'padding:24px;box-sizing:border-box;width:100%;height:100%;';
            heading = document.createElement('div');
            heading.style.cssText = 'font-size:28px;padding:0 12px 12px;';
            status = document.createElement('div');
            status.setAttribute('role', 'status');
            status.style.cssText = 'min-height:30px;padding:0 12px;white-space:pre-wrap;';
            viewport = document.createElement('div');
            viewport.style.cssText = 'overflow:auto;height:70vh;padding:4px 12px;';
            list = document.createElement('div');
            viewport.appendChild(list);
            root.appendChild(heading);
            root.appendChild(status);
            root.appendChild(viewport);
            viewport.addEventListener('scroll', save);
            renderRows();
            if (self.activity && typeof self.activity.loader === 'function') self.activity.loader(false);
        };

        this.start = function () {
            if (destroyed || exiting) return;
            var activity = Lampa.Activity && typeof Lampa.Activity.active === 'function' ? Lampa.Activity.active() : null;
            if (Lampa.Activity && typeof Lampa.Activity.active === 'function' &&
                (!activity || activity.activity !== self.activity)) return;
            if (activeBrowser && activeBrowser !== self) activeBrowser.pause();
            activeBrowser = self;
            running = true;
            playbackDiagnosticRecord('browser-start', playback || pendingPlayback, 'component-start');
            if (pendingPlayback) {
                playback = pendingPlayback;
                pendingPlayback.restoreOwner = self;
                playbackDiagnosticRecord('restore-owner-attached', pendingPlayback, 'component-start');
            }
            self.create();
            diagnosticController = {
                toggle: function () { focus(selectedIndex(), true); },
                up: function () { focus(selectedIndex() - 1, false); },
                down: function () { focus(selectedIndex() + 1, false); },
                left: function () { if (!loading) Lampa.Controller.toggle('menu'); },
                right: function () {},
                enter: function () { self.select(selectedIndex()); },
                back: function () { self.back(); }
            };
            Lampa.Controller.add('content', diagnosticController);
            Lampa.Controller.toggle('content');
            if (!current() || controllerName() !== 'content' ||
                (typeof Lampa.Controller.windowTop === 'function' && Lampa.Controller.windowTop())) return;
            if (frame.items === null && !loading) load(frame.id, frame.title, false);
            else focus(selectedIndex(), true);
        };

        this.select = function (index) {
            if (!running || !current() || loading) return;
            if (!consumeAndroidReturnInput()) return;
            var items = resourceEntry ? resourceEntry.resources : (frame.items || []);
            if (!items.length) {
                if (frame.items === null) load(frame.id, frame.title, false);
                else self.back();
                return;
            }
            if (index < 0 || index >= items.length) return;
            remember(index);
            var entry = items[index];
            if (resourceEntry) launch(resourceEntry, entry);
            else if (entry.isFolder) load(entry.id, entry.title, true);
            else if (entry.resources && entry.resources.length > 1) {
                save();
                resourceEntry = entry;
                resourceIndex = 0;
                resourceScroll = 0;
                renderRows();
            } else launch(entry, null);
        };

        this.back = function () {
            if (!running || !current()) return;
            // Back navigates normally while playback is unconfirmed; it never releases the global launch lock.
            if (loading) { cancelLoad(); focus(selectedIndex(), true); return; }
            save();
            if (resourceEntry) { resourceEntry = null; renderRows(); return; }
            if (parents.length) { frame = parents.pop(); error = ''; renderRows(); }
            else {
                if (controllerName() !== 'content' || (typeof Lampa.Controller.windowTop === 'function' &&
                    Lampa.Controller.windowTop())) return;
                var history = typeof Lampa.Activity.all === 'function' ? Lampa.Activity.all() : [];
                var previous = history.length > 1 ? history[history.length - 2] : null;
                var departing = Lampa.Activity.active();
                exiting = true;
                self.pause();
                // backward() starts the previous Activity synchronously; destroy follows later.
                try { Lampa.Activity.backward(); }
                finally {
                    if (!destroyed && Lampa.Activity.active() === departing) {
                        exiting = false;
                        if (current()) {
                            running = true; // Keep the catalog usable without taking focus from an overlay.
                            if (controllerName() === 'content' && typeof Lampa.Controller.windowTop === 'function' &&
                                !Lampa.Controller.windowTop()) self.start();
                        }
                    }
                }
                if (!previous || Lampa.Activity.active() !== previous ||
                    controllerName() !== 'content' || typeof Lampa.Controller.windowTop !== 'function' ||
                    Lampa.Controller.windowTop() || !Lampa.Settings || typeof Lampa.Settings.create !== 'function') return;
                Lampa.Controller.toggle('settings');
                // Settings open/toggle listeners may synchronously navigate or open another window.
                if (Lampa.Activity.active() !== previous || controllerName() !== 'settings' ||
                    Lampa.Controller.windowTop()) return;
                Lampa.Settings.create(COMPONENT);
            }
        };

        this.refresh = function () {
            if (current() && !resourceEntry) load(frame.id, frame.title, false);
        };

        this.pause = function () {
            playbackDiagnosticRecord('browser-pause', playback || pendingPlayback, 'component-pause');
            save(); cancelLoad(); running = false;
            if (androidReturnState && androidReturnState.catalog === diagnosticCatalog) resetAndroidReturnCycle();
            if (playback && playback.restoreOwner === self) {
                playback.restoreOwner = null;
                playbackDiagnosticRecord('restore-owner-detached', playback, 'component-pause');
            }
            recordReturnDiagnostic('pause');
        };
        this.stop = this.pause;
        this.isCurrent = current;
        this.render = function (asDom) { self.create(); return asDom ? root : window.$(root); };
        this.destroy = function () {
            if (destroyed) return;
            playbackDiagnosticRecord('browser-destroy', playback || pendingPlayback, 'component-destroy');
            self.pause();
            destroyed = true;
            generation++;
            renderGeneration++;
            if (activeBrowser === self) {
                activeBrowser = null;
                if (playerReturnController === 'content') playerReturnController = null;
            }
            playbackDiagnosticRecord('browser-destroyed', playback || pendingPlayback, 'component-destroyed');
            if (viewport) viewport.removeEventListener('scroll', save);
            if (root) {
                window.$(root).find('.selector').off();
                if (root.parentNode) root.parentNode.removeChild(root);
            }
            rows = [];
            parents = [];
            resourceEntry = null;
            recordReturnDiagnostic('destroy');
        };
    }

    function openCatalog() {
        if (!Lampa.Component || typeof Lampa.Component.add !== 'function' || !Lampa.Activity ||
            typeof Lampa.Activity.push !== 'function' || !Lampa.Controller ||
            typeof Lampa.Controller.add !== 'function' || typeof Lampa.Controller.toggle !== 'function' ||
            typeof Lampa.Controller.collectionSet !== 'function' || typeof Lampa.Controller.collectionFocus !== 'function' ||
            typeof Lampa.Activity.backward !== 'function' || typeof window.$ !== 'function') {
            notify('Lampa Component/Activity API unavailable', 'error');
            return;
        }
        if (activeBrowser && activeBrowser.isCurrent()) { activeBrowser.start(); return; }
        if (!browserRegistered) {
            Lampa.Component.add(BROWSER_COMPONENT, DlnaBrowser);
            browserRegistered = true;
        }
        Lampa.Activity.push({ component: BROWSER_COMPONENT, title: 'DLNA', objectId: '0' });
    }

    function registerPlayerCloseListener(retryAfterConfirmedMissing) {
        retryAfterConfirmedMissing = !!retryAfterConfirmedMissing;
        var name = 'playerCloseListener';
        var state = registrationState(name);
        var listener = Lampa.Player && Lampa.Player.listener;
        var handler = guardState.playerCloseHandler;
        if (typeof handler !== 'function') {
            handler = function (event) {
                var closeData;
                var closeDataRead = false;
                try {
                    closeData = event && event.data;
                    closeDataRead = true;
                } catch (closeDataError) {}
                var closingSession = pendingPlayback;
                var hasCloseData = closeDataRead && !!closeData;
                var closeMatches = closingSession && closingSession.data ? closeData === closingSession.data : 'not-checked-no-pending';
                playbackDiagnosticRecord('player-close', closingSession, closingSession ? 'observed' : 'no-pending',
                    hasCloseData, closeMatches);
                if (pendingPlayback) {
                    if (closeDataRead && event && closeData === pendingPlayback.data && pendingPlayback.data) completePlaybackSession(pendingPlayback, true, 'close-data-identity');
                    else playbackDiagnosticRecord('completion-rejected', pendingPlayback,
                        hasCloseData ? 'close-data-mismatch' : 'close-data-missing', hasCloseData, closeMatches);
                    return;
                }
                if (abandonedPlaybackExists) {
                    playbackDiagnosticRecord('playback-event-rejected', null, 'unowned-close', hasCloseData, false);
                    return;
                }
                if (activeBrowser) { activeBrowser.playerClosed(event); return; }
                // The current owner is about to be closed, not recovered.
                invalidateBrowseRequests(true);
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


    // =========================================================================
    // UPnP Device / Service Description Parser & Renderer Registry (Step 1)
    // =========================================================================
    var rendererRegistry = {
        items: {},
        order: [],
        activeId: null,
        scpdCache: {}
    };

    function xmlDirectChildren(node, localName) {
        var result = [];
        if (!node || !node.childNodes) return result;
        for (var i = 0; i < node.childNodes.length; i++) {
            var child = node.childNodes[i];
            if (child.nodeType !== 1) continue;
            var name = child.localName || child.nodeName.split(':').pop();
            if (!localName || name === localName) result.push(child);
        }
        return result;
    }

    function xmlDirectText(node, localName) {
        var children = xmlDirectChildren(node, localName);
        return children.length ? String(children[0].textContent || '').replace(/^\s+|\s+$/g, '') : '';
    }

    function resolveUpnpUrl(baseLocation, relativeOrAbsoluteUrl) {
        var raw = String(relativeOrAbsoluteUrl || '').replace(/^\s+|\s+$/g, '');
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw)) return isValidResourceUrl(raw) ? raw : '';
        var base = String(baseLocation || '').replace(/^\s+|\s+$/g, '');
        var match = /^(https?:\/\/[^\/?#]+)([^?#]*)/i.exec(base);
        if (!match) return '';
        var origin = match[1];
        var basePath = match[2] || '/';
        var resolved;
        if (raw.charAt(0) === '/') {
            resolved = origin + raw;
        } else {
            var slash = basePath.lastIndexOf('/');
            var dir = slash >= 0 ? basePath.slice(0, slash + 1) : '/';
            resolved = origin + dir + raw;
        }
        return isValidResourceUrl(resolved) ? resolved : '';
    }

    function normalizeServiceKey(serviceType) {
        var type = String(serviceType || '');
        if (type.indexOf(':service:AVTransport:') >= 0) return 'avTransport';
        if (type.indexOf(':service:RenderingControl:') >= 0) return 'renderingControl';
        if (type.indexOf(':service:ConnectionManager:') >= 0) return 'connectionManager';
        return '';
    }

    function collectUpnpDevices(deviceNode, baseLocation, out) {
        if (!deviceNode) return;
        var deviceType = xmlDirectText(deviceNode, 'deviceType');
        var friendlyName = xmlDirectText(deviceNode, 'friendlyName');
        var udn = xmlDirectText(deviceNode, 'UDN');
        var manufacturer = xmlDirectText(deviceNode, 'manufacturer');
        var modelName = xmlDirectText(deviceNode, 'modelName');
        var modelNumber = xmlDirectText(deviceNode, 'modelNumber');

        var services = {};
        var serviceListNodes = xmlDirectChildren(deviceNode, 'serviceList');
        for (var i = 0; i < serviceListNodes.length; i++) {
            var serviceNodes = xmlDirectChildren(serviceListNodes[i], 'service');
            for (var j = 0; j < serviceNodes.length; j++) {
                var svcNode = serviceNodes[j];
                var serviceType = xmlDirectText(svcNode, 'serviceType');
                var serviceId = xmlDirectText(svcNode, 'serviceId');
                var controlURL = resolveUpnpUrl(baseLocation, xmlDirectText(svcNode, 'controlURL'));
                var scpdURL = resolveUpnpUrl(baseLocation, xmlDirectText(svcNode, 'SCPDURL'));
                var eventSubURL = resolveUpnpUrl(baseLocation, xmlDirectText(svcNode, 'eventSubURL'));
                if (!serviceType) continue;
                var svcInfo = {
                    serviceType: serviceType,
                    serviceId: serviceId,
                    controlURL: controlURL,
                    scpdURL: scpdURL,
                    eventSubURL: eventSubURL
                };
                services[serviceType] = svcInfo;
                var shortKey = normalizeServiceKey(serviceType);
                if (shortKey && !services[shortKey]) services[shortKey] = svcInfo;
            }
        }

        out.push({
            deviceType: deviceType,
            friendlyName: friendlyName,
            udn: udn,
            manufacturer: manufacturer,
            modelName: modelName,
            modelNumber: modelNumber,
            services: services
        });

        var deviceListNodes = xmlDirectChildren(deviceNode, 'deviceList');
        for (var k = 0; k < deviceListNodes.length; k++) {
            var childDevices = xmlDirectChildren(deviceListNodes[k], 'device');
            for (var m = 0; m < childDevices.length; m++) {
                collectUpnpDevices(childDevices[m], baseLocation, out);
            }
        }
    }

    function parseUpnpDeviceDescription(rawXml, descriptionUrl) {
        var doc = parseXml(rawXml);
        var rootNode = doc.documentElement;
        if (!rootNode) throw new Error('Пустой XML описания UPnP-устройства');
        var urlBase = xmlDirectText(rootNode, 'URLBase');
        var effectiveBase = (urlBase && isValidResourceUrl(urlBase)) ? urlBase : descriptionUrl;
        var devices = [];
        var topDevices = xmlDirectChildren(rootNode, 'device');
        for (var i = 0; i < topDevices.length; i++) {
            collectUpnpDevices(topDevices[i], effectiveBase, devices);
        }
        if (!devices.length) throw new Error('В описании UPnP не найдены элементы <device>');

        var rendererDevice = null;
        for (var j = 0; j < devices.length; j++) {
            if (devices[j].deviceType.indexOf(':device:MediaRenderer:') >= 0) {
                rendererDevice = devices[j];
                break;
            }
        }
        if (!rendererDevice) {
            for (var k = 0; k < devices.length; k++) {
                if (devices[k].services.avTransport && devices[k].services.avTransport.controlURL) {
                    rendererDevice = devices[k];
                    break;
                }
            }
        }
        if (!rendererDevice) throw new Error('Устройство не является MediaRenderer (отсутствует сервис AVTransport)');
        var avTransport = rendererDevice.services.avTransport;
        if (!avTransport || !avTransport.controlURL) {
            throw new Error('У MediaRenderer отсутствует корректный controlURL для AVTransport');
        }

        var id = rendererDevice.udn || descriptionUrl;
        return {
            id: id,
            udn: rendererDevice.udn || '',
            descriptionUrl: descriptionUrl,
            baseUrl: effectiveBase,
            deviceType: rendererDevice.deviceType,
            friendlyName: rendererDevice.friendlyName || rendererDevice.modelName || descriptionUrl,
            manufacturer: rendererDevice.manufacturer,
            modelName: rendererDevice.modelName,
            modelNumber: rendererDevice.modelNumber,
            services: rendererDevice.services,
            endpoints: {
                avTransport: avTransport.controlURL,
                renderingControl: rendererDevice.services.renderingControl ? rendererDevice.services.renderingControl.controlURL : '',
                connectionManager: rendererDevice.services.connectionManager ? rendererDevice.services.connectionManager.controlURL : ''
            },
            scpd: {},
            updatedAt: (new Date()).getTime()
        };
    }

    function parseUpnpScpd(rawXml) {
        var doc = parseXml(rawXml);
        var rootNode = doc.documentElement;
        if (!rootNode) throw new Error('Пустой XML SCPD');
        var actions = {};
        var actionListNodes = xmlDirectChildren(rootNode, 'actionList');
        for (var i = 0; i < actionListNodes.length; i++) {
            var actionNodes = xmlDirectChildren(actionListNodes[i], 'action');
            for (var j = 0; j < actionNodes.length; j++) {
                var actionNode = actionNodes[j];
                var actionName = xmlDirectText(actionNode, 'name');
                if (!actionName) continue;
                var inArgs = [];
                var outArgs = [];
                var argListNodes = xmlDirectChildren(actionNode, 'argumentList');
                for (var a = 0; a < argListNodes.length; a++) {
                    var argNodes = xmlDirectChildren(argListNodes[a], 'argument');
                    for (var b = 0; b < argNodes.length; b++) {
                        var argName = xmlDirectText(argNodes[b], 'name');
                        var direction = xmlDirectText(argNodes[b], 'direction').toLowerCase();
                        var relatedStateVariable = xmlDirectText(argNodes[b], 'relatedStateVariable');
                        if (!argName) continue;
                        var argInfo = { name: argName, relatedStateVariable: relatedStateVariable };
                        if (direction === 'out') outArgs.push(argInfo);
                        else inArgs.push(argInfo);
                    }
                }
                actions[actionName] = { name: actionName, inArgs: inArgs, outArgs: outArgs };
            }
        }

        var stateVariables = {};
        var sstNodes = xmlDirectChildren(rootNode, 'serviceStateTable');
        for (var s = 0; s < sstNodes.length; s++) {
            var varNodes = xmlDirectChildren(sstNodes[s], 'stateVariable');
            for (var v = 0; v < varNodes.length; v++) {
                var varName = xmlDirectText(varNodes[v], 'name');
                if (!varName) continue;
                var allowed = [];
                var allowedListNodes = xmlDirectChildren(varNodes[v], 'allowedValueList');
                for (var al = 0; al < allowedListNodes.length; al++) {
                    var allowedValueNodes = xmlDirectChildren(allowedListNodes[al], 'allowedValue');
                    for (var av = 0; av < allowedValueNodes.length; av++) {
                        var val = String(allowedValueNodes[av].textContent || '').replace(/^\s+|\s+$/g, '');
                        if (val) allowed.push(val);
                    }
                }
                stateVariables[varName] = {
                    name: varName,
                    dataType: xmlDirectText(varNodes[v], 'dataType'),
                    allowedValues: allowed
                };
            }
        }

        return { actions: actions, stateVariables: stateVariables };
    }

    function upsertRenderer(descriptor, makeActive) {
        if (!descriptor || !descriptor.id) return null;
        var existing = rendererRegistry.items[descriptor.id];
        if (existing) {
            for (var key in descriptor) {
                if (Object.prototype.hasOwnProperty.call(descriptor, key) && key !== 'scpd') {
                    existing[key] = descriptor[key];
                }
            }
            if (descriptor.scpd) {
                for (var svcKey in descriptor.scpd) {
                    if (Object.prototype.hasOwnProperty.call(descriptor.scpd, svcKey)) {
                        existing.scpd[svcKey] = descriptor.scpd[svcKey];
                    }
                }
            }
        } else {
            rendererRegistry.items[descriptor.id] = descriptor;
            rendererRegistry.order.push(descriptor.id);
        }
        if (makeActive || !rendererRegistry.activeId) {
            rendererRegistry.activeId = descriptor.id;
        }
        return rendererRegistry.items[descriptor.id];
    }

    function getActiveRenderer() {
        return rendererRegistry.activeId ? (rendererRegistry.items[rendererRegistry.activeId] || null) : null;
    }

    function fetchRendererDescription(descriptionUrl, callback, options) {
        options = options || {};
        var cleanUrl = String(descriptionUrl || '').replace(/^\s+|\s+$/g, '');
        if (!isValidResourceUrl(cleanUrl)) {
            if (callback) callback(new Error('Некорректный URL описания UPnP-рендерера'));
            return;
        }
        requestNative(cleanUrl, null, {}, function (rawXml) {
            var descriptor;
            try {
                descriptor = parseUpnpDeviceDescription(rawXml, cleanUrl);
            } catch (parseErr) {
                if (callback) callback(new Error('Ошибка разбора описания UPnP-рендерера: ' + errorText(parseErr)));
                return;
            }
            var saved = upsertRenderer(descriptor, options.makeActive !== false);
            if (callback) callback(null, saved);
        }, function (netErr) {
            if (callback) callback(new Error('Ошибка загрузки описания UPnP-рендерера: ' + errorText(netErr)));
        });
    }

    function fetchRendererScpd(renderer, serviceKey, callback) {
        if (!renderer || !renderer.services || !renderer.services[serviceKey]) {
            if (callback) callback(new Error('Сервис ' + serviceKey + ' не найден у рендерера'));
            return;
        }
        var svc = renderer.services[serviceKey];
        if (!svc.scpdURL) {
            if (callback) callback(new Error('У сервиса ' + serviceKey + ' отсутствует SCPDURL'));
            return;
        }
        if (renderer.scpd && renderer.scpd[serviceKey]) {
            if (callback) callback(null, renderer.scpd[serviceKey]);
            return;
        }
        if (rendererRegistry.scpdCache[svc.scpdURL]) {
            renderer.scpd[serviceKey] = rendererRegistry.scpdCache[svc.scpdURL];
            if (callback) callback(null, renderer.scpd[serviceKey]);
            return;
        }
        requestNative(svc.scpdURL, null, {}, function (rawXml) {
            var parsed;
            try {
                parsed = parseUpnpScpd(rawXml);
            } catch (parseErr) {
                if (callback) callback(new Error('Ошибка разбора SCPD (' + serviceKey + '): ' + errorText(parseErr)));
                return;
            }
            rendererRegistry.scpdCache[svc.scpdURL] = parsed;
            renderer.scpd[serviceKey] = parsed;
            if (callback) callback(null, parsed);
        }, function (netErr) {
            if (callback) callback(new Error('Ошибка загрузки SCPD (' + serviceKey + '): ' + errorText(netErr)));
        });
    }

    function inspectConfiguredRenderer() {
        var url = String(setting('renderer_url', '')).replace(/^\s+|\s+$/g, '');
        if (!url) {
            notify('Укажите URL описания UPnP Renderer (например, http://192.168.1.50:1400/xml/device_description.xml)', 'error');
            return;
        }
        notify('Загрузка описания UPnP Renderer…');
        fetchRendererDescription(url, function (err, renderer) {
            if (err) {
                notify(errorText(err), 'error');
                return;
            }
            try {
                if (Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                    Lampa.Storage.set(PREFIX + 'active_renderer_id', renderer.id);
                }
            } catch (storageErr) {}
            var lines = [
                'Renderer: ' + renderer.friendlyName,
                renderer.manufacturer || renderer.modelName ? ('Модель: ' + [renderer.manufacturer, renderer.modelName, renderer.modelNumber].filter(Boolean).join(' ')) : '',
                'AVTransport: ' + renderer.endpoints.avTransport,
                renderer.endpoints.renderingControl ? ('RenderingControl: ' + renderer.endpoints.renderingControl) : 'RenderingControl: нет'
            ].filter(Boolean);
            notify(lines.join('\n'), 'success');
        }, { makeActive: true });
    }


    // =========================================================================
    // UPnP Renderer Verification & AVTransport SOAP Client (Step 2)
    // =========================================================================
    var rendererSession = null;

    function parseUpnpSoapFault(rawXml) {
        try {
            var doc = parseXml(rawXml);
            var faults = doc.getElementsByTagName('Fault');
            var hasFault = faults && faults.length > 0;
            if (!hasFault) {
                var all = doc.getElementsByTagName('*');
                for (var i = 0; i < all.length; i++) {
                    if (all[i].localName === 'Fault') {
                        hasFault = true;
                        break;
                    }
                }
            }
            if (!hasFault) return null;
            var faultString = textOf(doc.documentElement, 'faultstring') || 'SOAP Fault';
            var errorCode = textOf(doc.documentElement, 'errorCode');
            var errorDescription = textOf(doc.documentElement, 'errorDescription');
            if (errorCode || errorDescription) {
                return 'UPnP Error ' + (errorCode || '?') + (errorDescription ? ': ' + errorDescription : ' (' + faultString + ')');
            }
            return faultString;
        } catch (e) {
            return null;
        }
    }

    function soapServiceAction(controlUrl, serviceType, actionName, args, success, failure) {
        if (!isValidResourceUrl(controlUrl)) {
            if (failure) failure(new Error('Некорректный controlURL UPnP сервиса'));
            return;
        }
        var argXml = '';
        if (args && args.length) {
            for (var i = 0; i < args.length; i++) {
                var pair = args[i];
                if (!pair || !pair[0]) continue;
                argXml += '<' + pair[0] + '>' + xmlEscape(pair[1] === undefined || pair[1] === null ? '' : pair[1]) + '</' + pair[0] + '>';
            }
        }
        var body = '<?xml version="1.0" encoding="utf-8"?>' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:' + actionName + ' xmlns:u="' + xmlEscape(serviceType) + '">' +
            argXml +
            '</u:' + actionName + '></s:Body></s:Envelope>';

        requestNative(controlUrl, body, {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': '"' + serviceType + '#' + actionName + '"'
        }, function (raw) {
            var doc;
            try {
                doc = parseXml(raw);
            } catch (parseErr) {
                if (failure) failure(new Error('Разбор SOAP ответа (' + actionName + '): ' + errorText(parseErr)));
                return;
            }
            var faultMsg = parseUpnpSoapFault(raw);
            if (faultMsg) {
                if (failure) failure(new Error(actionName + ': ' + faultMsg));
                return;
            }
            if (success) success(doc, raw);
        }, function (netErr) {
            var rawBody = netErr && netErr.responseText ? netErr.responseText : '';
            var faultMsg = rawBody ? parseUpnpSoapFault(rawBody) : null;
            if (failure) {
                failure(new Error(actionName + ': ' + (faultMsg || errorText(netErr))));
            }
        });
    }

    function avTransportCall(renderer, actionName, args, success, failure) {
        if (!renderer || !renderer.services || !renderer.services.avTransport || !renderer.services.avTransport.controlURL) {
            if (failure) failure(new Error('Активный UPnP Renderer не выбран или не поддерживает AVTransport'));
            return;
        }
        var svc = renderer.services.avTransport;
        soapServiceAction(svc.controlURL, svc.serviceType, actionName, args, success, failure);
    }

    function renderingControlCall(renderer, actionName, args, success, failure) {
        if (!renderer || !renderer.services || !renderer.services.renderingControl || !renderer.services.renderingControl.controlURL) {
            if (failure) failure(new Error('UPnP Renderer не поддерживает RenderingControl'));
            return;
        }
        var svc = renderer.services.renderingControl;
        soapServiceAction(svc.controlURL, svc.serviceType, actionName, args, success, failure);
    }

    function connectionManagerCall(renderer, actionName, args, success, failure) {
        if (!renderer || !renderer.services || !renderer.services.connectionManager || !renderer.services.connectionManager.controlURL) {
            if (failure) failure(new Error('UPnP Renderer не поддерживает ConnectionManager'));
            return;
        }
        var svc = renderer.services.connectionManager;
        soapServiceAction(svc.controlURL, svc.serviceType, actionName, args, success, failure);
    }

    function avGetTransportInfo(renderer, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'GetTransportInfo', [['InstanceID', inst]], function (doc) {
            var root = doc.documentElement;
            var info = {
                state: textOf(root, 'CurrentTransportState') || 'UNKNOWN',
                status: textOf(root, 'CurrentTransportStatus') || 'UNKNOWN',
                speed: textOf(root, 'CurrentSpeed') || '1'
            };
            if (renderer) renderer.lastTransportInfo = info;
            if (callback) callback(null, info);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function avGetPositionInfo(renderer, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'GetPositionInfo', [['InstanceID', inst]], function (doc) {
            var root = doc.documentElement;
            var pos = {
                track: textOf(root, 'Track') || '0',
                duration: textOf(root, 'TrackDuration') || '00:00:00',
                metaData: textOf(root, 'TrackMetaData') || '',
                uri: textOf(root, 'TrackURI') || '',
                relTime: textOf(root, 'RelTime') || '00:00:00',
                absTime: textOf(root, 'AbsTime') || '00:00:00'
            };
            if (renderer) renderer.lastPositionInfo = pos;
            if (callback) callback(null, pos);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function buildDidlMetadata(entry, resource) {
        var res = resource || (entry && entry.resources && entry.resources.length ? entry.resources[0] : null);
        var url = playbackUrl(entry, res);
        var title = (entry && entry.title) || 'DLNA Media';
        var mime = (res && res.mime) || (entry && entry.mime) || 'video/*';
        var protocolInfo = (res && res.protocolInfo) || (entry && entry.protocolInfo) || ('http-get:*:' + mime + ':*');
        var upnpClass = 'object.item.videoItem';
        if (String(mime).toLowerCase().indexOf('audio/') === 0) upnpClass = 'object.item.audioItem.musicTrack';
        else if (String(mime).toLowerCase().indexOf('image/') === 0) upnpClass = 'object.item.imageItem';

        var attrs = ' protocolInfo="' + xmlEscape(protocolInfo) + '"';
        if (res && res.duration) attrs += ' duration="' + xmlEscape(res.duration) + '"';
        if (res && res.size > 0) attrs += ' size="' + xmlEscape(res.size) + '"';
        if (res && res.resolution) attrs += ' resolution="' + xmlEscape(res.resolution) + '"';
        if (res && res.bitrate > 0) attrs += ' bitrate="' + xmlEscape(res.bitrate) + '"';

        return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
            'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
            '<item id="' + xmlEscape((entry && entry.id) || '0') + '" parentID="' + xmlEscape((entry && entry.parentID) || '-1') + '" restricted="1">' +
            '<dc:title>' + xmlEscape(title) + '</dc:title>' +
            '<upnp:class>' + upnpClass + '</upnp:class>' +
            '<res' + attrs + '>' + xmlEscape(url) + '</res>' +
            '</item></DIDL-Lite>';
    }

    function avSetAVTransportURI(renderer, uri, metaData, callback, instanceId) {
        if (!isValidResourceUrl(uri)) {
            if (callback) callback(new Error('Некорректный URI для передачи на Renderer'));
            return;
        }
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'SetAVTransportURI', [
            ['InstanceID', inst],
            ['CurrentURI', uri],
            ['CurrentURIMetaData', metaData || '']
        ], function () {
            if (callback) callback(null);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function avPlay(renderer, callback, speed, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'Play', [
            ['InstanceID', inst],
            ['Speed', speed === undefined ? '1' : String(speed)]
        ], function () {
            if (callback) callback(null);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function avPause(renderer, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'Pause', [['InstanceID', inst]], function () {
            if (callback) callback(null);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function avStop(renderer, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'Stop', [['InstanceID', inst]], function () {
            if (callback) callback(null);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function avSeek(renderer, target, unit, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'Seek', [
            ['InstanceID', inst],
            ['Unit', unit || 'REL_TIME'],
            ['Target', String(target || '00:00:00')]
        ], function () {
            if (callback) callback(null);
        }, function (err) {
            if (callback) callback(err);
        });
    }

    function verifyUpnpRenderer(renderer, callback) {
        if (!renderer) {
            if (callback) callback(new Error('Renderer не передан для проверки'));
            return;
        }
        var report = {
            renderer: renderer,
            transportInfo: null,
            scpdLoaded: false,
            actions: [],
            protocolSink: []
        };

        avGetTransportInfo(renderer, function (infoErr, info) {
            if (infoErr) {
                if (callback) callback(new Error('Проверка AVTransport не удалась: ' + errorText(infoErr)));
                return;
            }
            report.transportInfo = info;
            renderer.verified = true;
            renderer.verifiedAt = (new Date()).getTime();

            function checkConnectionManager(done) {
                if (!renderer.endpoints.connectionManager) {
                    done();
                    return;
                }
                connectionManagerCall(renderer, 'GetProtocolInfo', [], function (doc) {
                    var sink = textOf(doc.documentElement, 'Sink');
                    if (sink) {
                        report.protocolSink = sink.split(',').map(function (s) {
                            return s.replace(/^\s+|\s+$/g, '');
                        }).filter(Boolean);
                        renderer.protocolSink = report.protocolSink;
                    }
                    done();
                }, function () {
                    done();
                });
            }

            fetchRendererScpd(renderer, 'avTransport', function (scpdErr, scpd) {
                if (!scpdErr && scpd && scpd.actions) {
                    report.scpdLoaded = true;
                    for (var act in scpd.actions) {
                        if (Object.prototype.hasOwnProperty.call(scpd.actions, act)) {
                            report.actions.push(act);
                        }
                    }
                }
                checkConnectionManager(function () {
                    if (callback) callback(null, report);
                });
            });
        });
    }

    function verifyConfiguredRenderer() {
        var url = String(setting('renderer_url', '')).replace(/^\s+|\s+$/g, '');
        if (!url) {
            notify('Укажите URL описания UPnP Renderer в настройках', 'error');
            return;
        }
        notify('Проверка UPnP Renderer и AVTransport…');
        fetchRendererDescription(url, function (descErr, renderer) {
            if (descErr) {
                notify(errorText(descErr), 'error');
                return;
            }
            verifyUpnpRenderer(renderer, function (verifyErr, report) {
                if (verifyErr) {
                    notify(errorText(verifyErr), 'error');
                    return;
                }
                var lines = [
                    'Renderer готов: ' + renderer.friendlyName,
                    'Состояние AVTransport: ' + report.transportInfo.state + ' (' + report.transportInfo.status + ')',
                    report.scpdLoaded ? ('Действия AVTransport (' + report.actions.length + '): ' + report.actions.slice(0, 10).join(', ') + (report.actions.length > 10 ? '…' : '')) : 'SCPD AVTransport: недоступен',
                    report.protocolSink.length ? ('Поддерживаемых профилей Sink: ' + report.protocolSink.length) : ''
                ].filter(Boolean);
                notify(lines.join('\n'), 'success');
            });
        }, { makeActive: true });
    }


    // =========================================================================
    // SSDP Discovery via UDP / Native Bridge API (Step 3)
    // =========================================================================
    var SSDP_MULTICAST_ADDR = '239.255.255.250';
    var SSDP_MULTICAST_PORT = 1900;
    var ssdpState = {
        running: false,
        lastRunAt: 0,
        lastError: '',
        foundDevices: [],
        foundRenderers: [],
        foundServers: []
    };

    function detectSsdpNativeTransport() {
        var w = window;
        // Explicit, documented contracts only (no heuristic method guessing).
        if (w.AndroidJS && typeof w.AndroidJS.ssdpDiscover === 'function') {
            return {
                available: true,
                kind: 'bridge-method',
                bridgeName: 'AndroidJS',
                methodName: 'ssdpDiscover',
                target: w.AndroidJS,
                fn: w.AndroidJS.ssdpDiscover
            };
        }
        if (w.chrome && w.chrome.sockets && w.chrome.sockets.udp &&
            typeof w.chrome.sockets.udp.create === 'function' &&
            typeof w.chrome.sockets.udp.bind === 'function' &&
            typeof w.chrome.sockets.udp.send === 'function') {
            return {
                available: true,
                kind: 'chrome-udp',
                bridgeName: 'chrome.sockets.udp',
                target: w.chrome.sockets.udp
            };
        }
        if (w.nw && typeof w.nw.require === 'function') {
            try {
                var nwDgram = w.nw.require('dgram');
                if (nwDgram && typeof nwDgram.createSocket === 'function') {
                    return {
                        available: true,
                        kind: 'nw-dgram',
                        bridgeName: 'nw.dgram',
                        target: nwDgram
                    };
                }
            } catch (e) {}
        }
        if (typeof w.dgram === 'object' && w.dgram && typeof w.dgram.createSocket === 'function') {
            return {
                available: true,
                kind: 'node-dgram',
                bridgeName: 'dgram',
                target: w.dgram
            };
        }

        return {
            available: false,
            reason: 'Подтверждённый UDP/SSDP транспорт отсутствует (требуется AndroidJS.ssdpDiscover, chrome.sockets.udp или dgram). Используйте прямой URL описания Renderer.'
        };
    }

    function buildSsdpMSearchPacket(searchTarget, mx) {
        var st = searchTarget || 'ssdp:all';
        var wait = Math.max(1, Math.min(5, parseInt(mx || 2, 10) || 2));
        return [
            'M-SEARCH * HTTP/1.1',
            'HOST: ' + SSDP_MULTICAST_ADDR + ':' + SSDP_MULTICAST_PORT,
            'MAN: "ssdp:discover"',
            'MX: ' + wait,
            'ST: ' + st,
            '',
            ''
        ].join('\r\n');
    }

    function parseSsdpResponse(rawPacket) {
        if (!rawPacket) return null;
        var text = typeof rawPacket === 'string' ? rawPacket : '';
        if (!text && typeof rawPacket === 'object') {
            text = rawPacket.data || rawPacket.message || rawPacket.payload || rawPacket.response || '';
        }
        if (typeof text !== 'string' || !text.trim()) return null;
        var lines = text.split(/\r?\n/);
        var headers = {};
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i];
            var idx = line.indexOf(':');
            if (idx <= 0) continue;
            var key = line.slice(0, idx).replace(/^\s+|\s+$/g, '').toUpperCase();
            var val = line.slice(idx + 1).replace(/^\s+|\s+$/g, '');
            headers[key] = val;
        }
        var location = headers['LOCATION'] || '';
        var st = headers['ST'] || headers['NT'] || '';
        var usn = headers['USN'] || '';
        var server = headers['SERVER'] || '';
        if (!location && !st && !usn) return null;
        return {
            location: location,
            st: st,
            usn: usn,
            server: server,
            raw: text
        };
    }

    function parseSsdpResponsesList(payload) {
        var list = [];
        if (!payload) return list;
        if (typeof payload === 'string') {
            var trimmed = payload.replace(/^\s+|\s+$/g, '');
            if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
                try {
                    return parseSsdpResponsesList(JSON.parse(trimmed));
                } catch (e) {}
            }
            var chunks = trimmed.split(/(?=HTTP\/1\.[01]\s+\d+|NOTIFY\s+\*\s+HTTP\/1\.[01])/i);
            for (var i = 0; i < chunks.length; i++) {
                var parsed = parseSsdpResponse(chunks[i]);
                if (parsed) list.push(parsed);
            }
            return list;
        }
        if (Object.prototype.toString.call(payload) === '[object Array]') {
            for (var j = 0; j < payload.length; j++) {
                var item = parseSsdpResponse(payload[j]);
                if (item) list.push(item);
            }
            return list;
        }
        if (typeof payload === 'object') {
            if (payload.devices) return parseSsdpResponsesList(payload.devices);
            if (payload.responses) return parseSsdpResponsesList(payload.responses);
            var single = parseSsdpResponse(payload);
            if (single) list.push(single);
        }
        return list;
    }

    function invokeSsdpNativeSearch(transport, searchTarget, timeoutMs, callback) {
        var packet = buildSsdpMSearchPacket(searchTarget, Math.max(1, Math.round((timeoutMs || 2500) / 1000)));
        var settled = false;

        function finish(err, rawResponses) {
            if (settled) return;
            settled = true;
            if (err) callback(err);
            else callback(null, parseSsdpResponsesList(rawResponses));
        }

        try {
            if (transport.kind === 'bridge-method') {
                var fn = transport.fn;
                var target = transport.target;
                var requestPayload = {
                    host: SSDP_MULTICAST_ADDR,
                    port: SSDP_MULTICAST_PORT,
                    st: searchTarget,
                    timeout: timeoutMs,
                    packet: packet
                };
                var callbackDelivered = false;
                var onNativeSuccess = function (res) {
                    callbackDelivered = true;
                    finish(null, res);
                };
                var onNativeError = function (err) {
                    callbackDelivered = true;
                    finish(new Error(errorText(err || 'Ошибка нативного SSDP-поиска')));
                };
                // Explicit contract: try structured options + callbacks first; support synchronous/Promise return without relying on fn.length
                var callResult;
                try {
                    callResult = fn.call(target, requestPayload, onNativeSuccess, onNativeError);
                } catch (firstErr) {
                    callResult = fn.call(target, searchTarget, onNativeSuccess, onNativeError);
                }
                if (callResult && typeof callResult.then === 'function') {
                    callResult.then(function (res) {
                        if (!callbackDelivered) finish(null, res);
                    }, function (err) {
                        if (!callbackDelivered) finish(new Error(errorText(err || 'Ошибка нативного SSDP-поиска')));
                    });
                } else if (callResult !== undefined && callResult !== null && !callbackDelivered) {
                    finish(null, callResult);
                } else {
                    setTimeout(function () {
                        if (!settled && !callbackDelivered) {
                            finish(new Error('Таймаут ответа AndroidJS.ssdpDiscover (контракт не вернул результат)'));
                        }
                    }, Math.max(1000, (timeoutMs || 2500) + 500));
                }
                return;
            }

            if (transport.kind === 'chrome-udp') {
                var sock = transport.target;
                var collected = [];
                sock.create({}, function (createInfo) {
                    if (!createInfo || !createInfo.socketId) {
                        finish(new Error('Не удалось создать UDP сокет (chrome.sockets.udp)'));
                        return;
                    }
                    var socketId = createInfo.socketId;
                    var onReceive = function (info) {
                        if (info && info.socketId === socketId && info.data) {
                            try {
                                var bytes = new Uint8Array(info.data);
                                var str = '';
                                for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
                                collected.push(str);
                            } catch (e) {}
                        }
                    };
                    if (sock.onReceive && typeof sock.onReceive.addListener === 'function') {
                        sock.onReceive.addListener(onReceive);
                    }
                    sock.bind(socketId, '0.0.0.0', 0, function () {
                        var buf = new ArrayBuffer(packet.length);
                        var view = new Uint8Array(buf);
                        for (var i = 0; i < packet.length; i++) view[i] = packet.charCodeAt(i) & 0xff;
                        sock.send(socketId, buf, SSDP_MULTICAST_ADDR, SSDP_MULTICAST_PORT, function () {});
                        setTimeout(function () {
                            try {
                                if (sock.onReceive && typeof sock.onReceive.removeListener === 'function') {
                                    sock.onReceive.removeListener(onReceive);
                                }
                                sock.close(socketId, function () {});
                            } catch (e) {}
                            finish(null, collected);
                        }, timeoutMs || 2500);
                    });
                });
                return;
            }

            if (transport.kind === 'node-dgram' || transport.kind === 'nw-dgram') {
                var dgram = transport.target;
                var socket = dgram.createSocket('udp4');
                var packets = [];
                socket.on('message', function (msg) {
                    packets.push(msg ? msg.toString('utf8') : '');
                });
                socket.on('error', function (err) {
                    try { socket.close(); } catch (e) {}
                    finish(new Error('Ошибка UDP сокета: ' + errorText(err)));
                });
                socket.bind(0, function () {
                    try {
                        socket.addMembership(SSDP_MULTICAST_ADDR);
                        var sendBuf = Buffer.from ? Buffer.from(packet, 'utf8') : new Buffer(packet, 'utf8');
                        socket.send(sendBuf, 0, sendBuf.length, SSDP_MULTICAST_PORT, SSDP_MULTICAST_ADDR);
                    } catch (sendErr) {}
                    setTimeout(function () {
                        try { socket.close(); } catch (e) {}
                        finish(null, packets);
                    }, timeoutMs || 2500);
                });
                return;
            }

            finish(new Error('Неподдерживаемый нативный UDP-транспорт'));
        } catch (err) {
            finish(new Error('Сбой запуска SSDP-поиска: ' + errorText(err)));
        }
    }

    function discoverSsdpDevices(options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        options = options || {};
        var transport = detectSsdpNativeTransport();
        if (!transport.available) {
            ssdpState.lastError = transport.reason;
            if (callback) callback(new Error(transport.reason));
            return;
        }
        if (ssdpState.running) {
            if (callback) callback(new Error('SSDP-поиск уже выполняется'));
            return;
        }

        ssdpState.running = true;
        ssdpState.lastError = '';
        ssdpState.lastRunAt = (new Date()).getTime();
        var targets = options.targets || [
            'urn:schemas-upnp-org:device:MediaRenderer:1',
            'urn:schemas-upnp-org:device:MediaServer:1'
        ];
        var timeoutMs = options.timeoutMs || 2500;
        var allPackets = [];
        var idx = 0;

        function nextTarget() {
            if (idx >= targets.length) {
                finalizePackets();
                return;
            }
            var st = targets[idx++];
            invokeSsdpNativeSearch(transport, st, timeoutMs, function (err, list) {
                if (!err && list && list.length) {
                    allPackets = allPackets.concat(list);
                }
                nextTarget();
            });
        }

        function finalizePackets() {
            var byLocation = {};
            for (var i = 0; i < allPackets.length; i++) {
                var pkt = allPackets[i];
                if (pkt && pkt.location && isValidResourceUrl(pkt.location)) {
                    if (!byLocation[pkt.location]) byLocation[pkt.location] = pkt;
                }
            }
            var locations = Object.keys ? Object.keys(byLocation) : [];
            if (!locations.length) {
                for (var k in byLocation) {
                    if (Object.prototype.hasOwnProperty.call(byLocation, k)) locations.push(k);
                }
            }

            var renderers = [];
            var servers = [];
            var devices = [];
            var pending = locations.length;

            if (!pending) {
                ssdpState.running = false;
                ssdpState.foundDevices = [];
                ssdpState.foundRenderers = [];
                ssdpState.foundServers = [];
                if (callback) callback(null, { devices: [], renderers: [], servers: [] });
                return;
            }

            for (var j = 0; j < locations.length; j++) {
                (function (loc) {
                    var pktInfo = byLocation[loc];
                    requestNative(loc, null, {}, function (rawXml) {
                        try {
                            var doc = parseXml(rawXml);
                            var rootNode = doc.documentElement;
                            var urlBase = xmlDirectText(rootNode, 'URLBase');
                            var effectiveBase = (urlBase && isValidResourceUrl(urlBase)) ? urlBase : loc;
                            var parsedDevices = [];
                            var topDevices = xmlDirectChildren(rootNode, 'device');
                            for (var d = 0; d < topDevices.length; d++) {
                                collectUpnpDevices(topDevices[d], effectiveBase, parsedDevices);
                            }
                            for (var p = 0; p < parsedDevices.length; p++) {
                                var dev = parsedDevices[p];
                                var entry = {
                                    location: loc,
                                    st: pktInfo.st,
                                    usn: pktInfo.usn,
                                    server: pktInfo.server,
                                    deviceType: dev.deviceType,
                                    friendlyName: dev.friendlyName || dev.modelName || loc,
                                    udn: dev.udn,
                                    manufacturer: dev.manufacturer,
                                    modelName: dev.modelName,
                                    services: dev.services
                                };
                                devices.push(entry);
                                if (dev.deviceType.indexOf(':device:MediaRenderer:') >= 0 || (dev.services && dev.services.avTransport && dev.services.avTransport.controlURL)) {
                                    renderers.push(entry);
                                    try {
                                        var rDesc = parseUpnpDeviceDescription(rawXml, loc);
                                        upsertRenderer(rDesc, !getActiveRenderer());
                                    } catch (rErr) {}
                                }
                                if (dev.deviceType.indexOf(':device:MediaServer:') >= 0 || (dev.services && dev.services['urn:schemas-upnp-org:service:ContentDirectory:1'])) {
                                    servers.push(entry);
                                }
                            }
                        } catch (xmlErr) {}
                        doneOne();
                    }, function () {
                        doneOne();
                    });
                })(locations[j]);
            }

            function doneOne() {
                pending--;
                if (pending > 0) return;
                ssdpState.running = false;
                ssdpState.foundDevices = devices;
                ssdpState.foundRenderers = renderers;
                ssdpState.foundServers = servers;
                if (callback) callback(null, { devices: devices, renderers: renderers, servers: servers });
            }
        }

        nextTarget();
    }

    function runSsdpDiscoveryUi() {
        var transport = detectSsdpNativeTransport();
        if (!transport.available) {
            notify('SSDP недоступен: ' + transport.reason, 'error');
            return;
        }
        notify('SSDP-поиск UPnP-устройств в сети…');
        discoverSsdpDevices({}, function (err, res) {
            if (err) {
                notify(errorText(err), 'error');
                return;
            }
            var lines = [
                'SSDP завершён: найдено устройств ' + res.devices.length,
                'MediaRenderer: ' + res.renderers.length + (res.renderers.length ? ' (' + res.renderers.map(function (r) { return r.friendlyName; }).slice(0, 4).join(', ') + ')' : ''),
                'MediaServer: ' + res.servers.length + (res.servers.length ? ' (' + res.servers.map(function (s) { return s.friendlyName; }).slice(0, 4).join(', ') + ')' : '')
            ];
            notify(lines.join('\n'), 'success');
        });
    }


    // =========================================================================
    // Active UPnP Renderer Selection & Switching (Step 4)
    // =========================================================================
    function persistActiveRendererId(rendererId) {
        try {
            if (Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                Lampa.Storage.set(PREFIX + 'active_renderer_id', rendererId || '');
            }
        } catch (e) {}
    }

    function readPersistedRendererId() {
        try {
            return String(setting('active_renderer_id', '') || '');
        } catch (e) {
            return '';
        }
    }

    function listRegisteredRenderers() {
        var out = [];
        var seen = {};
        for (var i = 0; i < rendererRegistry.order.length; i++) {
            var id = rendererRegistry.order[i];
            if (seen[id]) continue;
            seen[id] = true;
            var r = rendererRegistry.items[id];
            if (r) out.push(r);
        }
        return out;
    }

    function selectRendererById(rendererId, options) {
        options = options || {};
        if (!rendererId || !rendererRegistry.items[rendererId]) {
            if (options.callback) options.callback(new Error('Renderer не найден в реестре'));
            return null;
        }
        var prevActive = getActiveRenderer();
        var nextRenderer = rendererRegistry.items[rendererId];
        rendererRegistry.activeId = rendererId;
        persistActiveRendererId(rendererId);

        if (options.syncUrl !== false && nextRenderer.descriptionUrl) {
            try {
                if (Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                    Lampa.Storage.set(PREFIX + 'renderer_url', nextRenderer.descriptionUrl);
                }
            } catch (e) {}
        }

        if (!prevActive || prevActive.id !== nextRenderer.id) {
            resetRendererPlaybackSession('renderer-switched');
        }

        function finishSwitch(verifyErr, verifyReport) {
            if (options.notify !== false) {
                if (verifyErr) {
                    notify('Выбран Renderer ' + nextRenderer.friendlyName + ', но проверка AVTransport вернула ошибку: ' + errorText(verifyErr), 'error');
                } else {
                    var msg = 'Активный Renderer: ' + nextRenderer.friendlyName;
                    if (verifyReport && verifyReport.transportInfo) {
                        msg += ' (' + verifyReport.transportInfo.state + ')';
                    }
                    notify(msg, 'success');
                }
            }
            if (options.callback) options.callback(verifyErr || null, nextRenderer, verifyReport || null);
        }

        if (options.stopPrevious && prevActive && prevActive.id !== nextRenderer.id) {
            avStop(prevActive, function () {
                if (options.verify !== false) {
                    verifyUpnpRenderer(nextRenderer, function (err, report) {
                        finishSwitch(err, report);
                    });
                } else {
                    finishSwitch(null, null);
                }
            });
        } else if (options.verify !== false) {
            verifyUpnpRenderer(nextRenderer, function (err, report) {
                finishSwitch(err, report);
            });
        } else {
            finishSwitch(null, null);
        }
        return nextRenderer;
    }

    function restorePersistedRenderer(callback, options) {
        options = options || {};
        var mode = String(setting('playback_target', 'local') || 'local');
        if (mode !== 'renderer' && !options.force) {
            if (callback) callback(null, null);
            return;
        }
        var persistedId = readPersistedRendererId();
        if (persistedId && rendererRegistry.items[persistedId]) {
            rendererRegistry.activeId = persistedId;
            if (callback) callback(null, rendererRegistry.items[persistedId]);
            return;
        }
        var url = String(setting('renderer_url', '')).replace(/^\s+|\s+$/g, '');
        if (url && isValidResourceUrl(url)) {
            fetchRendererDescription(url, function (err, renderer) {
                if (!err && renderer && persistedId && renderer.id === persistedId) {
                    rendererRegistry.activeId = renderer.id;
                }
                if (callback) callback(err || null, renderer || getActiveRenderer());
            }, { makeActive: true });
            return;
        }
        if (callback) callback(null, getActiveRenderer());
    }

    function formatRendererChoiceSubtitle(renderer) {
        var parts = [];
        if (renderer.id === rendererRegistry.activeId) parts.push('АКТИВЕН');
        if (renderer.lastTransportInfo && renderer.lastTransportInfo.state) {
            parts.push('Состояние: ' + renderer.lastTransportInfo.state);
        }
        if (renderer.modelName) parts.push(renderer.modelName);
        if (renderer.endpoints && renderer.endpoints.avTransport) parts.push(renderer.endpoints.avTransport);
        return parts.join(' · ') || renderer.descriptionUrl || '';
    }

    function openRendererSelectUi() {
        function presentChoices() {
            var renderers = listRegisteredRenderers();
            if (!renderers.length) {
                notify('Список UPnP Renderer пуст. Укажите URL в настройках или запустите SSDP-поиск.', 'error');
                return;
            }
            var entries = renderers.map(function (r) {
                return {
                    title: (r.id === rendererRegistry.activeId ? '● ' : '○ ') + (r.friendlyName || r.id),
                    subtitle: formatRendererChoiceSubtitle(r),
                    rendererId: r.id
                };
            });
            openSelect('Выбор активного UPnP Renderer', entries, function (selected) {
                if (!selected || !selected.rendererId) return;
                notify('Переключение на ' + (rendererRegistry.items[selected.rendererId] ? rendererRegistry.items[selected.rendererId].friendlyName : selected.rendererId) + '…');
                selectRendererById(selected.rendererId, {
                    verify: true,
                    stopPrevious: false,
                    syncUrl: true,
                    notify: true
                });
            }, function () {});
        }

        var url = String(setting('renderer_url', '')).replace(/^\s+|\s+$/g, '');
        var current = getActiveRenderer();
        if (!current && url && isValidResourceUrl(url)) {
            fetchRendererDescription(url, function () {
                presentChoices();
            }, { makeActive: true });
        } else {
            presentChoices();
        }
    }


    // =========================================================================
    // AVTransport Playback Integration & Remote Control (Step 5)
    // =========================================================================
    var rendererSessionSeq = 0;
    var rendererPlaybackState = {
        sessionId: 0,
        launching: false,
        active: false,
        hasPlayed: false,
        rendererId: '',
        title: '',
        uri: '',
        entry: null,
        resource: null,
        transportState: 'STOPPED',
        transportActions: [],
        relTime: '00:00:00',
        duration: '00:00:00',
        pollTimer: null
    };

    function isRendererOutputEnabled() {
        var mode = String(setting('playback_target', 'local') || 'local');
        return mode === 'renderer' && !!getActiveRenderer();
    }

    function stopRendererStatusPolling() {
        if (rendererPlaybackState.pollTimer) {
            clearTimeout(rendererPlaybackState.pollTimer);
            rendererPlaybackState.pollTimer = null;
        }
    }

    function resetRendererPlaybackSession(reason) {
        rendererSessionSeq++;
        stopRendererStatusPolling();
        rendererPlaybackState.sessionId = rendererSessionSeq;
        rendererPlaybackState.launching = false;
        rendererPlaybackState.active = false;
        rendererPlaybackState.hasPlayed = false;
        rendererPlaybackState.rendererId = '';
        rendererPlaybackState.title = '';
        rendererPlaybackState.uri = '';
        rendererPlaybackState.entry = null;
        rendererPlaybackState.resource = null;
        rendererPlaybackState.transportState = 'STOPPED';
        rendererPlaybackState.transportActions = [];
        rendererPlaybackState.relTime = '00:00:00';
        rendererPlaybackState.duration = '00:00:00';
    }

    function isRendererSessionCurrent(sessionId, rendererId) {
        var active = getActiveRenderer();
        return !!active &&
            rendererPlaybackState.sessionId === sessionId &&
            rendererPlaybackState.rendererId === rendererId &&
            active.id === rendererId;
    }

    function parseHmsToSeconds(hms) {
        var parts = String(hms || '').split(':');
        if (parts.length !== 3) return 0;
        var h = parseInt(parts[0], 10) || 0;
        var m = parseInt(parts[1], 10) || 0;
        var s = parseFloat(parts[2]) || 0;
        return Math.max(0, h * 3600 + m * 60 + s);
    }

    function formatSecondsToHms(totalSec) {
        var sec = Math.max(0, Math.floor(Number(totalSec) || 0));
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function isBenignAvStopError(err) {
        var msg = errorText(err).toLowerCase();
        // UPnP AVTransport error 701 (Transition not available) is expected when already STOPPED
        return msg.indexOf('701') >= 0 || msg.indexOf('transition not available') >= 0;
    }

    function avGetCurrentTransportActions(renderer, callback, instanceId) {
        var inst = instanceId === undefined ? '0' : String(instanceId);
        avTransportCall(renderer, 'GetCurrentTransportActions', [['InstanceID', inst]], function (doc) {
            var raw = textOf(doc.documentElement, 'Actions') || '';
            var actions = raw.split(',').map(function (a) {
                return a.replace(/^\s+|\s+$/g, '').toUpperCase();
            }).filter(Boolean);
            if (callback) callback(null, actions);
        }, function (err) {
            if (callback) callback(err, []);
        });
    }

    function refreshRendererPlaybackStatus(callback, expectedSessionId, expectedRendererId) {
        var renderer = getActiveRenderer();
        if (!renderer) {
            if (callback) callback(new Error('Активный Renderer не выбран'));
            return;
        }
        var targetRendererId = expectedRendererId || renderer.id;
        var targetSessionId = expectedSessionId !== undefined ? expectedSessionId : rendererPlaybackState.sessionId;

        function stillValid() {
            var cur = getActiveRenderer();
            if (!cur || cur.id !== targetRendererId) return false;
            if (expectedSessionId !== undefined && rendererPlaybackState.sessionId !== targetSessionId) return false;
            return true;
        }

        avGetTransportInfo(renderer, function (tErr, tInfo) {
            if (!stillValid()) return;
            if (!tErr && tInfo) {
                rendererPlaybackState.transportState = tInfo.state;
                if (tInfo.state === 'PLAYING' || tInfo.state === 'TRANSITIONING' || tInfo.state === 'PAUSED_PLAYBACK') {
                    rendererPlaybackState.hasPlayed = true;
                } else if (rendererPlaybackState.hasPlayed &&
                    (tInfo.state === 'STOPPED' || tInfo.state === 'NO_MEDIA_PRESENT')) {
                    // Natural playback completion on TV: stop background polling
                    rendererPlaybackState.active = false;
                    rendererPlaybackState.hasPlayed = false;
                    stopRendererStatusPolling();
                }
            }
            avGetPositionInfo(renderer, function (pErr, pInfo) {
                if (!stillValid()) return;
                if (!pErr && pInfo) {
                    rendererPlaybackState.relTime = pInfo.relTime || rendererPlaybackState.relTime;
                    if (pInfo.duration && pInfo.duration !== '00:00:00' && pInfo.duration !== 'NOT_IMPLEMENTED') {
                        rendererPlaybackState.duration = pInfo.duration;
                    }
                    if (pInfo.uri) rendererPlaybackState.uri = pInfo.uri;
                }
                if (callback) callback(tErr || pErr || null, rendererPlaybackState);
            });
        });
    }

    function scheduleNextRendererPoll(sessionId, rendererId) {
        stopRendererStatusPolling();
        if (!rendererPlaybackState.active || !isRendererSessionCurrent(sessionId, rendererId)) return;
        rendererPlaybackState.pollTimer = setTimeout(function () {
            rendererPlaybackState.pollTimer = null;
            if (!rendererPlaybackState.active || !isRendererSessionCurrent(sessionId, rendererId)) return;
            refreshRendererPlaybackStatus(function () {
                if (rendererPlaybackState.active && isRendererSessionCurrent(sessionId, rendererId)) {
                    scheduleNextRendererPoll(sessionId, rendererId);
                }
            }, sessionId, rendererId);
        }, 4000);
    }

    function playOnActiveRenderer(entry, selectedResource, onComplete) {
        var renderer = getActiveRenderer();
        if (!renderer) {
            notify('Активный UPnP Renderer не выбран. Выберите устройство в настройках.', 'error');
            if (onComplete) onComplete(new Error('No active renderer'));
            return;
        }
        if (rendererPlaybackState.launching) {
            notify('Выполняется запуск на ' + renderer.friendlyName + ', дождитесь завершения…', 'default');
            if (onComplete) onComplete(new Error('Renderer launch already in progress'));
            return;
        }
        var url = playbackUrl(entry, selectedResource);
        if (!validatePlaybackUrl(url)) {
            if (onComplete) onComplete(new Error('Invalid playback URL'));
            return;
        }

        // Start an isolated session bound to this rendererId
        stopRendererStatusPolling();
        var sessionId = ++rendererSessionSeq;
        var rendererId = renderer.id;
        rendererPlaybackState.sessionId = sessionId;
        rendererPlaybackState.launching = true;
        rendererPlaybackState.active = false;
        rendererPlaybackState.hasPlayed = false;
        rendererPlaybackState.rendererId = rendererId;
        rendererPlaybackState.title = entry.title || 'DLNA Media';
        rendererPlaybackState.uri = url;
        rendererPlaybackState.entry = entry;
        rendererPlaybackState.resource = selectedResource || null;
        rendererPlaybackState.transportState = 'TRANSITIONING';
        rendererPlaybackState.transportActions = [];
        rendererPlaybackState.relTime = '00:00:00';
        rendererPlaybackState.duration = (selectedResource && selectedResource.duration) || entry.duration || '00:00:00';

        var metadata = buildDidlMetadata(entry, selectedResource);
        notify('Отправка на ' + renderer.friendlyName + ': ' + rendererPlaybackState.title + '…');

        function abortIfStale() {
            return !isRendererSessionCurrent(sessionId, rendererId);
        }

        function startNewStream() {
            if (abortIfStale()) return;
            avSetAVTransportURI(renderer, url, metadata, function (setErr) {
                if (abortIfStale()) return;
                if (setErr) {
                    rendererPlaybackState.launching = false;
                    rendererPlaybackState.transportState = 'STOPPED';
                    notify('Ошибка SetAVTransportURI: ' + errorText(setErr), 'error');
                    if (onComplete) onComplete(setErr);
                    return;
                }
                avPlay(renderer, function (playErr) {
                    if (abortIfStale()) return;
                    rendererPlaybackState.launching = false;
                    if (playErr) {
                        rendererPlaybackState.transportState = 'STOPPED';
                        notify('Ошибка AVTransport Play: ' + errorText(playErr), 'error');
                        if (onComplete) onComplete(playErr);
                        return;
                    }
                    rendererPlaybackState.active = true;
                    rendererPlaybackState.hasPlayed = true;
                    rendererPlaybackState.transportState = 'PLAYING';
                    avGetCurrentTransportActions(renderer, function (actErr, actions) {
                        if (!abortIfStale() && !actErr && actions && actions.length) {
                            rendererPlaybackState.transportActions = actions;
                        }
                    });
                    scheduleNextRendererPoll(sessionId, rendererId);
                    notify('Воспроизведение на ' + renderer.friendlyName + ': ' + rendererPlaybackState.title, 'success');
                    if (onComplete) onComplete(null, rendererPlaybackState);
                }, '1');
            });
        }

        // Stop any active stream before loading a new URI; fail or warn on non-701 Stop errors
        avStop(renderer, function (stopErr) {
            if (abortIfStale()) return;
            if (stopErr && !isBenignAvStopError(stopErr)) {
                rendererPlaybackState.launching = false;
                rendererPlaybackState.transportState = 'STOPPED';
                notify('Не удалось остановить предыдущий поток перед запуском: ' + errorText(stopErr), 'error');
                if (onComplete) onComplete(stopErr);
                return;
            }
            startNewStream();
        });
    }

    function rendererSupportsAction(renderer, actionName) {
        var upper = String(actionName || '').toUpperCase();
        var runtimeActions = rendererPlaybackState.rendererId === renderer.id ? rendererPlaybackState.transportActions : [];
        if (runtimeActions && runtimeActions.length) {
            return runtimeActions.indexOf(upper) >= 0;
        }
        var scpd = renderer && renderer.scpd && renderer.scpd.avTransport;
        if (scpd && scpd.actions) {
            return !!scpd.actions[actionName];
        }
        return true;
    }

    function openRendererRemoteUi() {
        var renderer = getActiveRenderer();
        if (!renderer) {
            notify('Активный UPnP Renderer не выбран.', 'error');
            return;
        }
        var targetRendererId = renderer.id;
        notify('Запрос состояния ' + renderer.friendlyName + '…');
        refreshRendererPlaybackStatus(function (statusErr) {
            var currentRenderer = getActiveRenderer();
            if (!currentRenderer || currentRenderer.id !== targetRendererId) return;
            if (statusErr) {
                notify('Не удалось получить статус Renderer: ' + errorText(statusErr), 'error');
                return;
            }
            avGetCurrentTransportActions(renderer, function (actErr, actions) {
                if (!actErr && actions && actions.length && rendererPlaybackState.rendererId === renderer.id) {
                    rendererPlaybackState.transportActions = actions;
                }
                var st = rendererPlaybackState;
                var header = renderer.friendlyName + ' [' + (st.transportState || 'UNKNOWN') + ']' +
                    (st.relTime && st.duration && st.duration !== '00:00:00' ? ' · ' + st.relTime + ' / ' + st.duration : (st.relTime ? ' · ' + st.relTime : ''));
                var items = [
                    {
                        title: '▶ Play / Продолжить',
                        subtitle: st.title || 'Возобновить воспроизведение на Renderer',
                        action: 'play'
                    }
                ];
                if (rendererSupportsAction(renderer, 'Pause')) {
                    items.push({
                        title: '⏸ Pause / Пауза',
                        subtitle: 'Приостановить воспроизведение',
                        action: 'pause'
                    });
                }
                items.push({
                    title: '⏹ Stop / Стоп',
                    subtitle: 'Остановить воспроизведение на Renderer',
                    action: 'stop'
                });
                if (rendererSupportsAction(renderer, 'Seek')) {
                    items.push({
                        title: '⏩ Перемотать вперёд (+30 сек)',
                        subtitle: 'Seek REL_TIME +00:00:30',
                        action: 'seek_fwd'
                    });
                    items.push({
                        title: '⏪ Перемотать назад (-30 сек)',
                        subtitle: 'Seek REL_TIME -00:00:30',
                        action: 'seek_back'
                    });
                }
                items.push({
                    title: '🔄 Обновить статус',
                    subtitle: 'GetTransportInfo + GetPositionInfo',
                    action: 'refresh'
                });

                openSelect(header, items, function (chosen) {
                    if (!chosen) return;
                    var activeNow = getActiveRenderer();
                    if (!activeNow || activeNow.id !== targetRendererId) {
                        notify('Активный Renderer был изменён.', 'error');
                        return;
                    }
                    if (chosen.action === 'play') {
                        avPlay(renderer, function (err) {
                            if (err) notify('Ошибка Play: ' + errorText(err), 'error');
                            else {
                                rendererPlaybackState.rendererId = renderer.id;
                                rendererPlaybackState.active = true;
                                rendererPlaybackState.hasPlayed = true;
                                rendererPlaybackState.transportState = 'PLAYING';
                                scheduleNextRendererPoll(rendererPlaybackState.sessionId, renderer.id);
                                notify('Renderer: PLAYING', 'success');
                            }
                        }, '1');
                    } else if (chosen.action === 'pause') {
                        avPause(renderer, function (err) {
                            if (err) notify('Ошибка Pause: ' + errorText(err), 'error');
                            else {
                                rendererPlaybackState.transportState = 'PAUSED_PLAYBACK';
                                notify('Renderer: PAUSED', 'default');
                            }
                        });
                    } else if (chosen.action === 'stop') {
                        avStop(renderer, function (err) {
                            if (err) notify('Ошибка Stop: ' + errorText(err), 'error');
                            else {
                                rendererPlaybackState.active = false;
                                rendererPlaybackState.hasPlayed = false;
                                rendererPlaybackState.transportState = 'STOPPED';
                                stopRendererStatusPolling();
                                notify('Renderer: STOPPED', 'default');
                            }
                        });
                    } else if (chosen.action === 'seek_fwd' || chosen.action === 'seek_back') {
                        refreshRendererPlaybackStatus(function (posErr) {
                            if (posErr) {
                                notify('Не удалось определить текущую позицию для перемотки: ' + errorText(posErr), 'error');
                                return;
                            }
                            var cur = parseHmsToSeconds(rendererPlaybackState.relTime);
                            var maxDur = parseHmsToSeconds(rendererPlaybackState.duration);
                            var delta = chosen.action === 'seek_fwd' ? 30 : -30;
                            var targetSec = Math.max(0, cur + delta);
                            if (maxDur > 0 && targetSec > maxDur) {
                                targetSec = Math.max(0, maxDur - 1);
                            }
                            var nextTarget = formatSecondsToHms(targetSec);
                            avSeek(renderer, nextTarget, 'REL_TIME', function (err) {
                                if (err) notify('Ошибка Seek: ' + errorText(err), 'error');
                                else {
                                    rendererPlaybackState.relTime = nextTarget;
                                    notify('Перемотка на ' + nextTarget, 'success');
                                }
                            });
                        });
                    } else if (chosen.action === 'refresh') {
                        openRendererRemoteUi();
                    }
                }, function () {});
            });
        });
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
            registerPlayerExternalListener();
            bindAndroidReturn();
            registerPlaybackDiagnosticListeners();
            bindSettingsLifecycle();
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

            registerParam('rendererUrlParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'renderer_url', type: 'input', values: '', default: '', placeholder: 'http://192.168.1.50:1400/xml/device_description.xml' },
                field: {
                    name: translated('dlna_bridge_renderer_url', 'URL описания UPnP Renderer'),
                    description: translated('dlna_bridge_renderer_desc', 'Ссылка на XML-описание устройства (device.xml / rootDesc.xml) для определения endpoint AVTransport.')
                }
            });
            registerParam('inspectRendererParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'renderer_inspect', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_renderer_check', 'Проверить UPnP Renderer') },
                onChange: function () { inspectConfiguredRenderer(); }
            });
            registerParam('verifyRendererAvParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'renderer_verify_av', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_renderer_av_check', 'Проверить AVTransport SOAP') },
                onChange: function () { verifyConfiguredRenderer(); }
            });
            registerParam('ssdpDiscoverParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'ssdp_discover', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_ssdp_discover', 'SSDP-поиск устройств (UDP)') },
                onChange: function () { runSsdpDiscoveryUi(); }
            });
            registerParam('selectRendererParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'renderer_select', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_renderer_select', 'Выбрать активный Renderer') },
                onChange: function () { openRendererSelectUi(); }
            });
            registerParam('playbackTargetParam', {
                component: COMPONENT,
                param: {
                    name: PREFIX + 'playback_target',
                    type: 'select',
                    values: {
                        local: 'Локальный плеер Lampa',
                        renderer: 'UPnP/DLNA Renderer (AVTransport)'
                    },
                    default: 'local'
                },
                field: {
                    name: translated('dlna_bridge_playback_target', 'Куда отправлять воспроизведение'),
                    description: translated('dlna_bridge_playback_target_desc', 'Локальный плеер Lampa или внешний UPnP/DLNA Renderer через AVTransport.')
                }
            });
            registerParam('rendererRemoteParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'renderer_remote', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_renderer_remote', 'Пульт управления Renderer (Play/Pause/Stop/Seek)') },
                onChange: function () { openRendererRemoteUi(); }
            });

            registerParam('androidRecoveryParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'android_recovery', type: 'trigger', default: false },
                field: { name: 'Разрешить новую попытку — Android' },
                onChange: requestAndroidRecovery
            });

            registerParam('androidDiagnosticParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'androidjs_diag', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_androidjs', 'Проверить AndroidJS') },
                onChange: function () { diagnoseAndroidBridges(); }
            });

            registerParam('showPlaybackDiagnosticLogParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'playback_diagnostic_log', type: 'trigger', default: false },
                field: { name: 'PLAYBACK DIAGNOSTICS (LOCAL): Show playback diagnostic log (memory only)' },
                onChange: function () { showPlaybackDiagnosticLog(); }
            });
            registerParam('previousPlaybackDiagnosticLogParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'playback_diagnostic_previous', type: 'trigger', default: false },
                field: { name: 'Previous playback diagnostic events (same snapshot)' },
                onChange: function () { showPreviousPlaybackDiagnosticLog(); }
            });
            registerParam('clearPlaybackDiagnosticLogParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'clear_playback_diagnostic_log', type: 'trigger', default: false },
                field: { name: 'Clear playback diagnostic log (not catalog cache)' },
                onChange: function () { clearPlaybackDiagnosticLog(); }
            });

            if (String(setting('playback_target', 'local') || 'local') === 'renderer') {
                restorePersistedRenderer();
            }

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
