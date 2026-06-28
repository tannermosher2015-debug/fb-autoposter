#!/usr/bin/env node
// fb-autoposter — publish organic posts to a Facebook Page and/or linked
// Instagram Business account via the Meta Graph API. Zero dependencies (Node 18+).
//
//   FB:  text / link / photo  -> /{PAGE_ID}/feed  and  /{PAGE_ID}/photos
//   IG:  photo (image required) -> /{IG_USER_ID}/media -> /media_publish
//
// Usage:
//   node autopost.mjs --text "Hello world"                         (FB text)
//   node autopost.mjs --text "Read this" --link "https://..."      (FB link)
//   node autopost.mjs --text "Caption" --image "https://..." --to both
//   node autopost.mjs --text "Caption" --image-file ./local.jpg    (FB only)
//   node autopost.mjs --queue posts.json                           (multi-post queue)
//   add --dry-run to any command to preview without publishing.
//
// Config comes from a .env file next to this script (see .env.example).

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePublicJpeg } from "./image-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- env loader
async function loadEnv() {
  try {
    const raw = await readFile(resolve(HERE, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* no .env file — rely on real environment variables */
  }
}

const cfg = () => ({
  version: process.env.GRAPH_VERSION || "v21.0",
  pageId: process.env.FB_PAGE_ID,
  pageToken: process.env.FB_PAGE_TOKEN,
  igUserId: process.env.IG_USER_ID,
  // IG content publishing uses the linked Page's token unless overridden.
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
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

// --------------------------------------------------------------- graph helper
async function graph(path, fields, { token, version }, files = {}) {
  const url = `https://graph.facebook.com/${version}/${path}`;
  let body;
  if (Object.keys(files).length) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields))
      if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
    for (const [k, f] of Object.entries(files)) {
      const buf = await readFile(f);
      body.set(k, new Blob([buf]), basename(f));
    }
    body.set("access_token", token);
  } else {
    body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields))
      if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
    body.set("access_token", token);
  }
  const res = await fetch(url, { method: "POST", body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(
      `Graph API ${res.status}: ${e.message || text}` +
        (e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : "")
    );
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- post: facebook
async function postFacebook(c, { text, link, image, imageFile, dryRun }) {
  if (!c.pageId || !c.pageToken)
    throw new Error("Facebook needs FB_PAGE_ID and FB_PAGE_TOKEN in .env");
  const auth = { token: c.pageToken, version: c.version };

  if (imageFile) {
    if (dryRun) return { platform: "facebook", dryRun: true, kind: "photo(file)", imageFile };
    const r = await graph(`${c.pageId}/photos`, { message: text || "" }, auth, {
      source: imageFile,
    });
    return { platform: "facebook", kind: "photo", id: r.post_id || r.id, raw: r };
  }
  if (image) {
    if (dryRun) return { platform: "facebook", dryRun: true, kind: "photo(url)", image };
    const r = await graph(`${c.pageId}/photos`, { url: image, message: text || "" }, auth);
    return { platform: "facebook", kind: "photo", id: r.post_id || r.id, raw: r };
  }
  // text / link feed post
  if (!text && !link) throw new Error("Facebook post needs text, link, or an image");
  if (dryRun) return { platform: "facebook", dryRun: true, kind: link ? "link" : "text", text, link };
  const r = await graph(`${c.pageId}/feed`, { message: text || "", link: link || "" }, auth);
  return { platform: "facebook", kind: link ? "link" : "text", id: r.id, raw: r };
}

// ------------------------------------------------------------ post: instagram
async function postInstagram(c, { text, image, dryRun }) {
  if (!c.igUserId || !c.igToken)
    throw new Error("Instagram needs IG_USER_ID and a token (IG_TOKEN or FB_PAGE_TOKEN) in .env");
  if (!image)
    throw new Error("Instagram requires a public --image URL (no text-only or local-file posts)");
  const auth = { token: c.igToken, version: c.version };
  if (dryRun) return { platform: "instagram", dryRun: true, kind: "photo", image };

  // 1) create media container
  const container = await graph(
    `${c.igUserId}/media`,
    { image_url: image, caption: text || "" },
    auth
  );
  const creationId = container.id;

  // 2) publish (retry while the container is still processing)
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await graph(`${c.igUserId}/media_publish`, { creation_id: creationId }, auth);
      return { platform: "instagram", kind: "photo", id: r.id, raw: r };
    } catch (e) {
      lastErr = e;
      if (/not ready|media is not ready|9007|process/i.test(e.message)) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------- post: router
const isHttpUrl = (s) => /^https?:\/\//i.test(s || "");
const isJpegUrl = (s) => /\.jpe?g($|\?)/i.test(s || "");

async function publishOne(c, post) {
  const to = (post.to || (post.image || post.imageFile ? "fb" : "fb")).toLowerCase();
  const wantFb = to === "fb" || to === "facebook" || to === "both";
  const wantIg = to === "ig" || to === "instagram" || to === "both";
  const results = [];
  const errors = [];

  // Instagram needs a public JPEG URL. If the image is a local file or a
  // non-JPEG URL (webp/png), auto-convert + host it, and reuse that URL for FB too.
  const src = post.imageFile || post.image;
  if (wantIg && src && !(isHttpUrl(src) && isJpegUrl(src))) {
    if (post.dryRun) {
      console.log(`   (would convert + host for Instagram: ${src})`);
    } else {
      try {
        const url = await ensurePublicJpeg(src, process.env, {
          log: (m) => console.log(m),
        });
        post.image = url;
        post.imageFile = undefined;
      } catch (e) {
        errors.push(`image-host: ${e.message}`);
        return { results, errors }; // can't post the image anywhere reliably
      }
    }
  }

  if (wantFb) {
    try {
      results.push(await postFacebook(c, post));
    } catch (e) {
      errors.push(`facebook: ${e.message}`);
    }
  }
  if (wantIg) {
    try {
      results.push(await postInstagram(c, post));
    } catch (e) {
      errors.push(`instagram: ${e.message}`);
    }
  }
  return { results, errors };
}

// ----------------------------------------------------------------- queue mode
async function runQueue(c, file, dryRun) {
  const path = resolve(process.cwd(), file);
  const queue = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(queue)) throw new Error("Queue file must be a JSON array of posts");

  let posted = 0,
    skipped = 0,
    failed = 0;
  for (const post of queue) {
    if (post.posted === true) {
      skipped++;
      continue;
    }
    const label = post.id || post.text?.slice(0, 40) || "(untitled)";
    process.stdout.write(`\n• ${label}\n`);
    const { results, errors } = await publishOne(c, { ...post, dryRun });
    for (const r of results)
      console.log(
        `   ✓ ${r.platform} ${r.kind}${r.dryRun ? " [dry-run]" : ` -> ${r.id}`}`
      );
    for (const e of errors) console.log(`   ✗ ${e}`);

    if (!dryRun && errors.length === 0 && results.length) {
      post.posted = true;
      post.posted_at = new Date().toISOString();
      post.result_ids = results.map((r) => `${r.platform}:${r.id}`);
      posted++;
    } else if (errors.length) {
      post.last_error = errors.join("; ");
      failed++;
    }
  }
  if (!dryRun) await writeFile(path, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(
    `\nQueue done — posted ${posted}, already-done ${skipped}, failed ${failed}.` +
      (dryRun ? " (dry-run: nothing published, file unchanged)" : "")
  );
}

// ------------------------------------------------------------------- entry
async function main() {
  await loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const c = cfg();
  const dryRun = !!args["dry-run"];

  if (args.queue) {
    await runQueue(c, args.queue, dryRun);
    return;
  }

  const post = {
    to: args.to || (args.image || args["image-file"] ? "both" : "fb"),
    text: args.text || args.message,
    link: args.link,
    image: args.image,
    imageFile: args["image-file"],
    dryRun,
  };
  if (!post.text && !post.link && !post.image && !post.imageFile) {
    console.log(
      "Nothing to post. Try:\n" +
        '  node autopost.mjs --text "Hello"\n' +
        '  node autopost.mjs --text "Caption" --image "https://..." --to both\n' +
        "  node autopost.mjs --queue posts.json\n" +
        "Add --dry-run to preview."
    );
    process.exitCode = 1;
    return;
  }

  const { results, errors } = await publishOne(c, post);
  for (const r of results)
    console.log(`✓ ${r.platform} ${r.kind}${r.dryRun ? " [dry-run]" : ` -> ${r.id}`}`);
  for (const e of errors) console.log(`✗ ${e}`);
  if (errors.length && !results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exitCode = 1;
});
