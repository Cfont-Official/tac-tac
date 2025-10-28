// server.js
import express from "express";
import fetch from "node-fetch";
import cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import { URL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

/**
 * Helper: run a DuckDuckGo HTML search for site:tiktok.com and parse links.
 * We use the lightweight HTML interface to avoid needing an API key.
 */
async function searchTikTokLinks(query, maxResults = 8) {
  if (!query || query.trim() === "") return [];
  const q = encodeURIComponent(`site:tiktok.com ${query}`);
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${q}`;

  const res = await fetch(ddgUrl, {
    headers: {
      "User-Agent": "tiktok-embed-search/1.0 (+https://your-domain.example)"
    }
  });
  const text = await res.text();
  const $ = cheerio.load(text);

  const links = new Set();
  // DuckDuckGo HTML results put anchors in 'a.result__a' - be broad and look for <a>
  $("a").each((i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // Filter for tiktok posts (user/video/ID) or short vm.tiktok.com links
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const host = u.hostname || "";
      if (host.includes("tiktok.com") || host.includes("vm.tiktok.com")) {
        // Normalize some known mobile/short formats by leaving them as-is;
        // we'll let oEmbed or fetch handle redirects if needed.
        links.add(href);
      }
    } catch (e) {
      // ignore malformed
    }
    if (links.size >= maxResults) return false;
  });

  return Array.from(links).slice(0, maxResults);
}

/**
 * Normalize URL for oEmbed:
 * - TikTok oEmbed prefers the canonical www.tiktok.com/@user/video/ID or m.tiktok.com/v/ID.html
 * - For short vm.tiktok.com links we follow redirects server-side to get the final URL.
 */
async function resolveFinalUrl(possibleUrl) {
  try {
    // request HEAD or GET and follow redirects to find final URL
    const r = await fetch(possibleUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "tiktok-embed-search/1.0" },
    });
    return r.url || possibleUrl;
  } catch (e) {
    return possibleUrl;
  }
}

async function fetchOEmbedHtml(videoUrl) {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`;
    const res = await fetch(oembedUrl, { headers: { "User-Agent": "tiktok-embed-search/1.0" }});
    if (!res.ok) {
      // oEmbed failed — return null and let caller handle
      return null;
    }
    const json = await res.json();
    // The oEmbed response contains an `html` field with the embed snippet
    return json.html || null;
  } catch (err) {
    return null;
  }
}

/**
 * API: /api/search?q=your+query
 * Returns array: [{ sourceUrl, resolvedUrl, embedHtml }]
 */
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString();
  if (!q) return res.status(400).json({ error: "Missing q parameter" });

  try {
    const rawLinks = await searchTikTokLinks(q, 12);
    const results = [];

    for (const link of rawLinks) {
      const resolved = await resolveFinalUrl(link);
      const embedHtml = await fetchOEmbedHtml(resolved);
      if (embedHtml) {
        results.push({
          sourceUrl: link,
          resolvedUrl: resolved,
          embedHtml
        });
      }
      // small delay to be polite (avoid hammering services)
      await new Promise(r => setTimeout(r, 250));
      if (results.length >= 8) break;
    }

    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Fallback: serve index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`tiktok-embed-search listening on port ${PORT}`);
});
