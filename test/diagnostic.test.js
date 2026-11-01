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

function playercoreStatsFixture() {
    const audioBitrate = 192000;
    const videoBitrate = 5800000;
    const width = 1920;
    const height = 1080;
    const playing = audioBitrate + " / " + videoBitrate + " (" + width + "x" + height + ")";
    return [
        "Player state: playing",
        "Playing bitrate (a/v): " + playing,
        "Playing/Buffering vmaf: 94/90",
        "Buffering bitrate (a/v): 64000 / 300000",
        "Video Track: Codec: main (avchigh, hdr)",
        "Audio Track: name, Id: a1, Channels: 2, Codec: aac (he-aac)",
        "Throughput: 8123.5 kbps",
        "Current CDN (a/v/t): edge, Id: 1 / edge, Id: 2 / edge, Id: 3",
    ].join("\n");
}

test("playercore stats keep playing bitrate apart from throughput", () => {
    const overlay = playercoreStatsFixture();
    const fromValue = core.probeStatsText(core.readStatsNodeText({
        tagName: "TEXTAREA",
        value: overlay,
        textContent: "",
    }));
    assert.equal(fromValue.playingAudioBitrate, 192000);
    assert.equal(fromValue.playingVideoBitrate, 5800000);
    assert.equal(fromValue.width, 1920);
    assert.equal(fromValue.height, 1080);
    assert.equal(fromValue.codec, "avchigh");
    assert.equal(fromValue.throughputKbps, 8123.5);
    assert.equal(fromValue.source, "player-info");
    assert.equal("bitrateKbps" in fromValue, false);
    assert.notEqual(fromValue.playingVideoBitrate, fromValue.throughputKbps);
    assert.equal(fromValue.playingVideoBitrate === 300000, false);

    const missing = core.probeStatsText("Playing bitrate (a/v): ? / 540000 (960x540)\nVideo Track: Codec: main (av1, prk)\n");
    assert.equal(missing.playingAudioBitrate, null);
    assert.equal(missing.playingVideoBitrate, 540000);
    assert.equal(missing.width, 960);
    assert.equal(missing.height, 540);
    assert.equal(missing.codec, "av1");
    assert.equal(missing.throughputKbps, null);

    const throughputOnly = core.probeStatsText("Throughput: 999 kbps\n1920x1080 5800 kbps avc\n");
    assert.equal(throughputOnly.throughputKbps, 999);
    assert.equal(throughputOnly.playingAudioBitrate, null);
    assert.equal(throughputOnly.playingVideoBitrate, null);
    assert.equal(throughputOnly.codec, null);
    assert.equal(throughputOnly.width, null);

    const emptyValue = core.probeStatsText(core.readStatsNodeText({
        tagName: "TEXTAREA",
        value: "",
        textContent: overlay,
    }));
    assert.equal(emptyValue.source, "none");
});

test("rendered resolution stays separate from the selected stream and player trace", () => {
    const selected = core.snapshotOptions([
        { value: "450000", text: "450000 / 40", selected: true },
    ]);
    const sample = core.sanitizeEvent(core.buildSample({
        wasDiscarded: true,
        index: 4,
        rendered: { width: 1920, height: 1080, bitrate: 450000 },
        renderedProbe: core.probeStatsText(playercoreStatsFixture()),
        selectedStream: { video: selected, actor: "extension-hidden" },
        playerTrace: { videoBitrateKbps: 450, audioBitrateKbps: 192, codec: "avc", at: 20 },
        dom: { menuPresent: false, videoCount: 1 },
        playerGeneration: 2,
    }));
    assert.equal(sample.rendered.width, 1920);
    assert.equal(sample.rendered.height, 1080);
    assert.equal("bitrate" in sample.rendered, false);
    assert.equal("bitrateKbps" in sample.renderedProbe, false);
    assert.equal(sample.renderedProbe.playingVideoBitrate, 5800000);
    assert.equal(sample.renderedProbe.playingAudioBitrate, 192000);
    assert.equal(sample.renderedProbe.throughputKbps, 8123.5);
    assert.equal(sample.renderedProbe.codec, "avchigh");
    assert.equal(sample.renderedProbe.source, "player-info");
    assert.equal(sample.selectedStream.video.order[0].value, "450000");
    assert.equal(sample.playerTrace.videoBitrateKbps, 450);
    assert.notEqual(sample.playerTrace.videoBitrateKbps, sample.renderedProbe.playingVideoBitrate);
    assert.notEqual(sample.renderedProbe.throughputKbps, sample.renderedProbe.playingVideoBitrate);
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
    assert.equal(exported.events[0].code, "unclassified");
    assert.equal("message" in exported.events[0], false);
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
    assert.equal(exported.events[5].code, "settings-load-failed");
    assert.equal("message" in exported.events[5], false);
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
    assert.match(hook, /\.player-info textarea/);
    assert.match(hook, /readStatsNodeText/);
    assert.doesNotMatch(hook, /kbps\/i\.test\(text\)/);
    assert.doesNotMatch(hook, /emitError\(event/);
    assert.doesNotMatch(hook, /emitError\(error/);
    assert.doesNotMatch(hook, /emitError\(reason/);
    assert.match(hook, /selectTrackedMeasurement/);
    assert.match(hook, /clearsAttribution/);
    assert.match(bridge, /finishWrite/);
    assert.doesNotMatch(bridge, /splice\(0,\s*buffer\.length\)/);
    const options = read("pages/options.js");
    assert.match(options, /mergeDiagnosticStorage/);
    assert.doesNotMatch(options, /\.sort\(/);
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

test("page errors keep a fixed code and drop names, emails, and title ids", () => {
    const stored = core.sanitizeEvent(core.describeError("page-error"));
    const leaked = core.sanitizeEvent({
        type: "error",
        code: "page-rejection",
        message: "Ada Lovelace 81234567 viewer@example.com",
    });
    const unknown = core.sanitizeEvent({
        type: "error",
        message: "The Crown 81234567 ada@example.com",
    });
    assert.equal(stored.code, "page-error");
    assert.equal("message" in stored, false);
    assert.equal(leaked.code, "page-rejection");
    assert.equal(unknown.code, "unclassified");
    const text = JSON.stringify([stored, leaked, unknown]);
    assert.equal(text.includes("81234567"), false);
    assert.equal(text.includes("example.com"), false);
    assert.equal(text.includes("Ada"), false);
    assert.equal(text.includes("Crown"), false);
});

test("tracked video serial is measured instead of the largest leftover element", () => {
    const entries = [
        { serial: 1, width: 1920, height: 1080, droppedVideoFrames: 1, totalVideoFrames: 100, corruptedVideoFrames: 0 },
        { serial: 2, width: 960, height: 540, droppedVideoFrames: 7, totalVideoFrames: 20, corruptedVideoFrames: 3 },
    ];
    const measured = core.selectTrackedMeasurement(entries, 2);
    assert.equal(measured.matched, true);
    assert.equal(measured.videoSerial, 2);
    assert.equal(measured.width, 960);
    assert.equal(measured.height, 540);
    assert.equal(measured.playback.droppedVideoFrames, 7);
    assert.equal(measured.playback.totalVideoFrames, 20);
    assert.notEqual(measured.width, 1920);
    const missing = core.selectTrackedMeasurement(entries, 9);
    assert.equal(missing.matched, false);
    assert.equal(missing.width, null);
    assert.equal(missing.playback, null);
});

test("player replacement and title change drop the previous override attribution", () => {
    assert.equal(core.clearsAttribution("video-replaced"), true);
    assert.equal(core.clearsAttribution("title-switch"), true);
    assert.equal(core.clearsAttribution("leave-watch"), true);
    assert.equal(core.clearsAttribution("enter-watch"), true);
    assert.equal(core.clearsAttribution("video-added"), false);
    const selected = { playerGeneration: 1, video: { order: [{ value: "1", caption: "1", selected: true }] }, actor: "extension-hidden" };
    const trace = { playerGeneration: 1, type: "playback-trace", videoBitrateKbps: 100 };
    const stale = core.attributionForSample(selected, trace, 2);
    assert.equal(stale.selectedStream, null);
    assert.equal(stale.playerTrace, null);
    const current = core.attributionForSample(selected, trace, 1);
    assert.equal(current.selectedStream, selected);
    assert.equal(current.playerTrace, trace);
});

test("failed storage writes keep buffered logs and export keeps the newer session", () => {
    const queue = core.createPersistController({
        startedAt: 2000,
        sessionId: "0123456789abcdef",
    });
    queue.enqueue([{ type: "sampler", phase: "start", at: 1 }]);
    queue.enqueue([{ type: "document", wasDiscarded: true, at: 2 }]);
    const first = queue.beginWrite();
    assert.equal(first.events.length, 2);
    assert.equal(first.chunk, 1);
    const failed = queue.finishWrite(false);
    assert.equal(failed.failed, true);
    assert.equal(failed.code, "storage-write-failed");
    assert.equal(failed.pending, 2);
    assert.equal(failed.chunk, 0);
    queue.enqueue([{ type: "sampler", phase: "complete", at: 3 }]);
    const second = queue.beginWrite();
    assert.equal(second.events.length, 3);
    const saved = queue.finishWrite(true);
    assert.equal(saved.failed, false);
    assert.equal(saved.pending, 0);
    assert.equal(saved.chunk, 1);

    const olderKey = "nflx1080pDiagnosticLog.ffffffffffffffff.0001";
    const newerKey = "nflx1080pDiagnosticLog.aaaaaaaaaaaaaaaa.0001";
    const stored = {};
    stored[newerKey] = { events: [{ type: "sampler", phase: "start", at: 5000, message: "ada@example.com 81234567" }] };
    stored[olderKey] = {
        events: [
            { type: "sampler", phase: "start", at: 1000 },
            { type: "sampler", phase: "complete", at: 1001 },
        ],
    };
    const lexical = Object.keys(stored).sort();
    assert.equal(lexical[0], newerKey);
    const exported = core.mergeDiagnosticStorage(stored, {}, { maxEvents: 1 });
    assert.equal(exported.events.length, 1);
    assert.equal(exported.events[0].at, 5000);
    assert.equal(exported.retention.droppedOldest, 2);
    assert.equal(exported.retention.order, "startedAt-or-event-time,sessionId,chunk");
    assert.equal(JSON.stringify(exported).includes("81234567"), false);
    assert.equal(JSON.stringify(exported).includes("example.com"), false);

    const early = core.diagnosticChunkKey(1000, "aaaaaaaaaaaaaaaa", 2);
    const late = core.diagnosticChunkKey(1000, "aaaaaaaaaaaaaaaa", 10);
    const timed = {};
    timed[late] = { events: [{ type: "sampler", phase: "complete", at: 1100 }] };
    timed[early] = { events: [{ type: "sampler", phase: "start", at: 1000 }] };
    const ordered = core.mergeDiagnosticStorage(timed, {}, { maxEvents: 2 });
    assert.equal(ordered.events[0].phase, "start");
    assert.equal(ordered.events[1].phase, "complete");
    const plan = core.planDiagnosticRetention(timed, 1);
    assert.deepEqual(plan.removeKeys, [early]);
    assert.deepEqual(plan.keepKeys, [late]);
});

test("two 3-minute captures survive the 250ms flush and chunk pruning", () => {
    assert.equal(core.FLUSH_DELAY_MS, 250);
    assert.equal(core.SAMPLE_COUNT, 180);
    assert.ok(core.CHUNK_EVENT_LIMIT >= core.SAMPLE_COUNT + 5);
    assert.ok(core.MAX_STORED_CHUNKS * core.CHUNK_EVENT_LIMIT >= 2 * (core.SAMPLE_COUNT + 5));
    const bridge = read("diagnostic/bridge.js");
    assert.match(bridge, /FLUSH_DELAY_MS/);

    function createSession(startedAt, sessionId) {
        const stored = {};
        const queue = core.createPersistController({
            startedAt: startedAt,
            sessionId: sessionId,
        });
        let now = 0;
        let due = null;
        function flush() {
            due = null;
            const request = queue.beginWrite();
            if (!request) return;
            stored[request.key] = { events: request.events };
            const result = queue.finishWrite(true);
            const plan = core.planDiagnosticRetention(stored, core.MAX_STORED_CHUNKS);
            for (let i = 0; i < plan.removeKeys.length; i++) delete stored[plan.removeKeys[i]];
            if (result.pending) flush();
        }
        return {
            stored: stored,
            ingest: function (events) {
                queue.enqueue(events);
                if (queue.pending() >= 200) {
                    due = null;
                    flush();
                    return;
                }
                if (due == null) due = now + core.FLUSH_DELAY_MS;
            },
            advance: function (ms) {
                const target = now + ms;
                while (due != null && due <= target) {
                    now = due;
                    flush();
                }
                now = target;
            },
        };
    }

    function metadata(at, wasDiscarded, seq) {
        return [
            { type: "document", at: at, seq: seq, wasDiscarded: wasDiscarded, readyState: "complete", navigationType: "reload" },
            { type: "settings-dom", at: at + 1, seq: seq + 1, applied: true, parseError: false, settings: {
                use6Channels: true, setMaxBitrate: true, disableVP9: true, disableAVChigh: true, disableAV1: true, showAllSubs: true,
            } },
            { type: "profile", at: at + 2, seq: seq + 2, marker: "final", invalid: false, profiles: ["playready-h264mpl40-dash"] },
            { type: "menu", at: at + 3, seq: seq + 3, phase: "before-override-click", actor: "extension-hidden", label: "video", menuPresent: true, snapshot: {
                order: [{ value: "5800000", caption: "5800000 / 94", selected: true }],
            } },
            { type: "error", at: at + 4, seq: seq + 4, code: "page-error" },
        ];
    }

    function runCapture(session, at, wasDiscarded) {
        session.ingest(metadata(at, wasDiscarded, 1));
        session.advance(core.FLUSH_DELAY_MS);
        for (let i = 1; i <= core.SAMPLE_COUNT; i++) {
            session.ingest([{
                type: "sample",
                at: at + i * 1000,
                seq: 100 + i,
                index: i,
                wasDiscarded: wasDiscarded,
                rendered: { width: wasDiscarded ? 960 : 1920, height: wasDiscarded ? 540 : 1080 },
                playerGeneration: 1,
                videoSerial: 1,
            }]);
            session.advance(core.FLUSH_DELAY_MS);
            session.advance(1000 - core.FLUSH_DELAY_MS);
        }
    }

    const normal = createSession(1_700_000_000_000, "aaaaaaaaaaaaaaaa");
    const discard = createSession(1_700_000_300_000, "ffffffffffffffff");
    runCapture(normal, 1_700_000_000_000, false);
    runCapture(discard, 1_700_000_300_000, true);
    const stored = Object.assign({}, normal.stored, discard.stored);
    assert.ok(Object.keys(stored).length < core.MAX_STORED_CHUNKS);
    assert.ok(Object.keys(normal.stored).length <= 2);
    const exported = core.mergeDiagnosticStorage(stored, { extensionId: core.DIAGNOSTIC_EXTENSION_ID });
    const samples = exported.events.filter(function (event) { return event.type === "sample"; });
    const documents = exported.events.filter(function (event) { return event.type === "document"; });
    assert.equal(samples.length, 360);
    assert.equal(samples.filter(function (event) { return event.wasDiscarded === false && event.index === 1; }).length, 1);
    assert.equal(samples.filter(function (event) { return event.wasDiscarded === true && event.index === 1; }).length, 1);
    assert.equal(samples.filter(function (event) { return event.wasDiscarded === false && event.index === 180; }).length, 1);
    assert.equal(samples.filter(function (event) { return event.wasDiscarded === true && event.index === 180; }).length, 1);
    assert.equal(documents.length, 2);
    assert.equal(documents.filter(function (event) { return event.wasDiscarded === true; }).length, 1);
    assert.equal(exported.events.filter(function (event) { return event.type === "settings-dom" && event.applied === true; }).length, 2);
    assert.equal(exported.events.filter(function (event) { return event.type === "profile" && event.marker === "final"; }).length, 2);
    assert.equal(exported.events.filter(function (event) { return event.type === "menu" && event.phase === "before-override-click"; }).length, 2);
    assert.equal(exported.events.filter(function (event) { return event.type === "error" && event.code === "page-error"; }).length, 2);
    assert.equal(exported.retention.droppedOldest, 0);
});
