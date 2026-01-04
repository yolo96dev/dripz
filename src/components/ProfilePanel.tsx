import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";

/* ---------------- types ---------------- */

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
  callFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string;
    gas?: string;
  }) => Promise<any>;
}

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

type Stats = {
  totalWager: number;
  highestWin: number;
  pnl: number;
};

type XpState = {
  xp: string;
  level: number;
};

/* ---------------- contracts ---------------- */

const PROFILE_CONTRACT = "dripzpf.testnet";
const XP_CONTRACT = "dripzxp.testnet";
const COINFLIP_CONTRACT = "dripzcf.testnet";
const JACKPOT_CONTRACT = "dripzjpv2.testnet";

/* ---------------- constants / helpers ---------------- */

const FALLBACK_AVATAR = "https://placehold.co/160x160";

const YOCTO = BigInt("1000000000000000000000000");

function yoctoToNearNumber(yoctoStr: string): number {
  try {
    const y = BigInt(yoctoStr || "0");
    const sign = y < 0n ? -1 : 1;
    const abs = y < 0n ? -y : y;

    const whole = abs / YOCTO;
    const frac = abs % YOCTO;

    // 4 decimals for UI
    const near4 =
      Number(whole) + Number(frac / BigInt("100000000000000000000")) / 10_000;

    return sign * near4;
  } catch {
    return 0;
  }
}

function sumYocto(a: string, b: string): string {
  try {
    return (BigInt(a || "0") + BigInt(b || "0")).toString();
  } catch {
    return "0";
  }
}

function maxYocto(a: string, b: string): string {
  try {
    const A = BigInt(a || "0");
    const B = BigInt(b || "0");
    return (A > B ? A : B).toString();
  } catch {
    return "0";
  }
}

async function sha256HexFromFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * IMPORTANT: Access Vite env vars statically so Vite can inline them at build-time.
 * Do NOT indirect through (import.meta as any).env, because that can prevent replacement.
 */
function getImgBBKey(): string {
  return (
    import.meta.env.VITE_IMGBB_API_KEY ||
    // These fallbacks are harmless if undefined (kept for portability)
    (import.meta.env as any).NEXT_PUBLIC_IMGBB_API_KEY ||
    (import.meta.env as any).REACT_APP_IMGBB_API_KEY ||
    ""
  );
}

async function uploadToImgBB(file: File, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("image", file);

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
    method: "POST",
    body: form,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.error || `Upload failed (${res.status})`;
    throw new Error(String(msg));
  }

  // prefer direct URL
  const directUrl =
    json?.data?.image?.url || json?.data?.url || json?.data?.display_url;

  if (!directUrl || typeof directUrl !== "string") {
    throw new Error("ImgBB upload succeeded but did not return a direct URL");
  }

  return directUrl;
}

/* ---------------- component ---------------- */

export default function ProfilePanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  if (!signedAccountId) return null;

  /* ---------------- PROFILE STATE ---------------- */

  const [username, setUsername] = useState(signedAccountId);

  // what UI displays as avatar
  const [avatar, setAvatar] = useState<string>(FALLBACK_AVATAR);

  // on-chain fields (hidden from UI)
  const [pfpUrl, setPfpUrl] = useState<string>(FALLBACK_AVATAR);
  const [pfpHash, setPfpHash] = useState<string>("");

  // helpful UI
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileUploading, setProfileUploading] = useState(false);
  const [profileError, setProfileError] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");

  /* ---------------- STATS (on-chain) ---------------- */

  const [stats, setStats] = useState<Stats>({
    totalWager: 0,
    highestWin: 0,
    pnl: 0,
  });

  const [xp, setXp] = useState<XpState>({
    xp: "0.000",
    level: 1,
  });

  const [statsLoading, setStatsLoading] = useState(false);

  /* ---------------- LOAD: Profile + Stats + XP ---------------- */

  useEffect(() => {
    if (!signedAccountId) return;

    let cancelled = false;

    (async () => {
      setStatsLoading(true);
      setProfileLoading(true);
      setProfileError("");
      setUploadError("");

      try {
        // Use allSettled so a failure in one contract doesn't blank everything.
        const [coinRes, jackRes, xpRes, profRes] = await Promise.allSettled([
          viewFunction({
            contractId: COINFLIP_CONTRACT,
            method: "get_player_stats",
            args: { player: signedAccountId },
          }),
          viewFunction({
            contractId: JACKPOT_CONTRACT,
            method: "get_player_stats",
            args: { account_id: signedAccountId },
          }),
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }),
          viewFunction({
            contractId: PROFILE_CONTRACT,
            method: "get_profile",
            args: { account_id: signedAccountId },
          }),
        ]);

        const coin: PlayerStatsView | null =
          coinRes.status === "fulfilled"
            ? (coinRes.value as PlayerStatsView)
            : null;

        // jackpot returns extra fields too; we only need these 3 (safe read)
        const jack: Partial<PlayerStatsView> | null =
          jackRes.status === "fulfilled" ? (jackRes.value as any) : null;

        const px: PlayerXPView | null =
          xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

        const prof: ProfileView | null =
          profRes.status === "fulfilled" ? (profRes.value as ProfileView) : null;

        // aggregate coinflip + jackpot
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

        const nextStats: Stats = {
          totalWager: yoctoToNearNumber(totalWagerYocto),
          highestWin: yoctoToNearNumber(highestPayoutYocto),
          pnl: yoctoToNearNumber(pnlYocto),
        };

        const nextXp: XpState = {
          xp: typeof px?.xp === "string" ? px.xp : "0.000",
          level: px?.level ? Number(px.level) : 1,
        };

        if (!cancelled) {
          setStats(nextStats);
          setXp(nextXp);
        }

        // If profile exists, use it as defaults
        if (
          prof &&
          typeof prof.username === "string" &&
          typeof prof.pfp_url === "string"
        ) {
          if (!cancelled) {
            setUsername(prof.username);
            setAvatar(prof.pfp_url || FALLBACK_AVATAR);
            setPfpUrl(prof.pfp_url || FALLBACK_AVATAR);
            setPfpHash(prof.pfp_hash ?? "");
          }
        }
      } catch (e) {
        if (!cancelled) {
          setStats({ totalWager: 0, highestWin: 0, pnl: 0 });
          setXp({ xp: "0.000", level: 1 });
          console.error("Failed to load profile panel data:", e);
        }
      } finally {
        if (!cancelled) {
          setStatsLoading(false);
          setProfileLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  const publicNamePreview = useMemo(() => {
    const u = (username || "").trim();
    return u.length > 0 ? u : signedAccountId;
  }, [username, signedAccountId]);

  /* ---------------- HANDLERS ---------------- */

  async function onAvatarChange(file: File | null) {
    if (!file) return;

    setUploadError("");
    setProfileError("");

    // local preview instantly (nice UX)
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result || ""));
    reader.readAsDataURL(file);

    // compute hash (auto, hidden)
    try {
      const hex = await sha256HexFromFile(file);
      setPfpHash(hex);
    } catch (err) {
      console.warn("Could not compute sha256 for file:", err);
      setPfpHash("");
    }

    // upload to ImgBB so refresh works (auto, hidden)
    const key = getImgBBKey();
    if (!key) {
      setUploadError(
        "Missing ImgBB API key. Add VITE_IMGBB_API_KEY (Vite) or NEXT_PUBLIC_IMGBB_API_KEY (Next) or REACT_APP_IMGBB_API_KEY (CRA)."
      );
      return;
    }

    setProfileUploading(true);
    try {
      const directUrl = await uploadToImgBB(file, key);

      // these are what we save on-chain
      setPfpUrl(directUrl);

      // switch avatar to the hosted URL too
      setAvatar(directUrl);
    } catch (e: any) {
      console.error("ImgBB upload failed:", e);
      setUploadError(e?.message || "ImgBB upload failed.");
    } finally {
      setProfileUploading(false);
    }
  }

  async function saveProfile() {
    setProfileSaving(true);
    setProfileError("");

    try {
      // Require that upload succeeded (otherwise you’ll save placeholder URL)
      if (!pfpUrl || pfpUrl === FALLBACK_AVATAR) {
        throw new Error(
          "Pick a profile picture first (upload must succeed) so it can be saved on-chain."
        );
      }

      await callFunction({
        contractId: PROFILE_CONTRACT,
        method: "set_profile",
        args: {
          username,
          pfp_url: pfpUrl,
          pfp_hash:
            pfpHash && pfpHash.trim().length > 0 ? pfpHash.trim() : undefined,
        },
        deposit: "0",
      });

      // reflect saved url as avatar
      setAvatar(pfpUrl);
    } catch (e: any) {
      console.error("Failed to save profile:", e);
      setProfileError(e?.message || "Failed to save profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  /* ---------------- RENDER ---------------- */

  return (
    <div style={styles.container}>
      {/* exact same pulse keyframes style (no class) */}
      <style>{`@keyframes dripzPulse {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.45);
    opacity: 1;
  }
  70% {
    transform: scale(1.08);
    box-shadow: 0 0 0 10px rgba(124, 58, 237, 0);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(124, 58, 237, 0);
    opacity: 1;
  }
}`}</style>

      <div style={styles.headerRow}>
        <div>
          <div style={styles.kicker}></div>
          <h2 style={styles.title}>Profile</h2>
        </div>

        <div style={styles.headerPill}>
          <span style={styles.headerDot} />
          <span style={{ fontWeight: 900, letterSpacing: "0.2px" }}>
            Connected
          </span>
        </div>
      </div>

      {/* MAIN CARD */}
      <div style={styles.card}>
        <div style={styles.topRow}>
          {/* AVATAR */}
          <div style={styles.avatarWrap}>
            <img
              src={avatar}
              alt="avatar"
              style={styles.avatar}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
              }}
            />

            <label
              style={{
                ...styles.uploadBtn,
                opacity: profileUploading ? 0.7 : 1,
                cursor: profileUploading ? "not-allowed" : "pointer",
              }}
            >
              {profileUploading ? "Uploading…" : "Change"}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={profileUploading}
                onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {/* NAME + LEVEL */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.nameRow}>
              <div style={styles.name}>{publicNamePreview}</div>
              <div
                style={{ ...styles.levelBadge, ...levelBadgeStyle(xp.level) }}
              >
                Lv {xp.level}
              </div>
            </div>

            <div style={styles.subtle}>{signedAccountId}</div>

            {/* edit username */}
            <div style={styles.inputRow}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                style={styles.input}
                maxLength={32}
              />
              <button
                style={{
                  ...styles.primaryBtn,
                  opacity: profileSaving ? 0.7 : 1,
                  cursor: profileSaving ? "not-allowed" : "pointer",
                }}
                disabled={profileSaving}
                onClick={saveProfile}
              >
                {profileSaving ? "Saving…" : "Save"}
              </button>
            </div>

            {profileLoading && (
              <div style={styles.mutedLine}>Loading on-chain profile…</div>
            )}
            {uploadError && <div style={styles.error}>{uploadError}</div>}
            {profileError && <div style={styles.error}>{profileError}</div>}
          </div>
        </div>

        {/* STATS GRID */}
        <div style={styles.statsGrid}>
          <Stat label="XP" value={xp.xp} />
          <Stat
            label="Total Wagered"
            value={statsLoading ? "…" : `${stats.totalWager.toFixed(4)} NEAR`}
          />
          <Stat
            label="Biggest Win"
            value={statsLoading ? "…" : `${stats.highestWin.toFixed(4)} NEAR`}
          />
          <Stat
            label="PnL"
            value={statsLoading ? "…" : `${stats.pnl.toFixed(4)} NEAR`}
            positive={!statsLoading && stats.pnl >= 0}
            negative={!statsLoading && stats.pnl < 0}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- small UI bits ---------------- */

function Stat({
  label,
  value,
  subtle,
  positive,
  negative,
}: {
  label: string;
  value: string;
  subtle?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statLabel}>{label}</div>
      <div
        style={{
          ...styles.statValue,
          ...(subtle ? { opacity: 0.8 } : {}),
          ...(positive ? { color: "#34d399" } : {}),
          ...(negative ? { color: "#fb7185" } : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

function levelBadgeStyle(level: number): CSSProperties {
  if (level >= 66)
    return {
      background: "rgba(239,68,68,0.22)",
      color: "#fecaca",
      borderColor: "rgba(239,68,68,0.35)",
    };
  if (level >= 41)
    return {
      background: "rgba(245,158,11,0.22)",
      color: "#fde68a",
      borderColor: "rgba(245,158,11,0.35)",
    };
  if (level >= 26)
    return {
      background: "rgba(59,130,246,0.22)",
      color: "#bfdbfe",
      borderColor: "rgba(59,130,246,0.35)",
    };
  if (level >= 10)
    return {
      background: "rgba(34,197,94,0.22)",
      color: "#bbf7d0",
      borderColor: "rgba(34,197,94,0.35)",
    };
  return {
    background: "rgba(148,163,184,0.18)",
    color: "#e5e7eb",
    borderColor: "rgba(148,163,184,0.25)",
  };
}

/* ---------------- styles ---------------- */

const styles: Record<string, CSSProperties> = {
  container: {
    maxWidth: 860,
    margin: "0 auto",
    padding: 22,
    fontFamily:
      "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Droid Sans,Helvetica Neue,sans-serif",
  },

  headerRow: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 14,
  },

  kicker: {
    height: 6,
  },

  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 1000,
    letterSpacing: "-0.02em",
    color: "#fff",
  },

  headerPill: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.20)",
    background: "rgba(7, 12, 24, 0.72)",
    color: "#fff",
    backdropFilter: "blur(8px)",
  },

  headerDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: "0 0 0 3px rgba(124,58,237,0.18)",
    animation: "dripzPulse 1.4s ease-out infinite",
  },

  card: {
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.10), transparent 55%), radial-gradient(900px 500px at 90% 20%, rgba(37,99,235,0.16), transparent 55%), rgba(7, 12, 24, 0.92)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
    padding: 16,
    marginBottom: 16,
    overflow: "hidden",
  },

  topRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 14,
  },

  avatarWrap: {
    width: 170,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    alignItems: "center",
  },

  avatar: {
    width: 160,
    height: 160,
    borderRadius: 18,
    objectFit: "cover",
    border: "1px solid rgba(148,163,184,0.22)",
    boxShadow: "0 18px 35px rgba(0,0,0,0.45)",
    background: "rgba(0,0,0,0.25)",
  },

  uploadBtn: {
    width: "100%",
    textAlign: "center",
    borderRadius: 14,
    padding: "10px 12px",
    fontWeight: 900,
    letterSpacing: "0.2px",
    color: "#fff",
    border: "1px solid rgba(148,163,184,0.22)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))",
    backdropFilter: "blur(8px)",
  },

  nameRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },

  name: {
    fontSize: 18,
    fontWeight: 1000,
    color: "#fff",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  subtle: {
    fontSize: 12,
    color: "rgba(226,232,240,0.72)",
    marginBottom: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  levelBadge: {
    borderRadius: 999,
    padding: "6px 10px",
    fontWeight: 1000,
    border: "1px solid rgba(148,163,184,0.22)",
    fontSize: 12,
    whiteSpace: "nowrap",
  },

  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },

  input: {
    flex: 1,
    minWidth: 0,
    borderRadius: 14,
    padding: "12px 12px",
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2, 6, 23, 0.45)",
    color: "#fff",
    outline: "none",
    fontWeight: 800,
  },

  primaryBtn: {
    borderRadius: 14,
    padding: "12px 14px",
    fontWeight: 1000,
    border: "1px solid rgba(124,58,237,0.45)",
    background:
      "linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.95))",
    color: "#fff",
    boxShadow: "0 14px 28px rgba(0,0,0,0.35)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  mutedLine: {
    fontSize: 12,
    color: "rgba(226,232,240,0.70)",
    marginTop: 6,
  },

  error: {
    marginTop: 8,
    borderRadius: 14,
    border: "1px solid rgba(248,113,113,0.35)",
    background: "rgba(248,113,113,0.12)",
    color: "#fecaca",
    padding: "10px 12px",
    fontWeight: 800,
    fontSize: 13,
  },

  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
    marginTop: 10,
  },

  statBox: {
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.16)",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03))",
    padding: 12,
    boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
  },

  statLabel: {
    fontSize: 12,
    color: "rgba(226,232,240,0.72)",
    fontWeight: 900,
    marginBottom: 6,
  },

  statValue: {
    fontSize: 16,
    fontWeight: 1000,
    color: "#fff",
    letterSpacing: "-0.01em",
  },
};
