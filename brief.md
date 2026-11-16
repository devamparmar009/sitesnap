<div align="center">

<img src="public/favicon.svg" width="64" alt="sitesnap logo" />

# sitesnap, the full brief

**Everything about sitesnap in one place: every feature in plain words, then the command line, how it works inside, and the security and test notes.**

New here? Start with the short [README](README.md) and its two-minute video.

</div>

## Contents

1. [What sitesnap is](#1-what-sitesnap-is)
2. [Why people save websites](#2-why-people-save-websites)
3. [Every feature, in plain words](#3-every-feature-in-plain-words)
4. [Using the app, step by step](#4-using-the-app-step-by-step)
5. [What it can save](#5-what-it-can-save)
6. [Where it falls short](#6-where-it-falls-short)
7. [The command line](#7-the-command-line)
8. [How it works inside](#8-how-it-works-inside)
9. [Security notes](#9-security-notes)
10. [Technical limits](#10-technical-limits)
11. [Tests](#11-tests)
12. [Hosting it for other people](#12-hosting-it-for-other-people)
13. [Courtesy and licence](#13-courtesy-and-licence)

---

## 1. What sitesnap is

sitesnap saves a whole website onto your computer: its pages, pictures, fonts and styles. Afterwards the copy opens without the internet, and the links between its pages still work. Think of "Save as PDF", but for an entire website.

| | |
| --- | --- |
| **What you get** | A folder with the site's pages, pictures, fonts and styles, and a zip file of the same. |
| **What you need** | Node.js 18 or newer (free, from [nodejs.org](https://nodejs.org)) and an internet connection while saving. No account. Runs on Mac, Windows and Linux. Once built, the double-click app (Mac or Linux) needs nothing else. |
| **Where it lives** | In `Documents / sitesnap` on your computer. Nothing you save is uploaded. |
| **What it costs** | Nothing to run. No fees and no subscription. |
| **What it is not** | A backup you can restore a website from, or a licence to copy things you have no right to copy. |

## 2. Why people save websites

Websites vanish more often than people expect. Hosting lapses, businesses close, and redesigns throw old pages away. A saved copy stays where you put it. 38% of web pages that existed in 2013 could no longer be reached by October 2023. ([Pew Research Center, May 2024](https://www.pewresearch.org/data-labs/2024/05/17/when-online-content-disappears/))

- **Before a redesign or a move.** The site is about to be rebuilt. A copy shows exactly how it looked and what it said, so nothing is lost in the switch.
- **A site that is closing.** A business, event, club or project is winding down and the hosting will lapse. A copy keeps the story.
- **No internet.** Flights, ships, classrooms and work in the field. Take the whole site with you.
- **Handing it over.** A designer gives a client a folder they can open by double-clicking, with no hosting needed.
- **Your own records.** A copy of what a page said on a given day. Useful for your files, though it is not certified legal evidence.
- **Reading and research.** Documentation or articles you rely on. A deleted page then can't surprise you.

## 3. Every feature, in plain words

Each feature gets a sentence in plain words, and a small line on how it works.

### Before it saves

- **It looks the site up first.** You see the site's name, icon and preview picture, and a rough page count, before anything is saved. If you typed a wrong address you find out in a second.
  <br /><sub>How: The check reads the page, the site's robot rules and its page list, then fetches the icon and preview image. It takes a second or two.</sub>
- **It warns you about problems early.** Three common problems get a notice before you start: a page that needs a sign-in, a site that builds itself with code, and a site that asks not to be copied.
  <br /><sub>How: Each notice comes with the button that fixes it, such as Sign in first or Set up modern site mode.</sub>
- **Errors are written for people.** A mistyped address says "We couldn't find that website", not "fetch failed". Most errors come with a button for the next step.
  <br /><sub>How: The technical text is tucked behind a Technical details link, in case you need to pass it to someone.</sub>

### While it saves

- **You choose how much and how big.** Just this page, this section or the whole website, at three sizes. Nobody has to know what "depth" means.
  <br /><sub>How: Behind the scenes these set how many clicks deep to go, and how many pages, files and megabytes are allowed.</sub>
- **Modern site mode.** Some sites build their pages with code after they load. This mode opens each page in a built-in browser first, so you get the finished page and not a blank one.
  <br /><sub>How: It is a one-time download of about 150 MB, set up from a button. It is slower, so it stays off unless a site needs it. It can also scroll each page so late-loading pictures are saved.</sub>
- **Sign in first.** For pages behind a login. A real browser window opens, you sign in as normal, and sitesnap saves the pages as you see them.
  <br /><sub>How: sitesnap never sees your password. It borrows the signed-in session for that one download, keeps it in memory only, and sends it to that site only.</sub>
- **Polite by default.** It follows a site's robot rules unless you switch that off, waits when a site says it's busy, and has a Go gently switch for fragile sites.
  <br /><sub>How: If a site refuses it, sitesnap tries two other ordinary browser identities before giving up. It never tries to get past "prove you're human" screens.</sub>
- **It keeps going without you.** Close the tab, or come back another day, and the save carries on as long as sitesnap itself is running. Stop keeps what is saved so far.
  <br /><sub>How: The download belongs to the app, not to the browser tab. Two saves can run at once.</sub>
- **A live map and honest progress.** The site draws itself as pages are saved, next to a percentage, the time left and a count of pages, pictures and files. "Tell me when it's done" sends a notification and a chime.
  <br /><sub>How: The map is drawn from real data: each dot is a page that was really saved, and each spark is a file arriving.</sub>

### After it saves

- **It works offline for real.** Links between pages are rewritten to point at the saved files, and pictures, fonts, styles and scripts come along.
  <br /><sub>How: It also handles things a page builds while it runs, such as 3D models and addresses assembled by code, so the copy doesn't quietly go back to the internet.</sub>
- **A viewer inside the app.** Open the copy in sitesnap, with a searchable list of its pages down the side. No unzipping and no setup.
  <br /><sub>How: Saved sites are shown from a separate address, so a copied site's own code can't take control of sitesnap.</sub>
- **A zip with an Open me page.** The zip file has a page called Open me at the top. Double-click it and the saved site opens in your browser.
  <br /><sub>How: The private resume notes sitesnap keeps for itself are left out of the zip, because they list every address it visited.</sub>
- **A library you can find again.** Everything you save goes to Documents / sitesnap, one folder per save, named with the site and the date.
  <br /><sub>How: Nothing is deleted on a timer. From Your library you can open, zip, show or delete each copy.</sub>
- **Check the site for changes.** Run a saved site again and sitesnap downloads only the files that changed since last time.
  <br /><sub>How: It asks the site whether each file is newer, which is much faster than starting over. A fresh save makes a new dated folder, if you want to keep versions.</sub>

### Control and privacy

- **Private by design.** sitesnap runs on your computer and keeps what you save there. It has no account, no tracking and no upload.
  <br /><sub>How: The only traffic is to the site you are saving, plus the one-time download of the browser engine if you turn on modern site mode.</sub>
- **Limits that protect your disk.** Each save has a cap on pages, files and total size, so a huge or endless site can't fill your drive.
  <br /><sub>How: Limits apply per file and per request as well, and a request that stalls is dropped.</sub>
- **More options.** Sub-sites, the site's own page list, robot rules, words to include or skip, and your own page and space limits, all in plain language.
  <br /><sub>How: These are the same controls developers use on the command line.</sub>
- **The double-click app.** A Mac or Linux app you open like any other. There is nothing else to install, and the page has a Quit button. On Windows, use `npm run app` for now.
  <br /><sub>How: It is a packaged copy of the Node.js runtime with sitesnap inside. On another Mac the first launch needs a right-click and Open, because Apple has not approved it.</sub>
- **A command line for developers.** Every option is also a command, for scripts and scheduled jobs.
  <br /><sub>How: For example: `node bin/cli.js https://example.com --zip`.</sub>

## 4. Using the app, step by step

```bash
npm run app     # opens your browser on it, with a Quit button
npm start       # the same server, for developers: no auto-open, Ctrl-C to stop
```

The app is built for people who have never heard of a crawler. Nothing on the
screen says "depth", "robots.txt" or "glob".

1. **Paste an address.** sitesnap looks the site up first and shows its name,
   icon and preview picture, roughly how big it is, and anything that would
   spoil the copy: a page that needs you signed in, a site that builds its
   pages with JavaScript, robot rules that ask tools to stay away. A typo gets
   "We couldn't find that website", not `fetch failed`.
2. **Answer two questions.** *How much?* Just this page, this section, or the
   whole website. *How big?* Quick look (25 pages), Normal (150) or Everything
   (1,000). Every developer option still exists under **More options**, in
   plain words.
3. **Watch it save.** A live map of the site draws itself: the page you pasted
   in the middle, each saved page as a point on a ring (one ring per level of
   the address), files flying in to the page that needed them. A progress bar
   with time left, a plain-English tally, and an optional "tell me when it's
   done" notification and chime. You can close the tab; the download carries
   on, and reopening the app picks it back up.
4. **Open it.** The finished copy opens inside the app, with a searchable list
   of its pages. Or save it as a zip (with an **Open me.html** at the top), or
   show its folder.

Everything you save is kept in **Your library**, in `Documents/sitesnap`, one
readable folder per copy (`example.com 2026-10-08 10-42/`), each with its own
`Open me.html`. **Check the site for changes** re-runs a copy, downloading only
what changed. Nothing is swept away after an hour any more.

**Pages behind a login.** *Sign in first* opens a real browser window on the
site. You sign in there as usual; sitesnap never sees the password. It borrows
the signed-in session's cookies for that one download, keeps them in memory
only, and sends them to that site only.

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | the app's port |
| `SITESNAP_VIEW_PORT` | `PORT + 1` | the port saved sites are shown from (see Security notes) |
| `HOST` | `127.0.0.1` | bind address |
| `SITESNAP_LIBRARY` | `~/Documents/sitesnap` | where saved sites are kept |
| `SITESNAP_HOME` | per-user app data folder | where modern site mode is installed |
| `SITESNAP_BLOCK_PRIVATE` | unset | `1` refuses private/loopback/metadata targets |
| `SITESNAP_OPEN` | `1` | `0` stops `npm run app` opening the browser |

### More options

Under **More options** on the plan screen. Every developer option is here, in plain words.

| Option | What it does |
| --- | --- |
| Modern site mode | Runs each page in a built-in browser first, for sites that build themselves with code. Slower. One-time download of about 150 MB. |
| Go gently | Waits between pages. Use it if a site says you are visiting too fast. |
| Include sub-sites | Also saves addresses such as blog.example.com and shop.example.com. |
| Ignore the site's robot rules | Only for your own site, or with the owner's permission. |
| Use the site's own page list | Reads the list of pages the site publishes (its sitemap), which finds pages nothing links to. |
| Only save / Skip | Saves only addresses containing certain words, or skips them. Words such as blog or .pdf work. |
| Most pages / Most space | Your own limits, in place of the three sizes. |

### The desktop app

```bash
npm run build:app
```

produces `dist/sitesnap.app` and `dist/sitesnap-mac.zip` on macOS (a single
`dist/sitesnap` executable on Linux). Double-click it and your browser opens
on sitesnap. There is no Dock icon; the page's **Quit** button closes it, and
opening the app again while it runs simply reopens the page.

It is a Node "single executable application": the app is bundled with
esbuild, the page files ride along as embedded assets, and both are packed
into the official Node.js runtime for your platform. The build downloads that
runtime from nodejs.org once (into `.build-cache/`) and checks it against the
SHA-256 nodejs.org publishes. Homebrew's Node, among others, is compiled
without single-executable support, which is why the build does not reuse it.

The app is signed ad hoc, which is enough on the Mac that built it. On another
Mac, the first launch needs right-click → **Open** (it is not notarised by
Apple). The app prefers IPv4 when it connects, since a double-clicked app gets
none of your shell's settings and some networks stall on IPv6.

## 5. What it can save

sitesnap saves most ordinary public websites as they are. Sites that build their pages in the browser need one extra setting, pages behind a login need you to sign in first, and sites behind a bot-protection screen stay blocked.

### Works out of the box

Sites where the server sends the whole page:

- **Blogs, portfolios, small-business sites and landing pages.**
- **WordPress and most other CMS sites.**
- **Documentation sites and wikis.** Save one section by starting at, say, `/docs/` and choosing "This section".
- **News and article pages.**
- **Sites with a sitemap.** sitesnap uses it to find pages that nothing links to.
- **Older and non-English sites** in other text encodings (Shift_JIS, windows-1252). They are converted so the copy is not garbled.
- **Sites that redirect** (`example.com` to `www.example.com`, or to a country version). The save follows to wherever the address lands.
- **Sites with 3D models and WebGL.** Model and texture files (`.glb`, `.gltf`, `.bin`, `.hdr`, `.ktx2` and more) are saved with the page.
- **Your own local dev server**, such as `http://localhost:3000`.
- **Sites that turn away unfamiliar browsers.** sitesnap tries again as Chrome, then Firefox, then Safari.

### Needs "Modern site mode"

Turn it on under **More options** (CLI: `--render`). It is a one-time download of about 150 MB, and saving is slower.

- **Apps that build their pages in the browser** with React, Vue, Angular and similar. Without this mode you get an empty shell.
- **Pages whose pictures load as you scroll.** Keep "Scroll each page" ticked (CLI: `--scroll`).
- **Slow pages.** Tick "Give slow pages extra time to finish" (CLI: `--settle 4000`).

See [JavaScript-rendered sites](#javascript-rendered-sites).

### Needs you to sign in

- **Members areas, account pages and private docs.** In the app, **Sign in first** opens a real browser window and you sign in there; sitesnap never sees the password. It borrows that session for one download and sends it to that site only. The CLI takes `--cookie` or `-H` instead.

### Saved, but partly live or limited

- **Features that ask the live server while you browse**, such as server-side search, contact forms, comments, live feeds and chat. The copy is files, not the server, so these do not work offline.
- **Some advanced app code.** Files loaded by background workers, some WebAssembly and `importScripts` still come from the live site. See [Limits](#10-technical-limits).
- **Very large sites.** The app's sizes go up to 1,000 pages ("Everything"), and **More options → Most pages** raises that to 5,000. The CLI defaults to 200 pages and 500 MB, both adjustable.
- **Sub-sites** such as `blog.example.com` are skipped unless you switch on **Include sub-sites** (CLI: `--subdomains`).

### Won't save

- **Sites behind a bot-protection challenge** (a "checking your browser" screen). sitesnap names the block and stops. It does not solve CAPTCHAs or try to get around the check.
- **Pages the site's robots.txt asks tools to avoid.** **Ignore the site's robot rules** (CLI: `--ignore-robots`) turns this off; use it only on your own site or with the owner's permission.
- **Private or internal network addresses on the hosted page.** The hosted page always blocks them and always obeys robots.txt, and it saves at most 60 pages by default.

### Whose sites you can save

Only save sites you have the right to copy. The site's terms of service and copyright still apply. Safe choices are your own sites, sites whose owner has said yes, openly licensed documentation, and practice sites built for this, such as [books.toscrape.com](https://books.toscrape.com).

## 6. Where it falls short

Know these before you promise anyone anything.

- **It is a picture with working links, not the live site.** Search boxes, shopping carts, comment forms and logins need the website's own computer to think. They don't work in a saved copy.
- **It is not a backup.** You can't restore a WordPress site, its admin area or its database from a sitesnap copy. It holds what visitors saw.
- **Some sites say no.** If a site shows a "checking your browser" screen, sitesnap stops and says so. It doesn't try to get around it, and that is on purpose.
- **Parts from other services may not work.** Embedded maps, videos from other services and chat widgets can still call the live internet, so they may not show offline.
- **Very large sites are capped.** The three sizes stop at 1,000 pages. Under More options the limit goes to 5,000.
- **It is not certified evidence.** A saved copy is dated by its folder name and nothing is signed or sealed. Regulated firms and courts expect a signed timestamp and a tamper seal.
- **No double-click app for Windows yet.** sitesnap itself runs on Mac, Windows and Linux, and its tests pass on all three. On Windows you start it with `npm run app`. On another Mac, the double-click app's first launch needs a right-click and Open.
- **Modern site mode costs time and space.** It needs a one-time download of about 150 MB and each page takes longer.

## 7. The command line

### Install

Node 18+ (uses built-in `fetch`). Tested on the current Node LTS on macOS, Windows and Ubuntu.

```bash
npm install
```

Four dependencies: `express`, `ws`, `cheerio`, `archiver`. (`esbuild` is a dev
dependency, used only to build the desktop app.)

For `--render` only, add Playwright separately — see
[JavaScript-rendered sites](#javascript-rendered-sites). In the app this is a
button: **More options → Modern site mode → Set it up**.

### CLI

```bash
node bin/cli.js <url> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --out <dir>` | `./snapshots/<host>` | output directory |
| `-z, --zip` | off | also produce a `.zip` |
| `-d, --depth <n>` | 5 | max link depth from the start page |
| `-p, --max-pages <n>` | 200 | max HTML pages |
| `-f, --max-files <n>` | 3000 | max total files |
| `-c, --concurrency <n>` | 6 | parallel requests |
| `--max-mb <n>` | 500 | total download budget |
| `--timeout <ms>` | 30000 | inactivity timeout, network **and** disk (see below) |
| `--subdomains` | off | follow links to subdomains |
| `--all-paths` | off | allow climbing above the start path |
| `--ignore-robots` | off | don't read robots.txt |
| `--block-private` | off | refuse private / loopback / metadata addresses |
| `-q, --quiet` | off | only print the summary |
| `-i, --include <pat>` | — | only crawl pages matching (repeatable) |
| `-x, --exclude <pat>` | — | never fetch anything matching (repeatable) |
| `--sitemap` | off | seed from sitemap.xml |
| `--max-sitemap <n>` | 5000 | cap URLs taken from the sitemap |
| `--retries <n>` | 2 | retries per request on 429/5xx/network |
| `--delay <ms>` | 0 | pause between requests, shared by all workers |
| `--render` | off | run JavaScript before mirroring (needs Playwright) |
| `--scroll` | off | scroll rendered pages to load lazy content |
| `--settle <ms>` | 1200 | min time to let a rendered page finish |
| `--resume` | off | reuse unchanged files from a previous run |
| `-H, --header <h>` | — | extra request header (repeatable) |
| `--cookie <c>` | — | shorthand for `-H "Cookie: ..."` |
| `-A, --user-agent <ua>` | a current Chrome | who to identify as |
| `--no-runtime-rewrite` | off | don't ship the runtime URL map |

```bash
# a docs section only, three levels deep, zipped
node bin/cli.js https://example.com/docs/ --depth 3 --zip

# your own dev server
node bin/cli.js http://localhost:3000 -o ./backup --ignore-robots
```

`Ctrl-C` stops cleanly and keeps what has already been written.

#### Opening the result

Serve (or open) the **mirror root** — the directory containing the host
folders — not the host folder itself:

```
snapshots/example.com/          <- the mirror root: serve THIS
  www.example.com/index.html
  cdn.example.com/...           <- cross-origin assets live beside it
```

Assets pulled from other hosts are stored as sibling directories and linked
with `../otherhost/…`. Serving the host folder as the document root puts those
links above it, and every cross-origin image silently 404s.

### Getting exactly the pages you want

Three tools, in the order you should reach for them.

#### 1. Start in the right place

`--no-parent` is on by default, so the crawl stays at or below your start
path. Starting at `/docs/` rather than `/` is the single biggest lever you
have — it is more effective than any filter.

#### 2. Filter with globs

```bash
# only the CSS reference, and never a PDF
node bin/cli.js https://developer.mozilla.org/en-US/docs/Web/CSS \
  -i '/en-US/docs/Web/CSS/*' -x '*.pdf'
```

- `*` **crosses `/`**, so `/docs/*` means everything under `/docs`. Segment-
  bounded globbing is right for filesystems and wrong for URLs.
- A trailing `/*` also matches the bare directory, so `/docs/*` covers `/docs`
  itself — otherwise you would silently lose the section's index page.
- `?` matches one non-slash character.
- A pattern starting with `/` is matched against the path + query. Anything
  else is matched against the whole URL, so `*.pdf` and
  `https://cdn.example.com/*` both work.
- `re:` takes a raw regex: `-i 're:^/(docs|guide)/'`.

Two rules worth knowing, because they are what make filtered mirrors actually
render:

- **`--include` gates pages only.** Styling usually lives outside the content
  path you asked for, so filtering assets by `--include` would strip the CSS
  and fonts from the very pages you kept. `--exclude` does apply to assets.
- **The start URL is exempt from `--include`.** You named it as the entry
  point, and it is what discovers the links your include selects from.
  `--exclude` still applies to it.

#### 3. Use the site's own map

```bash
node bin/cli.js https://example.com --sitemap --zip
```

A sitemap is the site telling you its URL list. It finds pages that are linked
from nowhere, skips pagination and tag sprawl, and removes the need to guess a
depth. Handles sitemap index files and gzipped `.xml.gz`, and reads
`Sitemap:` directives from robots.txt.

Sitemap URLs still obey scope, filters and budgets — it seeds the crawl, it
does not override it. Combine the two for real precision:

```bash
node bin/cli.js https://example.com --sitemap -i '/blog/2024/*'
```

`--max-sitemap` caps *accepted* URLs — filtering happens during the walk, not
after truncation, so a narrow `--include` over a huge sitemap still finds its
matches.

## 8. How it works inside

### Why this exists rather than a wget wrapper

The popular Node website-downloaders shell out to `wget`:

```js
exec(`wget -mkEpnp ${userSuppliedUrl}`)   // don't
```

That is a command injection. Anything after a `;` in the URL field runs as the
server user, and because a WebSocket handshake is not blocked by the
same-origin policy, *any page open in your browser* can drive a permissive
localhost server into doing it.

The crawler has **no `child_process` and no shell**. It is pure Node `fetch`.
There is no shell to inject into — the bug class is absent by construction, not
by escaping. It also means no `wget` dependency, which matters on macOS, where
`wget` isn't installed by default.

The app around the crawler starts other programs in exactly one file,
`lib/system.js`, for three fixed jobs: opening your browser on the app's own
`http://127.0.0.1` address, showing a saved site's folder in Finder or
Explorer, and running the optional browser-engine installer. All three use an
argument array with no shell, and none of them is ever handed text a person
typed or a site sent.

### The two passes

Two passes, and the split is forced by a real constraint.

The local filename of a resource depends on what the server actually served: a
URL like `/about` with no extension only becomes `about.html` once we've seen
`Content-Type: text/html`. So a link can't be rewritten until its target has
been fetched.

1. **Crawl** — breadth-first from the start URL. HTML pages yield more pages
   (scope-limited) and assets; stylesheets are parsed too, so `@import` chains
   and `url(...)` fonts come along. Everything is written to disk raw, and a
   manifest records `url -> local path`.
2. **Rewrite** — each saved HTML and CSS file is reread and its references
   repointed at local files. Anything that *wasn't* downloaded (out of scope,
   failed, over budget) is rewritten to an absolute URL, so the page degrades
   to the live site instead of 404-ing.

Redirects are recorded under both the requested and final URL, so links to
either resolve.

### JavaScript-rendered sites

A client-rendered app serves a `<div id="root">` and builds the real page in
the browser. Mirrored as-is, that is an empty shell.

```bash
npm install playwright && npx playwright install chromium
node bin/cli.js https://app.example.com --render
```

Rendering drives a real headless browser, waits for the network to settle, and
mirrors the resulting DOM — so script-generated content *and* script-generated
links are both captured.

Playwright is **not** a declared dependency. It pulls a ~150MB browser, which
is an absurd cost for the common case of mirroring a static site, so it is
installed on demand and loaded lazily. Without it, `--render` fails with
install instructions; everything else works untouched.

It is also much slower — a real browser per page. Use it when you need it.

#### Knowing when a page is "done"

This is the hard part of rendering, and the obvious answer is wrong.

Waiting for the network to fall silent (`networkidle`, the usual default)
fails badly on the real web: analytics beacons, chat widgets, ad refreshes,
polling and websockets mean a great many sites **never** go idle. The page
finishes rendering in milliseconds and the wait burns the entire timeout
anyway — then throws the finished DOM away. On a page like that, rendering
used to take 17s and still capture nothing.

sitesnap decides readiness from the document instead. A page is done when
three things agree:

- the rendered DOM has stopped changing for a short quiet period,
- no requests are in flight, and
- at least `--settle` ms have passed.

The last one matters because "the DOM stopped changing" is ambiguous — a page
showing `loading…` is perfectly stable, and capturing it would mirror the
spinner. Everything is capped so a never-quiet site still returns promptly.

**A navigation timeout is not treated as failure.** The browser usually holds
a perfectly good page while some straggling third-party script keeps the
navigation pending; that page is kept and flagged as possibly incomplete
rather than discarded.

If a page's content appears on a **timer** with no network request to wait on,
nothing observable distinguishes "still rendering" from "finished" — raise the
floor:

```bash
node bin/cli.js https://slow-app.example --render --settle 4000
```

#### Lazy-loaded content

Many sites only request images as they approach the viewport, so a mirror
taken without scrolling is missing them. `--scroll` scrolls to the bottom
(capped, so an infinite feed cannot run forever), waits for what that pulls
in, then returns to the top:

```bash
node bin/cli.js https://example.com --render --scroll
```

### When a site refuses you

The most common reason a mirror comes back empty has nothing to do with
JavaScript, redirects or budgets. The site simply declined to answer.

sitesnap used to identify itself honestly:

```
Mozilla/5.0 (compatible; sitesnap/1.0; +offline archiving; respects robots.txt)
```

That string is refused outright by a real and not-rare class of WAF rule. The
one on mapleleaflegalservices.ca rejects **any** User-Agent containing the
token `compatible` — while serving `spider`, `crawler` and `bot` without
complaint. The rule is not aimed at crawlers at all; it matches the *shape* of
the conventional polite UA, which is also how a decade of copy-pasted blocklists
match Internet Explorer. So the most honest string on offer was the one that
failed, 403 is not a retryable status, and the crawl ended on the seed with an
empty directory.

Two things changed.

**The default is a current Chrome.** Politeness that reliably produces an
empty mirror is not politeness. What actually makes this crawler well-behaved
is unchanged and was never a matter of what it called itself: robots.txt is
still obeyed by default, requests are still rate-limited and backed off, and
`Retry-After` is still honoured. Use `--user-agent` if you would rather
announce yourself — hosts that accept it will still get it.

**A refusal is now recoverable.** On 403, 406, 418, 451 — or a 401 with no
`WWW-Authenticate`, which is a block wearing an auth costume — sitesnap climbs
a ladder of genuinely different browser identities (Chrome, then Firefox, then
Safari) rather than three versions of the same one. A rule tuned to reject one
vendor's string has no reason to reject another's; bumping a version number
leaves the shape the host objected to entirely intact.

```
HTTP 403 from example.com — host refuses this client, retrying as Chrome
```

Two details matter:

- **Climbing does not spend `--retries`.** It is a different request, not a
  repeat of the same one. Charging it a retry would mean a host that blocks the
  first two rungs exhausts the retry budget before the third is ever offered.
- **The answer is remembered per host.** One 403 is paid for the whole host,
  not one per file.

A 404 never escalates — that is a rejection of the *request*, and no identity
fixes it. A 401 carrying `WWW-Authenticate` never escalates either; it wants a
password, and burning the ladder on it would help nobody.

If every identity is refused, sitesnap reports the block and stops. It does not
attempt to defeat bot-protection challenges, and there is a test asserting it
gives up rather than looping.

#### Header consistency, and one thing deliberately not sent

Requests carry the header set that matches whatever identity is in play: a
type-appropriate `Accept`, `Accept-Language`, and Chrome's `sec-ch-ua` client
hints on the Chrome rungs only — Firefox and Safari implement no client hints,
so sending them there would be a contradiction rather than camouflage.

The `sec-fetch-*` trio is **not** sent, which is a correction rather than an
oversight. `sec-fetch-mode` is a forbidden header name: undici sets it to
`cors` on every request and discards whatever we supply, while the other two
pass through. A hand-assembled "navigation" therefore went out as
`sec-fetch-dest: document` beside `sec-fetch-mode: cors` — a pairing no browser
ever emits, since a document request is always `mode: navigate`. An internally
contradictory set is a *stronger* automation signal than none, so none is sent
and the request reads as what it honestly is: a script-issued fetch. Pages that
genuinely gate on navigation metadata are served by `--render`, where a real
browser produces the real trio.

### URLs the page builds while it runs

The rewrite pass repoints every reference it can *see*. A modern app has
references it cannot see, because they do not exist until the page runs:

```js
const url = `https://cdn.example.com/models/${name}/${variant}.glb`;
loader.load(url);
```

That string is assembled from three variables at call time and appears nowhere
in the source. No static rewriter can touch it — and three.js's own glTF
example does exactly this. The consequence was a mirror that downloaded the
3.7MB model, wrote it to disk, and then loaded the live copy off the internet
anyway. The archive looked complete and was not: pull the network and the page
rendered an empty canvas.

So the manifest is also published to the running page, as a single
`sitesnap-runtime.js` at the mirror root. Every page loads it first, and it
wraps `fetch`, `XMLHttpRequest`, the `src`/`href`/`data` properties of the
elements a loader might build, and `setAttribute`, translating any address it
recognises into the local copy. three.js's `ImageLoader` — every ordinary
texture — goes through `img.src`, so property coverage is not optional.

Two properties make this safe enough to have on by default:

- **Exact matches only.** A URL absent from the manifest passes through
  untouched, so a page fetching something never mirrored still reaches the live
  site rather than a fabricated local 404. There is no prefix guessing.
- **Inert when unused.** Every wrapper falls through to the original function.

It lives in one file rather than inline in each page: inlining cost a full copy
of the manifest per page, which on a large crawl is hundreds of megabytes of
duplicated JSON. Turn it off with `--no-runtime-rewrite`.

### Rendering captures what the browser did, not what it decided

Capturing a settled DOM captures the script tags the page's own JavaScript
*injected*, and replaying an injection is not the same as having run it. The
injected tag executes a second time, from a blank slate, without whatever the
injector had set up for it — so it either throws or does its work twice.

WordPress is a clean example. It ships a module that feature-detects emoji
support and, only if the browser lacks it, injects `wp-emoji-release.min.js`.
Headless Chromium fails that detection where an ordinary browser passes it, so
the mirror froze in a `<script src>` the live page never has — and on replay it
ran without the state the module normally hands it and threw on every page
load. The live site threw nothing.

`<script src>` elements absent from the server's own HTML are therefore dropped
at capture. That is safe precisely because the code that injected them is still
present and still runs: a page that genuinely needs an injected chunk
re-injects it, now judged against the *viewer's* browser rather than against
headless Chromium. What is discarded is only the frozen verdict of the wrong
environment.

### 3D, WebGL and other binaries

Model and texture payloads are followed like any other asset — `.glb`,
`.gltf`, `.bin`, `.hdr`, `.exr`, `.ktx2`, `.basis`, `.drc`, `.fbx`, `.obj`,
`.usdz` and friends. `.bin` earns its place despite being the vaguest name
here: a `.gltf` is a manifest whose geometry lives in a sibling `.bin`, and
capturing the manifest alone yields a model that loads to nothing.

Type detection had to be fixed to make this work at all. A `.glb` served as
`application/octet-stream` — uninformative, so the bytes decide — was being
sniffed as **CSS**. The CSS test looks for "a selector, then a brace", and a
glTF binary opens with the ASCII tag `glTF` followed by a JSON chunk whose `{`
arrives a few bytes later. That was enough to match, so a 3.7MB model was
classified as a stylesheet, decoded as text, re-encoded as UTF-8 — inflating it
from 3.7MB to 5.5MB and destroying it — and written out as
`DamagedHelmet.glb.css`.

Binary is now settled before any text test runs, by looking for a NUL byte in
the first block: the same check `git` and `file(1)` use, and one no stylesheet
or HTML document can fail. JSON is separated from CSS on the neighbouring
ambiguity — a stylesheet can never begin with `{`, and the one CSS form that
begins with `[` is an attribute selector, which always closes its bracket
before the rule opens.

### Repeat runs, politeness, and auth

**Resume.** `--resume` records each file's `ETag` / `Last-Modified` and sends
conditional requests next time. Unchanged files come back `304` and are reused
from disk, so a second run over a large docs site is mostly free.

```bash
node bin/cli.js https://example.com/docs/ -o ./docs --resume
```

State lives in `.sitesnap-state.json` in the output directory. It is excluded
from the `.zip` — it records every URL crawled, so shipping it inside a shared
archive would leak your crawl history. It records each
document's outbound links as absolute URLs. That matters: the saved HTML has
already been rewritten to local paths, so a resumed run cannot rediscover links
by reparsing it — `about.html` would resolve to the wrong URL. The recorded
links are replayed instead.

Switching `--render` on or off invalidates the cache for HTML pages, so a
resumed run re-fetches them at the new setting instead of handing back a shell
that was cached without rendering.

**Retries and throttling.** Requests retry on 429, 5xx and network errors with
exponential backoff and full jitter, honouring `Retry-After`. A 429 or 503 also
raises an adaptive delay for *every* subsequent request, decaying as the host
recovers — one rate-limit response slows the whole crawl down rather than just
that one retry.

`--delay <ms>` adds a fixed pause. It is shared across workers, not applied per
worker, so `--delay 500 --concurrency 6` really is one request per 500ms and
not six.

**Auth.** `-H` and `--cookie` attach headers for pages behind a login:

```bash
node bin/cli.js https://example.com/account --cookie 'session=abc123'
node bin/cli.js https://api.example.com -H 'Authorization: Bearer TOKEN'
```

These are sent **only to the starting origin**. A mirror routinely pulls assets
from CDNs and third parties, and attaching your session cookie to those
requests would hand your credentials to every host the page references. There
is a test that fails if that ever regresses.

### Handling the real web

Three things that only show up once you point a crawler at sites you did not
write yourself.

**Encoding.** Not every page is UTF-8. Decoding a Shift_JIS or windows-1252
page as UTF-8 replaces every non-ASCII byte with U+FFFD *permanently* — the
original bytes are gone, so no later pass can repair it. sitesnap resolves the
encoding from BOM, then `Content-Type`, then an in-document `<meta charset>`,
falling back to windows-1252 when unlabelled bytes are not valid UTF-8.
Everything is written to disk as UTF-8 **and the document's own declaration is
rewritten to match**, otherwise the offline copy renders as mojibake.

**Entry redirects.** The URL you type is often not the page you land on:
`nike.com` geo-redirects to `nike.in`, and countless sites send the apex to
`www`. Scope is judged against the start URL, so every link on the landed page
belonged to a host the crawl had already left — all of them rejected, one page
saved, nothing followed, no error. The seed now re-anchors the crawl to
wherever it actually landed. Only the seed: a redirect deeper in the crawl
must not drag the whole scope with it.

**Code-split JavaScript.** A modern site's entry script is often a stub that
`import`s a dozen hashed chunks named nowhere in the HTML. sitesnap parses
JavaScript for its module specifiers and follows them, so the mirror's
interactive layer works instead of 404-ing. Rewritten specifiers keep their
`./` prefix — ES modules treat a bare name as a *package*, so a naive rewrite
breaks every chunk.

**Wrong or missing `Content-Type`.** Plenty of servers send HTML as
`application/octet-stream`, `text/plain`, or with no header at all. Trusting
the header alone means those pages are stored as opaque blobs and never
parsed — so every link on them is lost and the crawl silently dead-ends.
sitesnap sniffs the leading bytes whenever the declared type is missing or
generic, while binary signatures (PNG, JPEG, PDF, ZIP, WOFF…) are never
sniffed as text.

**Bot protection.** Some sites answer automated clients with a "checking your
browser" interstitial carrying a 403 or 503. That is not a fault in the crawl
and not a site outage, so sitesnap identifies it and says so by name instead
of reporting a bare status code. **It does not attempt to satisfy, solve or
work around such a challenge.** If the site is yours, allow-list the crawler
or use an export; otherwise ask the owner.

## 9. Security notes

Worth knowing if you change the defaults.

- **No shell.** The crawler never starts a process. The app does so only in
  `lib/system.js`, with fixed argument arrays and no shell (see the top of
  this file).
- **Path containment.** URL paths become file paths, and remote servers control
  their own URLs. Every path segment is sanitized in isolation (no separators,
  no traversal tokens, no leading dots, Windows reserved names escaped) and the
  assembled path is re-checked against the job root before any write. See
  `lib/urlpath.js` and its tests.
- **No `innerHTML` in the client.** Log lines contain URLs from the crawled
  site; everything reaching the DOM goes through `textContent`.
- **WebSocket origin gate.** Handshakes must carry an `Origin` matching this
  server, which is what stops another tab from driving it. Verified:

  ```
  Origin: https://evil.example   -> 403
  Origin: http://localhost:4000  -> 101
  ```

- **Saved sites are shown from a second port.** A mirrored site's own
  JavaScript runs when you open it in the viewer. On the app's origin it could
  open the command socket itself, so the viewer listens on `PORT + 1`, a
  different origin that the WebSocket gate refuses like any other foreign
  page. A test asserts it gets a 403.
- **Unguessable snapshot ids.** Saved sites are served only via the library's
  registry, which is rebuilt from each folder's `snapshot.json`; a
  user-supplied string is never mapped onto the filesystem. The viewer never
  serves dotfiles, so the resume state (a list of every URL crawled) stays
  private.
- **The engine installer checks what it downloads.** Modern site mode fetches
  `playwright-core` from the npm registry, verifies it against the registry's
  published sha512, and unpacks it in pure Node, refusing any archive entry
  that would land outside its folder.
- **Budgets.** Page, file, byte and per-file caps, plus a per-request timeout,
  so a hostile or infinite site can't fill the disk.
- **`--timeout` is an inactivity deadline, not a total-time cap, and it covers
  both sides of the pipe.** A request that keeps making progress — however
  slowly — is never killed for taking a long time; only genuine silence for
  `--timeout` ms trips it, on either the network read or the disk write.
  Without the write side covered, a stalled destination write (a locked file,
  a throttled or network-mounted disk, backup/antivirus software intercepting
  the write) could hang a worker forever with nothing printed — and since
  that worker never returns to the queue, enough of those can quietly stop
  the whole crawl. `lib/fetcher.js` and `#pipeWithStallGuard` in
  `lib/crawler.js` cover the two sides respectively; see `test/network.test.js`
  for the reproductions (steady-slow-survives, dead-read-caught,
  stalled-write-caught).

If you expose this beyond localhost, set `SITESNAP_BLOCK_PRIVATE=1` so a
submitted URL can't be used to read internal services or cloud metadata. The
server warns at startup when bound to a non-loopback address.

## 10. Technical limits

Honest about what it doesn't do.

- **JavaScript needs `--render`**, and that needs Playwright installed
  separately. Without it you get the server-sent HTML, which for a
  client-rendered app is an empty shell.
- **Sites behind a bot-protection challenge stay blocked.** A crude
  User-Agent rule is recoverable and now is; an interstitial that demands a
  browser check is not. sitesnap reports it clearly and will not try to defeat
  it — no CAPTCHA solving, no TLS fingerprint spoofing, no proxy rotation.
- **The runtime URL map covers `fetch`, `XHR` and element URL properties.**
  A resource pulled in by some other route — a Worker constructed from a
  runtime URL, a WASM module instantiated from a stream, an `importScripts`
  inside a worker — is not intercepted, and will load from the live site.
- **No form submission.** `-H`/`--cookie` cover session and token auth, but
  there is no login-form flow — get the cookie from your browser's devtools.
- **The public-suffix list is curated, not complete.** It covers ccTLD second
  levels and the common hosting platforms, so `example.co.uk` and
  `other.co.uk` are correctly distinct, but an exotic suffix may still fall
  back to the last two labels. Only matters with `--subdomains`.
- **robots.txt support is partial** — `User-agent`, `Allow`, `Disallow` with
  `*`/`$`, `Crawl-delay` and `Sitemap`. No other directives.
- **`srcset` candidates are all downloaded**, which costs bandwidth on
  image-heavy sites.
- **No duplicate-content deduplication, deliberately.** Two URLs serving
  identical bytes still need two files on disk, because links point at both
  paths, and a zip stores them separately regardless. The only possible saving
  is bandwidth, and content can't be compared until after it is downloaded. A
  "fix" here would add complexity and cost hardlinks that don't survive
  archiving.

## 11. Tests

```bash
npm test
```

231 tests, in eleven groups. GitHub runs all of them on fresh macOS, Windows and
Ubuntu machines on every pull request and every change to `main`
(`.github/workflows/test.yml`), and they pass on all three.

- **`urlpath.test.js`** — the security core. This module decides where
  attacker-influenced input lands on your filesystem: traversal, encoded
  traversal, encoded separators, dotfiles, Windows device names, containment.
- **`extract.test.js`** — reference finding and rewriting across HTML and CSS,
  including `srcset` parsing and the `@import url(...)` form.
- **`patterns.test.js`** — glob semantics, include/exclude precedence,
  robots `Sitemap:` directives, and sitemap XML parsing.
- **`crawler.test.js`** — behaviour against a real local HTTP server: the
  worker pool actually running in parallel, budget enforcement, filtering,
  sitemap seeding, and the two-pass rewrite producing working local links.
- **`network.test.js`** — retry and backoff, `Retry-After`, shared throttling,
  resume via 304, stall detection, and the credential-scoping rule.
- **`decode.test.js`** — character-encoding detection, charset re-tagging,
  content sniffing, and bot-protection identification.
- **`render.test.js`** — JavaScript rendering: script-built DOM captured,
  script-created links followed, and a render failure falling back to the
  server HTML. These skip when Playwright is absent, since that is a supported
  state; the "not installed" error path is tested the rest of the time.
- **`useragent.test.js`** — client identity: that the default is not the shape
  hosts block, that a refusal climbs the ladder without spending `--retries`,
  that the accepted identity is remembered per host, that a host refusing
  everything gives up rather than looping, and that a real auth challenge is
  left alone. Also guards the `sec-fetch` regression, where a hand-set
  `dest: document` sat beside undici's forced `mode: cors` — a pairing no
  browser emits.
- **`app.test.js`** — the pieces behind the app: plain-language errors
  (including that no message uses an em dash), address parsing, the site
  check against a local fixture, the library on disk, the installer refusing
  checksum mismatches and path-climbing archive entries, and how the app's
  questions become crawler settings.
- **`server.test.js`** — the app server end to end over its real WebSocket: a
  full check-save-view-zip, the viewer port being refused by the command
  socket, a download outliving the tab that started it, Stop keeping what was
  saved, and the two-at-a-time limit.
- **`runtime.test.js`** — the runtime URL map: that it redirects addresses it
  knows, passes through everything else untouched, never rewrites `data:` or
  `blob:`, preserves fragments, and loads before any page script at every
  depth in the tree.

Two of those crawler tests are regression guards for bugs that were invisible
in normal use — the worker pool silently collapsing to one worker, and
`maxPages`/`maxFiles` failing to cap a wide fan-out. Both produced correct
output, just slowly or unboundedly, so only a measuring test catches them.

## 12. Hosting it for other people

sitesnap is built to run on your own computer. The code also has a hosted mode (`SITESNAP_HOSTED=1`) with small limits and private saves for each visitor. Hosting sitesnap for other people needs written permission under the licence; the setup notes are in [DEPLOY.md](DEPLOY.md).

## 13. Courtesy and licence

**Courtesy.** robots.txt is respected unless you pass `--ignore-robots`. Rate limits, terms
of service and copyright still apply to whatever you point this at. Mirror what
you have the right to mirror.

**Licence.** Source-available, all rights reserved. You can read the code and run sitesnap on your own computer for your own projects and for client work, paid or not, such as saving a prospective client's site so you can redesign it for them. Copying or changing the code, hosting it for others, and selling it need written permission. See [LICENSE](LICENSE).
