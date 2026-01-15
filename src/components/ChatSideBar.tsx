import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { createClient } from "@supabase/supabase-js";

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
// If you ever change navbar height, update this one number.
const NAVBAR_HEIGHT_PX = 72;

// Supabase (Vite env)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

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

function yoctoToNearNumber(yoctoStr: string): number {
  const y = BigInt(yoctoStr);
  const sign = y < 0n ? -1 : 1;
  const abs = y < 0n ? -y : y;

  const whole = abs / YOCTO;
  const frac = abs % YOCTO;

  // 4 decimals for UI
  const near4 = Number(whole) + Number(frac / BigInt("100000000000000000000")) / 10_000;
  return sign * near4;
}

function bi(s: any): bigint {
  try {
    if (typeof s === "bigint") return s;
    if (typeof s === "number" && Number.isFinite(s)) return BigInt(Math.trunc(s));
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

export default function ChatSidebar() {
  const { signedAccountId, viewFunction } = useWalletSelector() as WalletSelectorHook;

  const isLoggedIn = Boolean(signedAccountId);

  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const v = window.localStorage.getItem(CHAT_OPEN_KEY);
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
    } catch {
      // ignore
    }
    return true;
  });

  // Save open/closed state so refresh restores it
  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_OPEN_KEY, isOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [isOpen]);

  // ✅ Lock background scroll when chat is open (mobile + desktop)
  const bodyScrollYRef = useRef<number>(0);
  const bodyPrevStyleRef = useRef<Partial<CSSStyleDeclaration> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const body = document.body;
    const html = document.documentElement;

    if (isOpen) {
      // snapshot current styles so we can restore exactly
      bodyPrevStyleRef.current = {
        overflow: body.style.overflow,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        left: body.style.left,
        right: body.style.right,
        touchAction: body.style.touchAction,
      };

      // preserve scroll position (important for iOS)
      bodyScrollYRef.current = window.scrollY || window.pageYOffset || 0;

      // lock
      body.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = `-${bodyScrollYRef.current}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.touchAction = "none";

      // prevents some iOS overscroll bleed
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

      // restore scroll position
      const y = bodyScrollYRef.current || 0;
      if (y > 0) window.scrollTo(0, y);
      bodyScrollYRef.current = 0;
      bodyPrevStyleRef.current = null;
    }

    // cleanup on unmount
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

  const serverIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const m of messages) if (m.serverId) next.add(m.serverId);
    serverIdsRef.current = next;
  }, [messages]);

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

  // Profile modal state (read-only)
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalAccountId, setProfileModalAccountId] = useState<string>("");
  const [profileModalLoading, setProfileModalLoading] = useState(false);
  const [profileModalProfile, setProfileModalProfile] = useState<ProfileView>(null);
  const [profileModalLevel, setProfileModalLevel] = useState<number>(1);
  const [profileModalName, setProfileModalName] = useState<string>("");

  // profile stats
  const [profileModalStats, setProfileModalStats] = useState<ProfileStatsState | null>(null);

  const isViewingOwnProfile =
    Boolean(signedAccountId) && Boolean(profileModalAccountId) && signedAccountId === profileModalAccountId;

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
      const trimmed = nextOthers.length > cap ? nextOthers.slice(-cap) : nextOthers;

      return [...system, ...trimmed];
    });
  }

  function replaceMessageById(localId: string, next: Partial<Message>) {
    setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, ...next } : m)));
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

  // Load last messages from DB on mount
  useEffect(() => {
    if (!supabase) {
      console.warn("Supabase not configured: missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: CHAT_TABLE }, (payload) => {
        const row = payload.new as ChatRow;
        if (!row?.id) return;

        if (serverIdsRef.current.has(row.id)) return;

        pushMessage(rowToMessage(row));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      const prof: ProfileView | null = profRes.status === "fulfilled" ? (profRes.value as ProfileView) : null;
      const xp: PlayerXPView | null = xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;
      const coin: PlayerStatsView | null =
        coinRes.status === "fulfilled" ? (coinRes.value as PlayerStatsView) : null;
      const jack: Partial<PlayerStatsView> | null = jackRes.status === "fulfilled" ? (jackRes.value as any) : null;

      setProfileModalProfile(prof);
      setProfileModalName(prof?.username || m.displayName || accountId);
      setProfileModalLevel(xp?.level ? parseLevel(xp.level, m.level || 1) : m.level || 1);

      const totalWagerYocto = sumYocto(coin?.total_wagered_yocto ?? "0", (jack as any)?.total_wagered_yocto ?? "0");
      const pnlYocto = sumYocto(coin?.pnl_yocto ?? "0", (jack as any)?.pnl_yocto ?? "0");
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
      replaceMessageById(localId, {
        pending: false,
        failed: false,
        serverId: row.id,
        createdAt: row.created_at,
        id: `db-${row.id}`,
        level: parseLevel(row.level, parseLevel(myLevel, 1)),
      });
    } catch (e) {
      console.error("Failed to send message:", e);
      replaceMessageById(localId, { pending: false, failed: true });
    }
  }

  /* ---------------- COLLAPSED BUBBLE ---------------- */
  if (!isOpen) {
    return (
      <button style={styles.chatBubble} onClick={() => setIsOpen(true)} title="Open chat">
        💬
      </button>
    );
  }

  const showOverlay = true;

  /* ---------------- OPEN SIDEBAR ---------------- */
  return (
    <>
      <style>
        {`
          @keyframes dripzPulse {
            0%   { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.45); }
            70%  { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 10px rgba(124,58,237,0.00); }
            100% { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.00); }
          }

          /* ✅ iOS zoom prevention: keep input font-size >= 16px */
          .dripz-chat-input {
            font-size: 16px !important;
          }
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
            <div style={{ ...styles.headerDot, ...(isLoggedIn ? styles.headerDotPulse : null) }} />
            <div>
              <div style={styles.headerTitle}>Chat</div>
              <div style={styles.headerSub}>{isLoggedIn ? "Connected" : "Wallet required"}</div>
            </div>
          </div>

          <button style={styles.closeButton} onClick={() => setIsOpen(false)} title="Close chat">
            ✕
          </button>
        </div>

        {/* MESSAGES */}
        <div style={styles.messages} className="dripz-chat-messages">
          {!isLoggedIn && <div style={styles.locked}>🔒 Connect your wallet to chat</div>}

          {messages.map((m) => {
            const isMine =
              m.role === "user" && m.accountId && signedAccountId && m.accountId === signedAccountId;

            return (
              <div
                key={m.id}
                style={{
                  ...styles.messageBubble,
                  ...(m.role === "system" ? styles.systemBubble : isMine ? styles.userBubble : styles.otherBubble),
                  ...(m.pending ? styles.pendingBubble : null),
                  ...(m.failed ? styles.failedBubble : null),
                }}
              >
                <div style={styles.bubbleHeaderRow}>
                  <button
                    type="button"
                    style={{
                      ...styles.bubbleNameButton,
                      cursor: m.role === "user" ? "pointer" : "default",
                      opacity: m.role === "user" ? 1 : 0.95,
                    }}
                    title={m.role === "user" ? "Click for actions" : m.displayName}
                    onClick={(e) => openNameMenu(e, m)}
                    disabled={m.role !== "user"}
                  >
                    {m.displayName}
                  </button>

                  {m.level > 0 && (
                    <div style={{ ...styles.bubbleLevel, ...levelBadgeStyle(m.level) }}>Lv {m.level}</div>
                  )}
                </div>

                <div style={styles.bubbleText}>
                  {m.text}
                  {m.failed && <span style={styles.failedText}> (failed to send)</span>}
                </div>
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
              <button type="button" style={styles.replyCancel} onClick={() => setReplyTo(null)} title="Cancel reply">
                ✕
              </button>
            </div>
          )}

          <div style={styles.inputRow}>
            <div style={{ flex: 1, position: "relative" }}>
              <input
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
                <div style={styles.cooldownPill}>{(cooldownLeft / 1000).toFixed(1)}s</div>
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
        <div ref={menuRef} style={{ ...styles.nameMenu, left: nameMenu.x, top: nameMenu.y }}>
          <button type="button" style={styles.nameMenuItem} onClick={onClickReply}>
            Reply
          </button>
          <button type="button" style={styles.nameMenuItem} onClick={openProfileModalForMessage}>
            Profile
          </button>
        </div>
      )}

      {/* Read-only profile modal */}
      {profileModalOpen && (
        <div style={styles.modalOverlay} onMouseDown={() => setProfileModalOpen(false)}>
          <div style={styles.modalCard} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Profile</div>
              <button type="button" style={styles.modalClose} onClick={() => setProfileModalOpen(false)} title="Close">
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
                      src={profileModalProfile?.pfp_url || "https://placehold.co/64x64"}
                      style={styles.modalAvatar}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={styles.modalName}>{profileModalName || "User"}</div>

                      {isViewingOwnProfile && <div style={styles.modalMuted}>{profileModalAccountId || "unknown"}</div>}

                      <div style={styles.modalPills}>
                        <span style={{ ...styles.modalPill, ...levelBadgeStyle(profileModalLevel) }}>
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
                          {profileModalStats ? `${profileModalStats.totalWager.toFixed(4)} NEAR` : "—"}
                        </div>
                      </div>

                      <div style={styles.modalStatBox}>
                        <div style={styles.modalStatLabel}>Biggest Win</div>
                        <div style={styles.modalStatValue}>
                          {profileModalStats ? `${profileModalStats.highestWin.toFixed(4)} NEAR` : "—"}
                        </div>
                      </div>

                      <div style={styles.modalStatBox}>
                        <div style={styles.modalStatLabel}>PnL</div>
                        <div style={styles.modalStatValue}>
                          {profileModalStats ? `${profileModalStats.pnl.toFixed(4)} NEAR` : "—"}
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

/* ===================== UPDATED “JACKPOT-LIKE” STYLES ===================== */

const styles: Record<string, CSSProperties> = {
  // ✅ Backdrop starts BELOW navbar so navbar stays clickable + always above chat
  backdrop: {
    position: "fixed",
    top: NAVBAR_HEIGHT_PX,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    background: "rgba(0,0,0,0.25)",
    backdropFilter: "blur(2px)",
    // ✅ prevent touch scroll/zoom gestures on backdrop
    touchAction: "none",
  },

  chatBubble: {
    position: "fixed",
    left: 16,
    bottom: 18,
    width: 54,
    height: 54,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
    zIndex: 1000,
    boxShadow: "0 16px 30px rgba(0,0,0,0.35)",
  },

  // ✅ Sidebar starts BELOW navbar (top = navbar height + margin)
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

    // ✅ keep scroll gestures inside the sidebar
    overscrollBehavior: "contain",
    touchAction: "pan-y",
  },

  header: {
    padding: "14px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
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

    // ✅ smooth iOS scroll + prevent page behind from being pulled
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

  messageBubble: {
    padding: "10px 11px",
    borderRadius: 16,
    maxWidth: "88%",
    fontSize: 14,
    lineHeight: 1.4,
    wordBreak: "break-word",
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
  },

  userBubble: {
    alignSelf: "flex-end",
    background: "linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.95))",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#fff",
  },

  otherBubble: {
    alignSelf: "flex-start",
    background: "rgba(15, 23, 42, 0.75)",
    color: "#e5e7eb",
  },

  systemBubble: {
    alignSelf: "center",
    maxWidth: "95%",
    background: "rgba(2, 6, 23, 0.55)",
    color: "#cbd5e1",
    border: "1px dashed rgba(148,163,184,0.22)",
  },

  pendingBubble: {
    opacity: 0.78,
  },

  failedBubble: {
    outline: "1px solid rgba(220,38,38,0.65)",
  },

  failedText: {
    opacity: 0.95,
    fontSize: 12,
  },

  bubbleHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },

  bubbleNameButton: {
    border: "none",
    background: "transparent",
    color: "inherit",
    padding: 0,
    margin: 0,
    textAlign: "left",
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.2px",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  bubbleLevel: {
    fontSize: 11,
    fontWeight: 900,
    padding: "2px 8px",
    borderRadius: 999,
    whiteSpace: "nowrap",
  },

  bubbleText: {
    fontSize: 14,
    opacity: 0.98,
  },

  inputWrap: {
    borderTop: "1px solid rgba(148,163,184,0.14)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.00))",
    padding: 10,
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

  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  input: {
    width: "100%",
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2, 6, 23, 0.55)",
    color: "#e5e7eb",
    padding: "0 12px",
    outline: "none",

    // ✅ key for mobile: prevent zoom-in on focus (iOS Safari)
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
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
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

  modalBody: {
    padding: 14,
  },

  modalMuted: {
    color: "#94a3b8",
    fontSize: 13,
  },

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

  modalSection: {
    marginTop: 10,
  },

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
