/* Lampa DLNA Bridge 0.6.8
 * Native Lampa.Reguest transport + ContentDirectory Browse + DIDL-Lite navigation.
 * No SSDP discovery: the router server is configured by address.
 */
(function () {
    'use strict';

    var GUARD = 'lampa_dlna_bridge_060';
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
    var checkingServer = false;
    var serverGeneration = 0;
    var knownServer = null;
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
                name: 'DLNA Bridge 0.6.8',
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
                dlna_bridge_title: { ru: 'DLNA Bridge 0.6.8', en: 'DLNA Bridge 0.6.8' },
                dlna_bridge_server: { ru: 'Адрес DLNA-сервера', en: 'DLNA server address' },
                dlna_bridge_open: { ru: 'Открыть каталог DLNA', en: 'Open DLNA catalog' },
                dlna_bridge_check_server: { ru: 'Проверить DLNA-сервер', en: 'Check DLNA server' },
                dlna_bridge_check_success: { ru: 'Сервер ответил. Элементов в корне: ', en: 'Server responded. Root entries: ' },
                dlna_bridge_check_failure: { ru: 'Не удалось прочитать каталог. Проверьте адрес и доступность MiniDLNA.', en: 'Could not read the catalog. Check the MiniDLNA address and availability.' },
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

    function normalizedAddress(value) {
        return String(value).replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    }

    function baseUrl() {
        var address = normalizedAddress(setting('server_url', DEFAULT_BASE));
        if (knownServer !== null && knownServer !== address) {
            serverGeneration++;
            cache = {};
            browseToken++;
            if (activeBrowser) activeBrowser.serverChanged();
        }
        knownServer = address;
        return address;
    }

    function changeServer(address) {
        baseUrl();
        Lampa.Storage.set(PREFIX + 'server_url', normalizedAddress(address));
        baseUrl();
    }

    function savedServers() {
        var values = setting('saved_servers', []);
        if (Object.prototype.toString.call(values) !== '[object Array]') return [];
        var result = [];
        for (var i = 0; i < values.length; i++) {
            if (typeof values[i] !== 'string') continue;
            var address = normalizedAddress(values[i]);
            if (address && result.indexOf(address) < 0) result.push(address);
        }
        return result;
    }

    function saveCurrentServer() {
        var addresses = savedServers();
        var address = baseUrl();
        if (addresses.indexOf(address) < 0) addresses.push(address);
        Lampa.Storage.set(PREFIX + 'saved_servers', addresses);
        notify('Сервер сохранён.', 'success');
    }

    function serverList(removing) {
        var addresses = savedServers();
        var active = baseUrl();
        if (!addresses.length) { notify('Нет сохранённых серверов.', 'default'); return; }
        openSelect(removing ? 'Удалить сохранённый сервер' : 'Выбрать сервер', addresses.map(function (address) {
            return { title: (address === active ? '✓ ' : '') + address, address: address, serverAction: true };
        }), function (entry) {
            var address = entry.address;
            if (!removing) { changeServer(address); return; }
            openSelect('Удалить ' + address + '?', [
                { title: 'Отмена', serverAction: true }, { title: 'Удалить', confirmed: true, serverAction: true }
            ], function (answer) {
                if (!answer.confirmed) return;
                Lampa.Storage.set(PREFIX + 'saved_servers', savedServers().filter(function (item) { return item !== address; }));
            });
        });
    }

    function requestNative(url, body, headers, success, failure, independent) {
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
            if (!independent) currentRequest = req;
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

    function soapBrowse(objectId, start, count, success, failure, isCurrent, checkAddress) {
        var body = '<?xml version="1.0" encoding="utf-8"?>' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:Browse xmlns:u="' + SERVICE + '">' +
            '<ObjectID>' + xmlEscape(objectId) + '</ObjectID>' +
            '<BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>' +
            '<StartingIndex>' + start + '</StartingIndex><RequestedCount>' + count + '</RequestedCount>' +
            '<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>';
        var checkingAddress = checkAddress !== undefined;
        requestNative((checkingAddress ? checkAddress : baseUrl()) + '/ctl/ContentDir', body, {
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
        }, failure, checkingAddress);
    }

    function checkServer() {
        if (checkingServer) return;
        var address = baseUrl();
        var checkGeneration = serverGeneration;
        checkingServer = true;
        soapBrowse('0', 0, 1, function (items, total) {
            checkingServer = false;
            if (baseUrl() !== address || checkGeneration !== serverGeneration) return;
            notify(translated('dlna_bridge_check_success', 'Сервер ответил. Элементов в корне: ') + total, 'success');
        }, function () {
            checkingServer = false;
            if (baseUrl() !== address || checkGeneration !== serverGeneration) return;
            notify(translated('dlna_bridge_check_failure', 'Не удалось прочитать каталог. Проверьте адрес и доступность MiniDLNA.'), 'error');
        }, null, address);
    }

    function browseAll(objectId, callback, token) {
        baseUrl();
        var requestServerGeneration = serverGeneration;
        token = token === undefined ? browseToken : token;
        function isCurrent() {
            baseUrl();
            return token === browseToken && requestServerGeneration === serverGeneration;
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
        if (entry.serverAction) return true;
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
        var gb = bytes / 1073741824;
        return gb >= 1 ? gb.toFixed(2) + ' ГБ' : (bytes / 1048576).toFixed(0) + ' МБ';
    }

    function formatResourceSubtitle(resource) {
        var details = [];
        if (resource.mime) details.push(resource.mime);
        if (resource.resolution) details.push(resource.resolution);
        if (resource.bitrate) details.push(Math.round(resource.bitrate / 1000) + ' кбит/с');
        if (resource.duration) details.push(resource.duration);
        if (resource.size) details.push(formatSize(resource.size));
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
        var browserServerGeneration = serverGeneration;
        this.serverChanged = function () {
            generation++;
            loading = false;
            parents = [];
            resourceEntry = null;
            resourceIndex = 0;
            resourceScroll = 0;
            error = '';
            frame = { id: '0', title: 'DLNA', items: null, index: 0, scroll: 0 };
            frame.diagnosticFolder = ++returnDiagnosticFolderSequence;
            browserServerGeneration = serverGeneration;
            if (root) renderRows();
        };
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
            baseUrl();
            if (browserServerGeneration !== serverGeneration) self.serverChanged();
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
                // Main.start delegates content to items_line in the Android web build.
                var returnedController = controllerName();
                if (!previous || Lampa.Activity.active() !== previous ||
                    (returnedController !== 'content' && !(previous.component === 'main' && returnedController === 'items_line')) ||
                    typeof Lampa.Controller.windowTop !== 'function' ||
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
        baseUrl();
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

            baseUrl();
            registerComponent();
            registerParam('serverUrlParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'server_url', type: 'input', values: '', default: DEFAULT_BASE, placeholder: DEFAULT_BASE },
                field: {
                    name: translated('dlna_bridge_server', 'Адрес DLNA-сервера'),
                    description: translated('dlna_bridge_about', 'SOAP Browse через Lampa.Reguest.native.')
                },
                onChange: function () {
                    // Params.input has already stored the value and Input has closed.
                    // Recreate our panel after that teardown, with the new stored value.
                    baseUrl();
                    Lampa.Controller.toggle('settings');
                    Lampa.Settings.create(COMPONENT);
                }
            });
            registerParam('save_serverParam', { component: COMPONENT, param: { name: PREFIX + 'save_server', type: 'trigger', default: false }, field: { name: 'Сохранить текущий сервер' }, onChange: function () { saveCurrentServer(); } });
            registerParam('select_serverParam', { component: COMPONENT, param: { name: PREFIX + 'select_server', type: 'trigger', default: false }, field: { name: 'Выбрать сервер' }, onChange: function () { serverList(false); } });
            registerParam('delete_serverParam', { component: COMPONENT, param: { name: PREFIX + 'delete_server', type: 'trigger', default: false }, field: { name: 'Удалить сохранённый сервер' }, onChange: function () { serverList(true); } });
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

            registerParam('checkServerParam', {
                component: COMPONENT,
                param: { name: PREFIX + 'check_server', type: 'trigger', default: false },
                field: { name: translated('dlna_bridge_check_server', 'Проверить DLNA-сервер') },
                onChange: checkServer
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
