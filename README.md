# BX Terminal Dashboard

Mobile-friendly dashboard for the BX-Trender scanner.
Reads live scan data from Supabase, displays via Vercel.

## Environment Variables Required

| Name | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` | `https://wefobwdspqzxbesbnzoc.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API → anon public key |

## Local dev (optional)

```
npm install
cp .env.example .env  # then paste your anon key
npm run dev
```

## Deploy on Vercel

Just import this repo to Vercel, add the two env vars above, and click Deploy.
