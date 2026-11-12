import { useMemo, useState } from "react";
import { api, ApiError, eventCode, type EventInfo } from "./api";
import { clock, useCountdown, useLive } from "./useLive";
import { joinUrl, PollBars, RoomGrid, type RoomTable } from "./Screen";
import { Brand } from "./Brand";

type TableSetup = { number: number; topic: string; starter: string; open: boolean };
type PollSetup = { question: string; options: string[]; allowText: boolean };
type HostGuest = { id: string; name: string; left: boolean; pinnedTable: number | null; table: number | null };
type HostView = {
  event: EventInfo;
  tables: TableSetup[];
  polls: (PollSetup & { position: number })[];
  guests: HostGuest[];
  room: RoomTable[];
  repeatPairs: number;
  poll: null | {
    question: string;
    options: string[];
    counts: number[];
    typed: number;
    total: number;
    texts: { id: string; text: string; approved: boolean }[];
  };
};

function pinStore(code: string, value?: string | null) {
  const key = `tm:${code}:pin`;
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* private mode */ }
  return value ?? null;
}

export function Host() {
  const code = useMemo(eventCode, []);
  const [pin, setPin] = useState<string | null>(() => pinStore(code));
  const [entry, setEntry] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useLive<HostView>(code, pin ? () => api("host.state", { code, pin }) : null, [pin]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      await api("host.state", { code, pin: entry });
      pinStore(code, entry);
      setPin(entry);
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!pin || live.error?.code === "bad_pin" || live.error?.code === "locked") {
    return (
      <main className="host narrow">
        <form className="stack" onSubmit={login}>
          <Brand />
          <h1>Host sign-in</h1>
          <p className="sub">Event: {code}</p>
          <label className="label" htmlFor="pin">Host PIN</label>
          <input id="pin" inputMode="numeric" autoComplete="off" value={entry} onChange={(e) => setEntry(e.target.value)} autoFocus />
          {(loginError || live.error) && <p className="error" role="alert">{loginError || live.error?.message}</p>}
          <button className="primary big" disabled={busy || !entry}>Sign in</button>
        </form>
      </main>
    );
  }
  if (!live.data) return <main className="host"><p className="sub">{live.error?.message ?? "Loading..."}</p></main>;
  return <Dashboard code={code} pin={pin} view={live.data} setView={live.setData} stale={live.stale} signOut={() => { pinStore(code, null); setPin(null); }} />;
}

function Dashboard({ code, pin, view, setView, stale, signOut }: {
  code: string; pin: string; view: HostView; setView: (v: HostView) => void; stale: boolean; signOut: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { event } = view;
  const left = useCountdown(event.roundEndsAt, event.serverNow);

  async function act(action: string, body: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const next = await api<HostView>("host." + action, { code, pin, ...body });
      if ((next as any).event) setView(next);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const active = view.guests.filter((g) => !g.left);
  const openTables = view.tables.filter((t) => t.open);
  const hasPollNext = event.phase === "round" && event.round < event.totalRounds && view.polls.some((p) => p.position === event.round);
  const next =
    event.phase === "lobby" ? "Start round 1"
    : event.phase === "poll" ? `Start round ${event.round + 1}`
    : event.phase === "round" && event.round >= event.totalRounds ? "Finish the event"
    : event.phase === "round" ? (hasPollNext ? "End round and open the poll" : `Start round ${event.round + 1}`)
    : "";
  const phaseLabel =
    event.phase === "lobby" ? "Doors open"
    : event.phase === "round" ? `Round ${event.round} of ${event.totalRounds}`
    : event.phase === "poll" ? `Poll after round ${event.round}`
    : "Finished";
  const perTable = openTables.length ? active.length / openTables.length : 0;
  const warnRounds = event.totalRounds > openTables.length;
  const wide = useMemo(() => window.matchMedia("(min-width: 700px)").matches, []);

  return (
    <main className={"host" + (next ? " hasbar" : "")}>
      <header className="row between">
        <div>
          <Brand />
          <h1>{event.name}</h1>
          <p className="sub">Host page · guests join at {joinUrl(code).replace(/^https?:\/\//, "")} · <a href={`/screen${location.search}`} target="_blank" rel="noreferrer">open the big screen</a></p>
        </div>
        <button onClick={signOut}>Sign out</button>
      </header>
      {stale && <p className="banner" role="status">Reconnecting...</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="panel">
        <div className="row between">
          <div>
            <div className="phase">{phaseLabel}{event.phase === "round" && left != null ? ` · ${clock(left)} left` : ""}</div>
            <p className="sub">
              {active.length} checked in · {openTables.length} open tables
              {perTable ? ` · about ${perTable.toFixed(1)} per table` : ""} · {view.repeatPairs} pairs have met twice
            </p>
          </div>
          {next && (
            <div className="advance">
              {!confirming ? (
                <button className="primary big" disabled={busy} onClick={() => setConfirming(true)}>{next}</button>
              ) : (
                <>
                  <button className="primary big" disabled={busy} onClick={async () => { await act("advance", { fromPhase: event.phase, fromRound: event.round }); setConfirming(false); }}>
                    Yes, {next.charAt(0).toLowerCase() + next.slice(1)}
                  </button>
                  <button className="big" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                </>
              )}
            </div>
          )}
        </div>
        {warnRounds && event.phase !== "finished" && (
          <p className="warn">There are more rounds than open tables, so some guests will have to revisit a table.</p>
        )}
        {event.phase === "lobby" && active.length > 0 && perTable < 3 && (
          <p className="warn">Fewer than 3 guests per table. Consider closing some tables in Setup.</p>
        )}
      </section>

      {view.poll && (
        <section className="panel">
          <h2>Poll: {view.poll.question}</h2>
          <PollBars poll={view.poll} />
          {view.poll.texts.length > 0 && (
            <>
              <span className="label">Typed answers. Only approved ones show on the big screen.</span>
              <ul className="list">
                {view.poll.texts.map((t) => (
                  <li key={t.id} className="answer">
                    <span>{t.text}</span>
                    <button disabled={busy} onClick={() => act("approveAnswer", { answerId: t.id, approved: !t.approved })}>
                      {t.approved ? "Hide" : "Show on screen"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {(event.phase === "round" || event.phase === "poll") && (
        <details className="panel" open={wide}>
          <summary><h2>Tables right now</h2></summary>
          <RoomGrid tables={view.room} />
        </details>
      )}

      <Guests view={view} busy={busy} act={act} />
      <Setup key={event.phase + event.round} view={view} busy={busy} act={act} startOpen={wide && event.phase === "lobby"} />
      <Danger busy={busy} act={act} />
    </main>
  );
}

type Act = (action: string, body?: Record<string, unknown>) => Promise<boolean>;

function Guests({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [find, setFind] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const open = view.tables.filter((t) => t.open);
  const inRound = view.event.phase === "round";
  const q = find.trim().toLowerCase();
  const shown = q ? view.guests.filter((g) => g.name.toLowerCase().includes(q)) : view.guests;
  return (
    <details className="panel" open>
      <summary><h2>Guests ({view.guests.filter((g) => !g.left).length})</h2></summary>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await act("addGuest", { name }))) setName(""); }}>
        <input aria-label="Add a guest by first name" placeholder="Add a guest by first name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy || !name.trim()}>Add</button>
      </form>
      {view.guests.length > 8 && (
        <input type="search" aria-label="Find a guest" placeholder="Find a guest" value={find} onChange={(e) => setFind(e.target.value)} />
      )}
      <p className="fine">Tap a name to move, rename or mark someone as gone.</p>
      <ul className="list guests">
        {shown.map((g) => {
          const isOpen = openId === g.id;
          return (
            <li key={g.id} className={g.left ? "gone" : ""}>
              <button className="guestrow" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : g.id)}>
                <span>
                  <strong>{g.name}</strong>
                  {g.table != null && !g.left && <span className="sub"> · table {g.table}</span>}
                  {g.pinnedTable != null && <span className="sub"> · kept at table {g.pinnedTable}</span>}
                  {g.left && <span className="sub"> · gone</span>}
                </span>
                <span className="chev" aria-hidden="true">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <div className="guestactions">
                  {!g.left && (
                    <select
                      aria-label={`Move ${g.name} to a table`}
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "unpin") act("unpinGuest", { guestId: g.id });
                        else if (v.startsWith("keep:")) act("moveGuest", { guestId: g.id, table: Number(v.slice(5)), keep: true });
                        else if (v) act("moveGuest", { guestId: g.id, table: Number(v) });
                      }}
                    >
                      <option value="">Move to a table...</option>
                      {inRound && open.map((t) => <option key={t.number} value={t.number}>To table {t.number} this round</option>)}
                      {open.map((t) => <option key={"k" + t.number} value={"keep:" + t.number}>Keep at table {t.number} every round</option>)}
                      {g.pinnedTable != null && <option value="unpin">Stop keeping at one table</option>}
                    </select>
                  )}
                  <button disabled={busy} onClick={() => act("markLeft", { guestId: g.id, left: !g.left })}>{g.left ? "Bring back" : "Mark as gone"}</button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const n = window.prompt?.(`New name for ${g.name}`, g.name);
                      if (n && n.trim() && n !== g.name) act("renameGuest", { guestId: g.id, name: n });
                    }}
                  >
                    Rename
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {view.guests.length === 0 && <li className="sub">Nobody has checked in yet.</li>}
        {view.guests.length > 0 && shown.length === 0 && <li className="sub">No guest matches that.</li>}
      </ul>
    </details>
  );
}

function Setup({ view, busy, act, startOpen }: { view: HostView; busy: boolean; act: Act; startOpen: boolean }) {
  const [tables, setTables] = useState<TableSetup[]>(view.tables);
  const [polls, setPolls] = useState<PollSetup[]>(view.polls.map((p) => ({ question: p.question, options: p.options, allowText: p.allowText })));
  const [name, setName] = useState(view.event.name);
  const [rounds, setRounds] = useState(view.event.totalRounds);
  const [minutes, setMinutes] = useState(view.event.roundMinutes);
  const [feedback, setFeedback] = useState(view.event.feedbackUrl ?? "");
  const [saved, setSaved] = useState(false);
  const setTable = (i: number, patch: Partial<TableSetup>) => setTables(tables.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setPoll = (i: number, patch: Partial<PollSetup>) => setPolls(polls.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const nextNumber = tables.length ? Math.max(...tables.map((t) => t.number)) + 1 : 1;

  return (
    <details className="panel" open={startOpen}>
      <summary><h2>Setup</h2></summary>
      <p className="sub">Change tables, topics, rounds and polls here. Changes to tables apply from the next round.</p>
      <div className="grid3">
        <label className="field"><span className="label">Event name</span><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span className="label">Rounds</span><input type="number" min={Math.max(1, view.event.round)} max={8} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} /></label>
        <label className="field"><span className="label">Minutes per round</span><input type="number" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
      </div>
      <label className="field"><span className="label">Feedback link shown at the end (optional)</span><input value={feedback} placeholder="https://" onChange={(e) => setFeedback(e.target.value)} /></label>

      <h3>Tables</h3>
      <ul className="list">
        {tables.map((t, i) => (
          <li key={t.number} className="tablerow">
            <strong>{t.number}</strong>
            <input aria-label={`Topic for table ${t.number}`} placeholder="Topic" value={t.topic} maxLength={60} onChange={(e) => setTable(i, { topic: e.target.value })} />
            <input aria-label={`Starter question for table ${t.number}`} placeholder="Starter question" value={t.starter} maxLength={160} onChange={(e) => setTable(i, { starter: e.target.value })} />
            <label className="check"><input type="checkbox" checked={t.open} onChange={(e) => setTable(i, { open: e.target.checked })} /> Open</label>
            <button type="button" onClick={() => setTables(tables.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={tables.length >= 30} onClick={() => setTables([...tables, { number: nextNumber, topic: "", starter: "", open: true }])}>Add a table</button>

      <h3>Polls</h3>
      <p className="sub">Poll 1 runs after round 1, poll 2 after round 2, and so on. A round with no poll goes straight to the next round.</p>
      <ul className="list">
        {polls.map((p, i) => (
          <li key={i} className="stack tight">
            <div className="row nowrap">
              <strong>{i + 1}</strong>
              <input aria-label={`Question for poll ${i + 1}`} placeholder="Question" value={p.question} maxLength={200} onChange={(e) => setPoll(i, { question: e.target.value })} />
              <button type="button" onClick={() => setPolls(polls.filter((_, j) => j !== i))}>Remove</button>
            </div>
            <textarea aria-label={`Options for poll ${i + 1}, one per line`} placeholder="Options, one per line (up to 6)" rows={4} value={p.options.join("\n")} onChange={(e) => setPoll(i, { options: e.target.value.split("\n") })} />
            <label className="check"><input type="checkbox" checked={p.allowText} onChange={(e) => setPoll(i, { allowText: e.target.checked })} /> Let guests type their own answer</label>
          </li>
        ))}
      </ul>
      <button type="button" disabled={polls.length >= 8} onClick={() => setPolls([...polls, { question: "", options: [], allowText: true }])}>Add a poll</button>

      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setSaved(false);
            const ok = await act("setup", {
              name, totalRounds: rounds, roundMinutes: minutes, feedbackUrl: feedback, tables,
              ...(view.event.phase === "poll" ? {} : { polls }),
            });
            setSaved(ok);
          }}
        >
          Save setup
        </button>
        {saved && <span className="sub" role="status">Saved.</span>}
      </div>
    </details>
  );
}

function Danger({ busy, act }: { busy: boolean; act: Act }) {
  const [word, setWord] = useState("");
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState("");
  return (
    <details className="panel">
      <summary><h2>After the event</h2></summary>
      <p className="sub">Wiping deletes every guest name, seat and poll answer and returns the event to "doors open". Tables, topics and polls are kept.</p>
      <div className="row">
        <input aria-label="Type WIPE to confirm" placeholder="Type WIPE to confirm" value={word} onChange={(e) => setWord(e.target.value)} />
        <button className="danger" disabled={busy || word !== "WIPE"} onClick={async () => { if (await act("wipe", { confirm: "WIPE" })) { setWord(""); setMsg("Guest data wiped."); } }}>Wipe guest data</button>
      </div>
      <h3>Change the host PIN</h3>
      <div className="row">
        <input aria-label="New PIN, 6 to 12 digits" placeholder="New PIN, 6 to 12 digits" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
        <button disabled={busy || !/^[0-9]{6,12}$/.test(newPin)} onClick={async () => { if (await act("changePin", { newPin })) { setMsg("PIN changed. Sign in again with the new one."); setNewPin(""); } }}>Change PIN</button>
      </div>
      {msg && <p className="sub" role="status">{msg}</p>}
    </details>
  );
}
