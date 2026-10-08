# Claude Code 模组

[English](README.md) · [Русский](README.ru.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

## plan-progress

在 Claude Code 输入框上方显示实时进度条。Claude 将任务拆分为阶段和步骤，进度条随工作推进而填充。每个任务的子代理列在其进度条下方。

![plan-progress：两个带子代理的任务、一个提问、一个错误、中途改写的计划，两个任务均已完成](media/plan-progress.gif)

[带声音的视频（MP4，14 秒）](media/plan-progress.mp4)

- 每个任务一行：状态、标题、进度条、百分比、关闭按钮
- 进度条上的标签显示当前阶段和步骤；悬停可查看已用时间
- 阶段用胶囊标记，步骤用圆点标记；悬停可查看到达时间
- 完成的进度条变为绿色并显示总用时，30 秒后自动消失（`/config` 中的 `doneBarSeconds`）
- 四种状态：进行中、需要输入、错误、完成
- 每个子代理在其任务下占一行：名称、模型和 effort、当前工具、用时
- 计划可在执行中修改；已完成的步骤按标题保留
- 进度条按会话保存，恢复会话时重新显示
- 提问、出错和完成时播放简短提示音
- 支持桌面应用和终端
- 在终端中，`auto` 主题下进度条跟随 GNOME 桌面的浅色或深色模式，并使用当前 Omarchy 主题的颜色

### 安装

需要 Claude Code 2.1.286 或更高版本（用 `claude --version` 查看，用 `claude update` 更新）。在更旧的版本上钩子模块不会加载，也不会出现进度条；启动时会显示 `plan-progress: hooks module did not load`。

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

更新：

```
claude plugin marketplace update zycck-mods
claude plugin update plan-progress@zycck-mods
```

### 命令

- `/progress` 显示或隐藏进度条
- `/progress-clear` 移除所有进度条
- `/progress-agents` 折叠或重新显示进度条下方的代理行（进度条 ✕ 旁的 箭头按钮只作用于该条）
- `/plan-progress-autoclose` 关闭或重新开启已完成进度条的自动消失；该选择在会话之间保留

底部的 **Progress** 按钮与 `/progress` 作用相同。

### 工作原理

模组注册一个 `plan_progress` 工具。Claude 先发送一次完整计划，之后发送简短更新，例如 `{id, next: true}` 或 `{id, done: ["Routes"]}`。未知的步骤名称会被拒绝，并返回该进度条的步骤列表。在 plan mode 中批准的计划会成为进度条 `plan`。子代理行来自引擎事件，不消耗 token。

在桌面应用中，进度条是一张 SVG 图像，上方叠加悬停层。在终端中，它是字符网格，仅在 Claude 工作时播放动画。

### 测试

`plugins/plan-progress/tests` 在模拟引擎上运行真实模块：`node compile.cjs ../hooks/register.tsx register.mjs`，然后运行 `node regress.mjs` 和 `node scenarios.mjs`。

## 许可证

MIT
