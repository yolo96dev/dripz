import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { createClient } from "@supabase/supabase-js";
import ChatPng from "@/assets/chat.png";
import EmojiBtnPng from "@/assets/emojichat.png";

// ✅ icon sources (Vite)
const CHAT_ICON_SRC = (ChatPng as any)?.src ?? (ChatPng as any);
const EMOJI_BTN_SRC = (EmojiBtnPng as any)?.src ?? (EmojiBtnPng as any);

// ✅ Auto-load all emojis from /src/assets/emojis
// Add/remove files there and they appear automatically.
const EMOJI_GLOB = import.meta.glob(
  "/src/assets/emojis/*.{png,jpg,jpeg,gif,webp,svg}",
  {
    eager: true,
    import: "default",
  }
) as Record<string, string>;

type EmojiItem = { name: string; url: string };

// Token format stored in DB so everyone can render the same emoji:
// :emoji:filename.gif:
const EMOJI_TOKEN_PREFIX = ":emoji:";
const EMOJI_TOKEN_SUFFIX = ":";

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
}

type Message = {
  id: string;
  role: "system" | "user";
  text: string;

  displayName: string;
  level: number;

  accountId?: string;

  serverId?: string;
  createdAt?: string;

  pending?: boolean;
  failed?: boolean;
};

type ProfileView =
  | {
      account_id: string;
      username: string;
      pfp_url: string;
      pfp_hash?: string;
      updated_at_ns: string;
    }
  | null;

type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string;
  level: string;
};

type PlayerStatsView = {
  total_wagered_yocto: string;
  highest_payout_yocto: string;
  pnl_yocto: string;
};

type ProfileStatsState = {
  totalWager: number;
  highestWin: number;
  pnl: number;
};

// Contracts
const PROFILE_CONTRACT = "dripzpf.testnet";
const XP_CONTRACT = "dripzxp.testnet";
const COINFLIP_CONTRACT = "dripzcf.testnet";
const JACKPOT_CONTRACT = "dripzjpv2.testnet";

// Limits
const MAX_MESSAGES = 50;
const COOLDOWN_MS = 3000;

// Persist chat open/closed state across refreshes
const CHAT_OPEN_KEY = "dripz_chat_open";

// ✅ Keep chat under navbar (offset from top in px)
const NAVBAR_HEIGHT_PX = 72;

// Supabase (Vite env)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env
  .VITE_SUPABASE_ANON_KEY as string | undefined;

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const CHAT_TABLE = "chat_messages";

type ChatRow = {
  id: string;
  created_at: string;
  account_id: string;
  display_name: string;
  level: number | string | null;
  text: string;
};

type ReplyTo = {
  accountId?: string;
  displayName: string;
};

type NameMenuState = {
  open: boolean;
  x: number;
  y: number;
  message?: Message;
};

// yocto helpers (for modal stats only)
const YOCTO = BigInt("1000000000000000000000000");
const CHAT_FALLBACK_PFP = "https://placehold.co/64x64";

// PFP retry timing (prevents hammering while still allowing eventual success)
const PFP_RETRY_AFTER_MS = 25_000;

function yoctoToNearNumber(yoctoStr: string): number {
  const y = BigInt(yoctoStr);
  const sign = y < 0n ? -1 : 1;
  const abs = y < 0n ? -y : y;

  const whole = abs / YOCTO;
  const frac = abs % YOCTO;

  // 4 decimals for UI
  const near4 =
    Number(whole) + Number(frac / BigInt("100000000000000000000")) / 10_000;
  return sign * near4;
}

function bi(s: any): bigint {
  try {
    if (typeof s === "bigint") return s;
    if (typeof s === "number" && Number.isFinite(s))
      return BigInt(Math.trunc(s));
    return BigInt(String(s ?? "0"));
  } catch {
    return 0n;
  }
}

function sumYocto(a: any, b: any): string {
  return (bi(a) + bi(b)).toString();
}

function maxYocto(a: any, b: any): string {
  const A = bi(a);
  const B = bi(b);
  return (A >= B ? A : B).toString();
}

function parseLevel(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function levelHexColor(level: number): string {
  const lv = clampInt(level, 0, 100);
  if (lv >= 66) return "#ef4444";
  if (lv >= 41) return "#f59e0b";
  if (lv >= 26) return "#3b82f6";
  if (lv >= 10) return "#22c55e";
  return "#9ca3af";
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function levelBadgeStyle(level: number): CSSProperties {
  const c = levelHexColor(level);
  return {
    color: c,
    backgroundColor: hexToRgba(c, 0.14),
    border: `1px solid ${hexToRgba(c, 0.32)}`,
  };
}

function buildEmojiList(): EmojiItem[] {
  const items: EmojiItem[] = [];
  for (const [path, url] of Object.entries(EMOJI_GLOB || {})) {
    const name = path.split("/").pop() || path;
    items.push({ name, url });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

function makeEmojiToken(filename: string) {
  return `${EMOJI_TOKEN_PREFIX}${filename}${EMOJI_TOKEN_SUFFIX}`;
}

function parseEmojiTokenAt(
  text: string,
  i: number
): { token: string; name: string; end: number } | null {
  // expects ":emoji:" at i
  if (!text.startsWith(EMOJI_TOKEN_PREFIX, i)) return null;
  const afterPrefix = i + EMOJI_TOKEN_PREFIX.length;
  const end = text.indexOf(EMOJI_TOKEN_SUFFIX, afterPrefix);
  if (end === -1) return null;
  const name = text.slice(afterPrefix, end).trim();
  if (!name) return null;
  const token = text.slice(i, end + 1);
  return { token, name, end: end + 1 };
}

export default function ChatSidebar() {
  const { signedAccountId, viewFunction } =
    useWalletSelector() as WalletSelectorHook;

  const isLoggedIn = Boolean(signedAccountId);

  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const v = window.localStorage.getItem(CHAT_OPEN_KEY);
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
    } catch {}
    return true;
  });

  // Save open/closed state so refresh restores it
  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_OPEN_KEY, isOpen ? "1" : "0");
    } catch {}
  }, [isOpen]);

  // ✅ Lock background scroll when chat is open (mobile + desktop)
  const bodyScrollYRef = useRef<number>(0);
  const bodyPrevStyleRef = useRef<Partial<CSSStyleDeclaration> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const body = document.body;
    const html = document.documentElement;

    if (isOpen) {
      bodyPrevStyleRef.current = {
        overflow: body.style.overflow,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        left: body.style.left,
        right: body.style.right,
        touchAction: body.style.touchAction,
      };

      bodyScrollYRef.current = window.scrollY || window.pageYOffset || 0;

      body.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = `-${bodyScrollYRef.current}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.touchAction = "none";

      html.style.overscrollBehavior = "none";
    } else {
      const prev = bodyPrevStyleRef.current;
      if (prev) {
        body.style.overflow = prev.overflow || "";
        body.style.position = prev.position || "";
        body.style.top = prev.top || "";
        body.style.width = prev.width || "";
        body.style.left = prev.left || "";
        body.style.right = prev.right || "";
        body.style.touchAction = prev.touchAction || "";
      } else {
        body.style.overflow = "";
        body.style.position = "";
        body.style.top = "";
        body.style.width = "";
        body.style.left = "";
        body.style.right = "";
        body.style.touchAction = "";
      }

      html.style.overscrollBehavior = "";

      const y = bodyScrollYRef.current || 0;
      if (y > 0) window.scrollTo(0, y);
      bodyScrollYRef.current = 0;
      bodyPrevStyleRef.current = null;
    }

    return () => {
      if (isOpen) {
        const prev = bodyPrevStyleRef.current;
        if (prev) {
          body.style.overflow = prev.overflow || "";
          body.style.position = prev.position || "";
          body.style.top = prev.top || "";
          body.style.width = prev.width || "";
          body.style.left = prev.left || "";
          body.style.right = prev.right || "";
          body.style.touchAction = prev.touchAction || "";
        } else {
          body.style.overflow = "";
          body.style.position = "";
          body.style.top = "";
          body.style.width = "";
          body.style.left = "";
          body.style.right = "";
          body.style.touchAction = "";
        }
        html.style.overscrollBehavior = "";
        const y = bodyScrollYRef.current || 0;
        if (y > 0) window.scrollTo(0, y);
      }
    };
  }, [isOpen]);

  // Logged-in user display info (loaded from contracts)
  const [myName, setMyName] = useState<string>("");
  const [myLevel, setMyLevel] = useState<number>(1);

  const myDisplayName = useMemo(() => {
    const n = (myName || "").trim();
    return n.length > 0 ? n : signedAccountId || "User";
  }, [myName, signedAccountId]);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "system-1",
      role: "system",
      text: "Welcome to Dripz chat 👋",
      displayName: "Dripz",
      level: 0,
    },
  ]);

  // Keep a ref to the latest messages for realtime reconciliation
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const serverIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const m of messages) if (m.serverId) next.add(m.serverId);
    serverIdsRef.current = next;
  }, [messages]);

  // ✅ PFP cache
  // IMPORTANT FIX: do NOT permanently cache fallback when a fetch fails,
  // otherwise a transient RPC/profile hiccup can make other users "never" show their PFP.
  const [pfpByAccount, setPfpByAccount] = useState<Record<string, string>>({});
  const inflightPfpRef = useRef<Set<string>>(new Set());
  const pfpRetryAfterRef = useRef<Map<string, number>>(new Map());

  function schedulePfpRetry(accountId: string) {
    if (!accountId) return;
    pfpRetryAfterRef.current.set(accountId, Date.now() + PFP_RETRY_AFTER_MS);
  }

  function clearCachedPfp(accountId: string) {
    if (!accountId) return;
    setPfpByAccount((prev) => {
      if (!prev[accountId]) return prev;
      const next = { ...prev };
      delete next[accountId];
      return next;
    });
  }

  // fetch missing PFPs (best effort, deduped, retryable)
  useEffect(() => {
    if (!viewFunction) return;

    const ids = Array.from(
      new Set(
        messages
          .filter((m) => m.role === "user" && m.accountId)
          .map((m) => String(m.accountId))
      )
    );

    const now = Date.now();
    const missing = ids.filter((id) => {
      if (pfpByAccount[id]) return false;
      if (inflightPfpRef.current.has(id)) return false;
      const retryAt = pfpRetryAfterRef.current.get(id) || 0;
      if (now < retryAt) return false;
      return true;
    });

    if (missing.length === 0) return;

    let cancelled = false;
    missing.forEach((id) => inflightPfpRef.current.add(id));

    // small concurrency limit
    const CONC = 6;

    (async () => {
      const updates: Record<string, string> = {};

      for (let i = 0; i < missing.length; i += CONC) {
        const batch = missing.slice(i, i + CONC);

        const res = await Promise.allSettled(
          batch.map((id) =>
            viewFunction({
              contractId: PROFILE_CONTRACT,
              method: "get_profile",
              args: { account_id: id },
            }) as Promise<ProfileView>
          )
        );

        if (cancelled) return;

        for (let j = 0; j < batch.length; j++) {
          const id = batch[j];

          const r = res[j];
          if (r.status === "fulfilled") {
            const prof = r.value as ProfileView;
            const url =
              prof && typeof prof.pfp_url === "string" ? prof.pfp_url.trim() : "";
            if (url) {
              updates[id] = url;
              pfpRetryAfterRef.current.delete(id);
            } else {
              // no url yet → retry later (don’t cache fallback permanently)
              schedulePfpRetry(id);
            }
          } else {
            // transient error → retry later (don’t cache fallback permanently)
            schedulePfpRetry(id);
          }
        }
      }

      if (!cancelled && Object.keys(updates).length > 0) {
        setPfpByAccount((prev) => ({ ...prev, ...updates }));
      }

      missing.forEach((id) => inflightPfpRef.current.delete(id));
    })().catch(() => {
      missing.forEach((id) => {
        inflightPfpRef.current.delete(id);
        schedulePfpRetry(id);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [messages, viewFunction, pfpByAccount]);

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Cooldown
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const cooldownLeft = Math.max(0, cooldownUntilMs - nowTick);
  const canSend = isLoggedIn && input.trim().length > 0 && cooldownLeft === 0;

  // Reply state
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);

  // Name menu state
  const [nameMenu, setNameMenu] = useState<NameMenuState>({
    open: false,
    x: 0,
    y: 0,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ✅ Emoji picker state
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);
  const emojiPopRef = useRef<HTMLDivElement | null>(null);
  const emojis = useMemo(() => buildEmojiList(), []);

  // Profile modal state (read-only)
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalAccountId, setProfileModalAccountId] =
    useState<string>("");
  const [profileModalLoading, setProfileModalLoading] = useState(false);
  const [profileModalProfile, setProfileModalProfile] =
    useState<ProfileView>(null);
  const [profileModalLevel, setProfileModalLevel] = useState<number>(1);
  const [profileModalName, setProfileModalName] = useState<string>("");

  // profile stats
  const [profileModalStats, setProfileModalStats] =
    useState<ProfileStatsState | null>(null);

  const isViewingOwnProfile =
    Boolean(signedAccountId) &&
    Boolean(profileModalAccountId) &&
    signedAccountId === profileModalAccountId;

  // tick cooldown so UI updates smoothly
  useEffect(() => {
    if (!isOpen) return;
    if (cooldownLeft <= 0) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [cooldownLeft, isOpen]);

  // Scroll to bottom on new message
  useEffect(() => {
    if (!isOpen) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  // Close name menu on outside click / escape
  useEffect(() => {
    if (!nameMenu.open) return;

    function onDown(e: MouseEvent) {
      const el = menuRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setNameMenu((s) => ({ ...s, open: false }));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setNameMenu((s) => ({ ...s, open: false }));
        setProfileModalOpen(false);
      }
    }

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [nameMenu.open]);

  // Close profile modal on escape
  useEffect(() => {
    if (!profileModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setProfileModalOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileModalOpen]);

  // Close emoji picker on outside click / escape
  useEffect(() => {
    if (!emojiOpen) return;

    function onDown(e: MouseEvent) {
      const pop = emojiPopRef.current;
      const btn = emojiBtnRef.current;
      const t = e.target as Node;
      if (pop && pop.contains(t)) return;
      if (btn && btn.contains(t)) return;
      setEmojiOpen(false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEmojiOpen(false);
    }

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  // Load my profile username + xp level (best-effort)
  useEffect(() => {
    if (!signedAccountId || !viewFunction) return;
    let cancelled = false;

    (async () => {
      try {
        const [prof, xp] = await Promise.all([
          viewFunction({
            contractId: PROFILE_CONTRACT,
            method: "get_profile",
            args: { account_id: signedAccountId },
          }) as Promise<ProfileView>,
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }) as Promise<PlayerXPView>,
        ]);

        if (cancelled) return;
        setMyName(prof?.username ?? "");
        setMyLevel(xp?.level ? parseLevel(xp.level, 1) : 1);

        // cache my pfp too (only if valid)
        const myPfp =
          prof && typeof prof.pfp_url === "string" ? prof.pfp_url.trim() : "";
        if (myPfp) {
          setPfpByAccount((prev) => ({ ...prev, [signedAccountId]: myPfp }));
        }
      } catch (e) {
        if (cancelled) return;
        setMyName("");
        setMyLevel(1);
        console.warn("Chat: failed to load profile/xp:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  function pushMessage(m: Message) {
    setMessages((prev) => {
      const system = prev.filter((x) => x.role === "system");
      const others = prev.filter((x) => x.role !== "system");

      const nextOthers = [...others, m];
      const cap = Math.max(1, MAX_MESSAGES - system.length);
      const trimmed =
        nextOthers.length > cap ? nextOthers.slice(-cap) : nextOthers;

      return [...system, ...trimmed];
    });
  }

  function replaceMessageById(localId: string, next: Partial<Message>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === localId ? { ...m, ...next } : m))
    );
  }

  function rowToMessage(row: ChatRow): Message {
    return {
      id: `db-${row.id}`,
      serverId: row.id,
      createdAt: row.created_at,
      role: "user",
      text: row.text,
      displayName: row.display_name || row.account_id,
      level: parseLevel(row.level, 1),
      accountId: row.account_id,
    };
  }

  // ✅ DEDUPE FIX: reconcile realtime INSERT with optimistic sender message
  function upsertIncomingRow(row: ChatRow) {
    const dbId = `db-${row.id}`;
    const mapped = rowToMessage(row);

    setMessages((prev) => {
      // 1) if already present (by serverId or id), just normalize it
      const existingIdx = prev.findIndex(
        (m) => m.serverId === row.id || m.id === dbId
      );
      if (existingIdx !== -1) {
        const next = prev.slice();
        next[existingIdx] = {
          ...next[existingIdx],
          ...mapped,
          pending: false,
          failed: false,
        };
        // remove any duplicates with same server id / db id
        const deduped = next.filter(
          (m, idx) =>
            idx === existingIdx ||
            !(
              m.serverId === row.id ||
              m.id === dbId ||
              (m.id === mapped.id && m.serverId === mapped.serverId)
            )
        );
        return deduped;
      }

      // 2) try to match a pending local message from the SAME sender with same text
      const localIdx = prev.findIndex(
        (m) =>
          m.role === "user" &&
          m.pending &&
          !m.serverId &&
          m.accountId === row.account_id &&
          m.text === row.text
      );

      if (localIdx !== -1) {
        const next = prev.slice();
        next[localIdx] = {
          ...next[localIdx],
          ...mapped,
          pending: false,
          failed: false,
        };

        // remove any accidental duplicates for this db id (shouldn't exist here, but safe)
        const deduped = next.filter(
          (m, idx) => idx === localIdx || !(m.serverId === row.id || m.id === dbId)
        );
        return deduped;
      }

      // 3) otherwise append (respect cap like pushMessage)
      const system = prev.filter((x) => x.role === "system");
      const others = prev.filter((x) => x.role !== "system");

      const nextOthers = [...others, mapped];
      const cap = Math.max(1, MAX_MESSAGES - system.length);
      const trimmed =
        nextOthers.length > cap ? nextOthers.slice(-cap) : nextOthers;
      return [...system, ...trimmed];
    });
  }

  // ✅ DEDUPE FIX: when our insert returns, convert the optimistic message,
  // and delete any realtime duplicate that already arrived.
  function confirmLocalWithRow(localId: string, row: ChatRow) {
    const dbId = `db-${row.id}`;
    const mapped = rowToMessage(row);

    setMessages((prev) => {
      const localIdx = prev.findIndex((m) => m.id === localId);
      let next = prev.slice();

      if (localIdx !== -1) {
        next[localIdx] = {
          ...next[localIdx],
          ...mapped,
          pending: false,
          failed: false,
        };
      } else {
        // if local doesn't exist anymore, fall back to upsert behavior
        const existingIdx = next.findIndex(
          (m) => m.serverId === row.id || m.id === dbId
        );
        if (existingIdx !== -1) {
          next[existingIdx] = {
            ...next[existingIdx],
            ...mapped,
            pending: false,
            failed: false,
          };
        } else {
          // append with cap
          const system = next.filter((x) => x.role === "system");
          const others = next.filter((x) => x.role !== "system");
          const nextOthers = [...others, mapped];
          const cap = Math.max(1, MAX_MESSAGES - system.length);
          const trimmed =
            nextOthers.length > cap ? nextOthers.slice(-cap) : nextOthers;
          next = [...system, ...trimmed];
        }
      }

      // Remove duplicates with same dbId/serverId, keeping the (localIdx) if it exists, else first match.
      const keeperIndex =
        localIdx !== -1
          ? localIdx
          : next.findIndex((m) => m.serverId === row.id || m.id === dbId);

      if (keeperIndex === -1) return next;

      const deduped = next.filter(
        (m, idx) => idx === keeperIndex || !(m.serverId === row.id || m.id === dbId)
      );
      return deduped;
    });
  }

  function renderMessageText(text: string) {
    if (!text) return null;

    const parts: React.ReactNode[] = [];
    let i = 0;

    while (i < text.length) {
      const idx = text.indexOf(EMOJI_TOKEN_PREFIX, i);
      if (idx === -1) {
        parts.push(text.slice(i));
        break;
      }

      if (idx > i) parts.push(text.slice(i, idx));

      const parsed = parseEmojiTokenAt(text, idx);
      if (!parsed) {
        parts.push(text[idx]);
        i = idx + 1;
        continue;
      }

      const found = emojis.find((e) => e.name === parsed.name);
      if (found) {
        parts.push(
          <img
            key={`emoji_${idx}_${parsed.name}`}
            src={found.url}
            alt={parsed.name}
            style={styles.inlineEmoji}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
          />
        );
      } else {
        parts.push(parsed.token);
      }

      i = parsed.end;
    }

    return parts.map((p, k) => <span key={k}>{p}</span>);
  }

  // Load last messages from DB on mount
  useEffect(() => {
    if (!supabase) {
      console.warn(
        "Supabase not configured: missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY"
      );
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase
          .from(CHAT_TABLE)
          .select("id, created_at, account_id, display_name, level, text")
          .order("created_at", { ascending: false })
          .limit(MAX_MESSAGES);

        if (error) throw error;
        if (cancelled) return;

        const rows = (data ?? []) as ChatRow[];
        const ordered = rows.slice().reverse();

        setMessages((prev) => {
          const system = prev.filter((m) => m.role === "system");
          const mapped = ordered.map(rowToMessage);

          const cap = Math.max(1, MAX_MESSAGES - system.length);
          const trimmed = mapped.length > cap ? mapped.slice(-cap) : mapped;

          return [...system, ...trimmed];
        });
      } catch (e) {
        console.error("Failed to load chat history:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime subscribe (new inserts) — subscribe once, dedupe via ref
  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel("dripz-chat")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: CHAT_TABLE },
        (payload) => {
          const row = payload.new as ChatRow;
          if (!row?.id) return;

          // ✅ immediate dedupe to prevent the sender seeing doubles
          if (serverIdsRef.current.has(row.id)) return;
          serverIdsRef.current.add(row.id);

          upsertIncomingRow(row);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  function openNameMenu(e: React.MouseEvent, m: Message) {
    e.stopPropagation();
    if (m.role !== "user") return;

    const W = 168;
    const H = 104;
    const pad = 8;

    const x = Math.min(window.innerWidth - W - pad, Math.max(pad, e.clientX));
    const y = Math.min(window.innerHeight - H - pad, Math.max(pad, e.clientY));

    setNameMenu({ open: true, x, y, message: m });
  }

  function onClickReply() {
    const m = nameMenu.message;
    if (!m) return;

    setReplyTo({
      accountId: m.accountId,
      displayName: m.displayName,
    });

    setNameMenu((s) => ({ ...s, open: false }));
  }

  async function openProfileModalForMessage() {
    const m = nameMenu.message;
    if (!m) return;

    const accountId = m.accountId || "";
    setNameMenu((s) => ({ ...s, open: false }));

    setProfileModalAccountId(accountId);
    setProfileModalOpen(true);
    setProfileModalLoading(true);
    setProfileModalStats(null);

    try {
      if (!viewFunction || !accountId) {
        setProfileModalProfile(null);
        setProfileModalName(m.displayName);
        setProfileModalLevel(m.level || 1);
        return;
      }

      const [profRes, xpRes, coinRes, jackRes] = await Promise.allSettled([
        viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: accountId },
        }) as Promise<ProfileView>,
        viewFunction({
          contractId: XP_CONTRACT,
          method: "get_player_xp",
          args: { player: accountId },
        }) as Promise<PlayerXPView>,
        viewFunction({
          contractId: COINFLIP_CONTRACT,
          method: "get_player_stats",
          args: { player: accountId },
        }) as Promise<PlayerStatsView>,
        viewFunction({
          contractId: JACKPOT_CONTRACT,
          method: "get_player_stats",
          args: { account_id: accountId },
        }) as Promise<any>,
      ]);

      const prof: ProfileView | null =
        profRes.status === "fulfilled"
          ? (profRes.value as ProfileView)
          : null;

      const xp: PlayerXPView | null =
        xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

      const coin: PlayerStatsView | null =
        coinRes.status === "fulfilled"
          ? (coinRes.value as PlayerStatsView)
          : null;

      const jack: Partial<PlayerStatsView> | null =
        jackRes.status === "fulfilled" ? (jackRes.value as any) : null;

      setProfileModalProfile(prof);
      setProfileModalName(prof?.username || m.displayName || accountId);
      setProfileModalLevel(
        xp?.level ? parseLevel(xp.level, m.level || 1) : m.level || 1
      );

      const pfp =
        prof && typeof prof.pfp_url === "string" ? prof.pfp_url.trim() : "";
      if (pfp) {
        setPfpByAccount((prev) => ({ ...prev, [accountId]: pfp }));
      } else {
        schedulePfpRetry(accountId);
      }

      const totalWagerYocto = sumYocto(
        coin?.total_wagered_yocto ?? "0",
        (jack as any)?.total_wagered_yocto ?? "0"
      );
      const pnlYocto = sumYocto(
        coin?.pnl_yocto ?? "0",
        (jack as any)?.pnl_yocto ?? "0"
      );
      const highestPayoutYocto = maxYocto(
        coin?.highest_payout_yocto ?? "0",
        (jack as any)?.highest_payout_yocto ?? "0"
      );

      setProfileModalStats({
        totalWager: yoctoToNearNumber(totalWagerYocto),
        highestWin: yoctoToNearNumber(highestPayoutYocto),
        pnl: yoctoToNearNumber(pnlYocto),
      });
    } catch (err) {
      console.warn("Profile modal: failed to load:", err);
      setProfileModalProfile(null);
      setProfileModalName(m.displayName || accountId);
      setProfileModalLevel(m.level || 1);
      setProfileModalStats(null);
    } finally {
      setProfileModalLoading(false);
    }
  }

  function insertEmoji(name: string) {
    const token = makeEmojiToken(name);
    setEmojiOpen(false);

    setInput((prev) => {
      const s = prev || "";
      if (!s.trim()) return token;
      const needsSpace = !s.endsWith(" ") && !s.endsWith("\n");
      return needsSpace ? `${s} ${token}` : `${s}${token}`;
    });

    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function sendMessage() {
    if (!isLoggedIn) return;

    let text = input.trim();
    if (!text) return;

    const now = Date.now();
    if (now < cooldownUntilMs) return;

    if (replyTo?.displayName) {
      const mention = `@${replyTo.displayName} `;
      if (!text.startsWith(mention)) text = mention + text;
    }

    setInput("");
    setCooldownUntilMs(now + COOLDOWN_MS);
    setNowTick(now);

    const localId = `local-${now}`;
    const optimistic: Message = {
      id: localId,
      role: "user",
      text,
      displayName: myDisplayName,
      level: parseLevel(myLevel, 1),
      accountId: signedAccountId || undefined,
      createdAt: new Date(now).toISOString(),
      pending: true,
    };
    pushMessage(optimistic);
    setReplyTo(null);

    if (!supabase) {
      replaceMessageById(localId, { pending: false });
      return;
    }

    try {
      const { data, error } = await supabase
        .from(CHAT_TABLE)
        .insert({
          account_id: signedAccountId,
          display_name: myDisplayName,
          level: parseLevel(myLevel, 1),
          text,
        })
        .select("id, created_at, account_id, display_name, level, text")
        .single();

      if (error) throw error;

      const row = data as ChatRow;

      // ✅ ensure realtime/optimistic can't double-show
      serverIdsRef.current.add(row.id);
      confirmLocalWithRow(localId, row);
    } catch (e) {
      console.error("Failed to send message:", e);
      replaceMessageById(localId, { pending: false, failed: true });
    }
  }

  /* ---------------- COLLAPSED PILL ---------------- */
  if (!isOpen) {
    return (
      <button
        style={styles.chatPill}
        onClick={() => setIsOpen(true)}
        title="Open chat"
      >
        <img
          src={CHAT_ICON_SRC}
          alt="Chat"
          style={styles.chatPillIcon}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </button>
    );
  }

  const showOverlay = true;

  return (
    <>
      <style>
        {`
          @keyframes dripzPulse {
            0%   { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.45); }
            70%  { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 10px rgba(124,58,237,0.00); }
            100% { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.00); }
          }

          .dripz-chat-input { font-size: 16px !important; }
        `}
      </style>

      {showOverlay && (
        <div
          style={styles.backdrop}
          onMouseDown={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside style={styles.sidebar} aria-label="Chat sidebar">
        {/* HEADER */}
        <div style={styles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                ...styles.headerDot,
                ...(isLoggedIn ? styles.headerDotPulse : null),
              }}
            />
            <div>
              <div style={styles.headerTitle}>Chat</div>
              <div style={styles.headerSub}>
                {isLoggedIn ? "Connected" : "Wallet required"}
              </div>
            </div>
          </div>

          <button
            style={styles.closeButton}
            onClick={() => setIsOpen(false)}
            title="Close chat"
          >
            ✕
          </button>
        </div>

        {/* MESSAGES */}
        <div style={styles.messages}>
          {!isLoggedIn && (
            <div style={styles.locked}>🔒 Connect your wallet to chat</div>
          )}

          {messages.map((m) => {
            if (m.role === "system") {
              return (
                <div key={m.id} style={styles.systemRow}>
                  <div style={styles.systemPill}>{renderMessageText(m.text)}</div>
                </div>
              );
            }

            const isMine =
              m.role === "user" &&
              m.accountId &&
              signedAccountId &&
              m.accountId === signedAccountId;

            const acct = m.accountId ? String(m.accountId) : "";
            const avatarUrl = acct
              ? pfpByAccount[acct] || CHAT_FALLBACK_PFP
              : CHAT_FALLBACK_PFP;

            const ringGlow =
              m.level > 0
                ? hexToRgba(levelHexColor(m.level), 0.22)
                : "rgba(148,163,184,0.18)";

            return (
              <div
                key={m.id}
                style={{
                  ...styles.msgRow,
                  ...(isMine ? styles.msgRowMine : styles.msgRowOther),
                }}
              >
                {/* Left avatar for other users */}
                {!isMine && (
                  <div style={styles.avatarCol}>
                    <div
                      style={{
                        ...styles.avatarRing,
                        boxShadow: `0 0 0 3px ${ringGlow}, 0 14px 26px rgba(0,0,0,0.35)`,
                      }}
                    >
                      <img
                        src={avatarUrl}
                        alt="pfp"
                        style={styles.avatarImg}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                        onError={(e) => {
                          // ✅ PFP reliability fix:
                          // if an image URL is bad/temporary, fall back AND clear cache so it can retry later.
                          (e.currentTarget as HTMLImageElement).src =
                            CHAT_FALLBACK_PFP;
                          if (acct) {
                            clearCachedPfp(acct);
                            schedulePfpRetry(acct);
                          }
                        }}
                      />
                    </div>
                  </div>
                )}

                <div
                  style={{
                    ...styles.bubbleCard,
                    ...(isMine ? styles.bubbleMine : styles.bubbleOther),
                    ...(m.pending ? styles.pendingBubble : null),
                    ...(m.failed ? styles.failedBubble : null),
                  }}
                >
                  <div style={styles.bubbleTop}>
                    <button
                      type="button"
                      style={{
                        ...styles.nameBtnNew,
                        ...(isMine ? styles.nameBtnMine : null),
                      }}
                      title="Click for actions"
                      onClick={(e) => openNameMenu(e, m)}
                    >
                      {m.displayName}
                    </button>

                    {m.level > 0 && (
                      <div style={{ ...styles.levelPill, ...levelBadgeStyle(m.level) }}>
                        Lv {m.level}
                      </div>
                    )}
                  </div>

                  <div style={styles.bubbleBody}>
                    {renderMessageText(m.text)}
                    {m.failed && (
                      <span style={styles.failedText}> (failed to send)</span>
                    )}
                  </div>
                </div>

                {/* Right avatar for your own messages (subtle, optional) */}
                {isMine && (
                  <div style={styles.avatarColMine}>
                    <div
                      style={{
                        ...styles.avatarRingSmall,
                        boxShadow: `0 0 0 3px ${ringGlow}, 0 10px 18px rgba(0,0,0,0.24)`,
                      }}
                    >
                      <img
                        src={avatarUrl}
                        alt="pfp"
                        style={styles.avatarImgSmall}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src =
                            CHAT_FALLBACK_PFP;
                          if (acct) {
                            clearCachedPfp(acct);
                            schedulePfpRetry(acct);
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>

        {/* INPUT */}
        <div style={styles.inputWrap}>
          {replyTo && (
            <div style={styles.replyBar}>
              <div style={styles.replyText}>
                Replying to <b>@{replyTo.displayName}</b>
              </div>
              <button
                type="button"
                style={styles.replyCancel}
                onClick={() => setReplyTo(null)}
                title="Cancel reply"
              >
                ✕
              </button>
            </div>
          )}

          {/* Emoji popover */}
          {emojiOpen && (
            <div
              ref={emojiPopRef}
              style={styles.emojiPopover}
              role="dialog"
              aria-label="Emojis"
            >
              <div style={styles.emojiHeaderRow}>
                <div style={styles.emojiTitle}>Emojis</div>
                <button
                  type="button"
                  style={styles.emojiClose}
                  onClick={() => setEmojiOpen(false)}
                  aria-label="Close"
                  title="Close"
                >
                  ✕
                </button>
              </div>

              {emojis.length === 0 ? (
                <div style={styles.emojiEmpty}>
                  No emojis found. Add files to <b>/src/assets/emojis</b>.
                </div>
              ) : (
                <div style={styles.emojiGrid}>
                  {emojis.map((e) => (
                    <button
                      key={e.name}
                      type="button"
                      style={styles.emojiItem}
                      onClick={() => insertEmoji(e.name)}
                      title={e.name}
                    >
                      <img
                        src={e.url}
                        alt={e.name}
                        style={styles.emojiImg}
                        draggable={false}
                        onDragStart={(ev) => ev.preventDefault()}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={styles.inputRow}>
            {/* emoji button */}
            <button
              ref={emojiBtnRef}
              type="button"
              style={{
                ...styles.emojiBtn,
                ...(emojiOpen ? styles.emojiBtnActive : null),
                opacity: isLoggedIn ? 1 : 0.55,
                cursor: isLoggedIn ? "pointer" : "not-allowed",
              }}
              disabled={!isLoggedIn}
              onClick={() => setEmojiOpen((v) => !v)}
              title="Emojis"
              aria-label="Emojis"
            >
              <img
                src={EMOJI_BTN_SRC}
                alt="Emojis"
                style={styles.emojiBtnIcon}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </button>

            <div style={{ flex: 1, position: "relative" }}>
              <input
                ref={inputRef}
                className="dripz-chat-input"
                style={{
                  ...styles.input,
                  opacity: isLoggedIn ? 1 : 0.55,
                }}
                disabled={!isLoggedIn}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder={isLoggedIn ? "Type a message…" : "Login to chat"}
                inputMode="text"
                autoCapitalize="sentences"
                autoCorrect="on"
              />

              {isLoggedIn && cooldownLeft > 0 && (
                <div style={styles.cooldownPill}>
                  {(cooldownLeft / 1000).toFixed(1)}s
                </div>
              )}
            </div>

            <button
              style={{
                ...styles.sendButton,
                opacity: canSend ? 1 : 0.55,
                cursor: canSend ? "pointer" : "not-allowed",
              }}
              disabled={!canSend}
              onClick={sendMessage}
              title={cooldownLeft > 0 ? "Cooldown active" : "Send"}
            >
              ➤
            </button>
          </div>
        </div>
      </aside>

      {/* Name menu (Reply/Profile) */}
      {nameMenu.open && nameMenu.message && (
        <div
          ref={menuRef}
          style={{ ...styles.nameMenu, left: nameMenu.x, top: nameMenu.y }}
        >
          <button type="button" style={styles.nameMenuItem} onClick={onClickReply}>
            Reply
          </button>
          <button
            type="button"
            style={styles.nameMenuItem}
            onClick={openProfileModalForMessage}
          >
            Profile
          </button>
        </div>
      )}

      {/* Read-only profile modal */}
      {profileModalOpen && (
        <div
          style={styles.modalOverlay}
          onMouseDown={() => setProfileModalOpen(false)}
        >
          <div
            style={styles.modalCard}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Profile</div>
              <button
                type="button"
                style={styles.modalClose}
                onClick={() => setProfileModalOpen(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              {profileModalLoading ? (
                <div style={styles.modalMuted}>Loading…</div>
              ) : (
                <>
                  <div style={styles.modalTopRow}>
                    <img
                      alt="pfp"
                      src={profileModalProfile?.pfp_url || CHAT_FALLBACK_PFP}
                      style={styles.modalAvatar}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src =
                          CHAT_FALLBACK_PFP;
                        if (profileModalAccountId) {
                          clearCachedPfp(profileModalAccountId);
                          schedulePfpRetry(profileModalAccountId);
                        }
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={styles.modalName}>
                        {profileModalName || "User"}
                      </div>

                      {isViewingOwnProfile && (
                        <div style={styles.modalMuted}>
                          {profileModalAccountId || "unknown"}
                        </div>
                      )}

                      <div style={styles.modalPills}>
                        <span
                          style={{
                            ...styles.modalPill,
                            ...levelBadgeStyle(profileModalLevel),
                          }}
                        >
                          Lv {profileModalLevel}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div style={styles.modalSection}>
                    <div style={styles.modalStatsGrid}>
                      <div style={styles.modalStatBox}>
                        <div style={styles.modalStatLabel}>Wagered</div>
                        <div style={styles.modalStatValue}>
                          {profileModalStats
                            ? `${profileModalStats.totalWager.toFixed(4)} NEAR`
                            : "—"}
                        </div>
                      </div>

                      <div style={styles.modalStatBox}>
                        <div style={styles.modalStatLabel}>Biggest Win</div>
                        <div style={styles.modalStatValue}>
                          {profileModalStats
                            ? `${profileModalStats.highestWin.toFixed(4)} NEAR`
                            : "—"}
                        </div>
                      </div>

                      <div style={styles.modalStatBox}>
                        <div style={styles.modalStatLabel}>PnL</div>
                        <div style={styles.modalStatValue}>
                          {profileModalStats
                            ? `${profileModalStats.pnl.toFixed(4)} NEAR`
                            : "—"}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ===================== STYLES ===================== */

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    top: NAVBAR_HEIGHT_PX,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    background: "rgba(0,0,0,0.25)",
    backdropFilter: "blur(2px)",
    touchAction: "none",
  },

  chatPill: {
    position: "fixed",
    left: 16,
    bottom: 18,
    width: 58,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(124,58,237,0.65)",
    background: "rgba(7, 12, 24, 0.45)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 16px 30px rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    zIndex: 1000,
    userSelect: "none",
  },

  chatPillIcon: {
    width: 22,
    height: 22,
    display: "block",
    opacity: 0.95,
    userSelect: "none",
  },

  inlineEmoji: {
    width: 22,
    height: 22,
    display: "inline-block",
    verticalAlign: "text-bottom",
    margin: "0 2px",
    borderRadius: 6,
  },

  sidebar: {
    position: "fixed",
    left: 14,
    top: NAVBAR_HEIGHT_PX + 14,
    bottom: 14,
    zIndex: 1000,
    width: "min(380px, 92vw)",
    display: "flex",
    flexDirection: "column",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%), rgba(7, 12, 24, 0.94)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
    overflow: "hidden",
    overscrollBehavior: "contain",
    touchAction: "pan-y",
  },

  header: {
    padding: "14px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
  },

  headerDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: "0 0 0 3px rgba(124,58,237,0.18)",
  },

  headerDotPulse: {
    animation: "dripzPulse 1.4s ease-out infinite",
    willChange: "transform",
  },

  headerTitle: {
    fontWeight: 900,
    fontSize: 14,
    letterSpacing: "0.2px",
    lineHeight: 1.1,
  },

  headerSub: {
    marginTop: 2,
    fontSize: 12,
    color: "#9ca3af",
  },

  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    fontSize: 16,
    cursor: "pointer",
  },

  messages: {
    flex: 1,
    padding: "12px 12px 10px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    WebkitOverflowScrolling: "touch",
    overscrollBehavior: "contain",
  },

  locked: {
    fontSize: 13,
    textAlign: "center",
    color: "#94a3b8",
    marginTop: 8,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
  },

  // ✅ New, cleaner system row
  systemRow: {
    display: "flex",
    justifyContent: "center",
    margin: "6px 0",
  },
  systemPill: {
    maxWidth: "92%",
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px dashed rgba(148,163,184,0.26)",
    background: "rgba(2, 6, 23, 0.55)",
    color: "rgba(226,232,240,0.90)",
    fontSize: 13,
    fontWeight: 800,
    textAlign: "center",
  },

  // ✅ New row layout (avatar + bubble)
  msgRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 10,
  },
  msgRowOther: {
    justifyContent: "flex-start",
  },
  msgRowMine: {
    justifyContent: "flex-end",
  },

  avatarCol: {
    width: 40,
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-end",
  },
  avatarColMine: {
    width: 34,
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-end",
  },

  avatarRing: {
    width: 38,
    height: 38,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(255,255,255,0.03)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImg: {
    width: 34,
    height: 34,
    borderRadius: 12,
    objectFit: "cover",
    background: "rgba(0,0,0,0.22)",
  },

  avatarRingSmall: {
    width: 30,
    height: 30,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.03)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImgSmall: {
    width: 26,
    height: 26,
    borderRadius: 10,
    objectFit: "cover",
    background: "rgba(0,0,0,0.22)",
  },

  bubbleCard: {
    maxWidth: "78%",
    minWidth: 0,
    padding: "10px 12px",
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.16)",
    boxShadow: "0 14px 28px rgba(0,0,0,0.22)",
    backdropFilter: "blur(10px)",
  },
  bubbleOther: {
    background: "rgba(15, 23, 42, 0.72)",
    color: "#e5e7eb",
  },
  bubbleMine: {
    background:
      "linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.95))",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.14)",
  },

  bubbleTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },

  nameBtnNew: {
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    textAlign: "left",
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: "0.2px",
    color: "rgba(226,232,240,0.90)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  nameBtnMine: {
    color: "rgba(255,255,255,0.96)",
  },

  levelPill: {
    fontSize: 11,
    fontWeight: 950,
    padding: "2px 8px",
    borderRadius: 999,
    whiteSpace: "nowrap",
  },

  bubbleBody: {
    fontSize: 14,
    lineHeight: 1.45,
    opacity: 0.98,
    wordBreak: "break-word",
  },

  pendingBubble: { opacity: 0.78 },
  failedBubble: { outline: "1px solid rgba(220,38,38,0.65)" },
  failedText: { opacity: 0.95, fontSize: 12 },

  inputWrap: {
    borderTop: "1px solid rgba(148,163,184,0.14)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.00))",
    padding: 10,
    position: "relative",
  },

  replyBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    marginBottom: 8,
  },

  replyText: {
    fontSize: 12,
    color: "#cbd5e1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  replyCancel: {
    width: 28,
    height: 28,
    borderRadius: 10,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    cursor: "pointer",
  },

  inputRow: { display: "flex", alignItems: "center", gap: 10 },

  input: {
    width: "100%",
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2, 6, 23, 0.55)",
    color: "#e5e7eb",
    padding: "0 12px",
    outline: "none",
    fontSize: 16,
  },

  cooldownPill: {
    position: "absolute",
    right: 8,
    top: "50%",
    transform: "translateY(-50%)",
    padding: "3px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 900,
    color: "#e5e7eb",
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.06)",
  },

  sendButton: {
    width: 42,
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    color: "#fff",
    fontSize: 16,
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
  },

  emojiBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 10px 18px rgba(0,0,0,0.16)",
  },
  emojiBtnActive: {
    border: "1px solid rgba(124,58,237,0.45)",
    boxShadow:
      "0 0 0 1px rgba(124,58,237,0.18), 0 10px 18px rgba(0,0,0,0.16)",
    background: "rgba(124,58,237,0.10)",
  },
  emojiBtnIcon: {
    width: 18,
    height: 18,
    display: "block",
    opacity: 0.95,
    userSelect: "none",
  },

  emojiPopover: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 58,
    zIndex: 2000,
    borderRadius: 16,
    border: "1px solid rgba(124,58,237,0.35)",
    background: "rgba(7, 12, 24, 0.96)",
    boxShadow: "0 18px 44px rgba(0,0,0,0.55)",
    overflow: "hidden",
  },
  emojiHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 12px",
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
  },
  emojiTitle: {
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "rgba(207,200,255,0.92)",
  },
  emojiClose: {
    width: 30,
    height: 30,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 900,
  },
  emojiEmpty: {
    padding: 12,
    fontSize: 12,
    color: "rgba(255,255,255,0.70)",
  },
  emojiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, 1fr)",
    gap: 8,
    padding: 12,
    maxHeight: 220,
    overflowY: "auto",
  },
  emojiItem: {
    width: "100%",
    aspectRatio: "1 / 1",
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  emojiImg: {
    width: 22,
    height: 22,
    objectFit: "contain",
    display: "block",
  },

  nameMenu: {
    position: "fixed",
    zIndex: 5000,
    width: 168,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(7, 12, 24, 0.98)",
    boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },

  nameMenuItem: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
    textAlign: "left",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 6000,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    touchAction: "none",
  },

  modalCard: {
    width: "min(420px, 92vw)",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%), rgba(7, 12, 24, 0.98)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
    overflow: "hidden",
  },

  modalHeader: {
    padding: "14px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
  },

  modalTitle: {
    fontWeight: 950,
    fontSize: 14,
    letterSpacing: "0.2px",
    color: "#e5e7eb",
  },

  modalClose: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    fontSize: 16,
    cursor: "pointer",
  },

  modalBody: { padding: 14 },
  modalMuted: { color: "#94a3b8", fontSize: 13 },

  modalTopRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 12,
  },

  modalAvatar: {
    width: 64,
    height: 64,
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.18)",
    objectFit: "cover",
    background: "rgba(255,255,255,0.04)",
  },

  modalName: {
    fontSize: 16,
    fontWeight: 950,
    color: "#e5e7eb",
    lineHeight: 1.1,
  },

  modalPills: {
    marginTop: 8,
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },

  modalPill: {
    fontSize: 12,
    fontWeight: 950,
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
  },

  modalSection: { marginTop: 10 },

  modalStatsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
  },

  modalStatBox: {
    padding: "10px 10px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
  },

  modalStatLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "#94a3b8",
    letterSpacing: "0.2px",
    marginBottom: 4,
  },

  modalStatValue: {
    fontSize: 13,
    fontWeight: 950,
    color: "#e5e7eb",
  },
};
