-- Table Mixer schema.
-- Browsers never touch these tables directly: row level security is on with
-- no policies, and all access goes through the "api" Edge Function, which
-- uses the service role.

create table public.events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  phase text not null default 'lobby' check (phase in ('lobby', 'round', 'poll', 'finished')),
  round int not null default 0,
  total_rounds int not null default 3 check (total_rounds between 1 and 8),
  round_minutes int not null default 25 check (round_minutes between 1 and 120),
  round_ends_at timestamptz,
  current_poll uuid,
  host_pin_hash text not null,
  pin_fail_count int not null default 0,
  pin_locked_until timestamptz,
  feedback_url text,
  created_at timestamptz not null default now()
);

create table public.tables (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  number int not null check (number between 1 and 30),
  topic text not null default '',
  starter text not null default '',
  open boolean not null default true,
  unique (event_id, number)
);

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  name text not null,
  token uuid not null unique default gen_random_uuid(),
  device_id text,
  pinned_table int,
  joined_at timestamptz not null default now(),
  left_at timestamptz
);
create index guests_event_idx on public.guests (event_id);

create table public.seats (
  event_id uuid not null references public.events (id) on delete cascade,
  round int not null,
  guest_id uuid not null references public.guests (id) on delete cascade,
  table_number int not null,
  primary key (event_id, round, guest_id)
);
create index seats_guest_idx on public.seats (guest_id);

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  position int not null,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  allow_text boolean not null default true,
  unique (event_id, position)
);

create table public.poll_answers (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  guest_id uuid not null references public.guests (id) on delete cascade,
  option_index int,
  answer_text text,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (poll_id, guest_id)
);

create index poll_answers_guest_idx on public.poll_answers (guest_id);

alter table public.events
  add constraint events_current_poll_fk foreign key (current_poll) references public.polls (id) on delete set null;

create index events_current_poll_idx on public.events (current_poll);

alter table public.events enable row level security;
alter table public.tables enable row level security;
alter table public.guests enable row level security;
alter table public.seats enable row level security;
alter table public.polls enable row level security;
alter table public.poll_answers enable row level security;

revoke all on public.events, public.tables, public.guests, public.seats, public.polls, public.poll_answers from anon, authenticated;
