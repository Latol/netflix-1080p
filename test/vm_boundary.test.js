const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const chromeBin = process.env.CHROME_BIN || "/usr/bin/google-chrome";

function chromeAvailable() {
    return fs.existsSync(chromeBin);
}

function bundleScripts(bundle) {
    if (bundle === "baseline") return "";
    if (bundle === "diag5941") {
        return "<script src=\"/pins/5941c8b/core.js\"></script><script src=\"/pins/5941c8b/page_hook.js\"></script>";
    }
    return "<script src=\"/diagnostic/core.js\"></script><script src=\"/diagnostic/page_hook.js\"></script>";
}

function startServer(pinDir) {
    const counts = { documents: 0 };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname.startsWith("/netflix.com/watch/")) {
            counts.documents += 1;
            const bundle = url.searchParams.get("bundle") || "head";
            const html = fs.readFileSync(path.join(__dirname, "vm", "fixture.html"), "utf8")
                .replace("<!-- BUNDLE_SCRIPTS -->", bundleScripts(bundle));
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
        }
        if (url.pathname.startsWith("/pins/")) {
            const filePath = path.normalize(path.join(pinDir, url.pathname.slice("/pins/".length)));
            if (!filePath.startsWith(pinDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404);
                res.end("missing pin");
                return;
            }
            res.writeHead(200, { "content-type": "text/javascript" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        const filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
        if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404);
            res.end("missing");
            return;
        }
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
    });
    server.counts = counts;
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

function writePins(pinDir) {
    fs.mkdirSync(path.join(pinDir, "5941c8b"), { recursive: true });
    fs.writeFileSync(path.join(pinDir, "5941c8b", "core.js"), execFileSync("git", ["show", "5941c8b:diagnostic/core.js"], { cwd: root }));
    fs.writeFileSync(path.join(pinDir, "5941c8b", "page_hook.js"), execFileSync("git", ["show", "5941c8b:diagnostic/page_hook.js"], { cwd: root }));
    fs.writeFileSync(path.join(pinDir, "baseline-bitrate.js"), execFileSync("git", ["show", "origin/baseline/v1.34.0:netflix_max_bitrate.js"], { cwd: root }));
}

function waitForPortFile(profileDir) {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (fs.existsSync(portFile)) {
                clearInterval(timer);
                const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
                resolve(port);
                return;
            }
            if (Date.now() - started > 10000) {
                clearInterval(timer);
                reject(new Error("chrome devtools port was not created"));
            }
        }, 50);
    });
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.next = 1;
        this.pending = new Map();
        this.events = [];
        this.navigations = new Map();
        ws.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.method === "Page.frameNavigated" && message.params && message.params.frame && !message.params.frame.parentId) {
                const count = this.navigations.get(message.sessionId) || 0;
                this.navigations.set(message.sessionId, count + 1);
            }
            if (message.id && this.pending.has(message.id)) {
                const waiter = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
                else waiter.resolve(message.result || {});
                return;
            }
            this.events.push(message);
        });
    }

    send(method, params, sessionId) {
        const id = this.next++;
        const payload = { id, method, params: params || {} };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
    }

    waitEvent(method, sessionId, timeoutMs) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const index = this.events.findIndex((event) => {
                    return event.method === method && (!sessionId || event.sessionId === sessionId);
                });
                if (index >= 0) {
                    clearInterval(timer);
                    resolve(this.events.splice(index, 1)[0]);
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(timer);
                    reject(new Error("timed out waiting for " + method));
                }
            }, 20);
        });
    }
}

async function evaluate(cdp, sessionId, expression) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result && result.result.value;
}

async function openFixture(cdp, port, bundle) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 10000);
    await cdp.send("Page.navigate", {
        url: "http://127.0.0.1:" + port + "/netflix.com/watch/80000000?bundle=" + bundle,
    }, sessionId);
    await loaded;
    return sessionId;
}

function assertBundle(bundle, result) {
    assert.equal(result.signals.initialClicks, 1, bundle + " initial override");
    assert.equal(result.signals.clicksAfterClock, 1, bundle + " clock hold added an override");
    assert.equal(result.signals.clicksAfterSignals, 1, bundle + " dispatched signals added an override");
    assert.equal(result.signals.clicksAfterPlayerReplacement, 1, bundle + " model reset added an override");
    assert.equal(result.signals.keydownsAfterSignals, result.signals.keydownsAfterInitial, bundle + " key chord changed");
    assert.ok(result.signals.forwardTimerCallbacks >= 1, bundle + " timer did not run during the forward clock");
    assert.ok(result.signals.backwardTimerCallbacks >= 1, bundle + " timer did not run during the backward clock");
    assert.equal(result.signals.comparedMonotonicAcrossTimeOrigins, false);
    assert.equal(result.signals.onlineMeansNetflixReachable, false);
    assert.deepEqual(result.signals.modelOptionValues.slice(0, 2), ["5800000", "300000"]);
    assert.equal(result.navigationsDuringProbe, 0, bundle + " document navigated");
    assert.equal(result.serverDocumentGetsDuringProbe, 0, bundle + " document was fetched again");
    if (bundle === "baseline") {
        assert.equal(result.menu.videoMenuBuilt, 0);
        assert.equal(result.signals.forwardSamples, 0);
        assert.equal(result.signals.playersAfterReplacement, 0);
    } else {
        assert.equal(result.menu.videoMenuBuilt, 1);
        assert.equal(result.menu.videoMenuUpdatedSameTurn, 0);
        assert.equal(result.menu.videoMenuUpdatedLater, 1);
        assert.equal(result.menu.laterCount, 3);
        assert.ok(result.signals.forwardSamples >= 1, bundle + " sample did not observe the forward clock");
        assert.ok(result.signals.backwardSamples >= 1, bundle + " sample did not observe the backward clock");
        assert.ok(result.signals.restoredSamples >= 1, bundle + " sample did not observe the restored clock");
        assert.ok(result.signals.playersAfterReplacement > result.signals.playersBeforeReplacement);
    }
}

test("chrome page boundary: clocks, reload detector, baseline and diagnostic", { timeout: 120000, skip: chromeAvailable() ? false : "chrome is not installed" }, async () => {
    const profileDir = fs.mkdtempSync("/tmp/nflx-chrome-");
    const pinDir = fs.mkdtempSync("/tmp/nflx-pins-");
    writePins(pinDir);
    const baselineBytes = fs.readFileSync(path.join(pinDir, "baseline-bitrate.js"));
    const headBytes = fs.readFileSync(path.join(root, "netflix_max_bitrate.js"));
    const server = await startServer(pinDir);
    const port = server.address().port;
    const chrome = spawn(chromeBin, [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--user-data-dir=" + profileDir,
        "--remote-debugging-port=0",
        "about:blank",
    ], { stdio: "ignore" });
    let report;
    try {
        const debugPort = await waitForPortFile(profileDir);
        const version = await (await fetch("http://127.0.0.1:" + debugPort + "/json/version")).json();
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve);
            ws.addEventListener("error", reject);
        });
        const cdp = new Cdp(ws);

        const control = await openFixture(cdp, port, "baseline");
        const controlNavBefore = cdp.navigations.get(control) || 0;
        const controlGetsBefore = server.counts.documents;
        const controlLoad = cdp.waitEvent("Page.loadEventFired", control, 10000);
        try {
            await evaluate(cdp, control, "location.reload()");
        } catch (error) {
            report = report || {};
            report.reloadEvaluateError = String(error.message || error).slice(0, 180);
        }
        await controlLoad;
        const reloadControl = {
            label: "real_location_reload_positive_control",
            prototypeOverrideUsed: false,
            navigationsBefore: controlNavBefore,
            navigationsAfter: cdp.navigations.get(control) || 0,
            serverDocumentGetsBefore: controlGetsBefore,
            serverDocumentGetsAfter: server.counts.documents,
        };

        const bundles = {};
        for (const bundle of ["baseline", "diag5941", "head"]) {
            const sessionId = await openFixture(cdp, port, bundle);
            const menu = await evaluate(cdp, sessionId, "window.runMenuProbe()");
            const navBefore = cdp.navigations.get(sessionId) || 0;
            const getsBefore = server.counts.documents;
            const signals = await evaluate(cdp, sessionId, "window.runSignalProbe()");
            bundles[bundle] = {
                menu,
                signals,
                navigationsDuringProbe: (cdp.navigations.get(sessionId) || 0) - navBefore,
                serverDocumentGetsDuringProbe: server.counts.documents - getsBefore,
            };
            if (bundle !== "baseline") {
                let lifecycle = { attempted: true, supported: false, label: "chromium_page_lifecycle_cdp" };
                try {
                    await cdp.send("Page.setWebLifecycleState", { state: "frozen" }, sessionId);
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    await cdp.send("Page.setWebLifecycleState", { state: "active" }, sessionId);
                    lifecycle.supported = true;
                    lifecycle.after = await evaluate(cdp, sessionId, "window.readProbe()");
                } catch (error) {
                    lifecycle.errorName = "cdp_lifecycle_unsupported";
                }
                let network = { attempted: true, supported: false, label: "chromium_network_emulation" };
                try {
                    await cdp.send("Network.emulateNetworkConditions", {
                        offline: true,
                        latency: 400,
                        downloadThroughput: 0,
                        uploadThroughput: 0,
                    }, sessionId);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    await cdp.send("Network.emulateNetworkConditions", {
                        offline: false,
                        latency: 0,
                        downloadThroughput: -1,
                        uploadThroughput: -1,
                    }, sessionId);
                    network.supported = true;
                    network.after = await evaluate(cdp, sessionId, "window.readProbe()");
                } catch (error) {
                    network.errorName = "cdp_network_emulation_unsupported";
                }
                bundles[bundle].lifecycle = lifecycle;
                bundles[bundle].network = network;
            }
        }

        report = {
            label: "vm_browser_boundary",
            notMacOsSleep: true,
            notNetflixDrm: true,
            notGpuResume: true,
            notClearToLowQualityTransition: true,
            chrome: version.Browser,
            bitrateScriptBytesMatchBaseline: baselineBytes.equals(headBytes),
            reloadControl,
            bundles,
        };
        fs.writeFileSync("/tmp/nflx-vm-boundary-report.json", JSON.stringify(report, null, 2));
        ws.close();
    } finally {
        chrome.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(pinDir, { recursive: true, force: true });
        try {
            fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
            if (report) report.profileCleanup = "left in place";
        }
    }

    assert.ok(report.reloadControl.navigationsAfter > report.reloadControl.navigationsBefore, "reload detector did not observe a navigation");
    assert.ok(report.reloadControl.serverDocumentGetsAfter > report.reloadControl.serverDocumentGetsBefore, "reload detector did not observe a document fetch");
    assert.equal(report.bitrateScriptBytesMatchBaseline, true);
    for (const bundle of ["baseline", "diag5941", "head"]) {
        assertBundle(bundle, report.bundles[bundle]);
        const lifecycle = report.bundles[bundle].lifecycle;
        const network = report.bundles[bundle].network;
        if (lifecycle && lifecycle.supported) assert.equal(lifecycle.after.clicks, 1, bundle + " lifecycle");
        if (network && network.supported) assert.equal(network.after.clicks, 1, bundle + " network");
    }
    assert.equal(report.bundles.baseline.signals.clicksAfterSignals, report.bundles.diag5941.signals.clicksAfterSignals);
    assert.equal(report.bundles.diag5941.signals.clicksAfterSignals, report.bundles.head.signals.clicksAfterSignals);
});
