# fb-autoposter

A tiny, dependency-free Node tool that publishes **organic** posts to a Facebook
Page and a linked Instagram Business account via the Meta **Graph API**.

> This is for *organic* posts (the free posts/scheduling side of Business Suite),
> not paid ads. It talks to the Graph API directly — the same way Buffer/Later do.

Supports:
- **Facebook**: text status, link post, photo (public URL **or** local file)
- **Instagram**: photo with caption (Instagram requires an image — no text-only posts)
- **Queue mode**: a JSON file of many posts; it publishes the un-posted ones and
  marks them done.

---

## 1. One-time setup (the part only you can do)

You need a **Page access token**. I can't create the Meta app or generate the
token for you (that's credential setup on your account), but here are the exact steps.

### A. Create a Meta app
1. Go to <https://developers.facebook.com/apps/> → **Create app**.
2. Use case: **Other** → type **Business** → finish.
3. In the app dashboard, add the **Facebook Login for Business** product (or just
   use the Graph API Explorer in the next step).

### B. Get the IDs and a token (quickest path: Graph API Explorer)
1. Open <https://developers.facebook.com/tools/explorer/>.
2. Top-right: pick your app.
3. Click **Add a Permission** and add:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   and (for IG) `instagram_basic`, `instagram_content_publish`.
4. Click **Generate Access Token**, approve the dialog, choosing your Page.
5. Run these in the Explorer to grab your IDs:
   - `me/accounts` → copy your Page's `id` (**FB_PAGE_ID**) and its `access_token`.
   - `{FB_PAGE_ID}?fields=instagram_business_account` → copy the
     `instagram_business_account.id` (**IG_USER_ID**), if you want IG.

### C. Make the token long-lived (so it doesn't expire in ~1 hour)
The Explorer token is short-lived. Exchange it once for a long-lived one:

1. Get your **App ID** and **App Secret** from the app dashboard → Settings → Basic.
2. Exchange the user token (60-day token):
   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_USER_TOKEN
   ```
3. Call `me/accounts` again **with that long-lived user token** — the Page token
   it returns is effectively non-expiring. Use that as **FB_PAGE_TOKEN**.

> If this is a brand-new app it starts in *Development mode*, which only works for
> Pages/accounts you admin — which is fine for posting to your own Page. You do not
> need App Review for that.

### D. Fill in your .env
```
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```
Then edit `.env` and paste your `FB_PAGE_ID`, `FB_PAGE_TOKEN`, and (optional)
`IG_USER_ID`. The real `.env` is git-ignored.

---

## 2. Posting

Always test with `--dry-run` first — it validates wiring without publishing.

```powershell
# Facebook text
node autopost.mjs --text "Aloha from our new tool!"

# Facebook link post
node autopost.mjs --text "New on the blog" --link "https://frontlinewebdesign.tech/blog/x"

# Photo from a public URL, to BOTH Facebook + Instagram
node autopost.mjs --text "Summer special!" --image "https://yoursite.com/img.jpg" --to both

# Photo from a LOCAL file (Facebook only — IG can't take local files)
node autopost.mjs --text "Behind the scenes" --image-file ".\photo.jpg"

# Preview anything without publishing
node autopost.mjs --text "test" --image "https://..." --to both --dry-run
```

### Flags
| Flag | Meaning |
|------|---------|
| `--text` (or `--message`) | post body / caption |
| `--link` | URL for a Facebook link post |
| `--image` | **public** image URL (works for FB and IG) |
| `--image-file` | local image path (FB only) |
| `--to` | `fb` \| `ig` \| `both` (default: `fb`, or `both` when an image is given) |
| `--queue <file>` | run a queue file instead of a single post |
| `--dry-run` | validate + preview, publish nothing |

---

## 3. Queue mode (post many)

Copy the sample and edit it:
```powershell
Copy-Item posts.example.json posts.json
```
Each entry:
```json
{
  "id": "promo-1",
  "to": "both",
  "text": "caption here",
  "image": "https://public-url/photo.jpg",
  "link": "",
  "posted": false
}
```
Run it:
```powershell
node autopost.mjs --queue posts.json --dry-run   # preview
node autopost.mjs --queue posts.json             # publish
```
After a successful publish each entry is stamped `"posted": true` with
`posted_at` and `result_ids`, so re-running the queue **skips** already-posted
items. Failures get a `last_error` and stay un-posted for a retry.

---

## Stop the token expiring (one-time)

Explorer tokens die after ~1 hour/day. To get a **non-expiring Page token**:

1. In `.env` fill: `FB_APP_ID`, `FB_APP_SECRET` (App dashboard → Settings → Basic,
   click "Show"), and `FB_USER_TOKEN` (Explorer → set **User or Page = User Token**
   → Generate → paste it).
2. Run:
   ```powershell
   node refresh-token.mjs
   ```
   It exchanges for a long-lived token, writes the Page token into `FB_PAGE_TOKEN=`,
   clears `FB_USER_TOKEN`, and prints the expiry (should say *non-expiring*).

## Instagram images are automatic now

Point the tool at **any** image — a local file, or a `.webp`/`.png`/`.jpg` URL — and
for Instagram it will auto-convert to JPEG and upload to your `assets` subdomain,
then post. One-time setup in `.env`:

- `ASSET_BASE_URL` / `ASSET_REMOTE_DIR` — already filled in.
- `FTP_HOST`, `FTP_PASS` — from **hPanel → Files → FTP Accounts** (`FTP_USER` is your
  hosting username, already filled).
- Requires Python + Pillow (`pip install Pillow`).

Then this just works:
```powershell
node autopost.mjs --text "New build!" --image-file ".\promo.webp" --to both
node autopost.mjs --text "New build!" --image "https://frontlinewebdesign.tech/work-thumbs/spa.webp" --to both
```
A `.jpg` URL that's already public is used as-is (no conversion/upload).

## Notes & gotchas
- **Instagram needs a publicly reachable image URL** — Meta fetches it server-side.
  You can host images on any of your sites (Hostinger). Local files won't work for IG.
- Instagram allows a limited number of API posts per day (currently 50/24h per account).
- If a token suddenly fails with code 190, it expired/was invalidated — regenerate
  the Page token (step C) and update `.env`.
- The Facebook photo caption is sent as `message`. If a photo's caption ever doesn't
  appear, that's the field to check in `autopost.mjs`.
