import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { api, eventCode, tableColor, type EventInfo } from "./api";
import { clock, useCountdown, useLive } from "./useLive";
import { Brand } from "./Brand";

export type RoomTable = { number: number; topic: string; starter: string; guests: string[] };
type RoomView = {
  event: EventInfo;
  guestCount: number;
  waiting: string[];
  tables: RoomTable[];
  poll: null | { question: string; options: string[]; counts: number[]; typed: number; total: number; approvedTexts: string[] };
};

export function joinUrl(code: string) {
  const def = (import.meta.env.VITE_EVENT_CODE as string) || "demo";
  return location.origin + "/" + (code === def ? "" : `?e=${encodeURIComponent(code)}`);
}

export function Qr({ url, size = 320 }: { url: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { width: size * 2, margin: 1, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [url, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={`QR code for ${url}`} /> : null;
}

export function RoomGrid({ tables }: { tables: RoomTable[] }) {
  return (
    <div className="room">
      {tables.map((t) => (
        <section className="table" key={t.number}>
          <header>
            <span className="badge" style={{ background: tableColor(t.number) }}>{t.number}</span>
            <h3>{t.topic || `Table ${t.number}`}</h3>
            <span className="count">{t.guests.length}</span>
          </header>
          <div className="chips">{t.guests.map((g) => <span className="chip" key={g}>{g}</span>)}</div>
        </section>
      ))}
    </div>
  );
}

export function PollBars({ poll }: { poll: { options: string[]; counts: number[]; typed: number; total: number } }) {
  return (
    <div className="opts">
      {poll.options.map((o, i) => {
        const pct = poll.total ? Math.round((poll.counts[i] * 100) / poll.total) : 0;
        return (
          <div className="opt static" key={i}>
            <i className="bar" style={{ width: pct + "%" }} />
            <span>{o}</span>
            <span className="pct">{poll.counts[i]}</span>
          </div>
        );
      })}
      {poll.typed > 0 && <p className="sub">{poll.typed} typed {poll.typed === 1 ? "answer" : "answers"}</p>}
    </div>
  );
}

export function Screen() {
  const code = useMemo(eventCode, []);
  const live = useLive<RoomView>(code, () => api("room", { code }));
  const view = live.data;
  const left = useCountdown(view?.event.roundEndsAt, view?.event.serverNow);
  const url = joinUrl(code);

  if (!view) return <main className="screen"><p className="sub">{live.error ? live.error.message : "Loading..."}</p></main>;
  const { event } = view;
  return (
    <main className="screen">
      <header className="row between">
        <div className="stack tight"><Brand /><h1>{event.name}</h1></div>
        <div className="row">
          {event.phase === "round" && <span className="label">Round {event.round} of {event.totalRounds}</span>}
          {event.phase === "round" && left != null && <span className={"timer huge" + (left === 0 ? " done" : "")}>{clock(left)}</span>}
        </div>
      </header>

      {event.phase === "lobby" && (
        <div className="lobby">
          <div className="stack center">
            <Qr url={url} />
            <p className="url">{url.replace(/^https?:\/\//, "")}</p>
          </div>
          <div className="stack">
            <h2>Scan to get your table</h2>
            <p className="sub">Type your first name and you're in. No app, no sign-up.</p>
            <p className="bigcount">{view.guestCount} <span>checked in</span></p>
            <div className="chips">{view.waiting.map((g) => <span className="chip" key={g}>{g}</span>)}</div>
          </div>
        </div>
      )}

      {event.phase === "round" && <RoomGrid tables={view.tables} />}

      {event.phase === "poll" && view.poll && (
        <div className="pollscreen">
          <div className="stack">
            <span className="label">Quick poll · answer on your phone</span>
            <h2 className="question">{view.poll.question}</h2>
            <PollBars poll={view.poll} />
          </div>
          {view.poll.approvedTexts.length > 0 && (
            <div className="stack">
              <span className="label">In your words</span>
              {view.poll.approvedTexts.map((t, i) => <blockquote key={i}>{t}</blockquote>)}
            </div>
          )}
        </div>
      )}

      {event.phase === "finished" && (
        <div className="stack center finish">
          <h2>That's a wrap. Thanks for coming.</h2>
          <p className="sub">Stick around for coffee.</p>
        </div>
      )}

      {event.phase !== "lobby" && event.phase !== "finished" && (
        <aside className="corner"><Qr url={url} size={96} /><span>Just arrived? Scan to join.</span></aside>
      )}
      {live.stale && <p className="banner" role="status">Reconnecting...</p>}
    </main>
  );
}
