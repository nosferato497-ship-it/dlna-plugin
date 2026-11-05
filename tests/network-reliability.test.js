var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function decodeXml(value) {
    return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function makeXmlNode(name, attributes, nodeType, text) {
    var node = {
        nodeName: name,
        localName: name.split(':').pop(),
        nodeType: nodeType,
        textContent: text || '',
        childNodes: [],
        getAttribute: function (attribute) {
            return attributes[attribute] === undefined ? null : attributes[attribute];
        },
        getElementsByTagName: function (tag) {
            var found = [];
            function visit(parent) {
                var i;
                for (i = 0; i < parent.childNodes.length; i++) {
                    var child = parent.childNodes[i];
                    if (child.nodeType === 1 && (tag === '*' || child.nodeName === tag || child.localName === tag)) found.push(child);
                    if (child.nodeType === 1) visit(child);
                }
            }
            visit(node);
            return found;
        }
    };
    return node;
}

function TestDOMParser() {}
TestDOMParser.prototype.parseFromString = function (source) {
    var documentNode = { childNodes: [], documentElement: null };
    var stack = [documentNode];
    var tokenPattern = /<\?[^>]*\?>|<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g;
    var tokens = String(source).match(tokenPattern) || [];
    var i;
    for (i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        if (token.indexOf('<?') === 0 || token.indexOf('<!--') === 0 || token.indexOf('<!') === 0) continue;
        if (token.indexOf('</') === 0) {
            if (stack.length > 1) stack.pop();
        } else if (token.charAt(0) === '<') {
            var selfClosing = /\/>$/.test(token);
            var content = token.substring(1, token.length - (selfClosing ? 2 : 1));
            var match = /^([^\s]+)([\s\S]*)$/.exec(content);
            if (!match) continue;
            var attributes = {};
            var attributePattern = /([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/g;
            var attributeMatch;
            while ((attributeMatch = attributePattern.exec(match[2]))) {
                attributes[attributeMatch[1]] = decodeXml(attributeMatch[3]);
            }
            var element = makeXmlNode(match[1], attributes, 1, '');
            stack[stack.length - 1].childNodes.push(element);
            if (!documentNode.documentElement) documentNode.documentElement = element;
            if (!selfClosing) stack.push(element);
        } else {
            var text = decodeXml(token);
            if (stack.length > 1) {
                var textNode = makeXmlNode('#text', {}, 3, text);
                stack[stack.length - 1].childNodes.push(textNode);
                stack[stack.length - 1].textContent += text;
            }
        }
    }
    documentNode.getElementsByTagName = function (tag) {
        var found = [];
        function visit(parent) {
            var j;
            for (j = 0; j < parent.childNodes.length; j++) {
                var child = parent.childNodes[j];
                if (child.nodeType === 1 && (tag === '*' || child.nodeName === tag || child.localName === tag)) found.push(child);
                if (child.nodeType === 1) visit(child);
            }
        }
        visit(documentNode);
        return found;
    };
    return documentNode;
};

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function soapResponse(didl, total, extra) {
    return '<s:Envelope><s:Body>' + (extra || '') + '<u:BrowseResponse>' +
        '<Result>' + escapeXml(didl || '') + '</Result><TotalMatches>' + total +
        '</TotalMatches><UpdateID>7</UpdateID></u:BrowseResponse></s:Body></s:Envelope>';
}

function soapResponseWithUpdate(didl, total, updateMarkup) {
    return '<s:Envelope><s:Body><u:BrowseResponse>' +
        '<Result>' + escapeXml(didl || '') + '</Result><TotalMatches>' + total +
        '</TotalMatches>' + updateMarkup + '</u:BrowseResponse></s:Body></s:Envelope>';
}

function soapResponseWithoutTotal(didl) {
    return '<s:Envelope><s:Body><u:BrowseResponse><Result>' + escapeXml(didl || '') +
        '</Result><UpdateID>7</UpdateID></u:BrowseResponse></s:Body></s:Envelope>';
}

function makeFolders(count, prefix) {
    var entries = [];
    var i;
    for (i = 0; i < count; i++) entries.push({ id: (prefix || 'f') + i, title: 'Folder ' + i, isFolder: true });
    return entries;
}

function createListener() {
    var handlers = {};
    return {
        follow: function (type, callback) {
            var names = type.split(',');
            var i;
            for (i = 0; i < names.length; i++) {
                var name = names[i];
                if (!handlers[name]) handlers[name] = [];
                if (handlers[name].indexOf(callback) < 0) handlers[name].push(callback);
            }
        },
        has: function (type, callback) {
            return !!(handlers[type] && handlers[type].indexOf(callback) >= 0);
        },
        remove: function (type, callback) {
            if (!handlers[type]) return;
            var index = handlers[type].indexOf(callback);
            if (index >= 0) handlers[type].splice(index, 1);
        },
        send: function (type, event) {
            var list = handlers[type] ? handlers[type].slice(0) : [];
            var i;
            for (i = 0; i < list.length; i++) list[i](event || {});
        },
        count: function (type) { return handlers[type] ? handlers[type].length : 0; }
    };
}

function didl(entries) {
    var xml = '<DIDL-Lite>';
    entries.forEach(function (entry) {
        if (entry.isFolder) {
            xml += '<container id="' + entry.id + '" parentID="0" childCount="0"><dc:title>' + entry.title + '</dc:title></container>';
        } else {
            xml += '<item id="' + entry.id + '" parentID="0"><dc:title>' + entry.title + '</dc:title>' +
                '<res protocolInfo="http-get:*:video/mp4:*">' + entry.url + '</res></item>';
        }
    });
    return xml + '</DIDL-Lite>';
}

// DOM used only when the production capability check chooses fallback.
function fallbackDom() {
    var listeners = { keydown: [], keyup: [] };
    var dom = {};
    function element(tag) {
        return {
            tag: tag, style: {}, children: [], events: {}, parentNode: null,
            appendChild: function (child) { this.children.push(child); child.parentNode = this; },
            removeChild: function (child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
            addEventListener: function (type, callback) { this.events[type] = callback; },
            focus: function () { dom.document.activeElement = this; if (this.events.focus) this.events.focus(); },
            scrollIntoView: function () {}
        };
    }
    function all(node) {
        var result = [node];
        node.children.forEach(function (child) { result = result.concat(all(child)); });
        return result;
    }
    dom.document = {
        body: element('body'), activeElement: null, createElement: element,
        getElementById: function (id) { return all(this.body).filter(function (node) { return node.id === id; })[0] || null; }
    };
    dom.add = function (type, callback) { listeners[type].push(callback); };
    dom.remove = function (type, callback) { listeners[type] = listeners[type].filter(function (item) { return item !== callback; }); };
    dom.key = function (key) {
        listeners.keydown.slice().forEach(function (callback) {
            callback({ key: key, preventDefault: function () {}, stopPropagation: function () {}, stopImmediatePropagation: function () {} });
        });
    };
    dom.count = function (type) { return listeners[type].length; };
    dom.overlay = function () { return dom.document.getElementById('dlna-bridge-menu'); };
    dom.buttons = function () { return all(dom.document.body).filter(function (node) { return node.tag === 'button'; }); };
    return dom;
}

function createHarness(options) {
    options = options || {};
    var requests = [];
    var timers = [];
    var nextTimer = 0;
    var dom = fallbackDom();
    var selects = [];
    var played = [];
    var notices = [];
    var parserCalls = 0;
    function HarnessDOMParser() { parserCalls++; }
    HarnessDOMParser.prototype.parseFromString = TestDOMParser.prototype.parseFromString;
    var settingsListener = createListener();
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
    source = source.replace(
        'if (window.appready) init();',
        'window.__test = { init: init, requestNative: requestNative, soapBrowse: soapBrowse, browseAll: browseAll, showFolder: showFolder, openCatalog: openLegacyCatalog, play: play, cache: cache, closeMenu: function () { if (activeMenuClose) activeMenuClose(); }, menuCloser: function () { return activeMenuClose; }, browseGeneration: function () { return browseToken; } }; if (window.appready) init();'
    );

    function Reguest() {
        if (options.constructorThrows) throw options.constructorThrows;
        this.timeout = function (value) { this.timeoutValue = value; };
        this.clear = function () {
            this.cleared = true;
            if (options.clearThrows) throw new Error('clear failed');
        };
        this.native = function (url, success, failure, body, params) {
            if (options.nativeThrows) throw options.nativeThrows;
            if (options.nativeFailureThenThrows) {
                failure({ status: 0 }, 'timeout');
                throw new Error('native threw after failure callback');
            }
            if (options.nativeSuccessThenThrows) {
                success('ok');
                throw new Error('native threw after success callback');
            }
            requests.push({ url: url, success: success, failure: failure, body: body, params: params, request: this });
        };
    }

    var controllerName = 'settings_component';
    var Lampa = {
        Reguest: options.withoutReguest ? null : Reguest,
        Storage: { field: function () { return ''; } },
        SettingsApi: { addComponent: function () {}, addParam: function () {} },
        Lang: { add: function () {}, translate: function (value) { return value; } },
        Listener: { follow: function () {} },
        Settings: { listener: settingsListener },
        Controller: {
            enabled: function () { return { name: controllerName }; },
            toggle: function (name) { controllerName = name; },
            add: function () {},
            windowOpen: function () {},
            windowClose: function () {},
            collectionSet: function () {},
            collectionFocus: function () {}
        },
        Select: { opened: function () { return true; }, close: function () {}, show: function (config) { selects.push(config); } },
        Player: { listener: createListener(), play: function (entry) { played.push(entry); }, callback: function () {} },
        Noty: { show: function (message) { notices.push(message); } }
    };
    if (Object.prototype.hasOwnProperty.call(options, 'opened')) Lampa.Select.opened = options.opened;
    var window = { Lampa: Lampa, appready: false, $: function (value) { return value; }, DOMParser: HarnessDOMParser,
        addEventListener: dom.add, removeEventListener: dom.remove };
    var document = dom.document;
    var context = {
        window: window,
        Lampa: Lampa,
        document: document,
        DOMParser: HarnessDOMParser,
        console: { log: function () {}, error: function () {} },
        setTimeout: function (callback, delay) { var id = ++nextTimer; timers.push({ callback: callback, delay: delay, id: id }); return id; },
        clearTimeout: function (id) {
            var i;
            for (i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1);
        }
    };
    vm.runInNewContext(source, context);
    window.__test.init();

    function popRequest() {
        assert.ok(requests.length, 'expected a pending request');
        return requests.shift();
    }

    function takeRequest(index) {
        return index === undefined ? popRequest() : requests.splice(index, 1)[0];
    }

    return {
        requests: requests,
        dom: dom,
        timers: timers,
        selects: selects,
        played: played,
        notices: notices,
        settingsListener: settingsListener,
        playerListener: Lampa.Player.listener,
        parserCalls: function () { return parserCalls; },
        Lampa: Lampa,
        test: window.__test,
        respond: function (xml, index) { takeRequest(index).success(xml); },
        reject: function (xhr, error, index) { takeRequest(index).failure(xhr, error); },
        runTimer: function () { var timer = timers.shift(); assert.ok(timer, 'expected a retry timer'); timer.callback(); return timer.delay; },
        popRequest: popRequest
    };
}

test('uses native text transport for successful Browse and parses SOAP Fault without changing request format', function () {
    var harness = createHarness();
    var result;
    harness.test.soapBrowse('0', 0, 200, function (items, total, update) { result = { items: items, total: total, update: update }; }, function (error) { throw error; });
    assert.strictEqual(harness.requests.length, 1);
    assert.strictEqual(harness.requests[0].url, 'http://192.168.1.1:8200/ctl/ContentDir');
    assert.strictEqual(harness.requests[0].params.dataType, 'text');
    assert.strictEqual(harness.requests[0].params.timeout, 20000);
    assert.strictEqual(harness.requests[0].request.timeoutValue, 20000);
    assert.ok(harness.requests[0].body.indexOf('<StartingIndex>0</StartingIndex>') >= 0);
    assert.strictEqual(harness.requests[0].params.headers['SOAPAction'], '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"');
    harness.respond(soapResponse(didl([{ id: 'folder', title: 'Folder', isFolder: true }]), 1));
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].isFolder, true);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.update, 7);

    var fault;
    harness.test.soapBrowse('0', 0, 200, function () { throw new Error('success must not run for Fault'); }, function (error) { fault = error; });
    harness.respond('<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>');
    assert.match(fault.message, /Denied/);
    assert.strictEqual(harness.requests.length, 0);
});

test('retries network timeout and reports the final error once', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('timeout', function (error) { if (error) errors.push(error); });
    harness.reject({ status: 0 }, 'timeout');
    harness.runTimer();
    harness.reject({ status: 0 }, 'timeout');
    harness.runTimer();
    harness.reject({ status: 0 }, 'timeout');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /timeout/);
    assert.strictEqual(harness.requests.length, 0);
});

test('retries a network failure and reports its HTTP status', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('http-error', function (error) { if (error) errors.push(error); });
    harness.reject({ status: 503 }, 'service unavailable');
    harness.runTimer();
    harness.reject({ status: 503 }, 'service unavailable');
    harness.runTimer();
    harness.reject({ status: 503 }, 'service unavailable');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /HTTP 503/);
});

test('delivers one error callback for synchronous Reguest construction and native exceptions', function () {
    var construction = createHarness({ constructorThrows: new Error('constructor failed') });
    var constructionErrors = 0;
    construction.test.requestNative('/test', null, {}, function () {}, function () { constructionErrors++; });
    assert.strictEqual(constructionErrors, 1);

    var native = createHarness({ nativeThrows: new Error('native failed') });
    var nativeErrors = 0;
    native.test.requestNative('/test', null, {}, function () {}, function () { nativeErrors++; });
    assert.strictEqual(nativeErrors, 1);
    assert.strictEqual(native.requests.length, 0);

    var afterError = createHarness({ nativeFailureThenThrows: true });
    var afterErrorCalls = 0;
    afterError.test.requestNative('/test', null, {}, function () {}, function () { afterErrorCalls++; });
    assert.strictEqual(afterErrorCalls, 1);

    var afterSuccess = createHarness({ nativeSuccessThenThrows: true });
    var successCalls = 0;
    var lateErrors = 0;
    afterSuccess.test.requestNative('/test', null, {}, function () { successCalls++; }, function () { lateErrors++; });
    assert.strictEqual(successCalls, 1);
    assert.strictEqual(lateErrors, 0);
});

test('ignores repeated native success and error callbacks', function () {
    var successHarness = createHarness();
    var successCalls = 0;
    var successErrors = 0;
    successHarness.test.requestNative('/repeat-success', null, {}, function () { successCalls++; }, function () { successErrors++; });
    var successRequest = successHarness.popRequest();
    successRequest.success('ok');
    successRequest.success('late');
    assert.strictEqual(successCalls, 1);
    assert.strictEqual(successErrors, 0);

    var errorHarness = createHarness();
    var errorCalls = 0;
    errorHarness.test.requestNative('/repeat-error', null, {}, function () {}, function () { errorCalls++; });
    var errorRequest = errorHarness.popRequest();
    errorRequest.failure({ status: 0 }, 'timeout');
    errorRequest.failure({ status: 0 }, 'second timeout');
    assert.strictEqual(errorCalls, 1);
});

test('swallows request cleanup errors and reports missing Reguest once', function () {
    var clearHarness = createHarness({ clearThrows: true });
    var successes = 0;
    var errors = 0;
    clearHarness.test.requestNative('/clear-throws', null, {}, function () { successes++; }, function () { errors++; });
    clearHarness.popRequest().success('ok');
    assert.strictEqual(successes, 1);
    assert.strictEqual(errors, 0);

    var missingHarness = createHarness({ withoutReguest: true });
    var missingErrors = 0;
    missingHarness.test.requestNative('/missing', null, {}, function () {}, function (error) {
        missingErrors++;
        assert.match(error.message, /Reguest недоступен/);
    });
    assert.strictEqual(missingErrors, 1);
});

test('does not cache an incomplete catalog after three empty pages with remaining matches', function () {
    var harness = createHarness();
    var error;
    harness.test.browseAll('empty', function (failure) { error = failure; });
    harness.respond(soapResponse('', 1));
    assert.strictEqual(harness.runTimer(), 700);
    harness.respond(soapResponse('', 1));
    assert.strictEqual(harness.runTimer(), 1400);
    harness.respond(soapResponse('', 1));
    assert.match(error.message, /пустую страницу/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'empty'), false);
});

test('does not treat a downstream callback exception as a SOAP parse failure or retry', function () {
    var harness = createHarness();
    var failureCalls = 0;
    harness.test.soapBrowse('callback-error', 0, 200, function () { throw new Error('UI callback failed'); }, function () { failureCalls++; });
    assert.throws(function () { harness.respond(soapResponse(didl([{ id: 'f', title: 'Folder', isFolder: true }]), 1)); }, /UI callback failed/);
    assert.strictEqual(failureCalls, 0);
    assert.strictEqual(harness.requests.length, 0);
});

test('does not retry Browse when its final downstream callback throws', function () {
    var harness = createHarness();
    harness.test.browseAll('downstream-throw', function () { throw new Error('catalog callback failed'); });
    assert.throws(function () {
        harness.respond(soapResponse(didl([{ id: 'one', title: 'One', isFolder: true }]), 1));
    }, /catalog callback failed/);
    assert.strictEqual(harness.timers.length, 0);
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(harness.test.cache['downstream-throw'].length, 1);
});

test('ignores late responses from overlapping Browse calls and reopened catalog', function () {
    var harness = createHarness();
    harness.test.showFolder('first', 'First', []);
    harness.test.showFolder('second', 'Second', []);
    var older = harness.requests[0];
    var newer = harness.requests[1];
    newer.success(soapResponse(didl([{ id: 'new', title: 'New', isFolder: true }]), 1));
    var parserCallsBeforeStaleResponse = harness.parserCalls();
    older.success(soapResponse(didl([{ id: 'old', title: 'Old', isFolder: true }]), 1));
    assert.strictEqual(harness.parserCalls(), parserCallsBeforeStaleResponse);
    assert.strictEqual(harness.selects.length, 1);
    assert.strictEqual(harness.selects[0].title, 'Second');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'first'), false);

    var reopen = createHarness();
    reopen.test.openCatalog();
    var stale = reopen.requests[0];
    reopen.test.openCatalog();
    var current = reopen.requests[1];
    stale.success(soapResponse(didl([{ id: 'stale', title: 'Stale', isFolder: true }]), 1));
    assert.strictEqual(reopen.selects.length, 0);
    current.success(soapResponse(didl([{ id: 'current', title: 'Current', isFolder: true }]), 1));
    assert.strictEqual(reopen.selects.length, 1);
    assert.ok(reopen.selects[0].title.indexOf('DLNA') === 0);

    var closed = createHarness();
    closed.test.showFolder('closed-menu', 'Closed menu', []);
    var closedRequest = closed.requests[0];
    // Real Settings sends open{name: 'main'} when settings_component backs out to Settings.
    closed.settingsListener.send('open', { name: 'main' });
    closed.test.openCatalog();
    var reopenedRequest = closed.requests[1];
    closedRequest.success(soapResponse(didl([{ id: 'late', title: 'Late', isFolder: true }]), 1));
    assert.strictEqual(closed.selects.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(closed.test.cache, 'closed-menu'), false);
    reopenedRequest.success(soapResponse(didl([{ id: 'fresh', title: 'Fresh', isFolder: true }]), 1));
    assert.strictEqual(closed.selects.length, 1);
});

test('invalidates Browse through the Settings lifecycle when leaving the DLNA settings component', function () {
    var harness = createHarness();
    assert.strictEqual(harness.settingsListener.count('open'), 1);
    assert.strictEqual(harness.settingsListener.count('close'), 1);
    harness.test.showFolder('pending-settings-exit', 'Pending', []);
    var staleRequest = harness.popRequest();

    // Mirrors Settings Component.back() -> Controller.toggle('settings') -> Settings.listener.send('open', {name:'main'}).
    harness.settingsListener.send('open', { name: 'main' });
    staleRequest.success(soapResponse(didl([{ id: 'late', title: 'Late', isFolder: true }]), 1));
    assert.strictEqual(harness.selects.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'pending-settings-exit'), false);

    harness.test.openCatalog();
    var freshRequest = harness.popRequest();
    freshRequest.success(soapResponse(didl([{ id: 'fresh', title: 'Fresh', isFolder: true }]), 1));
    assert.strictEqual(harness.selects.length, 1);

    var closedSettings = createHarness();
    closedSettings.test.showFolder('pending-settings-close', 'Pending close', []);
    var closeRequest = closedSettings.popRequest();
    closedSettings.settingsListener.send('close');
    closeRequest.success(soapResponse(didl([{ id: 'late', title: 'Late', isFolder: true }]), 1));
    assert.strictEqual(closedSettings.selects.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(closedSettings.test.cache, 'pending-settings-close'), false);
});

test('folder navigation and Back remain valid without Settings lifecycle transitions', function () {
    var harness = createHarness();
    harness.test.showFolder('root', 'Root', []);
    harness.settingsListener.send('open', { name: 'dlna_bridge' });
    harness.popRequest().success(soapResponse(didl([{ id: 'child', title: 'Child', isFolder: true }]), 1));
    var rootSelect = harness.selects[harness.selects.length - 1];
    rootSelect.items[0].onSelect();
    harness.popRequest().success(soapResponse(didl([{ id: 'leaf', title: 'Leaf', isFolder: false, url: 'http://media/leaf' }]), 1));
    var childSelect = harness.selects[harness.selects.length - 1];
    childSelect.onBack();
    var parentSelect = harness.selects[harness.selects.length - 1];
    assert.strictEqual(parentSelect.title, 'Root');
    assert.strictEqual(harness.settingsListener.count('open'), 1);
    assert.strictEqual(harness.settingsListener.count('close'), 1);
});

test('preserves pagination and caches only the completed list', function () {
    var harness = createHarness();
    var result;
    var firstEntries = [];
    var i;
    for (i = 0; i < 200; i++) firstEntries.push({ id: 'f' + i, title: 'Folder ' + i, isFolder: true });
    harness.test.browseAll('paged', function (error, items) { if (!error) result = items; });
    assert.ok(harness.requests[0].body.indexOf('<RequestedCount>200</RequestedCount>') >= 0);
    harness.respond(soapResponse(didl(firstEntries), 201));
    assert.strictEqual(harness.requests.length, 1);
    assert.strictEqual(harness.requests[0].body.indexOf('<StartingIndex>200</StartingIndex>') >= 0, true);
    harness.respond(soapResponse(didl([{ id: 'last', title: 'Last', isFolder: true }]), 201));
    assert.strictEqual(result.length, 201);
    assert.strictEqual(harness.test.cache.paged.length, 201);
    var cachedResult;
    harness.test.browseAll('paged', function (error, items) { if (!error) cachedResult = items; });
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(cachedResult.length, 201);
});

test('accepts identical UpdateID values across two pages and caches the complete catalog', function () {
    var harness = createHarness();
    var result;
    harness.test.browseAll('same-update-id', function (error, items) {
        assert.ifError(error);
        result = items;
    });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200)), 201, '<UpdateID>42</UpdateID>'));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(1, 'last')), 201, '<UpdateID>42</UpdateID>'));
    assert.strictEqual(result.length, 201);
    assert.strictEqual(harness.test.cache['same-update-id'].length, 201);
});

test('rejects UpdateID changes on page two without retrying or caching partial items', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('changed-update-two', function (error) { if (error) errors.push(error); });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200)), 201, '<UpdateID>42</UpdateID>'));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(1, 'last')), 201, '<UpdateID>43</UpdateID>'));
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /UpdateID/);
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(harness.timers.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'changed-update-two'), false);
});

test('rejects UpdateID changes on page three without caching a mixed catalog', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('changed-update-three', function (error) { if (error) errors.push(error); });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200, 'a')), 401, '<UpdateID>42</UpdateID>'));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200, 'b')), 401, '<UpdateID>42</UpdateID>'));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(1, 'c')), 401, '<UpdateID>44</UpdateID>'));
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /UpdateID/);
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(harness.timers.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'changed-update-three'), false);
});

test('allows all pages to omit UpdateID and documents that changes cannot then be detected', function () {
    var harness = createHarness();
    var result;
    harness.test.browseAll('no-update-id', function (error, items) {
        assert.ifError(error);
        result = items;
    });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200)), 201, ''));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(1, 'last')), 201, ''));
    assert.strictEqual(result.length, 201);
    assert.strictEqual(harness.test.cache['no-update-id'].length, 201);
});

test('rejects UpdateID presence on only one page and does not cache the partial catalog', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('partial-update-id', function (error) { if (error) errors.push(error); });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200)), 201, ''));
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(1, 'last')), 201, '<UpdateID>42</UpdateID>'));
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /UpdateID/);
    assert.strictEqual(harness.timers.length, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'partial-update-id'), false);
});

test('does not retry a present but empty or malformed UpdateID', function () {
    ['<UpdateID></UpdateID>', '<UpdateID>invalid</UpdateID>'].forEach(function (updateMarkup, index) {
        var harness = createHarness();
        var errors = [];
        var key = 'invalid-update-id-' + index;
        harness.test.browseAll(key, function (error) { if (error) errors.push(error); });
        harness.popRequest().success(soapResponseWithUpdate(didl([]), 0, updateMarkup));
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0].message, /UpdateID/);
        assert.strictEqual(harness.requests.length, 0);
        assert.strictEqual(harness.timers.length, 0);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, key), false);
    });
});

test('ignores repeated late callbacks after an UpdateID consistency error', function () {
    var harness = createHarness();
    var errors = [];
    var successCount = 0;
    harness.test.browseAll('late-update-callback', function (error) {
        if (error) errors.push(error);
        else successCount++;
    });
    harness.popRequest().success(soapResponseWithUpdate(didl(makeFolders(200)), 201, '<UpdateID>42</UpdateID>'));
    var secondRequest = harness.popRequest();
    secondRequest.success(soapResponseWithUpdate(didl(makeFolders(1, 'last')), 201, '<UpdateID>43</UpdateID>'));
    secondRequest.success(soapResponseWithUpdate(didl(makeFolders(1, 'late')), 201, '<UpdateID>42</UpdateID>'));
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(successCount, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'late-update-callback'), false);
});

test('caches an empty catalog when TotalMatches is zero', function () {
    var harness = createHarness();
    var result;
    harness.test.browseAll('zero-total', function (error, items) {
        assert.ifError(error);
        result = items;
    });
    assert.strictEqual(harness.requests.length, 1);
    assert.ok(harness.requests[0].body.indexOf('<StartingIndex>0</StartingIndex>') >= 0);
    harness.popRequest().success(soapResponse(didl([]), 0));
    assert.strictEqual(result.length, 0);
    assert.strictEqual(harness.test.cache['zero-total'].length, 0);
    harness.test.browseAll('zero-total', function (error, items) { assert.ifError(error); result = items; });
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(result.length, 0);
});

test('completes and caches exactly 200 objects in one page', function () {
    var harness = createHarness();
    var result;
    harness.test.browseAll('exactly-200', function (error, items) { assert.ifError(error); result = items; });
    var request = harness.popRequest();
    assert.ok(request.body.indexOf('<StartingIndex>0</StartingIndex>') >= 0);
    assert.ok(request.body.indexOf('<RequestedCount>200</RequestedCount>') >= 0);
    request.success(soapResponse(didl(makeFolders(200)), 200));
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(result.length, 200);
    assert.strictEqual(harness.test.cache['exactly-200'].length, 200);
});

test('completes and caches exactly 5000 objects across 25 complete pages', function () {
    var harness = createHarness();
    var result;
    var page;
    harness.test.browseAll('exactly-5000', function (error, items) { assert.ifError(error); result = items; });
    for (page = 0; page < 25; page++) {
        var request = harness.popRequest();
        assert.ok(request.body.indexOf('<StartingIndex>' + (page * 200) + '</StartingIndex>') >= 0);
        assert.ok(request.body.indexOf('<RequestedCount>200</RequestedCount>') >= 0);
        request.success(soapResponse(didl(makeFolders(200, 'p' + page + '-')), 5000));
    }
    assert.strictEqual(harness.requests.length, 0);
    assert.strictEqual(result.length, 5000);
    assert.strictEqual(harness.test.cache['exactly-5000'].length, 5000);
});

test('uses returned DIDL object count for offsets when an untitled entry is filtered from display', function () {
    var harness = createHarness();
    var firstPage = makeFolders(200);
    firstPage[17].title = '';
    var result;
    harness.test.browseAll('filtered-title', function (error, items) { if (!error) result = items; });
    harness.popRequest().success(soapResponse(didl(firstPage), 201));
    assert.strictEqual(harness.requests.length, 1);
    assert.ok(harness.requests[0].body.indexOf('<StartingIndex>200</StartingIndex>') >= 0);
    harness.popRequest().success(soapResponse(didl(makeFolders(1, 'last')), 201));
    assert.strictEqual(result.length, 200);
    assert.strictEqual(harness.test.cache['filtered-title'].length, 200);
});

test('rejects missing, empty, NaN, and malformed TotalMatches without caching', function () {
    var cases = [
        { label: 'NaN', xml: soapResponse('', 'NaN') },
        { label: 'empty', xml: soapResponse('', '') },
        { label: 'missing', xml: soapResponseWithoutTotal('') },
        { label: 'malformed', xml: soapResponse('', 'not-a-number') },
        { label: 'negative', xml: soapResponse('', '-1') },
        { label: 'fractional', xml: soapResponse('', '1.5') },
        { label: 'infinite', xml: soapResponse('', 'Infinity') }
    ];
    cases.forEach(function (scenario) {
        var harness = createHarness();
        var errors = [];
        harness.test.browseAll('invalid-' + scenario.label, function (error) { if (error) errors.push(error); });
        harness.respond(scenario.xml);
        harness.runTimer();
        harness.respond(scenario.xml);
        harness.runTimer();
        harness.respond(scenario.xml);
        assert.strictEqual(errors.length, 1, scenario.label + ' should fail once');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'invalid-' + scenario.label), false);
    });
});

test('does not cache a partial catalog when the unchanged 5000-item safety cap is reached', function () {
    var harness = createHarness();
    var errors = [];
    harness.test.browseAll('over-limit', function (error) { if (error) errors.push(error); });
    var page;
    for (page = 0; page < 25; page++) {
        var request = harness.popRequest();
        assert.ok(request.body.indexOf('<StartingIndex>' + (page * 200) + '</StartingIndex>') >= 0);
        request.success(soapResponse(didl(makeFolders(200, 'p' + page + '-')), 5001));
    }
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /превышает лимит/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'over-limit'), false);
});

test('rejects decreases and increases in TotalMatches between pages without caching', function () {
    var changes = [200, 202];
    changes.forEach(function (changedTotal) {
        var harness = createHarness();
        var errors = [];
        harness.test.browseAll('changed-' + changedTotal, function (error) { if (error) errors.push(error); });
        harness.popRequest().success(soapResponse(didl(makeFolders(200)), 201));
        assert.strictEqual(harness.requests.length, 1);
        harness.popRequest().success(soapResponse(didl([{ id: 'last', title: 'Last', isFolder: true }]), changedTotal));
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0].message, /TotalMatches изменился/);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'changed-' + changedTotal), false);
    });
});

test('does not cache page one after a page two network or SOAP failure', function () {
    ['network', 'soap'].forEach(function (kind) {
        var harness = createHarness();
        var errors = [];
        harness.test.browseAll('page-two-' + kind, function (error) { if (error) errors.push(error); });
        harness.popRequest().success(soapResponse(didl(makeFolders(200)), 201));
        assert.strictEqual(harness.requests.length, 1);
        if (kind === 'network') harness.reject({ status: 0 }, 'timeout');
        else harness.respond('<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>');
        harness.runTimer();
        if (kind === 'network') harness.reject({ status: 0 }, 'timeout');
        else harness.respond('<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>');
        harness.runTimer();
        if (kind === 'network') harness.reject({ status: 0 }, 'timeout');
        else harness.respond('<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>');
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.test.cache, 'page-two-' + kind), false);
    });
});

test('passes the original DIDL resource URL to Lampa.Player.play without fetching it', function () {
    var harness = createHarness();
    var url = 'http://media.example/video%20name.mp4?token=keep%2Fexact';
    harness.test.play({ url: url, title: 'Video' });
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, url);
    assert.strictEqual(harness.requests.length, 0);
});

// Native Select lifecycle: callbacks remain callable even after their menu is hidden.
function navigationHarness() {
    var harness = createHarness();
    var originalShow = harness.Lampa.Select.show;
    harness.nativeVisible = false;
    harness.Lampa.Select.opened = function () { return harness.nativeVisible; };
    harness.Lampa.Select.show = function (config) {
        harness.nativeVisible = true;
        originalShow(config);
        harness.Lampa.Controller.toggle('select');
    };
    harness.currentMenu = function () { return harness.selects[harness.selects.length - 1]; };
    harness.ok = function (menu, index) {
        // Native Select hides before dispatching the selected item's callback.
        harness.nativeVisible = false;
        harness.Lampa.Controller.toggle('settings_component');
        menu.items[index || 0].onSelect();
    };
    harness.folderResponse = function (request, entries) {
        request.success(soapResponse(didl(entries), entries.length));
    };
    harness.test.showFolder('0', 'Root', []);
    var root = harness.popRequest();
    assert.match(root.body, /<ObjectID>0<\/ObjectID>/);
    harness.folderResponse(root, [{ id: 'A', title: 'A', isFolder: true }]);
    return harness;
}

function enterFolderA(harness) {
    harness.ok(harness.currentMenu());
    var request = harness.popRequest();
    assert.match(request.body, /<ObjectID>A<\/ObjectID>/);
    harness.folderResponse(request, [{ id: 'B', title: 'B', isFolder: true }]);
    return harness.currentMenu();
}

function videoEntries() {
    return [{ id: 'video', title: 'Video', url: 'http://media/video.mp4' }];
}

test('native Root -> A -> B -> Video preserves ObjectIDs, Back and playback', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    harness.ok(menuA);
    var requestB = harness.popRequest();
    assert.match(requestB.body, /<ObjectID>B<\/ObjectID>/);
    harness.folderResponse(requestB, videoEntries());
    var menuB = harness.currentMenu();
    assert.strictEqual(menuB.title, 'B');
    harness.ok(menuB);
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://media/video.mp4');
    menuB.items[0].onSelect();
    menuB.onBack();
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.currentMenu(), menuB);
    // A freshly opened current menu still accepts a genuine user Back.
    harness.test.showFolder('B', 'B', [{ id: '0', title: 'Root' }, { id: 'A', title: 'A' }]);
    harness.currentMenu().onBack();
    assert.strictEqual(harness.currentMenu().title, 'A');
    harness.currentMenu().onBack();
    assert.strictEqual(harness.currentMenu().title, 'Root');
});

['before response', 'after response', 'cache'].forEach(function (timing) {
    test('native ignores old onBack after selection: ' + timing, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        if (timing === 'cache') harness.test.cache.B = videoEntries();
        harness.ok(menuA);
        var requestB = timing === 'cache' ? null : harness.popRequest();
        if (timing === 'before response') menuA.onBack();
        if (requestB) {
            assert.match(requestB.body, /<ObjectID>B<\/ObjectID>/);
            harness.folderResponse(requestB, videoEntries());
        }
        var menuB = harness.currentMenu();
        menuA.onBack();
        menuA.items[0].onSelect();
        assert.strictEqual(harness.currentMenu(), menuB);
        assert.strictEqual(menuB.title, 'B');
        assert.ok(harness.test.cache.B);
        assert.strictEqual(harness.requests.length, 0);
        // Stale callbacks must not clear the current menu's close handler.
        var closed = 0;
        harness.Lampa.Select.closeAll = function () { closed++; };
        harness.test.closeMenu();
        assert.strictEqual(closed, 1);
    });
});

test('native double onSelect creates one Browse and keeps its response current', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    harness.ok(menuA);
    menuA.items[0].onSelect();
    assert.strictEqual(harness.requests.length, 1);
    harness.folderResponse(harness.popRequest(), videoEntries());
    assert.strictEqual(harness.currentMenu().title, 'B');
});

test('native repeated Back runs parent navigation once and ignores old selections', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    menuA.onBack();
    var root = harness.currentMenu();
    menuA.onBack();
    menuA.items[0].onSelect();
    assert.strictEqual(harness.currentMenu(), root);
    assert.strictEqual(root.title, 'Root');
    assert.strictEqual(harness.requests.length, 0);
    harness.ok(root);
    assert.strictEqual(harness.currentMenu().title, 'A');
});

['close', 'closeAll'].forEach(function (method) {
    ['synchronous', 'delayed'].forEach(function (timing) {
        test('native programmatic ' + method + ' suppresses ' + timing + ' Back', function () {
            var harness = navigationHarness();
            var menuA = enterFolderA(harness);
            var queued;
            var closes = 0;
            harness.Lampa.Select[method] = function () {
                closes++;
                if (timing === 'synchronous') menuA.onBack();
                else queued = menuA.onBack;
            };
            var count = harness.selects.length;
            harness.test.closeMenu();
            harness.test.closeMenu();
            assert.strictEqual(closes, 1);
            assert.strictEqual(harness.selects.length, count);
            harness.test.showFolder('0', 'Root', []);
            var current = harness.currentMenu();
            if (queued) queued();
            menuA.items[0].onSelect();
            assert.strictEqual(harness.currentMenu(), current);
            assert.strictEqual(harness.requests.length, 0);
            assert.strictEqual(harness.played.length, 0);
            harness.test.closeMenu();
            assert.strictEqual(closes, 2);
        });
    });
});

['selection', 'back'].forEach(function (action) {
    test('native settles ' + action + ' before reentrant Controller.toggle callbacks', function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var toggle = harness.Lampa.Controller.toggle;
        var reentered = 0;
        harness.Lampa.Controller.toggle = function (name) {
            toggle(name);
            if (reentered++ === 0) {
                menuA.onBack();
                menuA.items[0].onSelect();
            }
        };
        if (action === 'selection') {
            // Call directly while controller is select to force restoration.
            menuA.items[0].onSelect();
            assert.strictEqual(harness.requests.length, 1);
            harness.folderResponse(harness.popRequest(), videoEntries());
            assert.strictEqual(harness.currentMenu().title, 'B');
        } else {
            menuA.onBack();
            assert.strictEqual(harness.currentMenu().title, 'Root');
            assert.strictEqual(harness.requests.length, 0);
        }
        assert.ok(reentered > 0);
    });
});

['before response', 'after response', 'cache'].forEach(function (timing) {
    ['back', 'select', 'close'].forEach(function (callback) {
        test('superseded open native menu ignores ' + callback + ': ' + timing, function () {
            var harness = navigationHarness();
            var menuA = enterFolderA(harness);
            var closeA = harness.test.menuCloser();
            var closeCalls = 0;
            harness.Lampa.Select.closeAll = function () { closeCalls++; };
            if (timing === 'cache') harness.test.cache.B = videoEntries();
            // Open B independently; A never received selection, Back or close.
            harness.test.showFolder('B', 'B', [{ id: '0', title: 'Root' }, { id: 'A', title: 'A' }]);
            var requestB = timing === 'cache' ? null : harness.popRequest();
            function stale() {
                if (callback === 'back') menuA.onBack();
                else if (callback === 'select') menuA.items[0].onSelect();
                else closeA();
            }
            function assertStaleIgnored() {
                var generation = harness.test.browseGeneration();
                var closer = harness.test.menuCloser();
                var count = harness.selects.length;
                var controller = harness.Lampa.Controller.enabled().name;
                stale();
                stale();
                assert.strictEqual(harness.test.browseGeneration(), generation);
                assert.strictEqual(harness.test.menuCloser(), closer);
                assert.strictEqual(harness.selects.length, count);
                assert.strictEqual(harness.Lampa.Controller.enabled().name, controller);
                assert.strictEqual(harness.requests.length, 0);
                assert.strictEqual(closeCalls, 0);
            }
            if (timing === 'before response') assertStaleIgnored();
            if (requestB) {
                assert.match(requestB.body, /<ObjectID>B<\/ObjectID>/);
                harness.folderResponse(requestB, videoEntries());
            }
            assert.strictEqual(harness.currentMenu().title, 'B');
            assert.ok(harness.test.cache.B);
            assertStaleIgnored();
            harness.ok(harness.currentMenu());
            assert.strictEqual(harness.played.length, 1);
            assert.strictEqual(harness.played[0].url, 'http://media/video.mp4');
            stale();
            assert.strictEqual(harness.played.length, 1);
        });
    });
});

test('superseded native callbacks during Select.show and later cannot steal new Back', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    var closeA = harness.test.menuCloser();
    var originalShow = harness.Lampa.Select.show;
    var generation;
    var menuB;
    harness.Lampa.Select.show = function (config) {
        if (config.title === 'B') {
            generation = harness.test.browseGeneration();
            menuA.onBack();
            menuA.items[0].onSelect();
            closeA();
            assert.strictEqual(harness.test.browseGeneration(), generation);
            menuB = config;
        }
        originalShow(config);
    };
    harness.test.cache.B = videoEntries();
    harness.test.showFolder('B', 'B', [{ id: '0', title: 'Root' }, { id: 'A', title: 'A' }]);
    assert.strictEqual(harness.currentMenu(), menuB);
    var currentCloser = harness.test.menuCloser();
    menuA.onBack();
    menuA.items[0].onSelect();
    closeA();
    assert.strictEqual(harness.test.menuCloser(), currentCloser);
    assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
    menuB.onBack();
    assert.strictEqual(harness.currentMenu().title, 'A');
    var currentA = harness.currentMenu();
    menuB.onBack();
    menuA.onBack();
    assert.strictEqual(harness.currentMenu(), currentA);
    currentA.onBack();
    assert.strictEqual(harness.currentMenu().title, 'Root');
    assert.strictEqual(harness.requests.length, 0);
});

test('native invalid URL leaves current menu Back usable in the lifecycle model', function () {
    var harness = navigationHarness();
    harness.test.cache.B = [{ id: 'bad', title: 'Bad', url: 'javascript:alert(1)' }];
    harness.test.showFolder('B', 'B', [{ id: '0', title: 'Root' }, { id: 'A', title: 'A' }]);
    var menuB = harness.currentMenu();
    var generation = harness.test.browseGeneration();
    var closer = harness.test.menuCloser();
    harness.ok(menuB);
    menuB.items[0].onSelect();
    assert.strictEqual(harness.played.length, 0);
    assert.strictEqual(harness.test.browseGeneration(), generation);
    assert.strictEqual(harness.test.menuCloser(), closer);
    assert.strictEqual(harness.Lampa.Controller.enabled().name, 'settings_component');
    menuB.onBack();
    var requestA = harness.popRequest();
    assert.match(requestA.body, /<ObjectID>A<\/ObjectID>/);
    harness.folderResponse(requestA, [{ id: 'B', title: 'B', isFolder: true }]);
    assert.strictEqual(harness.currentMenu().title, 'A');
    assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
});

function beginIndependentBrowse(harness) {
    harness.test.showFolder('B', 'B', [{ id: '0', title: 'Root' }, { id: 'A', title: 'A' }]);
    return harness.popRequest();
}

function failBrowse(harness, request, outcome) {
    if (outcome === 'fault') {
        var fault = '<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>';
        request.success(fault);
        // SOAP Fault follows the existing three-attempt Browse policy.
        harness.runTimer();
        harness.respond(fault);
        harness.runTimer();
        harness.respond(fault);
    } else request.success(soapResponse(didl([]), 0));
}

['fault', 'empty'].forEach(function (outcome) {
    ['Back', 'selection'].forEach(function (action) {
        test('remaining native menu recovers ' + action + ' after Browse ' + outcome, function () {
            var harness = navigationHarness();
            var menuA = enterFolderA(harness);
            var closeA = harness.test.menuCloser();
            var request = beginIndependentBrowse(harness);
            var generation = harness.test.browseGeneration();
            menuA.onBack();
            menuA.items[0].onSelect();
            assert.strictEqual(harness.test.browseGeneration(), generation);
            failBrowse(harness, request, outcome);
            var recovered = harness.currentMenu();
            assert.notStrictEqual(recovered, menuA);
            assert.strictEqual(recovered.title, 'A');
            assert.strictEqual(harness.nativeVisible, true);
            assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
            assert.notStrictEqual(harness.test.menuCloser(), closeA);
            assert.strictEqual(harness.test.browseGeneration(), generation);
            menuA.onBack();
            menuA.items[0].onSelect();
            assert.strictEqual(harness.test.browseGeneration(), generation);
            if (action === 'Back') {
                recovered.onBack();
                assert.strictEqual(harness.currentMenu().title, 'Root');
                assert.strictEqual(harness.requests.length, 0);
            } else {
                harness.ok(recovered);
                // Empty B was cached by Browse; Fault was not.
                if (outcome === 'empty') {
                    assert.strictEqual(harness.requests.length, 0);
                    assert.ok(harness.test.menuCloser());
                    assert.strictEqual(harness.currentMenu().title, 'A');
                } else {
                    assert.strictEqual(harness.requests.length, 1);
                    harness.folderResponse(harness.popRequest(), videoEntries());
                    assert.strictEqual(harness.currentMenu().title, 'B');
                }
            }
        });
    });
});

['open menu', 'pending Browse'].forEach(function (phase) {
    test('Settings invalidation leaves visible native menu manageable: ' + phase, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var request = phase === 'pending Browse' ? beginIndependentBrowse(harness) : null;
        var generation = harness.test.browseGeneration();
        harness.settingsListener.send('open', { name: 'main' });
        assert.strictEqual(harness.test.browseGeneration(), generation + 1);
        if (request) harness.folderResponse(request, videoEntries());
        assert.notStrictEqual(harness.currentMenu(), menuA);
        assert.strictEqual(harness.currentMenu().title, 'A');
        assert.strictEqual(harness.nativeVisible, true);
        var recovered = harness.currentMenu();
        menuA.onBack();
        assert.strictEqual(harness.currentMenu(), recovered);
        recovered.onBack();
        assert.strictEqual(harness.currentMenu().title, 'Root');
        assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
        assert.strictEqual(harness.requests.length, 0);
    });
});

['open menu', 'changed Browse token', 'pending Browse'].forEach(function (phase) {
    test('Player.close safely dismisses native menu: ' + phase, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var request = phase === 'pending Browse' ? beginIndependentBrowse(harness) : null;
        if (phase === 'changed Browse token') harness.settingsListener.send('open', { name: 'main' });
        var calls = 0;
        harness.Lampa.Select.closeAll = function () {
            calls++;
            harness.nativeVisible = false;
            harness.Lampa.Controller.toggle('settings_component');
            menuA.onBack();
        };
        harness.playerListener.send('close');
        assert.strictEqual(calls, 1);
        assert.strictEqual(harness.nativeVisible, false);
        assert.strictEqual(harness.test.menuCloser(), null);
        assert.strictEqual(harness.Lampa.Controller.enabled().name, 'settings_component');
        var count = harness.selects.length;
        var generation = harness.test.browseGeneration();
        if (request) harness.folderResponse(request, videoEntries());
        menuA.onBack();
        menuA.items[0].onSelect();
        assert.strictEqual(harness.selects.length, count);
        assert.strictEqual(harness.test.browseGeneration(), generation);
        assert.strictEqual(harness.requests.length, 0);
    });
});

['fault', 'empty', 'Settings'].forEach(function (outcome) {
    test('hidden native menu is detached on recovery: ' + outcome, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var request = outcome === 'Settings' ? null : beginIndependentBrowse(harness);
        harness.nativeVisible = false;
        if (request) failBrowse(harness, request, outcome);
        else harness.settingsListener.send('open', { name: 'main' });
        assert.ok(harness.test.menuCloser());
        assert.notStrictEqual(harness.currentMenu(), menuA);
        var generation = harness.test.browseGeneration();
        menuA.onBack();
        menuA.items[0].onSelect();
        assert.strictEqual(harness.test.browseGeneration(), generation);
        assert.strictEqual(harness.requests.length, 0);
        harness.test.showFolder('A', 'A', [{ id: '0', title: 'Root' }]);
        assert.notStrictEqual(harness.currentMenu(), menuA);
        assert.strictEqual(harness.nativeVisible, true);
        assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
        harness.currentMenu().onBack();
        assert.strictEqual(harness.currentMenu().title, 'Root');
    });
});

['synchronous', 'delayed'].forEach(function (timing) {
    test('active pending close handle dismisses owner without Back: ' + timing, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var request = beginIndependentBrowse(harness);
        var queued;
        var calls = 0;
        harness.Lampa.Select.closeAll = function () {
            calls++;
            harness.nativeVisible = false;
            harness.Lampa.Controller.toggle('settings_component');
            if (timing === 'synchronous') menuA.onBack();
            else queued = menuA.onBack;
        };
        harness.test.closeMenu();
        assert.strictEqual(calls, 1);
        assert.strictEqual(harness.test.menuCloser(), null);
        assert.strictEqual(harness.nativeVisible, false);
        var count = harness.selects.length;
        var generation = harness.test.browseGeneration();
        if (queued) queued();
        harness.folderResponse(request, videoEntries());
        assert.strictEqual(harness.selects.length, count);
        assert.strictEqual(harness.test.browseGeneration(), generation);
        assert.strictEqual(harness.Lampa.Controller.enabled().name, 'settings_component');
        assert.strictEqual(harness.requests.length, 0);
        harness.test.showFolder('A', 'A', [{ id: '0', title: 'Root' }]);
        assert.strictEqual(harness.nativeVisible, true);
        assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
    });
});

test('obsolete Browse completion cannot resume menu suspended for a newer request', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    var requestB = beginIndependentBrowse(harness);
    harness.test.showFolder('C', 'C', [{ id: '0', title: 'Root' }]);
    var requestC = harness.popRequest();
    var generation = harness.test.browseGeneration();
    harness.folderResponse(requestB, []);
    menuA.onBack();
    menuA.items[0].onSelect();
    assert.strictEqual(harness.test.browseGeneration(), generation);
    assert.strictEqual(harness.requests.length, 0);
    failBrowse(harness, requestC, 'fault');
    assert.strictEqual(harness.test.browseGeneration(), generation);
    var recovered = harness.currentMenu();
    assert.notStrictEqual(recovered, menuA);
    menuA.onBack();
    assert.strictEqual(harness.currentMenu(), recovered);
    recovered.onBack();
    assert.strictEqual(harness.currentMenu().title, 'Root');
    assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
});

var unavailableVisibility = [
    { name: 'missing', value: undefined },
    { name: 'not a function', value: true },
    { name: 'throwing', value: function () { throw new Error('opened failed'); } },
    { name: 'undefined result', value: function () {} },
    { name: 'null result', value: function () { return null; } },
    { name: 'string result', value: function () { return 'true'; } },
    { name: 'numeric result', value: function () { return 1; } },
    { name: 'object result', value: function () { return {}; } }
];

function assertFallbackMenu(harness) {
    assert.ok(harness.dom.overlay());
    assert.strictEqual(harness.dom.count('keydown'), 1);
    assert.strictEqual(harness.dom.count('keyup'), 1);
    assert.strictEqual(harness.dom.document.activeElement, harness.dom.buttons()[0]);
    assert.ok(harness.test.menuCloser());
}

unavailableVisibility.forEach(function (visibility) {
    test('unavailable visibility chooses usable DOM navigation: ' + visibility.name, function () {
        var harness = createHarness({ opened: visibility.value });
        harness.test.cache['0'] = [{ id: 'A', title: 'A', isFolder: true }];
        harness.test.cache.A = [{ id: 'B', title: 'B', isFolder: true }];
        harness.test.cache.B = videoEntries();
        harness.test.showFolder('0', 'Root', []);
        assert.strictEqual(harness.selects.length, 0);
        assertFallbackMenu(harness);
        harness.dom.key('Enter'); harness.runTimer();
        assertFallbackMenu(harness);
        harness.dom.key('Enter'); harness.runTimer();
        assertFallbackMenu(harness);
        harness.dom.key('Escape');
        assertFallbackMenu(harness);
        assert.match(harness.dom.buttons()[0].textContent, /B/);
        harness.dom.key('Enter'); harness.runTimer();
        harness.dom.key('Enter'); harness.runTimer();
        assert.strictEqual(harness.played.length, 1);
        assert.strictEqual(harness.played[0].url, 'http://media/video.mp4');
        assert.strictEqual(harness.dom.overlay(), null);
        assert.strictEqual(harness.test.menuCloser(), null);
        assert.strictEqual(harness.requests.length, 0);
        harness.test.showFolder('A', 'A', [{ id: '0', title: 'Root' }]);
        harness.settingsListener.send('open', { name: 'main' });
        assertFallbackMenu(harness);
        harness.playerListener.send('close');
        assert.strictEqual(harness.dom.overlay(), null);
        assert.strictEqual(harness.test.menuCloser(), null);
        assert.strictEqual(harness.dom.count('keydown'), 0);
        assert.strictEqual(harness.dom.count('keyup'), 0);
    });
});

['empty', 'fault'].forEach(function (outcome) {
    test('missing opened DOM selection recovers parent after Browse ' + outcome, function () {
        var harness = createHarness({ opened: undefined });
        harness.test.cache['0'] = [{ id: 'A', title: 'A', isFolder: true }];
        harness.test.cache.A = [{ id: 'B', title: 'B', isFolder: true }];
        harness.test.showFolder('A', 'A', [{ id: '0', title: 'Root' }]);
        harness.dom.key('Enter'); harness.runTimer();
        assert.strictEqual(harness.dom.overlay(), null);
        failBrowse(harness, harness.popRequest(), outcome);
        assertFallbackMenu(harness);
        assert.match(harness.dom.buttons()[0].textContent, /B/);
        assert.strictEqual(harness.requests.length, 0);
        assert.strictEqual(harness.timers.length, 0);
        harness.dom.key('Escape');
        assertFallbackMenu(harness);
        assert.match(harness.dom.buttons()[0].textContent, /A/);
    });
});

['empty', 'fault', 'Settings'].forEach(function (outcome) {
    unavailableVisibility.forEach(function (visibility) {
        test('hidden native recovery uses fresh DOM on ' + outcome + ': ' + visibility.name, function () {
            var harness = navigationHarness();
            var menuA = enterFolderA(harness);
            var closeA = harness.test.menuCloser();
            var request = outcome === 'Settings' ? null : beginIndependentBrowse(harness);
            harness.nativeVisible = false;
            harness.Lampa.Select.opened = visibility.value;
            if (request) failBrowse(harness, request, outcome);
            else harness.settingsListener.send('open', { name: 'main' });
            assertFallbackMenu(harness);
            assert.notStrictEqual(harness.test.menuCloser(), closeA);
            var generation = harness.test.browseGeneration();
            var closer = harness.test.menuCloser();
            menuA.onBack(); menuA.items[0].onSelect(); closeA();
            assert.strictEqual(harness.test.browseGeneration(), generation);
            assert.strictEqual(harness.test.menuCloser(), closer);
            assert.strictEqual(harness.requests.length, 0);
            harness.dom.key('Escape');
            assertFallbackMenu(harness);
            assert.match(harness.dom.buttons()[0].textContent, /A/);
            assert.strictEqual(harness.Lampa.Controller.enabled().name, 'settings_component');
        });
    });
});

[true, false].forEach(function (reported) {
    test('boolean visibility never revives the previous native instance: ' + reported, function () {
        var harness = navigationHarness();
        var menuA = enterFolderA(harness);
        var request = beginIndependentBrowse(harness);
        harness.nativeVisible = !reported; // Deliberately stale API result.
        harness.Lampa.Select.opened = function () { return reported; };
        harness.folderResponse(request, []);
        var recovered = harness.currentMenu();
        assert.notStrictEqual(recovered, menuA);
        assert.strictEqual(recovered.title, 'A');
        assert.strictEqual(harness.nativeVisible, true);
        var generation = harness.test.browseGeneration();
        menuA.onBack(); menuA.items[0].onSelect();
        assert.strictEqual(harness.test.browseGeneration(), generation);
        recovered.onBack();
        assert.strictEqual(harness.currentMenu().title, 'Root');
        assert.strictEqual(harness.requests.length, 0);
    });
});

test('native recovery does not close or replace a newer menu opened during dismissal', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    var request = beginIndependentBrowse(harness);
    harness.test.cache.C = videoEntries();
    harness.Lampa.Select.closeAll = function () {
        harness.nativeVisible = false;
        menuA.onBack();
        harness.test.showFolder('C', 'C', [{ id: '0', title: 'Root' }]);
    };
    harness.folderResponse(request, []);
    var menuC = harness.currentMenu();
    assert.strictEqual(menuC.title, 'C');
    assert.strictEqual(harness.nativeVisible, true);
    assert.strictEqual(harness.dom.overlay(), null);
    var generation = harness.test.browseGeneration();
    menuA.onBack(); menuA.items[0].onSelect();
    assert.strictEqual(harness.test.browseGeneration(), generation);
    harness.ok(menuC);
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.requests.length, 0);
});

test('Back while native Browse is pending remains ignored until the real Lampa order is verified', function () {
    var harness = navigationHarness();
    var menuA = enterFolderA(harness);
    var request = beginIndependentBrowse(harness);
    var generation = harness.test.browseGeneration();
    harness.nativeVisible = false;
    harness.Lampa.Controller.toggle('settings_component');
    menuA.onBack();
    assert.strictEqual(harness.test.browseGeneration(), generation);
    harness.folderResponse(request, videoEntries());
    assert.strictEqual(harness.currentMenu().title, 'B');
    assert.strictEqual(harness.Lampa.Controller.enabled().name, 'select');
});
