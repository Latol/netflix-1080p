// Shared Chrome DevTools Protocol helpers for the browser-level tests.
// No dependencies: Node 22 provides fetch and WebSocket.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_CHROME_BIN = "/usr/bin/google-chrome";

function chromeBinary() {
    return process.env.CHROME_BIN || DEFAULT_CHROME_BIN;
}

function chromeAvailable() {
    return fs.existsSync(chromeBinary());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPortFile(profileDir, timeoutMs) {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const limit = timeoutMs || 15000;
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (fs.existsSync(portFile)) {
                clearInterval(timer);
                const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
                resolve(port);
                return;
            }
            if (Date.now() - started > limit) {
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

    // Resolves with the first buffered event that matches; other events stay queued.
    waitEvent(method, sessionId, timeoutMs, predicate) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const index = this.events.findIndex((event) => {
                    if (event.method !== method) return false;
                    if (sessionId && event.sessionId !== sessionId) return false;
                    return predicate ? Boolean(predicate(event)) : true;
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

    // Removes and returns every buffered event that matches.
    takeEvents(method, predicate) {
        const taken = [];
        for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (event.method !== method) continue;
            if (predicate && !predicate(event)) continue;
            taken.unshift(event);
            this.events.splice(i, 1);
        }
        return taken;
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

const BASE_ARGS = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
];

// Launches Chrome with a fresh remote debugging port and returns a browser-level CDP connection.
// options.profileDir (required), options.extraArgs (array), options.env (object merged over process.env).
async function launchChrome(options) {
    const opts = options || {};
    if (!opts.profileDir) throw new Error("profileDir is required");
    const args = BASE_ARGS.concat([
        "--user-data-dir=" + opts.profileDir,
        "--remote-debugging-port=0",
    ], opts.extraArgs || [], ["about:blank"]);
    const env = Object.assign({}, process.env, opts.env || {});
    const chrome = spawn(chromeBinary(), args, { stdio: "ignore", env });
    try {
        const debugPort = await waitForPortFile(opts.profileDir, opts.portTimeoutMs);
        const version = await (await fetch("http://127.0.0.1:" + debugPort + "/json/version")).json();
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve);
            ws.addEventListener("error", reject);
        });
        return { chrome, ws, cdp: new Cdp(ws), version, debugPort };
    } catch (error) {
        chrome.kill("SIGKILL");
        throw error;
    }
}

// Creates a new page target, attaches with a flat session, and enables the usual domains.
async function attachNewPage(cdp, domains) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    for (const domain of domains || ["Page", "Runtime"]) {
        await cdp.send(domain + ".enable", {}, sessionId);
    }
    return { sessionId, targetId: created.targetId };
}

module.exports = {
    chromeBinary,
    chromeAvailable,
    sleep,
    waitForPortFile,
    Cdp,
    evaluate,
    launchChrome,
    attachNewPage,
    BASE_ARGS,
};
