# VM で切った境界

この文書は Linux 上の Chrome で、拡張の実ファイルをローカル fixture に読み込んだ結果です。macOS のスリープ、Netflix の DRM 再生、GPU 復帰は実証していません。画質低下を外から数値で差し込んだ再現でもありません。

ユーザー申告では、診断版 `5941c8b` を使っているとき、タブ休止のあとは問題なく、Mac 本体のスリープ復帰後は最初が鮮明で、数秒から 30 秒で粗くなります。低下後の解像度、codec、bitrate、復帰時ログは未取得です。過去の「1080p から 540p 以下」は、今回の実測値としては扱いません。

## 仮説と、この VM での予測

1. URL が変わらないまま visibility / pageshow / freeze / resume / online が来ると、元の bitrate スクリプトが Override をやり直す。予測は、最初の成功のあとにクリックが増えることです。
2. 診断フックが、v1.34.0 の選択処理に無い復帰操作を足している。予測は、reload か追加の Override です。
3. 同じ URL で video 要素だけが増えても、URL 監視は Override を再開しない。予測は、クリックが増えないことです。
4. `online` を Netflix へ届くこととみなして再接続する。予測は、オフライン模擬のあとでも reload も Override も増えないことです。仕様上、`navigator.onLine` が true でも特定のホストへ届くことは意味しません。
5. 同一タスクで増えた候補を、診断ログが遅延更新として複数回残す。予測は、MutationObserver の1回のコールバックで `menu-built` が1件、その後の別タスクでだけ `menu-updated` が出ることです。
6. `Date.now` の前後ジャンプや、別ドキュメントの `performance.now` の差をスリープ判定に使う。予測は、その差を復帰条件にしていないことです。`Date.now` は時計合わせでも動き、`performance.now` は単調ですが、別の time origin とは比べません。長いコールバック間隔も、スリープだけの印ではありません。

visibility、pageshow、freeze、resume、online はページ、ドキュメント、接続の候補信号です。Mac のシステム復帰そのものではなく、Mac で必ず届くものでもありません。

## 実行

Chrome `156.0.8078.47`（この VM の Linux 版。ユーザーの Mac にある `156.0.8078.74` とは別です）。

```text
node --test test/diagnostic.test.js test/vm_boundary.test.js
```

`test/vm_boundary.test.js` は headless Chrome に `http://127.0.0.1/.../netflix.com/watch/fixture` を開きます。ホストは Netflix ではなく、URL 文字列が元スクリプトの watch 正規表現に合うだけです。Netflix へは接続していません。

区分:

- `mutation_observer_same_task`: 実際の `diagnostic/page_hook.js` とブラウザの MutationObserver。
- `dispatched_dom_events_and_simulated_clock`: ページから送った DOM イベントと、`Date.now` の差し替え。リスナーの有無と時計の模擬であり、ブラウザの凍結でも OS のスリープでもありません。
- `chromium_page_lifecycle_cdp`: この Chrome が受けた `Page.setWebLifecycleState` の frozen から active。ページライフサイクルの凍結であり、OS のスリープではありません。
- `chromium_network_emulation`: `Network.emulateNetworkConditions` の offline から online。Netflix への到達確認ではありません。

結果（この実行）:

- 同一タスクで option を2件足したとき `menu-built` は 1、同一タスクの `menu-updated` は 0。次のタスクで 1 件足すと `menu-updated` が 1、件数は 3。Bugbot の「同一ターンの候補追加が毎回別イベントになる」は、この呼び出しでは起きていません。
- 元の `netflix_max_bitrate.js` は、メニューが揃ったあと Override を 1 回押しました。その後のイベント、時計の ±1 時間、video 要素の追加、CDP の freeze/active、offline/online のあと、クリックは 1 のまま、reload は 0 です。修飾キー付き keydown は最初の 3 件から増えていません。
- 別 iframe の `performance.now` は記録しただけで、判定には引き算していません。

## 採らなかった修正

復帰信号で Override をやり直す処理は入れていません。この VM の経路では、URL が同じ間は元のスクリプトが Override を再開せず、診断フックも再開させていません。解像度が確認できていないトラックを、周期的な Override で選び直す根拠はありません。Override は playercore 上で現在時刻への seek を伴います。

タブ休止が問題ない、という申告は回帰条件として残します。今回のテストはそれを Mac で再確認していません。

## まだ VM で見ていないもの

- macOS のスリープと、Apple の `mach_absolute_time` と `mach_continuous_time` の差。
- Netflix のログイン、DRM、実映像、GPU 復帰。
- 復帰後にプレーヤーが内部で取り替えるか、ABR が低いトラックのままになるか。
- ユーザーの Mac にある診断ログ。Cloud へは転送していません。
