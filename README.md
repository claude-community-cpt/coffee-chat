# coffee-chat

Table Mixer: the check-in and table-rotation app for the Cape Town Claude community coffee mornings.

Guests scan a QR code, type a first name and get a table. The host advances rounds from a host page, and every guest gets a new table, a new topic and a mostly new group each round. Between rounds there can be an opinion poll with multiple-choice options and optional typed answers.

A volunteer-run community tool. Not an Anthropic product.

Live at https://table-mixer.vercel.app (the default event there is a demo).

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Guests (phone) | Join with a first name, see your table, topic and table mates, answer polls |
| `/screen` | Projector | QR code and check-in count, then the live room, poll results, round timer |
| `/host` | Host (PIN) | Advance rounds, manage guests, moderate typed answers, edit tables, topics, rounds and polls, wipe data |

Add `?e=<event code>` to any path to use an event other than the default in `web/.env`.

## Layout

- `web/`: React + Vite + TypeScript front end, deployed to Vercel (root directory `web`).
- `supabase/migrations/`: database schema.
- `supabase/functions/api/`: the single Edge Function that all pages talk to. `assign.ts` is the seating logic, with tests in `assign.test.ts`.
- `scripts/simulate.ts`: runs a full event against the live API with fake guests.

## How it fits together

Browsers never read or write tables directly. Row level security is on with no policies, and every request goes through the `api` Edge Function, which uses the service role. Guests are identified by a random token kept on their phone. Host actions need the event's PIN (stored as a hash, 5 wrong tries locks it for 5 minutes).

Live updates use a Supabase Realtime broadcast on `event:<code>` that only says "something changed". Pages then refetch, and also poll every 8 seconds in case the socket drops.

Seating: round 1 fills tables in arrival order. Later rounds search for a seating where nobody revisits a table and as few pairs as possible meet twice, while keeping table sizes even. Latecomers go to the smallest open table.

## Design

The look follows the community site, https://claudecapetown.com: ivory background, ink text, coral accent, serif display headings, pill buttons and soft white cards. The tokens at the top of `web/src/styles.css` use the same names and values as that site (`--coral`, `--ivory`, `--ink` and so on), so a change there can be copied across.

Differences from the site:

- Fonts are Lora and Poppins from Google Fonts, which are the site's own fallbacks. The site's licensed display fonts and the logo image are not copied into this repo.
- Dark mode follows the phone's setting. There is no toggle.
- Tables each get one of eight colours (`--t1` to `--t8`) so a guest can match the number on their phone to the big screen.

## Deploying

- **Front end**: the Vercel project `table-mixer` is linked to this repo with root directory `web`. Merging to `main` updates the live site, and every pull request gets its own preview link.
- **Backend**: the schema and the `api` function are applied to the Supabase project by hand (or through the Supabase connector). Merging does not deploy them, so apply any change under `supabase/` separately.

## Privacy

First name only, at most 20 characters. Typed poll answers only reach the big screen after the host approves them. "Wipe guest data" on the host page deletes all names, seats and answers, and should be run within two days of an event.

## Development

Use `bun`.

```sh
cd web
bun install
bun run dev      # local dev server
bun run build    # type-check and build

cd ..
bun test supabase/functions/api            # seating tests
API_URL=https://<project-ref>.supabase.co/functions/v1/api \
  EVENT_CODE=demo HOST_PIN=<pin> GUESTS=35 bun scripts/simulate.ts
```

`web/.env` holds only public values (project URL, publishable key, default event code). Never put a service role key or a host PIN in this repo.

The simulation wipes the event it runs against, so only point it at a demo event.
