# ApnaKhata

A simple digital cash book for **one business** — track cash in, cash out, and see where the money's going. No sign-up, no login form, no purchases, no server, no database. Everything runs in the browser.

**Stack:** plain HTML/CSS/JS. That's it — no build step, no backend, no accounts to configure. All data is stored locally in the browser via `localStorage`, so there is genuinely nothing running on a server and nothing to pay for, ever.

---

## Deploy it

1. Push this folder to a new GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub**, select the repo.
3. Build settings are already defined in `netlify.toml` (publish directory `public`, no build command, no functions). Netlify will pick this up automatically — just click **Deploy**.

That's the whole deployment. No environment variables, no database to provision, no API keys.

### Try it locally first (optional)

You don't need Node or any tooling — it's static files. Either:
- Open `public/index.html` directly in a browser, or
- Serve the folder with anything simple, e.g. `npx serve public` or Python's `python3 -m http.server --directory public`.

---

## How data storage works

- On first open, you'll be asked to set a **PIN** (4–8 digits). This becomes the lock for the ledger on that browser.
- All transactions are stored under a `localStorage` key in that specific browser, on that specific device.
- **This means your data does not sync across devices or browsers.** If you use ApnaKhata on your phone and your laptop, they'll have two separate, independent ledgers. Clearing your browser's site data, using private/incognito mode, or switching browsers will also start you with an empty ledger.
- **Backup regularly.** Settings → *Download backup (JSON)* saves everything to a file. Settings → *Restore from a backup file* loads it back in (e.g. after clearing your browser, or to move your ledger to a new device). Reports → *Export CSV* gives you a spreadsheet-friendly copy any time.

If losing data on browser-clear or wanting it to follow you across devices is a dealbreaker, the honest fix is adding a small cloud database back in — see "If you outgrow this" below.

## Security, as promised

There's no traditional login system, so here's exactly what is and isn't protecting your data:

- **PIN lock**, not a password login. The PIN is never stored in plain text — it's run through PBKDF2 (100,000 iterations, SHA-256) with a random salt, using the browser's built-in Web Crypto API, and only the resulting hash is kept in `localStorage`.
- **No password recovery.** Because there's no server and no account, there's nothing to reset a forgotten PIN against — that's the trade-off for having no backend at all. If you forget it, Settings → *Erase all data* is the only way back in (after which you'd restore from your last backup).
- **Session unlock expires after 12 hours** (stored in `sessionStorage`, which clears when the browser closes anyway).
- **Security headers** in `netlify.toml`: a strict Content-Security-Policy, `X-Frame-Options: DENY`, no MIME sniffing.
- **HTTPS everywhere**, automatically, via Netlify.

**Honest limitation:** because everything — including the PIN check — happens in the browser, this protects against a casual passerby glancing at the ledger, not against someone with real access to the device (e.g. via browser dev tools) or physical access to unlocked storage. Treat it the way you'd treat a notebook with a combination lock on the cover, not a bank vault.

---

## If you outgrow this

Pure static is the simplest and cheapest option, but it comes with two real limits: no cross-device sync, and data is only as safe as your last manual backup. If either becomes a problem, the natural next step (without ever running your own server) is:

| Option | What it adds |
|---|---|
| **Netlify Functions + MongoDB Atlas** | Real shared database behind a small serverless API — your ledger follows you to any device, still no server to manage, still free at this scale. |
| **Firebase (Firestore)** | The frontend talks to a hosted database directly using security rules instead of your own API — least code to add. |
| **Supabase (Postgres)** | Similar to Firebase, SQL-based, generous free tier. |

Happy to build any of these out if you want cross-device sync later — just ask.

---

## Project structure

```
public/
  index.html
  css/style.css
  js/app.js       → all app logic, including local storage and PIN hashing
  assets/favicon.svg
netlify.toml       → static hosting config + security headers
```
