#!/usr/bin/env node
// fb-autoposter — publish organic posts to a Facebook Page and/or linked
// Instagram Business account via the Meta Graph API.
//
// Post kinds:
//   text / link      -> FB feed              (FB only)
//   image / photo    -> FB photo + IG feed   (any image format; auto-hosted)
//   carousel         -> FB multi-photo + IG carousel   (2–10 images)
//   reel  (video)    -> IG Reel + FB video
//   story            -> IG Story (image or video; FB skipped — no Page Story API)
//
// Examples:
//   node autopost.mjs --text "Hello"                                  (FB text)
//   node autopost.mjs --text "Read" --link "https://..."             (FB link)
//   node autopost.mjs --text "Cap" --image ".\pic.png" --to both     (photo)
//   node autopost.mjs --text "Cap" --images "a.png,b.png,c.png" --to both   (carousel)
//   node autopost.mjs --text "Cap" --reel ".\clip.mp4" --to both     (IG Reel + FB video)
//   node autopost.mjs --story ".\slide.png" --to ig                  (IG Story)
//   node autopost.mjs --queue posts.json                             (batch)
//   add --dry-run to preview without publishing.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostImage, hostVideo } from "./image-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// ---------------------------------------------------------------- env loader
async function loadEnv() {
  try {
    const raw = await readFile(resolve(HERE, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* rely on real env vars */
  }
}

const cfg = () => ({
  version: process.env.GRAPH_VERSION || "v21.0",
  pageId: process.env.FB_PAGE_ID,
  pageToken: process.env.FB_PAGE_TOKEN,
  igUserId: process.env.IG_USER_ID,
  igToken: process.env.IG_TOKEN || process.env.FB_PAGE_TOKEN,
});

// ----------------------------------------------------------------- arg parser
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// --------------------------------------------------------------- graph helpers
async function graph(path, fields, { token, version }) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  body.set("access_token", token);
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, { method: "POST", body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`Graph API ${res.status}: ${e.message || text}` +
      (e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : ""));
  }
  return json;
}
async function graphGet(path, params, { token, version }) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

// Poll an IG container until it finishes processing (reels/videos/stories).
async function waitForContainer(c, creationId, auth, { tries = 30, gap = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await graphGet(creationId, { fields: "status_code,status" }, auth);
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR") throw new Error(`media processing failed: ${s.status || "ERROR"}`);
    await sleep(gap);
  }
  throw new Error("media still processing after timeout");
}
async function igPublish(c, creationId, auth) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try { return await graph(`${c.igUserId}/media_publish`, { creation_id: creationId }, auth); }
    catch (e) { lastErr = e; if (/not ready|9007|process|media is not/i.test(e.message)) { await sleep(3000); continue; } throw e; }
  }
  throw lastErr;
}

// ------------------------------------------------------------- facebook posts
async function fbText(c, { text, link }) {
  const r = await graph(`${c.pageId}/feed`, { message: text || "", link: link || "" }, c.auth);
  return { platform: "facebook", kind: link ? "link" : "text", id: r.id };
}
async function fbPhoto(c, { text, url }) {
  const r = await graph(`${c.pageId}/photos`, { url, message: text || "" }, c.auth);
  return { platform: "facebook", kind: "photo", id: r.post_id || r.id };
}
async function fbCarousel(c, { text, urls }) {
  const ids = [];
  for (const url of urls) {
    const p = await graph(`${c.pageId}/photos`, { url, published: "false" }, c.auth);
    ids.push(p.id);
  }
  const fields = { message: text || "" };
  ids.forEach((id, i) => (fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
  const r = await graph(`${c.pageId}/feed`, fields, c.auth);
  return { platform: "facebook", kind: `carousel(${urls.length})`, id: r.id };
}
async function fbVideo(c, { text, videoUrl }) {
  const r = await graph(`${c.pageId}/videos`, { file_url: videoUrl, description: text || "" }, c.auth);
  return { platform: "facebook", kind: "video", id: r.id };
}

// ------------------------------------------------------------ instagram posts
async function igPhoto(c, { text, url }) {
  const ct = await graph(`${c.igUserId}/media`, { image_url: url, caption: text || "" }, c.auth);
  const r = await igPublish(c, ct.id, c.auth);
  return { platform: "instagram", kind: "photo", id: r.id };
}
async function igCarousel(c, { text, urls }) {
  const children = [];
  for (const url of urls) {
    const ch = await graph(`${c.igUserId}/media`, { image_url: url, is_carousel_item: "true" }, c.auth);
    children.push(ch.id);
  }
  const ct = await graph(`${c.igUserId}/media`,
    { media_type: "CAROUSEL", children: children.join(","), caption: text || "" }, c.auth);
  const r = await igPublish(c, ct.id, c.auth);
  return { platform: "instagram", kind: `carousel(${urls.length})`, id: r.id };
}
async function igReel(c, { text, videoUrl }) {
  const ct = await graph(`${c.igUserId}/media`,
    { media_type: "REELS", video_url: videoUrl, caption: text || "", share_to_feed: "true" }, c.auth);
  await waitForContainer(c, ct.id, c.auth);
  const r = await igPublish(c, ct.id, c.auth);
  return { platform: "instagram", kind: "reel", id: r.id };
}
async function igStory(c, { url, videoUrl }) {
  const fields = videoUrl ? { media_type: "STORIES", video_url: videoUrl }
                          : { media_type: "STORIES", image_url: url };
  const ct = await graph(`${c.igUserId}/media`, fields, c.auth);
  if (videoUrl) await waitForContainer(c, ct.id, c.auth);
  const r = await igPublish(c, ct.id, c.auth);
  return { platform: "instagram", kind: "story", id: r.id };
}

// --------------------------------------------------------------- post router
function detectKind(p) {
  if (p.kind) return p.kind;
  if (p.reel || (p.video && p.asReel)) return "reel";
  if (p.story) return "story";
  if (p.video) return "video";
  if (p.images && p.images.length > 1) return "carousel";
  if (p.image || p.imageFile) return "image";
  if (p.text || p.link) return "text";
  return "text";
}

async function publishOne(c, post) {
  const to = (post.to || "fb").toLowerCase();
  const wantFb = ["fb", "facebook", "both"].includes(to);
  const wantIg = ["ig", "instagram", "both"].includes(to);
  const kind = detectKind(post);
  const auth = { token: c.pageToken, version: c.version };
  const igAuth = { token: c.igToken, version: c.version };
  const cFb = { ...c, auth };
  const cIg = { ...c, auth: igAuth };
  const results = [], errors = [];
  const text = post.text || post.message || "";

  if (!c.pageId || !c.pageToken) { errors.push("missing FB_PAGE_ID / FB_PAGE_TOKEN in .env"); return { results, errors }; }
  if (wantIg && !c.igUserId) errors.push("instagram: IG_USER_ID not set — skipping IG");

  try {
    // ---- resolve media to public URLs (shared by both platforms) ----
    let imgUrls = [], videoUrl = null;
    const rawImages = post.images?.length ? post.images
      : (post.image || post.imageFile) ? [post.imageFile || post.image] : [];
    const rawVideo = post.reel || post.video || (post.story && /\.mp4($|\?)/i.test(post.story) ? post.story : null);
    const storyMedia = typeof post.story === "string" ? post.story : null;

    if (post.dryRun) {
      const what = kind === "text" ? (post.link ? "link" : "text")
        : kind === "carousel" ? `carousel(${rawImages.length})`
        : kind;
      console.log(`   (dry-run) ${what} -> ${[wantFb && "facebook", wantIg && "instagram"].filter(Boolean).join(" + ")}`);
      if (rawImages.length || rawVideo || storyMedia)
        console.log(`   media: ${[...new Set([...rawImages, rawVideo, storyMedia].filter(Boolean))].join(", ")}`);
      results.push({ platform: "(both)", kind, dryRun: true });
      return { results, errors };
    }

    if (kind === "image") imgUrls = [await hostImage(rawImages[0], process.env, { pad: true, log })];
    else if (kind === "carousel") {
      for (const im of rawImages) imgUrls.push(await hostImage(im, process.env, { pad: true, log }));
    } else if (kind === "reel" || kind === "video") {
      videoUrl = await hostVideo(rawVideo, process.env, { log });
    } else if (kind === "story") {
      if (storyMedia && /\.mp4($|\?)/i.test(storyMedia)) videoUrl = await hostVideo(storyMedia, process.env, { log });
      else if (storyMedia) imgUrls = [await hostImage(storyMedia, process.env, { pad: false, log })];
    }

    // ---- Facebook ----
    if (wantFb) {
      try {
        if (kind === "text") results.push(await fbText(cFb, { text, link: post.link }));
        else if (kind === "image") results.push(await fbPhoto(cFb, { text, url: imgUrls[0] }));
        else if (kind === "carousel") results.push(await fbCarousel(cFb, { text, urls: imgUrls }));
        else if (kind === "reel" || kind === "video") results.push(await fbVideo(cFb, { text, videoUrl }));
        else if (kind === "story") log("   (facebook skipped — no Page Story API; story is IG-only)");
      } catch (e) { errors.push(`facebook: ${e.message}`); }
    }

    // ---- Instagram ----
    if (wantIg && c.igUserId) {
      try {
        if (kind === "text") errors.push("instagram: needs an image/video (no text-only posts)");
        else if (kind === "image") results.push(await igPhoto(cIg, { text, url: imgUrls[0] }));
        else if (kind === "carousel") results.push(await igCarousel(cIg, { text, urls: imgUrls }));
        else if (kind === "reel" || kind === "video") results.push(await igReel(cIg, { text, videoUrl }));
        else if (kind === "story") results.push(await igStory(cIg, { url: imgUrls[0], videoUrl }));
      } catch (e) { errors.push(`instagram: ${e.message}`); }
    }
  } catch (e) {
    errors.push(`media-host: ${e.message}`);
  }
  return { results, errors };
}

// ----------------------------------------------------------------- queue mode
async function runQueue(c, file, dryRun) {
  const path = resolve(process.cwd(), file);
  const queue = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(queue)) throw new Error("Queue file must be a JSON array of posts");
  let posted = 0, skipped = 0, failed = 0;
  for (const post of queue) {
    if (post.posted === true) { skipped++; continue; }
    console.log(`\n• ${post.id || (post.text || "").slice(0, 40) || "(untitled)"}`);
    const { results, errors } = await publishOne(c, { ...post, dryRun });
    for (const r of results) console.log(`   ✓ ${r.platform} ${r.kind}${r.dryRun ? " [dry-run]" : ` -> ${r.id}`}`);
    for (const e of errors) console.log(`   ✗ ${e}`);
    if (!dryRun && errors.length === 0 && results.length) {
      post.posted = true; post.posted_at = new Date().toISOString();
      post.result_ids = results.map((r) => `${r.platform}:${r.id}`); posted++;
    } else if (errors.length) { post.last_error = errors.join("; "); failed++; }
  }
  if (!dryRun) await writeFile(path, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(`\nQueue done — posted ${posted}, already-done ${skipped}, failed ${failed}.` +
    (dryRun ? " (dry-run: nothing published)" : ""));
}

// ------------------------------------------------------------------- entry
async function main() {
  await loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const c = cfg();
  const dryRun = !!args["dry-run"];

  if (args.queue) { await runQueue(c, args.queue, dryRun); return; }

  const images = args.images ? String(args.images).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const post = {
    to: args.to || "both",
    text: args.text || args.message,
    link: args.link,
    image: args.image,
    imageFile: args["image-file"],
    images,
    reel: typeof args.reel === "string" ? args.reel : undefined,
    video: args.video,
    story: typeof args.story === "string" ? args.story : args.story ? (args.image || args.video) : undefined,
    dryRun,
  };
  if (args.reel === true && args.video) { post.video = args.video; post.asReel = true; }

  const hasContent = post.text || post.link || post.image || post.imageFile ||
    post.images || post.reel || post.video || post.story;
  if (!hasContent) {
    console.log("Nothing to post. Examples:\n" +
      '  node autopost.mjs --text "Hello"\n' +
      '  node autopost.mjs --text "Cap" --image ".\\pic.png" --to both\n' +
      '  node autopost.mjs --text "Cap" --images "a.png,b.png" --to both\n' +
      '  node autopost.mjs --text "Cap" --reel ".\\clip.mp4" --to both\n' +
      '  node autopost.mjs --story ".\\slide.png" --to ig\n' +
      "  node autopost.mjs --queue posts.json\nAdd --dry-run to preview.");
    process.exitCode = 1; return;
  }

  // default --to for FB-only kinds (text/link) when not specified
  if (!args.to && (post.text || post.link) && !post.image && !post.imageFile &&
      !post.images && !post.reel && !post.video && !post.story) post.to = "fb";

  const { results, errors } = await publishOne(c, post);
  for (const r of results) console.log(`✓ ${r.platform} ${r.kind}${r.dryRun ? " [dry-run]" : ` -> ${r.id}`}`);
  for (const e of errors) console.log(`✗ ${e}`);
  if (errors.length && !results.length) process.exitCode = 1;
}

main().catch((e) => { console.error("Error:", e.message); process.exitCode = 1; });
