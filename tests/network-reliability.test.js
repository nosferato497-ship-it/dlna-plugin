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

function createHarness(options) {
    options = options || {};
    var requests = [];
    var timers = [];
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
        'window.__test = { init: init, requestNative: requestNative, soapBrowse: soapBrowse, browseAll: browseAll, showFolder: showFolder, openCatalog: openCatalog, play: play, cache: cache }; if (window.appready) init();'
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
        Select: { show: function (config) { selects.push(config); } },
        Player: { play: function (entry) { played.push(entry); }, callback: function () {} },
        Noty: { show: function (message) { notices.push(message); } }
    };
    var window = { Lampa: Lampa, appready: false, $: function (value) { return value; }, DOMParser: HarnessDOMParser };
    var document = {
        getElementById: function () { return null; },
        createElement: function () { return { style: {}, textContent: '' }; }
    };
    var context = {
        window: window,
        Lampa: Lampa,
        document: document,
        DOMParser: HarnessDOMParser,
        console: { log: function () {}, error: function () {} },
        setTimeout: function (callback, delay) { timers.push({ callback: callback, delay: delay }); return timers.length; }
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
        timers: timers,
        selects: selects,
        played: played,
        notices: notices,
        settingsListener: settingsListener,
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
