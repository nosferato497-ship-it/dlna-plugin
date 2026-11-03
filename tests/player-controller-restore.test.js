var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var test = require('node:test');

function createPluginHarness(toggleFailures) {
    var closeHandler;
    var playerCallback;
    var restored = [];
    var toggles = 0;
    var activeController = 'settings_component';
    var source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

    source = source.replace(
        'if (window.appready) init();',
        'window.__test = { init: init, play: play, getPlayerReturnController: function () { return playerReturnController; } }; if (window.appready) init();'
    );

    var Lampa = {
        SettingsApi: {
            addComponent: function () {},
            addParam: function () {}
        },
        Storage: { field: function () { return ''; } },
        Lang: {
            add: function () {},
            translate: function (value) { return value; }
        },
        Controller: {
            enabled: function () { return { name: activeController }; },
            toggle: function (name) {
                toggles++;
                if (toggleFailures > 0) {
                    toggleFailures--;
                    throw new Error('Controller.toggle failed');
                }
                activeController = name;
                restored.push(name);
            }
        },
        Player: {
            listener: {
                follow: function (name, callback) {
                    if (name === 'close') closeHandler = callback;
                }
            },
            callback: function (callback) { playerCallback = callback; },
            play: function () {}
        },
        Noty: { show: function () {} }
    };
    var window = { Lampa: Lampa, appready: false };
    var document = { getElementById: function () { return null; } };

    vm.runInNewContext(source, {
        window: window,
        Lampa: Lampa,
        document: document,
        console: { log: function () {} }
    });
    window.__test.init();

    return {
        play: function () {
            window.__test.play({ url: 'http://server/video', title: 'video' });
        },
        closePlayer: function () {
            if (typeof playerCallback === 'function') playerCallback();
            if (closeHandler) closeHandler();
        },
        setActiveController: function (name) { activeController = name; },
        activeController: function () { return activeController; },
        playerReturnController: function () { return window.__test.getPlayerReturnController(); },
        restored: restored,
        toggles: function () { return toggles; }
    };
}

test('retries controller restore through player close listener after callback toggle throws', function () {
    var harness = createPluginHarness(1);
    harness.play();
    harness.setActiveController('player');

    assert.doesNotThrow(function () { harness.closePlayer(); });
    assert.strictEqual(harness.toggles(), 2);
    assert.deepStrictEqual(harness.restored, ['settings_component']);
    assert.strictEqual(harness.activeController(), 'settings_component');
});

test('preserves the return controller when the close fallback toggle throws', function () {
    var harness = createPluginHarness(2);
    harness.play();
    harness.setActiveController('player');

    assert.doesNotThrow(function () { harness.closePlayer(); });
    assert.strictEqual(harness.toggles(), 2);
    assert.strictEqual(harness.playerReturnController(), 'settings_component');
    assert.deepStrictEqual(harness.restored, []);

    assert.doesNotThrow(function () { harness.closePlayer(); });
    assert.strictEqual(harness.toggles(), 3);
    assert.strictEqual(harness.playerReturnController(), null);
    assert.deepStrictEqual(harness.restored, ['settings_component']);
});
