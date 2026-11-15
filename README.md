# X Image to Telegram

[中文](README.zh-CN.md) | **English**

A one-click script for Tampermonkey users to send images, videos, and animated GIFs from an X (Twitter) tweet to a Telegram channel.


## Features

- Inject a Telegram button into the action bar of each tweet (**a reply also includes a button**, each sending only the media from that specific tweet).
- Supports **static images**, **videos**, and **GIFs / animated images**.
- Media is always processed as in-memory `Blob` / `ArrayBuffer`, **without writing to disk or creating caches**.
- Multiple images are merged into **albums** by default, with the tweet link as the caption. Telegram allows at most 10 items per album and X allows up to 20 images per post, so longer posts are split into consecutive albums and streamed one chunk at a time.
- Animated GIFs are directly constructed from the cover URL's hash into an MP4 direct link, **without calling any API**.
- Videos are fetched via **authenticated same-origin GraphQL** for the highest quality MP4 tier (restricted content can also be retrieved); failure automatically degrades to a public API.
- Videos undergo **pre-size inspection before download** using `Range` requests, automatically selecting the first tier that does not exceed 50 MB.
- When `sendPhoto`, `sendVideo`, or `sendAnimation` fail, it degrades step-by-step to `sendDocument`.
- Supports 429 rate limiting, strictly using the `retry_after` value returned by the server.
- Compatible with X's SPA dynamic loading, infinite scrolling, and route switching.
- Supports light / dark themes.
- Compatible with `x.com` and `twitter.com`.

## Usage Instructions

### Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Create a new script and paste the entire content of [`userscripts/x-photo-to-tg.user.js`](./userscripts/x-photo-to-tg.user.js) into it
3. Fill in the `telegramBotToken` and `telegramChatId` at the top of the script (see the two sections below)
4. Press `Ctrl + S` to save, then open `https://x.com`
5. Find a tweet with an image / video / animated GIF, and click the Telegram button in the action bar

### Configure the script

All configurations are concentrated at the top of the script; **do not scatter the Bot Token anywhere else in the code**.

```javascript
const CONFIG = {
    telegramBotToken: 'YOUR_BOT_TOKEN',   // Required
    telegramChatId: 'YOUR_CHANNEL_ID',    // Required

    maxRetries: 3,                        // Retries for common network errors
    retryDelayMs: 1000,                   // Exponential Backoff Base (1s → 2s → 4s)
    requestTimeoutMs: 30000,              // Image download and API request timeouts
    sendDelayMs: 800,                     // The spacing between multiple media items

    videoRequestTimeoutMs: 120000,        // Independent video download timeout (30 seconds is insufficient for dozens of MB).
    graphqlQueryId: 'xd_EMdYvB9hfZsZ6Idri0w',   // The video API's `queryId`; update it here when it breaks after an X release.

    preferDocumentForOriginal: false,     // false=prioritize sendPhoto, true=prioritize sendDocument
    sendAsAlbum: true,                    // true=merge multiple images into an album; false=send them one by one
    debug: false,                         // When true, output detailed logs (never include complete Tokens).
};
```

| Configuration Item | Description |
| --- | --- |
| `telegramBotToken` | **Required**. Obtain from `@BotFather`, in the format `123456789:AAxxxx...` |
| `telegramChatId` | **Required**. Target channel ID, in the format `-1001234567890` |
| `preferDocumentForOriginal` | When `false`, `sendPhoto` is prioritized (previewable within the channel, but compressed by Telegram); when `true`, `sendDocument` is prioritized (retains original quality, but browsing experience is poorer) |
| `sendAsAlbum` | When `true`, multiple images are combined into one album and sent with the tweet link as the album caption; when `false`, they are sent sequentially one by one |
| `videoRequestTimeoutMs` | Timeout for video download. **Independent of `requestTimeoutMs`**, as videos of several dozen MB may not be fully downloaded in 30 seconds on a slow network |
| `graphqlQueryId` | The query ID for the video media address API. If it becomes invalid after a new X release ships, the script will automatically fall back and prompt to update this value |
| `debug` | Set to `true` when encountering issues; the console will output the Tweet ID, author, number of media items, download and request status, and retry count |

#### Two modes for sending multiple images

| Mode | Effect | Trade-off |
| --- | --- | --- |
| `sendAsAlbum: true` (default) | Images are merged into albums of at most 10, with the link caption on the first one | Only the chunk being sent (≤10 images) is held in memory, never the whole post; a failed chunk does not block the remaining ones |
| `sendAsAlbum: false` | Send each image independently, with the caption of the first successful image | Creates multiple separate messages in the channel, leading to a more fragmented browsing experience |

Chunking and fallback behavior (automatic, no configuration required):

- Up to 10 images → a single album (`sendMediaGroup` accepts 2–10 items only)
- More than 10 images → split into consecutive albums, with the caption on the first one only. Each chunk is downloaded, sent and released before the next one starts
- A chunk left with a single image (e.g. 11 images → 10 + 1) → sent with a plain `sendPhoto`
- An image in a chunk exceeds the `sendPhoto` limits → that chunk is sent one image at a time using the blobs already in memory, so nothing is downloaded twice
- Some images fail to download → they are skipped and the rest of the chunk is still sent
- A chunk fails (non-critical) → the remaining chunks are still attempted

#### The difference between sendPhoto and sendDocument

| Method | Advantage | Trade-off |
| --- | --- | --- |
| `sendPhoto` | Can be previewed directly within the channel | Telegram compresses it; **you won't receive the original file** |
| `sendDocument` | Preserves the original file | Poor browsing experience within the channel |

### Configure the Telegram Bot

#### Create a Bot

1. Find `@BotFather` on Telegram.
2. Send `/newbot`, then follow the prompts to set the name and username.
3. Note down the returned Token.

#### Add the Bot to the channel (all three criteria must be met)

The bot **must**:

1. Be added to the target channel
2. Have **admin** permissions
3. Have **Post Messages** permissions

Failure to meet any of these conditions will result in a `400 chat not found` or `403` error.

#### Get Channel Chat ID

1. Confirm that the Bot is already a channel administrator.
2. Post any message in the channel.
3. Open in your browser (replace `<token>`):

```text
https://api.telegram.org/bot<token>/getUpdates
```

4. In the returned JSON, locate `channel_post.chat.id`, which looks like `-1001234567890`.

> **Network Requirement:** The browser must be able to access `api.telegram.org`. If a direct connection fails (due to a reset), the browser must use a proxy.

### How it works

```text
Open X
  ↓
Find a tweet with an image / video / animated GIF (on the timeline or tweet details page)
  ↓
Click the Telegram button in the action bar
  ↓
Parse the tweet → extract author / tweet link / image / video
  ↓
Image: download into an in-memory Blob → send as an album or one by one (with caption)
  ↓
Video / animated GIF: resolve the media URL → pre-check size and pick a tier → download → send
  ↓
Release temporary resources
```

#### The handling paths for the three media types

| Media Type | Where the media URL comes from | Sending method | Fallback chain |
| --- | --- | --- | --- |
| Static image | DOM's `img.src` | `sendPhoto` | → `sendDocument` |
| **Animated GIF** (cover art uses `tweet_video_thumb`) | **The hash of the cover URL is directly concatenated**; zero API calls | `sendAnimation` | → `sendVideo` → `sendDocument` |
| **Video** | Authenticated GraphQL; falls back to the public API on failure | `sendVideo` | → `sendDocument` |

> Animated GIFs using `tweet_video_thumb` for cover art **do not call any API**; plain image tweets also do not.
> Only actual videos (and animated GIFs with a different cover path) initiate API requests.

#### Mixed text-and-image tweets are split into two messages

When a tweet includes both an image and a video:

```text
Message 1: Images (≥2 images use the album feature; 1 image uses the individual sendPhoto feature) + full caption (author / tweet link)
Message 2: Video or animated GIF, no caption
```

**Pure video tweets are unaffected by this**: When there are no image messages, the caption will be attached to the video, and the link won't be lost.

#### Button state

| Status | Appearance | Meaning |
| --- | --- | --- |
| Idle | Gray paper airplane | Can be sent |
| Sending | Blue rotating circle | Uploading; do not click repeatedly. The video will show its current stage (resolving URL / downloading / sending). |
| Success | Green checkmark | Sent successfully |
| Failure | Red warning | Send failed; can be clicked again to retry |

#### Repeated Send

- For tweets that have already been sent, clicking them again **will not** cause a re-upload; it will show the message "This tweet has already been sent".
- To force a re-send, use **Ctrl + click** (Cmd + click on macOS).
- After refreshing the page, the memory state is cleared, allowing you to send it again.

#### Caption format

```text
Author: https://x.com/username
Post: https://x.com/username/status/123456789
```

- The author link is a **required field**, sourced from the tweet's DOM and cannot be guessed from a numeric ID.
- If the tweet link fails to retrieve, it will be omitted; this **does not affect sending**.
- **Album mode** (`sendAsAlbum: true`): The caption serves as the overall description for the album and is placed only on the first album item.
- **Serial mode** (`sendAsAlbum: false`): The caption appears only on the **first successfully sent image**; if the first image fails, the caption shifts to the next successful image.
- **Pure video tweet**: The caption appears on the video (there are no image messages in this case; omitting it would result in losing the link).
- **Mixed text-image layout**: The caption appears on the image message, and video messages are not duplicated with it.

### Frequently Asked Questions

When encountering an issue, first set `debug` to `true` and open the browser console (F12) to check the logs.
The Bot Token in the logs should always be displayed as `<redacted>`; you can safely take a screenshot of it.

| Phenomenon | Resolution |
| --- | --- |
| "Telegram Bot Token is invalid" message | The token is either incorrectly entered or has expired. If necessary, regenerate it using `@BotFather` |
| "Telegram channel configuration error" / `400 chat not found` message | The Chat ID is incorrect, or the Bot is not part of that channel |
| "Bot lacks permission to send messages to this channel" message | Grant the Bot administrator and messaging permissions in the channel settings |
| "This tweet has no images or videos to send" message | The tweet only contains audio, or the media is a referenced tweet (both are unsupported) |
| "Image is too large" / "Video exceeds Telegram's 50 MB limit" message | The Telegram Bot upload limit is 50 MB; the script does not perform transcoding |
| "This tweet may be restricted content" message | The X login session has expired. Log in again and refresh the page; **this warning cannot be resolved by retrying** |
| "X login session has expired" message | The video API returns 401 / 403. Log in to X again |
| "Telegram rate limiting" message | A 429 error is triggered; the script will automatically wait and retry according to the server's `retry_after` value |
| Video overall slows down or quality decreases | The `graphqlQueryId` has broken after an X release, so the script has degraded to the public API (maximum 720p); the console will explicitly notify you of this change |
| Button does not appear / Clicking has no effect | Refresh the page; confirm the script is enabled; confirm the Token and Chat ID are correctly entered |
| Console warning "Bearer extraction failed" | The constant could not be retrieved from X's JS file. Refresh the page and retry; if this persists, please provide feedback |
| Video download is very slow or times out | The file is large or the network is slow. You can increase `videoRequestTimeoutMs` |

**Known Limitations**

- **Unsupported**: Audio, media from referenced tweets, self-assembled HLS segments, browser-side transcoding, any persistent media caching
- **Video and image limits of 50 MB**; `sendPhoto` is additionally restricted by 10 MB, total width/height ≤ 10000, and aspect ratio ≤ 20, and will be compressed by Telegram
- **Videos of restricted content depend on your X login session**; if it expires, you must log in again
- **`graphqlQueryId` breaks whenever X ships a release**; when it does, the script automatically degrades to the public API (maximum quality 1280x720), and the logs will indicate the update
- **Send history is not persisted**; state exists only in memory and is cleared upon page refresh
- **The runtime environment must have access to `api.telegram.org`**; otherwise, sending will fail
- **Album mode memory is capped per chunk**: only the chunk being sent (≤10 images) is held at any moment, and it is released right after. A 20-image post never holds 20 blobs at once

## Project Structure

```text
.
├── .gitignore
├── LICENSE
├── README.md                     # This file (English)
├── README.zh-CN.md               # Chinese version
└── userscripts/
    └── x-photo-to-tg.user.js     # Main script
```

## Security Notice

- Bot Tokens are sent exclusively to `api.telegram.org`, bypassing any third-party services.
- All Tokens in logs and error messages are uniformly masked with `<redacted>`.
- No telemetry, statistical services, or third-party image hosting services are used.
- Media is processed only in memory as `Blob` / `ArrayBuffer` and released after use; `Object URL` is immediately `revokeObjectURL`ed after usage.
- `@connect` only declares the domains actually needed; `@connect *` is not used.
- **Video media URLs are obtained via a same-origin request to X's official API**, using the browser's own login cookie (`credentials: 'include'`).
  The script **does not read, store, or expose** any credentials; HttpOnly `auth_token` that JS cannot access also does not need to be read.
- **No third-party download sources are introduced.** Early evaluated third-party API solutions have been rejected—they would expose download logs to third parties, while the logged-in session path offers better coverage and quality.
- The `Bearer` constant is extracted at runtime from X's own JS file; logs **only record the length**, never the value.

> Scripts that contain Tokens **should not** be submitted to version control repositories. The repository's `.gitignore` already ignores sensitive paths like `config.local.js`, `.env*`, and `secrets/`.
