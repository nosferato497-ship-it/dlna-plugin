var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function createHarness(options) {
    options = options || {};
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
    var components = [];
    var componentCalls = 0;
    var params = [];
    if (options.existingComponent) {
        components.push({ component: 'dlna_bridge', name: 'DLNA Bridge 0.6.0' });
    }
    if (options.existingParams) {
        options.existingParams.forEach(function (name) {
            params.push({
                component: 'dlna_bridge',
                param: { name: name, type: name === 'dlna_bridge_server_url' ? 'input' : 'trigger' },
                field: { name: name }
            });
        });
    }
    var paramValues = {};
    var paramDefaults = {};
    var selectCalls = 0;
    var triggerCalls = 0;
    var logs = [];
    var failComponentBefore = !!options.failComponentBefore;
    var failComponentAfter = !!options.failComponentAfter;
    var failParamBefore = options.failParamBefore || '';
    var failParamAfter = options.failParamAfter || '';
    var failParamInit = options.failParamInit || '';
    var failParamInitStage = options.failParamInitStage || null;
    var failLangAdd = !!options.failLangAdd;
    var failTranslate = !!options.failTranslate;
    var followMode = options.followMode || '';
    var followCalls = 0;
    var readyHandlers = [];
    var playerFollowMode = options.playerFollowMode || '';
    var playerFollowFailuresBefore = options.playerFollowFailuresBefore || 0;
    var playerFollowCalls = 0;
    var playerCloseHandlers = [];
    var playerCallback = null;
    var playerCallbacks = [];
    var playerCloseCalls = 0;
    var activeController = 'settings_component';
    var controllerRegistry = {};
    var controllerToggles = [];
    var controllerToggleAttempts = [];
    var closeOrder = [];
    if (options.existingPlayerClose) {
        playerCloseHandlers.push({ name: 'close', callback: function oldPlayerCloseHandler() { playerCloseCalls++; } });
    }
    var Lampa = {};

    function shouldFailParamInit(name, method, stage) {
        if (failParamInitStage && failParamInitStage.name === name &&
            failParamInitStage.method === method && failParamInitStage.stage === stage) {
            failParamInitStage = null;
            throw new Error('Params.' + method + ' failed at ' + stage);
        }
        if (stage === 'after' && name === failParamInit) {
            failParamInit = '';
            throw new Error('Params.' + method + ' failed after initialization');
        }
    }

    var Params = {
        select: function (name, values, defaultValue) {
            selectCalls++;
            shouldFailParamInit(name, 'select', 'before');
            paramValues[name] = values;
            shouldFailParamInit(name, 'select', 'partial');
            paramDefaults[name] = defaultValue;
            shouldFailParamInit(name, 'select', 'after');
        },
        trigger: function (name, defaultValue) {
            triggerCalls++;
            shouldFailParamInit(name, 'trigger', 'before');
            paramValues[name] = {
                'true': '#{settings_param_yes}',
                'false': '#{settings_param_no}'
            };
            shouldFailParamInit(name, 'trigger', 'partial');
            paramDefaults[name] = defaultValue;
            shouldFailParamInit(name, 'trigger', 'after');
        }
    };

    function addParam(param) {
        var name = param && param.param && param.param.name;
        if (name === failParamBefore) {
            failParamBefore = '';
            throw new Error('addParam failed before insertion');
        }
        params.push(param);
        if (param.param.type === 'select' || param.param.type === 'input') {
            Params.select(param.param.name, param.param.values, param.param.default);
        } else if (param.param.type === 'trigger') {
            Params.trigger(param.param.name, param.param.default);
        }
        if (name === failParamAfter) {
            failParamAfter = '';
            throw new Error('addParam failed after insertion');
        }
    }

    Lampa.SettingsApi = options.withoutSettingsApi ? null : {
        addComponent: function (component) {
            componentCalls++;
            if (failComponentBefore) {
                failComponentBefore = false;
                throw new Error('addComponent failed before insertion');
            }
            var i;
            for (i = 0; i < components.length; i++) {
                if (components[i].component === component.component) {
                    components[i] = component;
                    if (failComponentAfter) {
                        failComponentAfter = false;
                        throw new Error('addComponent failed after insertion');
                    }
                    return;
                }
            }
            components.push(component);
            if (failComponentAfter) {
                failComponentAfter = false;
                throw new Error('addComponent failed after insertion');
            }
        },
        getComponent: function (name) {
            var i;
            for (i = 0; i < components.length; i++) {
                if (components[i].component === name) return components[i];
            }
            return undefined;
        },
        addParam: addParam,
        getParam: function (component) {
            var found = [];
            var i;
            for (i = 0; i < params.length; i++) {
                if (params[i].component === component) found.push(params[i]);
            }
            return found.length ? found : undefined;
        }
    };
    Lampa.Storage = options.withoutStorage ? null : { field: function () { return ''; } };
    Lampa.Lang = options.withoutLang ? null : {
        add: function () {
            if (failLangAdd) {
                failLangAdd = false;
                throw new Error('Lang.add failed');
            }
        },
        translate: options.withoutTranslate ? undefined : function (key) {
            if (failTranslate) throw new Error('Lang.translate failed');
            return key;
        }
    };
    var playerListener = {
            follow: function (name, callback) {
                // This harness verifies close-listener registration; the component's
                // permanent external listener is a separate plugin-lifetime subscription.
                if (name !== 'close') return;
                playerFollowCalls++;
                if (playerFollowFailuresBefore > 0) {
                    playerFollowFailuresBefore--;
                    throw new Error('Player.listener.follow failed before subscription');
                }
                if (playerFollowMode === 'before') {
                    playerFollowMode = '';
                    throw new Error('Player.listener.follow failed before subscription');
                }
                playerCloseHandlers.push({ name: name, callback: callback });
                playerCallbacks.push(callback);
                if (playerFollowMode === 'after') {
                    playerFollowMode = '';
                    throw new Error('Player.listener.follow failed after subscription');
                }
            },
            has: options.playerHasMode === 'absent' ? undefined : function (name, callback) {
                if (options.playerHasMode === 'throws') throw new Error('Player.listener.has failed');
                var i;
                for (i = 0; i < playerCloseHandlers.length; i++) {
                    if (playerCloseHandlers[i].name === name && playerCloseHandlers[i].callback === callback) return true;
                }
                return false;
            }
    };
    Lampa.Player = {
        listener: playerListener,
        callback: function (callback) { playerCallback = callback; },
        play: function () {}
    };
    function addController(name, controller) {
        controllerRegistry[name] = controller || {};
    }
    addController('settings_component', {});
    addController('player', {});

    Lampa.Controller = {
        add: addController,
        enabled: function () {
            return { name: activeController, controller: controllerRegistry[activeController] };
        },
        toggle: function (name) {
            controllerToggleAttempts.push(name);
            if (!Object.prototype.hasOwnProperty.call(controllerRegistry, name)) return;
            activeController = name;
            controllerToggles.push(name);
            closeOrder.push('toggle:' + name);
        }
    };
    Lampa.Listener = options.withoutListener ? null : {
        follow: function (name, callback) {
            if (name !== 'app') return;
            followCalls++;
            if (followMode === 'before') {
                followMode = '';
                throw new Error('Listener.follow failed before subscription');
            }
            readyHandlers.push(callback);
            if (followMode === 'after') {
                followMode = '';
                throw new Error('Listener.follow failed after subscription');
            }
        }
    };
    Lampa.Noty = { show: function (message) { logs.push(String(message)); } };

    var window = {
        Lampa: options.withoutLampa ? null : Lampa,
        appready: options.appready !== undefined ? options.appready : true,
        console: {
            log: function (message) { logs.push(String(message)); },
            error: function (message) { logs.push(String(message)); }
        }
    };
    if (Object.prototype.hasOwnProperty.call(options, 'initialGuard')) {
        window.lampa_dlna_bridge_060 = options.initialGuard;
    }
    var document = { getElementById: function () { return null; } };
    var context = { window: window, Lampa: Lampa, document: document, console: window.console };

    source = source.replace(
        'if (window.appready) init();',
        'window.__test = { init: init, play: play, diagnoseAndroidBridges: diagnoseAndroidBridges }; if (window.appready) init();'
    );

    function loadAgain() {
        vm.runInNewContext(source, context);
    }

    function emitReady() {
        var handlers = readyHandlers.slice();
        var i;
        for (i = 0; i < handlers.length; i++) handlers[i]({ type: 'ready' });
    }

    loadAgain();
    return {
        components: components,
        componentCalls: function () { return componentCalls; },
        params: params,
        paramValues: paramValues,
        paramDefaults: paramDefaults,
        selectCalls: function () { return selectCalls; },
        triggerCalls: function () { return triggerCalls; },
        logs: logs,
        readyHandlerCount: function () { return readyHandlers.length; },
        followCalls: function () { return followCalls; },
        playerFollowCalls: function () { return playerFollowCalls; },
        playerCloseHandlerCount: function () { return playerCloseHandlers.length; },
        playerCloseCallback: function (index) { return playerCloseHandlers[index] && playerCloseHandlers[index].callback; },
        guardPlayerCloseHandler: function () {
            var guard = window.lampa_dlna_bridge_060;
            return guard && guard.playerCloseHandler;
        },
        playerCallbacks: playerCallbacks,
        playerCloseCalls: function () { return playerCloseCalls; },
        closeOrder: closeOrder,
        closePlayer: function () {
            var callback = playerCallback;
            if (typeof callback === 'function') {
                callback();
                closeOrder.push('callback:done');
            }
            playerCallback = null;
            closeOrder.push('callback:cleared');
            closeOrder.push('close:event');
            var handlers = playerCloseHandlers.slice();
            var i;
            for (i = 0; i < handlers.length; i++) {
                if (handlers[i].name === 'close') handlers[i].callback({});
            }
        },
        play: function () { window.__test.play({ url: 'http://server/video', title: 'video' }); },
        diagnoseAndroidBridges: function () { return window.__test.diagnoseAndroidBridges(); },
        setActiveController: function (name) { activeController = name; },
        activeController: function () { return activeController; },
        enabledController: function () { return Lampa.Controller.enabled(); },
        toggleController: function (name) { Lampa.Controller.toggle(name); },
        controllerToggles: controllerToggles,
        controllerToggleAttempts: controllerToggleAttempts,
        loadAgain: loadAgain,
        emitReady: emitReady,
        enableListener: function () {
            Lampa.Listener = {
                follow: function (name, callback) {
                    if (name !== 'app') return;
                    followCalls++;
                    readyHandlers.push(callback);
                }
            };
        },
        enableSettingsApi: function () {
            window.Lampa = Lampa;
            Lampa.SettingsApi = {
                addComponent: function (component) { components.push(component); },
                getComponent: function (name) {
                    var i;
                    for (i = 0; i < components.length; i++) {
                        if (components[i].component === name) return components[i];
                    }
                },
                addParam: addParam,
                getParam: function (component) {
                    var found = [];
                    var i;
                    for (i = 0; i < params.length; i++) {
                        if (params[i].component === component) found.push(params[i]);
                    }
                    return found.length ? found : undefined;
                }
            };
            if (!Lampa.Storage) Lampa.Storage = { field: function () { return ''; } };
        },
        setAppReady: function (value) { window.appready = value; },
        guard: function () { return window.lampa_dlna_bridge_060; },
        state: function () { return window.lampa_dlna_bridge_060; }
    };
}

function countParam(harness, name) {
    var count = 0;
    var i;
    for (i = 0; i < harness.params.length; i++) {
        if (harness.params[i].param.name === name) count++;
    }
    return count;
}

function assertCoreRegistered(harness) {
    assert.strictEqual(harness.state().initialized, true);
    assert.strictEqual(harness.state().initializing, false);
    assert.strictEqual(harness.state().loading, false);
    assert.strictEqual(harness.components.length, 1);
    assert.strictEqual(countParam(harness, 'dlna_bridge_server_url'), 1);
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);
    assert.strictEqual(countParam(harness, 'dlna_bridge_clear_cache'), 1);
}

function containsMojibake(value) {
    return /Р(?:°|ё|ѕ|±|є|џ)|С(?:Ђ|‚|€|ѓ|Ѓ)/.test(value);
}

test('registers the optional AndroidJS diagnostic action when supported', function () {
    var harness = createHarness();
    assert.strictEqual(countParam(harness, 'dlna_bridge_androidjs_diag'), 1);
    assertCoreRegistered(harness);
});

test('AndroidJS diagnostic messages use readable Russian and contain no mojibake', function () {
    var harness = createHarness();
    var report = harness.diagnoseAndroidBridges();
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
    var diagnostic = source.slice(source.indexOf('function androidBridgeType'), source.indexOf('function setting'));

    assert.ok(report.indexOf('только чтение дескрипторов') !== -1);
    assert.ok(report.indexOf('AndroidJS: отсутствует') !== -1);
    assert.ok(diagnostic.indexOf('ошибка перечисления') !== -1);
    assert.ok(diagnostic.indexOf('accessor глобального свойства (не прочитан)') !== -1);
    assert.ok(diagnostic.indexOf('ошибка инспекции') !== -1);
    assert.strictEqual(containsMojibake(diagnostic), false);
    assert.strictEqual(containsMojibake(report), false);
});

test('mojibake detector accepts ordinary Russian text', function () {
    assert.strictEqual(containsMojibake('Ошибка инспекции: отсутствует'), false);
});

test('mojibake detector identifies a known UTF-8-as-Windows-1251 sequence', function () {
    assert.strictEqual(containsMojibake('РѕС€РёР±РєР°'), true);
});

test('contains an exception from diagnostic parameter registration without blocking core settings', function () {
    var harness = createHarness({ failParamBefore: 'dlna_bridge_androidjs_diag' });
    assertCoreRegistered(harness);
    assert.strictEqual(countParam(harness, 'dlna_bridge_androidjs_diag'), 0);
});

test('recovers when addComponent throws before inserting the component', function () {
    var harness = createHarness({ failComponentBefore: true });
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().registrations.component, 'pending');
    assert.strictEqual(harness.components.length, 0);
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);

    harness.loadAgain();
    assertCoreRegistered(harness);
    assert.strictEqual(harness.componentCalls(), 2);
});

test('does not repeat addComponent after insertion followed by an exception', function () {
    var harness = createHarness({ failComponentAfter: true });
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().registrations.component, 'uncertain');
    assert.strictEqual(harness.components.length, 1);
    assert.strictEqual(harness.componentCalls(), 1);
    harness.loadAgain();
    assert.strictEqual(harness.componentCalls(), 1);
    assert.strictEqual(harness.state().initialized, false);
});

test('recovers when addParam throws before inserting a required parameter', function () {
    var harness = createHarness({ failParamBefore: 'dlna_bridge_open_catalog' });
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().registrations.openCatalogParam, 'pending');
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 0);
    assert.strictEqual(countParam(harness, 'dlna_bridge_clear_cache'), 1);

    harness.loadAgain();
    assertCoreRegistered(harness);
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);
});

test('does not duplicate or falsely confirm a parameter inserted before addParam throws', function () {
    var harness = createHarness({ failParamAfter: 'dlna_bridge_open_catalog' });
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().registrations.openCatalogParam, 'uncertain');
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);

    harness.loadAgain();
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);
});

test('does not treat parameter presence as proof that Params initialization succeeded', function () {
    var harness = createHarness({
        failParamInitStage: {
            name: 'dlna_bridge_open_catalog',
            method: 'trigger',
            stage: 'before'
        }
    });
    assert.strictEqual(harness.state().registrations.openCatalogParam, 'uncertain');
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);
    assert.strictEqual(harness.paramValues.dlna_bridge_open_catalog, undefined);
    assert.strictEqual(harness.paramDefaults.dlna_bridge_open_catalog, undefined);
    harness.loadAgain();
    assert.strictEqual(countParam(harness, 'dlna_bridge_open_catalog'), 1);
    assert.strictEqual(harness.state().initialized, false);
});

function verifyUncertainParamInitFailure(name, method, stage, hasValues, hasDefaults) {
    var harness = createHarness({
        appready: false,
        failParamInitStage: { name: name, method: method, stage: stage }
    });
    harness.emitReady();
    var callsBeforeRetry = method === 'select' ? harness.selectCalls() : harness.triggerCalls();

    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().registrations[method === 'select' ? 'serverUrlParam' : 'openCatalogParam'], 'uncertain');
    assert.strictEqual(countParam(harness, name), 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.paramValues, name), hasValues);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.paramDefaults, name), hasDefaults);

    // A new plugin evaluation and repeated app-ready signals must not repeat
    // addParam/Params initialization when SettingsApi only exposes the record.
    harness.loadAgain();
    harness.emitReady();
    harness.emitReady();
    harness.setAppReady(true);
    harness.loadAgain();

    assert.strictEqual(countParam(harness, name), 1);
    assert.strictEqual(method === 'select' ? harness.selectCalls() : harness.triggerCalls(), callsBeforeRetry);
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.state().initializing, false);
    assert.strictEqual(harness.state().loading, false);
}

test('keeps select registration uncertain when Params.select throws before values change', function () {
    verifyUncertainParamInitFailure('dlna_bridge_server_url', 'select', 'before', false, false);
});

test('keeps select registration uncertain when Params.select changes values but fails before defaults', function () {
    verifyUncertainParamInitFailure('dlna_bridge_server_url', 'select', 'partial', true, false);
});

test('keeps select registration uncertain when Params.select fails after full initialization', function () {
    verifyUncertainParamInitFailure('dlna_bridge_server_url', 'select', 'after', true, true);
});

test('keeps trigger registration uncertain when Params.trigger throws before values change', function () {
    verifyUncertainParamInitFailure('dlna_bridge_open_catalog', 'trigger', 'before', false, false);
});

test('keeps trigger registration uncertain when Params.trigger changes values but fails before defaults', function () {
    verifyUncertainParamInitFailure('dlna_bridge_open_catalog', 'trigger', 'partial', true, false);
});

test('keeps trigger registration uncertain when Params.trigger fails after full initialization', function () {
    verifyUncertainParamInitFailure('dlna_bridge_open_catalog', 'trigger', 'after', true, true);
});

test('uses fallback labels if Lampa.Lang is absent', function () {
    var harness = createHarness({ withoutLang: true });
    assertCoreRegistered(harness);
    assert.strictEqual(harness.params[0].field.name, 'Адрес DLNA-сервера');
});

test('uses fallback labels if Lampa.Lang.translate is absent or throws', function () {
    var absent = createHarness({ withoutTranslate: true });
    var throwing = createHarness({ failTranslate: true });
    assertCoreRegistered(absent);
    assertCoreRegistered(throwing);
    assert.strictEqual(absent.params[0].field.name, 'Адрес DLNA-сервера');
    assert.strictEqual(throwing.params[0].field.name, 'Адрес DLNA-сервера');
});

test('Lang.add failure is logged but does not falsely mark translations registered', function () {
    var harness = createHarness({ failLangAdd: true });
    assertCoreRegistered(harness);
    assert.strictEqual(harness.state().registrations.translations, 'uncertain');
    assert.strictEqual(harness.params[0].field.name, 'Адрес DLNA-сервера');
});

test('recovers when Lampa, SettingsApi, or Storage is absent on first load', function () {
    var withoutLampa = createHarness({ withoutLampa: true });
    var withoutSettings = createHarness({ withoutSettingsApi: true });
    var withoutStorage = createHarness({ withoutStorage: true });
    var cases = [withoutLampa, withoutSettings, withoutStorage];
    var i;
    for (i = 0; i < cases.length; i++) {
        assert.strictEqual(cases[i].state().initialized, undefined);
        assert.strictEqual(cases[i].state().loading, false);
        cases[i].enableSettingsApi();
        cases[i].loadAgain();
        assertCoreRegistered(cases[i]);
    }
});

test('retries after Listener is missing at first load', function () {
    var harness = createHarness({ appready: false, withoutListener: true });
    assert.strictEqual(harness.state().registrations.appReadyListener, 'pending');
    assert.strictEqual(harness.state().loading, false);
    harness.enableListener();
    harness.loadAgain();
    harness.emitReady();
    assertCoreRegistered(harness);
});

test('does not retry Listener.follow when it throws before subscription and leaves the result uncertain', function () {
    var harness = createHarness({ appready: false, followMode: 'before' });
    assert.strictEqual(harness.state().registrations.appReadyListener, 'uncertain');
    assert.strictEqual(harness.state().loading, false);
    assert.strictEqual(harness.readyHandlerCount(), 0);

    harness.loadAgain();
    assert.strictEqual(harness.followCalls(), 1);
    assert.strictEqual(harness.readyHandlerCount(), 0);
    harness.setAppReady(true);
    harness.loadAgain();
    assert.strictEqual(harness.state().initialized, true);
});

test('does not duplicate Listener.follow when it throws after subscription', function () {
    var harness = createHarness({ appready: false, followMode: 'after' });
    assert.strictEqual(harness.state().registrations.appReadyListener, 'uncertain');
    assert.strictEqual(harness.readyHandlerCount(), 1);

    harness.loadAgain();
    assert.strictEqual(harness.followCalls(), 1);
    assert.strictEqual(harness.readyHandlerCount(), 1);
    harness.emitReady();
    assertCoreRegistered(harness);
    harness.emitReady();
    assert.strictEqual(harness.components.length, 1);
});

test('repeated app ready events do not duplicate core registrations', function () {
    var harness = createHarness({ appready: false });
    harness.emitReady();
    harness.emitReady();
    assertCoreRegistered(harness);
    assert.strictEqual(harness.readyHandlerCount(), 1);
});

test('does not duplicate registrations on a successful repeated load', function () {
    var harness = createHarness();
    harness.loadAgain();
    assertCoreRegistered(harness);
    assert.strictEqual(harness.componentCalls(), 1);
});

test('keeps AndroidJS diagnostic registration optional', function () {
    var harness = createHarness({ failParamBefore: 'dlna_bridge_androidjs_diag' });
    assertCoreRegistered(harness);
    assert.strictEqual(harness.state().registrations.androidDiagnosticParam, 'pending');
});

test('keeps core initialization successful when AndroidJS is inserted before its registration throws', function () {
    var harness = createHarness({ failParamAfter: 'dlna_bridge_androidjs_diag' });
    assertCoreRegistered(harness);
    assert.strictEqual(harness.state().registrations.androidDiagnosticParam, 'uncertain');
    assert.strictEqual(countParam(harness, 'dlna_bridge_androidjs_diag'), 1);
    harness.loadAgain();
    assert.strictEqual(countParam(harness, 'dlna_bridge_androidjs_diag'), 1);
    assert.strictEqual(harness.state().initialized, true);
});

test('uses the 0.6.0 component label', function () {
    var harness = createHarness();
    assert.strictEqual(harness.components[0].name, 'DLNA Bridge 0.6.0');
});

test('migrates a legacy true guard without duplicating existing settings registrations', function () {
    var names = [
        'dlna_bridge_server_url',
        'dlna_bridge_open_catalog',
        'dlna_bridge_clear_cache',
        'dlna_bridge_androidjs_diag'
    ];
    var harness = createHarness({
        initialGuard: true,
        existingComponent: true,
        existingParams: names,
        existingPlayerClose: true
    });

    assert.strictEqual(typeof harness.guard(), 'object');
    assert.strictEqual(harness.guard().migratedFromBooleanGuard, true);
    assert.strictEqual(harness.guard().registrations.component, 'registered');
    assert.strictEqual(harness.guard().registrations.serverUrlParam, 'uncertain');
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.componentCalls(), 0);
    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.components.length, 1);
    names.forEach(function (name) { assert.strictEqual(countParam(harness, name), 1); });
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
});

test('recovers missing core settings after migrating a legacy true guard', function () {
    var harness = createHarness({
        initialGuard: true,
        existingComponent: true,
        existingPlayerClose: true
    });

    assertCoreRegistered(harness);
    assert.strictEqual(harness.componentCalls(), 0);
    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
});

test('replaces a legacy false guard and initializes normally', function () {
    var harness = createHarness({ initialGuard: false });
    assert.strictEqual(typeof harness.guard(), 'object');
    assertCoreRegistered(harness);
    assert.strictEqual(harness.playerFollowCalls(), 1);
});

test('creates a new guard when the guard is absent', function () {
    var harness = createHarness();
    assert.strictEqual(typeof harness.guard(), 'object');
    assertCoreRegistered(harness);
});

test('preserves a new-format guard object and does not repeat its registrations', function () {
    var guard = {
        registrations: {
            translations: 'registered',
            component: 'registered',
            serverUrlParam: 'registered',
            openCatalogParam: 'registered',
            clearCacheParam: 'registered',
            androidDiagnosticParam: 'registered',
            playerCloseListener: 'registered'
        }
    };
    var harness = createHarness({
        initialGuard: guard,
        existingComponent: true,
        existingParams: [
            'dlna_bridge_server_url',
            'dlna_bridge_open_catalog',
            'dlna_bridge_clear_cache',
            'dlna_bridge_androidjs_diag'
        ]
    });

    assert.strictEqual(harness.guard(), guard);
    assertCoreRegistered(harness);
    assert.strictEqual(harness.componentCalls(), 0);
    assert.strictEqual(harness.playerFollowCalls(), 0);
});

test('confirms missing Player.close subscription and retries once after follow throws before adding it', function () {
    var harness = createHarness({ playerFollowMode: 'before' });
    assert.strictEqual(harness.playerFollowCalls(), 2);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'registered');
    assertCoreRegistered(harness);
});

test('detects Player.close subscription after follow throws and does not subscribe twice', function () {
    var harness = createHarness({ playerFollowMode: 'after' });
    assert.strictEqual(harness.playerFollowCalls(), 1);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'registered');
    harness.loadAgain();
    assert.strictEqual(harness.playerFollowCalls(), 1);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
});

test('migrates a legacy true guard without an old Player.close handler and never adds a new one', function () {
    var harness = createHarness({ initialGuard: true, failParamBefore: 'dlna_bridge_clear_cache' });

    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.playerCloseHandlerCount(), 0);
    assert.strictEqual(harness.state().migratedFromBooleanGuard, true);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
    assert.strictEqual(harness.state().initialized, false);

    harness.loadAgain();
    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.playerCloseHandlerCount(), 0);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
    assert.strictEqual(harness.state().initialized, true);
});

test('preserves and receives close through the old handler after legacy guard migration', function () {
    var harness = createHarness({
        initialGuard: true,
        existingPlayerClose: true,
        failParamBefore: 'dlna_bridge_clear_cache'
    });
    var oldCallback = harness.playerCloseCallback(0);

    assert.strictEqual(typeof oldCallback, 'function');
    assert.strictEqual(harness.state().migratedFromBooleanGuard, true);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
    assert.strictEqual(harness.state().initialized, false);
    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);

    harness.loadAgain();
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
    assert.strictEqual(harness.playerFollowCalls(), 0);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);

    harness.closePlayer();
    assert.strictEqual(harness.playerCloseCallback(0), oldCallback);
    assert.strictEqual(harness.playerCloseCalls(), 1);
    assert.strictEqual(harness.playerFollowCalls(), 0);
});

test('restores the controller through Player.callback when no Player.close handler exists', function () {
    var harness = createHarness({ initialGuard: true });
    harness.play();
    harness.setActiveController('player');

    assert.strictEqual(harness.playerCloseHandlerCount(), 0);
    assert.doesNotThrow(function () { harness.closePlayer(); });
    assert.strictEqual(harness.activeController(), 'settings_component');
    assert.deepStrictEqual(harness.controllerToggles, ['settings_component']);
    assert.deepStrictEqual(harness.controllerToggleAttempts, ['settings_component']);
    assert.deepStrictEqual(harness.closeOrder, [
        'toggle:settings_component',
        'callback:done',
        'callback:cleared',
        'close:event'
    ]);
    assert.strictEqual(harness.playerCloseHandlerCount(), 0);
});

test('does not treat an unknown Controller.toggle target as a successful switch', function () {
    var harness = createHarness();

    harness.setActiveController('settings_component');
    assert.strictEqual(harness.enabledController().name, 'settings_component');
    assert.ok(harness.enabledController().controller);
    harness.toggleController('missing_controller');

    assert.strictEqual(harness.activeController(), 'settings_component');
    assert.deepStrictEqual(harness.controllerToggleAttempts, ['missing_controller']);
    assert.deepStrictEqual(harness.controllerToggles, []);
});

test('keeps Player.close pending after two confirmed pre-subscription failures and does not duplicate on reload', function () {
    var harness = createHarness({ playerFollowFailuresBefore: 2, failParamBefore: 'dlna_bridge_clear_cache' });

    assert.strictEqual(harness.playerFollowCalls(), 2);
    assert.strictEqual(harness.playerCloseHandlerCount(), 0);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'pending');
    assert.strictEqual(harness.state().initialized, false);

    harness.loadAgain();
    assert.strictEqual(harness.playerFollowCalls(), 3);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
    assert.strictEqual(harness.state().registrations.playerCloseListener, 'registered');
    assert.strictEqual(harness.state().initialized, true);
});

['absent', 'throws'].forEach(function (hasMode) {
    test('keeps Player.close uncertain when listener.has is ' + hasMode + ' and avoids another follow', function () {
        var harness = createHarness({
            playerFollowMode: 'after',
            playerHasMode: hasMode,
            failParamBefore: 'dlna_bridge_clear_cache'
        });

        assert.strictEqual(harness.playerFollowCalls(), 1);
        assert.strictEqual(harness.playerCloseHandlerCount(), 1);
        assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
        assert.strictEqual(harness.state().initialized, false);

        harness.loadAgain();
        assert.strictEqual(harness.playerFollowCalls(), 1);
        assert.strictEqual(harness.playerCloseHandlerCount(), 1);
        assert.strictEqual(harness.state().registrations.playerCloseListener, 'uncertain');
    });
});

test('reuses one Player.close callback and one subscription across repeated plugin loads', function () {
    var harness = createHarness();
    var callback = harness.playerCloseCallback(0);

    assert.strictEqual(typeof callback, 'function');
    assert.strictEqual(harness.playerFollowCalls(), 1);
    assert.strictEqual(harness.playerCallbacks.length, 1);
    assert.strictEqual(callback, harness.guardPlayerCloseHandler());

    harness.loadAgain();
    harness.loadAgain();
    harness.loadAgain();

    assert.strictEqual(harness.playerFollowCalls(), 1);
    assert.strictEqual(harness.playerCloseHandlerCount(), 1);
    assert.strictEqual(harness.playerCloseCallback(0), callback);
    assert.strictEqual(harness.playerCallbacks[0], callback);
    assert.strictEqual(harness.guardPlayerCloseHandler(), callback);
});
