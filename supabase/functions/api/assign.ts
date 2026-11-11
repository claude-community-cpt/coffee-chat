// Table assignment for Table Mixer.
// Pure functions with no imports, so the same file runs in a Supabase Edge
// Function, in the browser and in tests.

export type GuestSeatHistory = {
  id: string;
  // Table number for each past round, oldest first. null = not seated that round.
  history: (number | null)[];
  // Host has fixed this guest to a table (for access reasons, say).
  pinnedTable?: number;
};

export type Assignment = Record<string, number>; // guest id -> table number

export type AssignmentStats = {
  repeatPairs: number; // pairs seated together this round who had already met
  revisits: number; // guests sent back to a table they have already sat at
  sizes: Record<number, number>;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(a: string, b: string) {
  return a < b ? a + "|" + b : b + "|" + a;
}

/** Every pair of guests who have shared a table in a past round. */
export function metPairs(guests: GuestSeatHistory[]): Set<string> {
  const met = new Set<string>();
  const rounds = Math.max(0, ...guests.map((g) => g.history.length));
  for (let r = 0; r < rounds; r++) {
    const byTable = new Map<number, string[]>();
    for (const g of guests) {
      const t = g.history[r];
      if (t == null) continue;
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t)!.push(g.id);
    }
    for (const ids of byTable.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) met.add(pairKey(ids[i], ids[j]));
      }
    }
  }
  return met;
}

export function stats(
  guests: GuestSeatHistory[],
  assignment: Assignment,
  openTables: number[],
): AssignmentStats {
  const met = metPairs(guests);
  const byTable = new Map<number, GuestSeatHistory[]>();
  for (const t of openTables) byTable.set(t, []);
  for (const g of guests) byTable.get(assignment[g.id])?.push(g);
  let repeatPairs = 0;
  let revisits = 0;
  const sizes: Record<number, number> = {};
  for (const [t, list] of byTable) {
    sizes[t] = list.length;
    for (let i = 0; i < list.length; i++) {
      if (list[i].history.includes(t)) revisits++;
      for (let j = i + 1; j < list.length; j++) {
        if (met.has(pairKey(list[i].id, list[j].id))) repeatPairs++;
      }
    }
  }
  return { repeatPairs, revisits, sizes };
}

const REVISIT_COST = 50; // one revisit is worse than many repeat pairs

function attempt(
  guests: GuestSeatHistory[],
  openTables: number[],
  met: Set<string>,
  rand: () => number,
): { members: GuestSeatHistory[][]; cost: number } {
  const T = openTables.length;
  const n = guests.length;
  const cap = Math.ceil(n / T);
  const floor = Math.floor(n / T);
  const members: GuestSeatHistory[][] = openTables.map(() => []);
  const idx = new Map(openTables.map((t, i) => [t, i]));

  const personCost = (g: GuestSeatHistory, ti: number, skip?: GuestSeatHistory) => {
    let c = g.history.includes(openTables[ti]) ? REVISIT_COST : 0;
    for (const q of members[ti]) {
      if (q !== g && q !== skip && met.has(pairKey(g.id, q.id))) c++;
    }
    return c;
  };

  // Pinned guests first, then everyone else in random order.
  const pinned = guests.filter((g) => g.pinnedTable != null && idx.has(g.pinnedTable));
  const free = guests.filter((g) => !pinned.includes(g));
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  for (const g of pinned) members[idx.get(g.pinnedTable!)!].push(g);
  for (const g of free) {
    let best = -1;
    let bestCost = Infinity;
    for (let ti = 0; ti < T; ti++) {
      if (members[ti].length >= cap) continue;
      const c = personCost(g, ti) * 100 + members[ti].length;
      if (c < bestCost) {
        bestCost = c;
        best = ti;
      }
    }
    members[best].push(g);
  }

  const isPinned = (g: GuestSeatHistory) => pinned.includes(g);

  // Even out sizes so no table is more than one bigger than another.
  for (let guard = 0; guard < n; guard++) {
    let big = 0;
    let small = 0;
    for (let ti = 0; ti < T; ti++) {
      if (members[ti].length > members[big].length) big = ti;
      if (members[ti].length < members[small].length) small = ti;
    }
    if (members[big].length - members[small].length <= 1 || members[small].length >= floor) break;
    let pick = -1;
    let pickDelta = Infinity;
    members[big].forEach((g, i) => {
      if (isPinned(g)) return;
      const d = personCost(g, small) - personCost(g, big);
      if (d < pickDelta) {
        pickDelta = d;
        pick = i;
      }
    });
    if (pick < 0) break;
    members[small].push(members[big].splice(pick, 1)[0]);
  }

  // Swap pairs of guests between tables while that lowers the cost.
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (let t1 = 0; t1 < T; t1++) {
      for (let t2 = t1 + 1; t2 < T; t2++) {
        for (let i1 = 0; i1 < members[t1].length; i1++) {
          for (let i2 = 0; i2 < members[t2].length; i2++) {
            const a = members[t1][i1];
            const b = members[t2][i2];
            if (isPinned(a) || isPinned(b)) continue;
            const before = personCost(a, t1) + personCost(b, t2);
            if (before === 0) continue;
            const after = personCost(a, t2, b) + personCost(b, t1, a);
            if (after < before) {
              members[t1][i1] = b;
              members[t2][i2] = a;
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  let cost = 0;
  for (let ti = 0; ti < T; ti++) {
    const list = members[ti];
    for (let i = 0; i < list.length; i++) {
      if (list[i].history.includes(openTables[ti])) cost += REVISIT_COST;
      for (let j = i + 1; j < list.length; j++) {
        if (met.has(pairKey(list[i].id, list[j].id))) cost++;
      }
    }
  }
  return { members, cost };
}

/**
 * Seat every guest for the next round.
 * - Tables end up within one seat of each other in size.
 * - Guests avoid tables they have already visited.
 * - As few pairs as possible sit together twice.
 * The first round (nobody has history) fills tables in the order given, one
 * guest per table in turn, so people who arrive together are split up.
 */
export function assignRound(
  guests: GuestSeatHistory[],
  openTables: number[],
  seed = 1,
  tries = 40,
): Assignment {
  if (openTables.length === 0) throw new Error("No open tables");
  const result: Assignment = {};
  if (guests.length === 0) return result;

  const firstRound = guests.every((g) => g.history.every((t) => t == null));
  const anyPinned = guests.some((g) => g.pinnedTable != null);
  if (firstRound && !anyPinned) {
    guests.forEach((g, i) => (result[g.id] = openTables[i % openTables.length]));
    return result;
  }

  const met = metPairs(guests);
  let best: GuestSeatHistory[][] | null = null;
  let bestCost = Infinity;
  for (let k = 0; k < tries && bestCost > 0; k++) {
    const { members, cost } = attempt(guests, openTables, met, mulberry32(seed * 1000 + k));
    if (cost < bestCost) {
      bestCost = cost;
      best = members;
    }
  }
  best!.forEach((list, ti) => list.forEach((g) => (result[g.id] = openTables[ti])));
  return result;
}

/**
 * Seat one guest who arrives while a round is running: the smallest open
 * table, lowest number on a tie.
 */
export function seatLatecomer(currentSizes: Record<number, number>, openTables: number[]): number {
  if (openTables.length === 0) throw new Error("No open tables");
  let best = openTables[0];
  for (const t of openTables) {
    if ((currentSizes[t] ?? 0) < (currentSizes[best] ?? 0)) best = t;
  }
  return best;
}
