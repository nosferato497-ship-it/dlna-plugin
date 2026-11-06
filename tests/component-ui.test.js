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


function componentHarness(options) {
    options = options || {};
    var registry = {};
    var controllers = {};
    var controller = 'home';
    var requests = [];
    var timers = [];
    var played = [];
    var notices = [];
    var notyCalls = [];
    var pushed = [];
    var backwards = 0;
    var playerCallback;
    var playerCallbacks = [];
    var playerOpened = false;
    var pendingPlayers = [];
    var launches = [];
    var windowEvents = {};
    var params = [];
    var contentToggles = 0;
    var settingsClosed = 0;
    var active = null;
    var document;
    function element(tag) {
        var node = { tag: tag, style: {}, children: [], events: {}, attributes: {}, parentNode: null,
            className: '', textContent: '', scrollTop: 0, clientHeight: 300, offsetHeight: 50, offsetTop: 0,
            appendChild: function (child) { child.parentNode = this; child.offsetTop = this.children.length * 56; this.children.push(child); },
            removeChild: function (child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
            setAttribute: function (key, value) { this.attributes[key] = value; },
            getAttribute: function (key) { return this.attributes[key]; },
            addEventListener: function (name, fn) { (this.events[name] || (this.events[name] = [])).push(fn); },
            removeEventListener: function (name, fn) { this.events[name] = (this.events[name] || []).filter(function (f) { return f !== fn; }); },
            querySelectorAll: function () {
                var result = [];
                function walk(parent) { parent.children.forEach(function (child) {
                    if ((' ' + child.className + ' ').indexOf(' selector ') >= 0) result.push(child);
                    walk(child);
                }); }
                walk(this); return result;
            }
        };
        Object.defineProperty(node, 'firstChild', { get: function () { return this.children[0] || null; } });
        return node;
    }
    document = { body: element('body'), activeElement: null, createElement: element, getElementById: function () { return null; }, hidden: false, addEventListener: function (name, fn) { (this.events[name] || (this.events[name] = [])).push(fn); }, removeEventListener: function (name, fn) { this.events[name] = (this.events[name] || []).filter(function (f) { return f !== fn; }); }, events: {} };
    function dispatch(node, name) { (node.events[name] || []).slice().forEach(function (fn) { fn({ target: node }); }); }
    function $(node) {
        var nodes = Array.isArray(node) ? node : [node];
        return { 0: nodes[0], length: nodes.length,
            on: function (names, fn) { nodes.forEach(function (item) { names.split(' ').forEach(function (name) { item.addEventListener(name, fn); }); }); return this; },
            off: function () { nodes.forEach(function (item) { item.events = {}; }); return this; },
            find: function () { return $(nodes[0].querySelectorAll('.selector')); }
        };
    }
    var settingsListener = createListener();
    var playerListener = createListener();
    var selectListener = createListener();
    var keypadListener = createListener();
    var Lampa = {
        SettingsApi: { addComponent: function () {}, addParam: function (param) { params.push(param); } },
        Storage: { field: function () { return ''; } },
        Lang: { add: function () {}, translate: function (value) { return value; } },
        Listener: { follow: function () {} },
        Settings: { listener: settingsListener },
        Noty: { show: function (message, params) { notices.push(message); notyCalls.push({ message: message, params: params || {} }); } },
        Component: { add: function (name, constructor) { registry[name] = constructor; } },
        Activity: {
            active: function () { return active; },
            push: function (params) {
                if (active && active.activity && active.activity.component) active.activity.component.pause();
                var screen = new registry[params.component](params);
                var slide = { component: screen, loader: function () {} };
                screen.activity = slide;
                active = { component: params.component, activity: slide };
                pushed.push(active);
                screen.create();
                document.body.appendChild(screen.render(true));
                screen.start();
            },
            backward: function () {
                backwards++;
                if (active && active.activity) { var departed = active.activity.component; if (options.delayedDestroy) timers.push({ callback: function () { departed.destroy(); }, delay: 200 }); else departed.destroy(); }
                active = null;
                controller = 'home';
            }
        },
        Controller: {
            add: function (name, callbacks) { controllers[name] = callbacks; },
            enabled: function () { return { name: controller }; },
            toggle: function (name) { if (name === 'content') { contentToggles++; if (controller === 'settings') settingsClosed++; } controller = name; if (controllers[name] && controllers[name].toggle) controllers[name].toggle(); },
            collectionSet: function () {},
            collectionFocus: function (row) { document.activeElement = row; dispatch(row, 'hover:focus'); }
        },
        Select: { listener: selectListener, show: function () { throw new Error('Diagnostic log must not open Select'); } },
        Keypad: { listener: keypadListener },
        Player: {
            listener: playerListener,
            callback: function (fn) { playerCallback = fn; if (fn) playerCallbacks.push(fn); },
            opened: function () { return playerOpened; },
            play: function (data) { if (options.playerThrows) throw Error('Player failure'); played.push(data);
                var run = true; playerListener.send('create', { data: data, abort: function () { run = false; } });
                if (!run) return;
                function begin() { launches.push(data); if (options.externalPlayer) playerListener.send('external', data); else { playerListener.send('start', data); playerOpened = true; controller = 'player'; } }
                if (options.deferredPlayer) pendingPlayers.push(begin); else begin(); }
        },
        Reguest: function () {
            this.timeout = function () {};
            this.clear = function () {};
            this.native = function (url, success, failure, body, params) { requests.push({ url: url, success: success, failure: failure, body: body, params: params }); };
        }
    };
    if (options.preCreateAbort) playerListener.follow('create', function (event) { event.abort(); });
    if (options.listenerNoRemove) playerListener.remove = undefined;
    var window = { Lampa: Lampa, appready: false, DOMParser: TestDOMParser, $: $,
        addEventListener: function (name, fn) { (windowEvents[name] || (windowEvents[name] = [])).push(fn); },
        removeEventListener: function (name, fn) { windowEvents[name] = (windowEvents[name] || []).filter(function (f) { return f !== fn; }); } };
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8').replace(
        'if (window.appready) init();',
        'window.__test = { init: init, openCatalog: openCatalog, cache: cache }; if (window.appready) init();'
    );
    vm.runInNewContext(source, { window: window, Lampa: Lampa, document: document, DOMParser: TestDOMParser,
        console: { log: function () {}, error: function () {} },
        setTimeout: function (fn, delay) { timers.push({ callback: fn, delay: delay }); return timers.length; }, clearTimeout: function () {}
    });
    window.__test.init();
    var api = window.__test;
    function screen() { return active && active.activity.component; }
    function root() { return screen().render(true); }
    function viewport() { return root().children[2]; }
    return {
        launches: launches, pendingPlayers: pendingPlayers,
        Lampa: Lampa, api: api, requests: requests, timers: timers, played: played, notices: notices, pushed: pushed,
        document: document, settings: settingsListener, screen: screen, root: root, viewport: viewport,
        rows: function () { return viewport().children[0].children; },
        title: function () { return root().children[0].textContent; },
        status: function () { return root().children[1].textContent; },
        open: function () { var param = params.filter(function (p) { return p.param.name === 'dlna_bridge_open_catalog'; })[0]; assert.ok(param); param.onChange(); },
        press: function (name) { if (controllers[controller] && controllers[controller][name]) controllers[controller][name](); },
        click: function (row) { dispatch(row, 'click'); },
        scroll: function (position) { viewport().scrollTop = position; dispatch(viewport(), 'scroll'); },
        controller: function () { return controller; },
        backCount: function () { return backwards; },
        reply: function (entries, total) { assert.ok(requests.length); requests.shift().success(soapResponse(didl(entries), total === undefined ? entries.length : total)); },
        raw: function (xml) { assert.ok(requests.length); requests.shift().success(xml); },
        fail: function () { assert.ok(requests.length); requests.shift().failure({ status: 0 }, 'timeout'); },
        timer: function () { assert.ok(timers.length); timers.shift().callback(); },
        closePlayer: function () { playerOpened = false; if (playerCallback) playerCallback(); playerListener.send('close', { data: played[played.length - 1] }); },
        closeEvent: function (data) { playerOpened = false; playerListener.send('close', data ? { data: data } : {}); },
        callback: function (index) { playerCallbacks[index === undefined ? playerCallbacks.length - 1 : index](); },
        beginPlayer: function () { assert.ok(pendingPlayers.length); pendingPlayers.shift()(); },
        focusWindow: function () { (windowEvents.focus || []).slice().forEach(function (fn) { fn(); }); },
        blurWindow: function () { (windowEvents.blur || []).slice().forEach(function (fn) { fn(); }); },
        visibility: function (hidden) { document.hidden = hidden; dispatch(document, 'visibilitychange'); },
        contentToggles: function () { return contentToggles; },
        settingsClosed: function () { return settingsClosed; },
        externalHandlers: function () { return playerListener.count('external'); },
        closeHandlers: function () { return playerListener.count('close'); },
        createHandlers: function () { return playerListener.count('create'); },
        startHandlers: function () { return playerListener.count('start'); },
        showPlaybackDiagnosticLog: function () {
            var param = params.filter(function (item) { return item.param.name === 'dlna_bridge_playback_diagnostic_log'; })[0];
            assert.ok(param); param.onChange();
        },
        showPreviousPlaybackDiagnosticLog: function () {
            var param = params.filter(function (item) { return item.param.name === 'dlna_bridge_playback_diagnostic_previous'; })[0];
            assert.ok(param); param.onChange();
        },
        lastNotice: function () { return notyCalls[notyCalls.length - 1]; },
        notyCalls: notyCalls,
        selectObserverCount: function () { return selectListener.count('preshow') + selectListener.count('close'); },
        keypadBackHandlers: function () { return keypadListener.count('back'); },
        clearPlaybackDiagnosticLog: function () {
            var param = params.filter(function (item) { return item.param.name === 'dlna_bridge_clear_playback_diagnostic_log'; })[0];
            assert.ok(param); param.onChange();
        },
        visibilityHandlers: function () { return (document.events.visibilitychange || []).length; },
        windowHandlers: function () { return Object.keys(windowEvents).reduce(function (n, key) { return n + windowEvents[key].length; }, 0); },
        paused: function () { screen().pause(); },
        activate: function (activity) { active = activity; screen().start(); },
        resumed: function () { screen().start(); }
    };
}

function folder(id) { return { id: id, title: id, isFolder: true }; }
function video(url) { return { id: 'video', title: 'Video', url: url || 'http://192.168.1.1:8200/video.mp4' }; }
function ready() { var h = componentHarness(); h.open(); h.reply([folder('A')]); return h; }
function enterA(h) { h.press('enter'); assert.match(h.requests[0].body, /<ObjectID>A<\/ObjectID>/); h.reply([folder('B')]); }

test('component Root -> A -> B -> Video uses one Activity and native SOAP', function () {
    var h = ready();
    enterA(h); h.press('enter');
    assert.match(h.requests[0].body, /<ObjectID>B<\/ObjectID>/);
    assert.strictEqual(h.requests[0].url, 'http://192.168.1.1:8200/ctl/ContentDir');
    h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1);
    assert.strictEqual(h.pushed.length, 1);
    assert.strictEqual(h.controller(), 'player');
    h.closePlayer();
    assert.strictEqual(h.controller(), 'content');
    assert.strictEqual(h.title(), 'B');
    assert.strictEqual(h.document.activeElement, h.rows()[0]);
});

test('component Back restores parent and root Back exits Activity', function () {
    var h = ready(); enterA(h); h.press('enter'); h.reply([video()]);
    h.press('back'); assert.strictEqual(h.title(), 'A');
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    assert.strictEqual(h.requests.length, 0);
    h.press('back'); assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.controller(), 'home');
});

test('component loading is visible and duplicate OK creates one request', function () {
    var h = ready(); h.press('enter'); h.press('enter'); h.click(h.rows()[0]);
    assert.strictEqual(h.requests.length, 1);
    assert.match(h.status(), /\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430/);
    assert.strictEqual(h.root().getAttribute('aria-busy'), 'true');
    h.reply([folder('B')]); assert.strictEqual(h.root().getAttribute('aria-busy'), 'false');
});

test('component Back during Browse cancels transition and ignores late response', function () {
    var h = ready(); h.press('enter'); var old = h.requests.shift();
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    old.success(soapResponse(didl([folder('stale')]), 1));
    assert.strictEqual(h.title(), 'DLNA'); assert.strictEqual(h.api.cache.A, undefined);
    h.press('enter'); assert.strictEqual(h.requests.length, 1); h.reply([folder('B')]); assert.strictEqual(h.title(), 'A');
});

['Fault', 'timeout'].forEach(function (kind) {
    test('component preserves current list and path on ' + kind, function () {
        var h = ready(); h.press('enter');
        var fault = '<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>';
        var i; for (i = 0; i < 3; i++) { if (kind === 'Fault') h.raw(fault); else h.fail(); if (i < 2) h.timer(); }
        assert.strictEqual(h.title(), 'DLNA'); assert.match(h.status(), /Browse/);
        assert.match(h.rows()[0].textContent, /A/); assert.strictEqual(h.document.activeElement, h.rows()[0]);
        h.press('enter'); h.reply([folder('B')]); assert.strictEqual(h.title(), 'A');
        h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    });
});

test('component empty child remains controllable and Back returns parent', function () {
    var h = ready(); h.press('enter'); h.reply([]);
    assert.strictEqual(h.title(), 'A'); assert.strictEqual(h.rows().length, 1);
    assert.strictEqual(h.document.activeElement, h.rows()[0]);
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
});

test('component root failure leaves retry row and root cancellation remains usable', function () {
    var h = componentHarness(); h.open(); h.press('back');
    var cancelled = h.requests.shift(); cancelled.success(soapResponse(didl([folder('late')]), 1));
    assert.strictEqual(h.pushed.length, 1); assert.strictEqual(h.rows().length, 1);
    h.press('enter'); h.reply([folder('A')]); assert.match(h.rows()[0].textContent, /A/);
});

test('component overlapping refreshes accept only newest request', function () {
    var h = componentHarness(); h.open(); var first = h.requests.shift();
    h.screen().refresh(); var second = h.requests.shift();
    first.success(soapResponse(didl([folder('old')]), 1));
    assert.strictEqual(h.api.cache['0'], undefined);
    second.success(soapResponse(didl([folder('new')]), 1));
    assert.match(h.rows()[0].textContent, /new/);
});

test('component reuses catalog cache after Back without extra SOAP', function () {
    var h = ready(); enterA(h); h.press('back'); h.press('enter');
    assert.strictEqual(h.requests.length, 0); assert.strictEqual(h.title(), 'A');
});

test('component restores selected row and exact scroll offset after nested navigation', function () {
    var h = componentHarness(); h.open(); h.reply([folder('A'), folder('B'), folder('C')]);
    h.press('down'); h.scroll(180); h.press('enter'); h.reply([video()]);
    h.press('back');
    assert.strictEqual(h.document.activeElement, h.rows()[1]); assert.strictEqual(h.viewport().scrollTop, 180);
});

[0, 1].forEach(function (index) {
    test('component resource view selects resource ' + index + ' and restores catalog', function () {
        var h = componentHarness();
        h.api.cache['0'] = [{ title: 'Movie', resources: [
            { url: 'http://media/low', resolution: '640x360' }, { url: 'http://media/high', resolution: '1920x1080' }
        ] }];
        h.open(); h.scroll(90); h.press('enter');
        assert.match(h.rows()[1].textContent, /1920x1080/);
        if (index) h.press('down');
        h.press('enter'); h.press('enter');
        assert.strictEqual(h.played.length, 1); assert.strictEqual(h.played[0].url, index ? 'http://media/high' : 'http://media/low');
        h.closePlayer(); assert.strictEqual(h.document.activeElement, h.rows()[index]);
        h.press('back'); assert.strictEqual(h.title(), 'DLNA'); assert.strictEqual(h.viewport().scrollTop, 90);
        assert.strictEqual(h.pushed.length, 1);
    });
});

test('component rejects invalid selected resource without losing focus or Back', function () {
    var h = componentHarness(); h.api.cache['0'] = [{ title: 'Movie', resources: [{ url: 'javascript:alert(1)' }, { url: 'http://media/good' }] }];
    h.open(); h.press('enter'); h.press('enter');
    assert.strictEqual(h.played.length, 0); assert.strictEqual(h.document.activeElement, h.rows()[0]);
    h.press('down'); h.press('enter'); assert.strictEqual(h.played[0].url, 'http://media/good');
    h.closePlayer(); h.press('back'); assert.strictEqual(h.title(), 'DLNA');
});

test('component destroyed during Browse ignores response, retry and detached row callbacks', function () {
    var h = ready(); var row = h.rows()[0]; var callback = row.events.click[0];
    h.press('enter'); var request = h.requests.shift(); var component = h.screen();
    component.destroy(); var before = h.notices.length;
    request.success(soapResponse(didl([video()]), 1)); callback(); component.start(); component.back(); component.select(0);
    assert.strictEqual(h.api.cache.A, undefined); assert.strictEqual(h.notices.length, before);
    assert.strictEqual(h.played.length, 0); assert.strictEqual(h.requests.length, 0);
});

test('component pause cancels a pending transition and start restores retained catalog', function () {
    var h = ready(); h.press('enter'); var request = h.requests.shift();
    h.paused(); request.success(soapResponse(didl([video()]), 1)); h.resumed();
    assert.strictEqual(h.title(), 'DLNA'); assert.strictEqual(h.requests.length, 0);
    h.press('enter'); h.reply([folder('B')]); assert.strictEqual(h.title(), 'A');
});

test('component Settings events do not invalidate its independent pending Browse', function () {
    var h = ready(); h.press('enter'); h.settings.send('open', { name: 'main' }); h.reply([folder('B')]);
    assert.strictEqual(h.title(), 'A');
});

test('component player error leaves video selectable for retry', function () {
    var h = componentHarness({ playerThrows: true }); h.api.cache['0'] = [video()]; h.open();
    h.press('enter'); h.press('enter'); assert.strictEqual(h.played.length, 0);
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.document.activeElement, h.rows()[0]);
    h.press('back'); assert.strictEqual(h.backCount(), 1);
});


test('component repeated opening retains one Activity and one pending request', function () {
    var h = componentHarness(); h.open(); h.open();
    assert.strictEqual(h.pushed.length, 1); assert.strictEqual(h.requests.length, 1);
    h.reply([folder('A')]); h.open();
    assert.strictEqual(h.requests.length, 0); assert.strictEqual(h.pushed.length, 1);
});

test('component root Fault keeps retry available and retries without exiting Activity', function () {
    var h = componentHarness(); h.open();
    var fault = '<s:Envelope><s:Body><Fault><faultstring>Denied</faultstring></Fault></s:Body></s:Envelope>';
    var i; for (i = 0; i < 3; i++) { h.raw(fault); if (i < 2) h.timer(); }
    assert.match(h.status(), /Denied/); assert.strictEqual(h.rows().length, 1);
    assert.strictEqual(h.document.activeElement, h.rows()[0]);
    h.press('enter'); h.reply([folder('A')]); assert.match(h.rows()[0].textContent, /A/);
});

test('component empty root supports Back and shows an actual empty-state label', function () {
    var h = componentHarness(); h.open(); h.reply([]);
    assert.match(h.rows()[0].textContent, /\u041f\u0443\u0441\u0442\u0430\u044f/);
    h.press('back'); assert.strictEqual(h.backCount(), 1);
});

test('component legacy invalid URL never reaches Player and retains navigation', function () {
    var h = componentHarness(); h.api.cache['0'] = [video('javascript:alert(1)'), folder('A')]; h.open();
    h.press('enter'); assert.strictEqual(h.played.length, 0);
    h.press('down'); assert.strictEqual(h.rows()[1].style.outline, '2px solid #8fc7ff');
    h.press('enter'); h.reply([]); assert.strictEqual(h.title(), 'A');
    h.press('back'); assert.strictEqual(h.document.activeElement, h.rows()[1]);
});

test('component retry timer does not issue a request after destruction', function () {
    var h = componentHarness(); h.open(); h.fail(); assert.strictEqual(h.timers.length, 1);
    h.screen().destroy(); h.timer(); assert.strictEqual(h.requests.length, 0);
});

test('component stale player callback after root exit cannot restore destroyed focus', function () {
    var h = componentHarness(); h.api.cache['0'] = [video()]; h.open(); h.press('enter');
    h.Lampa.Activity.backward(); assert.strictEqual(h.controller(), 'home');
    h.closePlayer(); assert.strictEqual(h.controller(), 'home');
    assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.requests.length, 0);
});

test('component stale row from previous folder cannot navigate twice', function () {
    var h = ready(); var callback = h.rows()[0].events.click[0];
    h.press('enter'); h.reply([video()]); callback();
    assert.strictEqual(h.played.length, 0); assert.strictEqual(h.requests.length, 0);
});


test('player close without DLNA playback preserves Settings and pending Browse', function () {
    var h = componentHarness(); h.open();
    h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings');
    var count = h.contentToggles(); h.closeEvent();
    assert.strictEqual(h.controller(), 'settings'); assert.strictEqual(h.contentToggles(), count);
    h.reply([folder('A')]); assert.match(h.rows()[0].textContent, /A/);
});

['callback-first', 'close-first'].forEach(function (order) {
    test('player completion is consumed once: ' + order, function () {
        var h = componentHarness(); h.open(); h.reply([video()]); h.scroll(73); h.press('enter');
        if (order === 'callback-first') { h.callback(); h.closeEvent(h.played[0]); }
        else { h.closeEvent(h.played[0]); h.callback(); }
        assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.viewport().scrollTop, 73);
        h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings');
        var count = h.contentToggles(); h.callback(); h.closeEvent(h.played[0]);
        assert.strictEqual(h.controller(), 'settings'); assert.strictEqual(h.contentToggles(), count);
    });
});

test('old callback and identifiable close cannot finish a new session', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter'); h.closePlayer();
    h.press('enter'); assert.strictEqual(h.played.length, 2);
    h.callback(0); h.closeEvent(h.played[0]);
    assert.strictEqual(h.controller(), 'player');
    h.closePlayer(); assert.strictEqual(h.controller(), 'content');
});

test('anonymous close does not consume a live session or steal Settings', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter');
    h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings'); h.closeEvent();
    assert.strictEqual(h.controller(), 'settings'); h.callback(); assert.strictEqual(h.controller(), 'settings');
});

test('session completion after destroy cannot restore a controller', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter'); h.screen().destroy();
    h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings');
    h.callback(); h.closeEvent(h.played[0]); assert.strictEqual(h.controller(), 'settings');
    assert.strictEqual(h.windowHandlers(), 0); assert.strictEqual(h.externalHandlers(), 1);
    assert.strictEqual(h.closeHandlers(), 1); assert.strictEqual(h.visibilityHandlers(), 0);
});

test('session completion after Activity displacement does not steal its controller', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter'); h.paused();
    h.Lampa.Component.add('other', function () { this.create = function () {}; this.render = function () { return h.document.createElement('div'); }; this.start = function () { h.Lampa.Controller.add('other', {}); h.Lampa.Controller.toggle('other'); }; });
    h.Lampa.Activity.push({ component: 'other' }); h.callback(); h.closeEvent(h.played[0]);
    assert.strictEqual(h.controller(), 'other');
});

test('deferred Player launch ignores duplicate OK and content toggles', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]);
    h.press('enter'); h.press('enter'); h.Lampa.Controller.toggle('content'); h.press('enter');
    assert.strictEqual(h.played.length, 1); h.beginPlayer(); h.closePlayer(); h.press('enter');
    assert.strictEqual(h.played.length, 2);
});

['focus', 'visibility'].forEach(function (kind) {
    test('external ' + kind + ' never confirms playback completion', function () {
        var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video()]); h.scroll(71);
        h.press('enter'); h.press('enter'); assert.strictEqual(h.played.length, 1);
        if (kind === 'focus') { h.blurWindow(); h.focusWindow(); }
        else { h.visibility(true); h.visibility(false); }
        assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.viewport().scrollTop, 71);
        h.press('enter'); assert.strictEqual(h.played.length, 1);
        h.press('back'); assert.strictEqual(h.backCount(), 1);
        h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
        assert.strictEqual(h.played.length, 1);
    });
});

test('external player without a completion signal allows Back but keeps the global launch lock', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    assert.match(h.status(), /Back/); h.press('enter'); assert.strictEqual(h.played.length, 1);
    h.press('back'); assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.controller(), 'home');
    h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1);
});

test('external focus without departure does not unlock a duplicate launch', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.focusWindow(); h.press('enter'); assert.strictEqual(h.played.length, 1);
});

test('external focus does not close Settings or release the pending session', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.blurWindow(); h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings'); h.focusWindow();
    assert.strictEqual(h.controller(), 'settings'); h.Lampa.Controller.toggle('content'); h.press('enter');
    h.focusWindow(); h.press('enter');
    assert.strictEqual(h.played.length, 1);
});

test('delayed Activity destruction leaves old callbacks inert after reopen', function () {
    var h = componentHarness({ delayedDestroy: true }); h.open(); h.reply([video()]); h.press('enter');
    h.closePlayer(); h.press('back'); h.open();
    h.callback(0); h.closeEvent(h.played[0]); h.timer();
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.pushed.length, 2);
});


test('external event for another payload and unpaired visibility cannot unlock a launch', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.Lampa.Player.listener.send('external', { url: h.played[0].url }); h.visibility(true); h.visibility(false);
    h.press('back'); assert.strictEqual(h.backCount(), 1); h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.pendingPlayers.length, 1);
    while (h.pendingPlayers.length) h.beginPlayer(); h.closePlayer(); assert.strictEqual(h.controller(), 'content');
});

test('repeated opening adds no duplicate external or DOM listeners', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.open(); h.resumed();
    assert.strictEqual(h.externalHandlers(), 1); assert.strictEqual(h.closeHandlers(), 1);
    assert.strictEqual(h.windowHandlers(), 0); assert.strictEqual(h.visibilityHandlers(), 0);
    h.press('back'); assert.strictEqual(h.externalHandlers(), 1); h.open();
    assert.strictEqual(h.externalHandlers(), 1); assert.strictEqual(h.closeHandlers(), 1);
    assert.strictEqual(h.windowHandlers(), 0); assert.strictEqual(h.visibilityHandlers(), 0);
});

test('plugin-lifetime Player observers remain active when listener.remove is absent', function () {
    var h = componentHarness({ listenerNoRemove: true, externalPlayer: true, deferredPlayer: true });
    assert.strictEqual(h.closeHandlers(), 1); assert.strictEqual(h.externalHandlers(), 1);
    h.open(); h.reply([video()]); h.press('enter');
    while (h.pendingPlayers.length) h.beginPlayer();
    assert.strictEqual(h.launches.length, 1); assert.match(h.status(), /Внешний/);
    h.screen().destroy(); h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1);
    assert.strictEqual(h.closeHandlers(), 1); assert.strictEqual(h.externalHandlers(), 1);
});

test('invalid resource creates no return callback or external session', function () {
    var h = componentHarness(); h.api.cache['0'] = [{ title: 'bad', url: 'javascript:alert(1)' }]; h.open();
    h.press('enter'); h.closeEvent(); assert.strictEqual(h.played.length, 0); assert.strictEqual(h.title(), 'DLNA');
    h.press('back'); assert.strictEqual(h.backCount(), 1);
});

test('identifiable close while Settings is open finishes without closing it', function () {
    var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter');
    h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings'); var before = h.settingsClosed();
    h.closeEvent(h.played[0]); h.callback(); assert.strictEqual(h.controller(), 'settings'); assert.strictEqual(h.settingsClosed(), before);
    h.Lampa.Controller.toggle('content'); h.press('enter'); assert.strictEqual(h.played.length, 2);
});


test('identifiable close restores when Player.callback API is absent', function () {
    var h = componentHarness(); h.Lampa.Player.callback = undefined; h.open(); h.reply([video()]);
    h.press('enter'); h.closeEvent(h.played[0]); assert.strictEqual(h.controller(), 'content');
    h.press('enter'); assert.strictEqual(h.played.length, 2);
});

test('resource two external return retains metadata, focus and scroll without releasing the launch lock', function () {
    var h = componentHarness({ externalPlayer: true }); h.api.cache['0'] = [video('http://media/other'), { title: 'Movie', resources: [
        { url: 'http://media/low', resolution: '640x360' }, { url: 'http://media/high', resolution: '1920x1080' }
    ] }, video('http://media/last')]; h.open(); h.press('down'); h.scroll(63); h.press('enter'); h.press('down'); h.press('enter');
    assert.strictEqual(h.played[0].url, 'http://media/high');
    assert.match(h.rows()[1].textContent, /1920x1080/); h.scroll(28);
    h.press('back');
    assert.strictEqual(h.document.activeElement, h.rows()[1]); assert.strictEqual(h.viewport().scrollTop, 63);
    h.press('back'); assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.controller(), 'home');
    assert.strictEqual(h.requests.length, 0); assert.strictEqual(h.played.length, 1);
});


['player_panel', 'player_rewind', 'player_footer'].forEach(function (name) {
    test('owned completion restores content from ' + name, function () {
        var h = componentHarness(); h.open(); h.reply([video()]); h.press('enter');
        h.Lampa.Controller.add(name, {}); h.Lampa.Controller.toggle(name); h.closePlayer();
        assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.document.activeElement, h.rows()[0]);
    });
});


test('pending launch survives pause/start and executes only once', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]); h.scroll(64);
    h.press('enter'); h.paused(); h.resumed(); h.press('enter');
    assert.strictEqual(h.pendingPlayers.length, 1);
    while (h.pendingPlayers.length) h.beginPlayer();
    assert.strictEqual(h.launches.length, 1); h.closePlayer();
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.viewport().scrollTop, 64);
    assert.strictEqual(h.document.activeElement, h.rows()[0]); h.press('enter'); assert.strictEqual(h.played.length, 2);
});

test('destroy/reopen cannot admit a second pending launch; old close releases only its session', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.screen().destroy(); h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.pendingPlayers.length, 1); h.beginPlayer();
    h.Lampa.Controller.add('settings', {}); h.Lampa.Controller.toggle('settings'); h.closeEvent(h.played[0]);
    assert.strictEqual(h.controller(), 'settings'); h.Lampa.Controller.toggle('content'); h.press('enter');
    assert.strictEqual(h.played.length, 2); h.callback(0); h.closeEvent(h.played[0]);
    h.press('enter'); assert.strictEqual(h.played.length, 2);
});

['follow', 'remove'].forEach(function (method) {
    [undefined, true].forEach(function (value) {
        test('listener ' + method + '=' + value + ' follows the plugin-lifetime subscription policy', function () {
            var h = componentHarness(); h.Lampa.Player.listener[method] = value;
            h.open(); h.reply([video()]); h.press('enter');
            if (method === 'follow') {
                assert.strictEqual(h.played.length, 0); assert.ok(h.notices.length);
            } else {
                assert.strictEqual(h.played.length, 1);
                assert.strictEqual(h.externalHandlers(), 1); assert.strictEqual(h.closeHandlers(), 1);
                h.closePlayer();
            }
            h.press('back'); assert.strictEqual(h.backCount(), 1);
        });
    });
});

test('create.abort permits Back but keeps the lock because Lampa provides no cancellation acknowledgement', function () {
    var h = componentHarness();
    h.Lampa.Player.listener.follow('create', function (event) { event.abort(); });
    h.open(); h.reply([video()]); h.press('enter'); h.press('enter'); h.press('back');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
    assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.controller(), 'home');
    h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
});

test('create.abort registered before DLNA is indistinguishable from an unacknowledged launch', function () {
    var h = componentHarness({ preCreateAbort: true, deferredPlayer: true });
    h.open(); h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
    h.press('back'); assert.strictEqual(h.backCount(), 1);
    h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    while (h.pendingPlayers.length) h.beginPlayer();
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
});


test('Activity displacement and return preserve the pending launch and catalog', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]); h.scroll(82);
    var original = h.pushed[0]; h.press('enter');
    h.Lampa.Component.add('other', function () { this.create = function () {}; this.render = function () { return h.document.createElement('div'); }; this.start = function () {}; });
    h.Lampa.Activity.push({ component: 'other' }); h.activate(original); h.press('enter');
    assert.strictEqual(h.pendingPlayers.length, 1); h.beginPlayer(); h.closePlayer();
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.viewport().scrollTop, 82);
    assert.strictEqual(h.document.activeElement, h.rows()[0]); h.press('back'); assert.strictEqual(h.backCount(), 1);
});

test('late external after owner destruction cannot unlock the new browser', function () {
    var h = componentHarness({ deferredPlayer: true, externalPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.screen().destroy(); h.open(); if (h.requests.length) h.reply([video()]);
    h.beginPlayer(); h.blurWindow(); h.focusWindow(); h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 1);
    h.press('back'); assert.strictEqual(h.backCount(), 1); h.open(); if (h.requests.length) h.reply([video()]); h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 1);
});


test('late internal close restores current replacement catalog without manual controller repair', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video()]); h.press('enter');
    h.screen().destroy(); h.open(); if (h.requests.length) h.reply([video()]); h.scroll(88);
    h.press('enter'); while (h.pendingPlayers.length) h.beginPlayer();
    assert.strictEqual(h.launches.length, 1); h.closePlayer();
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.viewport().scrollTop, 88);
    assert.strictEqual(h.document.activeElement, h.rows()[0]); h.press('back'); assert.strictEqual(h.backCount(), 1);
});

test('external focus changes never acknowledge completion', function () {
    var h = componentHarness({ externalPlayer: true, deferredPlayer: true }); h.open(); h.reply([video()]);
    h.press('enter'); while (h.pendingPlayers.length) h.beginPlayer();
    h.blurWindow(); h.focusWindow(); h.visibility(true); h.visibility(false); h.press('enter');
    while (h.pendingPlayers.length) h.beginPlayer(); assert.strictEqual(h.launches.length, 1);
    h.press('back'); assert.strictEqual(h.backCount(), 1); h.open(); if(h.requests.length)h.reply([video()]);
    h.press('enter'); while(h.pendingPlayers.length)h.beginPlayer(); assert.strictEqual(h.launches.length, 1);
});

test('abort permits Activity exit while keeping cross-instance launch exclusion', function () {
    var h = componentHarness({ deferredPlayer: true }); h.Lampa.Player.listener.follow('create', function(e){e.abort();});
    h.open(); h.reply([video()]); h.press('enter'); h.press('back'); assert.strictEqual(h.backCount(), 1);
    h.open(); if(h.requests.length)h.reply([video()]); h.press('enter');
    while(h.pendingPlayers.length)h.beginPlayer(); assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
});

test('late external after destroy is observed independently and cannot be acknowledged by focus', function () {
    var h=componentHarness({ deferredPlayer:true, externalPlayer:true }); h.open(); h.reply([video()]); h.press('enter');
    h.screen().destroy(); h.open(); if(h.requests.length)h.reply([video()]);
    while(h.pendingPlayers.length)h.beginPlayer(); assert.match(h.status(), /Внешний/i);
    h.blurWindow(); h.focusWindow(); h.press('enter'); assert.strictEqual(h.played.length,1);
    h.press('back'); assert.strictEqual(h.backCount(),1);
});

test('pending playback still permits folder browsing and Back without starting another player', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([folder('A'), video()]); h.press('down'); h.press('enter');
    assert.strictEqual(h.played.length, 1);
    h.press('up'); h.press('enter');
    assert.match(h.requests[0].body, /<ObjectID>A<\/ObjectID>/); h.reply([folder('B')]);
    h.press('enter'); assert.strictEqual(h.requests.length, 1);
    assert.match(h.requests[0].body, /<ObjectID>B<\/ObjectID>/); h.reply([folder('C')]);
    h.press('back'); assert.strictEqual(h.requests.length, 0); assert.strictEqual(h.played.length, 1);
    h.press('back'); h.press('back'); h.press('back'); assert.strictEqual(h.backCount(), 1);
});

test('create.abort leaves folder navigation usable and keeps second playback blocked', function () {
    var h = componentHarness({ preCreateAbort: true }); h.open(); h.reply([video(), folder('A')]);
    h.press('enter'); assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
    h.press('down'); h.press('enter');
    assert.strictEqual(h.requests.length, 1); assert.match(h.requests[0].body, /<ObjectID>A<\/ObjectID>/);
    h.reply([video()]);
    var noticeCount = h.notices.length;
    h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 0);
    assert.strictEqual(h.requests.length, 0);
    assert.strictEqual(h.notices.length, noticeCount + 1);
    assert.match(String(h.notices[h.notices.length - 1]), /previous.*launch|not completed/i);
});
test('pending external session allows Root A B browsing and preserves lock', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video(), folder('A')]);
    h.press('enter'); assert.strictEqual(h.launches.length, 1);
    h.press('down'); h.press('enter'); h.reply([folder('B')]); h.press('enter'); h.reply([folder('C')]);
    h.press('back'); assert.strictEqual(h.title(), 'A'); h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    h.press('up');
    var noticeCount = h.notices.length;
    h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 1);
    assert.strictEqual(h.requests.length, 0); assert.strictEqual(h.notices.length, noticeCount + 1);
    assert.match(String(h.notices[h.notices.length - 1]), /previous.*launch|not completed/i);
});
test('pending multi-resource and legacy selections notify without replacing the launch', function () {
    var h = componentHarness({ externalPlayer: true });
    h.api.cache['0'] = [video(), { title: 'Multi', resources: [
        { url: 'http://media/one', resolution: '640x360' }, { url: 'http://media/two', resolution: '1920x1080' }
    ] }, video('http://media/legacy')];
    function assertBlockedSelection() {
        var calls = h.played.length;
        var starts = h.launches.length;
        var noticeCount = h.notices.length;
        h.press('enter');
        assert.strictEqual(h.played.length, calls);
        assert.strictEqual(h.launches.length, starts);
        assert.strictEqual(h.notices.length, noticeCount + 1);
        assert.match(String(h.notices[h.notices.length - 1]), /previous.*launch|not completed/i);
    }
    h.open(); h.press('enter'); assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 1);
    h.press('down'); h.press('enter'); assert.match(h.title(), /Multi/); h.scroll(47);
    var firstResource = h.document.activeElement;
    assertBlockedSelection();
    assert.strictEqual(h.document.activeElement, firstResource); assert.strictEqual(h.viewport().scrollTop, 47);
    h.press('down'); var secondResource = h.document.activeElement; assertBlockedSelection();
    assert.strictEqual(h.document.activeElement, secondResource);
    h.press('back'); h.press('down'); h.press('down'); assertBlockedSelection();
    assert.strictEqual(h.requests.length, 0);
});
test('pending launch survives Root exit and reopened catalog can browse folders', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([folder('A'), video()]); h.press('down'); h.press('enter');
    h.press('back'); assert.strictEqual(h.backCount(), 1); assert.strictEqual(h.played.length, 1);
    h.open(); h.press('up'); h.press('enter');
    assert.strictEqual(h.requests.length, 1); assert.match(h.requests[0].body, /<ObjectID>A<\/ObjectID>/);
    h.reply([folder('B')]); h.press('enter'); assert.match(h.requests[0].body, /<ObjectID>B<\/ObjectID>/);
    assert.strictEqual(h.played.length, 1);
});

test('pending Browse can be cancelled with Back without changing the launch lock', function () {
    var h = componentHarness({ externalPlayer: true }); h.open(); h.reply([video(), folder('A')]); h.press('enter');
    h.press('down'); h.press('enter'); assert.strictEqual(h.requests.length, 1);
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    h.reply([folder('late')]); assert.strictEqual(h.title(), 'DLNA');
    h.press('up');
    var noticeCount = h.notices.length;
    h.press('enter');
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.launches.length, 1);
    assert.strictEqual(h.notices.length, noticeCount + 1);
    assert.match(String(h.notices[h.notices.length - 1]), /previous.*launch|not completed/i);
    assert.strictEqual(h.requests.length, 0);
});
test('late close during Browse preserves current folder and allows next playback after completion', function () {
    var h = componentHarness({ deferredPlayer: true }); h.open(); h.reply([video(), folder('A')]); h.press('enter');
    h.press('down'); h.press('enter'); assert.strictEqual(h.requests.length, 1);
    h.beginPlayer(); assert.strictEqual(h.launches.length, 1);
    h.closePlayer(); assert.strictEqual(h.controller(), 'content');
    h.reply([folder('B')]); assert.strictEqual(h.title(), 'A'); h.press('enter');
    h.reply([video('http://media/other'), video('http://media/next'), video('http://media/last')]); assert.strictEqual(h.title(), 'B');
    h.press('down'); h.scroll(31); h.press('enter'); assert.strictEqual(h.played.length, 2);
    while (h.pendingPlayers.length) h.beginPlayer();
    assert.strictEqual(h.pendingPlayers.length, 0); assert.strictEqual(h.launches.length, 2);
    assert.strictEqual(h.launches[1].url, 'http://media/next');
    assert.strictEqual(h.requests.length, 0);
    h.closePlayer();
    assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.launches.length, 2);
    assert.strictEqual(h.document.activeElement, h.rows()[1]); assert.strictEqual(h.viewport().scrollTop, 31);
    assert.strictEqual(h.pendingPlayers.length, 0); assert.strictEqual(h.requests.length, 0);
});

function diagnosticNumbers(message) {
    return message.split('<br>').map(function (line) {
        var match = /^(?:#)(\d+)\s/.exec(line);
        return match ? Number(match[1]) : null;
    }).filter(function (number) { return number !== null; });
}

function readPlaybackDiagnosticPages(h) {
    var pages = [];
    h.showPlaybackDiagnosticLog();
    var message = h.lastNotice().message;
    pages.push(message);
    for (var i = 0; i < 30 && !/No older playback diagnostic events remain|Playback diagnostic log is empty/.test(message); i++) {
        h.showPreviousPlaybackDiagnosticLog();
        message = h.lastNotice().message;
        pages.push(message);
    }
    return pages.join('\n');
}

test('blocked launch is logged against the pending attempt without media details', function () {
    var h = componentHarness({ externalPlayer: true });
    h.open(); h.reply([video('http://media/private?token=SECRET')]); h.press('enter');
    h.press('enter');
    var lines = readPlaybackDiagnosticPages(h);

    assert.match(lines, /launch-blocked \[p1\]/);
    assert.match(lines, /phase=external/);
    assert.match(lines, /ctrl=content/);
    assert.match(lines, /activity=dlna_bridge_browser/);
    assert.doesNotMatch(lines, /private|SECRET/);
    assert.strictEqual(h.played.length, 1);
    assert.strictEqual(h.launches.length, 1);
});

test('notification pages use a fixed safe snapshot and leave Select, Keypad, cache and playback untouched', function () {
    var h = componentHarness({ externalPlayer: true });
    var item = video('http://media/private?token=SECRET');
    item.title = 'PRIVATE_TITLE';
    h.open(); h.reply([item]); h.press('enter');
    for (var i = 0; i < 13; i++) h.Lampa.Player.listener.send('start', {});

    var cache = h.api.cache;
    var played = h.played.length;
    var controller = h.controller();
    h.showPlaybackDiagnosticLog();
    var first = h.lastNotice();
    var firstNumbers = diagnosticNumbers(first.message);
    assert.strictEqual(first.params.time, 30000);
    assert.strictEqual(firstNumbers.length, 6);
    assert.match(first.message, /oldest first/);
    assert.match(first.message, /Previous events/);
    assert.doesNotMatch(first.message, /SECRET|PRIVATE_TITLE|media\//);

    for (var j = 0; j < 3; j++) h.Lampa.Player.listener.send('start', {});
    var pages = [first.message];
    var message = first.message;
    for (var k = 0; k < 30 && !/No older playback diagnostic events remain/.test(message); k++) {
        h.showPreviousPlaybackDiagnosticLog();
        message = h.lastNotice().message;
        pages.push(message);
    }
    assert.match(message, /No older playback diagnostic events remain/);

    var allNumbers = [];
    pages.forEach(function (page) {
        var numbers = diagnosticNumbers(page);
        assert.ok(numbers.length <= 6);
        allNumbers = allNumbers.concat(numbers);
    });
    pages.forEach(function (page) {
        var pageNumbers = diagnosticNumbers(page);
        var sortedPage = pageNumbers.slice(0).sort(function (a, b) { return a - b; });
        assert.deepStrictEqual(pageNumbers, sortedPage);
    });
    for (var pageIndex = 1; pageIndex < pages.length; pageIndex++) {
        var older = diagnosticNumbers(pages[pageIndex]);
        var newer = diagnosticNumbers(pages[pageIndex - 1]);
        if (older.length && newer.length) assert.ok(older[older.length - 1] < newer[0]);
    }
    assert.strictEqual(new Set(allNumbers).size, allNumbers.length);
    assert.strictEqual(Math.max.apply(Math, allNumbers), Math.max.apply(Math, firstNumbers));
    assert.strictEqual(h.selectObserverCount(), 0);
    assert.strictEqual(h.keypadBackHandlers(), 0);
    assert.strictEqual(h.controller(), controller);
    assert.strictEqual(h.api.cache, cache);
    assert.strictEqual(h.played.length, played);
    assert.strictEqual(h.requests.length, 0);

    var noticeCount = h.notices.length;
    h.press('enter');
    assert.strictEqual(h.played.length, played);
    assert.strictEqual(h.notices.length, noticeCount + 1);
    assert.strictEqual(h.controller(), controller);
    assert.strictEqual(h.api.cache, cache);
});

test('empty journal, previous-before-show, end of snapshot, and clear are explicit', function () {
    var h = componentHarness();
    var cache = h.api.cache;
    h.showPreviousPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Show the playback diagnostic log first/);
    h.showPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Playback diagnostic log is empty/);
    h.showPreviousPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Playback diagnostic log is empty/);
    h.clearPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Playback diagnostic log cleared/);
    h.showPreviousPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Show the playback diagnostic log first/);
    assert.strictEqual(h.api.cache, cache);
    assert.strictEqual(h.played.length, 0);
    assert.strictEqual(h.requests.length, 0);
    assert.strictEqual(h.selectObserverCount(), 0);
    assert.strictEqual(h.keypadBackHandlers(), 0);
});

test('playback diagnostic notifications preserve callback and close order without media data', function () {
    var h = componentHarness();
    var item = video('http://192.168.1.1:8200/video.mp4?token=SECRET_VALUE');
    item.title = 'PRIVATE_VIDEO_TITLE';
    h.open(); h.reply([item]); h.press('enter'); h.closePlayer();
    var lines = readPlaybackDiagnosticPages(h).replace(/<br>/g, '\n');

    assert.match(lines, /pending-set/);
    assert.match(lines, /callback-register/);
    assert.match(lines, /player-play-before/);
    assert.match(lines, /player-create/);
    assert.match(lines, /player-start/);
    assert.match(lines, /callback-enter/);
    assert.match(lines, /completion-accepted/);
    assert.match(lines, /player-close/);
    function sequenceFor(eventName) {
        var row = lines.split('\n').filter(function (line) { return line.indexOf(' ' + eventName + ' [') >= 0; })[0];
        assert.ok(row, eventName);
        return Number(/^#(\d+)/.exec(row)[1]);
    }
    assert.ok(sequenceFor('pending-set') < sequenceFor('player-create'));
    assert.ok(sequenceFor('player-create') < sequenceFor('player-start'));
    assert.ok(sequenceFor('player-start') < sequenceFor('callback-enter'));
    assert.ok(sequenceFor('callback-enter') < sequenceFor('completion-accepted'));
    assert.ok(sequenceFor('completion-accepted') < sequenceFor('pending-cleared'));
    assert.ok(sequenceFor('pending-cleared') < sequenceFor('player-close'));
    assert.doesNotMatch(lines, /SECRET_VALUE|PRIVATE_VIDEO_TITLE|192\.168\.1\.1/);
});

test('playback diagnostics accept a matching close when callback API is absent', function () {
    var h = componentHarness();
    h.Lampa.Player.callback = undefined;
    h.open(); h.reply([video()]); h.press('enter'); h.closeEvent(h.played[0]);
    h.screen().select(0);
    var lines = readPlaybackDiagnosticPages(h);

    assert.strictEqual(h.played.length, 2);
    assert.match(lines, /api-unavailable/);
    assert.match(lines, /sameData=yes/);
    assert.match(lines, /close-data-identity/);
});

test('playback diagnostics do not claim callback replacement from an unobserved setter', function () {
    var h = componentHarness();
    h.open(); h.reply([video()]); h.press('enter');
    h.Lampa.Player.callback(function () {});
    h.closeEvent(h.played[0]);
    h.screen().select(0);
    var lines = readPlaybackDiagnosticPages(h);

    assert.strictEqual(h.played.length, 2);
    assert.match(lines, /callback-register/);
    assert.match(lines, /close-data-identity/);
    assert.doesNotMatch(lines, /callback-overwritten/);
});

test('playback diagnostics preserve lock and explain close without data or with copied data', function () {
    ['missing', 'copy'].forEach(function (variant) {
        var h = componentHarness();
        h.Lampa.Player.callback = undefined;
        h.open(); h.reply([video()]); h.press('enter');
        if (variant === 'missing') h.closeEvent();
        else h.closeEvent({ url: h.played[0].url, title: h.played[0].title, quality: h.played[0].quality });
        var calls = h.played.length;
        var noticeCount = h.notices.length;
        h.screen().select(0);
        var lines = readPlaybackDiagnosticPages(h);

        assert.strictEqual(h.played.length, calls);
        assert.ok(h.notices.length > noticeCount);
        assert.match(lines, /completion-rejected/);
        assert.match(lines, variant === 'missing' ? /close-data-missing/ : /close-data-mismatch/);
        assert.match(lines, variant === 'missing' ? /data=no/ : /sameData=no/);
        assert.doesNotMatch(lines, /video\.mp4/);
    });
});

test('diagnostic log pagination keeps the cap at 100 and adds no Select or Keypad subscriptions', function () {
    var h = componentHarness();
    assert.strictEqual(h.createHandlers(), 1);
    assert.strictEqual(h.startHandlers(), 1);
    h.api.init();
    assert.strictEqual(h.createHandlers(), 1);
    assert.strictEqual(h.startHandlers(), 1);
    for (var i = 0; i < 130; i++) h.Lampa.Player.listener.send('start', {});

    h.showPlaybackDiagnosticLog();
    var pages = [h.lastNotice().message];
    var current = pages[0];
    for (var j = 0; j < 30 && !/No older playback diagnostic events remain/.test(current); j++) {
        h.showPreviousPlaybackDiagnosticLog();
        current = h.lastNotice().message;
        pages.push(current);
    }
    var allNumbers = [];
    pages.forEach(function (page) { allNumbers = allNumbers.concat(diagnosticNumbers(page)); });
    allNumbers = allNumbers.filter(function (number) { return number !== null; });
    assert.strictEqual(allNumbers.length, 100);
    assert.strictEqual(Math.min.apply(Math, allNumbers), 31);
    assert.strictEqual(Math.max.apply(Math, allNumbers), 130);
    assert.match(current, /No older playback diagnostic events remain/);
    assert.strictEqual(h.selectObserverCount(), 0);
    assert.strictEqual(h.keypadBackHandlers(), 0);
});

test('viewing and clearing playback diagnostics do not change external lock or catalog cache', function () {
    var h = componentHarness({ externalPlayer: true });
    h.open(); h.reply([video()]); h.press('enter');
    var cache = h.api.cache;
    var calls = h.played.length;
    var controller = h.controller();
    h.showPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /player-external/);
    assert.strictEqual(h.api.cache, cache);
    h.clearPlaybackDiagnosticLog();
    assert.strictEqual(h.api.cache, cache);
    h.showPlaybackDiagnosticLog();
    assert.match(h.lastNotice().message, /Playback diagnostic log is empty/);
    h.press('enter');
    assert.strictEqual(h.played.length, calls);
    assert.strictEqual(h.controller(), controller);
    assert.strictEqual(h.requests.length, 0);
    assert.strictEqual(h.closeHandlers(), 1);
    assert.strictEqual(h.externalHandlers(), 1);
});

test('playback diagnostic log records owner pause, destruction, reopen and handoff', function () {
    var h = componentHarness({ externalPlayer: true });
    h.open(); h.reply([video()]); h.press('enter');
    h.press('back');
    h.open();
    assert.strictEqual(h.requests.length, 0);
    var lines = readPlaybackDiagnosticPages(h);

    assert.match(lines, /browser-pause/);
    assert.match(lines, /restore-owner-detached/);
    assert.match(lines, /browser-destroy/);
    assert.match(lines, /browser-start/);
    assert.match(lines, /restore-owner-attached/);
    assert.match(lines, /activity=dlna_bridge_browser/);
    assert.match(lines, /ctrl=/);
    assert.strictEqual(h.played.length, 1);
    assert.strictEqual(h.title(), 'DLNA');
    assert.strictEqual(h.requests.length, 0);
    assert.strictEqual(h.selectObserverCount(), 0);
    assert.strictEqual(h.keypadBackHandlers(), 0);
});
