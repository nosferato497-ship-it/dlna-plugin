var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function createDiagnosticHarness(globals) {
    var params = [];
    var notices = [];
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
    var Lampa = {
        SettingsApi: {
            addComponent: function () {},
            addParam: function (param) { params.push(param); }
        },
        Storage: { field: function () { return ''; } },
        Lang: {
            add: function () {},
            translate: function (key) { return key; }
        },
        Player: {},
        Noty: { show: function (message) { notices.push(message); } }
    };
    var window = { Lampa: Lampa, appready: true };
    var document = { getElementById: function () { return null; } };
    var name;

    for (name in globals) {
        if (Object.prototype.hasOwnProperty.call(globals, name)) {
            Object.defineProperty(window, name, globals[name]);
        }
    }

    vm.runInNewContext(source, {
        window: window,
        Lampa: Lampa,
        document: document,
        console: { log: function () {} }
    });

    return {
        params: params,
        notices: notices,
        run: function () {
            var i;
            for (i = 0; i < params.length; i++) {
                if (params[i].param && params[i].param.name === 'dlna_bridge_androidjs_diag') {
                    params[i].onChange();
                    return notices[notices.length - 1];
                }
            }
            throw new Error('AndroidJS diagnostic setting was not registered');
        }
    };
}

test('adds a settings action and reports known bridge properties without invoking them', function () {
    var methodCalls = 0;
    var getterCalls = 0;
    var prototype = {
        inheritedMethod: function () { methodCalls++; }
    };
    var androidJs = Object.create(prototype);
    androidJs.safeMethod = function () { methodCalls++; };
    Object.defineProperty(androidJs, 'lazyValue', {
        get: function () { getterCalls++; return 'secret'; }
    });

    var globals = {
        AndroidJS: { value: androidJs, enumerable: true, configurable: true },
        Android: {
            get: function () { getterCalls++; throw new Error('must not read global accessor'); },
            configurable: true
        },
        UnlistedBridge: { value: { hidden: true }, enumerable: true, configurable: true }
    };
    var harness = createDiagnosticHarness(globals);
    var setting;
    var i;
    for (i = 0; i < harness.params.length; i++) {
        if (harness.params[i].param && harness.params[i].param.name === 'dlna_bridge_androidjs_diag') {
            setting = harness.params[i];
        }
    }

    assert(setting, 'dedicated AndroidJS setting is registered');
    assert.strictEqual(setting.field.name, 'dlna_bridge_androidjs');
    var report = harness.run();
    assert(report.indexOf('AndroidJS (object)') >= 0);
    assert(report.indexOf('safeMethod: function') >= 0);
    assert(report.indexOf('lazyValue: accessor (не прочитан)') >= 0);
    assert(report.indexOf('inheritedMethod: function') >= 0);
    assert(report.indexOf('Android: accessor глобального свойства (не прочитан)') >= 0);
    assert.strictEqual(report.indexOf('UnlistedBridge'), -1);
    assert.strictEqual(methodCalls, 0);
    assert.strictEqual(getterCalls, 0);
    assert(report.length <= 3000);
});

test('contains inspection errors and bounds long property lists', function () {
    var manyProperties = {};
    var i;
    for (i = 0; i < 100; i++) manyProperties['method' + i] = function () {};
    var throwingProxy = new Proxy({}, {
        ownKeys: function () { throw new Error('ownKeys failed'); }
    });
    var harness = createDiagnosticHarness({
        AndroidJS: { value: manyProperties, enumerable: true, configurable: true },
        AndroidBridge: { value: throwingProxy, enumerable: true, configurable: true }
    });

    var report;
    assert.doesNotThrow(function () { report = harness.run(); });
    assert(report.indexOf('ещё свойств: 88') >= 0);
    assert(report.indexOf('ошибка перечисления: ownKeys failed') >= 0);
    assert(report.length <= 3000);
});
