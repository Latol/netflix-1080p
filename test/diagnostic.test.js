const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const core = require(path.join(root, "diagnostic", "core.js"));

function read(name) {
    return fs.readFileSync(path.join(root, name), "utf8");
}

function chromeId(der) {
    const hash = crypto.createHash("sha256").update(der).digest();
    let id = "";
    for (const byte of hash.subarray(0, 16)) {
        id += String.fromCharCode(97 + (byte >> 4));
        id += String.fromCharCode(97 + (byte & 15));
    }
    return id;
}

function fakeClock() {
    const timers = [];
    return {
        timers: timers,
        schedule(fn) {
            timers.push(fn);
            return timers.length;
        },
        clear(id) {
            timers[id - 1] = null;
        },
        fireNext() {
            const index = timers.findIndex(Boolean);
            if (index === -1) return false;
            const fn = timers[index];
            timers[index] = null;
            fn();
            return true;
        },
        drain() {
            let guard = 0;
            while (this.fireNext()) {
                guard += 1;
                if (guard > 50) throw new Error("timer drain did not finish");
            }
        },
    };
}

test("new install defaults stay on the original values", () => {
    const installed = core.settingsForNewInstall();
    assert.deepEqual(installed, {
        use6Channels: true,
        setMaxBitrate: true,
        disableVP9: false,
        disableAVChigh: false,
        disableAV1: false,
        showAllSubs: false,
    });
    installed.disableVP9 = true;
    installed.setMaxBitrate = false;
    assert.equal(core.settingsForNewInstall().disableVP9, false);
    assert.equal(core.settingsForNewInstall().setMaxBitrate, true);
    assert.equal(core.USER_REPORTED_OPTIONS_SCREEN.storageRead, false);
    assert.equal(core.USER_REPORTED_OPTIONS_SCREEN.values.disableVP9, true);
    assert.equal(core.USER_REPORTED_OPTIONS_SCREEN.values.disableAVChigh, true);
    assert.equal(core.USER_REPORTED_OPTIONS_SCREEN.values.disableAV1, true);
    assert.equal(core.USER_REPORTED_OPTIONS_SCREEN.values.showAllSubs, true);
    assert.equal(core.settingsMatchReport(core.settingsForNewInstall()).matches, false);
    assert.equal(core.settingsMatchReport(core.USER_REPORTED_OPTIONS_SCREEN.values).matches, true);
});

test("reported screen is not written over loaded settings", () => {
    const loaded = core.describeSettingsDom(JSON.stringify(core.settingsForNewInstall()));
    assert.equal(loaded.applied, true);
    assert.equal(loaded.settings.disableVP9, false);
    assert.equal(loaded.matchesUserReportedScreen, false);
    assert.ok(loaded.mismatchedKeys.includes("disableVP9"));
    assert.ok(loaded.mismatchedKeys.includes("disableAV1"));
    assert.equal(core.originalAutomaticLoopExpected(loaded.settings), true);
    assert.equal(core.originalAutomaticLoopExpected({ setMaxBitrate: false }), false);
});

test("reversed candidate order keeps the original last-option choice", () => {
    const tracker = core.createMenuTracker();
    const initial = core.snapshotOptions([
        { value: "5800000", text: "5800000 / 94", selected: true },
        { value: "450000", text: "450000 / 40", selected: false },
    ]);
    tracker.noteOptions("video", initial, "extension-hidden");
    const live = core.snapshotOptions([
        { value: "5800000", text: "5800000 / 94", selected: false },
        { value: "450000", text: "450000 / 40", selected: true },
    ]);
    const events = tracker.noteOverrideBefore("video", live, "extension-hidden");
    assert.equal(events[0].phase, "menu-built");
    assert.equal(events[0].snapshot.order[0].value, "5800000");
    assert.equal(events[1].phase, "before-override-click");
    assert.deepEqual(events[1].snapshot.selectedIndexes, [1]);
    assert.equal(events[1].snapshot.lastValue, "450000");
    assert.equal(core.originalLastOptionIndex(live.count), 1);
    assert.equal(events[1].snapshot.selectedMatchesLast, true);
    assert.ok(Number(events[1].snapshot.lastValue) < Number(events[0].snapshot.order[0].value));
    assert.deepEqual(tracker.flush("video"), []);
});

test("delayed candidate updates stay on the timeline in arrival order", () => {
    const tracker = core.createMenuTracker();
    const partial = core.snapshotOptions([
        { value: "450000", text: "450000 / 40", selected: true },
    ]);
    tracker.noteOptions("video", partial, "unknown");
    const built = tracker.flush("video");
    const full = core.snapshotOptions([
        { value: "450000", text: "450000 / 40", selected: true },
        { value: "5800000", text: "5800000 / 94", selected: false },
    ]);
    tracker.noteOptions("video", full, "unknown");
    const updated = tracker.flush("video");
    assert.equal(built[0].phase, "menu-built");
    assert.equal(built[0].snapshot.count, 1);
    assert.equal(updated[0].phase, "menu-updated");
    assert.equal(updated[0].snapshot.order[1].value, "5800000");
    assert.ok(built[0].snapshot.count < updated[0].snapshot.count);
});

test("same-url player replacement continues one sample window", () => {
    const tracker = core.createPlayerTracker();
    let running = false;
    const actions = [];
    function apply(eventType, key) {
        const playerEvent = key == null ? null : tracker.note(key, 10);
        const action = core.decideSamplerAction({ running: running }, eventType);
        actions.push({
            eventType: eventType,
            action: action,
            playerGeneration: playerEvent && playerEvent.playerGeneration,
            replaced: playerEvent && playerEvent.replaced,
        });
        if (action === "start" || action === "restart") running = true;
        if (action === "cancel") running = false;
    }
    apply("enter-watch", null);
    apply("video-added", 1);
    apply("video-replaced", 2);
    assert.deepEqual(actions.map((item) => item.action), ["start", "continue", "continue"]);
    assert.equal(actions[2].playerGeneration, 2);
    assert.equal(actions[2].replaced, true);
    assert.equal(running, true);
});

test("missing menu records no selected stream and no click", () => {
    const sample = core.buildSample({
        wasDiscarded: true,
        index: 1,
        rendered: { width: 1920, height: 1080 },
        dom: { hideStylePresent: true, menuPresent: false, videoCount: 1 },
        playerGeneration: 1,
    });
    assert.equal(sample.dom.menuPresent, false);
    assert.equal(sample.dom.hideStylePresent, true);
    assert.equal(sample.selectedStream, null);
    assert.equal(sample.rendered.width, 1920);
    assert.equal(sample.rendered.height, 1080);
    assert.equal("bitrate" in sample.rendered, false);
    const tracker = core.createMenuTracker();
    assert.deepEqual(tracker.flush("video"), []);
});

test("leaving a watch page cancels the active sampler and ignores stale ticks", () => {
    const clock = fakeClock();
    const samples = [];
    const sampler = core.createSampler({
        intervalMs: 1000,
        maxSamples: 5,
        now: () => 0,
        schedule: clock.schedule,
        clear: clock.clear,
        onSample(info) { samples.push(info.index); },
    });
    const first = sampler.start({ wasDiscarded: true });
    const stale = clock.timers.find(Boolean);
    sampler.start({ wasDiscarded: true });
    stale();
    assert.deepEqual(samples, []);
    assert.equal(clock.timers.filter(Boolean).length, 1);
    clock.fireNext();
    assert.deepEqual(samples, [1]);
    assert.equal(core.decideSamplerAction({ running: true }, "leave-watch"), "cancel");
    sampler.cancel("leave-watch");
    clock.drain();
    assert.deepEqual(samples, [1]);
    assert.equal(sampler.isActive(), false);
    assert.notEqual(sampler.generation(), first.generation);
});

test("sampler stops after the finite sample count", () => {
    const clock = fakeClock();
    let completed = 0;
    const samples = [];
    const sampler = core.createSampler({
        intervalMs: 1000,
        maxSamples: 3,
        now: () => 0,
        schedule: clock.schedule,
        clear: clock.clear,
        onSample(info) { samples.push(info.index); },
        onComplete() { completed += 1; },
    });
    sampler.start({});
    clock.drain();
    assert.deepEqual(samples, [1, 2, 3]);
    assert.equal(completed, 1);
    assert.equal(clock.timers.filter(Boolean).length, 0);
    assert.equal(core.SAMPLE_INTERVAL_MS, 1000);
    assert.equal(core.SAMPLE_COUNT, 180);
});

test("manual override is classified separately from the hidden extension menu", () => {
    assert.equal(core.menuActor({ trusted: true, hideStylePresent: false }), "manual");
    assert.equal(core.menuActor({ trusted: false, hideStylePresent: true }), "extension-hidden");
    const tracker = core.createMenuTracker();
    const live = core.snapshotOptions([
        { value: "5800000", text: "5800000 / 94", selected: true },
    ]);
    const events = tracker.noteOverrideBefore("video", live, "manual");
    assert.equal(events[1].actor, "manual");
    assert.equal(events[1].phase, "before-override-click");
});

test("rendered resolution stays separate from the selected stream and player trace", () => {
    const selected = core.snapshotOptions([
        { value: "450000", text: "450000 / 40", selected: true },
    ]);
    const sample = core.sanitizeEvent(core.buildSample({
        wasDiscarded: true,
        index: 4,
        rendered: { width: 1920, height: 1080, bitrate: 450000 },
        renderedProbe: core.probeStatsText("1920x1080 5800 kbps avc"),
        selectedStream: { video: selected, actor: "extension-hidden" },
        playerTrace: { videoBitrateKbps: 450, audioBitrateKbps: 192, codec: "avc", at: 20 },
        dom: { menuPresent: false, videoCount: 1 },
        playerGeneration: 2,
    }));
    assert.equal(sample.rendered.width, 1920);
    assert.equal(sample.rendered.height, 1080);
    assert.equal("bitrate" in sample.rendered, false);
    assert.equal(sample.renderedProbe.bitrateKbps, 5800);
    assert.equal(sample.renderedProbe.codec, "avc");
    assert.equal(sample.selectedStream.video.order[0].value, "450000");
    assert.equal(sample.playerTrace.videoBitrateKbps, 450);
    assert.notEqual(sample.playerTrace.videoBitrateKbps, sample.renderedProbe.bitrateKbps);
});

test("export strips watch ids, urls, tokens, and refuses to mark a fix applied", () => {
    const locations = core.createLocationTracker();
    const moved = locations.update("https://www.netflix.com/watch/81234567?token=secret&cookie=abc");
    const poisoned = {
        type: "error",
        message: "failed https://cdn.example/watch/81234567?token=secret",
        cookie: "session=abc",
        href: "https://www.netflix.com/watch/81234567",
        watchKey: "81234567",
    };
    const exported = core.mergeExport({
        fixesApplied: true,
        storageReadFromOriginalExtension: true,
        events: [poisoned],
    }, [moved.publicEvent, {
        type: "document",
        wasDiscarded: true,
        readyState: "complete",
        navigationType: "reload",
        name: "https://www.netflix.com/watch/81234567",
    }], { extensionId: core.DIAGNOSTIC_EXTENSION_ID });
    const text = JSON.stringify(exported);
    assert.equal(text.includes("81234567"), false);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("netflix.com"), false);
    assert.equal(text.includes("session=abc"), false);
    assert.equal(exported.fixesApplied, false);
    assert.equal(exported.storageReadFromOriginalExtension, false);
    assert.equal(exported.diagnostic, true);
    assert.equal(exported.userReportedOptionsScreen.storageRead, false);
    assert.equal(exported.events[0].message.includes("[url]"), true);
    assert.equal(exported.events[1].isWatch, true);
    assert.equal(exported.events[1].entered, true);
    assert.equal(exported.events[2].wasDiscarded, true);
    assert.equal(exported.extensionId, core.DIAGNOSTIC_EXTENSION_ID);
    assert.notEqual(exported.extensionId, core.STORE_EXTENSION_ID);
});

test("title switch restarts sampling and a second enter does not", () => {
    const locations = core.createLocationTracker();
    const first = locations.update("https://www.netflix.com/watch/111");
    const again = locations.update("https://www.netflix.com/watch/111?trackId=9");
    const next = locations.update("https://www.netflix.com/watch/222");
    const leave = locations.update("https://www.netflix.com/browse");
    assert.equal(first.kind, "enter-watch");
    assert.equal(again.kind, "unchanged");
    assert.equal(next.kind, "title-switch");
    assert.equal(leave.kind, "leave-watch");
    assert.equal(core.decideSamplerAction({ running: true }, "enter-watch"), "continue");
    assert.equal(core.decideSamplerAction({ running: true }, "title-switch"), "restart");
    assert.equal(JSON.stringify(next.publicEvent).includes("222"), false);
});

test("profile and settings initialization can be ordered without keeping urls", () => {
    const facts = core.documentFacts({
        wasDiscarded: true,
        readyState: "loading",
        visibilityState: "visible",
    }, {
        getEntriesByType() {
            return [{ type: "reload", name: "https://www.netflix.com/watch/81234567?token=secret" }];
        },
    });
    const missing = core.describeGlobalOptionsAssignment(undefined);
    const loaded = core.describeSettingsDom(JSON.stringify(core.USER_REPORTED_OPTIONS_SCREEN.values));
    const profiles = core.classifyConsole(["Final profiles:", [
        "playready-h264mpl40-dash",
        "heaac-2-dash",
    ]]);
    const invalid = core.classifyConsole(["Final profiles:", ["ok-profile", { url: "https://secret.example/watch/1" }]]);
    const failure = core.classifyConsole(["Could not load settings:", new Error("missing https://www.netflix.com/watch/55?token=abc")]);
    const exported = core.mergeExport(null, [facts, missing, loaded, profiles, invalid, failure], {});
    assert.equal(exported.events[0].wasDiscarded, true);
    assert.equal(exported.events[0].navigationType, "reload");
    assert.equal(exported.events[1].applied, false);
    assert.equal(exported.events[2].applied, true);
    assert.equal(exported.events[2].matchesUserReportedScreen, true);
    assert.equal(exported.events[2].settings.disableAV1, true);
    assert.deepEqual(exported.events[3].profiles, ["playready-h264mpl40-dash", "heaac-2-dash"]);
    assert.equal(exported.events[4].invalid, true);
    assert.equal(exported.events[4].profiles, null);
    assert.equal(exported.events[5].type, "settings-error");
    const text = JSON.stringify(exported);
    assert.equal(text.includes("81234567"), false);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("token"), false);
});

test("playback trace keeps bitrate numbers and drops signed urls", () => {
    const trace = core.classifyConsole(["audio: 192kbps | video 5800kbps avc"]);
    assert.equal(trace.videoBitrateKbps, 5800);
    assert.equal(trace.audioBitrateKbps, 192);
    assert.equal(trace.codec, "avc");
    assert.equal(core.classifyConsole(["bitrate: 100 kbps https://cdn.example/a?token=abc"]), null);
    assert.equal(core.srcKind("blob:https://www.netflix.com/123"), "blob");
    assert.equal(core.srcKind(""), "empty");
    assert.equal(JSON.stringify(core.sanitizeEvent({
        type: "player",
        playerGeneration: 2,
        replaced: true,
        videoSerial: 2,
        srcKind: "blob",
        src: "blob:https://www.netflix.com/secret",
    })).includes("secret"), false);
});

test("extension sources keep original bitrate selection and add no reload", () => {
    const bitrate = read("netflix_max_bitrate.js");
    const content = read("content_script.js");
    const hook = read("diagnostic/page_hook.js");
    const bridge = read("diagnostic/bridge.js");
    const manifest = JSON.parse(read("manifest.json"));
    assert.match(bitrate, /options\[options\.length - 1\]\.setAttribute\('selected', 'selected'\)/);
    assert.match(bitrate, /setTimeout\(maxbitrate_run, 100\)/);
    assert.doesNotMatch(bitrate, /diagnostic/i);
    assert.match(content, /setMaxBitrate: true/);
    assert.match(content, /disableVP9: false/);
    assert.match(content, /disableAV1: false/);
    assert.doesNotMatch(content, /diagnostic/i);
    assert.doesNotMatch(hook, /\.click\s*\(/);
    assert.doesNotMatch(hook, /KeyboardEvent/);
    assert.doesNotMatch(hook, /location\.reload/);
    assert.doesNotMatch(hook, /tabs\.reload/);
    assert.doesNotMatch(hook, /storage\.sync\.set/);
    assert.doesNotMatch(hook, /document\.cookie/);
    assert.doesNotMatch(hook, /appendChild\s*=/);
    assert.doesNotMatch(bridge, /storage\.sync\.set/);
    assert.match(bridge, /storage\.local/);
    assert.equal(manifest.version, "1.34.0");
    assert.equal(manifest.name.includes("Diagnostic"), true);
    assert.deepEqual(manifest.permissions, ["storage", "declarativeNetRequest"]);
    assert.equal(manifest.content_scripts[0].world, "MAIN");
    assert.deepEqual(manifest.content_scripts[0].js, ["diagnostic/core.js", "diagnostic/page_hook.js"]);
    assert.ok(manifest.content_scripts[1].js.includes("content_script.js"));
    const id = chromeId(Buffer.from(manifest.key, "base64"));
    assert.equal(id, core.DIAGNOSTIC_EXTENSION_ID);
    assert.notEqual(id, core.STORE_EXTENSION_ID);
});

test("options page still defaults codec disables to off", () => {
    const options = read("pages/options.js");
    assert.match(options, /disableVP9:\s*false/);
    assert.match(options, /disableAVChigh:\s*false/);
    assert.match(options, /disableAV1:\s*false/);
    assert.match(options, /showAllSubs:\s*false/);
    assert.match(options, /setMaxBitrate:\s*true/);
    assert.match(options, /use6Channels:\s*true/);
    assert.doesNotMatch(options, /USER_REPORTED_OPTIONS_SCREEN\.values/);
});
