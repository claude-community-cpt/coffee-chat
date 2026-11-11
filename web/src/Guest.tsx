import { useEffect, useMemo, useState } from "react";
import { api, ApiError, eventCode, store, tableColor, type EventInfo } from "./api";
import { clock, useCountdown, useLive } from "./useLive";

type GuestView = {
  event: EventInfo;
  me: { name: string; left: boolean };
  table: { number: number; topic: string; starter: string } | null;
  mates: string[];
  poll: null | {
    id: string;
    question: string;
    options: string[];
    allowText: boolean;
    myAnswer: null | { optionIndex: number | null; text: string | null };
    counts?: number[];
    typed?: number;
    total?: number;
  };
};

function deviceId() {
  let id = store("tm:device");
  if (!id) {
    id = crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now();
    store("tm:device", id);
  }
  return id;
}

export function Guest() {
  const code = useMemo(eventCode, []);
  const tokenKey = `tm:${code}:token`;
  const [token, setToken] = useState<string | null>(() => store(tokenKey));
  const live = useLive<GuestView>(code, token ? () => api("view", { token }) : null, [token]);

  // The server no longer knows this phone (data wiped, or removed by the host).
  const forgotten = live.error?.code === "no_guest";
  useEffect(() => {
    if (token && forgotten) {
      store(tokenKey, null);
      setToken(null);
    }
  }, [token, forgotten, tokenKey]);

  return (
    <main className="guest">
      {!token ? (
        <Join code={code} onJoined={(t) => { store(tokenKey, t); setToken(t); }} />
      ) : !live.data ? (
        <p className="sub">{live.stale ? "Trying to connect..." : "Loading..."}</p>
      ) : (
        <Joined view={live.data} token={token} refresh={live.refresh} />
      )}
      {live.stale && live.data && (
        <p className="banner" role="status">
          Reconnecting. {live.data.table ? `Your table is still ${live.data.table.number}.` : "Hang tight."}
        </p>
      )}
      <footer>A volunteer-run community tool. Not an Anthropic product.</footer>
    </main>
  );
}

function Join({ code, onJoined }: { code: string; onJoined: (token: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Type a first name to join.");
    setBusy(true);
    setError("");
    try {
      const d = await api<{ token: string }>("join", { code, name, deviceId: deviceId() });
      onJoined(d.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="stack">
      <h1>Welcome to the Claude coffee morning</h1>
      <p className="sub">Pop in your first name and we'll give you a table.</p>
      <label className="label" htmlFor="name">First name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="given-name" autoFocus />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary big" disabled={busy}>{busy ? "Joining..." : "Get my table"}</button>
      <p className="fine">Your first name is shown to other guests and on the big screen, and deleted after the event.</p>
    </form>
  );
}

function Joined({ view, token, refresh }: { view: GuestView; token: string; refresh: () => void }) {
  const { event, me, table, mates, poll } = view;
  const left = useCountdown(event.roundEndsAt, event.serverNow);
  const steps = (
    <div className="steps" aria-label={`Round ${event.round} of ${event.totalRounds}`}>
      {Array.from({ length: event.totalRounds }, (_, i) => <i key={i} className={event.round > i ? "on" : ""} />)}
    </div>
  );

  if (me.left) {
    return <div className="stack"><h1>Thanks for coming, {me.name}</h1><p className="sub">You've been marked as gone. If that's a mistake, tell the host and they'll bring you back.</p></div>;
  }
  if (event.phase === "lobby") {
    return <div className="stack"><h1>You're in, {me.name}</h1><p className="sub">Grab a coffee. Your table will show up here when we start.</p></div>;
  }
  if (event.phase === "finished") {
    return (
      <div className="stack">
        <h1>That's a wrap</h1>
        <p className="sub">Thanks for coming, {me.name}. Stick around for coffee.</p>
        {event.feedbackUrl && <a className="button primary big" href={event.feedbackUrl} target="_blank" rel="noreferrer">Tell us how it went</a>}
      </div>
    );
  }
  if (event.phase === "poll" && poll) {
    return <div className="stack">{steps}<Poll poll={poll} token={token} refresh={refresh} /></div>;
  }
  if (!table) {
    return <div className="stack">{steps}<h1>Nearly there, {me.name}</h1><p className="sub">You'll get a table when the next round starts.</p></div>;
  }
  return (
    <div className="stack">
      {steps}
      <div className="row between">
        <span className="label">Round {event.round} of {event.totalRounds} · your table</span>
        {left != null && <span className="timer">{clock(left)}</span>}
      </div>
      <div className="bignum" style={{ color: tableColor(table.number) }}>{table.number}</div>
      <div className="card">
        <h2>{table.topic || `Table ${table.number}`}</h2>
        {table.starter && <p className="sub">Starter: {table.starter}</p>}
      </div>
      <div>
        <span className="label">You'll be sitting with</span>
        <div className="chips">
          {mates.length ? mates.map((m) => <span className="chip" key={m}>{m}</span>) : <span className="sub">You're first at the table.</span>}
        </div>
      </div>
    </div>
  );
}

function Poll({ poll, token, refresh }: { poll: NonNullable<GuestView["poll"]>; token: string; refresh: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = !!poll.myAnswer;
  async function send(body: { optionIndex?: number; text?: string }) {
    setBusy(true);
    setError("");
    try {
      await api("answer", { token, ...body });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const total = poll.total ?? 0;
  return (
    <>
      <span className="label">Quick poll · optional</span>
      <h1 className="question">{poll.question}</h1>
      <div className="opts">
        {poll.options.map((o, i) => {
          const pct = answered && total ? Math.round(((poll.counts?.[i] ?? 0) * 100) / total) : 0;
          const mine = poll.myAnswer?.optionIndex === i;
          return (
            <button key={i} className={"opt" + (mine ? " mine" : "")} disabled={busy || answered} onClick={() => send({ optionIndex: i })}>
              {answered && <i className="bar" style={{ width: pct + "%" }} />}
              <span>{o}</span>
              {answered && <span className="pct">{pct}%</span>}
            </button>
          );
        })}
      </div>
      {poll.allowText && !answered && (
        <form className="stack tight" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send({ text }); }}>
          <label className="label" htmlFor="own">Or type your own answer</label>
          <div className="row">
            <input id="own" value={text} onChange={(e) => setText(e.target.value)} maxLength={140} />
            <button disabled={busy || !text.trim()}>Send</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {answered ? (
        <p className="sub">
          {poll.myAnswer?.text ? `You said: "${poll.myAnswer.text}". ` : ""}Thanks. Your next table is coming up.
        </p>
      ) : (
        <p className="sub">Or skip it and stretch your legs.</p>
      )}
    </>
  );
}
