// Table Mixer API. One Edge Function, one POST endpoint, an "action" per call.
// Guests are identified by a random token, hosts by the event PIN. Browsers
// never read or write the database directly.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { assignRound, type GuestSeatHistory, metPairs, seatLatecomer } from "./assign.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const MAX_NAME = 20;
const MAX_TEXT = 140;
const MAX_GUESTS = 150;
const MAX_PER_DEVICE = 3;
const PIN_TRIES = 5;
const PIN_LOCK_MINUTES = 5;
// Small on purpose: the host can rename or remove anyone from the host page.
const BLOCKED = ["fuck", "shit", "cunt", "bitch", "nigg", "fag", "poes", "naai", "kak"];

type Db = SupabaseClient;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pinHash(code: string, pin: string): Promise<string> {
  return sha256(`${code}:${pin}`);
}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new ApiError("db", error.message, 500);
  return data as T;
}

async function getEvent(db: Db, code: unknown): Promise<Row> {
  const c = clean(code, 40).toLowerCase();
  if (!c) throw new ApiError("no_event", "Missing event code");
  const ev = await must(db.from("events").select("*").eq("code", c).maybeSingle());
  if (!ev) throw new ApiError("no_event", "We couldn't find that event", 404);
  return ev as Row;
}

async function notify(code: string) {
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: `event:${code}`, event: "changed", payload: { at: Date.now() } }] }),
    });
  } catch (_) {
    // Pages also poll, so a missed ping only delays an update.
  }
}

async function requireHost(db: Db, body: Row): Promise<Row> {
  const ev = await getEvent(db, body.code);
  if (ev.pin_locked_until && new Date(ev.pin_locked_until) > new Date()) {
    throw new ApiError("locked", "Too many wrong PINs. Try again in a few minutes.", 429);
  }
  const ok = (await pinHash(ev.code, clean(body.pin, 20))) === ev.host_pin_hash;
  if (!ok) {
    const fails = ev.pin_fail_count + 1;
    const lock = fails >= PIN_TRIES;
    await must(
      db.from("events").update({
        pin_fail_count: lock ? 0 : fails,
        pin_locked_until: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() : null,
      }).eq("id", ev.id).select("id"),
    );
    throw new ApiError("bad_pin", "That PIN isn't right", 401);
  }
  if (ev.pin_fail_count) await must(db.from("events").update({ pin_fail_count: 0 }).eq("id", ev.id).select("id"));
  return ev;
}

async function loadTables(db: Db, eventId: string): Promise<Row[]> {
  return (await must(db.from("tables").select("*").eq("event_id", eventId).order("number"))) as Row[];
}

async function loadGuests(db: Db, eventId: string): Promise<Row[]> {
  return (await must(db.from("guests").select("*").eq("event_id", eventId).order("joined_at").order("id"))) as Row[];
}

async function loadSeats(db: Db, eventId: string): Promise<Row[]> {
  return (await must(db.from("seats").select("*").eq("event_id", eventId))) as Row[];
}

async function uniqueName(db: Db, eventId: string, wanted: string, exceptId?: string): Promise<string> {
  const guests = await loadGuests(db, eventId);
  const taken = new Set(guests.filter((g) => g.id !== exceptId).map((g) => String(g.name).toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 100; n++) {
    const candidate = `${wanted.slice(0, MAX_NAME - 3)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

function checkName(raw: unknown): string {
  const name = clean(raw, MAX_NAME);
  if (!name) throw new ApiError("bad_name", "Type a first name to join");
  const lower = name.toLowerCase();
  if (BLOCKED.some((w) => lower.includes(w))) throw new ApiError("bad_name", "Please pick a different name");
  return name;
}

async function seatNow(db: Db, ev: Row, guestId: string) {
  if (ev.phase !== "round") return;
  const tables = (await loadTables(db, ev.id)).filter((t) => t.open).map((t) => t.number as number);
  if (!tables.length) return;
  const seats = (await loadSeats(db, ev.id)).filter((s) => s.round === ev.round);
  const guests = await loadGuests(db, ev.id);
  const active = new Set(guests.filter((g) => !g.left_at).map((g) => g.id));
  const sizes: Record<number, number> = {};
  for (const s of seats) if (active.has(s.guest_id)) sizes[s.table_number] = (sizes[s.table_number] ?? 0) + 1;
  const table = seatLatecomer(sizes, tables);
  await must(
    db.from("seats").upsert({ event_id: ev.id, round: ev.round, guest_id: guestId, table_number: table }).select("guest_id"),
  );
}

async function addGuestRow(db: Db, ev: Row, rawName: unknown, deviceId: string | null): Promise<Row> {
  const guests = await loadGuests(db, ev.id);
  if (guests.length >= MAX_GUESTS) throw new ApiError("full", "This event is full");
  if (deviceId && guests.filter((g) => g.device_id === deviceId).length >= MAX_PER_DEVICE) {
    throw new ApiError("device_limit", "This phone has already joined a few times. Ask the host to add you.");
  }
  const name = await uniqueName(db, ev.id, checkName(rawName));
  const guest = (await must(
    db.from("guests").insert({ event_id: ev.id, name, device_id: deviceId }).select("*").single(),
  )) as Row;
  await seatNow(db, ev, guest.id);
  return guest;
}

function pollTotals(poll: Row, answers: Row[]) {
  const options = (poll.options as string[]) ?? [];
  const counts = options.map(() => 0);
  let typed = 0;
  for (const a of answers) {
    if (a.option_index != null && a.option_index >= 0 && a.option_index < counts.length) counts[a.option_index]++;
    else if (a.answer_text) typed++;
  }
  return { counts, typed, total: answers.length };
}

async function currentPoll(db: Db, ev: Row): Promise<{ poll: Row; answers: Row[] } | null> {
  if (ev.phase !== "poll" || !ev.current_poll) return null;
  const poll = (await must(db.from("polls").select("*").eq("id", ev.current_poll).maybeSingle())) as Row | null;
  if (!poll) return null;
  const answers = (await must(db.from("poll_answers").select("*").eq("poll_id", poll.id).order("created_at"))) as Row[];
  return { poll, answers };
}

function eventPublic(ev: Row) {
  return {
    code: ev.code,
    name: ev.name,
    phase: ev.phase,
    round: ev.round,
    totalRounds: ev.total_rounds,
    roundMinutes: ev.round_minutes,
    roundEndsAt: ev.round_ends_at,
    feedbackUrl: ev.feedback_url,
    serverNow: new Date().toISOString(),
  };
}

// ---------- guest actions ----------

async function join(db: Db, body: Row) {
  const ev = await getEvent(db, body.code);
  if (ev.phase === "finished") throw new ApiError("closed", "This event has finished");
  const guest = await addGuestRow(db, ev, body.name, clean(body.deviceId, 64) || null);
  await notify(ev.code);
  return { token: guest.token, name: guest.name };
}

async function guestByToken(db: Db, token: unknown): Promise<{ guest: Row; ev: Row }> {
  const t = clean(token, 64);
  if (!/^[0-9a-f-]{36}$/i.test(t)) throw new ApiError("no_guest", "Please join again", 404);
  const guest = (await must(db.from("guests").select("*").eq("token", t).maybeSingle())) as Row | null;
  if (!guest) throw new ApiError("no_guest", "Please join again", 404);
  const ev = (await must(db.from("events").select("*").eq("id", guest.event_id).single())) as Row;
  return { guest, ev };
}

async function view(db: Db, body: Row) {
  const { guest, ev } = await guestByToken(db, body.token);
  const out: Row = { event: eventPublic(ev), me: { name: guest.name, left: !!guest.left_at }, table: null, mates: [], poll: null };
  if (ev.phase === "round") {
    const seats = (await loadSeats(db, ev.id)).filter((s) => s.round === ev.round);
    const mine = seats.find((s) => s.guest_id === guest.id);
    if (mine) {
      const tables = await loadTables(db, ev.id);
      const t = tables.find((x) => x.number === mine.table_number);
      const guests = await loadGuests(db, ev.id);
      const byId = new Map(guests.map((g) => [g.id, g]));
      out.table = { number: mine.table_number, topic: t?.topic ?? "", starter: t?.starter ?? "" };
      out.mates = seats
        .filter((s) => s.table_number === mine.table_number && s.guest_id !== guest.id)
        .map((s) => byId.get(s.guest_id))
        .filter((g) => g && !g.left_at)
        .map((g) => g!.name);
    }
  }
  const cp = await currentPoll(db, ev);
  if (cp) {
    const mineA = cp.answers.find((a) => a.guest_id === guest.id);
    out.poll = {
      id: cp.poll.id,
      question: cp.poll.question,
      options: cp.poll.options,
      allowText: cp.poll.allow_text,
      myAnswer: mineA ? { optionIndex: mineA.option_index, text: mineA.answer_text } : null,
      ...(mineA ? pollTotals(cp.poll, cp.answers) : {}),
    };
  }
  return out;
}

async function answer(db: Db, body: Row) {
  const { guest, ev } = await guestByToken(db, body.token);
  const cp = await currentPoll(db, ev);
  if (!cp) throw new ApiError("no_poll", "There's no poll open right now");
  const options = (cp.poll.options as string[]) ?? [];
  const text = clean(body.text, MAX_TEXT);
  let optionIndex: number | null = null;
  if (body.optionIndex != null && body.optionIndex !== "") {
    optionIndex = Number(body.optionIndex);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      throw new ApiError("bad_answer", "Pick one of the options");
    }
  }
  if (optionIndex == null && !text) throw new ApiError("bad_answer", "Pick an option or type an answer");
  if (optionIndex == null && !cp.poll.allow_text) throw new ApiError("bad_answer", "Pick one of the options");
  await must(
    db.from("poll_answers").upsert(
      {
        poll_id: cp.poll.id,
        guest_id: guest.id,
        option_index: optionIndex,
        answer_text: optionIndex == null ? text : null,
        approved: false,
      },
      { onConflict: "poll_id,guest_id" },
    ).select("id"),
  );
  await notify(ev.code);
  return { ok: true };
}

// ---------- big screen ----------

async function roomData(db: Db, ev: Row) {
  const [tables, guests, allSeats] = await Promise.all([loadTables(db, ev.id), loadGuests(db, ev.id), loadSeats(db, ev.id)]);
  const active = guests.filter((g) => !g.left_at);
  const byId = new Map(active.map((g) => [g.id, g]));
  const seats = allSeats.filter((s) => s.round === ev.round);
  const outTables = tables.filter((t) => t.open).map((t) => ({
    number: t.number,
    topic: t.topic,
    starter: t.starter,
    guests: ev.phase === "round" || ev.phase === "poll"
      ? seats.filter((s) => s.table_number === t.number && byId.has(s.guest_id)).map((s) => byId.get(s.guest_id)!.name)
      : [],
  }));
  return { tables, guests, active, allSeats, seats, outTables };
}

async function room(db: Db, body: Row) {
  const ev = await getEvent(db, body.code);
  const d = await roomData(db, ev);
  const out: Row = {
    event: eventPublic(ev),
    guestCount: d.active.length,
    waiting: ev.phase === "lobby" ? d.active.map((g) => g.name) : [],
    tables: d.outTables,
    poll: null,
  };
  const cp = await currentPoll(db, ev);
  if (cp) {
    out.poll = {
      question: cp.poll.question,
      options: cp.poll.options,
      ...pollTotals(cp.poll, cp.answers),
      approvedTexts: cp.answers.filter((a) => a.approved && a.answer_text).map((a) => a.answer_text),
    };
  }
  return out;
}

// ---------- host actions ----------

function repeatCount(guests: GuestSeatHistory[]): number {
  // Pairs who have shared a table more than once so far.
  const seen = new Map<string, number>();
  const rounds = Math.max(0, ...guests.map((g) => g.history.length));
  for (let r = 0; r < rounds; r++) {
    const one = guests.map((g) => ({ id: g.id, history: [g.history[r] ?? null] }));
    for (const k of metPairs(one)) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let n = 0;
  for (const v of seen.values()) if (v > 1) n += v - 1;
  return n;
}

function histories(guests: Row[], seats: Row[], rounds: number): GuestSeatHistory[] {
  const bySeat = new Map<string, number>();
  for (const s of seats) bySeat.set(`${s.guest_id}|${s.round}`, s.table_number);
  return guests.map((g) => ({
    id: g.id,
    pinnedTable: g.pinned_table ?? undefined,
    history: Array.from({ length: rounds }, (_, i) => bySeat.get(`${g.id}|${i + 1}`) ?? null),
  }));
}

async function hostState(db: Db, ev: Row) {
  const d = await roomData(db, ev);
  const polls = (await must(db.from("polls").select("*").eq("event_id", ev.id).order("position"))) as Row[];
  const seatNow = new Map(d.seats.map((s) => [s.guest_id, s.table_number]));
  const out: Row = {
    event: eventPublic(ev),
    tables: d.tables.map((t) => ({ number: t.number, topic: t.topic, starter: t.starter, open: t.open })),
    polls: polls.map((p) => ({ position: p.position, question: p.question, options: p.options, allowText: p.allow_text })),
    guests: d.guests.map((g) => ({
      id: g.id,
      name: g.name,
      left: !!g.left_at,
      pinnedTable: g.pinned_table,
      table: ev.phase === "round" || ev.phase === "poll" ? seatNow.get(g.id) ?? null : null,
    })),
    room: d.outTables,
    repeatPairs: repeatCount(histories(d.active, d.allSeats, ev.round)),
    poll: null,
  };
  const cp = await currentPoll(db, ev);
  if (cp) {
    out.poll = {
      question: cp.poll.question,
      options: cp.poll.options,
      ...pollTotals(cp.poll, cp.answers),
      texts: cp.answers.filter((a) => a.answer_text).map((a) => ({ id: a.id, text: a.answer_text, approved: a.approved })),
    };
  }
  return out;
}

async function setup(db: Db, ev: Row, body: Row) {
  const patch: Row = {};
  if (body.name != null) patch.name = clean(body.name, 80) || ev.name;
  if (body.totalRounds != null) {
    const n = Number(body.totalRounds);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new ApiError("bad_setup", "Rounds must be between 1 and 8");
    if (n < ev.round) throw new ApiError("bad_setup", `Round ${ev.round} has already started`);
    patch.total_rounds = n;
  }
  if (body.roundMinutes != null) {
    const n = Number(body.roundMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new ApiError("bad_setup", "Round length must be 1 to 120 minutes");
    patch.round_minutes = n;
  }
  if (body.feedbackUrl != null) {
    const u = clean(body.feedbackUrl, 300);
    if (u && !/^https:\/\//i.test(u)) throw new ApiError("bad_setup", "The feedback link must start with https://");
    patch.feedback_url = u || null;
  }
  if (Object.keys(patch).length) await must(db.from("events").update(patch).eq("id", ev.id).select("id"));

  if (Array.isArray(body.tables)) {
    const rows = (body.tables as Row[]).map((t) => ({
      event_id: ev.id,
      number: Number(t.number),
      topic: clean(t.topic, 60),
      starter: clean(t.starter, 160),
      open: t.open !== false,
    }));
    if (!rows.length || rows.length > 30) throw new ApiError("bad_setup", "Set between 1 and 30 tables");
    const nums = new Set(rows.map((r) => r.number));
    if (nums.size !== rows.length || rows.some((r) => !Number.isInteger(r.number) || r.number < 1 || r.number > 30)) {
      throw new ApiError("bad_setup", "Table numbers must be unique and between 1 and 30");
    }
    if (!rows.some((r) => r.open)) throw new ApiError("bad_setup", "At least one table must be open");
    await must(db.from("tables").upsert(rows, { onConflict: "event_id,number" }).select("id"));
    const existing = await loadTables(db, ev.id);
    const gone = existing.filter((t) => !nums.has(t.number)).map((t) => t.id);
    if (gone.length) await must(db.from("tables").delete().in("id", gone).select("id"));
  }

  if (Array.isArray(body.polls)) {
    if (ev.phase === "poll") throw new ApiError("bad_setup", "Wait until the current poll is closed to edit polls");
    const rows = (body.polls as Row[]).map((p, i) => ({
      event_id: ev.id,
      position: i + 1,
      question: clean(p.question, 200),
      options: (Array.isArray(p.options) ? p.options : []).map((o: unknown) => clean(o, 80)).filter(Boolean).slice(0, 6),
      allow_text: p.allowText !== false,
    })).filter((p) => p.question);
    if (rows.length > 8) throw new ApiError("bad_setup", "Up to 8 polls");
    for (const r of rows) {
      if (r.options.length < 2 && !r.allow_text) throw new ApiError("bad_setup", "A poll needs two options or typed answers");
    }
    await must(db.from("polls").delete().eq("event_id", ev.id).select("id"));
    if (rows.length) await must(db.from("polls").insert(rows).select("id"));
  }
}

async function startRound(db: Db, ev: Row, round: number) {
  const tables = (await loadTables(db, ev.id)).filter((t) => t.open).map((t) => t.number as number);
  if (!tables.length) throw new ApiError("no_tables", "Open at least one table first");
  const guests = (await loadGuests(db, ev.id)).filter((g) => !g.left_at);
  const seats = await loadSeats(db, ev.id);
  const hist = histories(guests, seats.filter((s) => s.round < round), round - 1);
  const assignment = assignRound(hist, tables, round);
  await must(db.from("seats").delete().eq("event_id", ev.id).eq("round", round).select("guest_id"));
  const rows = Object.entries(assignment).map(([guest_id, table_number]) => ({ event_id: ev.id, round, guest_id, table_number }));
  if (rows.length) await must(db.from("seats").insert(rows).select("guest_id"));
  await must(
    db.from("events").update({
      phase: "round",
      round,
      current_poll: null,
      round_ends_at: new Date(Date.now() + ev.round_minutes * 60000).toISOString(),
    }).eq("id", ev.id).select("id"),
  );
}

async function advance(db: Db, ev: Row, body: Row) {
  // The page sends the phase and round it was looking at, so a double tap or
  // two hosts pressing at once can't skip a step.
  if (body.fromPhase !== ev.phase || Number(body.fromRound) !== ev.round) {
    throw new ApiError("stale", "The event has already moved on. Check the screen and try again.", 409);
  }
  if (ev.phase === "lobby") return startRound(db, ev, 1);
  if (ev.phase === "poll") return startRound(db, ev, ev.round + 1);
  if (ev.phase === "round") {
    if (ev.round >= ev.total_rounds) {
      await must(db.from("events").update({ phase: "finished", round_ends_at: null, current_poll: null }).eq("id", ev.id).select("id"));
      return;
    }
    const poll = (await must(
      db.from("polls").select("id").eq("event_id", ev.id).eq("position", ev.round).maybeSingle(),
    )) as Row | null;
    if (poll) {
      await must(db.from("events").update({ phase: "poll", current_poll: poll.id, round_ends_at: null }).eq("id", ev.id).select("id"));
      return;
    }
    return startRound(db, ev, ev.round + 1);
  }
  throw new ApiError("finished", "This event has finished");
}

async function guestInEvent(db: Db, ev: Row, guestId: unknown): Promise<Row> {
  const id = clean(guestId, 64);
  const g = (await must(db.from("guests").select("*").eq("id", id).eq("event_id", ev.id).maybeSingle())) as Row | null;
  if (!g) throw new ApiError("no_guest", "That guest isn't in this event", 404);
  return g;
}

async function host(db: Db, action: string, body: Row) {
  const ev = await requireHost(db, body);
  switch (action) {
    case "host.state":
      return hostState(db, ev);
    case "host.setup":
      await setup(db, ev, body);
      break;
    case "host.advance":
      await advance(db, ev, body);
      break;
    case "host.addGuest":
      await addGuestRow(db, ev, body.name, null);
      break;
    case "host.markLeft": {
      const g = await guestInEvent(db, ev, body.guestId);
      const left = body.left !== false;
      await must(db.from("guests").update({ left_at: left ? new Date().toISOString() : null }).eq("id", g.id).select("id"));
      if (!left) await seatNow(db, ev, g.id);
      break;
    }
    case "host.renameGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      const name = await uniqueName(db, ev.id, checkName(body.name), g.id);
      await must(db.from("guests").update({ name }).eq("id", g.id).select("id"));
      break;
    }
    case "host.removeGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      await must(db.from("guests").delete().eq("id", g.id).select("id"));
      break;
    }
    case "host.moveGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      const table = Number(body.table);
      const tables = await loadTables(db, ev.id);
      if (!tables.some((t) => t.number === table && t.open)) throw new ApiError("bad_table", "That table isn't open");
      await must(db.from("guests").update({ pinned_table: body.keep ? table : null }).eq("id", g.id).select("id"));
      if (ev.phase === "round") {
        await must(
          db.from("seats").upsert({ event_id: ev.id, round: ev.round, guest_id: g.id, table_number: table }).select("guest_id"),
        );
      }
      break;
    }
    case "host.unpinGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      await must(db.from("guests").update({ pinned_table: null }).eq("id", g.id).select("id"));
      break;
    }
    case "host.approveAnswer": {
      const id = clean(body.answerId, 64);
      const polls = (await must(db.from("polls").select("id").eq("event_id", ev.id))) as Row[];
      await must(
        db.from("poll_answers").update({ approved: body.approved !== false }).eq("id", id).in("poll_id", polls.map((p) => p.id)).select("id"),
      );
      break;
    }
    case "host.changePin": {
      const pin = clean(body.newPin, 20);
      if (!/^[0-9]{6,12}$/.test(pin)) throw new ApiError("bad_pin", "The PIN must be 6 to 12 digits");
      await must(db.from("events").update({ host_pin_hash: await pinHash(ev.code, pin) }).eq("id", ev.id).select("id"));
      return { ok: true };
    }
    case "host.wipe": {
      // Removes every guest with their seats and poll answers, and returns
      // the event to the start. Tables, topics and polls are kept.
      if (body.confirm !== "WIPE") throw new ApiError("confirm", "Type WIPE to confirm");
      await must(db.from("guests").delete().eq("event_id", ev.id).select("id"));
      await must(
        db.from("events").update({ phase: "lobby", round: 0, round_ends_at: null, current_poll: null }).eq("id", ev.id).select("id"),
      );
      break;
    }
    default:
      throw new ApiError("unknown", "Unknown action", 404);
  }
  await notify(ev.code);
  const fresh = await getEvent(db, ev.code);
  return hostState(db, fresh);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: { code: "method", message: "POST only" } }, 405);
  try {
    const body = (await req.json()) as Row;
    const action = String(body.action ?? "");
    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    let data: unknown;
    if (action === "join") data = await join(db, body);
    else if (action === "view") data = await view(db, body);
    else if (action === "answer") data = await answer(db, body);
    else if (action === "room") data = await room(db, body);
    else if (action.startsWith("host.")) data = await host(db, action, body);
    else throw new ApiError("unknown", "Unknown action", 404);
    return json({ data });
  } catch (e) {
    if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error(e);
    return json({ error: { code: "server", message: "Something went wrong. Please try again." } }, 500);
  }
});
