# Claude Code 用 MOD

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

## plan-progress

Claude Code の入力欄の上にリアルタイムの進捗バーを表示します。Claude がタスクをステージとステップに分け、作業に合わせてバーが進みます。各タスクのサブエージェントはバーの下に一覧表示されます。

![plan-progress：エージェント付きの 2 つのタスク、質問、エラー、途中で書き換えられた計画、両タスクの完了](media/plan-progress.gif)

[音声付き動画（MP4、14 秒）](media/plan-progress.mp4)

- タスクごとに 1 行：状態、タイトル、バー、パーセント、閉じるボタン
- バー上のラベルに現在のステージとステップを表示。ホバーで経過時間を表示
- ステージはカプセル、ステップは点で表示。ホバーで到達時刻を表示
- 完了したバーは緑色になり、合計時間を表示、30 秒後に自動で消える（`/config` の `doneBarSeconds`）
- 4 つの状態：実行中、入力待ち、エラー、完了
- サブエージェントごとにタスクの下に 1 行：名前、モデルと effort、使用中のツール、時間
- 計画は途中で変更可能。完了したステップはタイトルで引き継がれます
- バーはセッションごとに保存され、セッション再開時に復元されます
- 質問、エラー、完了時に短い効果音
- デスクトップアプリとターミナルの両方に対応
- ターミナルでは `auto` テーマのとき GNOME デスクトップのライト／ダークに追従し、Omarchy の現在のテーマの色を使う

### インストール

Claude Code 2.1.286 以降が必要です（`claude --version` で確認、`claude update` で更新）。それより古いバージョンではフックモジュールが読み込まれず、バーは表示されません。起動時に `plan-progress: hooks module did not load` と表示されます。

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

更新：

```
claude plugin marketplace update zycck-mods
claude plugin update plan-progress@zycck-mods
```

### コマンド

- `/progress` バーの表示・非表示を切り替え
- `/progress-clear` すべてのバーを削除
- `/progress-agents` バーの下のエージェント行を折りたたむ・再表示する（バーの ✕ の横の 矢印ボタンはそのバーだけ）
- `/plan-progress-autoclose` 完了したバーの自動クローズをオフ／オンにする（選択はセッションをまたいで保持）

フッターの **Progress** ボタンは `/progress` と同じ動作です。

### 仕組み

MOD は `plan_progress` ツールを登録します。Claude は計画を一度送り、その後 `{id, next: true}` や `{id, done: ["Routes"]}` のような短い更新を送ります。存在しないステップ名は、そのバーのステップ一覧とともに拒否されます。plan mode で承認した計画はバー `plan` になります。エージェントの行はエンジンのイベントから作られ、トークンを消費しません。

デスクトップではバーは SVG 画像で、上にホバー用のレイヤーがあります。ターミナルでは文字のグリッドで、Claude が作業している間だけアニメーションします。

### テスト

`plugins/plan-progress/tests` は実際のモジュールをスタブエンジン上で実行します：`node compile.cjs ../hooks/register.tsx register.mjs` の後に `node regress.mjs` と `node scenarios.mjs`。

## ライセンス

MIT
