# X Image to Telegram

[English](README.md) | **中文**

把 X（Twitter）推文里的图片、视频与动图一键发送到 Telegram 频道的 Tampermonkey 用户脚本。

当前版本 **2.0.1**。

## 特性

- 在每条推文的操作栏注入一个 Telegram 按钮（**回复也同样有按钮**，各自只发送本条推文的媒体）
- 支持**静态图片**、**视频**与 **GIF / 动图**
- 媒体全程以内存 `Blob` / `ArrayBuffer` 处理，**不写磁盘、不建缓存**
- 多图默认合并为**相册**发送，推文链接作为 caption。Telegram 单相册最多 10 项，而 X 单帖最多 20 张图，因此更长的推文会拆成多个相册逐块流式发送
- 动图由封面 URL 的 hash 直接拼出 MP4 直链，**不调用任何接口**
- 视频经**登录态同源 GraphQL** 取最高画质 MP4 档位（受限内容同样可获取），失败自动降级到公开接口
- 视频按档位做**下载前体积预检**（`Range` 请求），自动挑第一个不超过 50 MB 的档位
- `sendPhoto` / `sendVideo` / `sendAnimation` 失败时逐级降级到 `sendDocument`
- 支持 429 限流，严格使用服务端返回的 `retry_after`
- 适配 X 的 SPA 动态加载、无限滚动与路由切换
- 支持亮色 / 暗色主题
- 兼容 `x.com` 与 `twitter.com`

## 使用说明

### 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 新建脚本，把 [`userscripts/x-photo-to-tg.user.js`](./userscripts/x-photo-to-tg.user.js) 全文粘贴进去
3. 填写脚本顶部的 `telegramBotToken` 与 `telegramChatId`（见下方两节）
4. `Ctrl + S` 保存，打开 `https://x.com`
5. 找到带图片 / 视频 / 动图的推文，点击操作栏里的 Telegram 按钮

### 配置脚本

所有配置集中在脚本顶部，**不要把 Bot Token 散落到代码其他位置**。

```javascript
const CONFIG = {
    telegramBotToken: 'YOUR_BOT_TOKEN',   // 必填
    telegramChatId: 'YOUR_CHANNEL_ID',    // 必填

    maxRetries: 3,                        // 普通网络错误重试次数
    retryDelayMs: 1000,                   // 指数退避基数（1s → 2s → 4s）
    requestTimeoutMs: 30000,              // 图片下载与接口请求超时
    sendDelayMs: 800,                     // 多条媒体之间的间隔

    videoRequestTimeoutMs: 120000,        // 视频下载独立超时（30s 对几十 MB 不够）
    graphqlQueryId: 'xd_EMdYvB9hfZsZ6Idri0w',   // 视频接口的 queryId，X 发版失效时改这里

    preferDocumentForOriginal: false,     // false=优先 sendPhoto，true=优先 sendDocument
    sendAsAlbum: true,                    // true=多图合并为相册，false=逐张串行
    debug: false,                         // true 时输出详细日志（绝不含完整 Token）
};
```

| 配置项 | 说明 |
| --- | --- |
| `telegramBotToken` | **必填**。从 `@BotFather` 获取，形如 `123456789:AAxxxx...` |
| `telegramChatId` | **必填**。目标频道 ID，形如 `-1001234567890` |
| `preferDocumentForOriginal` | `false` 时优先 `sendPhoto`（频道内可预览，但 Telegram 会压缩）；`true` 时优先 `sendDocument`（保留原始画质，浏览体验较差） |
| `sendAsAlbum` | `true` 时多图合并为一个相册发送，推文链接作为相册 caption；`false` 时逐张串行发送 |
| `videoRequestTimeoutMs` | 视频下载的超时时间。**独立于 `requestTimeoutMs`**，因为几十 MB 的视频在慢网络下 30 秒不够 |
| `graphqlQueryId` | 视频媒体地址接口的 queryId。X 发版后若失效，脚本会自动降级并提示更新此值 |
| `debug` | 遇到问题时设为 `true`，控制台会输出 Tweet ID、作者、媒体数量、下载与请求状态、重试次数 |

#### 多图发送的两种模式

| 模式 | 效果 | 代价 |
| --- | --- | --- |
| `sendAsAlbum: true`（默认） | 图片按每 10 张一组合并成多个相册，链接 caption 挂第一个 | 任何时刻只持有正在发送的那一组（≤10 张），不是整条推文；某一组失败不影响其余组 |
| `sendAsAlbum: false` | 逐张独立发送，caption 挂第一张成功的图 | 频道里是多条独立消息，浏览体验较碎 |

分块与降级行为（自动处理，无需配置）：

- 不超过 10 张 → 一个相册（`sendMediaGroup` 只接受 2–10 项）
- 超过 10 张 → 按顺序拆成多个相册，caption 只挂第一个。每一组都要「下载 → 发送 → 释放」之后才开始下一组
- 某组只剩 1 张（例如 11 张 → 10 + 1）→ 改用单张 `sendPhoto`
- 组内有图片超出 `sendPhoto` 限制 → 这一组用【已下载】的 blob 逐张发送，不重复下载
- 部分图片下载失败 → 跳过失败的几张，这一组剩余图片照常发送
- 某一组发送失败（非致命）→ 后续各组照常尝试

#### sendPhoto 与 sendDocument 的区别

| 方式 | 优点 | 代价 |
| --- | --- | --- |
| `sendPhoto` | 频道内可直接预览 | Telegram 会压缩，**收到的不是原始文件** |
| `sendDocument` | 保留原始文件 | 频道内浏览体验较差 |

### 配置 Telegram Bot

#### 创建 Bot

1. 在 Telegram 中找到 `@BotFather`
2. 发送 `/newbot`，按提示设置名称与用户名
3. 记下返回的 Token

#### 把 Bot 加入频道（必须满足全部三项）

Bot **必须**：

1. 被添加到目标频道
2. 具有**管理员**权限
3. 具有**发布消息 / Post Messages** 权限

缺少任一条件会收到 `400 chat not found` 或 `403` 错误。

#### 获取频道 Chat ID

1. 确认 Bot 已是频道管理员
2. 在频道里随便发一条消息
3. 浏览器打开（替换 `<token>`）：

```text
https://api.telegram.org/bot<token>/getUpdates
```

4. 在返回 JSON 中找到 `channel_post.chat.id`，形如 `-1001234567890`

> **网络要求：** 浏览器必须能访问 `api.telegram.org`。若直连不通（连接被重置），需要让浏览器走代理。

### 使用

```text
打开 X
  ↓
找到带图片 / 视频 / 动图的推文（时间线或推文详情页）
  ↓
点击操作栏的 Telegram 按钮
  ↓
解析推文 → 提取作者 / 推文链接 / 图片 / 视频
  ↓
图片：下载到内存 Blob → 相册或逐张发送（带 caption）
  ↓
视频/动图：解析媒体地址 → 体积预检选档 → 下载 → 发送
  ↓
释放临时资源
```

#### 三种媒体的处理路径

| 媒体类型 | 媒体地址从哪来 | 发送方法 | 降级链 |
| --- | --- | --- | --- |
| 静态图片 | DOM 的 `img.src` | `sendPhoto` | → `sendDocument` |
| **动图**（封面走 `tweet_video_thumb`） | **封面 URL 的 hash 直接拼出**，零接口调用 | `sendAnimation` | → `sendVideo` → `sendDocument` |
| **视频** | 登录态 GraphQL；失败降级到公开接口 | `sendVideo` | → `sendDocument` |

> 封面走 `tweet_video_thumb` 的动图**不调用任何接口**，纯图片推文同样不调用。
> 只有真正的视频（以及封面不是该路径的动图）才发起接口请求。

#### 图文混排会分成两条消息

推文同时含图片与视频时：

```text
消息 1：图片（≥2 张走相册，1 张走单张 sendPhoto）+ 完整 caption（作者 / 推文链接）
消息 2：视频或动图，不带 caption
```

**纯视频推文不受此影响**：没有图片消息时，caption 会挂在视频上，链接不会丢。

#### 按钮状态

| 状态 | 外观 | 含义 |
| --- | --- | --- |
| 空闲 | 灰色纸飞机 | 可以发送 |
| 发送中 | 蓝色旋转圈 | 正在上传，此时不可重复点击；视频会显示当前阶段（解析地址 / 下载 / 发送） |
| 成功 | 绿色对勾 | 已发送成功 |
| 失败 | 红色警告 | 发送失败，可再次点击重试 |

#### 重复发送

- 已成功发送的推文，再次点击**不会**重复上传，会提示「该推文已经发送过」
- 需要强制重发时，使用 **Ctrl + 点击**（macOS 为 Cmd + 点击）
- 页面刷新后内存状态清空，可以重新发送

#### caption 格式

```text
Author: https://x.com/username
Post: https://x.com/username/status/123456789
```

- 作者链接为**必填项**，来自推文 DOM，不通过数字 ID 猜测
- 推文链接若获取失败会被省略，**不影响发送**
- **相册模式**（`sendAsAlbum: true`）：caption 作为相册整体的说明，只放在相册第一项上
- **串行模式**（`sendAsAlbum: false`）：caption 只挂在**第一张成功发送**的图片上；若第一张失败，caption 会顺延到下一张成功的图片
- **纯视频推文**：caption 挂在视频上（此时没有图片消息，不挂就会丢掉链接）
- **图文混排**：caption 挂在图片消息上，视频消息不重复带

### 常见问题

遇到问题先把 `debug` 设为 `true`，打开浏览器控制台（F12）看日志。
日志中的 Bot Token 一律以 `<redacted>` 显示，可以安全截图。

| 现象 | 处理 |
| --- | --- |
| 提示「Telegram Bot Token 无效」 | Token 填写错误或已失效，必要时用 `@BotFather` 重新生成 |
| 提示「Telegram 频道配置错误」/ `400 chat not found` | Chat ID 错误，或 Bot 未加入该频道 |
| 提示「Bot 没有向该频道发送消息的权限」 | 在频道设置中给 Bot 管理员权限与发布消息权限 |
| 提示「该推文没有可发送的图片或视频」 | 推文只有音频，或媒体属于引用推文（均不支持） |
| 提示「图片过大」/「视频超过 Telegram 50 MB 上限」 | Telegram Bot 上传上限为 50 MB，脚本不做转码 |
| 提示「该推文可能为受限内容」 | X 登录态失效。重新登录并刷新页面；**这条提示不是重试能解决的** |
| 提示「X 登录态已失效」 | 视频接口返回 401 / 403，重新登录 X |
| 提示「Telegram 限流」 | 触发 429，脚本会按服务端 `retry_after` 自动等待重试 |
| 视频整体变慢或画质下降 | `graphqlQueryId` 随 X 发版失效，已降级到公开接口（最高 720p）；控制台会明确提示 |
| 按钮没有出现 / 点击无反应 | 刷新页面；确认脚本已启用；确认已填写 Token 与 Chat ID |
| 控制台提示「Bearer 提取失败」 | 未能从 X 的 JS 文件中取到该常量，刷新页面重试；持续出现请反馈 |
| 视频下载很慢或超时 | 文件较大或网络较慢，可调高 `videoRequestTimeoutMs` |

**已知限制**

- **不支持**：音频、引用推文中的媒体、自行拼装 HLS 分片、浏览器端转码、任何持久化媒体缓存
- **视频与图片上限 50 MB**；`sendPhoto` 另受 10 MB、宽高总和 ≤ 10000、宽高比 ≤ 20 限制，且会被 Telegram 压缩
- **受限内容的视频依赖登录态**，X 登录态失效时需重新登录
- **`graphqlQueryId` 会随 X 发版失效**，失效时自动降级到公开接口（画质上限 1280x720），日志会提示更新
- **发送历史不持久化**，状态只存在内存中，页面刷新即清空
- **运行环境必须能访问 `api.telegram.org`**，否则无法发送
- **相册模式的内存按块封顶**：任何时刻只持有正在发送的那一组（≤10 张），发完立即释放；20 张的推文也不会同时持有 20 份 blob

## 项目结构

```text
.
├── .gitignore
├── LICENSE
├── README.md                     # English version（主版本）
├── README.zh-CN.md               # 本文件（中文）
└── userscripts/
    └── x-photo-to-tg.user.js     # 主脚本
```

## 安全说明

- Bot Token 只发送到 `api.telegram.org`，不经过任何第三方服务
- 所有日志与错误提示中的 Token 统一经过 `<redacted>` 脱敏
- 不使用遥测、统计服务、第三方图床
- 媒体只在内存中以 `Blob` / `ArrayBuffer` 处理，用后释放，`Object URL` 使用后立即 `revokeObjectURL`
- `@connect` 只声明实际需要的域名，未使用 `@connect *`
- **视频的媒体地址通过同源请求 X 官方接口获取**，使用浏览器自身的登录 Cookie（`credentials: 'include'`）。
  脚本**不读取、不存储、不外传**任何凭据；JS 读不到的 HttpOnly `auth_token` 也不需要读
- **不引入任何第三方下载源。** 早期评估过的第三方接口方案已被否决——它会把下载记录暴露给第三方，
  而登录态通路在覆盖率和画质上都更优
- `Bearer` 常量在运行时从 X 自己的 JS 文件里提取，日志中**只记录长度**，绝不输出其值

> 填写了 Token 的脚本**不要**提交到版本库。仓库的 `.gitignore` 已忽略 `config.local.js`、`.env*`、`secrets/` 等敏感路径。
