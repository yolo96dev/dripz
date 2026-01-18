import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { createPortal } from "react-dom";
import DripzLogo from "@/assets/dripz.png";
import styles from "@/styles/app.module.css";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { GameNav } from "@/components/GameNav";
import { SocialLinks } from "@/components/SocialLinks";

interface WalletSelectorHook {
  signedAccountId: string | null;
  signIn: () => void;
  signOut: () => void;

  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;

  // ✅ needed so we can enforce “set username + pfp” on first login
  callFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string;
    gas?: string;
  }) => Promise<any>;
}

type MenuPos = { top: number; left: number };

const PROFILE_CONTRACT = "dripzpf.testnet";

// --- onboarding / upload helpers ---
// ✅ fallback image is dripz.png
const FALLBACK_AVATAR = (DripzLogo as any)?.src ?? (DripzLogo as any);

function getImgBBKey(): string {
  // Vite inlines import.meta.env.* at build-time
  return (
    (import.meta as any).env?.VITE_IMGBB_API_KEY ||
    (import.meta as any).env?.NEXT_PUBLIC_IMGBB_API_KEY ||
    (import.meta as any).env?.REACT_APP_IMGBB_API_KEY ||
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

  const directUrl =
    json?.data?.image?.url || json?.data?.url || json?.data?.display_url;

  if (!directUrl || typeof directUrl !== "string") {
    throw new Error("ImgBB upload succeeded but did not return a direct URL");
  }

  return directUrl;
}

export const Navigation = () => {
  const { signedAccountId, signIn, signOut, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const [hoverKey, setHoverKey] = useState<string>("");

  // portal mount (avoid SSR issues)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ✅ Responsive breakpoint (Bootstrap lg ~ 992px)
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 992;
  });

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ✅ Profile image (PFP)
  const [pfpUrl, setPfpUrl] = useState<string>("");

  // ✅ First-login profile setup modal state
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupUsername, setSetupUsername] = useState<string>("");
  const [setupPfpPreview, setSetupPfpPreview] = useState<string>("");
  const [setupPfpUrl, setSetupPfpUrl] = useState<string>("");
  const [setupUploading, setSetupUploading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string>("");

  // Remember which account we already validated in this session
  const lastCheckedAccountRef = useRef<string>("");

  // Fetch profile + decide whether to enforce setup
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!signedAccountId || !viewFunction) {
        if (!cancelled) {
          setPfpUrl("");
          setSetupOpen(false);
          setSetupUsername("");
          setSetupPfpPreview("");
          setSetupPfpUrl("");
          setSetupError("");
        }
        lastCheckedAccountRef.current = "";
        return;
      }

      // avoid refetch loops
      if (lastCheckedAccountRef.current === signedAccountId) return;
      lastCheckedAccountRef.current = signedAccountId;

      setSetupLoading(true);
      setSetupError("");

      try {
        const prof = await viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: signedAccountId },
        });

        if (cancelled) return;

        const url = String(prof?.pfp_url || "");
        const uname = String(prof?.username || "");

        setPfpUrl(url);

        const missingName = !uname || uname.trim().length < 2;
        const missingPfp = !url || url.trim().length < 6;

        // treat no profile or missing fields as "new user" that must set profile
        if (missingName || missingPfp) {
          setSetupOpen(true);

          // prefill username with on-chain username if present, else accountId
          setSetupUsername((uname || signedAccountId || "").slice(0, 32));

          // preview: use stored pfp if present
          setSetupPfpPreview(url || "");
          setSetupPfpUrl(url || "");
        } else {
          setSetupOpen(false);
        }
      } catch {
        if (cancelled) return;

        // if profile view fails, don't hard-lock, but strongly suggest setup
        setPfpUrl("");
        setSetupOpen(true);
        setSetupUsername((signedAccountId || "").slice(0, 32));
        setSetupPfpPreview("");
        setSetupPfpUrl("");
        setSetupError("Could not load your profile. Please set username + PFP.");
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  // When setup modal opens, keep dropdown closed
  useEffect(() => {
    if (setupOpen) setOpen(false);
  }, [setupOpen]);

  // ✅ Lock background scroll while setup modal is open (mobile + desktop)
  const bodyScrollYRef = useRef<number>(0);
  const bodyPrevStyleRef = useRef<Partial<CSSStyleDeclaration> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const body = document.body;
    const html = document.documentElement;

    if (setupOpen) {
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
  }, [setupOpen]);

  // Handle avatar file selection -> upload to ImgBB
  async function onSetupPfpFile(file: File | null) {
    if (!file) return;

    setSetupError("");

    // local preview
    try {
      const local = URL.createObjectURL(file);
      setSetupPfpPreview(local);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(local);
        } catch {}
      }, 2500);
    } catch {}

    const key = getImgBBKey();
    if (!key) {
      setSetupError(
        "Missing ImgBB API key. Set VITE_IMGBB_API_KEY to enable profile picture uploads."
      );
      return;
    }

    setSetupUploading(true);
    try {
      const url = await uploadToImgBB(file, key);
      setSetupPfpUrl(url);
      setSetupPfpPreview(url);
    } catch (e: any) {
      setSetupError(e?.message || "Failed to upload image.");
      setSetupPfpUrl("");
    } finally {
      setSetupUploading(false);
    }
  }

  async function saveSetupProfile() {
    setSetupError("");

    const u = (setupUsername || "").trim();
    if (u.length < 2) {
      setSetupError("Username must be at least 2 characters.");
      return;
    }
    if (u.length > 32) {
      setSetupError("Username must be 32 characters or less.");
      return;
    }

    const p = (setupPfpUrl || "").trim();
    if (!p || p.length < 6) {
      setSetupError("Please upload a profile picture.");
      return;
    }

    if (!signedAccountId) {
      setSetupError("Wallet not connected.");
      return;
    }

    if (!callFunction) {
      setSetupError(
        "Wallet callFunction is not available in this view. Please go to /profile to set username + pfp."
      );
      return;
    }

    setSetupSaving(true);
    try {
      await callFunction({
        contractId: PROFILE_CONTRACT,
        method: "set_profile",
        args: {
          username: u,
          pfp_url: p,
        },
        deposit: "0",
      });

      // reflect immediately in navbar
      setPfpUrl(p);
      setSetupOpen(false);

      // ✅ Broadcast profile update so chat/other components can update instantly
      try {
        window.dispatchEvent(
          new CustomEvent("dripz-profile-updated", {
            detail: { accountId: signedAccountId, username: u, pfp_url: p },
          })
        );
      } catch {}
    } catch (e: any) {
      setSetupError(e?.message || "Failed to save profile on-chain.");
    } finally {
      setSetupSaving(false);
    }
  }

  // where to place the dropdown (fixed, relative to viewport)
  const [menuPos, setMenuPos] = useState<MenuPos>({ top: 0, left: 0 });

  const DROPDOWN_MIN_WIDTH = 190;
  const DROPDOWN_GAP = 10;

  const computeMenuPos = () => {
    const btn = btnRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;
    const pad = 8;

    const desiredWidth = Math.min(
      Math.max(DROPDOWN_MIN_WIDTH, 220),
      Math.max(220, viewportW - pad * 2)
    );

    // right-align dropdown to button, but clamp to viewport
    let left = Math.round(r.right - desiredWidth);
    left = Math.max(pad, Math.min(left, viewportW - desiredWidth - pad));

    // drop below; if too low, flip above
    let top = Math.round(r.bottom + DROPDOWN_GAP);
    const approxMenuH = 240;
    if (top + approxMenuH > viewportH - pad) {
      top = Math.max(pad, Math.round(r.top - approxMenuH - DROPDOWN_GAP));
    }

    setMenuPos({ top, left });
  };

  // compute position when opening + keep it synced on scroll/resize
  useLayoutEffect(() => {
    if (!open) return;

    computeMenuPos();

    const onScroll = () => computeMenuPos();
    const onResize = () => computeMenuPos();

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // close dropdown on outside click / ESC
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!open) return;
      const t = e.target as Node | null;
      if (!t) return;

      const inMenu = menuRef.current?.contains(t);
      const inBtn = btnRef.current?.contains(t);
      if (!inMenu && !inBtn) setOpen(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown as any);
    document.addEventListener("touchstart", onDown as any, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown as any);
      document.removeEventListener("touchstart", onDown as any);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const navBtnBase: React.CSSProperties = {
    height: 38,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    fontWeight: 850,
    fontSize: 13,
    letterSpacing: "0.2px",
    padding: "0 10px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    cursor: "pointer",
    userSelect: "none",
    boxShadow: "0 10px 18px rgba(0,0,0,0.18)",
  };

  const navBtnPrimary: React.CSSProperties = {
    ...navBtnBase,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
  };

  const dropdownStyle: React.CSSProperties = {
    position: "fixed",
    top: menuPos.top,
    left: menuPos.left,
    minWidth: DROPDOWN_MIN_WIDTH,
    maxWidth: "calc(100vw - 16px)",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(7, 12, 24, 0.96)",
    boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
    padding: 6,
    zIndex: 999999,
  };

  const dropdownItemStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid transparent",
    background: "transparent",
    color: "#e5e7eb",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 850,
    display: "flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
  };

  const dropdownItemHover: React.CSSProperties = {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(148,163,184,0.14)",
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: "rgba(148,163,184,0.14)",
    margin: "6px 6px",
  };

  const Chevron = ({ open }: { open: boolean }) => (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 140ms ease",
        fontSize: 12,
        opacity: 0.9,
      }}
    >
      ▾
    </span>
  );

  const dropdownNode =
    open && mounted && !setupOpen
      ? createPortal(
          <div
            ref={menuRef}
            style={dropdownStyle}
            role="menu"
            aria-label="Account menu"
          >
            <Link
              to="/profile"
              style={{
                ...dropdownItemStyle,
                ...(hoverKey === "profile" ? dropdownItemHover : null),
              }}
              onMouseEnter={() => setHoverKey("profile")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              Profile
            </Link>

            <Link
              to="/transactions"
              style={{
                ...dropdownItemStyle,
                ...(hoverKey === "tx" ? dropdownItemHover : null),
              }}
              onMouseEnter={() => setHoverKey("tx")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              Transactions
            </Link>

            <Link
              to="/dripztkn"
              style={{
                ...dropdownItemStyle,
                ...(hoverKey === "dripz" ? dropdownItemHover : null),
              }}
              onMouseEnter={() => setHoverKey("dripz")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              $DRIPZ
            </Link>

            <div style={dividerStyle} />

            <button
              style={{
                ...dropdownItemStyle,
                color: "#f87171",
                ...(hoverKey === "logout" ? dropdownItemHover : null),
              }}
              onMouseEnter={() => setHoverKey("logout")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => {
                setOpen(false);
                signOut();
              }}
              role="menuitem"
            >
              <span style={{ opacity: 0.9 }}>⎋</span>
              Logout
            </button>
          </div>,
          document.body
        )
      : null;

  // ✅ Setup modal portal (forced for new users)
  const setupNode =
    setupOpen && mounted
      ? createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999999,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 14,
            }}
          >
            <div
              style={{
                width: "min(520px, 92vw)",
                borderRadius: 18,
                border: "1px solid rgba(148,163,184,0.18)",
                background:
                  "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%), rgba(7, 12, 24, 0.98)",
                boxShadow: "0 30px 80px rgba(0,0,0,0.70)",
                overflow: "hidden",
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Set up your profile"
            >
              <div
                style={{
                  padding: 14,
                  borderBottom: "1px solid rgba(148,163,184,0.14)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "nowrap",
                  minWidth: 0,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 950, fontSize: 14, color: "#fff" }}>
                    Finish setup
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "rgba(226,232,240,0.70)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "min(360px, 60vw)",
                    }}
                  >
                    New users must set a username and profile picture.
                  </div>
                </div>

                {/* ✅ FIX: mobile-safe logout button (no wrap, consistent sizing) */}
                <button
                  onClick={() => signOut()}
                  style={{
                    height: 34,
                    minHeight: 34,
                    borderRadius: 12,
                    border: "1px solid rgba(248,113,113,0.35)",
                    background: "rgba(248,113,113,0.10)",
                    color: "#fecaca",
                    fontWeight: 950,
                    padding: "0 12px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    whiteSpace: "nowrap",
                    flex: "0 0 auto",
                    lineHeight: 1,
                    userSelect: "none",
                    WebkitTapHighlightColor: "transparent",
                  }}
                  title="Logout"
                >
                  <span aria-hidden="true" style={{ opacity: 0.9 }}>
                    ⎋
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>Logout</span>
                </button>
              </div>

              <div style={{ padding: 14 }}>
                {setupError && (
                  <div
                    style={{
                      borderRadius: 14,
                      border: "1px solid rgba(248,113,113,0.35)",
                      background: "rgba(248,113,113,0.12)",
                      color: "#fecaca",
                      padding: "10px 12px",
                      fontWeight: 800,
                      fontSize: 13,
                      marginBottom: 12,
                    }}
                  >
                    {setupError}
                  </div>
                )}

                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 86, flexShrink: 0 }}>
                    <div
                      style={{
                        width: 86,
                        height: 86,
                        borderRadius: 18,
                        overflow: "hidden",
                        border: "1px solid rgba(148,163,184,0.18)",
                        background: "rgba(255,255,255,0.04)",
                        boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
                      }}
                    >
                      <img
                        src={
                          setupPfpPreview ||
                          setupPfpUrl ||
                          pfpUrl ||
                          FALLBACK_AVATAR
                        }
                        alt="pfp preview"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          display: "block",
                        }}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src =
                            FALLBACK_AVATAR;
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: "rgba(226,232,240,0.75)",
                        marginBottom: 6,
                      }}
                    >
                      Username
                    </div>

                    <input
                      value={setupUsername}
                      onChange={(e) =>
                        setSetupUsername(e.target.value.slice(0, 32))
                      }
                      placeholder="Choose a username"
                      style={{
                        width: "100%",
                        height: 42,
                        borderRadius: 14,
                        border: "1px solid rgba(148,163,184,0.18)",
                        background: "rgba(2, 6, 23, 0.55)",
                        color: "#fff",
                        padding: "0 12px",
                        outline: "none",
                        fontSize: 16,
                        fontWeight: 850,
                      }}
                      disabled={setupLoading || setupSaving}
                    />

                    <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                      <label
                        style={{
                          height: 38,
                          borderRadius: 14,
                          border: "1px solid rgba(148,163,184,0.18)",
                          background: "rgba(255,255,255,0.04)",
                          color: "#e5e7eb",
                          fontWeight: 900,
                          fontSize: 13,
                          padding: "0 12px",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor:
                            setupUploading || setupSaving
                              ? "not-allowed"
                              : "pointer",
                          opacity: setupUploading || setupSaving ? 0.7 : 1,
                          userSelect: "none",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {setupUploading ? "Uploading…" : "Upload PFP"}
                        <input
                          type="file"
                          accept="image/*"
                          hidden
                          disabled={setupUploading || setupSaving}
                          onChange={(e) =>
                            onSetupPfpFile(e.target.files?.[0] ?? null)
                          }
                        />
                      </label>

                      <button
                        onClick={saveSetupProfile}
                        disabled={setupSaving || setupUploading || setupLoading}
                        style={{
                          height: 38,
                          borderRadius: 14,
                          border: "1px solid rgba(255,255,255,0.14)",
                          background:
                            "linear-gradient(135deg, #7c3aed, #2563eb)",
                          color: "#fff",
                          fontWeight: 950,
                          fontSize: 13,
                          padding: "0 12px",
                          cursor:
                            setupSaving || setupUploading || setupLoading
                              ? "not-allowed"
                              : "pointer",
                          opacity:
                            setupSaving || setupUploading || setupLoading
                              ? 0.75
                              : 1,
                          boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
                          whiteSpace: "nowrap",
                        }}
                        title="Save profile"
                      >
                        {setupSaving ? "Saving…" : "Save"}
                      </button>
                    </div>

                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 12,
                        color: "rgba(226,232,240,0.60)",
                        lineHeight: 1.35,
                      }}
                    >
                      Tip: username must be 2–32 chars.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const showSocial = true;

  return (
    <>
      {/* ✅ tighter spacing + prettier pill + pull first game left a bit */}
      <style>{`
        .dripz-game-nav-pill{
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          touch-action: pan-x;
          scrollbar-width: none;
        }
        .dripz-game-nav-pill::-webkit-scrollbar{ height: 0px; }

        .dripz-game-nav-inner > *:first-child{
          margin-left: -6px;
        }

        .dripz-game-nav-inner a,
        .dripz-game-nav-inner button{
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
      `}</style>

      <nav
        className="navbar navbar-expand-lg navbar-dark"
        style={{
          background: "rgba(0,0,0,0.65)",
          color: "#fff",
          borderBottom: "1px solid rgba(148,163,184,0.12)",
          backdropFilter: "blur(10px)",
          position: isMobile ? "relative" : "sticky",
          top: isMobile ? undefined : 0,
          zIndex: 5000,
        }}
      >
        <div
          className="container-fluid"
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr) auto",
            alignItems: "center",
            gap: isMobile ? 10 : 14,
          }}
        >
          {/* LEFT: LOGO (+ hide Dripz text on mobile) */}
          <Link
            to="/"
            className="d-flex align-items-center gap-2 text-decoration-none"
            style={{ color: "inherit", justifySelf: "start", minWidth: 0 }}
            aria-label="Dripz Home"
          >
            <img
              src={DripzLogo}
              alt="Dripz"
              width={30}
              height={24}
              className={styles.logo}
              style={{ filter: "none", mixBlendMode: "normal", opacity: 1 }}
            />

            {!isMobile && (
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 900,
                  letterSpacing: "0.3px",
                  color: "inherit",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                }}
              >
                Dripz
              </span>
            )}
          </Link>

          {/* CENTER: GAMES */}
          <div
            style={{
              justifySelf: "center",
              width: "100%",
              minWidth: 0,
              display: "flex",
              justifyContent: isMobile ? "flex-start" : "center",
            }}
          >
            <div
              className={isMobile ? "dripz-game-nav-pill" : undefined}
              style={{
                width: isMobile ? "100%" : "auto",
                maxWidth: isMobile ? "100%" : "min(760px, 100%)",
                overflowX: isMobile ? "auto" : "visible",
                overflowY: "hidden",
                whiteSpace: isMobile ? "nowrap" : "normal",
                padding: isMobile ? "4px 8px" : 0,
                borderRadius: isMobile ? 999 : 0,
                border: isMobile ? "1px solid rgba(148,163,184,0.18)" : "none",
                background: isMobile
                  ? "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.03))"
                  : "transparent",
                boxShadow: isMobile ? "0 10px 18px rgba(0,0,0,0.18)" : "none",
              }}
            >
              <div
                className="dripz-game-nav-inner"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: isMobile ? 6 : 10,
                  flexWrap: "nowrap",
                  paddingRight: isMobile ? 6 : 0,
                }}
              >
                <GameNav />
              </div>
            </div>
          </div>

          {/* RIGHT: SOCIAL + AUTH */}
          <div
            className="d-flex align-items-center position-relative"
            style={{ justifySelf: "end", gap: isMobile ? 8 : 12 }}
          >
            {showSocial ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: isMobile ? 10 : 12,
                  transform: isMobile ? "scale(0.95)" : "none",
                  transformOrigin: "right center",
                }}
              >
                <SocialLinks />
              </div>
            ) : null}

            {!signedAccountId && (
              <button style={navBtnPrimary} onClick={signIn}>
                Login
              </button>
            )}

            {signedAccountId && (
              <button
                ref={btnRef}
                style={{
                  ...navBtnBase,
                  padding: "0 10px",
                  gap: 10,
                  opacity: setupOpen ? 0.65 : 1,
                  cursor: setupOpen ? "not-allowed" : "pointer",
                }}
                onClick={() => {
                  if (setupOpen) return;
                  setOpen((v) => !v);
                }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                title={setupOpen ? "Finish setup first" : "Account menu"}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    overflow: "hidden",
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(0,0,0,0.25)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "0 0 auto",
                    boxShadow: "0 0 0 3px rgba(124,58,237,0.10)",
                  }}
                >
                  <img
                    // ✅ fallback to dripz.png
                    src={pfpUrl || FALLBACK_AVATAR}
                    alt="pfp"
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src =
                        FALLBACK_AVATAR;
                    }}
                  />
                </span>

                <Chevron open={open} />
              </button>
            )}
          </div>
        </div>
      </nav>

      {dropdownNode}
      {setupNode}
    </>
  );
};
