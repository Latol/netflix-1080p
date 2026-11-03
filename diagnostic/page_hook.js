(function () {
    "use strict";

    const Core = globalThis.Netflix1080pDiagCore;
    if (!Core || globalThis.__nflx1080pDiagInstalled) return;
    globalThis.__nflx1080pDiagInstalled = true;

    const wasDiscarded = document.wasDiscarded === true;
    let seq = 0;
    let errorCount = 0;
    let playerGeneration = 0;
    let lastSelected = null;
    let lastTrace = null;
    let suppressMenuObserver = false;
    let pollTimer = null;
    let stylePresent = null;
    const menuSignatures = Object.create(null);
    const videoSerials = new WeakMap();
    let nextVideoSerial = 0;
    const menuTracker = Core.createMenuTracker();
    const playerTracker = Core.createPlayerTracker();
    const locations = Core.createLocationTracker();

    function emit(partial) {
        const event = Object.assign({
            at: Date.now(),
            perf: Math.round(performance.now()),
            seq: seq += 1,
        }, partial);
        let clean = null;
        try {
            clean = Core.sanitizeEvent(event);
        } catch (error) {
            return null;
        }
        if (!clean) return null;
        remember(clean);
        try {
            window.postMessage({ source: Core.MESSAGE_SOURCE, event: clean }, "*");
        } catch (error) {
            return clean;
        }
        return clean;
    }

    function remember(clean) {
        const parent = document.documentElement;
        if (!parent) return;
        let node = document.getElementById("nflx1080p-diag-buffer");
        if (!node) {
            node = document.createElement("script");
            node.id = "nflx1080p-diag-buffer";
            node.type = "application/json";
            node.textContent = "[]";
            parent.appendChild(node);
        }
        let list = [];
        try {
            list = JSON.parse(node.textContent || "[]");
        } catch (error) {
            list = [];
        }
        if (!Array.isArray(list)) list = [];
        list.push(clean);
        if (list.length > 250) list = list.slice(list.length - 250);
        node.textContent = JSON.stringify(list);
    }

    function emitError(code) {
        if (errorCount >= 20) return;
        errorCount += 1;
        emit(Core.describeError(code));
    }

    function clearAttribution() {
        lastSelected = null;
        lastTrace = null;
    }

    function hideStylePresent() {
        return Boolean(document.getElementById("maxbitrate-hide-menu-style"));
    }

    function streamRoot(node) {
        let current = node;
        while (current && current.nodeType === 1) {
            if (current.classList && current.classList.contains("player-streams")) return current;
            current = current.parentNode;
        }
        return null;
    }

    function labelTextFor(select) {
        const parent = select.parentElement;
        if (!parent) return "";
        const divs = parent.getElementsByTagName("div");
        if (!divs.length) return "";
        return (divs[0].textContent || "").trim();
    }

    function optionsFrom(select) {
        const options = [];
        const list = select.options || [];
        for (let i = 0; i < list.length; i++) {
            options.push({
                value: list[i].value,
                text: list[i].text,
                selected: list[i].selected === true,
            });
        }
        return options;
    }

    function rememberSelected(event) {
        if (!event || event.phase !== "before-override-click") return;
        if (!lastSelected) lastSelected = { video: null, audio: null, actor: event.actor };
        if (event.label === "video" || event.label === "audio") lastSelected[event.label] = event.snapshot;
        lastSelected.actor = event.actor;
        lastSelected.playerGeneration = playerGeneration;
    }

    function rememberMenu(label, snapshot) {
        menuSignatures[label] = Core.menuSignature(snapshot);
    }

    function recordOverride(root, actor) {
        const selects = root.querySelectorAll("select");
        for (let i = 0; i < selects.length; i++) {
            const label = Core.menuLabel(labelTextFor(selects[i]));
            const live = Core.snapshotOptions(optionsFrom(selects[i]));
            rememberMenu(label, live);
            const produced = menuTracker.noteOverrideBefore(label, live, actor);
            for (let j = 0; j < produced.length; j++) {
                rememberSelected(emit(produced[j]));
            }
        }
    }

    function recordVisibleMenu(root, actor) {
        const selects = root.querySelectorAll("select");
        for (let i = 0; i < selects.length; i++) {
            const label = Core.menuLabel(labelTextFor(selects[i]));
            const snapshot = Core.snapshotOptions(optionsFrom(selects[i]));
            const flushed = Core.recordMenuIfChanged(menuTracker, menuSignatures, label, snapshot, actor);
            for (let j = 0; j < flushed.length; j++) emit(flushed[j]);
        }
    }

    function findPlaybackStatsText(doc) {
        let nodes;
        try {
            nodes = doc.querySelectorAll(".player-info textarea");
        } catch (error) {
            return "";
        }
        for (let i = 0; i < nodes.length; i++) {
            const text = Core.readStatsNodeText(nodes[i]);
            if (text.indexOf("Playing bitrate (a/v):") !== -1 || text.indexOf("Video Track:") !== -1 || text.indexOf("Throughput:") !== -1) {
                return text;
            }
        }
        return "";
    }

    function renderedFromVideos() {
        const videos = document.getElementsByTagName("video");
        const entries = [];
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const serial = videoSerials.get(video);
            if (!serial) continue;
            let quality = null;
            try {
                if (typeof video.getVideoPlaybackQuality === "function") quality = video.getVideoPlaybackQuality();
            } catch (error) {
                quality = null;
            }
            entries.push({
                serial: serial,
                width: video.videoWidth,
                height: video.videoHeight,
                droppedVideoFrames: quality && quality.droppedVideoFrames,
                totalVideoFrames: quality && quality.totalVideoFrames,
                corruptedVideoFrames: quality && quality.corruptedVideoFrames,
            });
        }
        const measured = Core.selectTrackedMeasurement(entries, playerTracker.currentKey());
        return {
            width: measured.width,
            height: measured.height,
            playback: measured.playback,
            videoCount: videos.length,
            videoSerial: measured.videoSerial,
        };
    }

    const sampler = Core.createSampler({
        intervalMs: Core.SAMPLE_INTERVAL_MS,
        maxSamples: Core.SAMPLE_COUNT,
        now: function () { return Date.now(); },
        schedule: function (fn, ms) { return setTimeout(fn, ms); },
        clear: function (id) { clearTimeout(id); },
        onSample: function (info) {
            const rendered = renderedFromVideos();
            const attribution = Core.attributionForSample(lastSelected, lastTrace, playerGeneration);
            emit(Core.buildSample({
                wasDiscarded: wasDiscarded,
                index: info.index,
                rendered: { width: rendered.width, height: rendered.height },
                renderedProbe: Core.probeStatsText(findPlaybackStatsText(document)),
                selectedStream: attribution.selectedStream,
                playerTrace: attribution.playerTrace,
                playback: rendered.playback,
                dom: {
                    hideStylePresent: hideStylePresent(),
                    menuPresent: Boolean(document.querySelector(".player-streams")),
                    videoCount: rendered.videoCount,
                },
                playerGeneration: playerGeneration,
                videoSerial: rendered.videoSerial,
            }));
        },
        onComplete: function (info) {
            emit({
                type: "sampler",
                phase: "complete",
                generation: info.generation,
                wasDiscarded: wasDiscarded,
                intervalMs: Core.SAMPLE_INTERVAL_MS,
                maxSamples: Core.SAMPLE_COUNT,
            });
        },
    });

    function applySampler(action) {
        if (action === "start" || action === "restart") {
            const handle = sampler.start({ wasDiscarded: wasDiscarded });
            emit({
                type: "sampler",
                phase: action,
                generation: handle.generation,
                wasDiscarded: wasDiscarded,
                intervalMs: Core.SAMPLE_INTERVAL_MS,
                maxSamples: Core.SAMPLE_COUNT,
            });
            return;
        }
        if (action === "cancel" && sampler.isActive()) {
            sampler.cancel("navigation");
            emit({
                type: "sampler",
                phase: "cancel",
                wasDiscarded: wasDiscarded,
                intervalMs: Core.SAMPLE_INTERVAL_MS,
                maxSamples: Core.SAMPLE_COUNT,
            });
        }
    }

    function onHref(href) {
        const result = locations.update(href);
        if (result.kind === "unchanged") return;
        if (Core.clearsAttribution(result.kind)) clearAttribution();
        emit(result.publicEvent);
        applySampler(Core.decideSamplerAction({ running: sampler.isActive() }, result.kind));
    }

    function serialFor(video) {
        let serial = videoSerials.get(video);
        if (!serial) {
            nextVideoSerial += 1;
            serial = nextVideoSerial;
            videoSerials.set(video, serial);
        }
        return serial;
    }

    function noteVideo(video) {
        if (!video || video.tagName !== "VIDEO") return;
        const serial = serialFor(video);
        const previous = playerTracker.currentKey();
        if (previous === serial) return;
        const eventType = previous == null ? "video-added" : "video-replaced";
        const playerEvent = playerTracker.note(serial, Date.now());
        if (!playerEvent) return;
        if (Core.clearsAttribution(eventType)) clearAttribution();
        playerGeneration = playerEvent.playerGeneration;
        const src = video.currentSrc || video.src || "";
        emit(Object.assign({ srcKind: Core.srcKind(src) }, playerEvent));
        applySampler(Core.decideSamplerAction({ running: sampler.isActive() }, eventType));
    }

    function noteStyle(present) {
        const next = present === true;
        if (stylePresent === next) return;
        stylePresent = next;
        emit({ type: "extension-style", present: next });
    }

    let lastSettingsText = null;
    function readSettingsNode() {
        const node = document.getElementById("netflix-1080p-settings");
        if (!node) return;
        const text = node.textContent || "";
        if (text === lastSettingsText) return;
        lastSettingsText = text;
        emit(Core.describeSettingsDom(text));
    }

    function handleInteresting(node) {
        if (node.id === "netflix-1080p-settings") readSettingsNode();
        if (node.id === "maxbitrate-hide-menu-style") noteStyle(true);
        if (node.tagName === "VIDEO") noteVideo(node);
        if (suppressMenuObserver) return;
        const actor = hideStylePresent() ? "extension-hidden" : "unknown";
        if (node.classList && node.classList.contains("player-streams") && node.isConnected) {
            recordVisibleMenu(node, actor);
        }
        if (node.tagName === "OPTION" && node.parentElement && node.parentElement.tagName === "SELECT") {
            const root = streamRoot(node.parentElement);
            if (root && root.isConnected) recordVisibleMenu(root, actor);
        }
    }

    function scanAdded(node) {
        if (!node || node.nodeType !== 1) return;
        handleInteresting(node);
        if (!node.querySelectorAll || !node.childElementCount) return;
        if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "OPTION") return;
        const nested = node.querySelectorAll("video, #netflix-1080p-settings, #maxbitrate-hide-menu-style, .player-streams");
        for (let i = 0; i < nested.length; i++) handleInteresting(nested[i]);
    }

    function scanRemoved(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.id === "maxbitrate-hide-menu-style") noteStyle(false);
    }

    function installGlobalOptionsHook() {
        let current;
        let hadValue = false;
        try {
            if (Object.prototype.hasOwnProperty.call(window, "globalOptions") && window.globalOptions !== undefined) {
                current = window.globalOptions;
                hadValue = true;
            }
        } catch (error) {
            emitError("global-options-hook");
        }
        try {
            Object.defineProperty(window, "globalOptions", {
                configurable: true,
                enumerable: true,
                get: function () { return current; },
                set: function (value) {
                    current = value;
                    try {
                        emit(Core.describeGlobalOptionsAssignment(value));
                    } catch (error) {
                        emitError("global-options-hook");
                    }
                },
            });
        } catch (error) {
            emitError("global-options-hook");
            return;
        }
        if (hadValue) window.globalOptions = current;
    }

    function wrapConsole(level) {
        const original = console[level];
        if (typeof original !== "function") return;
        console[level] = function () {
            try {
                const classified = Core.classifyConsole(Array.prototype.slice.call(arguments));
                if (classified) {
                    const clean = emit(classified);
                    if (clean && clean.type === "playback-trace") {
                        lastTrace = Object.assign({ playerGeneration: playerGeneration }, clean);
                    }
                }
            } catch (error) {
                emitError("console-hook");
            }
            return original.apply(console, arguments);
        };
    }

    emit(Object.assign({ at: Date.now(), perf: Math.round(performance.now()) }, Core.documentFacts(document, performance)));
    installGlobalOptionsHook();
    wrapConsole("log");
    wrapConsole("error");
    wrapConsole("warn");
    window.addEventListener("popstate", function () {
        onHref(String(location.href));
    });
    window.addEventListener("hashchange", function () {
        onHref(String(location.href));
    });
    window.addEventListener("error", function () {
        emitError("page-error");
    });
    window.addEventListener("unhandledrejection", function () {
        emitError("page-rejection");
    });
    document.addEventListener("click", function (event) {
        const target = event.target && event.target.closest ? event.target.closest("button") : event.target;
        if (!target || target.tagName !== "BUTTON") return;
        if ((target.textContent || "").trim() !== "Override") return;
        const root = streamRoot(target);
        if (!root) return;
        suppressMenuObserver = true;
        const actor = Core.menuActor({
            trusted: event.isTrusted === true,
            hideStylePresent: hideStylePresent(),
        });
        try {
            recordOverride(root, actor);
        } catch (error) {
            emitError("override-hook");
        }
        setTimeout(function () {
            suppressMenuObserver = false;
            const produced = menuTracker.noteOverrideAfter("video", actor, Boolean(document.querySelector(".player-streams")));
            emit(produced[0]);
        }, 0);
    }, true);

    const observer = new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (record.type !== "childList") continue;
            for (let j = 0; j < record.addedNodes.length; j++) scanAdded(record.addedNodes[j]);
            for (let j = 0; j < record.removedNodes.length; j++) scanRemoved(record.removedNodes[j]);
        }
    });
    if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
        scanAdded(document.documentElement);
    }
    onHref(String(location.href));
    pollTimer = setInterval(function () {
        try {
            onHref(String(location.href));
        } catch (error) {
            emitError("location-hook");
        }
    }, 500);
    window.addEventListener("pagehide", function () {
        if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        observer.disconnect();
        if (sampler.isActive()) {
            sampler.cancel("dispose");
            emit({
                type: "sampler",
                phase: "cancel",
                wasDiscarded: wasDiscarded,
            });
        }
    });
})();
