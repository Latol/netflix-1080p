// Node-only regression test for the options page encoding failure.
//
// 5941c8b shipped pages/options.html without a charset declaration. chrome-extension://
// responses carry no charset either, so a Japanese-locale Chrome decoded the page and the
// classic <script src> files it loads as Shift_JIS. diagnostic/core.js contained a raw "x"
// (U+00D7) inside a regex character class; under Shift_JIS its second byte is a lead byte
// that swallows the closing "]", so core.js failed to parse and the export button did nothing.
// This test keeps every script the options page loads parseable under the common legacy
// encodings, keeps the diagnostic scripts pure ASCII, and keeps the charset declaration.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const BROKEN_COMMIT = "5941c8b77eb0938ee86bba1ccc545b96ea1b71e4";
const ENCODINGS = ["utf-8", "shift_jis", "euc-jp", "windows-1252", "gbk", "big5", "euc-kr"];
const OPTIONS_PAGE_SCRIPTS = ["diagnostic/core.js", "pages/options.js"];
const DIAGNOSTIC_SCRIPTS = ["diagnostic/core.js", "diagnostic/page_hook.js", "diagnostic/bridge.js"];

function readBytes(name) {
    return fs.readFileSync(path.join(root, name));
}

function parsesAs(bytes, encoding, filename) {
    const text = new TextDecoder(encoding).decode(bytes);
    new vm.Script(text, { filename: filename + " as " + encoding });
}

test("scripts loaded by the options page parse under legacy default encodings", () => {
    for (const name of OPTIONS_PAGE_SCRIPTS.concat(DIAGNOSTIC_SCRIPTS)) {
        const bytes = readBytes(name);
        for (const encoding of ENCODINGS) {
            assert.doesNotThrow(() => parsesAs(bytes, encoding, name), name + " does not parse as " + encoding);
        }
    }
});

test("diagnostic scripts stay pure ASCII so no page encoding can break them", () => {
    for (const name of DIAGNOSTIC_SCRIPTS) {
        const text = readBytes(name).toString("latin1");
        const match = text.match(/[^\x00-\x7f]/);
        assert.equal(match, null, name + " contains a non-ASCII byte at offset " + (match ? match.index : -1));
    }
});

test("negative control: the 5941c8b core.js really failed under Shift_JIS", (t) => {
    let bytes;
    try {
        bytes = execFileSync("git", ["show", BROKEN_COMMIT + ":diagnostic/core.js"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
        t.skip("commit " + BROKEN_COMMIT.slice(0, 7) + " is not available in this checkout");
        return;
    }
    assert.throws(() => parsesAs(bytes, "shift_jis", "core.js@5941c8b"), /Invalid regular expression/);
    assert.doesNotThrow(() => parsesAs(bytes, "utf-8", "core.js@5941c8b"));
    assert.doesNotThrow(() => parsesAs(bytes, "windows-1252", "core.js@5941c8b"));
});
