var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function decodeXml(value) {
    return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function makeNode(name, attributes, type, text) {
    var node = {
        nodeName: name,
        localName: name.split(':').pop(),
        nodeType: type,
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
    var tokens = String(source).match(/<\?[^>]*\?>|<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
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
            while ((attributeMatch = attributePattern.exec(match[2]))) attributes[attributeMatch[1]] = decodeXml(attributeMatch[3]);
            var element = makeNode(match[1], attributes, 1, '');
            stack[stack.length - 1].childNodes.push(element);
            if (!documentNode.documentElement) documentNode.documentElement = element;
            if (!selfClosing) stack.push(element);
        } else if (stack.length > 1) {
            var text = decodeXml(token);
            stack[stack.length - 1].childNodes.push(makeNode('#text', {}, 3, text));
            stack[stack.length - 1].textContent += text;
        }
    }
    documentNode.getElementsByTagName = function (tag) {
        var found = [];
        function visit(parent) {
            var i;
            for (i = 0; i < parent.childNodes.length; i++) {
                var child = parent.childNodes[i];
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

function res(url, attributes) {
    var attrs = '';
    Object.keys(attributes || {}).forEach(function (name) {
        attrs += ' ' + name + '="' + escapeXml(attributes[name]) + '"';
    });
    return '<res' + attrs + '>' + escapeXml(url) + '</res>';
}

function itemXml(resources, title) {
    return '<DIDL-Lite><item id="video" parentID="0"><dc:title>' + escapeXml(title || 'Video') + '</dc:title>' +
        resources.join('') + '</item></DIDL-Lite>';
}

function createHarness(dom) {
    var selects = [];
    var played = [];
    var notices = [];
    var cached = {};
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
    source = source.replace(
        'if (window.appready) init();',
        'window.__test = { decodeDidl: decodeDidl, showFolder: showFolder, play: play, isValidResourceUrl: isValidResourceUrl, cache: cache }; if (window.appready) init();'
    );
    var controller = { name: 'settings_component' };
    var Lampa = {
        Listener: { follow: function () {} },
        SettingsApi: { addComponent: function () {}, addParam: function () {} },
        Storage: { field: function () { return ''; } },
        Lang: { add: function () {}, translate: function (value) { return value; } },
        Controller: {
            enabled: function () { return controller; },
            toggle: function (name) { controller = { name: name }; },
            add: function () {}, windowOpen: function () {}, windowClose: function () {},
            collectionSet: function () {}, collectionFocus: function () {}
        },
        Select: { show: function (config) { selects.push(config); } },
        Player: { play: function (data) {
            if (dom) assertMenuClosed(dom);
            played.push(data);
        }, callback: function () {} },
        Noty: { show: function (message) { notices.push(message); } }
    };
    var window = { Lampa: Lampa, appready: false, DOMParser: TestDOMParser, $: function (value) { return value; } };
    var document = {
        getElementById: function () { return null; },
        createElement: function () { return { style: {}, textContent: '' }; }
    };
    if (dom) {
        document = dom.document;
        window.addEventListener = dom.addEventListener;
        window.removeEventListener = dom.removeEventListener;
        delete Lampa.Select;
    }
    vm.runInNewContext(source, {
        window: window,
        Lampa: Lampa,
        document: document,
        DOMParser: TestDOMParser,
        setTimeout: dom && dom.setTimeout,
        clearTimeout: dom && dom.clearTimeout,
        console: { log: function () {}, error: function () {} }
    });
    return { test: window.__test, selects: selects, played: played, notices: notices, cache: cached };
}

function runCachedFolder(harness, entries) {
    harness.test.cache.library = entries;
    harness.test.showFolder('library', 'Library', []);
    assert.strictEqual(harness.selects.length, 1);
    return harness.selects[0];
}

test('parses one resource and keeps legacy fields and resource metadata', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([res('http://media/video.mp4', {
        protocolInfo: 'http-get:*:video/mp4:DLNA.ORG_OP=01', size: '1048576', duration: '00:01:20', resolution: '1280x720', bitrate: '2400000'
    })]))[0];
    assert.strictEqual(entry.resources.length, 1);
    assert.strictEqual(entry.url, 'http://media/video.mp4');
    assert.strictEqual(entry.mime, 'video/mp4');
    assert.strictEqual(entry.resources[0].size, 1048576);
    assert.strictEqual(entry.resources[0].duration, '00:01:20');
    assert.strictEqual(entry.resources[0].resolution, '1280x720');
    assert.strictEqual(entry.resources[0].bitrate, 2400000);

    var select = runCachedFolder(harness, [entry]);
    select.items[0].onSelect();
    assert.strictEqual(harness.selects.length, 1);
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://media/video.mp4');
});

test('parses distinct resources including different MIME types and metadata', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/video-720.mp4', { protocolInfo: 'http-get:*:video/mp4:*', resolution: '1280x720', size: '5000000' }),
        res('http://media/video-1080.mkv?profile=high&token=a%2Fb', { protocolInfo: 'http-get:*:video/x-matroska:*', resolution: '1920x1080', size: '12000000', bitrate: '6000000' })
    ]))[0];
    assert.strictEqual(entry.resources.length, 2);
    assert.strictEqual(entry.resources[0].mime, 'video/mp4');
    assert.strictEqual(entry.resources[1].mime, 'video/x-matroska');
    assert.strictEqual(entry.resources[1].resolution, '1920x1080');
    assert.strictEqual(entry.resources[1].size, 12000000);
    assert.strictEqual(entry.resources[1].url, 'http://media/video-1080.mkv?profile=high&token=a%2Fb');
});

test('omits empty and invalid resource URLs and deduplicates exact URL strings', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('javascript:alert(1)', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('file:///video.mkv', { protocolInfo: 'http-get:*:video/x-matroska:*' }),
        res('http:///missing-host.mp4', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('http://?missing-host=1', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('http://media.example:invalid/video.mp4', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('http://media/video.mp4', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('http://media/video.mp4', { protocolInfo: 'http-get:*:video/webm:*' })
    ]))[0];
    assert.strictEqual(entry.resources.length, 1);
    assert.strictEqual(entry.resources[0].mime, 'video/mp4');
    assert.strictEqual(entry.url, 'http://media/video.mp4');
});

test('decodes XML-escaped URL query delimiters and preserves encoded query values', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/video.mkv?a=1&b=x%2Fy', { protocolInfo: 'http-get:*:video/x-matroska:*' })
    ]))[0];
    assert.strictEqual(entry.resources[0].url, 'http://media/video.mkv?a=1&b=x%2Fy');
});

test('handles missing resource metadata and ignores an item with no usable URL at playback', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([res('http://media/no-meta', {})]))[0];
    assert.strictEqual(entry.resources[0].mime, '');
    assert.strictEqual(entry.resources[0].duration, '');
    assert.strictEqual(entry.resources[0].size, 0);
    assert.strictEqual(entry.resources[0].resolution, '');
    assert.strictEqual(entry.resources[0].bitrate, 0);
    harness.test.play({ title: 'No URL', url: '', resources: [] });
    assert.strictEqual(harness.played.length, 0);
});

test('does not start playback from the catalog when every resource URL is unusable', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('ftp://media/video.mp4', { protocolInfo: 'http-get:*:video/mp4:*' })
    ], 'Broken'))[0];
    assert.strictEqual(entry.title, 'Broken');
    assert.strictEqual(entry.resources.length, 0);
    assert.strictEqual(entry.url, '');
    var catalog = runCachedFolder(harness, [entry]);
    catalog.items[0].onSelect();
    assert.strictEqual(harness.played.length, 0);
    assert.strictEqual(harness.selects.length, 1);
});

test('shows the resource count in the catalog row of a multi-resource item', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/a.mp4', { protocolInfo: 'http-get:*:video/mp4:*', size: '1000000' }),
        res('http://media/b.mkv', { protocolInfo: 'http-get:*:video/x-matroska:*', size: '9000000' })
    ]))[0];
    var catalog = runCachedFolder(harness, [entry]);
    assert.strictEqual(catalog.items[0].subtitle, 'Ресурсов: 2');
});

test('shows a native resource menu for multiple resources and plays the selected URL', function () {
    var index;
    var urls = ['http://media/low.mp4', 'http://media/high.mp4'];
    for (index = 0; index < urls.length; index++) {
        var harness = createHarness();
        var entry = harness.test.decodeDidl(itemXml([
            res(urls[0], { protocolInfo: 'http-get:*:video/mp4:*', resolution: '640x360', size: '1000000' }),
            res(urls[1], { protocolInfo: 'http-get:*:video/mp4:*', resolution: '1920x1080', size: '9000000' })
        ]))[0];
        var catalog = runCachedFolder(harness, [entry]);
        catalog.items[0].onSelect();
        assert.strictEqual(harness.played.length, 0);
        assert.strictEqual(harness.selects.length, 2);
        assert.match(harness.selects[1].items[0].subtitle, /640x360/);
        assert.match(harness.selects[1].items[1].subtitle, /1920x1080/);
        harness.selects[1].items[index].onSelect();
        assert.strictEqual(harness.played.length, 1);
        assert.strictEqual(harness.played[0].url, urls[index]);
    }
});

test('returns from resource selection to the catalog and permits reopening the item', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/a.mp4', { protocolInfo: 'http-get:*:video/mp4:*' }),
        res('http://media/b.mp4', { protocolInfo: 'http-get:*:video/mp4:*' })
    ]))[0];
    var catalog = runCachedFolder(harness, [entry]);
    catalog.items[0].onSelect();
    harness.selects[1].onBack();
    assert.strictEqual(harness.selects.length, 3);
    assert.strictEqual(harness.selects[2].title, 'Library');
    harness.selects[2].items[0].onSelect();
    assert.strictEqual(harness.selects.length, 4);
    harness.selects[3].items[0].onSelect();
    assert.strictEqual(harness.played[0].url, 'http://media/a.mp4');
});

test('falls back to the legacy URL field when resources is absent', function () {
    var harness = createHarness();
    var catalog = runCachedFolder(harness, [{
        id: 'legacy', title: 'Legacy item', isFolder: false, url: 'http://media/legacy.mkv', mime: 'video/x-matroska'
    }]);
    catalog.items[0].onSelect();
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://media/legacy.mkv');
});


test('skips MiniDLNA subtitle and thumbnail resources and plays the video directly', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://192.168.1.1:8200/MediaItems/22.mkv', {
            protocolInfo: 'http-get:*:video/x-matroska:DLNA.ORG_OP=01;DLNA.ORG_CI=0', size: '734003200', duration: '0:42:10.000', resolution: '1920x1080'
        }),
        res('http://192.168.1.1:8200/Captions/22.srt', { protocolInfo: 'http-get:*:text/srt:*' }),
        res('http://192.168.1.1:8200/Captions/22.ass', { protocolInfo: 'http-get:*:application/x-ass:*' }),
        res('http://192.168.1.1:8200/Thumbnails/22.jpg', { protocolInfo: 'http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_TN' })
    ], 'Episode'))[0];
    assert.strictEqual(entry.resources.length, 1);
    assert.strictEqual(entry.url, 'http://192.168.1.1:8200/MediaItems/22.mkv');
    assert.strictEqual(entry.mime, 'video/x-matroska');
    assert.strictEqual(entry.size, 734003200);

    var catalog = runCachedFolder(harness, [entry]);
    assert.strictEqual(catalog.items[0].subtitle.indexOf('Ресурсов'), -1);
    assert.ok(catalog.items[0].subtitle.indexOf('video/x-matroska') >= 0);
    catalog.items[0].onSelect();
    assert.strictEqual(harness.selects.length, 1);
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://192.168.1.1:8200/MediaItems/22.mkv');
});

test('keeps streaming and unlabeled resources that are not auxiliary', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/stream.m3u8', { protocolInfo: 'http-get:*:application/vnd.apple.mpegurl:*' }),
        res('http://media/raw.bin', { protocolInfo: 'http-get:*:application/octet-stream:*' }),
        res('http://media/no-protocol', {}),
        res('http://media/cover.png', { protocolInfo: 'http-get:*:IMAGE/PNG:*' })
    ]))[0];
    assert.strictEqual(entry.resources.map(function (resource) { return resource.url; }).join(' '),
        'http://media/stream.m3u8 http://media/raw.bin http://media/no-protocol');
});

test('takes legacy fields from the first playable resource', function () {
    var harness = createHarness();
    var entry = harness.test.decodeDidl(itemXml([
        res('http://media/first.mp4', { protocolInfo: 'http-get:*:video/mp4:*', size: '100', duration: '0:01:00' }),
        res('http://media/second.mkv', { protocolInfo: 'http-get:*:video/x-matroska:*', size: '200', duration: '0:02:00' })
    ]))[0];
    assert.strictEqual(entry.resources.length, 2);
    assert.strictEqual(entry.url, 'http://media/first.mp4');
    assert.strictEqual(entry.mime, 'video/mp4');
    assert.strictEqual(entry.size, 100);
    assert.strictEqual(entry.duration, '0:01:00');
});

var invalidPlaybackUrls = [
    '',
    'javascript:alert(1)', 'data:text/html,test', 'file:///video.mp4',
    'ftp://server/video.mp4', '/video.mp4', '//server/video.mp4',
    'http://999.999.999.999/video.mp4', 'http://256.1.1.1/video.mp4',
    'http://1.2.3/video.mp4', 'http://1.2.3.4.5/video',
    'http://[::::]:8200/video', 'http://[1::2::3]/video',
    'http://[1:2:3:4:5:6:7]/video', 'http://[1:2:3:4:5:6:7:8:9]/video',
    'http://[1:2:3:4:5:6:7:8::]/video', 'http://[gggg::1]/video',
    'http://[::ffff:256.1.1.1]/video', 'http://[::1/video',
    'http://[::1]extra/video', 'http://::1/video',
    'http:///video', 'http://:80/video', 'http://host:0/video',
    'http://host:65536/video', 'http://host:/video', 'http://host:no/video',
    'http://user@other@host/video', 'http://bad_host/video',
    'http://host\\@evil/video', 'http://host/%zz', 'http://host/line\nfeed',
    'http://0x7f000001/video', 'http://0177.0.0.1/video'
];

invalidPlaybackUrls.forEach(function (url) {
    test('rejects URL at parsing and every playback entry: ' + JSON.stringify(url), function () {
        var harness = createHarness();
        assert.strictEqual(harness.test.isValidResourceUrl(url), false);
        assert.strictEqual(harness.test.decodeDidl(itemXml([res(url, {})]))[0].resources.length, 0);
        harness.test.play({ title: 'Legacy', url: url });
        harness.test.play({ title: 'Resource', url: 'http://media/fallback', resources: [{ url: url }] });
        harness.test.play({ title: 'Selected', url: 'http://media/fallback' }, { url: url });
        assert.strictEqual(harness.played.length, 0);
        assert.strictEqual(harness.notices.length, 3);
    });
});

var validPlaybackUrls = [
    'http://192.168.1.1:8200/video.mp4', 'http://127.0.0.1/video.mp4',
    'http://localhost:8200/video.mp4', 'http://media-server/video',
    'http://media.example.org/video', 'http://media.example.org./video',
    'http://[::1]/video', 'http://[2001:db8::abcd]:8200/video',
    'http://[1:2:3:4:5:6:7:8]/video', 'http://[::]/video',
    'http://[::ffff:192.168.1.1]/video', 'http://[1:2:3:4:5:6:192.168.1.1]/video',
    'https://media/video', 'http://media/video?a=1&token=x%2Fy',
    'http://media/video#chapter', 'http://media/a%20b/video',
    'http://user:p%40ss@media/video'
];
[1, 80, 443, 65535].forEach(function (port) {
    validPlaybackUrls.push('http://localhost:' + port + '/video');
    validPlaybackUrls.push('http://[::1]:' + port + '/video');
});
validPlaybackUrls.forEach(function (url) {
    test('preserves valid URL in legacy and selected playback: ' + url, function () {
        var harness = createHarness();
        assert.strictEqual(harness.test.isValidResourceUrl(url), true);
        harness.test.play({ title: 'Legacy', url: url });
        harness.test.play({ title: 'Selected' }, { url: url });
        assert.strictEqual(harness.played.length, 2);
        assert.strictEqual(harness.played[0].url, url);
        assert.strictEqual(harness.played[1].url, url);
    });
});

test('bounds URL length at 8192 characters for parsing and playback', function () {
    var harness = createHarness();
    var prefix = 'http://media/video?token=';
    [8192, 8193, 16384].forEach(function (length) {
        var url = prefix + new Array(length - prefix.length + 1).join('a');
        assert.strictEqual(harness.test.isValidResourceUrl(url), length === 8192);
        assert.strictEqual(harness.test.decodeDidl(itemXml([res(url, {})]))[0].resources.length, length === 8192 ? 1 : 0);
        var before = harness.played.length;
        harness.test.play({ title: 'Legacy', url: url });
        assert.strictEqual(harness.played.length - before, length === 8192 ? 1 : 0);
    });
});

test('invalid selected URL leaves resource menu Back and reopening usable', function () {
    var harness = createHarness();
    var entry = { title: 'Video', resources: [
        { url: 'http://media/a', resolution: '640x360' },
        { url: 'http://media/b', resolution: '1920x1080' }
    ] };
    var catalog = runCachedFolder(harness, [entry]);
    catalog.items[0].onSelect();
    var beforeNotices = harness.notices.length;
    entry.resources[1].url = 'javascript:alert(1)';
    harness.selects[1].items[1].onSelect();
    assert.strictEqual(harness.played.length, 0);
    assert.strictEqual(harness.notices.length - beforeNotices, 1);
    harness.selects[1].onBack();
    harness.selects[2].items[0].onSelect();
    harness.selects[3].items[0].onSelect();
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://media/a');
});

// Minimal DOM and deterministic timers: run the real menu code, not callback stubs.
function menuDom() {
    var listeners = { keydown: [], keyup: [] };
    var timers = {};
    var nextTimer = 0;
    var dom = {};
    function element(tag) {
        return {
            tag: tag, style: {}, children: [], events: {}, parentNode: null,
            appendChild: function (child) { this.children.push(child); child.parentNode = this; },
            removeChild: function (child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
            addEventListener: function (type, handler) { this.events[type] = handler; },
            focus: function () {
                dom.document.activeElement = this;
                if (this.events.focus) this.events.focus();
            },
            scrollIntoView: function () {}
        };
    }
    function descendants(node) {
        var result = [node];
        node.children.forEach(function (child) { result = result.concat(descendants(child)); });
        return result;
    }
    dom.document = {
        body: element('body'), activeElement: null, createElement: element,
        getElementById: function (id) {
            return descendants(this.body).filter(function (node) { return node.id === id; })[0] || null;
        }
    };
    dom.addEventListener = function (type, handler) { listeners[type].push(handler); };
    dom.removeEventListener = function (type, handler) {
        listeners[type] = listeners[type].filter(function (candidate) { return candidate !== handler; });
    };
    dom.setTimeout = function (callback, delay) {
        assert.strictEqual(delay, 600);
        timers[++nextTimer] = callback;
        return nextTimer;
    };
    dom.clearTimeout = function (id) { delete timers[id]; };
    dom.flush = function () {
        Object.keys(timers).forEach(function (id) {
            var callback = timers[id];
            delete timers[id];
            if (callback) callback();
        });
    };
    dom.pending = function () { return Object.keys(timers).length; };
    dom.count = function (type) { return listeners[type].length; };
    dom.key = function (key, type) {
        var event = { key: key, preventDefault: function () {}, stopPropagation: function () {}, stopImmediatePropagation: function () {} };
        listeners[type || 'keydown'].slice().forEach(function (handler) { handler(event); });
    };
    dom.overlay = function () { return dom.document.getElementById('dlna-bridge-menu'); };
    dom.buttons = function () { return descendants(dom.document.body).filter(function (node) { return node.tag === 'button'; }); };
    return dom;
}

function domFolder(entries) {
    var dom = menuDom();
    var harness = createHarness(dom);
    harness.test.cache.library = entries;
    harness.test.showFolder('library', 'Library', []);
    return { dom: dom, harness: harness };
}

function assertMenuOpen(dom, index) {
    assert.ok(dom.overlay());
    assert.strictEqual(dom.count('keydown'), 1);
    assert.strictEqual(dom.count('keyup'), 1);
    assert.strictEqual(dom.document.activeElement, dom.buttons()[index]);
}

function assertMenuClosed(dom) {
    assert.strictEqual(dom.overlay(), null);
    assert.strictEqual(dom.count('keydown'), 0);
    assert.strictEqual(dom.count('keyup'), 0);
    assert.strictEqual(dom.pending(), 0);
}

test('DOM invalid legacy OK preserves overlay, focus and Back without pending callbacks', function () {
    var state = domFolder([{ title: 'Bad', url: 'javascript:alert(1)' }]);
    var dom = state.dom;
    var harness = state.harness;
    var before = harness.notices.length;
    dom.key('Enter');
    dom.key('Enter');
    dom.key('Enter', 'keyup');
    assertMenuOpen(dom, 0);
    assert.strictEqual(dom.pending(), 0);
    assert.strictEqual(harness.notices.length - before, 2);
    assert.strictEqual(harness.played.length, 0);
    dom.key('Escape');
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(harness.played.length, 0);
});

test('DOM invalid resource permits selecting a valid second resource exactly once', function () {
    var state = domFolder([{ title: 'Video', resources: [
        { url: 'http://[::::]/bad' }, { url: 'http://media/good', resolution: '1920x1080' }
    ] }]);
    var dom = state.dom;
    var harness = state.harness;
    dom.key('Enter');
    dom.flush();
    assertMenuOpen(dom, 0);
    assert.match(dom.buttons()[1].textContent, /1920x1080/);
    dom.key('Enter');
    assertMenuOpen(dom, 0);
    assert.strictEqual(dom.pending(), 0);
    dom.key('ArrowDown');
    assertMenuOpen(dom, 1);
    dom.key('Enter');
    dom.key('Enter');
    dom.buttons()[1].events.click();
    assert.strictEqual(dom.pending(), 1);
    assert.strictEqual(harness.played.length, 0);
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(harness.played.length, 1);
    assert.strictEqual(harness.played[0].url, 'http://media/good');
    dom.flush();
    assert.strictEqual(harness.played.length, 1);
});

test('DOM quick Back cancels pending valid playback and allows reopening', function () {
    var state = domFolder([{ title: 'Legacy', url: 'http://media/legacy' }]);
    var dom = state.dom;
    var harness = state.harness;
    dom.key('Enter');
    assert.strictEqual(dom.pending(), 1);
    assertMenuOpen(dom, 0);
    dom.key('Escape');
    dom.key('Escape', 'keyup');
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(harness.played.length, 0);
    harness.test.showFolder('library', 'Library', []);
    assertMenuOpen(dom, 0);
    dom.key('Enter');
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(harness.played.length, 1);
});

test('DOM error Back returns to catalog and reopening does not leak listeners', function () {
    var state = domFolder([{ title: 'Video', resources: [
        { url: 'data:text/html,bad' }, { url: 'http://media/good' }
    ] }]);
    var dom = state.dom;
    var harness = state.harness;
    var i;
    for (i = 0; i < 3; i++) {
        dom.key('Enter');
        dom.flush();
        dom.key('Enter');
        assertMenuOpen(dom, 0);
        dom.key('Escape');
        assertMenuOpen(dom, 0);
        assert.match(dom.buttons()[0].textContent, /Video/);
    }
    assert.strictEqual(harness.played.length, 0);
    dom.key('Escape');
    assertMenuClosed(dom);
});

test('DOM replacement cancels old pending choice and stale button callbacks', function () {
    var state = domFolder([{ title: 'Legacy', url: 'http://media/legacy' }]);
    var dom = state.dom;
    var harness = state.harness;
    var oldButton = dom.buttons()[0];
    oldButton.events.click();
    harness.test.showFolder('library', 'Library', []);
    oldButton.events.click();
    dom.flush();
    assertMenuOpen(dom, 0);
    assert.strictEqual(harness.played.length, 0);
    dom.key('Escape');
    assertMenuClosed(dom);
});

test('DOM rechecks URL changed during delay before closing and preserves selected focus', function () {
    var entry = { title: 'Legacy', url: 'http://media/legacy' };
    var state = domFolder([entry]);
    var dom = state.dom;
    var harness = state.harness;
    dom.key('Enter');
    entry.url = 'javascript:alert(1)';
    dom.flush();
    assertMenuOpen(dom, 0);
    assert.strictEqual(harness.played.length, 0);
    entry.url = 'http://media/recovered';
    dom.key('Enter');
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(harness.played[0].url, entry.url);
});

test('DOM click on invalid second resource retains its focus and permits first resource', function () {
    var state = domFolder([{ title: 'Video', resources: [
        { url: 'http://media/first' }, { url: 'ftp://media/bad' }
    ] }]);
    var dom = state.dom;
    dom.key('Enter');
    dom.flush();
    dom.buttons()[1].events.click();
    assertMenuOpen(dom, 1);
    assert.strictEqual(dom.pending(), 0);
    dom.key('ArrowUp');
    dom.key('Enter');
    dom.flush();
    assertMenuClosed(dom);
    assert.strictEqual(state.harness.played.length, 1);
    assert.strictEqual(state.harness.played[0].url, 'http://media/first');
});

test('DOM quick Back in resource menu cancels choice and restores catalog focus', function () {
    var state = domFolder([{ title: 'Video', resources: [
        { url: 'http://media/first' }, { url: 'http://media/second' }
    ] }]);
    var dom = state.dom;
    dom.key('Enter');
    dom.flush();
    dom.key('ArrowDown');
    dom.key('Enter');
    dom.key('Escape');
    dom.flush();
    assertMenuOpen(dom, 0);
    assert.strictEqual(state.harness.played.length, 0);
    dom.key('Enter');
    dom.flush();
    assertMenuOpen(dom, 0);
    dom.key('Escape');
    dom.key('Escape');
    assertMenuClosed(dom);
});
