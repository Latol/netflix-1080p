# 診断ビルド（discard 後の画質比較）

このブランチは Netflix 上の原因確定用です。bitrate の選び方、playercore、自動リロードは 1.34.0 のままです。修正は、同じ head の実機ログで急落時刻と候補・Override・描画解像度が結び付いてからにします。

拡張IDは `paaingnmhpdddlckkplellcbindblmkd` です。Web Store 版 `mdlbikciddolbenfkgggdegphnhmnfcg` とは別です。同時に有効にしないでください。

## 設定について

新規インストール時の初期値は元の拡張と同じです。

| 項目 | 初期値 |
| --- | --- |
| use6Channels | true |
| setMaxBitrate | true |
| disableVP9 | false |
| disableAVChigh | false |
| disableAV1 | false |
| showAllSubs | false |

ユーザー提供のオプション画面では、6項目すべてがチェックされていました。codec の3項目は「無効化する」スイッチなので、チェックは VP9、AVChigh、AV1 を無効にする状態です。これは画面の観測です。元の拡張の `chrome.storage` は読んでいません。診断版は別IDなので、保存値は自動では引き継がれません。診断版がこの画面の値を書き込むこともありません。

比較の前に、診断版のオプションを開いて6項目をすべてチェックし、Save してください。オプション画面に、いま保存されている値とその画面観測との一致不一致が出ます。

Web Store 版へ戻すときは、診断版を削除または無効にし、Web Store 版だけを有効にします。Web Store 版の保存値はそちらの ID に残っています。

## 事実

- 対象環境の申告は、macOS の Google Chrome 156.0.8078.74、New Netflix 1080p 1.34.0、Auto Tab Discard 0.7.7 です。
- 申告された症状は、休止した Netflix タブを選び直すと自動再生し、最初は 1080p、数秒から30秒で 540p 以下になり、数分待っても戻らず、通常の再読み込みで戻る、です。低下後の正確な解像度は未記録です。
- ユーザー提供画面の6チェックは上の観測です。
- `netflix_max_bitrate.js` は、メニューが揃ったとき Video と Audio の最後の option を選んで Override を押します。`setMaxBitrate` が真のときだけそのループに入ります。
- playercore の候補生成は video/audio streams の map で、その場では sort していません。Override は `Qza` により現在時刻への seek を伴います。
- 同じ設定のまま通常再生が 1080p になるなら、codec 無効化のチェック状態だけでは、再読み込みと休止復帰の差は説明できません。休止復帰のときだけ設定適用や候補順が変わるかは、ログで見る項目です。

## 仮説（未確定）

ログの急落時刻と突き合わせてから判定します。

- 一覧の末尾を最高品質とみなす処理が、復帰後は低いトラックを指している。
- 候補が遅れて増える前に Override が走り、その bitrate が固定される。
- Override の固定が解除され、ABR が低い描画解像度へ落ちる。
- プレーヤー要素が同一 URL のまま作り直される。
- 設定 DOM より playercore の初期化が先で、profile 生成が通常時と違う。

最大 bitrate を 1080p と同一視する結論にはしません。描画中の解像度と、選ばれたストリームは別フィールドです。

## 実機で残すもの

ログは `chrome.storage.local` にだけ入ります。ページの例外文は保存せず、決まったコードだけを残します。250ms ごとの保存は、同じチャンクをイベント上限まで書き換えてから次のチャンクへ進みます。チャンク数の上限内に、通常の再読み込みと休止復帰をそれぞれ 3 分取った記録が残ります。書き出しは古い記録から最大 4000 件に切ります。書き込みに失敗した分はバッファに残し、確認できるまで消しません。書き出しはオプション画面の「診断ログを書き出す」です。ファイル名は `netflix-1080p-diagnostic.json` です。

### 書き出し

オプション画面は UTF-8 を宣言します。5941c8b までの `pages/options.html` には charset 宣言がなく、`chrome-extension://` の応答にも charset が付かないため、日本語ロケールの Chrome は既定の Shift_JIS でページと、ページが読み込む `core.js` を復号していました。`core.js` の正規表現に含まれていた生の `×` は Shift_JIS では後続の `]` を巻き込み、`core.js` 全体が SyntaxError で読み込まれず、「診断ログを書き出す」「診断ログを消去」は押しても何も起きませんでした（記録側の `core.js` は manifest 経由の content script として UTF-8 で読まれるため、この影響を受けません）。これは Linux の Chrome for Testing 153 で `--lang=ja` と `intl.charset_default=Shift_JIS` を与えて再現したものです。Mac の Chrome 156 で同じ原因だったかは未確認です。

- 書き出しの成否は `#log-status` に出ます。成功時は「イベント N 件 / チャンク M 個 / 約 K KB」です。0 件なら 0 件と明示します。
- 失敗時は固定の code（`core-missing`、`storage-read-failed`、`export-build-failed`、`download-failed`）だけを出します。例外文は表示しません。
- 「診断ログを消去」は確認ダイアログを出してから消します。キャンセルすれば何も消えません。
- `core.js` が読み込めなかった場合も、拡張 ID は表示し、`core-missing` を status に出します。

書き出しは `chrome.storage.local` を読むだけで、記録と設定には書き込みません。

各 watch 進入または video 要素の出現から、1秒間隔で最大180回（3分）取ります。タイトルが変わると窓をやり直します。watch を離れると止めます。

同一タイムラインに入るもの:

- `document.wasDiscarded`、navigation type、document の開始
- video 要素の生成・交換（`player` の generation と `replaced`）
- 候補の順序、選択値、Override クリック直前、クリック後にメニューが残っているか
- `#maxbitrate-hide-menu-style` の有無（元の自動操作がメニューを隠している印）
- 設定 DOM と `globalOptions` へ入った6項目、報告画面との一致、profile 名、設定読み込みエラー
- サンプルの `rendered`（videoWidth / videoHeight）
- `renderedProbe` は `.player-info` の textarea だけを読む。`Playing bitrate (a/v)` の音声・映像 bitrate と解像度、`Video Track` の codec、`Throughput` の kbps は別フィールドです。Throughput は再生 bitrate に入れません。この textarea は、再生統計を手動で開いている間だけ存在します。開いていなければ bitrate と codec は null です。video 要素の描画解像度は、統計を開かなくても残ります。
- `selectedStream`（Override 直前に選ばれていた option）
- `playerTrace`（player のコンソールに出た bitrate。描画解像度ではない）

候補の追加が同一ターンで終わる場合は、そのターン終了時の一覧を1回記録します。後のターンで増減した場合は `menu-updated` です。Override より前の既定選択を別々に取れない場合、`menu-built` と `before-override-click` は同じスナップショットになります。

## ログに入れないもの

HAR、Cookie、token、完全な URL、署名付き URL、会話、作品を識別する watch ID、ページタイトルは保存しません。書き出した JSON にそれらが残っていないことを、共有前に確認してください。

## 手順

1. Web Store 版「New Netflix 1080p」を無効にする。
2. 診断用のディレクトリを用意する。リポジトリ直下をそのまま読み込むか、`python3 make.py` でテストを含まない `dist/` を作ってそれを読み込む。名前は「New Netflix 1080p Diagnostic」、ID は `paaingnmhpdddlckkplellcbindblmkd` です。
3. 診断版のオプションで6項目をすべてチェックして Save する。一致の表示を確認する。
4. 1080p が通常出る作品で通常の再読み込みをしたあと、再生統計を手動で開く。この playercore では Ctrl+Alt+Shift+D、または Ctrl+Alt+Shift+Q です。開いたまま 3 分再生する。診断フックは統計を自分では開きません。
5. 同じ作品で Auto Tab Discard により休止し、タブを選び直す。自動のページ再読み込みはしない。戻ったあとに、もう一度同じ操作で再生統計を開く。開いたまま 3 分見る。統計を開き直さないと、復帰後の bitrate と codec は null のままです。
6. オプションからログを書き出す。`#log-status` の件数で通常再生と休止復帰の両方が残っていることを確認する。0 件なら記録が動いていないので、再生統計を開いたまま 3 分再生してからやり直す。
7. 通常再生、通常の再読み込み、タブ切替、次話移動も、比較用に残せるなら残す。

合成テストは `node --test test/diagnostic.test.js` です。これは候補順の逆転、候補の遅延、同一 URL のプレーヤー交換、メニュー不在、移動中のキャンセル、手動 Override、`setMaxBitrate` が false のときのループ期待、再入と有限サンプルを fixture で見ます。Netflix 上でその現象が起きたことの確認ではありません。

## このビルドが触るもの

`netflix_max_bitrate.js` と `content_script.js` と playercore は変更していません。ページ側では、設定の代入時刻を見るための `globalOptions`、profile 行を残すための `console`、メニューと video の出現を見るための MutationObserver を追加しています。サニタイズ済みの直近ログを `script#nflx1080p-diag-buffer` にも置き、isolated world の bridge が早期イベントを取りこぼさないようにしています。選択、クリック、seek、リロードは呼びません。これらのフックが再生時刻を変えないことは、Netflix 実機では未確認です。180 件の完了後も、179 件目のあとの長い中断でも、中断後に有限の記録を 1 本取り直す。`performance.now` が進まない壁時計の飛びは `clock-discontinuity` として残し、Mac のスリープとは断定しない。これは診断の記録だけで、画質の復帰ではない。詳細は `docs/vm-boundary.md` です。

`baseline/v1.34.0` は凍結です。設定を合わせるためにそのブランチは変更していません。診断版は別IDなので、オプション画面で6項目を Save します。

## Bugbot

この案件の指定です。この Agent は Bugbot の契約も設定画面も変えていません。

- レベルは Default。High にはしない。
- Every Push。
- 個人設定の Review Draft PRs は On。
- この Netflix repo は ON。
- Autofix は New Branch と、既存の CI 失敗自動修正を維持。

この head に Bugbot のコメントが付いたかどうかは、PR 作成後に見る事項です。コメントが無い状態をレビュー完了にはしません。

## 未確認

- 休止復帰の実機ログと急落時刻の対応。原因も修正も、このログの前には確定しない。
- `wasDiscarded` がこの Auto Tab Discard の復帰で true になること
- stats 文言から bitrate と codec が取れること。取れないサンプルは null です
- 実機の5回 + 別作品3回の受入
- この head への Bugbot コメントの有無
- 5941c8b の書き出し不動が Mac / Chrome 156 で上記と同じ原因（Shift_JIS 復号）だったこと。VM の再現は Linux の Chrome for Testing 153 と、ロケール既定の強制による
- Grok から Codex チャット `01a196ea-f2bd-7f00-ab4e-1f06111ff5c5` への配送。Issue #1 の記録は配送成功ではありません
