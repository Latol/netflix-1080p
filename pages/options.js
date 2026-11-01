const use6ChannelsCheckbox = document.getElementById("use-51");
const setMaxBitrateCheckbox = document.getElementById("set-max-bitrate");
const disableVP9Checkbox = document.getElementById("disable-vp9");
const disableAVChighCheckbox = document.getElementById("disable-avchigh");
const disableAV1Checkbox = document.getElementById("disable-av1");
const showAllSubsCheckbox = document.getElementById("show-all-subs");

const optionsSavedLabel = document.getElementById("options-saved");

function saveOptions() {
	const use6Channels = use6ChannelsCheckbox.checked;
	const setMaxBitrate = setMaxBitrateCheckbox.checked;
	const disableVP9 = disableVP9Checkbox.checked;
	const disableAVChigh = disableAVChighCheckbox.checked;
	const showAllSubs = showAllSubsCheckbox.checked;
	const disableAV1 = disableAV1Checkbox.checked;

	chrome.storage.sync.set({
		use6Channels,
		setMaxBitrate,
		disableVP9,
		disableAVChigh,
		showAllSubs,
		disableAV1,
	}, function() {
		optionsSavedLabel.style.display = "inline-block";
		renderDiagnosticStatus({
			use6Channels,
			setMaxBitrate,
			disableVP9,
			disableAVChigh,
			showAllSubs,
			disableAV1,
		});
	});
}

function restoreOptions() {
	chrome.storage.sync.get({
		use6Channels: true,
		setMaxBitrate: true,
		disableVP9: false,
		disableAVChigh: false,
		showAllSubs: false,
		disableAV1: false,
	}, function(items) {
		use6ChannelsCheckbox.checked = items.use6Channels;
		setMaxBitrateCheckbox.checked = items.setMaxBitrate;
		disableVP9Checkbox.checked = items.disableVP9;
		disableAVChighCheckbox.checked = items.disableAVChigh;
		showAllSubsCheckbox.checked = items.showAllSubs;
		disableAV1Checkbox.checked = items.disableAV1;
		renderDiagnosticStatus(items);
	});
}

document.getElementById("save").addEventListener("click", saveOptions);

document.querySelectorAll("input[type=checkbox]").forEach(checkbox => {
	checkbox.addEventListener("change", () => optionsSavedLabel.style.display = "none");
});

const DIAGNOSTIC_LOG_KEY = "nflx1080pDiagnosticLog";

function renderDiagnosticStatus(items) {
	const core = globalThis.Netflix1080pDiagCore;
	const status = document.getElementById("diagnostic-status");
	if (!core || !status) return;
	const comparison = core.settingsMatchReport(items);
	if (comparison.matches) {
		status.textContent = "この診断版に保存されている6項目は、ユーザー提供画面のチェック状態と一致しています。一致は画面観測との比較であり、元拡張の storage を読んだ結果ではありません。";
		return;
	}
	status.textContent = "この診断版の保存値は、ユーザー提供画面と一致していません（" + comparison.mismatched.join(", ") + "）。値は自動では変えません。上のチェックを画面に合わせて Save してください。";
}

function renderDiagnosticIdentity() {
	const core = globalThis.Netflix1080pDiagCore;
	const idNode = document.getElementById("diagnostic-id");
	const storeNode = document.getElementById("store-id");
	if (!core || !idNode || !storeNode) return;
	idNode.textContent = chrome.runtime.id;
	storeNode.textContent = core.STORE_EXTENSION_ID;
}

function diagnosticStorageKeys(stored) {
	return Object.keys(stored).filter(function(key) {
		return key === DIAGNOSTIC_LOG_KEY || key.indexOf(DIAGNOSTIC_LOG_KEY + ".") === 0;
	}).sort();
}

function downloadDiagnosticLog() {
	const core = globalThis.Netflix1080pDiagCore;
	const status = document.getElementById("log-status");
	chrome.storage.local.get(null, function(stored) {
		const keys = diagnosticStorageKeys(stored || {});
		let payload = null;
		keys.forEach(function(key) {
			const part = stored[key];
			payload = core.mergeExport(payload, part && part.events, {
				extensionId: chrome.runtime.id,
			});
		});
		if (!payload) {
			payload = core.emptyExport({ extensionId: chrome.runtime.id });
		}
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "netflix-1080p-diagnostic.json";
		link.click();
		URL.revokeObjectURL(url);
		if (status) status.textContent = "書き出しました。視聴IDやURLが含まれていないことを確認してから共有してください。";
	});
}

function clearDiagnosticLog() {
	const status = document.getElementById("log-status");
	chrome.storage.local.get(null, function(stored) {
		const keys = diagnosticStorageKeys(stored || {});
		chrome.storage.local.remove(keys, function() {
			if (status) status.textContent = "この診断版のローカルログを消去しました。";
		});
	});
}

document.getElementById("download-log").addEventListener("click", downloadDiagnosticLog);
document.getElementById("clear-log").addEventListener("click", clearDiagnosticLog);
renderDiagnosticIdentity();
restoreOptions();