# Put sitesnap online (free page with an email gate)

This turns sitesnap into a web page that anyone can use for free. Visitors do
not sign in. They type an email address once, then the tool opens.

## 1. Deploy

1. Create a free account at [render.com](https://render.com).
2. Press the button below, or in Render choose **New, Blueprint** and pick
   this repository. `render.yaml` does the rest.

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/devamparmar009/sitesnap)
3. Wait for the build (a few minutes). Render gives you an address like
   `https://sitesnap-xxxx.onrender.com`. That is your live link.

The same `Dockerfile` runs on Fly.io, Railway, a VPS, or anywhere that runs Docker.

## 2. Keep the email list safe

Render's free plan wipes its disk on every restart and redeploy, so the file
`emails.jsonl` is only a short-term copy. Pick one:

- **Webhook (recommended).** Set `SITESNAP_EMAIL_WEBHOOK` to a URL that accepts
  a JSON `POST` with `{ "email", "at", "source" }`. Zapier, Make, n8n, a Google
  Apps Script web app, or Formspree can all receive it and write a row in a sheet.
- **Download.** While the server is awake, fetch the list with
  `curl -H "Authorization: Bearer $SITESNAP_ADMIN_KEY" https://YOUR-ADDRESS/admin/emails.csv`.
  Render generated `SITESNAP_ADMIN_KEY` for you; find it under Environment.

## 3. Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SITESNAP_HOSTED` | `1` in Docker | Turns on the email gate, per-visitor privacy and limits. |
| `SITESNAP_SECRET` | random | Signs visitor cookies. Set it, or everyone is asked again after a restart. |
| `SITESNAP_ADMIN_KEY` | none | Lets you download the email list. Unset means that route is off. |
| `SITESNAP_EMAIL_WEBHOOK` | none | Where each new email is also sent. |
| `SITESNAP_MAX_PAGES` | 60 | Pages per save. |
| `SITESNAP_MAX_MB` | 100 | Size per save. |
| `SITESNAP_MAX_MINUTES` | 8 | Time per save. |
| `SITESNAP_KEEP_MINUTES` | 30 | How long a finished save is kept before it is deleted. |
| `SITESNAP_MAX_JOBS` | 2 | Saves running at once, across all visitors. |
| `SITESNAP_DAILY_SAVES` | 10 | Saves per visitor per day. |

## What the free page does and does not do

- It always obeys `robots.txt`, always blocks private network addresses, and
  saves one site per visitor at a time.
- It does not run the built-in browser, so sites that build their pages with
  code can come out blank. The desktop app handles those.
- It has no in-browser viewer. Visitors download a zip and double-click
  **Open me.html**.
- The email is checked for shape only. No message is sent, so addresses are
  not verified.

## Your responsibilities

You are collecting personal data. Tell visitors what you do with it (the gate
page has a short note: edit `public/gate.html` to match what you really do),
honour requests to remove an address, and check what privacy rules apply where
you and your visitors live. Anything people save with your server is requested
from your server's address, so expect complaints to reach you.
