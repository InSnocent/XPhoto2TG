// ==UserScript==
// @name         X Image to Telegram
// @name:zh-CN   X 推文图片发送到 Telegram
// @namespace    https://github.com/InSnocent/XPhoto2TG
// @version      2.0.0
// @description  在 X（Twitter）每条推文上增加 Telegram 按钮，将该推文的图片、视频与动图发送到指定 Telegram 频道
// @author       InSnocent
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.telegram.org
// @connect      pbs.twimg.com
// @connect      video.twimg.com
// @connect      cdn.syndication.twimg.com
// @connect      abs.twimg.com
// 注：图片由 pbs.twimg.com 提供，视频/动图本体由 video.twimg.com 提供；
//     公开接口兜底与 Bearer 提取各占一个域名。**不要用 @connect ***。
//     视频地址走的是「同源 fetch 到 x.com」，不需要也不应出现在这里。
//     若日志出现「下载失败：网络错误」，把报错中的域名按同样格式加一行即可。
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * X Image to Telegram — V2
 *
 * 数据流：
 *   X DOM → Tweet Parser → Tweet Object → Upload Manager
 *         → Image Downloader / Video Resolver → Telegram Client → Toast / State
 *
 * 三种媒体的地址来源完全不同，改动前先读第 9b 节顶部说明：
 *   图片  → DOM 的 img.src
 *   动图  → 封面 URL 的 hash 直接拼出直链，零接口调用
 *   视频  → 登录态同源 GraphQL，失败降级到公开接口
 *
 * 不支持：音频、引用推文媒体、自行拼装 HLS、浏览器端转码、任何持久化媒体缓存。
 */

(function () {
    'use strict';

    // ============================================================
    // 1. 配置 —— 所有配置集中在此
    // ============================================================
    const CONFIG = {
        // 从 @BotFather 获取，形如 123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        telegramBotToken: 'YOUR_BOT_TOKEN',

        // 目标频道 Chat ID，形如 -1001234567890
        telegramChatId: 'YOUR_CHANNEL_ID',

        maxRetries: 3,
        retryDelayMs: 1000,
        requestTimeoutMs: 30000,
        sendDelayMs: 800,

        // 视频下载的独立超时。默认的 30s 对几十 MB 的视频不够
        videoRequestTimeoutMs: 120000,

        // 通路 C 的 GraphQL queryId。X 发版后若失效会返回 404，
        // 脚本会自动降级到通路 A（syndication）并在日志中提示更新此值。
        graphqlQueryId: 'xd_EMdYvB9hfZsZ6Idri0w',

        // false → 优先 sendPhoto（频道内可预览，但会被 Telegram 压缩）
        // true  → 优先 sendDocument（保留原始文件，浏览体验较差）
        preferDocumentForOriginal: false,

        // true  → 多图合并为一个相册（album）一次发送，链接作为相册 caption
        // false → 多图逐张串行发送，caption 挂第一张成功的图
        // 注：这是对「多图逐张串行」的显式变更，代价见第 11 节顶部说明
        sendAsAlbum: true,

        // true 时输出详细日志（绝不含完整 Bot Token）
        debug: false,
    };

    const PLACEHOLDER_TOKEN = 'YOUR_BOT_TOKEN';
    const PLACEHOLDER_CHAT = 'YOUR_CHANNEL_ID';

    // Telegram 官方限制（已核实）
    const TG_LIMITS = {
        photoMaxBytes: 10 * 1024 * 1024,   // sendPhoto：10 MB
        documentMaxBytes: 50 * 1024 * 1024, // sendDocument：50 MB
        videoMaxBytes: 50 * 1024 * 1024,    // sendVideo / sendAnimation：50 MB
        photoMaxDimensionSum: 10000,        // 宽高总和
        photoMaxAspectRatio: 20,            // 宽高比
        captionMaxChars: 1024,
    };

    // 图片质量降级链
    const QUALITY_ORDER = ['orig', '4096x4096', 'large', 'medium'];

    // 视频各阶段的按钮文案。视频下载耗时长，
    // 用户需要能看到「卡在哪一步」，否则只会以为脚本死了。
    const VIDEO_STAGE_LABELS = {
        pending: '正在准备视频…',
        resolving: '正在解析视频地址…',
        downloading: '正在下载视频…',
        sending: '正在发送视频到 Telegram…',
        done: '视频已发送',
        failed: '视频发送失败',
    };

    // ============================================================
    // 2. 选择器（集中管理，便于 X 改版后调整）
    // ============================================================
    const SEL = {
        tweetPrimary: 'article[data-testid="tweet"]',
        tweetFallback: 'article[role="article"]',
        userName: '[data-testid="User-Name"]',
        tweetText: '[data-testid="tweetText"]',
        tweetPhoto: '[data-testid="tweetPhoto"]',
        videoPlayer: '[data-testid="videoPlayer"]',
        videoComponent: '[data-testid="videoComponent"]',
        like: '[data-testid="like"]',
        retweet: '[data-testid="retweet"]',
        statusLink: 'a[href*="/status/"]',
        actionGroup: '[role="group"]',
        ourButton: '[data-tg-button="1"]',
    };

    const RESERVED_PATHS = new Set([
        'i', 'home', 'explore', 'notifications', 'messages', 'settings',
        'search', 'compose', 'login', 'logout', 'tos', 'privacy', 'about',
    ]);

    const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

    const IS_READY = CONFIG.telegramBotToken !== PLACEHOLDER_TOKEN &&
        CONFIG.telegramChatId !== PLACEHOLDER_CHAT;

    // ============================================================
    // 3. 日志
    // ============================================================

    /** Token 脱敏，任何输出都必须经过它 */
    function redact(text) {
        if (text == null) return text;
        let s = String(text);
        if (CONFIG.telegramBotToken && CONFIG.telegramBotToken !== PLACEHOLDER_TOKEN) {
            s = s.split(CONFIG.telegramBotToken).join('<redacted>');
        }
        return s.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<redacted>');
    }

    function log(...args) {
        if (!CONFIG.debug) return;
        console.log('%c[XPhoto2TG]', 'color:#1d9bf0;font-weight:bold', ...args.map(redact));
    }

    function logError(...args) {
        // 错误始终输出，但同样脱敏
        console.error('[XPhoto2TG]', ...args.map(redact));
    }

    // ============================================================
    // 4. 样式与 Toast（不使用 alert）
    // ============================================================

    const STYLE = `
[data-tg-button="1"] {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 34px; height: 34px; border-radius: 50%;
    cursor: pointer; color: rgb(83,100,113);
    transition: background-color .2s, color .2s;
    outline: none; -webkit-tap-highlight-color: transparent;
}
[data-tg-button="1"]:hover { background-color: rgba(29,155,240,.1); color: rgb(29,155,240); }
[data-tg-button="1"][data-state="uploading"] { color: rgb(29,155,240); cursor: progress; }
[data-tg-button="1"][data-state="success"] { color: rgb(0,186,124); }
[data-tg-button="1"][data-state="error"] { color: rgb(244,33,46); }
[data-tg-button="1"][data-state="uploading"] svg { display: none; }
[data-tg-button="1"] .tg-spin { display: none; }
[data-tg-button="1"][data-state="uploading"] .tg-spin {
    display: block; width: 16px; height: 16px;
    border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: tg-spin .7s linear infinite;
}
@keyframes tg-spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) {
    [data-tg-button="1"] { color: rgb(113,118,123); }
}

#xphoto2tg-toasts {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2147483000; display: flex; flex-direction: column; gap: 8px;
    align-items: center; pointer-events: none;
}
.xphoto2tg-toast {
    max-width: min(420px, 90vw);
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    padding: 10px 16px; border-radius: 10px; color: #fff;
    background: rgba(15,20,25,.94); box-shadow: 0 4px 16px rgba(0,0,0,.35);
    word-break: break-word; pointer-events: auto;
    opacity: 0; transform: translateY(-6px);
    transition: opacity .18s, transform .18s;
}
.xphoto2tg-toast.show { opacity: 1; transform: translateY(0); }
.xphoto2tg-toast.success { background: rgb(0,150,100); }
.xphoto2tg-toast.error { background: rgb(200,30,45); }
.xphoto2tg-toast.info { background: rgba(15,20,25,.94); }
`;

    let toastHost = null;

    function toast(message, type, timeoutMs) {
        if (!toastHost || !document.body.contains(toastHost)) {
            toastHost = document.createElement('div');
            toastHost.id = 'xphoto2tg-toasts';
            document.body.appendChild(toastHost);
        }
        const el = document.createElement('div');
        el.className = 'xphoto2tg-toast ' + (type || 'info');
        el.textContent = message;
        toastHost.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));

        const ttl = timeoutMs || (type === 'error' ? 6000 : 3500);
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 250);
        }, ttl);
        return el;
    }

    // ============================================================
    // 5. 状态管理
    // ============================================================

    /**
     * Map<tweetId, {state, captionSent, lastError, videoState}> —— 仅内存，刷新即清空。
     * videoState：none | pending | resolving | downloading | sending | done | failed，
     * 用于区分「正在解析媒体地址」与「正在下载视频」两个阶段。
     */
    const tweetStates = new Map();

    function getState(tweetId) {
        if (!tweetStates.has(tweetId)) {
            tweetStates.set(tweetId, {
                state: 'idle', captionSent: false, lastError: null, videoState: 'none',
            });
        }
        return tweetStates.get(tweetId);
    }

    // ============================================================
    // 6. 上传队列（全局并发 = 1）
    // ============================================================

    let queueTail = Promise.resolve();

    function enqueue(task) {
        queueTail = queueTail.then(task).catch((err) => {
            logError('任务执行异常：', err && err.message ? err.message : err);
        });
        return queueTail;
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ============================================================
    // 7. GM_xmlhttpRequest 封装
    // ============================================================

    function gm(opts) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest(Object.assign({
                timeout: CONFIG.requestTimeoutMs,
                onload: (res) => resolve(res),
                onerror: () => resolve({ status: 0, _transport: 'network' }),
                ontimeout: () => resolve({ status: 0, _transport: 'timeout' }),
                onabort: () => resolve({ status: 0, _transport: 'abort' }),
            }, opts));
        });
    }

    function pickHeader(headers, name) {
        if (!headers) return null;
        const m = headers.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
        return m ? m[1].trim() : null;
    }

    // ============================================================
    // 8. Tweet DOM 解析
    // ============================================================

    function describeEl(el) {
        if (!el || el.nodeType !== 1) return String(el);
        const parts = [el.tagName.toLowerCase()];
        const testid = el.getAttribute('data-testid');
        const role = el.getAttribute('role');
        if (testid) parts.push(`[data-testid="${testid}"]`);
        if (role) parts.push(`[role="${role}"]`);
        return parts.join('');
    }

    /**
     * 引用卡片判定（已实测）：
     * role="link" 容器 且 内部含 User-Name。
     * 主推文图片外层是 <a role="link">，内部无 User-Name，因此不会被误杀。
     */
    function detectQuoteCard(img, article) {
        let el = img;
        let guard = 0;
        while (el && el !== article && guard++ < 60) {
            if (el.getAttribute && el.getAttribute('role') === 'link') {
                let hasUserName = false;
                try { hasUserName = !!el.querySelector(SEL.userName); } catch (e) { /* 忽略 */ }
                if (hasUserName) return true;
            }
            el = el.parentElement;
        }
        return false;
    }

    /** 硬排除：卡片图片 / 视频封面 / 头像 / emoji / 嵌套 article */
    function isExcluded(img, article) {
        let el = img;
        let guard = 0;
        while (el && el !== article && guard++ < 60) {
            const testid = el.getAttribute && el.getAttribute('data-testid');
            if (testid === 'card.wrapper') return '卡片图片';
            if (testid === 'videoPlayer' || testid === 'videoComponent') return '视频/动图封面';
            if (testid === 'User-Name' || (testid && testid.indexOf('UserAvatar') === 0)) return '头像';
            if (testid === 'tweetText') return 'emoji';
            el = el.parentElement;
        }
        const owner = img.closest('article');
        if (owner && owner !== article) return '嵌套推文媒体';
        return null;
    }

    /**
     * 引用推文 / 卡片 / 头像等「不属于当前推文」的判定。
     * 与 isExcluded 同源，但用于 video 元素（V1 的 isExcluded 只处理 img）。
     */
    function isForeignMedia(el, article) {
        let n = el;
        let guard = 0;
        while (n && n !== article && guard++ < 60) {
            const testid = n.getAttribute && n.getAttribute('data-testid');
            if (testid === 'card.wrapper') return '卡片内媒体';
            if (testid === 'User-Name' || (testid && testid.indexOf('UserAvatar') === 0)) return '头像';
            if (testid === 'tweetText') return '正文内嵌媒体';
            n = n.parentElement;
        }
        const owner = el.closest('article');
        if (owner && owner !== article) return '嵌套推文媒体';
        // 引用卡片：role="link" 容器且内部含 User-Name（与 detectQuoteCard 同一判据）
        n = el;
        guard = 0;
        while (n && n !== article && guard++ < 60) {
            if (n.getAttribute && n.getAttribute('role') === 'link') {
                let hasUserName = false;
                try { hasUserName = !!n.querySelector(SEL.userName); } catch (e) { /* 忽略 */ }
                if (hasUserName) return '引用推文媒体';
            }
            n = n.parentElement;
        }
        return null;
    }

    /** 动图封面：形如 pbs.twimg.com/tweet_video_thumb/<hash>.jpg */
    function gifHashFromPoster(url) {
        if (!url) return null;
        const m = /\/tweet_video_thumb\/([^/?#.]+)/.exec(url);
        return m ? m[1] : null;
    }

    /** 从封面 URL 取 media id（amplify_video_thumb / ext_tw_video_thumb 后的那一段） */
    function mediaIdFromPoster(url) {
        if (!url) return null;
        const m = /(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/([^/?#.]+)/.exec(url);
        return m ? m[1] : null;
    }

    /**
     * 动图封面不能当静态图发送——它属于视频路径。
     * 判据：src 是 tweet_video_thumb，或所在 tweetPhoto 容器内有 video。
     */
    function isAnimatedGifCover(img) {
        const src = img.currentSrc || img.src || '';
        if (/\/tweet_video_thumb\//.test(src)) return true;
        const tp = img.closest(SEL.tweetPhoto);
        return !!(tp && tp.querySelector('video'));
    }

    /**
     * 只取当前推文自己的视频 / 动图（排除引用推文、卡片、头像内媒体）。
     *
     * 判定依据：
     *   DOM 里 <video src> 是 blob:（MSE），拿不到真实媒体地址；
     *   但 <video poster> 带封面 URL，动图可由它的 hash 直接拼出本体地址。
     */
    function extractVideos(article) {
        const out = [];
        const seen = new Set();
        const push = (v) => {
            const key = v.mediaId || v.poster;
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(v);
        };

        // ① <video> 元素：动图与视频都在这里
        for (const v of article.querySelectorAll('video')) {
            if (isForeignMedia(v, article)) continue;
            const poster = v.getAttribute('poster') || v.poster || '';
            if (!poster) continue;

            const gifHash = gifHashFromPoster(poster);

            // 「动图」必须有正面证据：封面走 tweet_video_thumb。
            // 不能只看「位于 tweetPhoto 容器内」—— 真实视频的 <video> 也落在该容器里，
            // 曾因此把视频判成动图、用 sendAnimation 发出（消息会变成循环动图而非视频）。
            // 权威判据在 resolveVideoSource：那里按最终选定的媒体 URL 再判一次。
            push({
                type: gifHash ? 'animated_gif' : 'video',
                poster,
                mediaId: gifHash || mediaIdFromPoster(poster),
                // 动图封面 hash 与本体共用同一个 hash → 零接口调用
                directUrl: gifHash ? `https://video.twimg.com/tweet_video/${gifHash}.mp4` : null,
                inTweetPhoto: !!v.closest(SEL.tweetPhoto),
            });
        }

        // ② 兜底：videoPlayer 尚未渲染出 <video> 时，用容器内的封面图定位
        for (const p of article.querySelectorAll(SEL.videoPlayer)) {
            if (isForeignMedia(p, article)) continue;
            if (p.querySelector('video')) continue;   // ① 已处理
            for (const img of p.querySelectorAll('img')) {
                const src = img.currentSrc || img.src || '';
                const id = mediaIdFromPoster(src);
                if (!id) continue;
                push({ type: 'video', poster: src, mediaId: id, directUrl: null });
                break;
            }
        }

        return out;
    }

    function mediaKey(url) {
        try {
            const u = new URL(url, location.href);
            const m = u.pathname.match(/\/media\/([^/]+)/);
            return m ? m[1] : u.pathname;
        } catch (e) {
            return url;
        }
    }

    function profileNameFromHref(href) {
        if (!href) return null;
        let path = href;
        try {
            if (/^https?:\/\//i.test(href)) path = new URL(href).pathname;
        } catch (e) {
            return null;
        }
        const seg = path.split('/').filter(Boolean);
        if (seg.length !== 1) return null;
        const name = seg[0];
        if (RESERVED_PATHS.has(name.toLowerCase())) return null;
        if (!USERNAME_RE.test(name)) return null;
        return name;
    }

    function normalizeTweetUrl(href) {
        try {
            const u = new URL(href, location.href);
            const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
            if (m) return `https://x.com/${m[1]}/status/${m[2]}`;
            return u.href;
        } catch (e) {
            return href;
        }
    }

    function extractTweetId(article) {
        // 优先时间戳链接：主推文最可靠来源
        const timeEl = article.querySelector('time');
        if (timeEl) {
            const a = timeEl.closest('a[href*="/status/"]');
            if (a) {
                const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
                if (m) return m[1];
            }
        }
        const links = article.querySelectorAll(SEL.statusLink);
        for (const a of links) {
            const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
            if (m) return m[1];
        }
        return null;
    }

    /** 作者 URL 必须来自 DOM，不得用数字 ID 拼接 */
    function extractAuthorUrl(article) {
        const un = article.querySelector(SEL.userName);
        if (!un) return null;
        for (const a of un.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (href.includes('/status/')) continue;
            const name = profileNameFromHref(href);
            if (name) return `https://x.com/${name}`;
        }
        return null;
    }

    function extractTweetUrl(article, tweetId, authorUrl) {
        const timeEl = article.querySelector('time');
        if (timeEl) {
            const a = timeEl.closest('a[href*="/status/"]');
            if (a && a.getAttribute('href')) return normalizeTweetUrl(a.getAttribute('href'));
        }
        // 降级：作者 URL 已在手，可组装同一条推文的地址
        if (tweetId && authorUrl) {
            const name = authorUrl.split('/').pop();
            return `https://x.com/${name}/status/${tweetId}`;
        }
        return null;
    }

    /** 只取当前推文自己的静态图片，排除头像/emoji/卡片/视频/动图封面/引用推文 */
    function extractImages(article) {
        const out = [];
        const usedKeys = new Set();

        for (const img of article.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            if (!src || src.startsWith('data:')) continue;
            if (!img.closest(SEL.tweetPhoto)) continue;   // 必须在 tweetPhoto 容器内
            if (isAnimatedGifCover(img)) continue;        // 动图封面归视频路径
            if (isExcluded(img, article)) continue;
            if (detectQuoteCard(img, article)) continue;  // 引用推文媒体

            const key = mediaKey(src);
            if (usedKeys.has(key)) continue;              // 按媒体 ID 去重
            usedKeys.add(key);

            out.push({ src, mediaKey: key, alt: img.getAttribute('alt') || '' });
        }
        return out;
    }

    function parseTweet(article) {
        const tweetId = extractTweetId(article);
        if (!tweetId) return null;
        const authorUrl = extractAuthorUrl(article);
        const tweetUrl = extractTweetUrl(article, tweetId, authorUrl);
        const images = extractImages(article);
        const videos = extractVideos(article);
        return { tweetId, authorUrl, tweetUrl, images, videos, el: article };
    }

    function buildCaption(tweet) {
        const lines = [];
        if (tweet.authorUrl) lines.push(`Author: ${tweet.authorUrl}`);
        if (tweet.tweetUrl) lines.push(`Post: ${tweet.tweetUrl}`);
        let caption = lines.join('\n');
        if (caption.length > TG_LIMITS.captionMaxChars) {
            caption = caption.slice(0, TG_LIMITS.captionMaxChars - 3) + '...';
        }
        return caption;
    }

    // ============================================================
    // 9. 图片下载
    // ============================================================

    function qualityVariantsFor(src) {
        try {
            const u = new URL(src, location.href);
            if (!/(^|\.)twimg\.com$/.test(u.hostname)) return [];
            return QUALITY_ORDER
                .map((q) => {
                    const v = new URL(u.href);
                    v.searchParams.set('name', q);
                    return { label: q, url: v.href };
                })
                // 去掉与原 URL 完全相同的候选
                .filter((v) => v.url !== u.href);
        } catch (e) {
            return [];
        }
    }

    async function fetchOnce(url) {
        const res = await gm({ method: 'GET', url, responseType: 'arraybuffer' });
        if (res._transport) return { transport: res._transport };
        if (res.status !== 200) return { status: res.status };
        const contentType = pickHeader(res.responseHeaders, 'content-type') || 'application/octet-stream';
        const bytes = res.response ? res.response.byteLength : 0;
        if (!bytes) return { status: 0, empty: true };
        return { arrayBuffer: res.response, contentType, bytes };
    }

    /**
     * 按质量降级链下载；网络错误有限重试。
     * 返回 { blob, contentType, bytes }，调用方负责在 finally 中释放。
     */
    async function downloadImage(image) {
        const candidates = qualityVariantsFor(image.src).map((v) => v.url);
        candidates.push(image.src);   // 最终回退到 DOM 中的原始 URL

        let lastError = null;
        for (const url of candidates) {
            for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
                log(`下载尝试 url=${redact(url)} attempt=${attempt}`);
                const r = await fetchOnce(url);

                if (r.arrayBuffer) {
                    if (r.bytes > TG_LIMITS.documentMaxBytes) {
                        // 超过 sendDocument 上限，换更小的档位
                        lastError = new Error(`图片过大（${formatBytes(r.bytes)}）`);
                        log(`该档位过大（${formatBytes(r.bytes)}），尝试下一档位`);
                        break;
                    }
                    const blob = new Blob([r.arrayBuffer], { type: r.contentType });
                    return { blob, contentType: r.contentType, bytes: r.bytes, url };
                }

                if (r.status === 404) {
                    log('该质量档位不存在（404），降级');
                    break;   // 换下一档位，不计入普通重试
                }

                lastError = new Error(r.transport ? `网络错误（${r.transport}）` : `HTTP ${r.status}`);
                if (attempt < CONFIG.maxRetries) {
                    const wait = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                    log(`下载失败：${lastError.message}，${wait}ms 后重试`);
                    await sleep(wait);
                }
            }
        }
        throw lastError || new Error('图片获取失败');
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    /** 读取图片尺寸，用于 sendPhoto 的本地预检查 */
    async function readDimensions(blob) {
        try {
            if (typeof createImageBitmap === 'function') {
                const bmp = await createImageBitmap(blob);
                const dim = { width: bmp.width, height: bmp.height };
                if (bmp.close) bmp.close();
                return dim;
            }
        } catch (e) {
            log('createImageBitmap 失败，回退到 Image + ObjectURL');
        }
        // 回退：Object URL 必须 revoke
        return new Promise((resolve) => {
            let objectUrl = null;
            const done = (dim) => {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve(dim);
            };
            try {
                objectUrl = URL.createObjectURL(blob);
                const im = new Image();
                im.onload = () => done({ width: im.naturalWidth, height: im.naturalHeight });
                im.onerror = () => done(null);
                im.src = objectUrl;
            } catch (e) {
                done(null);
            }
        });
    }

    /** sendPhoto 三重限制的本地预检查，避免一次必然失败的往返 */
    async function photoPrecheck(blob, dims) {
        if (blob.size > TG_LIMITS.photoMaxBytes) {
            return `文件 ${formatBytes(blob.size)} 超过 sendPhoto 上限 10 MB`;
        }
        const d = dims || await readDimensions(blob);
        if (!d) return null;   // 读不到尺寸就不拦，交给服务端判断
        const sum = d.width + d.height;
        if (sum > TG_LIMITS.photoMaxDimensionSum) {
            return `宽高总和 ${sum} 超过上限 10000`;
        }
        const ratio = d.width > d.height ? d.width / d.height : d.height / d.width;
        if (ratio > TG_LIMITS.photoMaxAspectRatio) {
            return `宽高比 ${ratio.toFixed(1)} 超过上限 20`;
        }
        return null;
    }

    // ============================================================
    // 9b. 视频 / 动图：媒体地址解析与下载
    //
    // 三条路线的分工：
    //   动图 → 封面 hash 直接拼 /tweet_video/<hash>.mp4，零接口调用
    //   视频 → 通路 C（登录态同源 GraphQL），失败再降级通路 A（公开接口）
    //
    // 【三种请求机制不可混用，看起来重复但各有原因】
    //   通路 C：同源 fetch + credentials:'include'（必须让浏览器自动带 HttpOnly Cookie）
    //   通路 A：GM_xmlhttpRequest（跨域，fetch 会被 CORS 拦截）
    //   媒体下载：GM_xmlhttpRequest + arraybuffer
    // ============================================================

    // features 参数。实测只有下列组合返回 200，改这里之前请先在浏览器里验证
    const GRAPHQL_FEATURES = {
        creator_subscriptions_tweet_preview_api_enabled: true,
        tweetypie_unmention_optimization_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: false,
        tweet_awards_web_tipping_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        rweb_video_screen_enabled: false,
    };

    // variables：实测只有这一组通过，其余组合一律 422
    function graphqlVariables(tweetId) {
        return {
            focalTweetId: tweetId,
            with_rux_injections: false,
            includePromotedContent: false,
            withCommunity: false,
            withQuickPromoteEligibilityTweetFields: true,
            withBirdwatchNotes: true,
            withVoice: true,
            withV2Timeline: true,
        };
    }

    function readCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return m ? m[1] : null;
    }

    /**
     * Bearer 是 X 前端的公开常量，从 abs.twimg.com 的 main.*.js 里取。
     * 不硬编码：X 换版后该常量会变，而这里每次页面加载只取一次并缓存（懒加载，
     * 纯图片推文永远不会触发这次下载）。
     * 注意：只记录长度，绝不把 Bearer 写进日志。
     */
    let bearerPromise = null;

    function getBearer() {
        if (!bearerPromise) {
            bearerPromise = extractBearer().catch(() => null);
        }
        return bearerPromise;
    }

    async function extractBearer() {
        const urls = Array.from(document.querySelectorAll('script[src]'))
            .map((s) => s.src)
            .filter((u) => /abs\.twimg\.com/.test(u));
        // main.*.js 优先，Bearer 就在里面
        urls.sort((a, b) => (b.includes('main') ? 1 : 0) - (a.includes('main') ? 1 : 0));

        for (const url of urls.slice(0, 6)) {
            const res = await gm({
                method: 'GET', url, responseType: 'text',
                timeout: CONFIG.videoRequestTimeoutMs,
            });
            if (!res || res.status !== 200 || !res.responseText) continue;
            const m = /["'](AAAAAAAAAAAAAAAAAAAAA[^"']{20,200})["']/.exec(res.responseText)
                || /bearer\s+([A-Za-z0-9%._-]{80,200})/i.exec(res.responseText);
            if (m) {
                log(`Bearer 提取成功（长度 ${m[1].length}，来源 ${String(url).split('/').pop()}）`);
                return m[1];
            }
        }
        log('Bearer 提取失败，通路 C 不可用');
        return null;
    }

    /**
     * 通路 C：登录态同源 GraphQL。
     * @returns {{json?:object, reason?:string, fatal?:boolean}}
     */
    async function fetchViaGraphQL(tweetId) {
        const ct0 = readCookie('ct0');
        if (!ct0) return { reason: 'no-csrf' };

        const bearer = await getBearer();
        if (!bearer) return { reason: 'no-bearer' };

        const url = `https://x.com/i/api/graphql/${CONFIG.graphqlQueryId}/TweetDetail`
            + `?variables=${encodeURIComponent(JSON.stringify(graphqlVariables(tweetId)))}`
            + `&features=${encodeURIComponent(JSON.stringify(GRAPHQL_FEATURES))}`;

        let res;
        try {
            res = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    authorization: `Bearer ${bearer}`,
                    'x-csrf-token': ct0,
                    'x-twitter-active-user': 'yes',
                    'x-twitter-auth-type': 'OAuth2Session',
                    'x-twitter-client-language': 'en',
                    accept: '*/*',
                },
            });
        } catch (e) {
            return { reason: 'network', message: e && e.message ? e.message : String(e) };
        }

        // 401/403 是凭据问题，降级也救不回来，直接告诉用户
        if (res.status === 401 || res.status === 403) return { reason: `http-${res.status}`, fatal: true };

        // 404 = queryId 失效，422 = 参数签名变了。都只说明「这条通路坏了」，
        // 不代表视频功能坏了 → 降级通路 A
        if (res.status === 404 || res.status === 422) {
            logError(`通路 C 返回 HTTP ${res.status}（queryId 或参数已失效），降级到通路 A`);
            return { reason: `http-${res.status}` };
        }
        if (res.status !== 200) return { reason: `http-${res.status}` };

        let json = null;
        let text = '';
        try {
            text = await res.text();
            json = JSON.parse(text);
        } catch (e) { /* 非 JSON */ }
        if (!json) return { reason: 'bad-json', text };
        return { json, text };
    }

    /**
     * 递归收集响应里所有带 variants 的媒体节点。
     * 不写死嵌套路径——X 换版时只要字段名不变就仍然有效。
     */
    function collectMediaNodes(root) {
        const found = [];
        const seen = new Set();
        const dig = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 40) return;
            if (Array.isArray(node)) {
                for (const it of node) dig(it, depth + 1);
                return;
            }
            if (seen.has(node)) return;
            seen.add(node);

            const info = node.video_info || node.videoInfo;
            if (info && Array.isArray(info.variants) && info.variants.length) {
                found.push({
                    id: node.id_str != null ? String(node.id_str) : null,
                    key: node.media_key != null ? String(node.media_key) : null,
                    poster: node.media_url_https || node.mediaUrl || null,
                    variants: info.variants,
                });
                return;   // 命中即可，不再下探
            }
            for (const k in node) {
                if (Object.prototype.hasOwnProperty.call(node, k)) dig(node[k], depth + 1);
            }
        };
        dig(root, 0);
        return found;
    }

    /**
     * 挑出属于本条推文的那一个媒体节点。
     *
     * 为什么必须按 id 匹配：TweetDetail 返回的是整个会话时间线，
     * 回复里的视频也出现在同一个响应里，不匹配就会发错视频。
     */
    function pickMediaNode(json, mediaId) {
        const nodes = collectMediaNodes(json);
        if (!nodes.length) return { nodes, node: null };

        if (mediaId) {
            const hit = nodes.find((n) => n.id === String(mediaId)
                || (n.key && n.key.endsWith('_' + mediaId)));
            if (hit) return { nodes, node: hit };
        }
        // 只有一个候选时可以直接用；多个候选又对不上就宁可报错，不发错视频
        if (nodes.length === 1) return { nodes, node: nodes[0] };
        return { nodes, node: null };
    }

    /**
     * mp4 变体排序。
     * 通路 A 的变体带 bitrate，通路 C 的不带，
     * 因此统一按 URL 里的 /avc1/<W>x<H>/ 面积降序，面积相同再比 bitrate。
     */
    function rankVariants(variants) {
        return variants
            .filter((v) => v && typeof v.url === 'string'
                && /video\/mp4/i.test(v.content_type || v.contentType || ''))
            .map((v) => {
                const m = /\/(\d+)x(\d+)\//.exec(v.url);
                const w = m ? Number(m[1]) : 0;
                const h = m ? Number(m[2]) : 0;
                return { url: v.url, w, h, area: w * h, bitrate: Number(v.bitrate || 0) };
            })
            .sort((a, b) => (b.area - a.area) || (b.bitrate - a.bitrate));
    }

    /**
     * 通路 A：公开接口兜底。跨域，必须用 GM_xmlhttpRequest。
     * 注意 TweetTombstone 返回的是 HTTP 200，必须解析响应体才能识别，
     * 且它稳定拒绝、重试无效，所以不重试。
     */
    async function fetchViaSyndication(tweetId) {
        const url = 'https://cdn.syndication.twimg.com/tweet-result'
            + `?id=${encodeURIComponent(tweetId)}&lang=en&token=a`;

        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            const res = await gm({ method: 'GET', url, responseType: 'text' });

            if (res._transport) {
                if (attempt < CONFIG.maxRetries) {
                    const wait = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                    log(`通路 A 网络错误（${res._transport}），${wait}ms 后重试`);
                    await sleep(wait);
                    continue;
                }
                return { reason: 'network' };
            }

            if (res.status === 429) {
                const ra = Number(pickHeader(res.responseHeaders, 'retry-after')) || 5;
                log(`通路 A 遇 429，按 retry-after 等待 ${ra}s`);
                if (attempt < CONFIG.maxRetries) { await sleep(ra * 1000 + 500); continue; }
                return { reason: 'flood' };
            }

            if (res.status === 404) return { reason: 'notFound' };
            if (res.status !== 200) return { reason: `http-${res.status}` };

            let json = null;
            try { json = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
            if (!json) return { reason: 'bad-json' };

            if (json.__typename === 'TweetTombstone') return { reason: 'tombstone' };
            if (!json.__typename && !json.mediaDetails) return { reason: 'notFound' };

            return { json, text: res.responseText };
        }
        return { reason: 'retryExhausted' };
    }

    /**
     * 从原始响应文本里直接抓 MP4 直链。
     *
     * 这不是「顺手写的兜底」，而是**唯一被实测证明过**的提取方式。
     * 结构化解析依赖 `video_info` / `variants` 这些字段名，而字段名**从未实测**；
     * 一旦 X 改了嵌套结构，正则仍能工作而结构解析会空手而归。
     * 两条路都保留，先试结构化，空手而归时再退到这里。
     *
     * 媒体 id 就在 URL 路径里（`/amplify_video/<id>/...`、`/tweet_video/<hash>.mp4`），
     * 因此可以据此过滤，避免把回复里别人的视频抓进来。
     */
    function rawMp4UrlsFromText(text, mediaId, nodeCount) {
        if (!text) return [];
        const all = Array.from(new Set(
            text.match(/https:\/\/video\.twimg\.com\/[^"\\]+?\.mp4[^"\\]*/g) || []));

        if (mediaId) {
            const mine = all.filter((u) => u.indexOf('/' + mediaId + '/') !== -1
                || u.indexOf('/' + mediaId + '.') !== -1);
            if (mine.length) return mine;
        }
        // 结构解析一个视频节点都没找到、且全部 URL 指向同一个媒体时才敢用
        if (nodeCount <= 1) {
            const ids = new Set(all
                .map((u) => (/\/(?:amplify_video|ext_tw_video)\/(\d+)\//.exec(u) || [])[1])
                .filter(Boolean));
            if (ids.size <= 1) return all;
        }
        return [];
    }

    function asVariants(urls) {
        return urls.map((url) => ({ url, content_type: 'video/mp4' }));
    }

    /**
     * 失败文案（三种「拿不到」必须区分开，
     * 否则用户无法判断该换个方式还是这条推文没救了）。
     */
    function mediaLookupError(aReason, cReason) {
        switch (aReason) {
            case 'tombstone': return '该推文可能为受限内容，无法通过公开接口获取';
            case 'notFound': return '推文不存在或不可见';
            case 'no-match': return '未找到可下载的视频';
            case 'flood': return '接口限流，请稍后重试';
            case 'bad-json': return '接口返回内容无法解析';
            case 'network':
            case 'retryExhausted': return '网络错误，无法获取视频地址';
            default: break;
        }
        if (aReason && aReason.indexOf('http-') === 0) return `接口返回 HTTP ${aReason.slice(5)}`;
        if (cReason && cReason.indexOf('http-') === 0) return `接口返回 HTTP ${cReason.slice(5)}`;
        return '未能获取视频地址';
    }

    /**
     * 下载前体积预检：Range: bytes=0-0 → 206 + content-range 里的总大小。
     * 若服务端忽略 Range 直接返回 200，说明整个文件已经在手，
     * 此时把 buffer 一并带出，避免白下一遍。
     */
    async function probeSize(url) {
        const res = await gm({
            method: 'GET', url, responseType: 'arraybuffer',
            headers: { Range: 'bytes=0-0' },
            timeout: CONFIG.videoRequestTimeoutMs,
        });
        if (res._transport) return { transport: res._transport };
        if (res.status !== 200 && res.status !== 206) return { status: res.status };

        const contentType = pickHeader(res.responseHeaders, 'content-type') || 'video/mp4';

        if (res.status === 200) {
            const bytes = res.response ? res.response.byteLength : 0;
            return bytes ? { total: bytes, contentType, prefetched: res.response } : { status: 0 };
        }

        const cr = pickHeader(res.responseHeaders, 'content-range');
        const m = cr ? /bytes\s+\d+-\d+\/(\d+)/i.exec(cr) : null;
        // 206 的 content-length 只是这一小段的长度，不能当总大小用
        return { total: m ? Number(m[1]) : null, contentType };
    }

    /**
     * 视频下载。与 downloadImage 分开：
     * 图片有 10 MB 档位判断与质量降级链，视频没有、也不该复用那条已验证的路径。
     */
    async function downloadVideo(url, prefetched) {
        if (prefetched) {
            const bytes = prefetched.byteLength;
            if (bytes > TG_LIMITS.videoMaxBytes) {
                throw new Error(`视频超过 Telegram 50 MB 上限（${formatBytes(bytes)}）`);
            }
            return { blob: new Blob([prefetched], { type: 'video/mp4' }), contentType: 'video/mp4', bytes };
        }

        let lastError = null;
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            log(`视频下载尝试 attempt=${attempt}`);
            const res = await gm({
                method: 'GET', url, responseType: 'arraybuffer',
                timeout: CONFIG.videoRequestTimeoutMs,
            });

            if (!res._transport && (res.status === 200 || res.status === 206)
                && res.response && res.response.byteLength) {
                const contentType = pickHeader(res.responseHeaders, 'content-type') || 'video/mp4';
                const bytes = res.response.byteLength;
                if (bytes > TG_LIMITS.videoMaxBytes) {
                    throw new Error(`视频超过 Telegram 50 MB 上限（${formatBytes(bytes)}）`);
                }
                return { blob: new Blob([res.response], { type: contentType }), contentType, bytes };
            }

            lastError = new Error(res._transport
                ? (res._transport === 'timeout' ? '视频下载超时' : `网络错误（${res._transport}）`)
                : `HTTP ${res.status}`);
            if (attempt < CONFIG.maxRetries) {
                const wait = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                log(`视频下载失败：${lastError.message}，${wait}ms 后重试`);
                await sleep(wait);
            }
        }
        throw lastError || new Error('视频下载失败');
    }

    /** 取封面 URL 的一级路径段，仅用于日志排查 */
    function posterHint(url) {
        const m = /\/(tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\//.exec(url || '');
        return m ? m[1] : (url ? '其他' : '无');
    }

    /**
     * 由【最终选定的媒体 URL】判定类型 —— 这是唯一不会骗人的判据。
     *
     *   /tweet_video/        → 动图（X 的动图专用扁平路径）
     *   /amplify_video/ 等   → 视频
     *
     * 为什么不靠 DOM：真机实测发现真实视频的 `<video>` 同样落在 tweetPhoto 容器里，
     * 只凭 DOM 会把视频误判成动图。
     *
     * **方向很关键**：把视频当动图发会「静默丢掉音轨」，
     * 把动图当视频发只是不循环播放。因此只有明确的 /tweet_video/ 才判为动图。
     */
    function kindFromUrl(url) {
        return /\/tweet_video\//.test(url || '') ? 'animated_gif' : 'video';
    }

    /**
     * 完整解析一条视频/动图：地址 → 选流 → 体积预检。
     * @returns {{kind:string, url:string, expectedBytes:number|null, prefetched:ArrayBuffer|undefined, source:string}}
     */
    async function resolveVideoSource(tweet, media) {
        // 把 DOM 判据原样记下来，真机排查时能一眼看出是哪条判据生效
        log(`媒体解析：DOM 判定=${media.type}，封面路径=${posterHint(media.poster)}`
            + `，容器=${media.inTweetPhoto ? 'tweetPhoto' : '其他'}`
            + `，动图直链=${media.directUrl ? '有' : '无'}`);

        // ① 动图：封面 hash 直接拼地址，不调任何接口
        if (media.directUrl) {
            log(`动图直链（未调用接口）：${media.directUrl}`);
            const size = await probeSize(media.directUrl);
            if (size.transport) throw new Error(`视频地址探测失败：网络错误（${size.transport}）`);
            if (size.status) throw new Error(`视频地址不可用（HTTP ${size.status}）`);
            if (size.total != null && size.total > TG_LIMITS.videoMaxBytes) {
                throw new Error(`视频超过 Telegram 50 MB 上限（${formatBytes(size.total)}）`);
            }
            return {
                kind: kindFromUrl(media.directUrl), url: media.directUrl, expectedBytes: size.total,
                prefetched: size.prefetched, source: '动图直链',
            };
        }

        // ② 视频：通路 C（登录态 GraphQL）→ 通路 A（syndication）逐级降级
        const c = await fetchViaGraphQL(tweet.tweetId);
        if (c.fatal) throw new Error('X 登录态已失效，请重新登录后刷新页面');

        let variants = null;
        let source = null;

        if (c.json) {
            const p = pickMediaNode(c.json, media.mediaId);
            if (p.node) {
                variants = p.node.variants;
                source = 'C';
            } else {
                logError(`通路 C 结构解析未匹配到 mediaId=${media.mediaId}`
                    + `（共 ${p.nodes.length} 个视频节点），改用原始文本提取`);
                const raw = rawMp4UrlsFromText(c.text, media.mediaId, p.nodes.length);
                if (raw.length) { variants = asVariants(raw); source = 'C·文本'; }
            }
        }

        let aReason = null;
        if (!variants) {
            log(`通路 C 不可用（${c.reason || '未匹配到媒体'}），降级到通路 A`);
            const a = await fetchViaSyndication(tweet.tweetId);
            if (a.json) {
                const p = pickMediaNode(a.json, media.mediaId);
                if (p.node) {
                    variants = p.node.variants;
                    source = 'A';
                } else {
                    const raw = rawMp4UrlsFromText(a.text, media.mediaId, p.nodes.length);
                    if (raw.length) { variants = asVariants(raw); source = 'A·文本'; }
                    else aReason = 'no-match';
                }
            } else {
                aReason = a.reason;
            }
        }

        if (!variants || !variants.length) throw new Error(mediaLookupError(aReason, c.reason));

        // ③ 选流 + 体积预检：档位已按面积降序，取第一个不超过 50 MB 的
        const ranked = rankVariants(variants);
        if (!ranked.length) throw new Error('未找到可下载的视频');

        let lastProbed = null;
        for (const v of ranked) {
            const size = await probeSize(v.url);
            if (size.transport || size.status) {
                log(`档位 ${v.w}x${v.h} 不可用（${
                    size.transport ? '网络错误 ' + size.transport : 'HTTP ' + size.status}），尝试下一档`);
                continue;
            }
            lastProbed = { v, total: size.total };
            if (size.total != null && size.total > TG_LIMITS.videoMaxBytes) {
                log(`档位 ${v.w}x${v.h} 为 ${formatBytes(size.total)}，超过 50 MB 上限，尝试下一档`);
                continue;
            }
            const kind = kindFromUrl(v.url);
            log(`选定档位 ${v.w}x${v.h}${size.total != null ? '，' + formatBytes(size.total) : ''}`
                + `（来源：通路 ${source}，判定：${kind === 'animated_gif' ? '动图' : '视频'}）`);
            return { kind, url: v.url, expectedBytes: size.total, prefetched: size.prefetched, source };
        }

        if (lastProbed && lastProbed.total != null) {
            throw new Error(`视频超过 Telegram 50 MB 上限（最小档 ${formatBytes(lastProbed.total)}）`);
        }
        throw new Error('未找到可下载的视频');
    }

    // ============================================================
    // 10. Telegram 客户端
    // ============================================================

    function apiUrl(method) {
        return `https://api.telegram.org/bot${CONFIG.telegramBotToken}/${method}`;
    }

    function parseTg(res) {
        if (res._transport) return { transport: res._transport };
        let json = null;
        try { json = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
        return {
            httpStatus: res.status,
            json,
            ok: !!(json && json.ok),
            description: json ? json.description : null,
            errorCode: json ? json.error_code : null,
            retryAfter: json && json.parameters ? json.parameters.retry_after : null,
            rawText: res.responseText,
        };
    }

    /** 把 Telegram 错误映射成用户可读提示 */
    function mapTelegramError(r) {
        if (r.transport) {
            return { kind: 'transport', message: r.transport === 'timeout' ? '请求超时' : '网络错误' };
        }
        switch (r.httpStatus) {
            case 401:
                return { kind: 'auth', message: 'Telegram Bot Token 无效' };
            case 400:
                return {
                    kind: 'badRequest',
                    message: 'Telegram 频道配置错误，请检查 Chat ID',
                    detail: r.description,
                };
            case 403:
                return { kind: 'forbidden', message: 'Bot 没有向该频道发送消息的权限' };
            case 429:
                return {
                    kind: 'flood',
                    message: r.retryAfter != null
                        ? `Telegram 限流，等待 ${r.retryAfter} 秒后重试`
                        : 'Telegram 限流，稍后重试',
                    retryAfter: r.retryAfter,
                };
            case 413:
                return { kind: 'tooLarge', message: '图片过大，Telegram 拒绝接收' };
            default:
                return {
                    kind: 'other',
                    message: `Telegram API 错误（HTTP ${r.httpStatus}）`,
                    detail: r.description,
                };
        }
    }

    /** 判断 400 是否属于「照片被拒」从而可以降级到 sendDocument */
    function isPhotoRejection(r) {
        if (r.httpStatus === 413) return true;
        if (r.httpStatus !== 400) return false;
        const d = (r.description || '').toLowerCase();
        return /photo|image|dimension|width|height|aspect|process/.test(d);
    }

    function fileExtension(contentType) {
        const map = {
            'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
            'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
        };
        return map[(contentType || '').toLowerCase()] || 'jpg';
    }

    /**
     * 发送一张图片：优先 sendPhoto，必要时降级 sendDocument。
     * 429 使用服务端 retry_after，不覆盖为本地固定延迟。
     */
    /** 判断 400 是否属于「视频被拒」从而可以降级到下一个发送方法 */
    function isVideoRejection(r) {
        if (r.httpStatus === 413) return true;
        if (r.httpStatus !== 400) return false;
        const d = (r.description || '').toLowerCase();
        return /video|animation|media|document|format|mime|duration|dimension|process|file/.test(d);
    }

    /**
     * 单次发送尝试：含 429 退避与网络重试，图片与视频共用。
     * 与 V1 的唯一差别是把「照片被拒」泛化成可注入的 isRejection 判据；
     * 判据的检查时机（flood 之后、鉴权之前）与 V1 完全一致。
     */
    async function uploadFile(method, field, blob, filename, caption, isRejection) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            const form = new FormData();
            form.append('chat_id', CONFIG.telegramChatId);
            if (caption) form.append('caption', caption);
            // 不手动设置 Content-Type，交给 GM_xmlhttpRequest 生成 boundary
            form.append(field, blob, filename);

            const res = await gm({ method: 'POST', url: apiUrl(method), data: form });
            const r = parseTg(res);

            if (r.ok) return { ok: true, messageId: r.json.result.message_id };

            const mapped = mapTelegramError(r);

            if (mapped.kind === 'flood') {
                // 必须使用服务端给出的 retry_after，不用本地固定延迟覆盖
                const waitMs = (mapped.retryAfter != null ? mapped.retryAfter : 5) * 1000 + 500;
                log(`${method} 遇 429，按服务端 retry_after 等待 ${waitMs}ms`);
                if (attempt < CONFIG.maxRetries) {
                    await sleep(waitMs);
                    continue;
                }
                // 反复等待后仍被限流，继续发后续媒体只会继续撞墙，中止本批
                return { ok: false, error: mapped, response: r, fatal: true };
            }

            // 被本方法拒绝 → 交给上层降级，不在这里重试
            if (isRejection && isRejection(r)) {
                return { ok: false, error: mapped, response: r, rejected: true };
            }

            // 鉴权/权限/配置类错误重试没有意义
            if (mapped.kind === 'auth' || mapped.kind === 'forbidden' || mapped.kind === 'badRequest') {
                return { ok: false, error: mapped, response: r, fatal: true };
            }

            if (attempt < CONFIG.maxRetries) {
                const wait = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                log(`${method} 失败：${mapped.message}，${wait}ms 后重试`);
                await sleep(wait);
                continue;
            }
            return { ok: false, error: mapped, response: r };
        }
        return { ok: false, error: { kind: 'retryExhausted', message: '重试次数已用尽' } };
    }

    /**
     * 发送一张图片：优先 sendPhoto，必要时降级 sendDocument。
     * 429 使用服务端 retry_after，不覆盖为本地固定延迟。
     */
    async function sendImageToTelegram(blob, contentType, mediaKey, caption) {
        const filename = `x-${mediaKey}.${fileExtension(contentType)}`;
        const trySend = (method, field) => uploadFile(
            method, field, blob, filename, caption,
            method === 'sendPhoto' ? isPhotoRejection : null);

        // ---- 决定首选方式 ----
        if (CONFIG.preferDocumentForOriginal) {
            const doc = await trySend('sendDocument', 'document');
            if (doc.ok) return { ok: true, method: 'sendDocument', messageId: doc.messageId };
            return doc;
        }

        // 本地预检查：不通过则直接走 sendDocument
        const dims = await readDimensions(blob);
        const precheckFail = await photoPrecheck(blob, dims);
        if (precheckFail) {
            log(`sendPhoto 预检查未通过：${precheckFail}，改用 sendDocument`);
            const doc = await trySend('sendDocument', 'document');
            if (doc.ok) return { ok: true, method: 'sendDocument', messageId: doc.messageId, downgraded: precheckFail };
            return doc;
        }

        const photo = await trySend('sendPhoto', 'photo');
        if (photo.ok) return { ok: true, method: 'sendPhoto', messageId: photo.messageId };

        if (photo.rejected && !photo.fatal) {
            log('sendPhoto 被拒，降级 sendDocument');
            const doc = await trySend('sendDocument', 'document');
            if (doc.ok) return { ok: true, method: 'sendDocument', messageId: doc.messageId, downgraded: 'sendPhoto 被 Telegram 拒绝' };
            return doc;
        }

        return photo;
    }

    /**
     * 发送视频 / 动图。
     *
     * 降级链：
     *   动图 → sendAnimation → sendVideo → sendDocument
     *   视频 → sendVideo                → sendDocument
     * 三个方法对同一段 MP4 的接受度依次放宽，因此即使 DOM 的动图/视频判据出错，
     * 也只是多一次往返，不会导致任务失败。
     */
    async function sendVideoToTelegram(blob, contentType, mediaKey, kind, caption) {
        const ext = /webm/i.test(contentType || '') ? 'webm' : 'mp4';
        const filename = `x-${mediaKey}.${ext}`;
        const chain = kind === 'animated_gif'
            ? [['sendAnimation', 'animation'], ['sendVideo', 'video'], ['sendDocument', 'document']]
            : [['sendVideo', 'video'], ['sendDocument', 'document']];

        let last = null;
        for (let i = 0; i < chain.length; i++) {
            const method = chain[i][0];
            const r = await uploadFile(method, chain[i][1], blob, filename, caption, isVideoRejection);
            if (r.ok) {
                return {
                    ok: true, method, messageId: r.messageId,
                    downgraded: i > 0 ? `${chain[i - 1][0]} 被 Telegram 拒绝` : null,
                };
            }
            last = r;

            // 凭据 / 权限 / 限流耗尽：换方法也一样失败，立即中止
            const errKind = r.error ? r.error.kind : null;
            if (errKind === 'auth' || errKind === 'forbidden' || errKind === 'flood') return r;
            // 非「被拒」类错误（网络等）也不该靠换方法解决
            if (!r.rejected) return r;

            if (i < chain.length - 1) log(`${method} 被拒，降级到 ${chain[i + 1][0]}`);
        }
        return last;
    }

    // ============================================================
    // 11. 上传任务编排
    //
    // 【相册模式的代价 —— 这是 CONFIG.sendAsAlbum 的已知取舍】
    //   1. 相册要求所有图片在【同一个请求】中提交，因此必须先把全部图片读入内存。
    //      X 单条推文最多 4 图，按 sendPhoto 上限 10 MB 估算峰值约 40 MB。
    //   2. 相册是「全有或全无」，无法像串行那样部分成功，失败时退回串行路径。
    //   3. sendMediaGroup 要求 2-10 项，故单图推文仍走单张 sendPhoto。
    //   4. 相册内不能混排 photo 与 document，故若有图片超出 sendPhoto 限制，
    //      整体退回串行（由串行路径逐张各自降级）。
    //   设为 false 即退回「逐张串行、caption 挂第一张成功的图」。
    // ============================================================

    function releaseAll(held) {
        for (const h of held) h.blob = null;
        held.length = 0;
    }

    /** 逐张串行发送（原 V1 路径，现作为单图路径与降级路径） */
    async function sendSerially(tweet, caption) {
        const state = getState(tweet.tweetId);
        let successCount = 0;
        const failures = [];

        for (let i = 0; i < tweet.images.length; i++) {
            const image = tweet.images[i];
            let downloaded = null;

            try {
                // 逐张串行：任何时刻只持有一张图的 Blob
                downloaded = await downloadImage(image);

                // caption 只挂在第一张【成功发送】的图片上
                const cap = state.captionSent ? null : caption;

                const sent = await sendImageToTelegram(
                    downloaded.blob, downloaded.contentType, image.mediaKey, cap);

                if (sent.ok) {
                    successCount++;
                    if (cap) state.captionSent = true;
                    log(`图片 ${i + 1}/${tweet.images.length} 发送成功（${sent.method}${
                        sent.downgraded ? '，降级原因：' + sent.downgraded : ''}）`);
                } else {
                    const msg = sent.error ? sent.error.message : '未知错误';
                    failures.push(msg);
                    state.lastError = msg;
                    logError(`图片 ${i + 1} 发送失败：${msg}`, sent.response && sent.response.rawText);
                    // 鉴权、权限、限流耗尽等错误不必再试后续图片
                    if (sent.fatal) break;
                }
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                failures.push(msg);
                state.lastError = msg;
                logError(`图片 ${i + 1} 处理失败：${msg}`);
            } finally {
                // 释放临时资源
                if (downloaded) {
                    downloaded.blob = null;
                    downloaded = null;
                }
            }

            if (i < tweet.images.length - 1) await sleep(CONFIG.sendDelayMs);
        }

        return { successCount, failures };
    }

    /**
     * 构建并发送相册。
     * @param {'photo'|'document'} itemType 相册内所有项必须同类型
     */
    async function sendMediaGroupAlbum(held, caption, itemType) {
        const media = held.map((h, i) => {
            const item = { type: itemType, media: `attach://file${i}` };
            // 官方文档未说明相册中非首项 caption 的显示行为，故只放首项
            if (i === 0 && caption) item.caption = caption;
            return item;
        });
        const mediaJson = JSON.stringify(media);

        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            // 每次重试重建 FormData，避免复用已提交的表单
            const form = new FormData();
            form.append('chat_id', CONFIG.telegramChatId);
            form.append('media', mediaJson);
            held.forEach((h, i) => {
                form.append(`file${i}`, h.blob, `x-${h.image.mediaKey}.${fileExtension(h.contentType)}`);
            });

            const res = await gm({ method: 'POST', url: apiUrl('sendMediaGroup'), data: form });
            const r = parseTg(res);

            if (r.ok) {
                return { ok: true, count: Array.isArray(r.json.result) ? r.json.result.length : held.length };
            }

            const mapped = mapTelegramError(r);

            if (mapped.kind === 'flood') {
                const waitMs = (mapped.retryAfter != null ? mapped.retryAfter : 5) * 1000 + 500;
                log(`相册发送遇 429，按服务端 retry_after 等待 ${waitMs}ms`);
                if (attempt < CONFIG.maxRetries) { await sleep(waitMs); continue; }
                return { ok: false, error: mapped, fatal: true };
            }

            if (mapped.kind === 'auth' || mapped.kind === 'forbidden' || mapped.kind === 'badRequest') {
                return { ok: false, error: mapped, fatal: true };
            }

            if (attempt < CONFIG.maxRetries) {
                const wait = CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                log(`相册发送失败：${mapped.message}，${wait}ms 后重试`);
                await sleep(wait);
                continue;
            }
            return { ok: false, error: mapped };
        }
        return { ok: false, error: { kind: 'retryExhausted', message: '重试次数已用尽' } };
    }

    /**
     * 相册路径。
     * @returns {{sent:number, failures:string[], fallbackToSerial:boolean}}
     */
    async function sendAsAlbum(tweet, caption) {
        const state = getState(tweet.tweetId);
        const failures = [];
        const held = [];

        // 相册必须在同一请求中提交，故先全部下载（代价见本节顶部说明）
        for (const image of tweet.images) {
            try {
                const d = await downloadImage(image);
                held.push({ image, blob: d.blob, contentType: d.contentType, bytes: d.bytes });
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                failures.push(msg);
                logError(`相册：图片 ${image.mediaKey} 下载失败：${msg}`);
            }
        }

        if (!held.length) {
            state.lastError = failures[0] || '全部图片获取失败';
            return { sent: 0, failures, fallbackToSerial: false };
        }

        // 相册要求 2-10 项，只剩一张时退回单张发送
        if (held.length === 1) {
            log('相册仅剩 1 张图，退回单张 sendPhoto');
            try {
                const cap = state.captionSent ? null : caption;
                const sent = await sendImageToTelegram(
                    held[0].blob, held[0].contentType, held[0].image.mediaKey, cap);
                if (sent.ok) {
                    if (cap) state.captionSent = true;
                    return { sent: 1, failures, fallbackToSerial: false };
                }
                const msg = sent.error ? sent.error.message : '发送失败';
                failures.push(msg);
                state.lastError = msg;
                return { sent: 0, failures, fallbackToSerial: false };
            } finally {
                releaseAll(held);
            }
        }

        // 决定相册类型：首选 photo，若有图片超出 sendPhoto 限制则整体退回串行
        let itemType = 'photo';
        if (CONFIG.preferDocumentForOriginal) {
            itemType = 'document';
        } else {
            for (const h of held) {
                const dims = await readDimensions(h.blob);
                const fail = await photoPrecheck(h.blob, dims);
                if (fail) {
                    log(`相册中有图片不满足 sendPhoto 限制（${fail}），整体退回串行发送`);
                    releaseAll(held);
                    // 串行路径会对每张图各自降级，容错更好
                    return { sent: 0, failures, fallbackToSerial: true };
                }
            }
        }

        try {
            const cap = state.captionSent ? null : caption;
            log(`发送相册：${held.length} 张，类型=${itemType}，总大小=${
                formatBytes(held.reduce((n, h) => n + h.bytes, 0))}`);

            const sent = await sendMediaGroupAlbum(held, cap, itemType);
            if (sent.ok) {
                if (cap) state.captionSent = true;
                return { sent: sent.count, failures, fallbackToSerial: false };
            }

            const msg = sent.error ? sent.error.message : '相册发送失败';
            logError(`相册发送失败：${msg}`, sent.response && sent.response.rawText);

            if (sent.fatal) {
                failures.push(msg);
                state.lastError = msg;
                return { sent: 0, failures, fallbackToSerial: false };
            }
            // 非致命错误：退回串行发送
            log('相册发送失败，退回逐张串行发送');
            return { sent: 0, failures, fallbackToSerial: true };
        } finally {
            releaseAll(held);
        }
    }

    /**
     * 视频 / 动图路径。
     *
     * 串行处理，任何时刻只持有一个视频的 Blob。
     * caption 只在「本次还没有任何消息带过它」时才挂上：
     *   纯视频推文 → 视频带 caption（否则作者链接与推文链接会全部丢失）
     *   图文混排   → 图片已带 caption，视频不带
     */
    async function sendVideosOfTweet(tweet, caption) {
        const state = getState(tweet.tweetId);
        let successCount = 0;
        const failures = [];

        // 每次阶段变化都同步到按钮上
        const setStage = (s) => {
            state.videoState = s;
            syncButtons(tweet.tweetId);
        };

        for (let i = 0; i < tweet.videos.length; i++) {
            const media = tweet.videos[i];
            let downloaded = null;

            try {
                setStage('resolving');
                const pick = await resolveVideoSource(tweet, media);

                setStage('downloading');
                toast(`正在下载视频${pick.expectedBytes != null
                    ? '（' + formatBytes(pick.expectedBytes) + '）' : ''}…`, 'info', 2500);
                downloaded = await downloadVideo(pick.url, pick.prefetched);

                setStage('sending');
                const cap = state.captionSent ? null : caption;
                const sent = await sendVideoToTelegram(
                    downloaded.blob, downloaded.contentType,
                    media.mediaId || tweet.tweetId, pick.kind, cap);

                if (sent.ok) {
                    successCount++;
                    if (cap) state.captionSent = true;
                    setStage('done');
                    log(`视频 ${i + 1}/${tweet.videos.length} 发送成功（${sent.method}${
                        sent.downgraded ? '，降级原因：' + sent.downgraded : ''}）`);
                } else {
                    const msg = sent.error ? sent.error.message : '未知错误';
                    failures.push(msg);
                    state.lastError = msg;
                    setStage('failed');
                    logError(`视频 ${i + 1} 发送失败：${msg}`, sent.response && sent.response.rawText);
                    const errKind = sent.error ? sent.error.kind : null;
                    if (errKind === 'auth' || errKind === 'forbidden' || errKind === 'flood') break;
                }
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                failures.push(msg);
                state.lastError = msg;
                setStage('failed');
                logError(`视频 ${i + 1} 处理失败：${msg}`);
            } finally {
                // 释放临时资源
                if (downloaded) {
                    downloaded.blob = null;
                    downloaded = null;
                }
            }

            if (i < tweet.videos.length - 1) await sleep(CONFIG.sendDelayMs);
        }

        return { successCount, failures };
    }

    async function uploadTweet(tweet) {
        const state = getState(tweet.tweetId);
        state.state = 'uploading';
        state.lastError = null;
        state.captionSent = false;
        state.videoState = tweet.videos.length ? 'pending' : 'none';
        syncButtons(tweet.tweetId);

        const caption = buildCaption(tweet);
        let successCount = 0;
        let totalCount = 0;
        const failures = [];

        try {
            // ① 图片：完全沿用 V1 路径，行为不变
            if (tweet.images.length) {
                totalCount += tweet.images.length;
                const useAlbum = CONFIG.sendAsAlbum && tweet.images.length >= 2;

                if (useAlbum) {
                    const r = await sendAsAlbum(tweet, caption);
                    successCount += r.sent;
                    failures.push(...r.failures);

                    if (r.fallbackToSerial) {
                        const s = await sendSerially(tweet, caption);
                        successCount += s.successCount;
                        failures.push(...s.failures);
                    }
                } else {
                    const s = await sendSerially(tweet, caption);
                    successCount += s.successCount;
                    failures.push(...s.failures);
                }
            }

            // ② 视频 / 动图：固定另发一条消息，不与图片相册混排
            if (tweet.videos.length) {
                totalCount += tweet.videos.length;
                const v = await sendVideosOfTweet(tweet, caption);
                successCount += v.successCount;
                failures.push(...v.failures);
            }
        } finally {
            // 只要有一项成功过，就视为部分成功（状态仍标 success，避免误判为全失败）
            state.state = successCount > 0 ? 'success' : 'error';
            if (!successCount && failures.length) state.lastError = failures[0];
            syncButtons(tweet.tweetId);
        }

        return { successCount, total: totalCount, failures };
    }

    // ============================================================
    // 12. 按钮注入与交互
    // ============================================================

    const ICON_PLANE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
        '<path d="M21.9 4.3 18.6 19.4c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.1c-.24.24-.44.44-.9.44l.32-4.57 8.3-7.5c.36-.32-.08-.5-.56-.18L7.94 12.4 3.4 10.98c-.98-.31-.99-.98.2-1.45L20.2 3c.82-.3 1.54.2 1.7 1.3Z"/></svg>';

    const ICON_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
        '<path d="M9.5 17.3 5.2 13l-1.4 1.4 5.7 5.7L20.2 9.4 18.8 8 9.5 17.3Z"/></svg>';

    const ICON_ALERT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V9h2v4Z"/></svg>';

    function setButtonState(btn, state) {
        if (!btn) return;
        btn.setAttribute('data-state', state);
        const labels = {
            idle: '发送到 Telegram',
            uploading: '正在发送到 Telegram',
            success: '已发送到 Telegram',
            error: '发送失败，点击重试',
        };
        btn.setAttribute('aria-label', labels[state] || labels.idle);
        btn.setAttribute('title', labels[state] || labels.idle);

        const iconHost = btn.querySelector('.tg-icon');
        if (iconHost) {
            iconHost.innerHTML = state === 'success' ? ICON_CHECK
                : state === 'error' ? ICON_ALERT
                    : ICON_PLANE;
        }
    }

    function createButton(tweetId) {
        const btn = document.createElement('div');
        btn.setAttribute('data-tg-button', '1');
        btn.setAttribute('data-tweet-id', tweetId);
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.innerHTML = '<span class="tg-spin"></span><span class="tg-icon"></span>';

        const state = getState(tweetId);
        setButtonState(btn, state.state);
        // 上传中禁用点击
        btn.style.pointerEvents = state.state === 'uploading' ? 'none' : '';

        const activate = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onButtonClick(btn, tweetId, ev.ctrlKey || ev.metaKey);
        };
        btn.addEventListener('click', activate);
        btn.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') activate(ev);
        });

        return btn;
    }

    /** 同一 tweetId 的所有 DOM 副本同步状态 */
    function syncButtons(tweetId) {
        const state = getState(tweetId);
        const nodes = document.querySelectorAll(`${SEL.ourButton}[data-tweet-id="${tweetId}"]`);
        // 补注入晚到的副本也要能显示当前视频阶段
        const stage = state.state === 'uploading' ? VIDEO_STAGE_LABELS[state.videoState] : null;
        for (const btn of nodes) {
            setButtonState(btn, state.state);
            btn.style.pointerEvents = state.state === 'uploading' ? 'none' : '';
            // 覆盖 setButtonState 的通用文案：让用户看到具体卡在哪一步
            if (stage) {
                btn.setAttribute('aria-label', stage);
                btn.setAttribute('title', stage);
            }
        }
    }

    /**
     * 尚未成功注入按钮的推文容器。
     * X 有时会先渲染推文主体、稍后才补上操作区（like/retweet），
     * 此时 injectButton 找不到锚点。把这些容器记下来稍后重试，
     * 且只在集合非空时才有额外开销，不会持续全量扫描。
     */
    const pendingArticles = new Set();

    function injectButton(article) {
        if (article.querySelector(SEL.ourButton)) {   // 避免重复插入
            pendingArticles.delete(article);
            return true;
        }

        const anchor = article.querySelector(SEL.like) || article.querySelector(SEL.retweet);
        if (!anchor) { pendingArticles.add(article); return false; }
        const group = anchor.closest(SEL.actionGroup);
        if (!group) { pendingArticles.add(article); return false; }
        // 引用推文卡片内部也有 role=group，需确认该 group 属于当前推文
        if (group.closest('article') !== article) { pendingArticles.add(article); return false; }

        const tweetId = extractTweetId(article);
        if (!tweetId) { pendingArticles.add(article); return false; }

        const btn = createButton(tweetId);
        group.appendChild(btn);
        pendingArticles.delete(article);
        log(`已注入按钮 tweetId=${tweetId}`);
        return true;
    }

    function retryPendingArticles() {
        if (!pendingArticles.size) return 0;
        let n = 0;
        for (const article of Array.from(pendingArticles)) {
            if (!article.isConnected) { pendingArticles.delete(article); continue; }
            if (injectButton(article)) n++;
        }
        return n;
    }

    /**
     * 按 tweetId 反查推文容器。
     * X 会重渲染并产生同一推文的多份 DOM 副本，因此不能只依赖按钮自身的
     * 闭包引用，需要按 tweetId 重新定位。
     */
    function findArticleByTweetId(tweetId) {
        // 优先：同 tweetId 的其他副本按钮
        const btn = document.querySelector(`${SEL.ourButton}[data-tweet-id="${tweetId}"]`);
        if (btn) {
            const a = btn.closest('article');
            if (a) return a;
        }
        // 兜底：逐个解析容器比对 tweetId
        for (const article of document.querySelectorAll(SEL.tweetPrimary)) {
            if (extractTweetId(article) === tweetId) return article;
        }
        return null;
    }

    async function onButtonClick(btn, tweetId, force) {
        const state = getState(tweetId);

        if (state.state === 'uploading') {
            toast('该推文正在发送中，请稍候', 'info');
            return;
        }
        if (state.state === 'success' && !force) {
            toast('该推文已经发送过（Ctrl + 点击可强制重发）', 'info');
            return;
        }

        if (!IS_READY) {
            toast('请先在脚本顶部填写 telegramBotToken 与 telegramChatId', 'error', 8000);
            return;
        }

        // 按钮只持有 tweetId，此处按 tweetId 反查当前可用的推文容器
        const article = findArticleByTweetId(tweetId);
        if (!article) {
            toast('无法定位推文容器，请刷新页面重试', 'error');
            return;
        }

        const tweet = parseTweet(article);
        if (!tweet) {
            toast('推文解析失败，请刷新页面重试', 'error');
            return;
        }
        if (!tweet.authorUrl) {
            // 作者 URL 是必须项
            toast('未能获取该推文的作者链接，已取消发送', 'error');
            return;
        }
        if (!tweet.images.length && !tweet.videos.length) {
            toast('该推文没有可发送的图片或视频', 'error');
            return;
        }

        const parts = [];
        if (tweet.images.length) parts.push(`${tweet.images.length} 张图片`);
        if (tweet.videos.length) parts.push(`${tweet.videos.length} 个视频/动图`);

        toast(`开始发送 ${parts.join(' + ')}…`, 'info', 2000);
        log(`开始上传 tweetId=${tweetId}，作者=${tweet.authorUrl}，`
            + `图片数=${tweet.images.length}，视频数=${tweet.videos.length}`);

        enqueue(async () => {
            const result = await uploadTweet(tweet);
            if (result.successCount === result.total) {
                toast(`✓ 已发送到 Telegram（${result.successCount} 项）`, 'success');
            } else if (result.successCount > 0) {
                toast(`部分成功：${result.successCount}/${result.total} 项，失败原因：${
                    result.failures[0] || '未知'}`, 'error', 8000);
            } else {
                toast(`✗ 发送失败：${result.failures[0] || '未知错误'}`, 'error', 8000);
            }
        });
    }

    // ============================================================
    // 13. 扫描调度
    // ============================================================

    function scanRoot(root) {
        let count = 0;
        const scope = root && root.nodeType === 1 ? root : document;
        const list = [];

        if (scope.matches && scope.matches(SEL.tweetPrimary)) list.push(scope);
        if (scope.querySelectorAll) {
            for (const el of scope.querySelectorAll(SEL.tweetPrimary)) list.push(el);
        }

        for (const article of list) {
            injectButton(article);
            count++;
        }
        return count;
    }

    function scanAll() {
        let n = 0;
        for (const article of document.querySelectorAll(SEL.tweetPrimary)) {
            injectButton(article);
            n++;
        }
        log(`全量扫描：推文 ${n} 条`);
        return n;
    }

    let rescanTimer = null;
    const pendingRoots = new Set();

    function scheduleIncrementalScan() {
        if (rescanTimer) return;
        rescanTimer = setTimeout(() => {
            rescanTimer = null;
            const roots = Array.from(pendingRoots);
            pendingRoots.clear();
            for (const r of roots) {
                if (r.isConnected) scanRoot(r);
            }
            // 补漏：操作区可能晚于推文主体出现
            const fixed = retryPendingArticles();
            if (fixed) log(`补注入按钮 ${fixed} 个`);
        }, 250);
    }

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            let sawTweetNode = false;
            for (const m of mutations) {
                if (!m.addedNodes || !m.addedNodes.length) continue;
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 只关心可能含推文的新增子树
                    if (node.matches && (node.matches(SEL.tweetPrimary) || node.querySelector(SEL.tweetPrimary))) {
                        pendingRoots.add(node);
                        sawTweetNode = true;
                    }
                }
            }
            // 有新的推文节点，或仍有推文等着补注入按钮时才调度
            if (sawTweetNode || pendingArticles.size) scheduleIncrementalScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('MutationObserver 已启动（childList + subtree，批量 250ms）');
    }

    /** SPA 路由切换后补一次全量扫描 */
    function watchRouteChange() {
        let lastHref = location.href;
        const check = () => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                log('检测到路由变化，执行全量扫描');
                setTimeout(scanAll, 300);
            }
        };
        window.addEventListener('popstate', check);
        // 对 pushState / replaceState 打补丁，覆盖 X 的内部路由
        for (const fn of ['pushState', 'replaceState']) {
            const orig = history[fn];
            if (typeof orig !== 'function') continue;
            history[fn] = function () {
                const ret = orig.apply(this, arguments);
                setTimeout(check, 0);
                return ret;
            };
        }
        setInterval(check, 1000);
    }

    // ============================================================
    // 14. 启动
    // ============================================================

    function main() {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(STYLE);
        } else {
            const s = document.createElement('style');
            s.textContent = STYLE;
            document.head.appendChild(s);
        }

        const n = scanAll();
        startObserver();
        watchRouteChange();

        if (!IS_READY) {
            logError('尚未配置 telegramBotToken 与 telegramChatId，按钮点击后会提示。');
            setTimeout(() => {
                toast('XPhoto2TG：请先在脚本顶部填写 Bot Token 与 Chat ID', 'error', 10000);
            }, 800);
        } else {
            log('XPhoto2TG 已就绪，已为 ' + n + ' 条推文注入按钮');
        }
        log('提示：Ctrl + 点击按钮可强制重发已成功的推文');
    }

    if (document.body) {
        main();
    } else {
        window.addEventListener('DOMContentLoaded', main, { once: true });
    }
})();
