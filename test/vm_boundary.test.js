const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const chromeBin = process.env.CHROME_BIN || "/usr/bin/google-chrome";

function chromeAvailable() {
    return fs.existsSync(chromeBin);
}

function startServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname.startsWith("/netflix.com/watch/")) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(fs.readFileSync(path.join(__dirname, "vm", "fixture.html")));
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
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
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
        ws.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
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

test("chrome page boundary: menu batch, unchanged URL, and non-sleep signals", { timeout: 60000, skip: chromeAvailable() ? false : "chrome is not installed" }, async () => {
    const profileDir = fs.mkdtempSync("/tmp/nflx-chrome-");
    const server = await startServer();
    const port = server.address().port;
    const chrome = spawn(chromeBin, [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
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
        const created = await cdp.send("Target.createTarget", { url: "about:blank" });
        const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
        const sessionId = attached.sessionId;
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId);
        const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 10000);
        await cdp.send("Page.navigate", {
            url: "http://127.0.0.1:" + port + "/netflix.com/watch/fixture",
        }, sessionId);
        await loaded;
        const menu = await evaluate(cdp, sessionId, "window.runMenuProbe()");
        const signals = await evaluate(cdp, sessionId, "window.runSignalProbe()");

        let lifecycle = { attempted: true, supported: false, label: "chromium_page_lifecycle_cdp" };
        try {
            await cdp.send("Page.setWebLifecycleState", { state: "frozen" }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 400));
            await cdp.send("Page.setWebLifecycleState", { state: "active" }, sessionId);
            lifecycle.supported = true;
            lifecycle.after = await evaluate(cdp, sessionId, "window.readProbe()");
        } catch (error) {
            lifecycle.supported = false;
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
            network.supported = false;
            network.errorName = "cdp_network_emulation_unsupported";
        }

        report = {
            label: "vm_browser_boundary",
            notMacOsSleep: true,
            notNetflixDrm: true,
            notGpuResume: true,
            chrome: version.Browser,
            menu,
            signals,
            lifecycle,
            network,
        };
        fs.writeFileSync("/tmp/nflx-vm-boundary-report.json", JSON.stringify(report, null, 2));
        ws.close();
    } finally {
        chrome.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await new Promise((resolve) => server.close(resolve));
        try {
            fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
            if (report) report.profileCleanup = "left in place";
        }
    }

    assert.equal(report.menu.videoMenuBuilt, 1);
    assert.equal(report.menu.videoMenuUpdatedSameTurn, 0);
    assert.equal(report.menu.videoMenuUpdatedLater, 1);
    assert.equal(report.menu.laterCount, 3);
    assert.equal(report.signals.initialClicks, 1);
    assert.equal(report.signals.clicksAfterSignals, 1);
    assert.equal(report.signals.keydownsAfterSignals, report.signals.keydownsAfterInitial);
    assert.equal(report.signals.clicksAfterPlayerReplacement, 1);
    assert.equal(report.signals.reloads, 0);
    assert.equal(report.signals.comparedMonotonicAcrossTimeOrigins, false);
    assert.equal(report.signals.onlineMeansNetflixReachable, false);
    assert.ok(report.signals.clockForwardDateDelta > 1000);
    assert.ok(report.signals.clockBackwardDateDelta < -1000);
    if (report.lifecycle.supported) {
        assert.equal(report.lifecycle.after.clicks, 1);
        assert.equal(report.lifecycle.after.reloads, 0);
    }
    if (report.network.supported) {
        assert.equal(report.network.after.clicks, 1);
        assert.equal(report.network.after.reloads, 0);
    }
});
