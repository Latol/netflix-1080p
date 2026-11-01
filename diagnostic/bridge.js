(function () {
    "use strict";

    const Core = globalThis.Netflix1080pDiagCore;
    if (!Core || globalThis.__nflx1080pDiagBridge) return;
    globalThis.__nflx1080pDiagBridge = true;

    const STORAGE_KEY = "nflx1080pDiagnosticLog";
    let buffer = [];
    let timer = null;
    let chunk = 0;
    const seen = new Set();
    const sessionId = newSessionId();

    function frameKind() {
        try {
            return window.top === window ? "top" : "child";
        } catch (error) {
            return "child";
        }
    }

    const frame = frameKind();

    function newSessionId() {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        let id = "";
        for (let i = 0; i < bytes.length; i++) {
            id += bytes[i].toString(16).padStart(2, "0");
        }
        return id;
    }

    function persist() {
        timer = null;
        if (!buffer.length) return;
        const batch = buffer.splice(0, buffer.length);
        chunk += 1;
        const payload = {};
        payload[STORAGE_KEY + "." + sessionId + "." + String(chunk).padStart(4, "0")] = Core.mergeExport(null, batch, {
            extensionId: chrome.runtime.id,
        });
        chrome.storage.local.set(payload);
    }

    function schedule() {
        if (buffer.length >= 200) {
            if (timer != null) {
                clearTimeout(timer);
                timer = null;
            }
            persist();
            return;
        }
        if (timer != null) return;
        timer = setTimeout(persist, 250);
    }

    function ingest(event) {
        const clean = Core.sanitizeEvent(event);
        if (!clean) return;
        if (!clean.frame) clean.frame = frame;
        const key = String(clean.frame) + ":" + String(clean.seq);
        if (seen.has(key)) return;
        seen.add(key);
        buffer.push(clean);
        schedule();
    }

    function drainDomBuffer() {
        const node = document.getElementById("nflx1080p-diag-buffer");
        if (!node) return;
        let list = [];
        try {
            list = JSON.parse(node.textContent || "[]");
        } catch (error) {
            return;
        }
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) ingest(list[i]);
    }

    drainDomBuffer();
    const drainTimer = setInterval(drainDomBuffer, 500);

    window.addEventListener("message", function (event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== Core.MESSAGE_SOURCE || !data.event) return;
        ingest(data.event);
    });

    window.addEventListener("pagehide", function () {
        drainDomBuffer();
        clearInterval(drainTimer);
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
        persist();
    });
})();
