// Browser-level test of the options page export, with the real unpacked extension loaded.
//
// Legs: {pinned 5941c8b, working tree} x {ja, en-US}. The ja legs force the locale default
// encoding (Shift_JIS) the way a Japanese-locale Chrome does for a page without a charset.
// The 5941c8b/ja leg asserts the reproduction (core.js SyntaxError, no download, no status);
// every other leg asserts a completed download with valid JSON.
//
// This is Linux Chrome for Testing with --load-extension. It is not macOS, not the user's
// profile, and not their stored data. Branded Google Chrome >= 137 ignores --load-extension,
// so this test fails loudly (not silently) when the extension is not loaded.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromeAvailable, sleep, evaluate, launchChrome, attachNewPage } = require("./vm/cdp.js");

const root = path.join(__dirname, "..");
const core = require(path.join(root, "diagnostic", "core.js"));

const PIN_COMMIT = "5941c8b77eb0938ee86bba1ccc545b96ea1b71e4";
const EXTENSION_ID = core.DIAGNOSTIC_EXTENSION_ID;
const OPTIONS_URL = "chrome-extension://" + EXTENSION_ID + "/pages/options.html";
const EXPECTED_TITLE = "New Netflix 1080p Options";
const EXPORT_FILENAME = "netflix-1080p-diagnostic.json";
const REPORT_PATH = "/tmp/nflx-options-export-report.json";
const SCREENSHOT_DIR = process.env.NFLX_SCREENSHOT_DIR || "";
const DEBUG = Boolean(process.env.NFLX_DEBUG);
function debug(message) {
    if (DEBUG) fs.writeSync(2, "[options_export " + new Date().toISOString().slice(11, 23) + "] " + message + "\n");
}

const LOCALES = {
    ja: { lang: "ja", env: { LANGUAGE: "ja", LANG: "ja_JP.UTF-8" }, charset: "Shift_JIS", prefCharset: "Shift_JIS" },
    "en-US": { lang: "en-US", env: { LANGUAGE: "en_US", LANG: "en_US.UTF-8" }, charset: "windows-1252", prefCharset: null },
};

// ---- packaged file list (same globs as make.py) ----

function packagedGlobs() {
    const source = fs.readFileSync(path.join(root, "make.py"), "utf8");
    const block = source.match(/INCLUDE_FILES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(block, "make.py INCLUDE_FILES not found");
    return Array.from(block[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function expandGlobs(globs, listing) {
    const files = [];
    for (const pattern of globs) {
        if (pattern.endsWith("/*")) {
            const dir = pattern.slice(0, -2) + "/";
            for (const file of listing) {
                if (file.startsWith(dir) && !file.slice(dir.length).includes("/") && !path.basename(file).startsWith(".")) files.push(file);
            }
        } else if (listing.includes(pattern)) {
            files.push(pattern);
        }
    }
    return files.sort();
}

function pinnedListing() {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", PIN_COMMIT], { cwd: root }).toString("utf8").split("\n").filter(Boolean);
}

function workingTreeListing(globs) {
    const listing = [];
    for (const pattern of globs) {
        if (pattern.endsWith("/*")) {
            const dir = pattern.slice(0, -2);
            for (const name of fs.readdirSync(path.join(root, dir))) listing.push(dir + "/" + name);
        } else if (fs.existsSync(path.join(root, pattern))) {
            listing.push(pattern);
        }
    }
    return listing;
}

function buildExtensionDir(label, files, read) {
    const dir = fs.mkdtempSync("/tmp/nflx-ext-" + label + "-");
    for (const file of files) {
        fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), read(file));
    }
    return dir;
}

// ---- storage seeds, built with the same core functions bridge.js uses ----

function baseEvent(type, seq, at, extra) {
    return Object.assign({ type: type, seq: seq, at: at, perf: seq * 1000, frame: "top" }, extra || {});
}

function menuOptions(count, prefix) {
    const order = [];
    for (let i = 0; i < count; i++) order.push({ value: String((i + 1) * 500000), caption: prefix + " " + (i + 1), selected: i === count - 1 });
    return { order: order };
}

function sampleEvent(seq, at, index) {
    return baseEvent("sample", seq, at, {
        index: index,
        rendered: { width: 1920, height: 1080 },
        renderedProbe: { width: 1920, height: 1080, playingAudioBitrate: 256, playingVideoBitrate: 5800, throughputKbps: 42000, codec: "vp9", source: "player-info" },
        selectedStream: { video: menuOptions(10, "video"), audio: menuOptions(3, "audio"), actor: "extension-hidden" },
        playerTrace: { videoBitrateKbps: 5800, audioBitrateKbps: 256, codec: "vp9", at: at },
        playback: { droppedVideoFrames: 1, totalVideoFrames: 60 * (index + 1), corruptedVideoFrames: 0 },
        dom: { hideStylePresent: true, menuPresent: false, videoCount: 1 },
        playerGeneration: 1,
        videoSerial: 1,
    });
}

function sessionEvents(startAt, count) {
    const events = [baseEvent("document", 1, startAt, { wasDiscarded: false, readyState: "complete", visibilityState: "visible", navigationType: "navigate" })];
    events.push(baseEvent("sampler", 2, startAt + 10, { phase: "start", generation: 1, intervalMs: 1000, maxSamples: 180 }));
    for (let i = 0; i < count; i++) events.push(sampleEvent(3 + i, startAt + 1000 * (i + 1), i));
    return events;
}

function chunkValue(events) {
    return core.mergeExport(null, events, { extensionId: EXTENSION_ID });
}

function buildSeeds() {
    const current = {};
    current[core.diagnosticChunkKey(1700000000000, "aaaaaaaaaaaaaaaa", 1)] = chunkValue(sessionEvents(1700000000000, 3));
    current[core.diagnosticChunkKey(1700000000000, "aaaaaaaaaaaaaaaa", 2)] = chunkValue(sessionEvents(1700000010000, 3));
    current[core.diagnosticChunkKey(1700000400000, "bbbbbbbbbbbbbbbb", 1)] = chunkValue(sessionEvents(1700000400000, 2));

    const mixed = Object.assign({}, current);
    mixed["nflx1080pDiagnosticLog"] = chunkValue(sessionEvents(1699999000000, 0));
    mixed["nflx1080pDiagnosticLog.cccccccccccccccc.0001"] = chunkValue(sessionEvents(1699999500000, 0));
    mixed[core.diagnosticChunkKey(1700000800000, "dddddddddddddddd", 1)] = { events: "not-an-array" };
    mixed[core.diagnosticChunkKey(1700000900000, "eeeeeeeeeeeeeeee", 1)] = null;
    mixed.unrelatedSetting = { keep: true };

    const large = {};
    for (let chunk = 1; chunk <= core.MAX_STORED_CHUNKS; chunk++) {
        const startAt = 1700100000000 + chunk * 300000;
        large[core.diagnosticChunkKey(1700100000000, "ffffffffffffffff", chunk)] = chunkValue(sessionEvents(startAt, core.CHUNK_EVENT_LIMIT - 2));
    }

    const seeds = { empty: {}, current: current, mixed: mixed, large: large };
    const expected = {};
    for (const name of Object.keys(seeds)) {
        const merged = core.mergeDiagnosticStorage(seeds[name], { extensionId: EXTENSION_ID });
        expected[name] = { events: merged.events.length, chunkCount: merged.retention.chunkCount, seedBytes: JSON.stringify(seeds[name]).length };
    }
    return { seeds, expected };
}

// ---- page helpers ----

function storageExpression(body) {
    return "new Promise(function (done) { " + body + " })";
}

async function clearStorage(cdp, sid) {
    const error = await evaluate(cdp, sid, storageExpression("chrome.storage.local.clear(function () { done(chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null); });"));
    assert.equal(error, null, "storage clear failed: " + error);
}

async function setStorage(cdp, sid, object) {
    const error = await evaluate(cdp, sid, storageExpression("chrome.storage.local.set(" + JSON.stringify(object) + ", function () { done(chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null); });"));
    assert.equal(error, null, "storage set failed: " + error);
}

async function seedStorage(cdp, sid, seed) {
    await clearStorage(cdp, sid);
    const keys = Object.keys(seed);
    if (!keys.length) return;
    // Large seeds go one key at a time to keep each CDP message small.
    for (const key of keys) {
        const one = {};
        one[key] = seed[key];
        await setStorage(cdp, sid, one);
    }
}

async function storageKeys(cdp, sid) {
    const keys = await evaluate(cdp, sid, storageExpression("chrome.storage.local.get(null, function (stored) { done(Object.keys(stored || {})); });"));
    return keys.slice().sort();
}

async function textOf(cdp, sid, selector) {
    return evaluate(cdp, sid, "(function () { var node = document.querySelector(" + JSON.stringify(selector) + "); return node ? node.textContent : null; })()");
}

// Real mouse click at the element's centre. When the click opens a modal dialog (confirm), the
// Input commands do not return until the dialog is handled, so the caller passes
// expectDialog=true and awaits the returned promise only after answering the dialog.
async function clickElement(cdp, sid, selector, expectDialog) {
    const rect = await evaluate(cdp, sid, "(function () { var node = document.querySelector(" + JSON.stringify(selector) + "); if (!node) return null; node.scrollIntoView({ block: 'center' }); var r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight }; })()");
    assert.ok(rect && rect.w > 0 && rect.h > 0, selector + " has no box");
    assert.ok(rect.x > 0 && rect.y > 0 && rect.x < rect.vw && rect.y < rect.vh, selector + " is outside the viewport: " + JSON.stringify(rect));
    const point = { x: Math.round(rect.x), y: Math.round(rect.y) };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sid);
    const pressed = cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sid);
    const released = pressed.then(() => cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sid));
    const settled = Promise.all([pressed, released]);
    if (expectDialog) {
        // Do not adopt the promise here: it only resolves once the dialog is answered.
        settled.catch(() => {});
        return { done: settled };
    }
    await settled;
    return { done: settled };
}

function exceptionText(event) {
    const details = event.params.exceptionDetails || {};
    const description = details.exception && details.exception.description;
    return (details.url || "") + " :: " + (details.text || "") + " " + (description || "");
}

async function screenshot(cdp, sid, name) {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
    fs.writeFileSync(path.join(SCREENSHOT_DIR, name + ".png"), Buffer.from(shot.data, "base64"));
}

// ---- one leg ----

async function openOptionsPage(context, leg) {
    const { cdp } = context;
    debug(leg.build + "/" + leg.locale + ": opening options page");
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: context.downloadDir, eventsEnabled: true });
    const page = await attachNewPage(cdp, ["Page", "Runtime", "Log"]);
    const sid = page.sessionId;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1600, deviceScaleFactor: 1, mobile: false }, sid);
    const loaded = cdp.waitEvent("Page.loadEventFired", sid, 10000);
    const nav = await cdp.send("Page.navigate", { url: OPTIONS_URL }, sid);
    await loaded;
    await sleep(300);
    const runtimeId = await evaluate(cdp, sid, "(typeof chrome === 'object' && chrome.runtime) ? chrome.runtime.id : null");
    const title = await evaluate(cdp, sid, "document.title");
    if (nav.errorText || runtimeId !== EXTENSION_ID || title !== EXPECTED_TITLE) {
        throw new Error("extension did not load (navigate=" + (nav.errorText || "ok") + ", runtime.id=" + runtimeId + ", title=" + JSON.stringify(title) + "). "
            + "Branded Google Chrome >= 137 ignores --load-extension; set CHROME_BIN to Chrome for Testing or Chromium. Browser: " + context.version.Browser);
    }
    const load = {
        characterSet: await evaluate(cdp, sid, "document.characterSet"),
        coreType: await evaluate(cdp, sid, "typeof globalThis.Netflix1080pDiagCore"),
        idText: await textOf(cdp, sid, "#diagnostic-id"),
        buttonText: await textOf(cdp, sid, "#download-log"),
        exceptions: cdp.takeEvents("Runtime.exceptionThrown", (e) => e.sessionId === sid).map(exceptionText),
        logErrors: cdp.takeEvents("Log.entryAdded", (e) => e.sessionId === sid && e.params.entry.level === "error").map((e) => e.params.entry.text.slice(0, 180)),
    };
    // The pinned build declares no charset, so it must take the locale default. The fixed page
    // declares UTF-8 and must decode as UTF-8 whatever the locale default is.
    const expectedCharset = leg.build === "pin5941" ? LOCALES[leg.locale].charset : "UTF-8";
    assert.equal(load.characterSet, expectedCharset, leg.build + "/" + leg.locale + " unexpected document encoding");
    await screenshot(cdp, sid, leg.build + "-" + leg.locale);
    return { sid, load };
}

async function expectDownload(context, sid, expected, scenarioName) {
    const { cdp } = context;
    const started = Date.now();
    const begin = await cdp.waitEvent("Browser.downloadWillBegin", undefined, 15000);
    debug(scenarioName + ": downloadWillBegin " + begin.params.suggestedFilename);
    assert.equal(begin.params.suggestedFilename, EXPORT_FILENAME, scenarioName + " filename");
    assert.ok(String(begin.params.url).startsWith("blob:chrome-extension://" + EXTENSION_ID + "/"), scenarioName + " url " + begin.params.url);
    const done = await cdp.waitEvent("Browser.downloadProgress", undefined, 30000, (e) => e.params.guid === begin.params.guid && (e.params.state === "completed" || e.params.state === "canceled"));
    assert.equal(done.params.state, "completed", scenarioName + " download state");
    const file = path.join(context.downloadDir, begin.params.guid);
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    assert.equal(json.schema, core.SCHEMA, scenarioName + " schema");
    assert.equal(json.extensionId, EXTENSION_ID, scenarioName + " extensionId");
    assert.equal(json.diagnostic, true);
    assert.equal(json.fixesApplied, false);
    assert.ok(Array.isArray(json.events), scenarioName + " events array");
    assert.equal(json.events.length, expected.events, scenarioName + " event count");
    assert.equal(json.retention.chunkCount, expected.chunkCount, scenarioName + " chunk count");
    fs.rmSync(file, { force: true });
    return { bytes: text.length, elapsedMs: Date.now() - started };
}

async function runSuccessScenario(context, sid, name, seed, expected, isHead) {
    const { cdp } = context;
    debug("scenario " + name + ": seeding " + Object.keys(seed).length + " keys");
    await seedStorage(cdp, sid, seed);
    debug("scenario " + name + ": seeded, clicking");
    const keysBefore = await storageKeys(cdp, sid);
    cdp.takeEvents("Runtime.exceptionThrown");
    cdp.takeEvents("Browser.downloadWillBegin");
    await clickElement(cdp, sid, "#download-log");
    const download = await expectDownload(context, sid, expected, name);
    debug("scenario " + name + ": download " + download.bytes + " bytes in " + download.elapsedMs + " ms");
    const status = await textOf(cdp, sid, "#log-status");
    assert.ok(status && status.length > 0, name + " status text is empty");
    if (isHead) {
        assert.match(status, new RegExp("イベント " + expected.events + " 件"), name + " status lacks the event count: " + status);
        assert.match(status, new RegExp("チャンク " + expected.chunkCount + " 個"), name + " status lacks the chunk count: " + status);
        if (expected.events === 0) assert.match(status, /0 件/, name + " zero events must be called out");
    }
    const keysAfter = await storageKeys(cdp, sid);
    assert.deepEqual(keysAfter, keysBefore, name + " storage keys changed (clear ran?)");
    const exceptions = cdp.takeEvents("Runtime.exceptionThrown", (e) => e.sessionId === sid).map(exceptionText);
    assert.deepEqual(exceptions, [], name + " exceptions after click");
    return Object.assign({ status: status.slice(0, 200) }, download);
}

async function runReproScenario(context, sid, name, seed) {
    const { cdp } = context;
    await seedStorage(cdp, sid, seed);
    const keysBefore = await storageKeys(cdp, sid);
    cdp.takeEvents("Runtime.exceptionThrown");
    cdp.takeEvents("Browser.downloadWillBegin");
    await clickElement(cdp, sid, "#download-log");
    // Errors thrown inside chrome.* API callbacks are reported by the extension bindings as a
    // console/log error ("Error handling response: TypeError ..."), not as an uncaught exception.
    const matches = (text) => /TypeError/.test(text) && /mergeDiagnosticStorage/.test(text);
    const thrown = await Promise.any([
        cdp.waitEvent("Log.entryAdded", sid, 5000, (e) => e.params.entry.level === "error" && matches(e.params.entry.text || "")),
        cdp.waitEvent("Runtime.exceptionThrown", sid, 5000, (e) => matches(JSON.stringify(e.params.exceptionDetails || {}))),
        cdp.waitEvent("Runtime.consoleAPICalled", sid, 5000, (e) => e.params.type === "error" && matches(JSON.stringify(e.params.args || []))),
    ]).catch(() => { throw new Error(name + ": no TypeError from mergeDiagnosticStorage was reported after the click"); });
    const clickError = thrown.method === "Log.entryAdded" ? thrown.params.entry.text : JSON.stringify(thrown.params);
    // The failure has been observed; now show that nothing else happened in a bounded window.
    await sleep(3000);
    const begins = cdp.takeEvents("Browser.downloadWillBegin");
    assert.equal(begins.length, 0, name + " a download started");
    assert.deepEqual(fs.readdirSync(context.downloadDir), [], name + " a file landed in the download dir");
    assert.equal(await textOf(cdp, sid, "#log-status"), "", name + " status text appeared");
    assert.deepEqual(await storageKeys(cdp, sid), keysBefore, name + " storage keys changed");
    return { clickError: String(clickError).slice(0, 200), channel: thrown.method };
}

async function runClearScenario(context, sid) {
    const { cdp } = context;
    debug("scenario clear: start");
    const keysBefore = await storageKeys(cdp, sid);
    assert.ok(keysBefore.includes("unrelatedSetting"), "clear scenario expects the mixed seed");
    cdp.takeEvents("Page.javascriptDialogOpening");
    const firstClick = await clickElement(cdp, sid, "#clear-log", true);
    const dialog = await cdp.waitEvent("Page.javascriptDialogOpening", sid, 5000);
    assert.equal(dialog.params.type, "confirm", "clear must ask with confirm()");
    await cdp.send("Page.handleJavaScriptDialog", { accept: false }, sid);
    await firstClick.done;
    await sleep(300);
    assert.deepEqual(await storageKeys(cdp, sid), keysBefore, "cancelled confirm must not remove anything");
    const secondClick = await clickElement(cdp, sid, "#clear-log", true);
    await cdp.waitEvent("Page.javascriptDialogOpening", sid, 5000);
    await cdp.send("Page.handleJavaScriptDialog", { accept: true }, sid);
    await secondClick.done;
    let keysAfter = null;
    for (let i = 0; i < 30; i++) {
        keysAfter = await storageKeys(cdp, sid);
        if (keysAfter.length === 1) break;
        await sleep(100);
    }
    assert.deepEqual(keysAfter, ["unrelatedSetting"], "accepted confirm must remove only diagnostic chunks");
    const status = await textOf(cdp, sid, "#log-status");
    assert.match(status, /消去/, "clear status missing: " + status);
    return { dialogType: dialog.params.type, message: String(dialog.params.message).slice(0, 120) };
}

async function withChrome(leg, extDir, body) {
    const locale = LOCALES[leg.locale];
    const profileDir = fs.mkdtempSync("/tmp/nflx-prof-");
    const downloadDir = fs.mkdtempSync("/tmp/nflx-dl-");
    if (locale.prefCharset) {
        fs.mkdirSync(path.join(profileDir, "Default"));
        fs.writeFileSync(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ intl: { charset_default: locale.prefCharset } }));
    }
    debug(leg.build + "/" + leg.locale + ": launching chrome");
    const launched = await launchChrome({
        profileDir,
        env: locale.env,
        extraArgs: ["--load-extension=" + extDir, "--disable-extensions-except=" + extDir, "--lang=" + locale.lang],
    });
    debug(leg.build + "/" + leg.locale + ": " + launched.version.Browser);
    const context = { cdp: launched.cdp, version: launched.version, downloadDir };
    try {
        return await body(context);
    } finally {
        try { launched.ws.close(); } catch (error) { /* ignore */ }
        launched.chrome.kill("SIGKILL");
        await sleep(200);
        for (const dir of [profileDir, downloadDir]) {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) { /* left in place */ }
        }
    }
}

// ---- fixtures and report ----

const report = { label: "options_export", notMacOs: true, notChrome156: true, notUserProfile: true, notUserStoredData: true, legs: {} };
let fixtures = null;

function ensureFixtures() {
    if (fixtures) return fixtures;
    debug("building fixtures");
    const globs = packagedGlobs();
    const pinFiles = expandGlobs(globs, pinnedListing());
    const headFiles = expandGlobs(globs, workingTreeListing(globs));
    assert.equal(pinFiles.length, 17, "pinned package should have 17 files");
    assert.deepEqual(headFiles, pinFiles, "working tree package list differs from 5941c8b");
    const pinDir = buildExtensionDir("pin5941", pinFiles, (file) => execFileSync("git", ["show", PIN_COMMIT + ":" + file], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
    const headDir = buildExtensionDir("head", headFiles, (file) => fs.readFileSync(path.join(root, file)));
    assert.doesNotMatch(fs.readFileSync(path.join(pinDir, "pages/options.html"), "utf8"), /charset/i, "pinned options.html unexpectedly declares a charset");
    report.headOptionsIdenticalToPin = fs.readFileSync(path.join(pinDir, "pages/options.html"), "utf8") === fs.readFileSync(path.join(headDir, "pages/options.html"), "utf8");
    const seeds = buildSeeds();
    fixtures = { pinDir, headDir, seeds: seeds.seeds, expected: seeds.expected };
    debug("fixtures ready: " + JSON.stringify(seeds.expected));
    report.expected = seeds.expected;
    return fixtures;
}

test.after(() => {
    if (fixtures) {
        for (const dir of [fixtures.pinDir, fixtures.headDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
});

const skip = chromeAvailable() ? false : "chrome is not installed";

test("5941c8b in a Japanese-locale Chrome: core.js fails to parse and export does nothing", { timeout: 180000, skip }, async () => {
    const fx = ensureFixtures();
    const leg = { build: "pin5941", locale: "ja" };
    const result = await withChrome(leg, fx.pinDir, async (context) => {
        const { sid, load } = await openOptionsPage(context, leg);
        assert.equal(load.coreType, "undefined", "core loaded although the page decoded as Shift_JIS");
        assert.ok(load.exceptions.some((text) => /\/diagnostic\/core\.js ::/.test(text) && /SyntaxError/.test(text)), "no SyntaxError from core.js: " + JSON.stringify(load.exceptions));
        assert.equal(load.idText, "", "extension id was rendered");
        assert.notEqual(load.buttonText, "診断ログを書き出す", "button label was not garbled");
        const scenarios = {};
        for (const name of ["empty", "current"]) scenarios[name] = await runReproScenario(context, sid, name, fx.seeds[name]);
        return { chrome: context.version.Browser, load, scenarios };
    });
    report.legs["pin5941/ja"] = result;
});

test("5941c8b in an English-locale Chrome: core.js loads and export downloads (locale control)", { timeout: 180000, skip }, async () => {
    const fx = ensureFixtures();
    const leg = { build: "pin5941", locale: "en-US" };
    const result = await withChrome(leg, fx.pinDir, async (context) => {
        const { sid, load } = await openOptionsPage(context, leg);
        assert.equal(load.coreType, "object");
        assert.deepEqual(load.exceptions, []);
        assert.equal(load.idText, EXTENSION_ID);
        const scenarios = {};
        for (const name of ["empty", "current", "mixed"]) scenarios[name] = await runSuccessScenario(context, sid, name, fx.seeds[name], fx.expected[name], false);
        return { chrome: context.version.Browser, load, scenarios };
    });
    report.legs["pin5941/en-US"] = result;
});

for (const localeName of ["ja", "en-US"]) {
    test("working tree in a " + localeName + " Chrome: page is UTF-8, export downloads, clear asks first", { timeout: 240000, skip }, async () => {
        const fx = ensureFixtures();
        const leg = { build: "head", locale: localeName };
        const result = await withChrome(leg, fx.headDir, async (context) => {
            const { sid, load } = await openOptionsPage(context, leg);
            assert.equal(load.coreType, "object", "core did not load: " + JSON.stringify(load.exceptions));
            assert.deepEqual(load.exceptions, []);
            assert.equal(load.idText, EXTENSION_ID);
            assert.equal(load.buttonText, "診断ログを書き出す", "button label is garbled: " + load.buttonText);
            const scenarios = {};
            for (const name of ["empty", "current", "large", "mixed"]) scenarios[name] = await runSuccessScenario(context, sid, name, fx.seeds[name], fx.expected[name], true);
            scenarios.clear = await runClearScenario(context, sid);
            return { chrome: context.version.Browser, load, scenarios };
        });
        report.legs["head/" + localeName] = result;
    });
}
