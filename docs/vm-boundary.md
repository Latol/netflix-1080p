# VM の境界

Linux の Chrome で、拡張の実ファイルをローカル fixture に読んだ結果です。画質が鮮明から粗いへ変わる遷移は、この実行では観測していません。macOS のスリープ、Netflix の DRM、GPU 復帰も実証していません。低い解像度を fixture に代入して、実機の不具合を捕まえたことにはしていません。

## 実行

Chrome の版は試験ごとに違います。`vm_boundary` の記録は Chrome `156.0.8078.47`、`options_export` の記録は Chrome for Testing `153.0.8010.12`（Playwright 同梱）です。どちらもユーザーの Mac にある `156.0.8078.74` ではありません。各試験は `/json/version` の値を report に書くので、実際に使った版はそちらを見ます。CI の `options-export` job は installer（`@puppeteer/browsers`）だけを固定し、Chrome はその日の stable を入れます。

```text
node --test test/diagnostic.test.js test/options_encoding.test.js
node --test test/vm_boundary.test.js
CHROME_BIN=/path/to/chrome-for-testing node --test test/options_export.test.js
```

`options_export` は拡張を `--load-extension` で実際に読み込みます。ブランド版 Google Chrome は 137 以降このフラグを無視するため、CI では別 job が Chrome for Testing を入れて実行します。拡張が読み込まれなかった場合、この試験は skip ではなく失敗します。

前者は node の fixture です。後者は headless Chrome です。CI でもジョブを分けています。node の成功は、スリープ後の画質の回帰テストではありません。

ブラウザ試験の URL は `127.0.0.1` 上の `/netflix.com/watch/80000000` です。数字は、元スクリプトが watch ページと判定するための印です。Netflix へは接続していません。

## 測定の範囲

reload が 0 という数値は、`runSignalProbe` の直前直後だけです。そこには、ページから送った DOM イベントと、ソースのタイマーが動いているあいだの時計のずれが含まれます。baseline、診断版 `5941c8b`、現在の head の 3 本を同じ条件で比べたのは、この段階のクリック数、keydown、メニュー記録、player 世代の記録です。

CDP の `Page.setWebLifecycleState`（frozen から active）と `Network.emulateNetworkConditions`（offline から online）は、そのあとで、診断版 `5941c8b` と現在の head だけが実行します。baseline はこのブロックを通りません。CDP のあとで断言しているのは Override のクリック数だけです。遷移回数とドキュメント GET は、CDP の段階では取り直していません。3 本の比較は CDP には及びません。

## 仮説と結果

1. URL が同じまま、送った visibility / pageshow / freeze / resume / online / offline や時計のずれで、bitrate スクリプトが Override をやり直す。これは `runSignalProbe` の範囲です。baseline、`5941c8b`、現在の head のどれでも、最初の 1 回からクリックは増えませんでした。送った DOM イベントはリスナーの試験です。
2. 診断フックが baseline に無い Override を足す。3 本のクリック数は、この probe の段階で同じ 1 です。`netflix_max_bitrate.js` のバイト列は `baseline/v1.34.0` と一致します。ドキュメントの再取得が 0 なのも、この probe の直前直後だけです。
3. 同じ URL で video 要素を足し、候補の末尾が小さい bitrate のメニューを fixture が差し込む。これは probe 内の模型です。Netflix がスリープ後にそうする証拠ではありません。模型のあと、Override は増えていません。診断版だけが player 世代の記録を 0 から 1 に増やしました。
4. CDP の offline から online のあと、診断版と現在の head ではクリックが 1 のままでした。baseline はこの CDP を実行していません。この段階の reload 回数は測っていません。`navigator.onLine` が true でも、そのホストへ届くことは意味しません。
5. 同一タスクの候補追加を、診断ログが遅延更新として重複記録する。baseline にはメニュー記録がありません。`5941c8b` と現在の head は、同一タスクで `menu-built` が 1、同一タスクの `menu-updated` は 0、次のタスクで足した 1 件だけ `menu-updated` でした。
6. `Date.now` の前後 1 時間を、ソースのタイマーが動いているあいだ維持する。これは probe の範囲です。baseline は interval のコールバックが forward 11 回、back 3 回、その時刻を見ました。診断版はそれに加え、サンプルの `at` が forward 1 件、back 2 件、時計を戻したあと 1 件でした。`performance.now` はその 1 時間には飛びません。別 iframe の `performance.now` は記録しただけで、time origin をまたいで引き算していません。

時計のずらし、送った DOM イベント、CDP の page lifecycle、CDP の network emulation は、それぞれ別の操作です。どれも macOS のスリープではありません。

## reload の検出

`Location.prototype.reload` の差し替えは使っていません。`location.reload` はインスタンス自身の LegacyUnforgeable なので、prototype の差し替えでは本物の reload を数えられません。

検出は、主フレームの `Page.frameNavigated` と、watch 用ドキュメントの HTTP GET です。対照として `location.reload()` を 1 回呼ぶと、遷移は 1 から 2、ドキュメント取得も 1 から 2 になりました。`runSignalProbe` の直前直後では、どちらも増えていません。CDP の freeze と network の段階では、この差分を取り直していません。ソースに `location.reload` が無い、という静的確認はこれとは別です。

## 診断記録の穴

180 件で `createSampler` は次のタイマーを止めるが、完了後も `active` を残していた。さらに、実行中の窓で長い中断を見ても記録を切り替えないため、179 件のあとでは中断後に最後の 1 件だけで終わる。これは診断の記録漏れであり、Netflix の画質低下の原因としては確定していない。

修正後は完了と同時に待機へ戻る。既存の 500ms 監視で、次のどちらかなら、実行中でも終わったあとでも、中断後の有限な記録を 1 本始める。

- 同じドキュメントの `performance.now` が 15 秒以上空く。理由は `execution-gap`。
- `performance.now` は短いのに `Date.now` が 15 秒以上進む。理由は `clock-discontinuity`。Mac のスリープでも、時計合わせでも起き得る。スリープの証明ではない。

同じ中断のあいだに続く信号は、普通の間隔が一度入るまで重ねて開始しない。バックグラウンドの長い間隔だけで、窓を何度もやり直さない。`Date.now` が戻るだけでは始めない。再生の操作にはつながない。

ブラウザの配線確認は、同じ URL の `page_hook` に仮想の `performance.now` を 20 秒足し、最初の `execution-gap` の開始イベントが出るまで待つ。上限は 4 秒。そこで世代と生の差を見る。これは Mac のスリープではない。同じ中断を 1 回にまとめることは、ブラウザの二つの注入では見ない。間に普通の監視が入ると、実装は正当に別の記録になる。そのまとめは fake clock の単体テストが持つ。

時計の各段階は、固定時間ではなく、その段階のサンプルかタイマーが出るまで待つ。上限は 4 秒。復帰時の正の `Date` 飛びは記録をやり直すことがあり、最初のサンプルは 500ms の監視のあと 1 秒で届く。メニューを入れ直す前に、bitrate スクリプトの 200ms 再試行が終わるまで待つ。

この VM の Chrome では、統計 textarea なしの 320x180 canvas 映像を、実タイマーのサンプルが `videoWidth` / `videoHeight` として記録する。キャプチャが使えるのに幅や高さが違えば試験は失敗する。使えないときは `capture-unsupported` と出す。時刻は仮想化していない。これは Netflix の画質低下の再現ではない。

## 入れなかったもの

画質を戻すコードは入れていません。この入力では、暗号化されていないローカル映像も同梱 playercore も、Netflix のログインなしには ABR の切り替え面まで届きません。低い `videoWidth` を代入して再現と呼ぶことはしていません。

復帰のたびに Override を押す処理も入れていません。Override は現在時刻への seek を伴います。

## 再現していないもの

描画が鮮明から粗く変わること、および再生統計上の解像度が 1080p から低い値へ変わることは、この VM では再現していません。ユーザーは、統計上の解像度が落ちたのか、見た目だけが粗くなったのかを、まだ確認していません。画質を戻すコードは未実装です。

VM だけでその遷移を再生するのに足りないのは、選択されたトラックと、描画中の幅・高さ、bitrate、codec が、粗くなった時刻の前後で別々に残った時系列です。リポジトリ、この PR、既存の Cloud artifact のどれにも、その時系列はありません。既存の zip と `vm_boundary_report_e87141d.json` は、ローカル fixture のクリックとログ境界だけです。

## オプション画面の書き出し

`test/options_export.test.js` は、配布済み 5941c8b と現在の head の 17 ファイルを unpacked 拡張として読み込み、`chrome-extension://paaingnmhpdddlckkplellcbindblmkd/pages/options.html` を開いて、本物のマウスイベントで「診断ログを書き出す」を押し、CDP の `Browser.downloadWillBegin` / `downloadProgress` でダウンロードを受け取ります。ja の脚は `--lang=ja` と `intl.charset_default=Shift_JIS` で、日本語ロケールの既定エンコードを強制します。en-US の脚は対照です。

示したこと（Chrome for Testing 153、Linux）:

- 5941c8b / ja: `document.characterSet` は `Shift_JIS`。読み込み時に `core.js` から `SyntaxError: Invalid regular expression: missing /`。`Netflix1080pDiagCore` は未定義、拡張 ID の表示は空、ボタンの文字は `險ｺ譁ｭ繝ｭ繧ｰ…` の文字化け。押すと `Error handling response: TypeError: Cannot read properties of undefined (reading 'mergeDiagnosticStorage')` が記録され、ダウンロードは始まらず、status も空のまま。空の storage でも、記録ありの storage でも同じ。
- 5941c8b / en-US: `windows-1252`。`core.js` は読み込まれ、書き出しは成功する。文字は化ける。不動はロケール依存。
- head の `core.js` を「読み込み時に throw する stub」に置き換えた拡張（ja）: 拡張 ID は表示され、`#log-status` に `code: core-missing` が出て例外文は含まれない。書き出し・消去を押しても同じ code が出るだけで、ダウンロードも confirm も storage の変化も起きない。
- head / ja と en-US: `UTF-8`。文字化けなし。空、3 チャンク、16 チャンク 4000 件（書き出し約 14 MB）、legacy key と不正値を混ぜた storage のすべてで、ファイル名 `netflix-1080p-diagnostic.json` のダウンロードが完了し、JSON の schema、件数、チャンク数が一致する。消去は `confirm` を出し、キャンセルでは何も消えず、承認では診断チャンクだけ消える。

示していないこと:

- Mac の Chrome 156、macOS のロケール設定、ユーザーのプロファイルと実際の保存データ。ユーザーの Mac で同じ復号が起きたことは、この試験では確認できません。
- 画質低下との関係。これはオプション画面の書き出し経路だけの話で、再生には触れていません。
