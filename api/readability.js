// readable.js — updated
const { Readability } = require("@mozilla/readability");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");
const { encode: htmlEntitiesEscape } = require("html-entities");
const createDOMPurify = require("dompurify");

const { APP_URL, constructIvUrl, DEFAULT_USER_AGENT_SUFFIX, FALLBACK_USER_AGENT } = require("./_common.js");

module.exports = async (request, response) => {
  if ((request.headers["user-agent"] ?? "").includes("readability-bot")) {
    response.send(EASTER_EGG_PAGE);
    return;
  }
  let { url, /*selector,*/ type, format } = request.query;
  if (!format) {
    format = type; // the type param will be deprecated in favor of format
  }
  if (!url & (format !== "json")) {
    response.redirect(APP_URL);
    return;
  }
  let meta, upstreamResponse;
  try {
    if (!isValidUrl(url)) {
      response.status(400).send("Invalid URL");
      return;
    }
    const headers = constructUpstreamRequestHeaders(request.headers);
    console.debug("RH: ", headers);
    upstreamResponse = await fetch(url, {
      headers,
    });
    console.debug("UP: ", upstreamResponse);
    const dom = new JSDOM(await upstreamResponse.textConverted(), { url: url });
    const DOMPurify = createDOMPurify(dom.window);
    const doc = dom.window.document;
    fixImgLazyLoadFromDataSrc(doc);
    if ((new URL(url)).hostname === "www.xiaohongshu.com") {
      fixXiaohongshuImages(doc);
    }
    else if ((new URL(url)).hostname === "mp.weixin.qq.com") {
      fixWeixinArticle(doc);
    }

    let article_content = null;
    if ((new URL(url)).hostname === "telegra.ph") {
      const ac = doc.querySelector(".tl_article_content");
      if (ac) {
        // CSS rules in https://telegra.ph/css/core.min.css
        ac.querySelector("h1").style.display = "none";
        ac.querySelector("address").style.display = "none";

        article_content = ac.innerHTML;
      }
    }

    const reader = new Readability(
      /*selector ? doc.querySelector(selector) :*/ doc
    );
    const article = reader.parse();
    const lang = extractLang(doc);
    // some stupid websites like xiaohongshu.com use the non-standard "name" attr
    const ogImage = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    meta = Object.assign({ url, lang }, article);
    meta.byline = stripRepeatedWhitespace(meta.byline);
    meta.siteName = stripRepeatedWhitespace(meta.siteName);
    meta.excerpt = stripRepeatedWhitespace(meta.excerpt);

    // ----------------------------
    // Transform content safely BEFORE final export:
    // convert <p><img></p> → <figure><img/><figcaption>...</figcaption></figure>
    // resolve relative image URLs to absolute, and sanitize the final fragment.
    // ----------------------------
    meta.content = transformImageParagraphsAndSanitize(article_content ?? meta.content, url);
    let cleaned = meta.content;
    cleaned = cleaned.replace(/<p>Story continues below this ad<\/p>/gi, '');
    cleaned = cleaned.replace(
      /<figure>[\s\S]*?alt="short article insert"[\s\S]*?<\/figure>/gi,
      ''
    );
    if (meta.imageUrl) {
      const leadFigure = `
        <figure>
          <img src="${htmlEntitiesEscape(meta.imageUrl)}"
               alt="${htmlEntitiesEscape(meta.title)}"
               style="max-width:100%; height:auto; border-radius:12px;">
        </figure>`;
      cleaned = leadFigure + cleaned;
    }
    meta.content = cleaned;
    

    meta.imageUrl = (ogImage || {}).content;
  } catch (e) {
    console.error(e);
    response.status(500).send(e.toString());
    return;
  }
  response.setHeader('cache-control', upstreamResponse.headers["cache-control"] ?? "public, max-age=900");
  if (format === "json") {
    console.debug(meta);
    response.json(meta);
  } else {
    response.send(render(meta));
  }
};

/**
 * transformImageParagraphsAndSanitize(rawHtml, baseUrl)
 *
 * FIXED for Indian Express and similar lazy-loading sites:
 * - Handles <p><img srcset=... data-srcset=... data-lazy-type=...></p>
 * - Converts ANY <p> containing an <img> into proper <figure>
 * - Keeps srcset, sizes, alt, etc.
 * - Resolves relative URLs
 * - Adds <figcaption> only when alt is meaningful
 */
function transformImageParagraphsAndSanitize(rawHtml, baseUrl) {
  const tmpDom = new JSDOM(rawHtml, { url: baseUrl });
  const tmpDoc = tmpDom.window.document;

  // Helper: resolve relative → absolute src / srcset / data-srcset
  function resolveImgSrc(imgEl) {
    // src
    let src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || "";
    if (src && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) {
      try { src = new URL(src, baseUrl).href; } catch (e) {}
      imgEl.setAttribute('src', src);
    }

    // srcset
    let srcset = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset') || "";
    if (srcset) {
      const newSrcset = srcset.split(',').map(part => {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) return part;
        let absUrl = url;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
          try { absUrl = new URL(url, baseUrl).href; } catch (e) {}
        }
        return size ? `${absUrl} ${size}` : absUrl;
      }).join(', ');
      imgEl.setAttribute('srcset', newSrcset);
    }

    // Clean up lazy attributes (optional but cleaner)
    imgEl.removeAttribute('data-src');
    imgEl.removeAttribute('data-srcset');
    imgEl.removeAttribute('data-lazy-type');
  }

  // Helper: detect useless filename-like alt
  function looksLikeFilename(str) {
    if (!str) return true;
    const trimmed = str.trim();
    if (/^[\w\-. ]+\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(trimmed)) return true;
    if (/^IMG[_-]?\d+/i.test(trimmed)) return true;
    if (/^\d{3,}_\d+/.test(trimmed)) return true;
    if (!/\s/.test(trimmed) && /^[^a-zA-Z]*$/.test(trimmed)) return true;
    return false;
  }

  // === MAIN FIX: Catch EVERY <p> that contains an <img> ===
  const paragraphs = Array.from(tmpDoc.querySelectorAll('p'));
  for (const p of paragraphs) {
    const imgs = Array.from(p.querySelectorAll('img'));

    if (imgs.length > 0) {
      for (const img of imgs) {
        resolveImgSrc(img);               // fix lazy + relative URLs

        const figure = tmpDoc.createElement('figure');
        figure.appendChild(img);          // move the img

        // Add figcaption only if alt is useful
        const alt = img.getAttribute('alt') || '';
        if (alt && alt.trim().length > 0 && !looksLikeFilename(alt)) {
          const figcap = tmpDoc.createElement('figcaption');
          figcap.textContent = alt.trim();
          figure.appendChild(figcap);
        }

        // Insert <figure> before the old <p>
        p.parentNode.insertBefore(figure, p);

        // Remove the now-empty <p> if it only contained the image
        if (p.textContent.trim() === '' && p.querySelectorAll('img').length === 0) {
          p.remove();
        }
      }
    }
  }

  // Final cleanup: any stray <img> outside <p> (just in case)
  for (const img of tmpDoc.querySelectorAll('img')) {
    resolveImgSrc(img);
  }

  // Sanitize
  const DOMPurifyForTmp = createDOMPurify(tmpDom.window);
  const sanitized = DOMPurifyForTmp.sanitize(
    tmpDoc.body ? tmpDoc.body.innerHTML : tmpDoc.documentElement.innerHTML
  );

  return sanitized;
}

function render(meta) {
  let { title, byline: author, siteName, content, url, excerpt, imageUrl, publishedTime } = meta;

  // Nice readable date
  let dateStr = '';
  if (publishedTime) {
    try {
      const date = new Date(publishedTime);
      dateStr = date.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (e) {
      dateStr = publishedTime;
    }
  }

  // Byline
  const bylineText = [
    siteName || new URL(url).hostname,
    author
  ].filter(Boolean).join(' • ');

  // Final cleaned content (extra safety layer)
  let finalContent = content || '';

  // Remove leftover Indian Express ad junk
  finalContent = finalContent
    .replace(/Story continues below this ad/gi, '')
    .replace(/<figure>[\s\S]*?alt="short article insert"[\s\S]*?<\/figure>/gi, '')
    .replace(/<div>\s*<p>Story continues below this ad<\/p>\s*<\/div>/gi, '');

  // Force featured image at the very top if we have one
  let leadImageHTML = '';
  if (imageUrl) {
    leadImageHTML = `
      <figure style="margin: 2rem 0 2.5rem 0;">
        <img 
          src="${htmlEntitiesEscape(imageUrl)}" 
          alt="${htmlEntitiesEscape(title)}"
          style="max-width: 100%; height: auto; border-radius: 12px; display: block; margin: 0 auto;">
      </figure>`;
  }

  return `<!DOCTYPE html>
<html lang="${meta.lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="same-origin">
  <meta http-equiv="Content-Security-Policy" content="script-src 'none'; frame-src 'none';">
  <meta name="description" content="${htmlEntitiesEscape(excerpt || title)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${htmlEntitiesEscape(title)}">
  <meta property="og:site_name" content="${htmlEntitiesEscape(siteName || new URL(url).hostname)}">
  <meta property="og:description" content="${htmlEntitiesEscape(excerpt || title)}">
  <meta property="article:author" content="${htmlEntitiesEscape(bylineText)}">
  \( {imageUrl ? `<meta property="og:image" content=" \){htmlEntitiesEscape(imageUrl)}">` : ''}
  <title>${htmlEntitiesEscape(title)}</title>

  <!-- Tailwind CSS CDN - beautiful & lightweight for IV -->
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=Georgia:wght@400;500&amp;display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; }
    .prose { font-family: 'Georgia', serif; line-height: 1.75; }
    .prose h1, .prose h2, .prose h3 { font-family: 'Inter', system-ui, sans-serif; }
    figure img { border-radius: 12px; }
    .byline { color: #555; font-size: 0.95rem; }
  </style>
</head>
<body class="bg-white text-zinc-900 max-w-3xl mx-auto px-6 py-8">

  <!-- Title -->
  <h1 class="text-4xl leading-tight font-semibold tracking-tight mb-6">
    ${htmlEntitiesEscape(title)}
  </h1>

  <!-- Byline -->
  <div class="byline flex flex-wrap items-center gap-x-3 gap-y-1 mb-8 text-sm">
    <span>${htmlEntitiesEscape(bylineText)}</span>
    ${dateStr ? `<span class="text-zinc-500">• ${dateStr}</span>` : ''}
  </div>

  <!-- Featured Image (forced at top) -->
  ${leadImageHTML}

  <!-- Article Content -->
  <article class="prose prose-zinc max-w-none text-[1.1rem] leading-relaxed">
    ${finalContent}
  </article>

  <hr class="my-12 border-zinc-200">

  <!-- Footer (exactly as you had before) -->
  <footer class="text-xs text-zinc-500">
    <small>
      The article (<a href="${constructIvUrl(url)}" title="Telegram Instant View link">IV</a>) 
      is scraped and extracted from 
      <a href="\( {url}" target="_blank"> \){htmlEntitiesEscape(siteName || new URL(url).hostname)}</a> 
      by <a href="${APP_URL}">readability-bot</a> at 
      <time datetime="\( {new Date().toISOString()}"> \){new Date().toString()}</time>.
    </small>
  </footer>

</body>
</html>`;
}

function constructUpstreamRequestHeaders(headers) {
  let ua = headers["user-agent"];
  if (ua && ua.indexOf("node-fetch") === -1) {
    ua += " " + DEFAULT_USER_AGENT_SUFFIX;
  }
  else {
    ua = FALLBACK_USER_AGENT;
  }
  return {
    "user-agent": ua,
    "referer": "https://www.google.com/?feeling-lucky"
    /*"x-real-ip": headers["x-real-ip"],
    "x-forwarded-for":
      headers["x-real-ip"] + ", " + (headers["x-forwarded-for"] ?? ""),*/
  };
}

function stripRepeatedWhitespace(s) {
  if (s) {
    return s.replace(/\s+/g, " ");
  } else {
    return s;
  }
}

function isValidUrl(url) {
  try {
    const _ = new URL(url);
    return true;
  } catch (_e) {
    return false;
  }
}

const EASTER_EGG_PAGE = `<html>
<head><title>Catastrophic Server Error</title></head>
<body>
  <p>Server is down. (<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">🛠︎ Debug</a>)</p>
</body>
</html>
`;

function extractLang(doc) {
  // Some malformed HTMLs may confuse querySelector.
  return (
    (doc.querySelector("html") &&
      doc.querySelector("html").getAttribute("lang")) ??
    (doc.querySelector("body") &&
      doc.querySelector("body").getAttribute("lang"))
  );
}

function fixImgLazyLoadFromDataSrc(doc) {
  // sample page: https://mp.weixin.qq.com/s/U07oNCwtiAMGnBvYZXPuMg
  console.debug(doc.querySelectorAll("body img:not([src])[data-src]"));
  for (const img of doc.querySelectorAll("body img:not([src])[data-src]")) {
    img.src = img.dataset.src;
  }
}

function fixXiaohongshuImages(doc) {
  // sample page:
  // https://www.xiaohongshu.com/explore/66a589ef000000002701c69e
  const target = doc.querySelector("#detail-desc") ?? doc.querySelector("body");
  // some magic to make readability.js and telegra.ph happy together
  const container = doc.createElement("span");
  target.prepend(container);
  for (const ogImage of doc.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')) {
    const url = ogImage.content;
    // console.log("xhsImg", url);
    const imgP = doc.createElement("p");
    const img = doc.createElement("img");
    img.src = url;
    imgP.append(img);
    container.append(imgP);
  }
}

function fixWeixinArticle(doc) {
  // sample page: https://mp.weixin.qq.com/s/ayHC7MpG6Jpiogzp-opQFw
  const jc = doc.querySelector("#js_content, .rich_media_content");
  if (jc) {
    jc.style = ""; // remove visibility: hidden
  }
}
