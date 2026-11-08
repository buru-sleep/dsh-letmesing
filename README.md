# dsh-letmesing

> 模型思考的时候，放你自己的音乐。

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：当助手开始思考时自动播放你指定的背景音乐，思考结束自动淡出。

名字致敬[《Let Me Go》](https://www.bilibili.com/video/BV1XbY66nEWr)和 [LetMeSeek](https://github.com/XYdyskYX/DSH-LetMeSeek)。

(本项目全程dsh制作，共计消耗138.5Mtoken)

---

## 功能

- **三种触发时机**，在设置里切换：
  - `整轮运行`（默认）— 从你发出消息到回复结束，全程播放
  - `推理时` — 只有模型真的在推理时播放，正文输出、工具执行时静音
  - `常驻` — 一直播放，当普通播放器用
- **自己选音乐**：设置页里点「选择文件夹」，指向你存放音乐的目录即可，支持 mp3 / m4a / aac / ogg / oga / wav / flac / webm / opus
- **淡入淡出**：进入 700ms 渐强，退出 420ms 渐弱，不会有硬切的突兀感
- **单实例播放**：桌面端和浏览器同时开着时，只有先打开的那个窗口出声，另一个静默待命
- **设置持久化**：音乐文件夹存在 `~/.dsh/letmesing/config.json`，不受桌面端端口变化影响

## 安装

> 需要 DSH `0.2.1-rc.2` 或更高版本。

**方式一：让 DSH 帮你装（推荐）**

把这个仓库克隆到本地，然后在对话里说：

```
帮我安装插件 D:\path\to\dsh-letmesing
```

助手会调用插件管理功能把它装进当前 profile。

**方式二：手动**

```bash
git clone https://github.com/buru-sleep/dsh-letmesing.git
```

然后在 DSH 的插件管理里把该目录作为 bundle 安装。

如果 `git clone` 失败，报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，那是 Windows 上 git 的 HTTPS 后端拿不到系统凭据，跟仓库无关。换 SSH 地址克隆，或者直接在网页上下载 ZIP 解压，然后把解压后的目录交给助手安装：

```bash
git clone git@github.com:buru-sleep/dsh-letmesing.git
```

安装后需要**重启 DSH**（桌面端没有刷新按钮，Client 代码在启动时加载）。重启后打开 设置 → LetMeSing。

## 使用

1. 打开 设置 → LetMeSing
2. 勾选「启用」
3. 点「选择文件夹」，指向你的音乐目录（也可以直接粘贴路径）
4. 选择「播放时机」
5. 选一首曲目，发一条消息听听

第一次使用需要点一下页面（浏览器的自动播放限制），之后就不用管了。

## 配置项

| 项 | 说明 |
| --- | --- |
| 启用 | 总开关 |
| 播放时机 | `turn`（默认）/ `reasoning` / `always` |
| 播放方式 | `one` 单曲循环（默认）/ `shuffle` 随机 / `sequence` 顺序 |
| 音量 | 0–1 |
| 曲目 | 文件名；列表里可以上下移动调整顺序 |
| 音乐文件夹 | 本地目录路径 |

所有这些都存在 Host 侧的 `~/.dsh/letmesing/config.json`，不是只写浏览器 `localStorage`。

> 为什么？桌面端每次启动端口是随机的，浏览器存储按源隔离，`localStorage` 在重启后会失效。

## 什么时候响、什么时候停

| 时机 | 行为 |
| --- | --- |
| 模型开始推理 | 淡入（700 ms） |
| 模型开始写正文 | 淡出（420 ms）——写给你看的时候不打扰 |
| 工具调用 | 这一轮输出结束即静音，下一段推理再回来 |
| 需要你审批 / 提问 | 静音，直到你答完（淡出 900 ms） |
| 一轮结束 | 淡出（900 ms） |
| 常驻模式 | 以上都不适用，一直响 |

## 工作原理

- **Client 插件**监听当前会话的事件流（`ctx.sessions` → `binding(sessionId).eventSource`），
  从 `reasoning-delta` 这类流式块判断「模型正在推理」。
- **Host 插件**用 `webServer.register()` 暴露两个接口：
  - `GET /dsh-letmesing/api/list` — 列出音乐文件夹里的音频
  - `GET /dsh-letmesing/music/<file>` — 静态音频，支持 Range 请求
- 播放本身交给浏览器的 `HTMLAudioElement`，不依赖任何本地播放器命令（afplay / ffplay 之类），所以三个平台上行为一致。

## 已知限制

- **只支持 Web 层**：桌面端和浏览器都能用；终端 TUI 形态没有页面，不生效。
- **不会自动下载音乐**：请自备音频文件。仓库里不附带任何音频，避免版权问题。
- **上游可能变更**：DSH 版本升级如果改了 slot 名或事件名，插件会静默降级（不崩，但不响），到时需要跟着更新。

## 开发

```bash
# 语法自检
node --check index.js
node --check client.js

# 改了 Host（index.js）后需要重载插件：
# 插件管理里先禁用再启用，或重启 DSH
# 改了 Client（client.js）后必须重启 DSH：桌面端没有 Ctrl+R，
# 而设置页里的「重新加载界面」会在同一页面上下文重跑整段 boot，
# 插件模块重复导入会中止启动（web boot: 1 entry did not activate），
# 所以这个按钮已经从界面里移除
```

## 许可

[MIT](./LICENSE)

## 致谢

- 《Let Me Go》— 罐装毕加索 / 星落落_oi 的[原曲](https://www.bilibili.com/video/BV1XbY66nEWr)，以及 B 站「大肥鱼」系列[动画 PV](https://www.bilibili.com/video/BV1mThC6LEbA)
- [LetMeSeek](https://github.com/XYdyskYX/DSH-LetMeSeek) — 同族前辈，本项目的骨架参考
