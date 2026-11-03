# VM の境界

Linux の Chrome で、拡張の実ファイルをローカル fixture に読んだ結果です。画質が鮮明から粗いへ変わる遷移は、この実行では観測していません。macOS のスリープ、Netflix の DRM、GPU 復帰も実証していません。低い解像度を fixture に代入して、実機の不具合を捕まえたことにはしていません。

## 実行

この VM の Chrome は `156.0.8078.47` です。ユーザーの Mac にある `156.0.8078.74` とは別のビルドです。

```text
node --test test/diagnostic.test.js
node --test test/vm_boundary.test.js
```

前者は node の fixture です。後者は headless Chrome です。CI でもジョブを分けています。node の成功は、スリープ後の画質の回帰テストではありません。

ブラウザ試験の URL は `127.0.0.1` 上の `/netflix.com/watch/80000000` です。数字は、元スクリプトが watch ページと判定するための印です。Netflix へは接続していません。

## 仮説と結果

1. URL が同じまま、visibility / pageshow / freeze / resume / online / offline や時計のずれで、bitrate スクリプトが Override をやり直す。baseline、診断版 `5941c8b`、現在の head のどれでも、最初の 1 回からクリックは増えませんでした。送った DOM イベントはリスナーの試験です。
2. 診断フックが baseline に無い reload や Override を足す。3 本ともクリックは 1、ドキュメントの再取得は 0 でした。`netflix_max_bitrate.js` のバイト列は `baseline/v1.34.0` と一致します。
3. 同じ URL で video 要素を足し、候補の末尾が小さい bitrate のメニューを fixture が差し込む。これはプレーヤーが取り替わった条件の模型です。Netflix がスリープ後にそうする証拠ではありません。模型のあと、Override は増えていません。診断版だけが player 世代の記録を 0 から 1 に増やしました。
4. `online` を Netflix へ届くこととみなす。CDP の offline から online のあと、クリックは 1、reload は 0 です。`navigator.onLine` が true でも、そのホストへ届くことは意味しません。
5. 同一タスクの候補追加を、診断ログが遅延更新として重複記録する。baseline にはメニュー記録がありません。`5941c8b` と現在の head は、同一タスクで `menu-built` が 1、同一タスクの `menu-updated` は 0、次のタスクで足した 1 件だけ `menu-updated` でした。
6. `Date.now` の前後 1 時間を、ソースのタイマーが動いているあいだ維持する。baseline は interval のコールバックが forward 11 回、back 3 回、その時刻を見ました。診断版はそれに加え、サンプルの `at` が forward 1 件、back 2 件、時計を戻したあと 1 件でした。`performance.now` はその 1 時間には飛びません。別 iframe の `performance.now` は記録しただけで、time origin をまたいで引き算していません。

時計のずらし、送った DOM イベント、CDP の page lifecycle frozen→active、CDP の network offline→online は、それぞれ別の操作です。どれも macOS のスリープではありません。

## reload の検出

`Location.prototype.reload` の差し替えは使っていません。`location.reload` はインスタンス自身の LegacyUnforgeable なので、prototype の差し替えでは本物の reload を数えられません。

検出は、主フレームの `Page.frameNavigated` と、watch 用ドキュメントの HTTP GET です。対照として `location.reload()` を 1 回呼ぶと、遷移は 1 から 2、ドキュメント取得も 1 から 2 になりました。信号試験のあいだは、どちらも増えていません。ソースに `location.reload` が無い、という静的確認はこれとは別です。

## 入れなかったもの

画質を戻すコードは入れていません。この入力では、暗号化されていないローカル映像も同梱 playercore も、Netflix のログインなしには ABR の切り替え面まで届きません。低い `videoWidth` を代入して再現と呼ぶことはしていません。

復帰のたびに Override を押す処理も入れていません。Override は現在時刻への seek を伴います。

## まだ無いもの

Mac のスリープで、どのトラックが選ばれ、描画解像度がどう変わったかの記録です。それを VM だけで再生するには、作品や Cookie を含まない、復帰前後の候補一覧、選択値、描画解像度、bitrate、codec の時系列が要ります。その記録はまだありません。Mac の操作や、ビルドの導入は求めていません。
