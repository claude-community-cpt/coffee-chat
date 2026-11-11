import { createClient } from "@supabase/supabase-js";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string;

export const supabase = createClient(URL_BASE, KEY, { auth: { persistSession: false } });

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${URL_BASE}/functions/v1/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new ApiError("offline", "Can't reach the server. Check your connection.");
  }
  const json = await res.json().catch(() => null);
  if (!json || json.error) {
    throw new ApiError(json?.error?.code ?? "server", json?.error?.message ?? "Something went wrong. Please try again.");
  }
  return json.data as T;
}

export function eventCode(): string {
  const fromUrl = new URLSearchParams(location.search).get("e");
  return (fromUrl || (import.meta.env.VITE_EVENT_CODE as string) || "demo").toLowerCase();
}

export function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

export type EventInfo = {
  code: string;
  name: string;
  phase: "lobby" | "round" | "poll" | "finished";
  round: number;
  totalRounds: number;
  roundMinutes: number;
  roundEndsAt: string | null;
  feedbackUrl: string | null;
  serverNow: string;
};

export const tableColor = (n: number) => `var(--t${((n - 1) % 8) + 1})`;
