'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

function createHarness(overrides = {}) {
    const timers = new Map();
    const requests = [];
    const params = [];
    const plays = [];
    let timerId = 0;
    const Lampa = {
        SettingsApi: {
            addComponent() {},
            addParam(param) { params.push(param); }
        },
        Storage: {
            field(key) {
                if (key === 'dlna_bridge_renderer_url') return 'http://192.168.1.12/device.xml';
                return '';
            }
        },
        Player: { play(data) { plays.push(data); } },
        Reguest: function () {
            this.native = function (url, success, failure, body, options) {
                requests.push({ url, success, failure, body, options });
            };
        }
    };
    const window = { Lampa, appready: true, ...overrides };
    vm.runInNewContext(source.replace('    start();', `
        window.testApi = { play: play, discover: discoverSsdpDevices, avPlay: avPlay };
        start();`), {
        window, Lampa, document: { getElementById() { return null; } },
        setTimeout(callback) {
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); }
    });
    return {
        ...window.testApi, requests, params, plays, timers,
        expire() {
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
        }
    };
}

test('a saved Renderer URL does not cause network activity in local mode', () => {
    const harness = createHarness();
    assert.equal(harness.requests.length, 0);
    const target = harness.params.find(entry => entry.param.name === 'dlna_bridge_playback_target');
    assert.equal(target.param.default, 'local');
    assert.equal(harness.params.length, 19);
    harness.play({ title: 'Video', url: 'http://192.168.1.2/video.mp4' });
    assert.equal(harness.plays.length, 1);
    assert.equal(harness.requests.length, 0);
});

test('AVTransport Play uses the advertised endpoint and SOAP action', () => {
    const harness = createHarness();
    const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1';
    const controlURL = 'http://192.168.1.12/avtransport';
    harness.avPlay({ services: { avTransport: { serviceType, controlURL } } }, () => {});
    const [request] = harness.requests;
    assert.equal(request.url, controlURL);
    assert.equal(request.options.headers.SOAPAction, '"' + serviceType + '#Play"');
    assert.match(request.body, /<InstanceID>0<\/InstanceID>.*<Speed>1<\/Speed>/);
});

test('a stalled AndroidJS promise or callback times out once and releases discovery', () => {
    for (const returnValue of [undefined, { then() {} }]) {
        let deliver;
        const harness = createHarness({
            AndroidJS: { ssdpDiscover(options, success) {
                assert.equal(options.st, 'test');
                deliver = success;
                return returnValue;
            } }
        });
        const results = [];
        const options = { targets: ['test'], timeoutMs: 250 };
        harness.discover(options, error => results.push(error));
        assert.equal(results.length, 0);
        harness.expire();
        assert.match(results[0].message, /SSDP/);
        deliver(['HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.12/device.xml\r\n']);
        assert.equal(results.length, 1);
        assert.equal(harness.requests.length, 0);
        harness.discover(options, error => results.push(error));
        deliver([]);
        assert.equal(results.length, 2);
        assert.equal(results[1], null);
        assert.equal(harness.timers.size, 0);
    }
});

test('SSDP ignores device-description responses after its HTTP deadline', () => {
    const harness = createHarness({
        AndroidJS: { ssdpDiscover() { return ['HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.12/device.xml\r\n']; } }
    });
    const results = [];
    harness.discover({ targets: ['test'] }, error => results.push(error));
    assert.equal(harness.requests.length, 1);
    harness.expire();
    assert.match(results[0].message, /SSDP/);
    harness.requests[0].success('<root/>');
    assert.equal(results.length, 1);
    harness.discover({ targets: ['test'] }, error => results.push(error));
    assert.equal(harness.requests.length, 2);
});

test('a stalled Chrome UDP bind closes socket zero, removes its listener and ignores late bind', () => {
    let bound;
    let listener;
    const closed = [];
    const harness = createHarness({ chrome: { sockets: { udp: {
        create(properties, callback) { callback({ socketId: 0 }); },
        bind(id, address, port, callback) { bound = callback; },
        send() { assert.fail('late bind must not send'); },
        close(id) { closed.push(id); },
        onReceive: {
            addListener(callback) { listener = callback; },
            removeListener(callback) { assert.equal(listener, callback); listener = null; }
        }
    } } } });
    const results = [];
    harness.discover({ targets: ['test'] }, error => results.push(error));
    assert.equal(typeof listener, 'function');
    harness.expire();
    bound(0);
    assert.deepEqual(closed, [0]);
    assert.equal(listener, null);
    assert.match(results[0].message, /SSDP/);
    assert.equal(results.length, 1);
});
