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
    var returnTasks = [];
    var returnEvents = [];
    var inputEvents = [];
    var timeoutSequence = 0;
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
    var activityStack = [];
    var activityListener = createListener();
    var settingsName = null;
    var settingsVisible = false;
    var settingsOpens = [];
    var settingsRows = [];
    var settingsIndex = 0;
    var navigation = [];
    var settingsBody;
    var settingsMain;
    var addressState = '';
    var document;
    var documentFocused = true;
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
    document.visibilityState = 'visible';
    if (!options.noDocumentFocus) document.hasFocus = function () {
        if (options.throwDocumentFocus) throw new Error('hasFocus unavailable');
        return documentFocused;
    };
    document.querySelector = function (selector) {
        var found = null;
        function visit(node) {
            if (selector.split(',').some(function (part) { return (' ' + node.className + ' ').indexOf(' ' + part.substring(1) + ' ') >= 0; })) found = node;
            node.children.forEach(visit);
        }
        visit(document.body); return found;
    };
    function dispatch(node, name) { (node.events[name] || []).slice().forEach(function (fn) { fn({ target: node }); }); }
    function $(node) {
        if (typeof node === 'string') node = element('div');
        var nodes = Array.isArray(node) ? node : [node];
        return { 0: nodes[0], length: nodes.length,
            on: function (names, fn) { nodes.forEach(function (item) { names.split(' ').forEach(function (name) { item.addEventListener(name, fn); }); }); return this; },
            text: function (value) { nodes[0].textContent = value; return this; },
            off: function () { nodes.forEach(function (item) { item.events = {}; }); return this; },
            find: function () { return $(nodes[0].querySelectorAll('.selector')); }
        };
    }
    var modalListener = createListener();
    var controllerListener = createListener();
    var globalListener = createListener();
    var windows = [];
    var modal = null;
    var modalOpened = false;
    var modalHook = null;
    function modalStage(stage, own) { if (modalHook) modalHook(stage, own); }
    var confirmations = [];
    var nativePlayers = [];
    var nativeLaunches = [];
    var settingsRow = element('div');
    settingsRow.addEventListener('hover:enter', function () { recover(); });
    var settingsListener = createListener();
    var playerListener = createListener();
    var selectListener = createListener();
    var keypadListener = createListener();
    var Lampa = {
        SettingsApi: { addComponent: function () {}, addParam: function (param) { params.push(param); } },
        Storage: { field: function () { return ''; } },
        Lang: { add: function () {}, translate: function (value) { return value; } },
        Listener: globalListener,
        Platform: { is: function (name) { return name === 'android'; } },
        Settings: { listener: settingsListener },
        Noty: { show: function (message, params) { notices.push(message); notyCalls.push({ message: message, params: params || {} }); } },
        Component: { add: function (name, constructor) { registry[name] = constructor; } },
        Activity: {
            listener: activityListener,
            all: function () { return activityStack; },
            mixState: function (value) { addressState = value || ''; },
            active: function () { return active; },
            push: function (params) {
                globalListener.send('activity', { type: 'init' });
                if (active && active.activity && active.activity.component.pause) active.activity.component.pause();
                var screen = new registry[params.component](params);
                var slide = { component: screen, loader: function () {} };
                screen.activity = slide;
                active = { component: params.component, activity: slide };
                if (options.nativeNavigation) activityStack.push(active);
                pushed.push(active);
                screen.create();
                document.body.appendChild(screen.render(true));
                if (options.nativeNavigation) startActivity(active);
                else screen.start();
            },
            backward: function () {
                if (options.nativeNavigation) {
                    activityListener.send('backward', { count: activityStack.length });
                    backwards++;
                    if (options.backwardThrows) throw new Error('backward failure');
                    if (activityStack.length === 1) return;
                    var departedActivity = activityStack.pop();
                    timers.push({ delay: 200, callback: function () {
                        departedActivity.activity.component.destroy();
                        globalListener.send('activity', { type: 'destroy', object: departedActivity });
                    } });
                    active = activityStack[activityStack.length - 1];
                    startActivity(active);
                    globalListener.send('activity', { type: 'archive', object: active });
                    return;
                }
                globalListener.send('activity', { type: 'destroy' });
                backwards++;
                if (active && active.activity) { var departed = active.activity.component; if (options.delayedDestroy) timers.push({ callback: function () { departed.destroy(); }, delay: 200 }); else departed.destroy(); }
                active = null;
                controller = 'home';
            }
        },
        Controller: {
            listener: controllerListener,
            add: function (name, callbacks) { controllers[name] = callbacks; },
            enabled: function () { return { name: controller, controller: controllers[controller] }; },
            toggle: function (name) {
                if (options.nativeNavigation && controllers[controller] && controllers[controller].gone) controllers[controller].gone(name);
                if (name === 'content') {
                    contentToggles++; if (controller === 'settings') settingsClosed++;
                    if (options.nativeNavigation && settingsVisible) { settingsVisible = false; settingsName = null; settingsListener.send('close'); }
                }
                controller = name;
                if (controllers[name] && controllers[name].toggle) controllers[name].toggle();
                controllerListener.send('toggle', { name: name });
            },
            // Lampa 6b5d921: Controller.enter dispatches once to its active handler OR focused node.
            enter: function () { if (controllers[controller] && controllers[controller].enter) controllers[controller].enter(); else if (document.activeElement) dispatch(document.activeElement, 'hover:enter'); },
            windowOpen: function (name, check) { var entry = { name: name, below: controller, check: check }; windows.push(entry); return entry; },
            windowTop: function () { windows = windows.filter(function (entry) { return !entry.check || entry.check(); }); return windows[windows.length - 1] || false; },
            windowClose: function (entry) { var i = windows.indexOf(entry); if (i < 0) return; var top = i === windows.length - 1; windows.splice(i, 1); var below = Lampa.Controller.windowTop(); if (top && controller === entry.name && below && below.name === entry.below) Lampa.Controller.toggle(below.name); },
            collectionSet: function (html) { navigation = (html[0] || html).querySelectorAll('.selector'); },
            collectionFocus: function (row) {
                document.body.querySelectorAll('.selector').forEach(function (node) { node.className = node.className.replace(/\s+focus\b/g, ''); });
                row.className += ' focus'; document.activeElement = row; dispatch(row, 'hover:focus');
            }
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
                function begin() { launches.push(data); if (options.externalPlayer) { nativePlayers.push(data); playerListener.send('external', data); } else { playerListener.send('start', data); playerOpened = true; controller = 'player'; } }
                if (options.deferredPlayer) pendingPlayers.push(begin); else begin(); }
        },
        Reguest: function () {
            this.timeout = function () {};
            this.clear = function () {};
            this.native = function (url, success, failure, body, params) { requests.push({ url: url, success: success, failure: failure, body: body, params: params }); };
        }
    };
    // Opt-in navigation model: backward pops/starts synchronously, destroys after 200ms.
    // Settings is an overlay, not an Activity. create sends open BEFORE toggling its controller.
    function startActivity(activity) {
        Lampa.Controller.add('content', { back: function () { Lampa.Activity.backward(); } });
        Lampa.Controller.toggle('content');
        addressState = 'activity=' + activity.component;
        if (activity.activity.component.start) activity.activity.component.start();
        globalListener.send('activity', { type: 'start', object: activity });
    }
    if (options.nativeNavigation) {
        active = { component: 'main', activity: { component: {} } };
        activityStack.push(active);
        settingsBody = element('settings-body'); document.body.appendChild(settingsBody);
        settingsMain = element('settings-main');
        var mainRow = element('setting'); mainRow.className = 'selector'; settingsMain.appendChild(mainRow);
        mainRow.addEventListener('hover:enter', function () { Lampa.Settings.create('dlna_bridge'); });
        function settingsContent(node) {
            if (node.parentNode) node.parentNode.removeChild(node);
            while (settingsBody.firstChild) settingsBody.removeChild(settingsBody.firstChild);
            settingsBody.appendChild(node);
        }
        Lampa.Controller.add('settings', {
            toggle: function () {
                if (settingsMain.parentNode) settingsMain.parentNode.removeChild(settingsMain);
                settingsName = 'main'; settingsOpens.push('main');
                settingsListener.send('open', { name: 'main' });
                settingsContent(settingsMain);
                Lampa.Controller.collectionSet($(settingsMain));
                Lampa.Controller.collectionFocus(mainRow, $(settingsMain));
                settingsVisible = true;
                Lampa.Activity.mixState('settings=main');
            },
            gone: function (to) { if (to !== 'settings_component') settingsVisible = false; },
            back: function () {
                if (settingsMain.parentNode) settingsMain.parentNode.removeChild(settingsMain);
                Lampa.Controller.toggle('head'); Lampa.Activity.mixState(); settingsListener.send('close');
            }
        });
        Lampa.Settings.create = function (name) {
            var componentBody = element('settings-component');
            settingsRows = params.filter(function (param) { return param.component === name; }).map(function (param) {
                var row = element('setting'); row.className = 'selector'; componentBody.appendChild(row);
                row.param = param;
                row.addEventListener('hover:enter', param.onChange || function () {});
                return row;
            });
            settingsIndex = 0;
            Lampa.Controller.add('settings_component', {
                toggle: function () { Lampa.Controller.collectionSet($(componentBody)); Lampa.Controller.collectionFocus(settingsRows[settingsIndex], $(componentBody)); },
                up: function () { settingsIndex = Math.max(0, settingsIndex - 1); document.activeElement = settingsRows[settingsIndex]; },
                down: function () { settingsIndex = Math.min(settingsRows.length - 1, settingsIndex + 1); document.activeElement = settingsRows[settingsIndex]; },
                back: function () { Lampa.Controller.toggle('settings'); }
            });
            settingsContent(componentBody);
            settingsOpens.push(name);
            settingsListener.send('open', { name: name, body: settingsRows });
            settingsName = name;
            Lampa.Controller.toggle('settings_component');
            Lampa.Activity.mixState('settings=' + name);
        };
        Lampa.Select.show = function (params) {
            selectListener.send('preshow', { active: params });
            var node = element('select'); node.className = 'selectbox--open'; var row = element('button'); row.className = 'selector'; node.appendChild(row);
            row.addEventListener('hover:enter', function () { params.onSelect(params.items[0]); });
            document.body.appendChild(node);
            selectListener.send('fullshow', { active: params, html: [node] });
            Lampa.Activity.mixState('select=open');
            var frame = Lampa.Controller.windowOpen('select', function () { return !!node.parentNode; });
            Lampa.Controller.add('select', {
                toggle: function () { Lampa.Controller.collectionSet($(node)); Lampa.Controller.collectionFocus(row, $(node)); },
                back: function () { node.parentNode.removeChild(node); Lampa.Controller.windowClose(frame); }
            });
            Lampa.Controller.toggle('select');
            return node;
        };
    }
    // Contract model of native Modal.open/buttons/register/close at Lampa 6b5d921.
    // No custom plugin stack; close() uses Controller.windowClose, not a test toggle to content.
    function registerModal(own) {
        Lampa.Controller.add('modal', {
            toggle: function () {
                if (options.nativeNavigation) Lampa.Controller.collectionSet($(own.node));
                document.activeElement = own.buttons[0];
            },
            down: function () { document.activeElement = own.buttons[1]; },
            up: function () { document.activeElement = own.buttons[0]; },
            back: own.params.onBack
        });
    }
    Lampa.Modal = {
        listener: modalListener,
        open: function (params) {
            var own = { params: params, node: null, buttons: [], previous: modalOpened ? modal : null };
            modalListener.send('preshow', { active: params });
            modalStage('before-dom', own);
            own.node = element('modal');
            own.node.className = 'modal';
            modal = own; confirmations.push(own);
            document.body.appendChild(own.node);
            if (params.html) own.node.appendChild(params.html[0]);
            params.buttons.forEach(function (button) {
                var node = element('button'); own.buttons.push(node);
                if (options.nativeNavigation) { node.className = 'selector'; own.node.appendChild(node); }
                node.addEventListener('hover:enter', function () { button.onSelect(); });
            });
            modalStage('after-dom', own);
            modalListener.send('fullshow', { active: params, html: [own.node] });
            own.frame = Lampa.Controller.windowOpen('modal', function () { return !!own.node.parentNode; });
            registerModal(own);
            Lampa.Controller.toggle('modal');
            modalStage('after-toggle', own);
            modalOpened = true;
            modalStage('after-open', own);
        },
        opened: function () { return modalOpened; },
        render: function () { return [modal && modal.node]; },
        close: function () {
            var own = modal;
            own.node.parentNode.removeChild(own.node);
            modalListener.send('close', { active: own.params });
            modalOpened = false; modal = own.previous;
            if (modal) { modalOpened = true; registerModal(modal); }
            if (own.frame) Lampa.Controller.windowClose(own.frame);
        }
    };
    if (!options.nativeNavigation) Lampa.Controller.add('settings_component', { toggle: function () { document.activeElement = settingsRow; } });
    function recover() {
        var param = params.filter(function (item) { return item.param.name === 'dlna_bridge_android_recovery'; })[0];
        assert.ok(param, 'Android recovery action registered'); param.onChange();
    }
    function settingsRecovery() { Lampa.Controller.toggle('settings_component'); recover(); }
    if (options.preCreateAbort) playerListener.follow('create', function (event) { event.abort(); });
    if (options.listenerNoRemove) playerListener.remove = undefined;
    var window = { Lampa: Lampa, appready: false, DOMParser: TestDOMParser, $: $,
        addEventListener: function (name, fn) { (windowEvents[name] || (windowEvents[name] = [])).push(fn); },
        removeEventListener: function (name, fn) { windowEvents[name] = (windowEvents[name] || []).filter(function (f) { return f !== fn; }); } };
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8').replace(
        'if (window.appready) init();',
        'window.__test = { init: init, openCatalog: openCatalog, cache: cache, records: playbackDiagnosticRecords, observation: function () { return returnDiagnosticAttempt; }, pending: function () { return pendingPlayback; }, autoReturn: function () { return androidReturnState; }, returnInput: function () { return androidReturnInput; } }; if (window.appready) init();'
    );
    if (options.failDiagnosticWrites) source = source.replace('var playbackDiagnosticRecords = [];', 'var playbackDiagnosticRecords = []; playbackDiagnosticRecords.push = function () { throw new Error("diagnostic write failed"); };');
    if (options.failDiagnosticRegistration) source = source.replace('registerPlaybackDiagnosticListeners();', '/* diagnostic subscriptions unavailable */');
    vm.runInNewContext(source, { window: window, Lampa: Lampa, document: document, DOMParser: TestDOMParser,
        console: { log: function () {}, error: function () {} },
        setTimeout: function (fn, delay) {
            var task = { callback: fn, delay: delay, id: ++timeoutSequence };
            (delay === 0 ? returnTasks : timers).push(task); return task.id;
        }, clearTimeout: function (id) {
            [timers, returnTasks].forEach(function (queue) {
                for (var i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
            });
        }
    });
    window.__test.init();
    var api = window.__test;
    function screen() { return active && active.activity.component; }
    function root() { return screen().render(true); }
    function viewport() { return root().children[2]; }
    function emitReturn(type) {
        if (type === 'hidden' || type === 'visible') {
            document.hidden = type === 'hidden'; document.visibilityState = type;
            dispatch(document, 'visibilitychange');
        } else {
            documentFocused = type === 'focus';
            (windowEvents[type] || []).slice().forEach(function (fn) { fn(); });
        }
    }
    function emitInput(type, repeat) {
        var event = { code: 13, enabled: true, event: { repeat: !!repeat } };
        keypadListener.send(type, event);
        if (type === 'keyup') { keypadListener.send('enter', event); Lampa.Controller.enter(); }
    }
    return {
        returnTasks: returnTasks, returnEvents: returnEvents, inputEvents: inputEvents,
        queueReturn: function (type) { returnEvents.push(function () { emitReturn(type); }); },
        queueInput: function (type, repeat) { inputEvents.push(function () { emitInput(type, repeat); }); },
        nextReturn: function () { assert.ok(returnEvents.length); returnEvents.shift()(); },
        nextInput: function () { assert.ok(inputEvents.length); inputEvents.shift()(); },
        flushReturnTasks: function () { while (returnTasks.length) returnTasks.shift().callback(); },
        freshOK: function () { emitInput('keydown'); emitInput('keyup'); },
        navigation: function () { return navigation; },
        settingsBody: function () { return settingsBody; },
        addressState: function () { return addressState; },
        settingsName: function () { return settingsName; },
        settingsVisible: function () { return settingsVisible; },
        settingsOpens: settingsOpens,
        settingsBoot: function () { Lampa.Controller.toggle('settings'); Lampa.Settings.create('dlna_bridge'); },
        setting: function (name) {
            var index = settingsRows.findIndex(function (row) { return row.param.param.name === 'dlna_bridge_' + name; });
            assert.ok(index >= 0, name);
            while (settingsIndex < index) controllers[controller].down();
            while (settingsIndex > index) controllers[controller].up();
            Lampa.Controller.enter();
        },
        launches: launches, pendingPlayers: pendingPlayers,
        nativePlayers: nativePlayers, nativeLaunches: nativeLaunches, confirmations: confirmations,
        modalHook: function (fn) { modalHook = fn; },
        modalNodes: function () { return document.body.children.filter(function (node) { return confirmations.some(function (own) { return own.node === node; }); }).length; },
        modalWindows: function () { Lampa.Controller.windowTop(); return windows.length; },
        beginNative: function (index) { assert.ok(nativePlayers.length); nativeLaunches.push(nativePlayers.splice(index || 0, 1)[0]); },
        recover: recover, settingsRecovery: settingsRecovery,
        // Native keyup sends enter before Controller.enter; it does not redispatch after a modal closes.
        keyup: function () { emitInput('keyup'); },
        recoveryHandlers: function () { return [globalListener.count('activity'), controllerListener.count('toggle'), modalListener.count('preshow'), modalListener.count('fullshow'), modalListener.count('close')].join(','); },
        foreignActivity: function () { globalListener.send('activity', { type: 'init' }); active = { component: 'foreign' }; Lampa.Controller.toggle('foreign'); },
        Lampa: Lampa, api: api, requests: requests, timers: timers, played: played, notices: notices, pushed: pushed,
        document: document, settings: settingsListener, screen: screen, root: root, viewport: viewport,
        rows: function () { return viewport().children[0].children; },
        title: function () { return root().children[0].textContent; },
        status: function () { return root().children[1].textContent; },
        open: function () { var param = params.filter(function (p) { return p.param.name === 'dlna_bridge_open_catalog'; })[0]; assert.ok(param); param.onChange(); },
        press: function (name) { if (controllers[controller] && controllers[controller][name]) controllers[controller][name](); },
        click: function (row) { dispatch(row, 'click'); },
        pointerDown: function (row) { dispatch(row, 'mousedown'); },
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
        focusWindow: function () { emitReturn('focus'); },
        blurWindow: function () { emitReturn('blur'); },
        visibility: function (hidden) { emitReturn(hidden ? 'hidden' : 'visible'); },
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
    assert.strictEqual(h.windowHandlers(), 4); assert.strictEqual(h.externalHandlers(), 1);
    assert.strictEqual(h.closeHandlers(), 1); assert.strictEqual(h.visibilityHandlers(), 2);
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
    assert.strictEqual(h.windowHandlers(), 4); assert.strictEqual(h.visibilityHandlers(), 2);
    h.press('back'); assert.strictEqual(h.externalHandlers(), 1); h.open();
    assert.strictEqual(h.externalHandlers(), 1); assert.strictEqual(h.closeHandlers(), 1);
    assert.strictEqual(h.windowHandlers(), 4); assert.strictEqual(h.visibilityHandlers(), 2);
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
    assert.strictEqual(h.selectObserverCount(), 1);
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
    assert.strictEqual(h.selectObserverCount(), 1);
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
    assert.strictEqual(h.startHandlers(), 2);
    h.api.init();
    assert.strictEqual(h.createHandlers(), 1);
    assert.strictEqual(h.startHandlers(), 2);
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
    assert.strictEqual(Math.max.apply(Math, allNumbers) - Math.min.apply(Math, allNumbers), 99);
    assert.match(current, /No older playback diagnostic events remain/);
    assert.strictEqual(h.selectObserverCount(), 1);
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
    assert.strictEqual(h.selectObserverCount(), 1);
    assert.strictEqual(h.keypadBackHandlers(), 0);
});

// Android recovery uses user permission, never a synthetic Android completion signal.
function externalRecoveryHarness(options) {
    var h = componentHarness(Object.assign({ externalPlayer: true }, options));
    h.open(); h.reply(options && options.entries || [video()]); h.press('enter'); return h;
}
function allowAndroidRetry(h) {
    h.settingsRecovery(); h.press('down'); h.keyup();
    assert.strictEqual(h.controller(), 'settings_component');
}
function drainAndroid(h) {
    while (h.pendingPlayers.length) h.beginPlayer();
    while (h.returnEvents.length) h.nextReturn();
    while (h.inputEvents.length) h.nextInput();
    h.flushReturnTasks();
    while (h.nativePlayers.length) h.beginNative();
}

test('Android recovery refuses no pending, internal playback and an unavailable confirmation API', function () {
    var h = componentHarness(); h.settingsRecovery();
    assert.match(h.lastNotice().message, /Незавершённого запуска нет/);
    h.open(); h.reply([video()]); h.press('enter'); h.settingsRecovery();
    assert.match(h.lastNotice().message, /встроенному плееру/); assert.strictEqual(h.confirmations.length, 0);
    h.Lampa.Player.listener.send('external', h.played[0]); h.recover();
    assert.strictEqual(h.confirmations.length, 0);
    h.closePlayer(); h.open(); h.press('enter'); assert.strictEqual(h.played.length, 2);
    var a = externalRecoveryHarness(); a.Lampa.Modal = undefined; a.settingsRecovery();
    assert.match(a.lastNotice().message, /подтверждение.*недоступно/); a.open(); a.press('enter');
    assert.strictEqual(a.played.length, 1); drainAndroid(a);
});

test('Android recovery cannot bypass delayed dispatch, create.abort or a foreign external payload', function () {
    [false, true].forEach(function (abort) {
        var h = externalRecoveryHarness({ deferredPlayer: true, preCreateAbort: abort });
        h.Lampa.Player.listener.send('external', { url: h.played[0].url }); h.settingsRecovery();
        assert.match(h.lastNotice().message, /ещё не наблюдалась/);
        assert.strictEqual(h.confirmations.length, 0); h.open(); h.press('enter');
        assert.strictEqual(h.played.length, 1); drainAndroid(h);
        assert.strictEqual(h.launches.length, abort ? 0 : 1);
    });
});

['cancel', 'back', 'default-enter'].forEach(function (method) {
    test('Android recovery ' + method + ' preserves the external lock', function () {
        var h = externalRecoveryHarness(); h.settingsRecovery();
        assert.match(h.confirmations[0].params.html[0].textContent, /нельзя гарантированно отменить/);
        if (method === 'cancel') h.confirmations[0].params.buttons[0].onSelect();
        else if (method === 'back') h.press('back'); else h.keyup();
        assert.strictEqual(h.controller(), 'settings_component'); h.open(); h.press('enter');
        assert.strictEqual(h.played.length, 1);
        assert.match(readPlaybackDiagnosticPages(h), /recovery-cancelled/); drainAndroid(h);
    });
});

[false, true].forEach(function (differentFile) {
    test('Android permission itself does not play; a separate selection plays ' + (differentFile ? 'another' : 'the same') + ' file', function () {
        var h = externalRecoveryHarness({ entries: [video(), { id: 'other', title: 'Other', url: 'http://media/other.mp4' }] });
        var first = h.played[0];
        allowAndroidRetry(h); assert.strictEqual(h.played.length, 1);
        var state = h.confirmations[0]; state.params.buttons[1].onSelect();
        assert.strictEqual(h.controller(), 'settings_component');
        h.open(); if (differentFile) h.press('down'); h.keyup();
        assert.strictEqual(h.played.length, 2);
        assert.strictEqual(h.played[1].url === first.url, !differentFile);
        var lines = readPlaybackDiagnosticPages(h);
        assert.match(lines, /recovery-accepted/); assert.match(lines, /playback-abandoned.*phase=abandoned/);
        assert.doesNotMatch(lines, /completion-accepted|pending-cleared|phase=finished/);
        drainAndroid(h); assert.strictEqual(h.nativeLaunches.length, 2);
    });
});

test('Android stale confirmation and old callback/close/start/external cannot affect a newer attempt', function () {
    var h = externalRecoveryHarness(); var first = h.played[0]; allowAndroidRetry(h);
    var old = h.confirmations[0]; h.open(); h.press('enter');
    h.settingsRecovery(); var current = h.confirmations[1];
    old.params.buttons[1].onSelect(); old.params.onBack();
    assert.strictEqual(h.Lampa.Modal.render()[0], current.node); assert.strictEqual(h.controller(), 'modal');
    h.callback(0); h.closeEvent(first); h.Lampa.Player.listener.send('start', first); h.Lampa.Player.listener.send('external', first);
    assert.strictEqual(h.controller(), 'modal'); h.press('back'); h.open(); h.press('enter');
    assert.strictEqual(h.played.length, 2);
    assert.match(readPlaybackDiagnosticPages(h), /recovery-confirm-stale/); drainAndroid(h);
});

test('Android real matching close during confirmation cannot authorize another current attempt', function () {
    var h = externalRecoveryHarness(); h.settingsRecovery(); var dialog = h.confirmations[0];
    h.closeEvent(h.played[0]); var before = h.contentToggles(); dialog.params.buttons[1].onSelect();
    assert.strictEqual(h.controller(), 'settings_component'); assert.strictEqual(h.contentToggles(), before);
    dialog.params.onBack(); assert.strictEqual(h.controller(), 'settings_component');
    h.open(); h.press('enter'); assert.strictEqual(h.played.length, 2);
    var lines = readPlaybackDiagnosticPages(h);
    assert.match(lines, /completion-accepted/); assert.match(lines, /recovery-confirm-stale/);
    assert.doesNotMatch(lines, /recovery-accepted|playback-abandoned/); drainAndroid(h);
});

test('Android recovery survives destroy/reopen without retaining the destroyed owner', function () {
    var h = externalRecoveryHarness(); var old = h.screen(); h.press('back'); h.open();
    if (h.requests.length) h.reply([video()]); allowAndroidRetry(h); h.open(); h.press('enter');
    var before = h.contentToggles(); old.start(); h.callback(0); h.closeEvent(h.played[0]);
    assert.strictEqual(h.contentToggles(), before); assert.strictEqual(h.played.length, 2); drainAndroid(h);
});

test('Android Activity displacement invalidates confirmation even after returning to the same Activity object', function () {
    var h = externalRecoveryHarness(); var original = h.pushed[0]; h.settingsRecovery();
    var dialog = h.confirmations[0]; h.foreignActivity(); dialog.params.buttons[1].onSelect(); dialog.params.onBack();
    assert.strictEqual(h.controller(), 'foreign'); assert.strictEqual(h.played.length, 1);
    h.activate(original); dialog.params.buttons[1].onSelect();
    assert.strictEqual(h.played.length, 1); h.press('enter'); assert.strictEqual(h.played.length, 1); drainAndroid(h);
});

test('Android foreign Modal and Settings are never closed by stale confirmation or callbacks', function () {
    var h = externalRecoveryHarness(); h.settingsRecovery(); var old = h.confirmations[0];
    h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () {} });
    var foreign = h.Lampa.Modal.render()[0]; old.params.buttons[1].onSelect(); old.params.onBack();
    assert.strictEqual(h.Lampa.Modal.render()[0], foreign); assert.strictEqual(h.controller(), 'modal');
    h.Lampa.Controller.toggle('settings_component'); var count = h.contentToggles();
    old.params.buttons[1].onSelect(); h.callback(0); h.closeEvent(h.played[0]);
    assert.strictEqual(h.controller(), 'settings_component'); assert.strictEqual(h.contentToggles(), count); drainAndroid(h);
});

test('Android permission and video activation use different native keyup dispatches', function () {
    var h = externalRecoveryHarness();
    h.Lampa.Controller.toggle('settings_component'); h.keyup(); // keyup -> enter -> Settings trigger -> Modal
    assert.strictEqual(h.controller(), 'modal'); assert.strictEqual(h.confirmations.length, 1);
    h.press('down'); h.keyup(); // one Controller.enter, ending back in Settings
    assert.strictEqual(h.played.length, 1); assert.strictEqual(h.controller(), 'settings_component');
    h.keyup(); // a queued extra OK can only invoke the Settings action, with no pending
    assert.strictEqual(h.played.length, 1); assert.match(h.lastNotice().message, /Незавершённого запуска нет/);
    h.open(); h.keyup(); assert.strictEqual(h.played.length, 2); drainAndroid(h);
});

test('Android native child Modal leaves its old confirmation cancel-only after returning', function () {
    var h = externalRecoveryHarness(); h.settingsRecovery(); var old = h.confirmations[0];
    h.Lampa.Modal.open({ buttons: [{ name: 'Child', onSelect: function () {} }], onBack: function () { h.Lampa.Modal.close(); } });
    old.params.onBack(); assert.strictEqual(h.confirmations.length, 2);
    assert.notStrictEqual(h.Lampa.Modal.render()[0], old.node);
    h.press('back'); assert.strictEqual(h.Lampa.Modal.render()[0], old.node);
    old.params.buttons[1].onSelect(); assert.strictEqual(h.played.length, 1);
    h.press('back'); assert.strictEqual(h.controller(), 'settings_component');
    h.open(); h.press('enter'); assert.strictEqual(h.played.length, 1); drainAndroid(h);
});

test('Android repeated confirmation opening has fixed listener counts and no Select or Keypad subscriptions', function () {
    var h = externalRecoveryHarness(); var counts;
    for (var i = 0; i < 12; i++) {
        h.settingsRecovery(); if (!counts) counts = h.recoveryHandlers();
        h.recover(); assert.strictEqual(h.confirmations.length, i + 1);
        assert.strictEqual(h.recoveryHandlers(), counts); h.press('back');
    }
    assert.strictEqual(h.selectObserverCount(), 1); assert.strictEqual(h.keypadBackHandlers(), 0);
    h.open(); h.press('enter'); assert.strictEqual(h.played.length, 1); drainAndroid(h);
});

test('Android abandoned events without pending cannot steal Settings or a foreign Activity', function () {
    var h = externalRecoveryHarness(); allowAndroidRetry(h); var old = h.played[0]; var count = h.contentToggles();
    h.callback(0); h.closeEvent(old); h.Lampa.Player.listener.send('start', old); h.Lampa.Player.listener.send('external', old);
    assert.strictEqual(h.controller(), 'settings_component'); assert.strictEqual(h.contentToggles(), count);
    h.foreignActivity(); h.callback(0); h.closeEvent(old); assert.strictEqual(h.controller(), 'foreign');
    assert.match(readPlaybackDiagnosticPages(h), /playback-event-rejected/); drainAndroid(h);
});

test('Android independent native requests retain the accepted residual order p2 then p1', function () {
    var h = externalRecoveryHarness({ deferredPlayer: true }); h.press('enter');
    assert.strictEqual(h.played.length, 1); h.beginPlayer(); // API returned; native request p1 still queued
    allowAndroidRetry(h); h.open(); h.press('enter'); h.press('enter');
    assert.strictEqual(h.played.length, 2); h.beginPlayer(); assert.strictEqual(h.nativePlayers.length, 2);
    h.beginNative(1); h.beginNative(0); // execute every independent queued native request
    assert.deepStrictEqual(h.nativeLaunches, [h.played[1], h.played[0]]);
    assert.strictEqual(h.nativePlayers.length, 0); assert.strictEqual(h.pendingPlayers.length, 0);
    h.press('enter'); assert.strictEqual(h.played.length, 2); // external p2 still locked
});

test('Android recovery fails closed on missing lifecycle APIs, wrong platform and an opening exception', function () {
    ['lifecycle', 'platform', 'open'].forEach(function (kind) {
        var h = externalRecoveryHarness();
        if (kind === 'lifecycle') h.Lampa.Controller.listener = undefined;
        if (kind === 'platform') h.Lampa.Platform.is = function () { return false; };
        if (kind === 'open') h.Lampa.Modal.open = function () { throw new Error('unsupported'); };
        h.settingsRecovery(); assert.strictEqual(h.confirmations.length, 0);
        assert.ok(h.lastNotice().message); h.open(); h.press('enter');
        assert.strictEqual(h.played.length, 1); drainAndroid(h);
    });
});

test('Android recovery journal contains reasons and attempt IDs without media or credentials', function () {
    var h = externalRecoveryHarness({ entries: [{ id: 'secret-id', title: 'PRIVATE_TITLE', url: 'http://user:password@media/movie.mp4?token=SECRET' }] });
    allowAndroidRetry(h); h.callback(0); h.closeEvent(h.played[0]);
    var lines = readPlaybackDiagnosticPages(h);
    assert.match(lines, /recovery-request.*\[p1\]/); assert.match(lines, /recovery-accepted.*\[p1\]/);
    assert.match(lines, /playback-abandoned.*\[p1\]/); assert.match(lines, /completion-rejected/);
    assert.doesNotMatch(lines, /PRIVATE_TITLE|secret-id|password|SECRET|movie\.mp4|http:\/\//);
    drainAndroid(h);
});


['before-dom', 'after-dom', 'after-toggle', 'close-toggle', 'callback-toggle', 'activity-toggle', 'close-fullshow', 'callback-fullshow', 'activity-fullshow'].forEach(function (stage) {
    test('Android partial confirmation exits safely: ' + stage, function () {
        var h = externalRecoveryHarness(); var fired = false;
        function interrupt() {
            if (fired) return; fired = true;
            if (/^close-/.test(stage)) h.closeEvent(h.played[0]);
            else if (/^callback-/.test(stage)) h.callback(0);
            else if (/^activity-/.test(stage)) h.foreignActivity();
            else throw new Error('partial open');
        }
        if (/-toggle$/.test(stage) && stage !== 'after-toggle') {
            h.Lampa.Controller.listener.follow('toggle', function (e) { if (e.name === 'modal') interrupt(); });
        } else if (/-fullshow$/.test(stage)) h.Lampa.Modal.listener.follow('fullshow', interrupt);
        else h.modalHook(function (at) { if (at === stage) interrupt(); });
        h.settingsRecovery(); h.modalHook(null);
        var old = h.confirmations[0];
        assert.strictEqual(h.modalNodes(), 0, 'no orphan DOM');
        assert.strictEqual(h.modalWindows(), 0, 'no orphan window frame');
        assert.strictEqual(h.controller(), /^activity-/.test(stage) ? 'foreign' : 'settings_component');
        if (old) { old.params.onBack(); old.params.buttons[1].onSelect(); old.params.onBack(); }
        assert.strictEqual(h.modalNodes(), 0); assert.strictEqual(h.modalWindows(), 0);
        assert.strictEqual(h.played.length, 1);
        h.open(); h.press('enter');
        assert.strictEqual(h.played.length, /^(close|callback)-/.test(stage) ? 2 : 1);
        if (!/^(close|callback)-/.test(stage)) {
            h.settingsRecovery(); assert.strictEqual(h.Lampa.Modal.opened(), true);
            h.press('back'); assert.strictEqual(h.controller(), 'settings_component');
            assert.strictEqual(h.modalNodes(), 0); assert.strictEqual(h.modalWindows(), 0);
        }
        drainAndroid(h);
    });
});

['during-failure', 'after-failure'].forEach(function (when) {
    test('Android failed confirmation preserves a foreign child: ' + when, function () {
        var h = externalRecoveryHarness(); var foreign;
        function child() {
            var origin = h.controller();
            h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () {
                h.Lampa.Modal.close();
                if (!h.Lampa.Controller.windowTop()) h.Lampa.Controller.toggle(origin);
            } });
            foreign = h.Lampa.Modal.render()[0];
        }
        h.modalHook(function (stage) {
            if (stage !== 'after-open') return;
            h.modalHook(null);
            if (when === 'during-failure') child();
            throw new Error('partial open');
        });
        h.settingsRecovery(); h.modalHook(null);
        if (when === 'after-failure') child();
        var old = h.confirmations[0];
        old.params.buttons[1].onSelect(); old.params.onBack();
        assert.strictEqual(h.Lampa.Modal.render()[0], foreign);
        assert.strictEqual(h.controller(), 'modal'); assert.strictEqual(h.played.length, 1);
        h.press('back');
        if (h.modalNodes()) { // Native child close returns to an invalidated parent, which may only close.
            assert.strictEqual(h.Lampa.Modal.render()[0], old.node);
            old.params.buttons[1].onSelect(); assert.strictEqual(h.played.length, 1);
            h.press('back');
        }
        assert.strictEqual(h.modalNodes(), 0); assert.strictEqual(h.modalWindows(), 0);
        assert.strictEqual(h.controller(), 'settings_component');
        old.params.onBack(); old.params.buttons[1].onSelect();
        h.open(); h.press('enter'); assert.strictEqual(h.played.length, 1);
        h.settingsRecovery(); h.press('back');
        assert.strictEqual(h.modalNodes(), 0); assert.strictEqual(h.modalWindows(), 0);
        drainAndroid(h);
    });
});

function nativeCatalog(options) {
    var h = componentHarness(Object.assign({ nativeNavigation: true, externalPlayer: true }, options));
    h.settingsBoot(); h.setting('open_catalog'); h.reply([video(), folder('A')]);
    return h;
}
function assertDlnaSettings(h) {
    assert.strictEqual(h.Lampa.Activity.active().component, 'main');
    assert.strictEqual(h.Lampa.Activity.all().length, 1);
    assert.strictEqual(h.controller(), 'settings_component');
    assert.strictEqual(h.settingsName(), 'dlna_bridge');
    assert.strictEqual(h.settingsVisible(), true);
}

test('native Back from root opens DLNA settings after leaving catalog', function () {
    var h = nativeCatalog();
    h.press('back'); assertDlnaSettings(h);
});

[false, true].forEach(function (pending) {
    test('native root return preserves ownership, deferred destroy and lock: pending=' + pending, function () {
        var h = nativeCatalog(); var old = h.screen();
        if (pending) h.press('enter');
        var plays = h.played.length;
        h.press('back'); assertDlnaSettings(h);
        assert.strictEqual(h.timers.length, 1, 'only native 200ms destroy, no plugin timer');
        h.timer(); assertDlnaSettings(h);
        old.start(); old.back(); old.select(0); assertDlnaSettings(h);
        h.setting('open_catalog'); assert.strictEqual(h.Lampa.Activity.all().length, 2);
        h.press('enter'); assert.strictEqual(h.played.length, plays + (pending ? 0 : 1));
        drainAndroid(h);
    });
});

test('native nested Back, resource Back and Browse cancellation precede root exit', function () {
    var h = nativeCatalog();
    h.press('down'); h.press('enter'); h.reply([folder('B')]);
    h.press('enter'); h.reply([video()]);
    h.press('back'); assert.strictEqual(h.title(), 'A');
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    assert.strictEqual(h.backCount(), 0);
    h.press('up'); h.press('enter'); h.press('back'); assertDlnaSettings(h); h.timer();
    h.api.cache['0'] = [{ id: 'multi', title: 'Multi', resources: [
        { url: 'http://media/one.mp4', mime: 'video/mp4' },
        { url: 'http://media/two.mp4', mime: 'video/mp4' }
    ] }, folder('C')];
    h.setting('open_catalog'); h.press('enter'); assert.strictEqual(h.title(), 'Multi');
    h.press('back'); assert.strictEqual(h.title(), 'DLNA');
    var before = h.backCount(); h.press('down'); h.press('enter');
    var late = h.requests.shift(); h.press('back');
    assert.strictEqual(h.backCount(), before); assert.strictEqual(h.title(), 'DLNA');
    late.success(soapResponse(didl([video()]), 1)); assert.strictEqual(h.title(), 'DLNA');
    h.press('back'); assertDlnaSettings(h); h.timer(); drainAndroid(h);
});

test('native repeated catalog-settings cycles keep history and subscriptions bounded', function () {
    var h = nativeCatalog(); var counts = h.recoveryHandlers(); var old = [];
    for (var i = 0; i < 12; i++) {
        old.push(h.screen()); h.press('back'); assertDlnaSettings(h); h.timer();
        old.forEach(function (screen) { screen.start(); screen.back(); });
        assertDlnaSettings(h); h.setting('open_catalog');
        assert.strictEqual(h.Lampa.Activity.all().length, 2);
        assert.strictEqual(h.recoveryHandlers(), counts);
        assert.strictEqual(h.settings.count('open'), 1);
        assert.strictEqual(h.windowHandlers(), 4); assert.strictEqual(h.visibilityHandlers(), 2);
        assert.strictEqual(h.closeHandlers(), 1); assert.strictEqual(h.externalHandlers(), 1);
    }
    assert.strictEqual(h.selectObserverCount(), 1); assert.strictEqual(h.keypadBackHandlers(), 0);
});

test('native settings cancel recovery and allow a separate later video selection', function () {
    var h = nativeCatalog(); h.press('enter'); h.press('back'); assertDlnaSettings(h); h.timer();
    h.setting('android_recovery'); assert.strictEqual(h.controller(), 'modal');
    h.press('back'); assertDlnaSettings(h);
    h.setting('open_catalog'); h.press('enter'); assert.strictEqual(h.played.length, 1);
    h.press('back'); assertDlnaSettings(h); h.timer();
    h.setting('android_recovery'); h.press('down'); h.keyup(); assertDlnaSettings(h);
    assert.strictEqual(h.played.length, 1, 'permission never plays');
    h.setting('open_catalog'); assert.strictEqual(h.played.length, 1);
    h.keyup(); assert.strictEqual(h.played.length, 2); drainAndroid(h);
});

test('native late old player callbacks cannot dismiss settings or authorize a newer attempt', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.played[0];
    h.press('back'); assertDlnaSettings(h); h.timer();
    h.setting('android_recovery'); h.press('down'); h.keyup(); assertDlnaSettings(h);
    h.callback(0); h.closeEvent(first); h.Lampa.Player.listener.send('external', first);
    assertDlnaSettings(h);
    h.setting('open_catalog'); h.keyup(); assert.strictEqual(h.played.length, 2);
    h.press('back'); assertDlnaSettings(h); h.timer();
    h.callback(0); h.closeEvent(first); h.Lampa.Player.listener.send('start', first);
    assertDlnaSettings(h);
    h.setting('open_catalog'); h.keyup(); assert.strictEqual(h.played.length, 2); drainAndroid(h);
});

['backward', 'activity-start', 'activity-archive', 'settings-open', 'settings-toggle'].forEach(function (stage) {
    ['activity', 'window'].forEach(function (intruder) {
        test('native root transition preserves foreign ' + intruder + ' during ' + stage, function () {
            var h = nativeCatalog(); var old = h.screen(); var fired = false; var foreign;
            function interrupt() {
                if (fired) return; fired = true;
                old.back(); // A repeated stale handler cannot repeat backward().
                if (intruder === 'activity') {
                    h.Lampa.Component.add('foreign', function () {
                        this.create = function () {}; this.render = function () { return h.document.createElement('div'); };
                        this.start = function () { h.Lampa.Controller.add('foreign', {}); h.Lampa.Controller.toggle('foreign'); };
                    });
                    h.Lampa.Activity.push({ component: 'foreign' }); foreign = h.Lampa.Activity.active();
                } else {
                    h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () {} });
                    foreign = h.Lampa.Modal.render()[0];
                }
            }
            if (stage === 'backward') h.Lampa.Activity.listener.follow('backward', interrupt);
            else if (stage.indexOf('activity-') === 0) h.Lampa.Listener.follow('activity', function (e) {
                if (e.type === stage.substring(9) && e.object.component === 'main') interrupt();
            });
            else if (stage === 'settings-open') h.settings.follow('open', function (e) { if (e.name === 'main') interrupt(); });
            else h.Lampa.Controller.listener.follow('toggle', function (e) { if (e.name === 'settings') interrupt(); });
            h.press('back'); assert.strictEqual(fired, true);
            // A backward-listener interruption happens before Lampa pops/starts: Lampa itself
            // then owns that transition. The plugin must not open settings over its result.
            assert.strictEqual(h.settingsOpens.filter(function (name) { return name === 'dlna_bridge'; }).length, 1);
            if (stage !== 'backward') {
                if (intruder === 'activity') {
                    assert.strictEqual(h.Lampa.Activity.active(), foreign); assert.strictEqual(h.controller(), 'foreign');
                } else {
                    assert.strictEqual(h.Lampa.Modal.render()[0], foreign); assert.strictEqual(h.controller(), 'modal');
                }
            }
            old.back();
            if (stage === 'backward' && intruder === 'activity') {
                // Lampa popped the newly pushed foreign Activity, so the catalog never left.
                // Its next Back is a valid user action after recovery, not a stale callback.
                assert.strictEqual(h.backCount(), 2); assertDlnaSettings(h);
            } else assert.strictEqual(h.backCount(), 1);
        });
    });
});

['sole', 'subscriber', 'exception'].forEach(function (scenario) {
    [false, true].forEach(function (pending) {
        test('native no-exit Back remains usable: ' + scenario + ', pending=' + pending, function () {
            var h = nativeCatalog({ backwardThrows: scenario === 'exception' });
            if (pending) h.press('enter');
            if (scenario === 'sole') h.Lampa.Activity.all().splice(0, 1);
            if (scenario === 'subscriber') h.Lampa.Activity.listener.follow('backward', function () {
                if (h.Lampa.Activity.all().length > 1) h.Lampa.Activity.all().splice(0, 1);
            });
            var original = h.Lampa.Activity.active();
            if (scenario === 'exception') assert.throws(function () { h.press('back'); }, /backward failure/);
            else h.press('back');
            assert.strictEqual(h.Lampa.Activity.active(), original);
            h.press('down'); h.press('enter');
            assert.strictEqual(h.requests.length, 1, 'folder selection after failed exit works');
            h.reply([video()]); h.press('back'); assert.strictEqual(h.title(), 'DLNA');
            h.press('up'); h.press('enter');
            assert.strictEqual(h.played.length, 1, 'pending lock is preserved; unlocked first selection plays');
            drainAndroid(h);
        });
    });
});

['main', 'dlna_bridge'].forEach(function (stage) {
    ['modal', 'select', 'activity'].forEach(function (kind) {
        test('audit documents native Settings continuation after open ' + stage + ': ' + kind, function () {
            var h = nativeCatalog(); var fired = false; var node; var foreign; var ok = 0; var back = 0;
            h.settings.follow('open', function (e) {
                if (fired || e.name !== stage) return; fired = true;
                if (kind === 'modal') {
                    h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () { ok++; } }], onBack: function () { back++; h.Lampa.Modal.close(); } });
                    node = h.Lampa.Modal.render()[0];
                } else if (kind === 'select') {
                    node = h.Lampa.Select.show({ items: [{}], onSelect: function () { ok++; } });
                } else {
                    h.Lampa.Component.add('foreign', function () {
                        node = h.document.createElement('foreign');
                        var row = h.document.createElement('button'); row.className = 'selector'; node.appendChild(row);
                        row.addEventListener('hover:enter', function () { ok++; });
                        this.create = function () {}; this.render = function () { return node; };
                        this.start = function () {
                            h.Lampa.Controller.add('foreign', { back: function () { back++; } });
                            h.Lampa.Controller.toggle('foreign');
                            h.Lampa.Controller.collectionSet([node]); h.Lampa.Controller.collectionFocus(row, [node]);
                        };
                    });
                    h.Lampa.Activity.push({ component: 'foreign' }); foreign = h.Lampa.Activity.active();
                }
                assert.strictEqual(h.navigation()[0].parentNode, node);
                assert.strictEqual(h.document.activeElement.parentNode, node);
            });
            h.press('back'); assert.strictEqual(fired, true);
            if (foreign) assert.strictEqual(h.Lampa.Activity.active(), foreign);
            assert.ok(node.parentNode, 'foreign DOM survives');
            assert.strictEqual(h.Lampa.Activity.all().length, kind === 'activity' ? 2 : 1);
            assert.strictEqual(h.modalWindows(), kind === 'activity' ? 0 : 1);
            assert.notStrictEqual(h.document.activeElement.parentNode, node, 'known defect: settings steals focus');
            assert.notStrictEqual(h.navigation()[0].parentNode, node, 'known defect: settings steals collection');
            assert.strictEqual(h.settingsBody().firstChild.tag, stage === 'main' ? 'settings-main' : 'settings-component');
            assert.strictEqual(h.settingsVisible(), stage === 'main');
            assert.strictEqual(h.addressState(), 'settings=' + stage);
            assert.strictEqual(h.controller(), stage === 'main' ? (kind === 'activity' ? 'foreign' : kind) : 'settings_component');
            // Native continuation, not a second plugin Back: ordinary OK/Back miss the foreign target.
            h.keyup(); assert.strictEqual(ok, 0);
            h.press('back'); assert.strictEqual(back, 0);
            assert.strictEqual(h.modalWindows(), kind === 'activity' ? 0 : 1, 'window remains without its active controller');
        });
    });
});

[false, true].forEach(function (throws) {
    test('native no-exit recovery does not take focus from a foreign window, throws=' + throws, function () {
        var h = nativeCatalog({ backwardThrows: throws }); h.press('enter');
        h.Lampa.Activity.all().splice(0, 1);
        var ok = 0; var back = 0; var node; var collection; var focused;
        h.Lampa.Activity.listener.follow('backward', function () {
            h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () { ok++; } }], onBack: function () { back++; h.Lampa.Modal.close(); } });
            node = h.Lampa.Modal.render()[0]; collection = h.navigation(); focused = h.document.activeElement;
        });
        if (throws) assert.throws(function () { h.press('back'); }, /backward failure/);
        else h.press('back');
        assert.strictEqual(h.controller(), 'modal'); assert.strictEqual(h.settingsVisible(), false);
        assert.strictEqual(h.document.activeElement, focused); assert.strictEqual(h.navigation(), collection);
        assert.ok(node.parentNode); assert.strictEqual(h.Lampa.Activity.all().length, 1);
        h.callback(0); assert.strictEqual(h.controller(), 'modal');
        h.keyup(); assert.strictEqual(ok, 1); h.press('back'); assert.strictEqual(back, 1);
        assert.strictEqual(node.parentNode, null); assert.strictEqual(h.modalWindows(), 0);
        drainAndroid(h);
    });
});

test('native no-exit restart respects a window opened synchronously by content toggle', function () {
    var h = nativeCatalog(); h.Lampa.Activity.all().splice(0, 1);
    var node; var collection; var focused;
    h.Lampa.Controller.listener.follow('toggle', function (e) {
        if (e.name !== 'content' || node) return;
        h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () {} });
        node = h.Lampa.Modal.render()[0]; collection = h.navigation(); focused = h.document.activeElement;
    });
    h.press('back');
    assert.strictEqual(h.controller(), 'modal'); assert.ok(node.parentNode);
    assert.strictEqual(h.navigation(), collection); assert.strictEqual(h.document.activeElement, focused);
    assert.strictEqual(h.Lampa.Activity.all().length, 1); assert.strictEqual(h.modalWindows(), 1);
});

function returnSample(h, event) {
    var found = h.api.records.filter(function (record) { return record.event === 'return-' + event; });
    assert.ok(found.length, event); return found[found.length - 1];
}
function observeRoundTrip(h) { h.blurWindow(); h.visibility(true); h.visibility(false); h.focusWindow(); }

['external-first', 'leave-first', 'return-first'].forEach(function (order) {
    test('return observations preserve lock before permission commit and record ordering: ' + order, function () {
        var h = nativeCatalog({ deferredPlayer: true }); h.press('enter');
        var session = h.api.pending(); var controller = h.controller(); var toggles = h.contentToggles();
        assert.strictEqual(returnSample(h, 'request').observation.external, '0');
        if (order === 'external-first') h.beginPlayer();
        h.blurWindow(); h.visibility(true);
        var departure = returnSample(h, 'visibility');
        assert.strictEqual(departure.observation.visibility, 'hidden');
        assert.strictEqual(departure.observation.external, order === 'external-first' ? '1' : '0');
        if (order === 'leave-first') h.beginPlayer();
        h.visibility(false); h.focusWindow();
        var arrival = returnSample(h, 'focus');
        assert.strictEqual(arrival.observation.documentFocus, '1');
        assert.strictEqual(arrival.observation.originCatalog, '1'); assert.strictEqual(arrival.observation.originFolder, '1');
        assert.strictEqual(arrival.observation.content, '1'); assert.strictEqual(arrival.observation.other, '0');
        assert.strictEqual(arrival.observation.navigationFocus, '1');
        assert.strictEqual(arrival.observation.hooks, '11111');
        assert.strictEqual(arrival.observation.external, order === 'return-first' ? '0' : '1');
        if (order === 'return-first') h.beginPlayer();
        var external = returnSample(h, 'external-match');
        assert.ok(order === 'external-first' ? external.n < departure.n : external.n > departure.n);
        if (order === 'return-first') assert.ok(external.n > arrival.n);
        for (var i = 0; i < 4; i++) { observeRoundTrip(h); h.Lampa.Player.listener.send('external', h.played[0]); }
        assert.strictEqual(h.api.pending(), session); assert.strictEqual(session.phase, 'external');
        assert.strictEqual(h.controller(), controller); assert.strictEqual(h.contentToggles(), toggles);
        h.keyup(); assert.strictEqual(h.played.length, 1); assert.strictEqual(h.nativePlayers.length, 1);
        assert.doesNotMatch(readPlaybackDiagnosticPages(h), /recovery-accepted|completion-accepted|pending-cleared|playback-abandoned/);
        drainAndroid(h); assert.strictEqual(h.nativeLaunches.length, 1);
    });
});

test('return observations do not invent a departure and do not unblock create.abort', function () {
    var h = nativeCatalog(); h.press('enter'); h.focusWindow(); h.visibility(false);
    assert.strictEqual(h.api.pending().phase, 'external');
    assert.strictEqual(h.api.records.some(function (r) { return r.observation && r.observation.visibility === 'hidden'; }), false);
    h.keyup(); assert.strictEqual(h.played.length, 1); drainAndroid(h);
    var a = nativeCatalog({ preCreateAbort: true }); a.press('enter'); var pending = a.api.pending();
    observeRoundTrip(a); a.keyup();
    assert.strictEqual(a.api.pending(), pending); assert.strictEqual(pending.phase, 'launching');
    assert.strictEqual(returnSample(a, 'focus').observation.external, '0');
    assert.strictEqual(a.played.length, 1); assert.strictEqual(a.launches.length, 0);
});

test('return diagnostics preserve internal Player completion behavior', function () {
    var h = nativeCatalog({ externalPlayer: false }); h.press('enter'); var pending = h.api.pending();
    observeRoundTrip(h);
    assert.strictEqual(h.api.pending(), pending); assert.strictEqual(h.controller(), 'player');
    assert.strictEqual(returnSample(h, 'focus').observation.external, '0');
    h.closePlayer(); assert.strictEqual(h.api.pending(), null); assert.strictEqual(h.controller(), 'content');
});

test('return generations identify parent folder restoration without exposing folder IDs', function () {
    var h = nativeCatalog(); h.press('enter'); var origin = returnSample(h, 'request').observation;
    h.screen().refresh(); if (h.requests.length) h.reply([video(), folder('A')]); h.focusWindow();
    assert.strictEqual(returnSample(h, 'focus').observation.folder, origin.folder);
    h.press('down'); h.press('enter'); h.reply([folder('PRIVATE_FOLDER_ID')]); h.focusWindow();
    var child = returnSample(h, 'focus').observation;
    assert.strictEqual(child.catalog, origin.catalog); assert.notStrictEqual(child.folder, origin.folder);
    assert.strictEqual(child.originFolder, '0'); h.press('back'); h.focusWindow();
    assert.strictEqual(returnSample(h, 'focus').observation.originFolder, '1');
    h.press('up'); h.keyup(); assert.strictEqual(h.played.length, 1); drainAndroid(h);
});

test('return observers keep only scalar context across destruction and reopening', function () {
    var h = nativeCatalog(); h.press('enter'); var pending = h.api.pending();
    var origin = returnSample(h, 'request').observation;
    var counts = h.recoveryHandlers(); h.press('back'); assertDlnaSettings(h); h.timer();
    assert.strictEqual(pending.restoreOwner, null); observeRoundTrip(h);
    assert.strictEqual(returnSample(h, 'focus').observation.originCatalog, '0');
    assert.strictEqual(returnSample(h, 'focus').observation.catalog, 0);
    h.setting('open_catalog'); h.focusWindow();
    assert.notStrictEqual(returnSample(h, 'focus').observation.catalog, origin.catalog);
    assert.strictEqual(returnSample(h, 'focus').observation.originCatalog, '0');
    assert.strictEqual(h.api.pending(), pending); h.keyup(); assert.strictEqual(h.played.length, 1);
    for (var i = 0; i < 8; i++) { h.press('back'); h.timer(); h.setting('open_catalog'); }
    assert.strictEqual(h.recoveryHandlers(), counts); assert.strictEqual(h.windowHandlers(), 4); assert.strictEqual(h.visibilityHandlers(), 2);
    [h.api.observation()].concat(h.api.records.map(function (r) { return r.observation; }).filter(Boolean)).forEach(function (snapshot) {
        Object.keys(snapshot).forEach(function (key) { assert.ok(['string', 'number', 'boolean'].indexOf(typeof snapshot[key]) >= 0); });
    });
    drainAndroid(h);
});

test('manual recovery and old player events remain unchanged with return observations', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.played[0]; h.focusWindow();
    h.press('back'); h.timer(); h.setting('android_recovery'); h.press('back'); assertDlnaSettings(h);
    h.setting('open_catalog'); h.keyup(); assert.strictEqual(h.played.length, 1);
    h.press('back'); h.timer(); h.setting('android_recovery'); h.press('down'); h.keyup(); assertDlnaSettings(h);
    assert.strictEqual(h.api.pending(), null); assert.strictEqual(h.api.observation(), null); assert.strictEqual(h.played.length, 1);
    h.setting('open_catalog'); h.keyup(); var second = h.api.pending();
    h.callback(0); h.closeEvent(first); h.Lampa.Player.listener.send('start', first); h.Lampa.Player.listener.send('external', first);
    observeRoundTrip(h); assert.strictEqual(h.api.pending(), second); h.keyup(); assert.strictEqual(h.played.length, 2);
    drainAndroid(h); assert.strictEqual(h.nativeLaunches.length, 2);
});

['normal', 'missing', 'throwing'].forEach(function (mode) {
    test('document focus is independent of Lampa navigation focus: ' + mode, function () {
        var h = nativeCatalog({ noDocumentFocus: mode === 'missing', throwDocumentFocus: mode === 'throwing' });
        h.press('enter'); h.blurWindow(); var sample = returnSample(h, 'blur').observation;
        assert.strictEqual(sample.documentFocus, mode === 'normal' ? '0' : '?');
        assert.strictEqual(sample.navigationFocus, '1'); assert.strictEqual(sample.content, '1');
        h.keyup(); assert.strictEqual(h.played.length, 1); drainAndroid(h);
    });
});

test('return samples report loading, error, resources and a partially opened foreign Modal', function () {
    var h = componentHarness({ nativeNavigation: true }); h.open(); h.focusWindow();
    assert.strictEqual(returnSample(h, 'focus').observation.loading, '1');
    for (var i = 0; i < 3; i++) { h.fail(); if (i < 2) h.timer(); }
    h.focusWindow(); assert.strictEqual(returnSample(h, 'focus').observation.error, '1');
    var a = nativeCatalog(); a.api.cache['0'] = [{ id: 'multi', title: 'Multi', resources: [
        { url: 'http://media/a', mime: 'video/mp4' }, { url: 'http://media/b', mime: 'video/mp4' }
    ] }];
    a.press('back'); a.timer(); a.setting('open_catalog'); a.press('enter'); a.focusWindow();
    assert.strictEqual(returnSample(a, 'focus').observation.resources, '1');
    a.modalHook(function (stage) { if (stage === 'after-dom') a.focusWindow(); });
    a.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () {} });
    var partial = returnSample(a, 'focus').observation;
    assert.strictEqual(partial.content, '1'); assert.strictEqual(partial.other, '1');
});

test('return records and pages contain no media, credentials or object IDs', function () {
    var h = componentHarness({ nativeNavigation: true, externalPlayer: true });
    h.open(); h.reply([{ id: 'PRIVATE_OBJECT_ID', title: 'PRIVATE_TITLE', url: 'http://user:password@media/private.mp4?token=SECRET' }]);
    h.press('enter'); observeRoundTrip(h); h.press('back'); h.timer();
    var text = JSON.stringify(h.api.records) + readPlaybackDiagnosticPages(h);
    assert.doesNotMatch(text, /PRIVATE_OBJECT_ID|PRIVATE_TITLE|password|SECRET|private\.mp4|http:\/\//);
    assert.match(text, /pending-context-not-causation/); assert.ok(h.api.records.length <= 100);
    drainAndroid(h);
});

function queuedReturn(h) {
    ['blur', 'hidden', 'visible', 'focus'].forEach(function (type) { h.queueReturn(type); });
    while (h.returnEvents.length) h.nextReturn();
    h.flushReturnTasks();
}
function queuedOK(h) {
    h.queueInput('keydown'); h.queueInput('keyup');
    while (h.inputEvents.length) h.nextInput();
}
function drainReturnModel(h) {
    while (h.pendingPlayers.length || h.returnEvents.length || h.inputEvents.length || h.returnTasks.length || h.nativePlayers.length || h.timers.length) {
        while (h.pendingPlayers.length) h.beginPlayer();
        while (h.returnEvents.length) h.nextReturn();
        while (h.inputEvents.length) h.nextInput();
        h.flushReturnTasks();
        while (h.nativePlayers.length) h.beginNative();
        while (h.timers.length) h.timer();
    }
}

['external-hidden', 'hidden-external', 'Home-return'].forEach(function (order) {
    test('automatic permission is one-shot, unconfirmed and needs fresh input: ' + order, function () {
        var h = nativeCatalog({ deferredPlayer: true }); h.press('enter'); var first = h.api.pending();
        if (order !== 'hidden-external') h.beginPlayer();
        h.queueReturn('blur'); h.queueReturn('hidden'); h.nextReturn(); h.nextReturn();
        if (order === 'hidden-external') h.beginPlayer();
        h.queueReturn('visible'); h.queueReturn('focus'); h.nextReturn(); h.nextReturn();
        assert.strictEqual(h.api.pending(), first, 'no permission inside event dispatch');
        h.flushReturnTasks();
        assert.strictEqual(h.api.pending(), null); assert.strictEqual(first.phase, 'abandoned'); assert.strictEqual(first.restoreOwner, null);
        assert.strictEqual(h.controller(), 'content'); assert.strictEqual(h.played.length, 1);
        queuedReturn(h); h.Lampa.Player.listener.send('external', first.data); h.flushReturnTasks();
        var accepted = h.api.records.filter(function (r) { return r.event === 'recovery-auto-accepted'; });
        assert.strictEqual(accepted.length, 1); assert.strictEqual(accepted[0].reason, 'auto-return-unconfirmed');
        assert.strictEqual(h.api.records.some(function (r) { return r.event === 'completion-accepted' || r.phase === 'finished'; }), false);
        h.queueInput('keyup'); h.nextInput(); assert.strictEqual(h.played.length, 1);
        h.queueInput('keydown', true); h.queueInput('keyup'); h.nextInput(); h.nextInput(); assert.strictEqual(h.played.length, 1);
        queuedOK(h); assert.strictEqual(h.played.length, 2);
        assert.strictEqual(h.played[0].url, h.played[1].url); assert.notStrictEqual(h.played[0], h.played[1]);
        drainReturnModel(h); assert.strictEqual(h.nativeLaunches.length, 2);
    });
});

test('visible before external requires a fresh complete cycle', function () {
    var h = nativeCatalog({ deferredPlayer: true }); h.press('enter'); var first = h.api.pending();
    queuedReturn(h); h.beginPlayer(); h.focusWindow(); h.flushReturnTasks();
    assert.strictEqual(h.api.pending(), first); assert.strictEqual(h.played.length, 1);
    queuedReturn(h); assert.strictEqual(h.api.pending(), null); drainReturnModel(h);
});

test('focus, component start and reopen without hidden cannot authorize; manual recovery remains', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending();
    h.blurWindow(); h.focusWindow(); h.resumed(); h.open(); h.flushReturnTasks();
    assert.strictEqual(h.api.pending(), first);
    h.press('back'); h.timer(); h.setting('android_recovery'); h.press('back'); assertDlnaSettings(h);
    assert.strictEqual(h.api.pending(), first);
    h.setting('android_recovery'); h.press('down'); h.keyup(); assert.strictEqual(h.api.pending(), null);
    assert.strictEqual(h.played.length, 1); h.setting('open_catalog'); h.keyup(); assert.strictEqual(h.played.length, 2);
    drainReturnModel(h);
});

test('folder change discards the old cycle even after returning to the origin', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending(); h.visibility(true);
    h.press('down'); h.press('enter'); h.reply([video()]); h.press('back');
    h.visibility(false); h.focusWindow(); h.flushReturnTasks(); assert.strictEqual(h.api.pending(), first);
    queuedReturn(h); assert.strictEqual(h.api.pending(), null); drainReturnModel(h);
});

test('Activity displacement invalidates the cycle without losing manual lock', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending(); h.visibility(true);
    h.Lampa.Component.add('other', function () { this.create = function () {}; this.render = function () { return h.document.createElement('div'); }; this.start = function () {}; this.destroy = function () {}; });
    h.Lampa.Activity.push({ component: 'other' }); h.press('back');
    h.visibility(false); h.focusWindow(); h.flushReturnTasks(); assert.strictEqual(h.api.pending(), first);
    queuedReturn(h); assert.strictEqual(h.api.pending(), null); drainReturnModel(h);
});

test('destroyed origin and a new catalog cannot reuse an old return cycle', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending(); h.visibility(true);
    h.press('back'); h.timer(); h.setting('open_catalog'); h.visibility(false); h.focusWindow(); h.flushReturnTasks();
    queuedReturn(h); assert.strictEqual(h.api.pending(), first); assert.strictEqual(first.restoreOwner, h.screen());
    assert.strictEqual(h.played.length, 1); drainReturnModel(h);
});

['settings', 'modal', 'select', 'partial-modal', 'after-visibility'].forEach(function (cover) {
    test('temporary cover discards cycle and never steals UI: ' + cover, function () {
        var h = nativeCatalog(); h.press('enter'); var first = h.api.pending(); h.visibility(true);
        function modal() { h.Lampa.Modal.open({ buttons: [{ name: 'Foreign', onSelect: function () {} }], onBack: function () { h.Lampa.Modal.close(); } }); }
        if (cover === 'settings') h.settingsBoot();
        else if (cover === 'select') h.Lampa.Select.show({ items: [{}], onSelect: function () {} });
        else if (cover === 'partial-modal') {
            h.modalHook(function (stage) { if (stage === 'after-dom') { h.visibility(false); h.focusWindow(); h.flushReturnTasks(); assert.strictEqual(h.api.pending(), first); } }); modal(); h.modalHook(null);
        } else if (cover === 'after-visibility') { h.Lampa.Controller.listener.follow('toggle', function () {}); h.visibility(false); modal(); }
        else modal();
        var controller = h.controller(); var focused = h.document.activeElement; var collection = h.navigation();
        h.visibility(false); h.focusWindow(); h.flushReturnTasks();
        assert.strictEqual(h.api.pending(), first); assert.strictEqual(h.controller(), controller);
        assert.strictEqual(h.document.activeElement, focused); assert.strictEqual(h.navigation(), collection);
        if (cover !== 'settings') h.press('back');
        h.open(); h.focusWindow(); h.flushReturnTasks(); assert.strictEqual(h.api.pending(), first, 'closing cover alone never authorizes');
        drainReturnModel(h);
    });
});

test('loading, error and resources are not eligible return targets', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending(); h.visibility(true);
    h.press('down'); h.press('enter'); h.visibility(false); h.focusWindow(); h.flushReturnTasks();
    assert.strictEqual(h.api.pending(), first); h.reply([video()]); h.flushReturnTasks(); assert.strictEqual(h.api.pending(), first);
    h.press('back');
    h.api.cache['0'] = [{ id: 'r', title: 'Resources', resources: [{ url: 'http://media/a' }, { url: 'http://media/b' }] }];
    h.screen().refresh(); if (h.requests.length) h.reply([]); h.press('enter'); queuedReturn(h);
    assert.strictEqual(h.api.pending(), first); drainReturnModel(h);
});

[false, true].forEach(function (abort) {
    test('internal start and abort without matching external never open bypass: abort=' + abort, function () {
        var h = nativeCatalog({ externalPlayer: false, preCreateAbort: abort }); h.press('enter'); var first = h.api.pending();
        queuedReturn(h); assert.strictEqual(h.api.pending(), first);
        h.Lampa.Player.listener.send('external', { url: h.played[0].url }); queuedReturn(h);
        assert.strictEqual(h.api.pending(), first); assert.strictEqual(h.played.length, 1); drainReturnModel(h);
    });
});

test('late old callback/close/start/external cannot change a newer same-URL attempt', function () {
    var h = nativeCatalog(); h.press('enter'); var old = h.played[0]; queuedReturn(h); queuedOK(h);
    var current = h.api.pending(); assert.ok(current); var before = h.contentToggles();
    h.callback(0); h.closeEvent(old); h.Lampa.Player.listener.send('start', old); h.Lampa.Player.listener.send('external', old);
    h.flushReturnTasks(); assert.strictEqual(h.api.pending(), current); assert.strictEqual(current.internalStarted, undefined);
    assert.strictEqual(h.contentToggles(), before); assert.strictEqual(h.played.length, 2); drainReturnModel(h);
});

['failDiagnosticWrites', 'failDiagnosticRegistration'].forEach(function (failure) {
    test('functional return does not depend on diagnostics: ' + failure, function () {
        var options = {}; options[failure] = true; var h = nativeCatalog(options); h.press('enter');
        queuedReturn(h); assert.strictEqual(h.api.pending(), null); queuedOK(h); assert.strictEqual(h.played.length, 2);
        drainReturnModel(h);
    });
});

test('held OK requires release and a new press after automatic permission', function () {
    var h = nativeCatalog(); h.press('enter'); h.queueInput('keydown'); h.nextInput();
    queuedReturn(h); assert.strictEqual(h.api.pending(), null);
    h.queueInput('keydown', true); h.queueInput('keyup'); h.nextInput(); h.nextInput();
    assert.strictEqual(h.played.length, 1); queuedOK(h); assert.strictEqual(h.played.length, 2); drainReturnModel(h);
});

test('independent native queue retains executable p2 then p1 residual order', function () {
    var h = nativeCatalog({ deferredPlayer: true }); h.press('enter'); h.beginPlayer(); var first = h.played[0];
    queuedReturn(h); queuedOK(h); h.beginPlayer(); var second = h.played[1];
    assert.strictEqual(h.nativePlayers.length, 2); h.beginNative(1); h.beginNative(0);
    assert.deepStrictEqual(h.nativeLaunches, [second, first]); assert.strictEqual(h.api.pending().data, second);
    drainReturnModel(h); assert.strictEqual(h.nativePlayers.length, 0); assert.strictEqual(h.pendingPlayers.length, 0);
});

test('an error in the origin folder blocks automatic permission', function () {
    var h = nativeCatalog(); h.press('enter'); var first = h.api.pending();
    h.visibility(true); delete h.api.cache['0']; h.screen().refresh();
    for (var i = 0; i < 3; i++) { h.fail(); if (i < 2) h.timer(); }
    assert.strictEqual(h.screen().playbackContext().error, true); h.visibility(false); h.focusWindow(); h.flushReturnTasks();
    assert.strictEqual(h.api.pending(), first); drainReturnModel(h);
});

test('new pointer gesture is required; an old click alone cannot launch', function () {
    var h = nativeCatalog(); h.press('enter'); queuedReturn(h);
    h.click(h.rows()[0]); assert.strictEqual(h.played.length, 1);
    h.pointerDown(h.rows()[0]); h.click(h.rows()[0]); assert.strictEqual(h.played.length, 2);
    drainReturnModel(h);
});

test('a fresh press interrupted by blur cannot turn into a residual launch', function () {
    var h = nativeCatalog(); h.press('enter'); queuedReturn(h);
    h.queueInput('keydown'); h.nextInput(); h.blurWindow(); h.focusWindow(); h.flushReturnTasks();
    h.queueInput('keyup'); h.nextInput(); assert.strictEqual(h.played.length, 1);
    queuedOK(h); assert.strictEqual(h.played.length, 2); drainReturnModel(h);
});

test('automatic cycles keep fixed subscriptions and scalar state only', function () {
    var h = nativeCatalog(); var counts;
    function countsNow() { return [h.recoveryHandlers(), h.windowHandlers(), h.visibilityHandlers(), h.selectObserverCount(),
        h.Lampa.Keypad.listener.count('keydown'), h.Lampa.Keypad.listener.count('keyup'), h.startHandlers()].join(':'); }
    counts = countsNow(); h.press('enter');
    for (var i = 0; i < 10; i++) {
        var session = h.api.pending();
        Object.keys(h.api.autoReturn()).forEach(function (key) { assert.ok(['number', 'string', 'boolean'].indexOf(typeof h.api.autoReturn()[key]) >= 0); });
        queuedReturn(h); assert.strictEqual(session.restoreOwner, null); assert.strictEqual(h.api.autoReturn(), null);
        assert.strictEqual(countsNow(), counts);
        if (i < 9) queuedOK(h);
    }
    assert.strictEqual(h.played.length, 10); drainReturnModel(h); assert.strictEqual(h.nativeLaunches.length, 10);
    assert.ok(h.api.records.length <= 100);
});

test('internal Player classification survives failed diagnostic registration', function () {
    var h = nativeCatalog({ externalPlayer: false, failDiagnosticRegistration: true }); h.press('enter');
    var first = h.api.pending(); assert.strictEqual(first.internalStarted, true);
    queuedReturn(h); h.Lampa.Player.listener.send('external', first.data); queuedReturn(h);
    assert.strictEqual(h.api.pending(), first); h.closePlayer(); assert.strictEqual(h.api.pending(), null); drainReturnModel(h);
});

['OK', 'pointer'].forEach(function (input) {
    test('automatic permission permits fresh multi-resource selection via ' + input, function () {
        var h = nativeCatalog();
        h.api.cache['0'].push({ title: 'Multi', resources: [
            { url: 'http://media/one.mp4', mime: 'video/mp4' },
            { url: 'http://media/two.mp4', mime: 'video/mp4' }
        ] });
        // Refresh from the cache before launching the original attempt.
        h.screen().refresh(); h.press('enter'); queuedReturn(h);
        assert.strictEqual(h.api.pending(), null); assert.strictEqual(h.played.length, 1);
        h.press('down'); h.press('down'); queuedOK(h);
        assert.strictEqual(h.title(), 'Multi'); assert.strictEqual(h.played.length, 1);
        // Neither an orphan release, a repeat, nor a click without a new press is input permission.
        h.queueInput('keyup'); h.nextInput();
        h.queueInput('keydown', true); h.queueInput('keyup'); h.nextInput(); h.nextInput();
        h.click(h.rows()[0]); assert.strictEqual(h.played.length, 1);
        h.press('back'); assert.strictEqual(h.title(), 'DLNA');
        queuedOK(h); assert.strictEqual(h.title(), 'Multi');
        h.press('down'); h.press('up'); h.press('down');
        if (input === 'OK') queuedOK(h);
        else { h.pointerDown(h.rows()[1]); h.click(h.rows()[1]); }
        assert.strictEqual(h.played.length, 2);
        assert.strictEqual(h.played[1].url, 'http://media/two.mp4');
        h.press('back'); assert.strictEqual(h.title(), 'DLNA');
        h.press('back'); assertDlnaSettings(h); h.timer();
        h.setting('open_catalog');
        assert.strictEqual(h.title(), 'DLNA');
        h.press('down'); h.press('down');
        queuedOK(h); assert.strictEqual(h.title(), 'Multi');
        queuedOK(h); assert.strictEqual(h.played.length, 2); // The new pending attempt still locks playback.
        h.press('back'); assert.strictEqual(h.title(), 'DLNA');
        drainReturnModel(h);
    });
});
