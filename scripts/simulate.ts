// Runs a whole event against the live API with fake guests, then wipes it.
// Usage: API_URL=... EVENT_CODE=demo HOST_PIN=123456 GUESTS=35 bun scripts/simulate.ts
const API = process.env.API_URL!;
const code = process.env.EVENT_CODE ?? "demo";
const pin = process.env.HOST_PIN!;
const N = Number(process.env.GUESTS ?? 35);
const LATE = Number(process.env.LATE ?? 4);

async function call(action: string, body: Record<string, unknown> = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${action}: ${json.error.code} ${json.error.message}`);
  return json.data;
}
const host = (action: string, body: Record<string, unknown> = {}) => call("host." + action, { code, pin, ...body });

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("CHECK FAILED: " + msg);
  console.log("ok  " + msg);
}

let state = await host("wipe", { confirm: "WIPE" });
check(state.event.phase === "lobby" && state.guests.length === 0, "starts empty in the lobby");

const t0 = Date.now();
const tokens: string[] = await Promise.all(
  Array.from({ length: N }, (_, i) => call("join", { code, name: `Guest ${i + 1}`, deviceId: `sim-${i}` }).then((d) => d.token)),
);
console.log(`    ${N} joins in ${Date.now() - t0} ms`);
state = await host("state");
check(state.guests.length === N, `${N} guests checked in`);

const dupe = await call("join", { code, name: "Guest 1", deviceId: "sim-dupe" });
check(dupe.name === "Guest 1 2", "a duplicate name gets a number");
tokens.push(dupe.token);

let bad = false;
try { await call("join", { code, name: "   ", deviceId: "x" }); } catch { bad = true; }
check(bad, "an empty name is refused");
bad = false;
try { await call("host.state", { code, pin: "000000x" }); } catch { bad = true; }
check(bad, "a wrong PIN is refused");

const seenTables = new Map<string, number[]>();
const metCount = new Map<string, number>();
for (let round = 1; round <= state.event.totalRounds; round++) {
  const from = await host("state");
  state = await host("advance", { fromPhase: from.event.phase, fromRound: from.event.round });
  check(state.event.phase === "round" && state.event.round === round, `round ${round} started`);

  if (round === 2) {
    for (let i = 0; i < LATE; i++) tokens.push((await call("join", { code, name: `Late ${i + 1}`, deviceId: `late-${i}` })).token);
    state = await host("state");
  }
  const sizes = state.room.map((t: { guests: string[] }) => t.guests.length);
  check(Math.max(...sizes) - Math.min(...sizes) <= 1, `round ${round} tables are even: ${sizes.join(" ")}`);

  const t1 = Date.now();
  const views = await Promise.all(tokens.map((token) => call("view", { token })));
  console.log(`    ${tokens.length} guest views in ${Date.now() - t1} ms`);
  check(views.every((v) => v.table), `round ${round}: every guest has a table`);
  for (const v of views) {
    const list = seenTables.get(v.me.name) ?? [];
    list.push(v.table.number);
    seenTables.set(v.me.name, list);
    for (const m of v.mates) {
      if (v.me.name < m) metCount.set(v.me.name + "|" + m, (metCount.get(v.me.name + "|" + m) ?? 0) + 1);
    }
  }

  if (round < state.event.totalRounds) {
    state = await host("advance", { fromPhase: "round", fromRound: round });
    check(state.event.phase === "poll", `poll ${round} opened`);
    let stale = false;
    try { await host("advance", { fromPhase: "round", fromRound: round }); } catch { stale = true; }
    check(stale, "a repeated advance is refused");
    await Promise.all(tokens.slice(0, 20).map((token, i) => call("answer", { token, optionIndex: i % 4 })));
    await call("answer", { token: tokens[20], text: "Something typed by a guest" });
    state = await host("state");
    check(state.poll.total === 21 && state.poll.texts.length === 1, "poll has 20 option answers and 1 typed answer");
    let room = await call("room", { code });
    check(room.poll.approvedTexts.length === 0, "typed answer is hidden from the big screen until approved");
    await host("approveAnswer", { answerId: state.poll.texts[0].id });
    room = await call("room", { code });
    check(room.poll.approvedTexts.length === 1, "approved typed answer shows on the big screen");
  }
}
const revisits = [...seenTables.values()].filter((l) => new Set(l).size !== l.length).length;
check(revisits === 0, "nobody visited the same table twice");
const repeats = [...metCount.values()].filter((v) => v > 1).length;
console.log(`    pairs who met more than once: ${repeats} (host page says ${state.repeatPairs})`);

state = await host("advance", { fromPhase: "round", fromRound: state.event.round });
check(state.event.phase === "finished", "event finished");
state = await host("wipe", { confirm: "WIPE" });
check(state.guests.length === 0 && state.event.phase === "lobby", "wipe removes every guest");
console.log("ALL GOOD");
