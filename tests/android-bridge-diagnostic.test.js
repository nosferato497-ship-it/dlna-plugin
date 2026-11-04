var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function createDiagnosticHarness(globals, options) {
    options = options || {};
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
    var windowTarget = { Lampa: Lampa, appready: true };
    var document = { getElementById: function () { return null; } };
    var name;

    for (name in globals) {
        if (Object.prototype.hasOwnProperty.call(globals, name)) {
            Object.defineProperty(windowTarget, name, globals[name]);
        }
    }

    var window = options.windowProxy ? new Proxy(windowTarget, {
        getOwnPropertyDescriptor: function (target, property) {
            if (options.windowDescriptorThrows && property === 'AndroidJS') throw options.windowDescriptorThrows;
            return Object.getOwnPropertyDescriptor(target, property);
        }
    }) : windowTarget;

    var context = {
        window: window,
        Lampa: Lampa,
        document: document,
        console: { log: function () {} }
    };
    if (options.throwFunctionToString) {
        vm.runInNewContext('Function.prototype.toString = function () { throw "toString blocked"; };', context);
    }
    vm.runInNewContext(source, context);

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

test('reports AndroidJS API method presence, type, arity, and bounded source without calling methods', function () {
    var calls = { httpReq: 0, get: 0, getResp: 0, dump: 0 };
    var androidJs = {
        httpReq: function (url, callback) { calls.httpReq++; },
        get: function (key) { calls.get++; },
        getResp: function (id, name, callback) { calls.getResp++; },
        dump: function () { calls.dump++; }
    };
    var harness = createDiagnosticHarness({
        AndroidJS: { value: androidJs, enumerable: true, configurable: true }
    });

    var report = harness.run();
    assert(report.indexOf('httpReq: present; type=function; length=2; source=function (url, callback)') >= 0);
    assert(report.indexOf('get: present; type=function; length=1; source=function (key)') >= 0);
    assert(report.indexOf('getResp: present; type=function; length=3; source=function (id, name, callback)') >= 0);
    assert(report.indexOf('dump: present; type=function; length=0; source=function ()') >= 0);
    assert.deepStrictEqual(calls, { httpReq: 0, get: 0, getResp: 0, dump: 0 });
    assert(report.length <= 3000);
});

test('reports missing AndroidJS API methods without attempting to call them', function () {
    var harness = createDiagnosticHarness({
        AndroidJS: { value: {}, enumerable: true, configurable: true }
    });
    var report = harness.run();
    ['httpReq', 'get', 'getResp', 'dump'].forEach(function (name) {
        assert(report.indexOf(name + ': absent; type=undefined; length=unavailable; source=unavailable') >= 0);
    });
    assert(report.length <= 3000);
});

test('reports absent, undefined, and null AndroidJS globals and their unavailable methods', function () {
    var absent = createDiagnosticHarness({}).run();
    var undefinedGlobal = createDiagnosticHarness({
        AndroidJS: { value: undefined, enumerable: true, configurable: true }
    }).run();
    var nullGlobal = createDiagnosticHarness({
        AndroidJS: { value: null, enumerable: true, configurable: true }
    }).run();
    [absent, undefinedGlobal, nullGlobal].forEach(function (report) {
        ['httpReq', 'get', 'getResp', 'dump'].forEach(function (name) {
            assert(report.indexOf(name + ': absent; type=undefined; length=unavailable; source=unavailable') >= 0);
        });
        assert(report.length <= 3000);
    });
    assert(absent.indexOf('AndroidJS: отсутствует') >= 0);
    assert(undefinedGlobal.indexOf('AndroidJS: undefined') >= 0);
    assert(nullGlobal.indexOf('AndroidJS: null') >= 0);
});

test('inspects an AndroidJS function global without invoking it', function () {
    var calls = 0;
    function AndroidJS(argument) { calls++; }
    AndroidJS.get = function (key) {};
    var report = createDiagnosticHarness({
        AndroidJS: { value: AndroidJS, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('AndroidJS (function)') >= 0);
    assert(report.indexOf('get: present; type=function; length=1; source=function (key)') >= 0);
    assert.strictEqual(calls, 0);
});

test('finds methods at prototype depths one and two but not beyond two', function () {
    var calls = 0;
    var depthTwo = { getResp: function (id) { calls++; } };
    var depthOne = Object.create(depthTwo);
    var androidJs = Object.create(depthOne);
    depthOne.httpReq = function (url, callback) { calls++; };
    var report = createDiagnosticHarness({
        AndroidJS: { value: androidJs, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: present; type=function; length=2;') >= 0);
    assert(report.indexOf('getResp: present; type=function; length=1;') >= 0);
    assert(report.indexOf('get: absent; type=undefined;') >= 0);
    assert.strictEqual(calls, 0);
    assert(report.length <= 3000);

    var depthThree = Object.create(Object.create(Object.create({ dump: function () {} })));
    var limitedReport = createDiagnosticHarness({
        AndroidJS: { value: depthThree, enumerable: true, configurable: true }
    }).run();
    assert(limitedReport.indexOf('dump: absent; type=undefined;') >= 0);
});

test('limits traversal when a proxy reports itself as its prototype', function () {
    var cyclic;
    cyclic = new Proxy({}, {
        getPrototypeOf: function () { return cyclic; }
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: cyclic, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: absent; type=undefined;') >= 0);
    assert(report.length <= 3000);
});

test('reports non-function API values by type without coercing their objects', function () {
    var conversions = 0;
    var objectValue = {
        toString: function () { conversions++; throw new Error('toString must not run'); },
        valueOf: function () { conversions++; throw new Error('valueOf must not run'); }
    };
    var report = createDiagnosticHarness({
        AndroidJS: {
            value: { httpReq: 'text', get: 4, getResp: objectValue, dump: null },
            enumerable: true,
            configurable: true
        }
    }).run();

    assert(report.indexOf('httpReq: present; type=string; length=unavailable') >= 0);
    assert(report.indexOf('get: present; type=number; length=unavailable') >= 0);
    assert(report.indexOf('getResp: present; type=object; length=unavailable') >= 0);
    assert(report.indexOf('dump: present; type=null; length=unavailable') >= 0);
    assert.strictEqual(conversions, 0);
});

test('does not read AndroidJS method accessors', function () {
    var getterCalls = 0;
    var androidJs = {};
    Object.defineProperty(androidJs, 'httpReq', {
        get: function () { getterCalls++; throw new Error('method accessor must not be read'); }
    });
    var harness = createDiagnosticHarness({
        AndroidJS: { value: androidJs, enumerable: true, configurable: true }
    });

    var report = harness.run();
    assert(report.indexOf('httpReq: present; type=accessor (not read)') >= 0);
    assert.strictEqual(getterCalls, 0);
});

test('does not read method accessors found on a prototype', function () {
    var getterCalls = 0;
    var prototype = {};
    Object.defineProperty(prototype, 'dump', {
        get: function () { getterCalls++; throw new Error('prototype accessor must not run'); }
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: Object.create(prototype), enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('dump: present; type=accessor (not read)') >= 0);
    assert.strictEqual(getterCalls, 0);
});

test('does not invoke an accessor for function.length', function () {
    var getterCalls = 0;
    function method(argument) {}
    Object.defineProperty(method, 'length', {
        get: function () { getterCalls++; throw new Error('length accessor must not run'); },
        configurable: true
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: { httpReq: method }, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: present; type=function; length=unavailable;') >= 0);
    assert.strictEqual(getterCalls, 0);
});

test('handles a missing function.length descriptor', function () {
    var method = new Proxy(function (argument) {}, {
        getOwnPropertyDescriptor: function (target, property) {
            if (property === 'length') return undefined;
            return Object.getOwnPropertyDescriptor(target, property);
        }
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: { httpReq: method }, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: present; type=function; length=unavailable;') >= 0);
});

test('handles an exception while reading the function.length descriptor', function () {
    var method = new Proxy(function () {}, {
        getOwnPropertyDescriptor: function (target, property) {
            if (property === 'length') throw new Error('length descriptor failed');
            return Object.getOwnPropertyDescriptor(target, property);
        }
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: { httpReq: method }, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: present; type=function; length=unavailable;') >= 0);
});

test('contains Function.prototype.toString exceptions without calling the method', function () {
    var calls = 0;
    var method = function (argument) { calls++; };
    var report = createDiagnosticHarness({
        AndroidJS: { value: { httpReq: method }, enumerable: true, configurable: true }
    }, { throwFunctionToString: true }).run();

    assert(report.indexOf('httpReq: present; type=function; length=1; source=unavailable') >= 0);
    assert.strictEqual(calls, 0);
    assert(report.length <= 3000);
});

test('limits AndroidJS function source text and total report length', function () {
    var longMethod = new Function('value', 'return value;/*' + new Array(500).join('x') + '*/');
    var harness = createDiagnosticHarness({
        AndroidJS: { value: { httpReq: longMethod }, enumerable: true, configurable: true }
    });
    var report = harness.run();
    var expectedSource = longMethod.toString().slice(0, 177) + '...';

    assert.ok(report.indexOf(expectedSource) >= 0);
    assert.ok(expectedSource.length <= 180);
    assert.ok(report.length <= 3000);
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
    assert(report.indexOf('ошибка перечисления свойств') >= 0);
    assert(report.length <= 3000);
});

test('contains getPrototypeOf and getOwnPropertyDescriptor failures without converting thrown objects', function () {
    var conversions = 0;
    var thrown = {
        get message() { conversions++; throw new Error('message getter must not run'); },
        toString: function () { conversions++; throw new Error('toString must not run'); },
        valueOf: function () { conversions++; throw new Error('valueOf must not run'); }
    };
    var descriptorFailure = new Proxy({}, {
        getOwnPropertyDescriptor: function (target, property) {
            if (property === 'httpReq') throw thrown;
            return Object.getOwnPropertyDescriptor(target, property);
        }
    });
    var prototypeFailure = new Proxy({}, {
        getPrototypeOf: function () { throw thrown; }
    });
    var report = createDiagnosticHarness({
        AndroidJS: { value: descriptorFailure, enumerable: true, configurable: true },
        AndroidBridge: { value: prototypeFailure, enumerable: true, configurable: true }
    }).run();

    assert(report.indexOf('httpReq: inspection error (details omitted)') >= 0);
    assert(report.indexOf('прототип 1: ошибка получения прототипа') >= 0);
    assert(report.indexOf('Android:') >= 0);
    assert.strictEqual(conversions, 0);
    assert(report.length <= 3000);
});

test('contains a global getOwnPropertyDescriptor failure and continues the report', function () {
    var conversions = 0;
    var thrown = {
        get message() { conversions++; throw new Error('message getter must not run'); },
        toString: function () { conversions++; throw new Error('toString must not run'); }
    };
    var report = createDiagnosticHarness({}, {
        windowProxy: true,
        windowDescriptorThrows: thrown
    }).run();

    assert(report.indexOf('AndroidJS: ошибка доступа к дескриптору (подробности опущены)') >= 0);
    assert(report.indexOf('androidJS:') >= 0);
    assert.strictEqual(conversions, 0);
    assert(report.length <= 3000);
});

test('keeps the report within its 3000-character limit with repeated inspection failures', function () {
    var proxies = {};
    ['AndroidJS', 'androidJS', 'Android', 'AndroidBridge', 'WebViewBridge', 'JSInterface'].forEach(function (name) {
        proxies[name] = {
            value: new Proxy({}, {
                ownKeys: function () { throw new Error(new Array(1000).join('x')); },
                getPrototypeOf: function () { throw new Error(new Array(1000).join('y')); }
            }),
            enumerable: true,
            configurable: true
        };
    });
    var report = createDiagnosticHarness(proxies).run();
    assert(report.length <= 3000);
});

test('keeps the combined worst-case report within 3000 characters without running accessors or conversions', function () {
    var sideEffects = 0;
    var manyProperties = {};
    var i;
    for (i = 0; i < 120; i++) manyProperties['property' + i + '_' + new Array(80).join('n')] = i;
    var hostile = {
        get message() { sideEffects++; throw new Error('message getter must not run'); },
        toString: function () { sideEffects++; throw new Error('toString must not run'); },
        valueOf: function () { sideEffects++; throw new Error('valueOf must not run'); }
    };
    var androidJs = manyProperties;
    androidJs.httpReq = new Function('a', 'b', 'return a;/*' + new Array(600).join('x') + '*/');
    Object.defineProperty(androidJs, 'get', {
        get: function () { sideEffects++; throw new Error('method getter must not run'); }
    });
    androidJs.getResp = hostile;
    function dump() {}
    Object.defineProperty(dump, 'length', {
        get: function () { sideEffects++; throw new Error('length getter must not run'); },
        configurable: true
    });
    androidJs.dump = dump;

    var props = {
        AndroidJS: { value: androidJs, enumerable: true, configurable: true },
        Android: {
            value: new Proxy({}, {
                ownKeys: function () { throw hostile; },
                getPrototypeOf: function () { throw hostile; }
            }),
            enumerable: true,
            configurable: true
        },
        AndroidBridge: {
            value: new Proxy({}, {
                ownKeys: function () { return ['hidden']; },
                getOwnPropertyDescriptor: function () { throw hostile; }
            }),
            enumerable: true,
            configurable: true
        },
        WebViewBridge: { value: manyProperties, enumerable: true, configurable: true },
        JSInterface: {
            get: function () { sideEffects++; throw new Error('global getter must not run'); },
            configurable: true
        }
    };
    var report = createDiagnosticHarness(props).run();

    assert(report.length <= 3000);
    assert(report.indexOf('... отчёт сокращён') >= 0);
    assert.strictEqual(sideEffects, 0);
});
