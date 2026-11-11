import { describe, expect, test } from "bun:test";
import { assignRound, seatLatecomer, stats, type GuestSeatHistory } from "./assign.ts";

function makeGuests(n: number): GuestSeatHistory[] {
  return Array.from({ length: n }, (_, i) => ({ id: "g" + String(i).padStart(3, "0"), history: [] }));
}
function tables(t: number) {
  return Array.from({ length: t }, (_, i) => i + 1);
}
function run(n: number, t: number, rounds: number) {
  const guests = makeGuests(n);
  const open = tables(t);
  let repeats = 0;
  let revisits = 0;
  let maxSpread = 0;
  for (let r = 0; r < rounds; r++) {
    const a = assignRound(guests, open, r + 1);
    const s = stats(guests, a, open);
    repeats += s.repeatPairs;
    revisits += s.revisits;
    const sizes = Object.values(s.sizes);
    maxSpread = Math.max(maxSpread, Math.max(...sizes) - Math.min(...sizes));
    for (const g of guests) g.history.push(a[g.id]);
  }
  return { repeats, revisits, maxSpread, guests };
}

describe("assignRound", () => {
  test("everyone gets a seat at an open table", () => {
    const guests = makeGuests(33);
    const a = assignRound(guests, [2, 4, 5, 9]);
    expect(Object.keys(a).length).toBe(33);
    for (const t of Object.values(a)) expect([2, 4, 5, 9]).toContain(t);
  });

  test("round 1 splits people who arrive together", () => {
    const guests = makeGuests(14);
    const a = assignRound(guests, tables(7));
    expect(a["g000"]).not.toBe(a["g001"]);
    expect(a["g000"]).toBe(a["g007"]);
  });

  test("35 guests, 7 tables, 3 rounds: nobody meets twice or revisits a table", () => {
    const r = run(35, 7, 3);
    expect(r.repeats).toBe(0);
    expect(r.revisits).toBe(0);
    expect(r.maxSpread).toBe(0);
  });

  test("grid of setups: tables stay even and nobody revisits while rounds <= tables", () => {
    const rows: string[] = [];
    for (const t of [4, 5, 6, 7, 8]) {
      for (const rounds of [2, 3, 4]) {
        for (const n of [20, 28, 35, 42, 50]) {
          const r = run(n, t, rounds);
          expect(r.maxSpread).toBeLessThanOrEqual(1);
          expect(r.revisits).toBe(0);
          rows.push(`${t} tables, ${rounds} rounds, ${n} guests: ${r.repeats} repeat pairs`);
        }
      }
    }
    if (process.env.SHOW_GRID) console.log(rows.join("\n"));
  }, 60000);

  test("a pinned guest stays at their table", () => {
    const guests = makeGuests(30);
    guests[3].pinnedTable = 2;
    for (let r = 0; r < 3; r++) {
      const a = assignRound(guests, tables(6), r + 1);
      expect(a[guests[3].id]).toBe(2);
      for (const g of guests) g.history.push(a[g.id]);
    }
  });

  test("guests who missed earlier rounds are seated like anyone else", () => {
    const { guests } = run(30, 6, 1);
    for (let i = 0; i < 5; i++) guests.push({ id: "late" + i, history: [null] });
    const a = assignRound(guests, tables(6), 2);
    const s = stats(guests, a, tables(6));
    const sizes = Object.values(s.sizes);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(s.revisits).toBe(0);
  });

  test("closing a table between rounds still seats everyone evenly", () => {
    const { guests } = run(35, 7, 1);
    const open = [1, 2, 3, 4, 5, 6];
    const a = assignRound(guests, open, 2);
    const s = stats(guests, a, open);
    expect(Object.values(a).includes(7)).toBe(false);
    const sizes = Object.values(s.sizes);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe("seatLatecomer", () => {
  test("picks the smallest open table", () => {
    expect(seatLatecomer({ 1: 5, 2: 4, 3: 5 }, [1, 2, 3])).toBe(2);
    expect(seatLatecomer({ 1: 5, 2: 5 }, [1, 2, 3])).toBe(3);
  });
});
