// image-host — host media as public URLs that Meta can fetch.
//  - hostImage(): convert any image -> JPEG (optionally padded to IG feed ratios)
//                 and upload; returns a public HTTPS URL.
//  - hostVideo(): upload an mp4 as-is; returns a public HTTPS URL.
// Uploads go to the Hostinger "assets" subdomain over FTP. Config in .env:
//   ASSET_BASE_URL, ASSET_REMOTE_DIR, FTP_HOST, FTP_USER, FTP_PASS, FTP_SECURE, PYTHON

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isUrl = (s) => /^https?:\/\//i.test(s || "");
const isJpegUrl = (s) => /\.jpe?g($|\?)/i.test(s || "");

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0 ? res(out.trim()) : rej(new Error(err.trim() || `${cmd} exited ${code}`))
    );
  });
}

// Pad version (for IG feed/carousel) keeps 0.8–1.91; "nopad" just re-encodes.
const PY_CONVERT = (pad) => `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w, h = im.size
ratio = w / h
PAD = ${pad ? "True" : "False"}
if PAD and (ratio > 1.91 or ratio < 0.8):
    t = min(max(ratio, 0.8), 1.91)
    if ratio > t:
        nh = int(w / t); c = Image.new("RGB", (w, nh), "white"); c.paste(im, (0, (nh - h) // 2)); im = c
    else:
        nw = int(h * t); c = Image.new("RGB", (nw, h), "white"); c.paste(im, ((nw - w) // 2, 0)); im = c
if im.size[0] < 1080:
    nw = 1080; nh = int(im.size[1] * 1080 / im.size[0]); im = im.resize((nw, nh), Image.LANCZOS)
im.save(dst, "JPEG", quality=90)
print(im.size[0], "x", im.size[1])
`;

function ftpCfg(env) {
  return {
    host: (env.FTP_HOST || "").replace(/^ftps?:\/\//i, "").replace(/\/.*$/, ""),
    user: env.FTP_USER,
    pass: env.FTP_PASS,
    secure: String(env.FTP_SECURE).toLowerCase() === "true",
    remoteDir: env.ASSET_REMOTE_DIR,
    base: (env.ASSET_BASE_URL || "").replace(/\/+$/, ""),
  };
}

function assertHostCfg(c) {
  if (!c.base || !c.host || !c.user || !c.pass)
    throw new Error(
      "Hosting needs ASSET_BASE_URL / FTP_HOST / FTP_USER / FTP_PASS in .env"
    );
}

async function ftpUpload(localPath, remoteName, c) {
  const { Client } = await import("basic-ftp");
  const client = new Client(30000);
  try {
    await client.access({
      host: c.host, user: c.user, password: c.pass,
      secure: c.secure, secureOptions: { rejectUnauthorized: false },
    });
    if (c.remoteDir) await client.ensureDir(c.remoteDir);
    await client.uploadFrom(localPath, remoteName);
  } finally {
    client.close();
  }
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const uniq = (ext) => `post-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;

async function verify(url) {
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`uploaded media not reachable (HTTP ${r.status}) at ${url}`);
  return url;
}

// Convert an image to JPEG and host it. pad=true => IG feed/carousel safe ratio.
export async function hostImage(input, env, { pad = false, log = () => {} } = {}) {
  if (isUrl(input) && isJpegUrl(input) && !pad) return input; // already usable
  const c = ftpCfg(env);
  assertHostCfg(c);
  const python = env.PYTHON || "python";
  const work = await mkdtemp(join(tmpdir(), "fbap-"));
  try {
    let srcPath;
    if (isUrl(input)) {
      log(`   downloading ${input}`);
      srcPath = join(work, "src");
      await fetchToFile(input, srcPath);
    } else srcPath = input;
    const jpg = join(work, "out.jpg");
    const dims = await run(python, ["-c", PY_CONVERT(pad), srcPath, jpg]);
    log(`   converted to JPEG ${pad ? "(feed-padded) " : ""}(${dims})`);
    const name = uniq("jpg");
    await ftpUpload(jpg, name, c);
    const url = `${c.base}/${name}`;
    log(`   uploaded -> ${url}`);
    return await verify(url);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Upload a video (mp4) as-is and host it.
export async function hostVideo(input, env, { log = () => {} } = {}) {
  if (isUrl(input) && /\.mp4($|\?)/i.test(input)) return input;
  const c = ftpCfg(env);
  assertHostCfg(c);
  const work = await mkdtemp(join(tmpdir(), "fbap-"));
  try {
    let srcPath;
    if (isUrl(input)) {
      log(`   downloading ${input}`);
      srcPath = join(work, "src.mp4");
      await fetchToFile(input, srcPath);
    } else {
      srcPath = join(work, "src.mp4");
      await copyFile(input, srcPath);
    }
    const name = uniq("mp4");
    log(`   uploading video…`);
    await ftpUpload(srcPath, name, c);
    const url = `${c.base}/${name}`;
    log(`   uploaded -> ${url}`);
    return await verify(url);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Back-compat: old name used by IG single-image feed posts (padded).
export const ensurePublicJpeg = (input, env, opts = {}) =>
  hostImage(input, env, { ...opts, pad: true });
