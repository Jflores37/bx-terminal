# BX Terminal

**A momentum-triage board for a watchlist — live at [bx-terminal.vercel.app](https://bx-terminal.vercel.app)**

### The question
A scanner can flag a few hundred names a day. The real question a trader has is narrower:
*which of these are actually shifting momentum right now, and which way — without me reading
a hundred charts on my phone?*

### What I built
A mobile-first terminal for the B-Xtrender momentum scanner that answers it at a glance. Live
scan results stream from Supabase into three ranked boards — **bullish / neutral / bearish** —
with an embedded candlestick chart, so triaging the watchlist takes seconds on a phone between
other things.

### The engineering decisions that matter
- **Resilient fetching** — `Promise.allSettled`, so one failing data pull degrades a single
  panel instead of blanking the whole board.
- **Graceful, honest empty/error states** — raw API errors are logged, not dumped into the UI.
- **Keyboard navigation** — arrow-key triage on desktop without breaking native scroll.

### What it demonstrates
Turning a noisy, high-volume data feed into a fast, prioritized read — the core analyst move of
*ranking and surfacing what matters*, applied to a live stream and a phone-sized screen.

### Limitations & next
Reads a single scan universe; classification is rules-based, not learned. Next: per-name alerts
and a "what changed since yesterday" diff via a self-join on the daily snapshots.

---

## Technical setup

Reads live scan data from Supabase, deployed on Vercel.

**Environment variables**

| Name | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` | `https://wefobwdspqzxbesbnzoc.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon public key |

**Local dev**
```bash
npm install
cp .env.example .env   # then paste your anon key
npm run dev
```

**Deploy** — import the repo to Vercel, add the two env vars, deploy.
