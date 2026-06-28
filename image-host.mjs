// image-host — turn any image (local file, or webp/png/jpg URL) into a public
// HTTPS JPEG that Instagram can fetch. Converts to JPEG via Python/Pillow and
// uploads to the Hostinger "assets" subdomain over FTP.
//
// Needed in .env for the upload step:
//   ASSET_BASE_URL=https://assets.frontlinewebdesign.tech
//   ASSET_REMOTE_DIR=domains/frontlinewebdesign.tech/public_html/assets
//   FTP_HOST=...        (hPanel > Files > FTP Accounts — "FTP IP/host")
//   FTP_USER=u987655740
//   FTP_PASS=...
//   FTP_SECURE=false    (set true to use FTPS explicit)
//   PYTHON=python       (optional override for the python executable)

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isUrl = (s) => /^https?:\/\//i.test(s);
const isJpegUrl = (s) => /\.jpe?g($|\?)/i.test(s);

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0 ? res(out.trim()) : rej(new Error(err.trim() || `${cmd} exited ${code}`))
    );
  });
}

const PY_CONVERT = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w, h = im.size
ratio = w / h
# Instagram accepts aspect ratios from 4:5 (0.8) to 1.91:1 — pad onto white if outside.
if ratio > 1.91 or ratio < 0.8:
    t = min(max(ratio, 0.8), 1.91)
    if ratio > t:
        nh = int(w / t); c = Image.new("RGB", (w, nh), "white"); c.paste(im, (0, (nh - h) // 2)); im = c
    else:
        nw = int(h * t); c = Image.new("RGB", (nw, h), "white"); c.paste(im, ((nw - w) // 2, 0)); im = c
# upscale small images so IG doesn't reject them
if im.size[0] < 1080:
    nw = 1080; nh = int(im.size[1] * 1080 / im.size[0]); im = im.resize((nw, nh), Image.LANCZOS)
im.save(dst, "JPEG", quality=90)
print(im.size[0], "x", im.size[1])
`;

async function convertToJpeg(srcPath, dstPath, python) {
  return run(python, ["-c", PY_CONVERT, srcPath, dstPath]);
}

async function ftpUpload(localPath, remoteName, cfg) {
  const { Client } = await import("basic-ftp");
  const client = new Client(30000);
  try {
    await client.access({
      host: cfg.host,
      user: cfg.user,
      password: cfg.pass,
      secure: cfg.secure,
      secureOptions: { rejectUnauthorized: false },
    });
    if (cfg.remoteDir) await client.ensureDir(cfg.remoteDir);
    await client.uploadFrom(localPath, remoteName);
  } finally {
    client.close();
  }
}

// Returns a public HTTPS JPEG URL for the given image input.
// - already-JPEG public URL  -> returned unchanged
// - webp/png/other URL or local file -> converted + uploaded, new URL returned
export async function ensurePublicJpeg(input, env, { log = () => {} } = {}) {
  if (isUrl(input) && isJpegUrl(input)) return input; // already good

  const python = env.PYTHON || "python";
  const cfg = {
    host: (env.FTP_HOST || "").replace(/^ftps?:\/\//i, "").replace(/\/.*$/, ""),
    user: env.FTP_USER,
    pass: env.FTP_PASS,
    secure: String(env.FTP_SECURE).toLowerCase() === "true",
    remoteDir: env.ASSET_REMOTE_DIR,
  };
  const base = (env.ASSET_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !cfg.host || !cfg.user || !cfg.pass)
    throw new Error(
      "Image needs conversion/hosting but ASSET_BASE_URL / FTP_HOST / FTP_USER / FTP_PASS are not all set in .env"
    );

  const work = await mkdtemp(join(tmpdir(), "fbap-"));
  try {
    // get the source onto disk
    let srcPath;
    if (isUrl(input)) {
      log(`   downloading ${input}`);
      const res = await fetch(input);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      srcPath = join(work, "src");
      await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));
    } else {
      srcPath = input; // local path
      await readFile(srcPath); // existence check (throws if missing)
    }

    const jpgPath = join(work, "out.jpg");
    const dims = await convertToJpeg(srcPath, jpgPath, python);
    log(`   converted to JPEG (${dims})`);

    const remoteName = `post-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    await ftpUpload(jpgPath, remoteName, cfg);
    const url = `${base}/${remoteName}`;
    log(`   uploaded -> ${url}`);

    // confirm it's actually reachable before handing to Instagram
    const head = await fetch(url, { method: "GET" });
    if (!head.ok)
      throw new Error(`uploaded image not reachable yet (HTTP ${head.status}) at ${url}`);
    return url;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
