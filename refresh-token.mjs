#!/usr/bin/env node
// refresh-token — swap a short-lived token for a long-lived (non-expiring) PAGE
// token and write it back into .env automatically.
//
// One-time setup in .env:
//   FB_APP_ID=...          (App dashboard > Settings > Basic)
//   FB_APP_SECRET=...      (same page — click "Show")
//   FB_USER_TOKEN=...      (Graph API Explorer: set "User or Page" = User Token,
//                           generate, copy it here. SHORT-lived is fine.)
//   FB_PAGE_ID=...         (already set)
//
// Then run:  node refresh-token.mjs
//
// What it does:
//   1) exchanges the short user token -> long-lived (~60 day) user token
//   2) reads the PAGE access token off that long-lived user token — page tokens
//      derived this way do not expire
//   3) verifies scopes, writes it into FB_PAGE_TOKEN=, and clears FB_USER_TOKEN
//
// Your secrets never leave this machine; nothing is printed except status.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, ".env");

function parseEnv(raw) {
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

// Replace a key's value in-place, preserving comments/order. Adds it if missing.
function setEnvValue(raw, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, "m");
  if (re.test(raw)) return raw.replace(re, `$1${value}`);
  return raw.replace(/\s*$/, "") + `\n${key}=${value}\n`;
}

async function gget(version, path, params) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error)
    throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function main() {
  const raw = await readFile(ENV_PATH, "utf8");
  const env = parseEnv(raw);
  const version = env.GRAPH_VERSION || "v21.0";
  const { FB_APP_ID, FB_APP_SECRET, FB_USER_TOKEN, FB_PAGE_ID } = env;

  const missing = ["FB_APP_ID", "FB_APP_SECRET", "FB_USER_TOKEN", "FB_PAGE_ID"].filter(
    (k) => !env[k]
  );
  if (missing.length) {
    console.error(
      "Missing in .env: " +
        missing.join(", ") +
        "\nFill them in (see the comments at the top of refresh-token.mjs) and re-run."
    );
    process.exitCode = 1;
    return;
  }

  console.log("1/3  Exchanging for a long-lived user token…");
  const longUser = await gget(version, "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET,
    fb_exchange_token: FB_USER_TOKEN,
  });
  const longUserToken = longUser.access_token;

  console.log("2/3  Fetching the long-lived Page token…");
  const pageRes = await gget(version, FB_PAGE_ID, {
    fields: "access_token,name",
    access_token: longUserToken,
  });
  const pageToken = pageRes.access_token;
  if (!pageToken)
    throw new Error(
      "No page access_token returned — is FB_PAGE_ID correct and does the user token admin that Page?"
    );

  console.log("3/3  Verifying scopes & expiry…");
  const dbg = await gget(version, "debug_token", {
    input_token: pageToken,
    access_token: pageToken,
  });
  const d = dbg.data || {};
  const scopes = d.scopes || [];
  const need = [
    "pages_manage_posts",
    "pages_read_engagement",
    "pages_show_list",
    "instagram_basic",
    "instagram_content_publish",
  ];
  const missingScopes = need.filter((s) => !scopes.includes(s));

  let out = setEnvValue(raw, "FB_PAGE_TOKEN", pageToken);
  out = setEnvValue(out, "FB_USER_TOKEN", ""); // clear the short token once used
  await writeFile(ENV_PATH, out, "utf8");

  const exp = d.expires_at;
  console.log(
    `\n✅ Page token for "${pageRes.name}" saved to .env.\n` +
      `   Expires: ${exp ? new Date(exp * 1000).toISOString() : "never"}${
        exp === 0 || exp == null ? " (non-expiring)" : ""
      }`
  );
  if (missingScopes.length)
    console.log("⚠️  Missing scopes: " + missingScopes.join(", ") +
      " — re-grant these in the Explorer if you need them.");
  else console.log("   All required scopes present. You're set.");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exitCode = 1;
});
