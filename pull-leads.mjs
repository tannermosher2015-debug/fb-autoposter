#!/usr/bin/env node
// pull-leads — fetch new Meta Instant Form (lead form) submissions via the Graph
// API, append them to leads.csv, and email each new one. Idempotent: tracks seen
// lead IDs in leads-seen.json so re-runs only report NEW leads. Cron-friendly.
//
// Uses the same .env as autopost.mjs. Needs FB_PAGE_TOKEN with `leads_retrieval`
// (the long-lived page token already has it). Email is optional — if SMTP_* isn't
// set, leads are still saved to leads.csv and printed.
//
// Run:  node pull-leads.mjs        (e.g. every 15 min via Task Scheduler / cron)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = resolve(HERE, "leads-seen.json");
const CSV_PATH = resolve(HERE, "leads.csv");

function parseEnv(raw) {
  const e = {};
  for (const l of raw.split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) { let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); e[m[1]] = v; }
  }
  return e;
}

async function gget(version, path, params, token) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return j;
}

// follow paging.next to collect all items
async function gall(version, path, params, token) {
  let out = [];
  let j = await gget(version, path, params, token);
  out = out.concat(j.data || []);
  while (j.paging?.next) {
    const res = await fetch(j.paging.next);
    j = await res.json();
    if (j.error) break;
    out = out.concat(j.data || []);
  }
  return out;
}

const flatten = (field_data = []) => {
  const o = {};
  for (const f of field_data) o[f.name] = (f.values || []).join(", ");
  return o;
};

const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

async function emailLead(env, lead, fields) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.LEAD_TO) return false;
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: String(env.SMTP_SECURE ?? "true").toLowerCase() !== "false",
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const name = fields.full_name || fields.name || "(no name)";
  const biz = fields.business_name || fields["what's_your_business_name?"] || "";
  const rows = Object.entries(fields).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`).join("");
  await t.sendMail({
    from: env.LEAD_FROM || env.SMTP_USER,
    to: env.LEAD_TO,
    subject: `New lead: ${name}${biz ? " — " + biz : ""}`,
    html: `<h2 style="font-family:sans-serif">New Instant Form lead</h2>
      <table style="font-family:sans-serif;font-size:15px">${rows}</table>
      <p style="font-family:sans-serif;color:#888;font-size:13px">Lead ${lead.id} · ${lead.created_time}</p>`,
  });
  return true;
}

async function main() {
  const env = parseEnv(await readFile(resolve(HERE, ".env"), "utf8"));
  const version = env.GRAPH_VERSION || "v21.0";
  const token = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID;
  if (!token || !pageId) { console.error("Missing FB_PAGE_ID / FB_PAGE_TOKEN in .env"); process.exitCode = 1; return; }

  const seen = new Set(existsSync(SEEN_PATH) ? JSON.parse(await readFile(SEEN_PATH, "utf8")) : []);
  const firstRun = seen.size === 0 && !existsSync(SEEN_PATH);

  const forms = await gall(version, `${pageId}/leadgen_forms`, { fields: "id,name,status" }, token);
  if (!forms.length) { console.log("No Instant Forms on this Page yet. Create one in Ads Manager, then re-run."); return; }
  console.log(`Found ${forms.length} form(s): ${forms.map((f) => f.name).join(", ")}`);

  const fresh = [];
  for (const form of forms) {
    let leads = [];
    try { leads = await gall(version, `${form.id}/leads`, { fields: "id,created_time,field_data,ad_id,form_id" }, token); }
    catch (e) { console.log(`  ⚠️ ${form.name}: ${e.message}`); continue; }
    for (const lead of leads) {
      if (seen.has(lead.id)) continue;
      seen.add(lead.id);
      fresh.push({ lead, form, fields: flatten(lead.field_data) });
    }
  }

  if (!fresh.length) { console.log("No new leads."); await writeFile(SEEN_PATH, JSON.stringify([...seen]), "utf8"); return; }

  // CSV
  const allKeys = [...new Set(fresh.flatMap((x) => Object.keys(x.fields)))];
  const header = ["lead_id", "created_time", "form", ...allKeys];
  let csv = existsSync(CSV_PATH) ? "" : header.map(csvCell).join(",") + "\n";
  for (const { lead, form, fields } of fresh)
    csv += [lead.id, lead.created_time, form.name, ...allKeys.map((k) => fields[k])].map(csvCell).join(",") + "\n";
  await writeFile(CSV_PATH, (existsSync(CSV_PATH) ? await readFile(CSV_PATH, "utf8") : "") + csv, "utf8");

  // Email (skip emailing on the very first run so an existing backlog doesn't blast you)
  let emailed = 0, emailable = !!(env.SMTP_HOST && env.LEAD_TO);
  if (emailable && !firstRun) {
    for (const { lead, fields } of fresh) { try { if (await emailLead(env, lead, fields)) emailed++; } catch (e) { console.log(`  ⚠️ email failed for ${lead.id}: ${e.message}`); } }
  }

  await writeFile(SEEN_PATH, JSON.stringify([...seen]), "utf8");
  console.log(`\n✅ ${fresh.length} new lead(s) saved to leads.csv` +
    (emailable ? (firstRun ? " (first run — emailing skipped to avoid backlog blast)" : `, ${emailed} emailed`) : " (no SMTP set — not emailed)"));
  for (const { fields } of fresh)
    console.log(`   • ${fields.full_name || fields.name || "(no name)"} — ${fields.email || ""} ${fields.phone_number || fields.phone || ""}`);
}

main().catch((e) => { console.error("Error:", e.message); process.exitCode = 1; });
