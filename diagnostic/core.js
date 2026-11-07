(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.Netflix1080pDiagCore = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SCHEMA = "netflix-1080p-diagnostic/1";
    const MESSAGE_SOURCE = "netflix-1080p-diagnostic";
    const SAMPLE_INTERVAL_MS = 1000;
    const SAMPLE_COUNT = 180;
    const MAX_EVENTS = 4000;
    const STORE_EXTENSION_ID = "mdlbikciddolbenfkgggdegphnhmnfcg";
    const DIAGNOSTIC_EXTENSION_ID = "paaingnmhpdddlckkplellcbindblmkd";
    const SETTING_KEYS = Object.freeze([
        "use6Channels",
        "setMaxBitrate",
        "disableVP9",
        "disableAVChigh",
        "disableAV1",
        "showAllSubs",
    ]);
    const DEFAULT_SETTINGS = Object.freeze({
        use6Channels: true,
        setMaxBitrate: true,
        disableVP9: false,
        disableAVChigh: false,
        disableAV1: false,
        showAllSubs: false,
    });
    const USER_REPORTED_OPTIONS_SCREEN = Object.freeze({
        source: "user-provided-options-screenshot",
        storageRead: false,
        values: Object.freeze({
            use6Channels: true,
            setMaxBitrate: true,
            disableVP9: true,
            disableAVChigh: true,
            disableAV1: true,
            showAllSubs: true,
        }),
        note: "Checkbox observation of the original options screen. chrome.storage was not read. Checked codec rows are disable switches.",
    });
    const CODEC_TOKENS = Object.freeze(["av1", "vp9", "h265", "hevc", "h264", "avc", "aac", "ec-3"]);
    const EVENT_TYPES = new Set([
        "document",
        "global-options",
        "settings-dom",
        "settings-error",
        "profile",
        "player-log",
        "playback-trace",
        "menu",
        "sample",
        "player",
        "location",
        "extension-style",
        "error",
        "sampler",
    ]);
    const MENU_PHASES = ["menu-built", "menu-updated", "before-override-click", "after-override-click"];
    const MENU_ACTORS = ["manual", "extension-hidden", "script", "unknown"];
    const MENU_LABELS = ["video", "audio", "cdn", "other"];
    const PLAYER_LOG_MARKERS = [
        "VP9 disabled",
        "5.1 support enabled",
        "AVChigh disabled",
        "AV1 disabled",
        "All subtitle tracks shown",
        "drmType:",
        "netflix_max_bitrate.js enabled",
    ];

    function pickSettings(input) {
        const settings = {};
        for (let i = 0; i < SETTING_KEYS.length; i++) {
            const key = SETTING_KEYS[i];
            settings[key] = Boolean(input && input[key]);
        }
        return settings;
    }

    function settingsForNewInstall() {
        return pickSettings(DEFAULT_SETTINGS);
    }

    function settingsMatchReport(loaded) {
        const settings = pickSettings(loaded);
        const reported = USER_REPORTED_OPTIONS_SCREEN.values;
        const mismatched = [];
        for (let i = 0; i < SETTING_KEYS.length; i++) {
            const key = SETTING_KEYS[i];
            if (settings[key] !== reported[key]) mismatched.push(key);
        }
        return {
            settings: settings,
            mismatched: mismatched,
            matches: mismatched.length === 0,
        };
    }

    function originalAutomaticLoopExpected(settings) {
        return Boolean(settings && settings.setMaxBitrate === true);
    }

    function redactText(value, maxLen) {
        const limit = maxLen || 180;
        if (typeof value !== "string") return "";
        let text = value;
        text = text.replace(/https?:\/\/\S+/gi, "[url]");
        text = text.replace(/blob:\S+/gi, "[blob]");
        text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]");
        text = text.replace(/\/watch\/\d+/gi, "/watch/[id]");
        text = text.replace(/\b(cookie|authorization|token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
        if (text.length > limit) text = text.slice(0, limit);
        return text;
    }

    function finiteOrNull(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    function boundedGap(value, allowNegative) {
        const number = finiteOrNull(value);
        if (number == null) return null;
        if (!allowNegative && number < 0) return null;
        if (Math.abs(number) > 7 * 24 * 60 * 60 * 1000) return null;
        return Math.round(number);
    }

    function integerOrNull(value) {
        const number = finiteOrNull(value);
        return number == null ? null : Math.trunc(number);
    }

    function clampDim(value) {
        const number = integerOrNull(value);
        if (number == null || number < 0 || number > 10000) return null;
        return number;
    }

    function codecOrNull(value) {
        if (typeof value !== "string") return null;
        const lower = value.toLowerCase();
        return CODEC_TOKENS.indexOf(lower) === -1 ? null : lower;
    }

    function findCodec(text) {
        const lower = String(text || "").toLowerCase();
        for (let i = 0; i < CODEC_TOKENS.length; i++) {
            const token = CODEC_TOKENS[i];
            const pattern = new RegExp("\\b" + token.replace("-", "\\-") + "\\b", "i");
            if (pattern.test(lower)) return token;
        }
        return null;
    }

    function enumString(value, allowed) {
        return typeof value === "string" && allowed.indexOf(value) !== -1 ? value : null;
    }

    function frameOrNull(value) {
        return value === "top" || value === "child" ? value : null;
    }

    function extensionIdOrNull(value) {
        return typeof value === "string" && /^[a-p]{32}$/.test(value) ? value : null;
    }

    const VIDEO_CODECS = ["avc", "avchigh", "hevc", "av1"];
    const ERROR_CODES = ["page-error", "page-rejection", "global-options-hook", "console-hook", "override-hook", "location-hook", "settings-load-failed", "storage-write-failed", "unclassified"];
    const STORAGE_PREFIX = "nflx1080pDiagnosticLog";
    const FLUSH_DELAY_MS = 250;
    const EXECUTION_GAP_MS = 15000;
    const SAMPLER_PHASES = ["start", "restart", "cancel", "complete", "gap"];
    const SAMPLER_REASONS = ["execution-gap", "clock-discontinuity"];
    const DATE_DISCONTINUITY_MS = 15000;
    const CHUNK_EVENT_LIMIT = SAMPLE_COUNT + 70;
    const MAX_STORED_CHUNKS = 16;

    function emptyProbe() {
        return {
            width: null,
            height: null,
            playingAudioBitrate: null,
            playingVideoBitrate: null,
            throughputKbps: null,
            codec: null,
            source: "none",
        };
    }

    function parseBitrateToken(token) {
        if (typeof token !== "string") return null;
        const text = token.trim();
        if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
        return finiteOrNull(Number(text));
    }

    function readStatsNodeText(node) {
        if (!node || typeof node !== "object") return "";
        if (node.tagName === "TEXTAREA" && typeof node.value === "string") return node.value;
        return typeof node.textContent === "string" ? node.textContent : "";
    }

    function probeStatsText(text) {
        const probe = emptyProbe();
        if (typeof text !== "string" || text.length === 0) return probe;
        const lines = text.slice(0, 100000).split(/\r?\n/);
        const limit = Math.min(lines.length, 400);
        for (let i = 0; i < limit; i++) {
            const line = lines[i];
            if (line.length === 0 || line.length > 500) continue;
            if (/https?:\/\//i.test(line) || /\/watch\/\d+/.test(line)) continue;
            const playing = line.match(/^Playing bitrate \(a\/v\):\s*([^/\n]+?)\s*\/\s*(\S+)(?:\s*\((\d{2,4})\s*[x\u00d7]\s*(\d{2,4})\))?\s*$/);
            if (playing) {
                probe.playingAudioBitrate = parseBitrateToken(playing[1]);
                probe.playingVideoBitrate = parseBitrateToken(playing[2]);
                if (playing[3] && playing[4]) {
                    probe.width = clampDim(Number(playing[3]));
                    probe.height = clampDim(Number(playing[4]));
                }
                continue;
            }
            const throughput = line.match(/^Throughput:\s*(\d+(?:\.\d+)?)\s*kbps\s*$/i);
            if (throughput) {
                probe.throughputKbps = finiteOrNull(Number(throughput[1]));
                continue;
            }
            const videoTrack = line.match(/^Video Track:\s*Codec:\s*.+\(([^)]+)\)\s*$/);
            if (videoTrack) {
                const primary = videoTrack[1].split(",")[0].trim().toLowerCase();
                probe.codec = VIDEO_CODECS.indexOf(primary) === -1 ? null : primary;
            }
        }
        const found = probe.playingAudioBitrate != null || probe.playingVideoBitrate != null || probe.throughputKbps != null || probe.codec != null || probe.width != null;
        probe.source = found ? "player-info" : "none";
        return probe;
    }

    function snapshotOptions(options) {
        const list = Array.isArray(options) ? options : [];
        const order = [];
        const selectedIndexes = [];
        const count = Math.min(list.length, 80);
        for (let i = 0; i < count; i++) {
            const item = list[i] || {};
            const value = redactText(item.value == null ? "" : String(item.value), 32);
            const captionSource = item.text == null ? item.caption : item.text;
            const caption = redactText(captionSource == null ? "" : String(captionSource), 80);
            const selected = item.selected === true;
            order.push({
                index: i,
                value: value,
                caption: caption,
                selected: selected,
            });
            if (selected) selectedIndexes.push(i);
        }
        const lastIndex = order.length ? order.length - 1 : -1;
        return {
            count: order.length,
            order: order,
            selectedIndexes: selectedIndexes,
            lastIndex: lastIndex,
            lastValue: lastIndex >= 0 ? order[lastIndex].value : null,
            selectedMatchesLast: selectedIndexes.length === 1 && selectedIndexes[0] === lastIndex,
        };
    }

    function originalLastOptionIndex(length) {
        const count = integerOrNull(length);
        if (count == null || count <= 0) return -1;
        return count - 1;
    }

    function menuLabel(text) {
        if (text === "Video Bitrate / VMAF") return "video";
        if (text === "Audio Bitrate") return "audio";
        if (text === "CDN") return "cdn";
        return "other";
    }

    function menuSignature(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.order)) return "";
        const parts = [];
        for (let i = 0; i < snapshot.order.length; i++) {
            const item = snapshot.order[i];
            parts.push(String(item.value) + (item.selected ? "*" : ""));
        }
        return parts.join("|");
    }

    function recordMenuIfChanged(tracker, signatures, label, snapshot, actor) {
        if (!snapshot || !snapshot.count) return [];
        const signature = menuSignature(snapshot);
        if (signatures[label] === signature) return [];
        signatures[label] = signature;
        tracker.noteOptions(label, snapshot, actor);
        return tracker.flush(label);
    }

    function menuActor(input) {
        const trusted = input && input.trusted === true;
        const hidden = input && input.hideStylePresent === true;
        if (trusted) return "manual";
        if (hidden) return "extension-hidden";
        if (input && input.trusted === false) return "script";
        return "unknown";
    }

    function srcKind(src) {
        if (typeof src !== "string" || src.length === 0) return "empty";
        if (src.indexOf("blob:") === 0) return "blob";
        if (src.indexOf("mediasource:") === 0) return "mediasource";
        return "other";
    }

    function describeGlobalOptionsAssignment(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return {
                type: "global-options",
                applied: false,
                settings: null,
                matchesUserReportedScreen: false,
                mismatchedKeys: SETTING_KEYS.slice(),
            };
        }
        const comparison = settingsMatchReport(value);
        return {
            type: "global-options",
            applied: true,
            settings: comparison.settings,
            matchesUserReportedScreen: comparison.matches,
            mismatchedKeys: comparison.mismatched,
        };
    }

    function describeSettingsDom(text) {
        let parsed = null;
        if (typeof text === "string") {
            try {
                parsed = JSON.parse(text);
            } catch (error) {
                parsed = null;
            }
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
                type: "settings-dom",
                applied: false,
                parseError: true,
                settings: null,
                matchesUserReportedScreen: false,
                mismatchedKeys: SETTING_KEYS.slice(),
            };
        }
        const comparison = settingsMatchReport(parsed);
        return {
            type: "settings-dom",
            applied: true,
            parseError: false,
            settings: comparison.settings,
            matchesUserReportedScreen: comparison.matches,
            mismatchedKeys: comparison.mismatched,
        };
    }

    function describeError(code) {
        return {
            type: "error",
            code: ERROR_CODES.indexOf(code) === -1 ? "unclassified" : code,
        };
    }

    function clearsAttribution(eventType) {
        return eventType === "video-replaced" || eventType === "title-switch" || eventType === "leave-watch" || eventType === "enter-watch";
    }

    function attributionForSample(selected, trace, playerGeneration) {
        const generation = integerOrNull(playerGeneration);
        function accept(value) {
            if (!value || typeof value !== "object") return null;
            if (integerOrNull(value.playerGeneration) !== generation) return null;
            return value;
        }
        return {
            selectedStream: accept(selected),
            playerTrace: accept(trace),
        };
    }

    function selectTrackedMeasurement(entries, trackedSerial) {
        const serial = integerOrNull(trackedSerial);
        const list = Array.isArray(entries) ? entries : [];
        let match = null;
        for (let i = 0; i < list.length; i++) {
            if (integerOrNull(list[i] && list[i].serial) === serial) match = list[i];
        }
        if (!match) {
            return {
                videoSerial: serial,
                width: null,
                height: null,
                playback: null,
                matched: false,
            };
        }
        return {
            videoSerial: serial,
            width: clampDim(match.width),
            height: clampDim(match.height),
            playback: {
                droppedVideoFrames: finiteOrNull(match.droppedVideoFrames),
                totalVideoFrames: finiteOrNull(match.totalVideoFrames),
                corruptedVideoFrames: finiteOrNull(match.corruptedVideoFrames),
            },
            matched: true,
        };
    }

    function documentFacts(doc, performanceObj) {
        let navigationType = null;
        try {
            const entries = performanceObj && performanceObj.getEntriesByType && performanceObj.getEntriesByType("navigation");
            const navigation = entries && entries[0];
            if (navigation && typeof navigation.type === "string") navigationType = navigation.type;
        } catch (error) {
            navigationType = null;
        }
        return {
            type: "document",
            wasDiscarded: Boolean(doc && doc.wasDiscarded),
            readyState: doc && doc.readyState || null,
            visibilityState: doc && doc.visibilityState || null,
            navigationType: navigationType,
        };
    }

    function classifyProfiles(marker, list) {
        const kind = marker === "Final profiles:" ? "final" : "netflix";
        if (!Array.isArray(list) || list.length > 80) {
            return { type: "profile", marker: kind, profiles: null, invalid: true };
        }
        const profiles = [];
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (typeof item !== "string" || !/^[a-z0-9.+_-]{1,80}$/i.test(item)) {
                return { type: "profile", marker: kind, profiles: null, invalid: true };
            }
            profiles.push(item);
        }
        return { type: "profile", marker: kind, profiles: profiles, invalid: false };
    }

    function classifyBitrateTrace(message) {
        if (typeof message !== "string" || message.length === 0 || message.length > 500) return null;
        if (/https?:\/\//i.test(message) || /\/watch\/\d+/.test(message) || /token=/i.test(message)) return null;
        const video = message.match(/\bvideo\s+(\d+(?:\.\d+)?)kbps/i);
        const audio = message.match(/\baudio:\s*(\d+(?:\.\d+)?)kbps/i);
        const generic = message.match(/\bbitrate:\s*(\d+(?:\.\d+)?)\s*kbps/i);
        if (!video && !audio && !generic) return null;
        return {
            type: "playback-trace",
            videoBitrateKbps: video ? Number(video[1]) : (generic ? Number(generic[1]) : null),
            audioBitrateKbps: audio ? Number(audio[1]) : null,
            codec: findCodec(message),
        };
    }

    function classifyConsole(args) {
        if (!args || !args.length || typeof args[0] !== "string") return null;
        const first = args[0];
        if (first.indexOf("kbps") !== -1 || first.indexOf("bitrate") !== -1) {
            const trace = classifyBitrateTrace(first);
            if (trace) return trace;
        }
        if (first.indexOf("Netflix profiles:") === 0) return classifyProfiles("Netflix profiles:", args[1]);
        if (first.indexOf("Final profiles:") === 0) return classifyProfiles("Final profiles:", args[1]);
        if (first.indexOf("Could not load settings:") === 0) {
            return { type: "settings-error", code: "settings-load-failed" };
        }
        if (first.indexOf("Loaded settings") === 0) return describeGlobalOptionsAssignment(args[1]);
        for (let i = 0; i < PLAYER_LOG_MARKERS.length; i++) {
            if (first.indexOf(PLAYER_LOG_MARKERS[i]) === 0) {
                return { type: "player-log", marker: PLAYER_LOG_MARKERS[i] };
            }
        }
        return null;
    }

    function buildSample(input) {
        const data = input || {};
        const rendered = data.rendered || {};
        const probe = data.renderedProbe || emptyProbe();
        const playback = data.playback || {};
        const dom = data.dom || {};
        return {
            type: "sample",
            wasDiscarded: data.wasDiscarded === true,
            index: integerOrNull(data.index),
            rendered: {
                width: clampDim(rendered.width),
                height: clampDim(rendered.height),
            },
            renderedProbe: {
                width: clampDim(probe.width),
                height: clampDim(probe.height),
                playingAudioBitrate: finiteOrNull(probe.playingAudioBitrate),
                playingVideoBitrate: finiteOrNull(probe.playingVideoBitrate),
                throughputKbps: finiteOrNull(probe.throughputKbps),
                codec: enumString(probe.codec, VIDEO_CODECS),
                source: probe.source === "player-info" ? "player-info" : "none",
            },
            selectedStream: data.selectedStream || null,
            playerTrace: data.playerTrace || null,
            playback: {
                droppedVideoFrames: finiteOrNull(playback.droppedVideoFrames),
                totalVideoFrames: finiteOrNull(playback.totalVideoFrames),
                corruptedVideoFrames: finiteOrNull(playback.corruptedVideoFrames),
            },
            dom: {
                hideStylePresent: data.dom ? data.dom.hideStylePresent === true : false,
                menuPresent: dom.menuPresent === true,
                videoCount: integerOrNull(dom.videoCount) || 0,
            },
            playerGeneration: integerOrNull(data.playerGeneration),
            videoSerial: integerOrNull(data.videoSerial),
        };
    }

    function sanitizeSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.order)) return null;
        return snapshotOptions(snapshot.order.map(function (item) {
            return {
                value: item && item.value,
                text: item && item.caption,
                selected: item && item.selected === true,
            };
        }));
    }

    function sanitizeSelected(value) {
        if (!value || typeof value !== "object") return null;
        const video = value.video ? sanitizeSnapshot(value.video) : null;
        const audio = value.audio ? sanitizeSnapshot(value.audio) : null;
        if (!video && !audio) return null;
        return {
            video: video,
            audio: audio,
            actor: enumString(value.actor, MENU_ACTORS) || "unknown",
        };
    }

    function sanitizeTrace(value) {
        if (!value || typeof value !== "object") return null;
        const videoBitrateKbps = finiteOrNull(value.videoBitrateKbps);
        const audioBitrateKbps = finiteOrNull(value.audioBitrateKbps);
        if (videoBitrateKbps == null && audioBitrateKbps == null) return null;
        return {
            videoBitrateKbps: videoBitrateKbps,
            audioBitrateKbps: audioBitrateKbps,
            codec: codecOrNull(value.codec),
            at: integerOrNull(value.at),
        };
    }

    function baseEvent(event) {
        return {
            type: event.type,
            seq: integerOrNull(event.seq),
            at: integerOrNull(event.at),
            perf: integerOrNull(event.perf),
            frame: frameOrNull(event.frame),
        };
    }

    function sanitizeEvent(event) {
        if (!event || typeof event !== "object" || !EVENT_TYPES.has(event.type)) return null;
        const base = baseEvent(event);
        switch (event.type) {
            case "document":
                return Object.assign(base, {
                    wasDiscarded: event.wasDiscarded === true,
                    readyState: enumString(event.readyState, ["loading", "interactive", "complete"]),
                    visibilityState: enumString(event.visibilityState, ["visible", "hidden", "prerender"]),
                    navigationType: enumString(event.navigationType, ["navigate", "reload", "back_forward", "prerender"]),
                });
            case "global-options":
            case "settings-dom": {
                const applied = event.applied === true && event.settings && typeof event.settings === "object";
                const comparison = applied ? settingsMatchReport(event.settings) : null;
                return Object.assign(base, {
                    applied: Boolean(applied),
                    parseError: event.parseError === true,
                    settings: comparison ? comparison.settings : null,
                    matchesUserReportedScreen: comparison ? comparison.matches : false,
                    mismatchedKeys: comparison ? comparison.mismatched : SETTING_KEYS.slice(),
                });
            }
            case "settings-error":
                return Object.assign(base, {
                    code: event.code === "settings-load-failed" ? "settings-load-failed" : "unclassified",
                });
            case "error":
                return Object.assign(base, {
                    code: enumString(event.code, ERROR_CODES) || "unclassified",
                });
            case "profile": {
                let profiles = null;
                let invalid = true;
                if (event.invalid === false && Array.isArray(event.profiles)) {
                    const classified = classifyProfiles(event.marker === "final" ? "Final profiles:" : "Netflix profiles:", event.profiles);
                    profiles = classified.profiles;
                    invalid = classified.invalid;
                }
                return Object.assign(base, {
                    marker: event.marker === "final" ? "final" : "netflix",
                    profiles: profiles,
                    invalid: invalid,
                });
            }
            case "player-log":
                return Object.assign(base, {
                    marker: enumString(event.marker, PLAYER_LOG_MARKERS),
                });
            case "playback-trace": {
                const trace = sanitizeTrace(event);
                if (!trace) return null;
                return Object.assign(base, trace);
            }
            case "menu": {
                const phase = enumString(event.phase, MENU_PHASES);
                if (!phase) return null;
                const snapshot = event.snapshot ? sanitizeSnapshot(event.snapshot) : null;
                if (phase !== "after-override-click" && !snapshot) return null;
                return Object.assign(base, {
                    phase: phase,
                    actor: enumString(event.actor, MENU_ACTORS) || "unknown",
                    label: enumString(event.label, MENU_LABELS) || "other",
                    snapshot: snapshot,
                    menuPresent: event.menuPresent === true,
                });
            }
            case "sample": {
                const sample = buildSample(event);
                sample.seq = base.seq;
                sample.at = base.at;
                sample.perf = base.perf;
                sample.frame = base.frame;
                sample.selectedStream = sanitizeSelected(event.selectedStream);
                sample.playerTrace = sanitizeTrace(event.playerTrace);
                return sample;
            }
            case "player":
                return Object.assign(base, {
                    playerGeneration: integerOrNull(event.playerGeneration),
                    replaced: event.replaced === true,
                    videoSerial: integerOrNull(event.videoSerial),
                    srcKind: enumString(event.srcKind, ["empty", "blob", "mediasource", "other"]),
                });
            case "location":
                return Object.assign(base, {
                    isWatch: event.isWatch === true,
                    entered: event.entered === true,
                    left: event.left === true,
                    switchedTitle: event.switchedTitle === true,
                });
            case "extension-style":
                return Object.assign(base, { present: event.present === true });
            case "sampler":
                return Object.assign(base, {
                    phase: enumString(event.phase, SAMPLER_PHASES),
                    generation: integerOrNull(event.generation),
                    wasDiscarded: event.wasDiscarded === true,
                    intervalMs: integerOrNull(event.intervalMs),
                    maxSamples: integerOrNull(event.maxSamples),
                    reason: enumString(event.reason, SAMPLER_REASONS),
                    perfGapMs: boundedGap(event.perfGapMs, false),
                    dateGapMs: boundedGap(event.dateGapMs, true),
                });
            default:
                return null;
        }
    }

    function reportedScreen() {
        return {
            source: USER_REPORTED_OPTIONS_SCREEN.source,
            storageRead: false,
            values: pickSettings(USER_REPORTED_OPTIONS_SCREEN.values),
            note: USER_REPORTED_OPTIONS_SCREEN.note,
        };
    }

    function mergeExport(existing, batch, meta) {
        const prior = existing && Array.isArray(existing.events) ? existing.events : [];
        const incoming = Array.isArray(batch) ? batch : [];
        const events = [];
        let dropped = existing && Number.isInteger(existing.dropped) && existing.dropped > 0 ? existing.dropped : 0;
        const combined = prior.concat(incoming);
        for (let i = 0; i < combined.length; i++) {
            const clean = sanitizeEvent(combined[i]);
            if (clean) events.push(clean);
        }
        while (events.length > MAX_EVENTS) {
            events.shift();
            dropped += 1;
        }
        const info = meta || {};
        const existingId = existing && existing.extensionId;
        return {
            schema: SCHEMA,
            extensionVersion: "1.34.0",
            diagnostic: true,
            fixesApplied: false,
            storageReadFromOriginalExtension: false,
            extensionId: extensionIdOrNull(info.extensionId) || extensionIdOrNull(existingId),
            userReportedOptionsScreen: reportedScreen(),
            dropped: dropped,
            events: events,
        };
    }

    function emptyExport(meta) {
        return mergeExport(null, [], meta || {});
    }

    function parseDiagnosticStorageKey(key) {
        if (typeof key !== "string") return null;
        const current = key.match(/^nflx1080pDiagnosticLog\.(\d+)\.([0-9a-f]{16})\.(\d+)$/);
        if (current) {
            return {
                key: key,
                startedAt: Number(current[1]),
                sessionId: current[2],
                chunk: Number(current[3]),
                legacy: false,
            };
        }
        const legacy = key.match(/^nflx1080pDiagnosticLog\.([0-9a-f]{16})\.(\d+)$/);
        if (legacy) {
            return {
                key: key,
                startedAt: null,
                sessionId: legacy[1],
                chunk: Number(legacy[2]),
                legacy: true,
            };
        }
        if (key === STORAGE_PREFIX) {
            return { key: key, startedAt: null, sessionId: "", chunk: 0, legacy: true };
        }
        return null;
    }

    function diagnosticChunkKey(startedAt, sessionId, chunk) {
        const time = integerOrNull(startedAt);
        const part = integerOrNull(chunk);
        if (time == null || time < 0 || part == null || part < 1) return null;
        if (typeof sessionId !== "string" || !/^[0-9a-f]{16}$/.test(sessionId)) return null;
        return STORAGE_PREFIX + "." + String(time).padStart(16, "0") + "." + sessionId + "." + String(part).padStart(4, "0");
    }

    function chunkSortTime(record) {
        if (record.startedAt != null) return record.startedAt;
        const events = Array.isArray(record.events) ? record.events : [];
        let earliest = null;
        for (let i = 0; i < events.length; i++) {
            const at = integerOrNull(events[i] && events[i].at);
            if (at == null) continue;
            if (earliest == null || at < earliest) earliest = at;
        }
        return earliest == null ? 0 : earliest;
    }

    function compareDiagnosticChunks(a, b) {
        const aTime = chunkSortTime(a);
        const bTime = chunkSortTime(b);
        if (aTime !== bTime) return aTime - bTime;
        if (a.sessionId < b.sessionId) return -1;
        if (a.sessionId > b.sessionId) return 1;
        return a.chunk - b.chunk;
    }

    function listDiagnosticChunks(stored) {
        const records = [];
        if (!stored || typeof stored !== "object") return records;
        const keys = Object.keys(stored);
        for (let i = 0; i < keys.length; i++) {
            const parsed = parseDiagnosticStorageKey(keys[i]);
            if (!parsed) continue;
            const value = stored[keys[i]];
            parsed.events = value && value.events;
            records.push(parsed);
        }
        records.sort(compareDiagnosticChunks);
        return records;
    }

    function planDiagnosticRetention(stored, maxChunks) {
        const limit = integerOrNull(maxChunks);
        const cap = limit == null ? MAX_STORED_CHUNKS : limit;
        const records = listDiagnosticChunks(stored);
        if (records.length <= cap) {
            return {
                keepKeys: records.map(function (record) { return record.key; }),
                removeKeys: [],
            };
        }
        return {
            keepKeys: records.slice(records.length - cap).map(function (record) { return record.key; }),
            removeKeys: records.slice(0, records.length - cap).map(function (record) { return record.key; }),
        };
    }

    function mergeDiagnosticStorage(stored, meta, limits) {
        const records = listDiagnosticChunks(stored);
        const maxEvents = limits && integerOrNull(limits.maxEvents) != null ? limits.maxEvents : MAX_EVENTS;
        const events = [];
        for (let i = 0; i < records.length; i++) {
            const batch = Array.isArray(records[i].events) ? records[i].events : [];
            for (let j = 0; j < batch.length; j++) events.push(batch[j]);
        }
        const merged = mergeExport(null, events, meta || {});
        while (merged.events.length > maxEvents) {
            merged.events.shift();
            merged.dropped += 1;
        }
        merged.retention = {
            maxEvents: maxEvents,
            maxChunks: MAX_STORED_CHUNKS,
            chunkCount: records.length,
            order: "startedAt-or-event-time,sessionId,chunk",
            droppedOldest: merged.dropped,
        };
        return merged;
    }

    function createPersistController(options) {
        const opts = options || {};
        const limit = integerOrNull(opts.chunkEventLimit) || CHUNK_EVENT_LIMIT;
        let buffer = [];
        let open = [];
        let openIndex = 1;
        let writing = null;
        return {
            enqueue: function (events) {
                const list = Array.isArray(events) ? events : [];
                for (let i = 0; i < list.length; i++) buffer.push(list[i]);
            },
            beginWrite: function () {
                if (writing || !buffer.length) return null;
                if (open.length >= limit) {
                    open = [];
                    openIndex += 1;
                }
                const room = limit - open.length;
                const take = buffer.slice(0, room);
                writing = { take: take, index: openIndex, base: open.slice() };
                return {
                    chunk: openIndex,
                    key: diagnosticChunkKey(opts.startedAt, opts.sessionId, openIndex),
                    events: writing.base.concat(take),
                };
            },
            finishWrite: function (ok) {
                if (!writing) {
                    return { pending: buffer.length, chunk: open.length ? openIndex : 0, failed: false, code: null };
                }
                if (!ok) {
                    writing = null;
                    return { pending: buffer.length, chunk: open.length ? openIndex : 0, failed: true, code: "storage-write-failed" };
                }
                open = writing.base.concat(writing.take);
                buffer = buffer.slice(writing.take.length);
                const written = writing.index;
                writing = null;
                if (open.length >= limit) {
                    open = [];
                    openIndex += 1;
                }
                return { pending: buffer.length, chunk: written, failed: false, code: null };
            },
            pending: function () { return buffer.length; },
        };
    }

    function createLocationTracker() {
        let watchKey = "";
        let watching = false;
        return {
            update: function (href) {
                const text = typeof href === "string" ? href : "";
                const match = text.match(/netflix\.com\/watch\/(\d+)/i);
                const nextKey = match ? match[1] : "";
                const isWatch = nextKey !== "";
                let kind = "unchanged";
                if (isWatch && nextKey !== watchKey) kind = watching ? "title-switch" : "enter-watch";
                else if (!isWatch && watching) kind = "leave-watch";
                watchKey = nextKey;
                watching = isWatch;
                return {
                    kind: kind,
                    publicEvent: {
                        type: "location",
                        isWatch: isWatch,
                        entered: kind === "enter-watch",
                        left: kind === "leave-watch",
                        switchedTitle: kind === "title-switch",
                    },
                };
            },
            watching: function () { return watching; },
        };
    }

    function decideSamplerAction(state, eventType) {
        const running = Boolean(state && state.running);
        switch (eventType) {
            case "enter-watch":
                return running ? "continue" : "start";
            case "title-switch":
                return "restart";
            case "leave-watch":
            case "dispose":
                return running ? "cancel" : "ignore";
            case "video-added":
                return running ? "continue" : "start";
            case "video-replaced":
                return running ? "continue" : "ignore";
            case "execution-gap":
            case "clock-discontinuity":
                return running ? "restart" : "start";
            default:
                return "ignore";
        }
    }

    function classifyPollGap(input) {
        const perfGapMs = finiteOrNull(input && input.perfGapMs);
        const dateGapMs = finiteOrNull(input && input.dateGapMs);
        if (perfGapMs != null && perfGapMs >= EXECUTION_GAP_MS) return "execution-gap";
        if (dateGapMs != null && dateGapMs >= DATE_DISCONTINUITY_MS) return "clock-discontinuity";
        return null;
    }

    function createCapturePolicy() {
        let suppressUntilOrdinary = false;
        return {
            reset: function () {
                suppressUntilOrdinary = false;
            },
            observe: function (input) {
                const kind = classifyPollGap(input);
                if (!kind) {
                    suppressUntilOrdinary = false;
                    return { action: "ignore", kind: null, coalesced: false };
                }
                if (suppressUntilOrdinary) {
                    return { action: "ignore", kind: kind, coalesced: true };
                }
                suppressUntilOrdinary = true;
                const running = Boolean(input && input.running);
                return {
                    action: running ? "restart" : "start",
                    kind: kind,
                    coalesced: false,
                };
            },
        };
    }

    function createSampler(deps) {
        if (!deps || typeof deps.schedule !== "function" || typeof deps.clear !== "function" || typeof deps.now !== "function" || typeof deps.onSample !== "function") {
            throw new Error("sampler deps missing");
        }
        const intervalMs = deps.intervalMs || SAMPLE_INTERVAL_MS;
        const maxSamples = deps.maxSamples || SAMPLE_COUNT;
        let generation = 0;
        let timer = null;
        let active = null;

        function clearTimer() {
            if (timer != null) {
                deps.clear(timer);
                timer = null;
            }
        }

        function cancel(reason) {
            generation += 1;
            clearTimer();
            const had = active != null;
            active = null;
            return { cancelled: had, reason: reason || "cancel" };
        }

        function start(meta) {
            cancel("restart");
            generation += 1;
            const gen = generation;
            active = {
                generation: gen,
                meta: meta || {},
                count: 0,
                startedAt: deps.now(),
            };
            const tick = function () {
                timer = null;
                if (gen !== generation || !active) return;
                if (active.count >= maxSamples) return;
                active.count += 1;
                deps.onSample({
                    generation: gen,
                    index: active.count,
                    meta: active.meta,
                });
                if (gen !== generation || !active) return;
                if (active.count >= maxSamples) {
                    const meta = active.meta;
                    if (gen === generation && active && active.generation === gen) {
                        active = null;
                        timer = null;
                    }
                    if (deps.onComplete) deps.onComplete({ generation: gen, meta: meta });
                    return;
                }
                timer = deps.schedule(tick, intervalMs);
            };
            timer = deps.schedule(tick, intervalMs);
            return { generation: gen };
        }

        return {
            start: start,
            cancel: cancel,
            isActive: function () { return active != null; },
            generation: function () { return generation; },
        };
    }

    function createPlayerTracker() {
        let generation = 0;
        let currentKey = null;
        return {
            currentKey: function () { return currentKey; },
            note: function (key, at) {
                const serial = integerOrNull(key);
                if (serial == null || serial === currentKey) return null;
                const replaced = currentKey != null;
                currentKey = serial;
                generation += 1;
                return {
                    type: "player",
                    at: integerOrNull(at),
                    playerGeneration: generation,
                    replaced: replaced,
                    videoSerial: serial,
                };
            },
        };
    }

    function createMenuTracker() {
        const slots = new Map();

        function slot(id) {
            if (!slots.has(id)) {
                slots.set(id, {
                    built: null,
                    published: false,
                    burst: false,
                    handled: false,
                    actor: "unknown",
                });
            }
            return slots.get(id);
        }

        function entry(id, phase, actor, snapshot, menuPresent) {
            return {
                type: "menu",
                phase: phase,
                actor: actor,
                label: id,
                snapshot: snapshot,
                menuPresent: menuPresent,
            };
        }

        return {
            noteOptions: function (id, snapshot, actor) {
                const state = slot(id);
                state.built = snapshot;
                state.actor = actor || state.actor;
                state.burst = true;
                state.handled = false;
                return { needsFlush: true };
            },
            flush: function (id) {
                const state = slot(id);
                if (!state.burst || state.handled || !state.built) {
                    state.burst = false;
                    state.handled = false;
                    return [];
                }
                state.burst = false;
                const phase = state.published ? "menu-updated" : "menu-built";
                state.published = true;
                return [entry(id, phase, state.actor, state.built, true)];
            },
            flushAll: function () {
                const events = [];
                const ids = Array.from(slots.keys());
                for (let i = 0; i < ids.length; i++) {
                    const flushed = this.flush(ids[i]);
                    for (let j = 0; j < flushed.length; j++) events.push(flushed[j]);
                }
                return events;
            },
            noteOverrideBefore: function (id, liveSnapshot, actor) {
                const state = slot(id);
                const events = [];
                if (state.built && !state.published) {
                    events.push(entry(id, "menu-built", state.actor, state.built, true));
                    state.published = true;
                } else if (!state.published && liveSnapshot) {
                    events.push(entry(id, "menu-built", actor, liveSnapshot, true));
                    state.built = liveSnapshot;
                    state.published = true;
                }
                state.handled = true;
                state.burst = true;
                events.push(entry(id, "before-override-click", actor, liveSnapshot, true));
                return events;
            },
            noteOverrideAfter: function (id, actor, menuPresent) {
                return [entry(id, "after-override-click", actor, null, menuPresent === true)];
            },
        };
    }

    return {
        SCHEMA: SCHEMA,
        MESSAGE_SOURCE: MESSAGE_SOURCE,
        SAMPLE_INTERVAL_MS: SAMPLE_INTERVAL_MS,
        SAMPLE_COUNT: SAMPLE_COUNT,
        MAX_EVENTS: MAX_EVENTS,
        MAX_STORED_CHUNKS: MAX_STORED_CHUNKS,
        FLUSH_DELAY_MS: FLUSH_DELAY_MS,
        EXECUTION_GAP_MS: EXECUTION_GAP_MS,
        DATE_DISCONTINUITY_MS: DATE_DISCONTINUITY_MS,
        CHUNK_EVENT_LIMIT: CHUNK_EVENT_LIMIT,
        ERROR_CODES: ERROR_CODES,
        STORE_EXTENSION_ID: STORE_EXTENSION_ID,
        DIAGNOSTIC_EXTENSION_ID: DIAGNOSTIC_EXTENSION_ID,
        SETTING_KEYS: SETTING_KEYS,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        USER_REPORTED_OPTIONS_SCREEN: USER_REPORTED_OPTIONS_SCREEN,
        pickSettings: pickSettings,
        settingsForNewInstall: settingsForNewInstall,
        settingsMatchReport: settingsMatchReport,
        originalAutomaticLoopExpected: originalAutomaticLoopExpected,
        redactText: redactText,
        readStatsNodeText: readStatsNodeText,
        probeStatsText: probeStatsText,
        snapshotOptions: snapshotOptions,
        originalLastOptionIndex: originalLastOptionIndex,
        menuLabel: menuLabel,
        menuSignature: menuSignature,
        recordMenuIfChanged: recordMenuIfChanged,
        menuActor: menuActor,
        srcKind: srcKind,
        describeGlobalOptionsAssignment: describeGlobalOptionsAssignment,
        describeSettingsDom: describeSettingsDom,
        describeError: describeError,
        clearsAttribution: clearsAttribution,
        attributionForSample: attributionForSample,
        selectTrackedMeasurement: selectTrackedMeasurement,
        documentFacts: documentFacts,
        classifyConsole: classifyConsole,
        buildSample: buildSample,
        sanitizeEvent: sanitizeEvent,
        mergeExport: mergeExport,
        emptyExport: emptyExport,
        diagnosticChunkKey: diagnosticChunkKey,
        planDiagnosticRetention: planDiagnosticRetention,
        mergeDiagnosticStorage: mergeDiagnosticStorage,
        createPersistController: createPersistController,
        createLocationTracker: createLocationTracker,
        decideSamplerAction: decideSamplerAction,
        classifyPollGap: classifyPollGap,
        createCapturePolicy: createCapturePolicy,
        createSampler: createSampler,
        createPlayerTracker: createPlayerTracker,
        createMenuTracker: createMenuTracker,
    };
});
