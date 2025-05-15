const crypto = require("crypto");
const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");

const {
  READABILITY_API_URL,
  BOT_TOKEN,
  constructIvUrl,
  constructReadableUrl,
} = require("./_common.js");

const START_MESSAGE = `Just send an article link here.
It will be converted to a readable webpage with Instant View.`;

const bot = new TelegramBot(BOT_TOKEN);

module.exports = async (request, response) => {
  try {
    const inlineQuery = request.body.inline_query;
    const message = request.body.message;

    if (inlineQuery && inlineQuery.query.trim()) {
      const url = tryFixUrl(inlineQuery.query);
      if (!url) return;

      const meta = await fetchMeta(url);
      const text = renderMessage(url, meta);

      try {
        await bot.answerInlineQuery(
          inlineQuery.id,
          [
            {
              type: "article",
              id: sha256(url),
              title: meta.title ?? "<UNTITLED>",
              description: meta.excerpt,
              input_message_content: {
                message_text: text,
                disable_web_page_preview: false,
                parse_mode: "HTML",
              },
            },
          ],
          { is_personal: false, cache_time: 900 }
        );
      } catch (e) {
        console.error("InlineQuery Error:", e);
      }
    } else if (message && message.text.trim()) {
      const text = message.text.trim();
      const chatId = message.chat.id;

      if (text === "/start") {
        await bot.sendMessage(chatId, START_MESSAGE, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Try Inline Mode", switch_inline_query: "" }],
            ],
          },
        });
      } else {
        const url = tryFixUrl(text);
        if (!url) {
          if (message.chat.type === "private") {
            await bot.sendMessage(chatId, "It is not a valid URL.");
          }
          return;
        }

        // Acknowledge early
        const sent = await bot.sendMessage(chatId, "Processing...", {
          parse_mode: "HTML",
        });

        try {
          const meta = await fetchMeta(url);
          const rendered = renderMessage(url, meta);

          await bot.editMessageText(rendered, {
            chat_id: chatId,
            message_id: sent.message_id,
            parse_mode: "HTML",
            disable_web_page_preview: false,
          });
        } catch (e) {
          const errorText = escapeHtml(e.toString());
          await bot.editMessageText(
            `Failed to fetch the URL with error:\n<pre>${errorText}</pre>`,
            {
              chat_id: chatId,
              message_id: sent.message_id,
              parse_mode: "HTML",
            }
          );
        }
      }
    }

    response.status(204).send("");
  } catch (e) {
    console.error("Main Handler Error:", e);
    response.status(200).send(e.toString());
  }
};

// ========== Utilities ==========

function renderMessage(url, meta) {
  const readableUrl = constructReadableUrl(url);
  const ivUrl = constructIvUrl(url);
  return `<a href="${ivUrl}"> </a><a href="${readableUrl}">${escapeHtml(
    meta.title ?? "Untitled Article"
  )}</a>\n${escapeHtml(
    meta.byline ?? meta.siteName ?? new URL(url).hostname
  )} (<a href="${url}">source</a>)`;
}

function tryFixUrl(url) {
  try {
    if (!url.startsWith("http")) {
      url = "http://" + url;
    }
    new URL(url); // throws if invalid
    return url;
  } catch {
    return null;
  }
}

function sha256(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchMeta(url) {
  const metaUrl = `${READABILITY_API_URL}?url=${encodeURIComponent(url)}&format=json`;
  const resp = await fetch(metaUrl);

  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {}
    throw new Error(`Upstream HTTP Error: ${resp.status} ${resp.statusText}\n${body}`);
  }

  return await resp.json();
}