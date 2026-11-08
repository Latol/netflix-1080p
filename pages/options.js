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

const LOG_FAIL = Object.freeze({
	coreMissing: "core-missing",
	storageRead: "storage-read-failed",
	build: "export-build-failed",
	download: "download-failed",
	storageRemove: "storage-remove-failed",
});

function setLogStatus(text) {
	const status = document.getElementById("log-status");
	if (status) status.textContent = text;
}

// Fixed codes only. Exception text is never shown: it could carry page data, and on a
// mis-decoded page it would be unreadable anyway.
function failText(action, code) {
	return action + "に失敗しました（code: " + code + "）。拡張を再読み込みしてもう一度試してください。保存済みのログは消していません。";
}

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
	if (idNode) idNode.textContent = chrome.runtime.id;
	if (!core) {
		// core.js did not load. Say so on screen instead of leaving the buttons silently dead.
		setLogStatus(failText("診断機能の読み込み", LOG_FAIL.coreMissing));
		return;
	}
	if (storeNode) storeNode.textContent = core.STORE_EXTENSION_ID;
}

function downloadDiagnosticLog() {
	const core = globalThis.Netflix1080pDiagCore;
	if (!core) {
		setLogStatus(failText("書き出し", LOG_FAIL.coreMissing));
		return;
	}
	chrome.storage.local.get(null, function(stored) {
		if (chrome.runtime.lastError) {
			setLogStatus(failText("書き出し", LOG_FAIL.storageRead));
			return;
		}
		let payload;
		let text;
		try {
			payload = core.mergeDiagnosticStorage(stored || {}, {
				extensionId: chrome.runtime.id,
			});
			text = JSON.stringify(payload, null, 2);
		} catch (ignored) {
			setLogStatus(failText("書き出し", LOG_FAIL.build));
			return;
		}
		let blob;
		try {
			blob = new Blob([text], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "netflix-1080p-diagnostic.json";
			link.style.display = "none";
			document.body.appendChild(link);
			link.click();
			link.remove();
			// Revoke later: the download has already taken its reference, but do not race it.
			setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
		} catch (ignored) {
			setLogStatus(failText("書き出し", LOG_FAIL.download));
			return;
		}
		const eventCount = payload.events.length;
		const chunkCount = payload.retention ? payload.retention.chunkCount : 0;
		const dropped = payload.retention && payload.retention.droppedOldest;
		let message = "書き出しました: イベント " + eventCount + " 件 / チャンク " + chunkCount + " 個 / 約 " + Math.ceil(blob.size / 1024) + " KB。";
		if (eventCount === 0) {
			message += "記録は 0 件です。この診断版を有効にしたまま Netflix の再生ページを開いて再生してから、もう一度書き出してください。";
		}
		if (dropped) {
			message += "上限を超えた古い記録 " + dropped + " 件は落としています。";
		}
		message += "視聴IDやURLが含まれていないことを確認してから共有してください。";
		setLogStatus(message);
	});
}

function clearDiagnosticLog() {
	const core = globalThis.Netflix1080pDiagCore;
	if (!core) {
		setLogStatus(failText("消去", LOG_FAIL.coreMissing));
		return;
	}
	if (!window.confirm("この診断版のローカルログを消去します。書き出していないログは戻せません。消去しますか？")) {
		return;
	}
	chrome.storage.local.get(null, function(stored) {
		if (chrome.runtime.lastError) {
			setLogStatus(failText("消去", LOG_FAIL.storageRead));
			return;
		}
		const plan = core.planDiagnosticRetention(stored || {}, 0);
		const keys = plan.keepKeys.concat(plan.removeKeys);
		chrome.storage.local.remove(keys, function() {
			if (chrome.runtime.lastError) {
				setLogStatus(failText("消去", LOG_FAIL.storageRemove));
				return;
			}
			setLogStatus("この診断版のローカルログを消去しました（" + keys.length + " チャンク）。");
		});
	});
}

document.getElementById("download-log").addEventListener("click", downloadDiagnosticLog);
document.getElementById("clear-log").addEventListener("click", clearDiagnosticLog);
renderDiagnosticIdentity();
restoreOptions();