import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
}

type MenuPos = { top: number; left: number };

const PROFILE_CONTRACT = "dripzpf.testnet";

export const Navigation = () => {
  const { signedAccountId, signIn, signOut, viewFunction } =
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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!signedAccountId || !viewFunction) {
        if (!cancelled) setPfpUrl("");
        return;
      }

      try {
        const prof = await viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: signedAccountId },
        });

        if (cancelled) return;

        const url = String(prof?.pfp_url || "");
        setPfpUrl(url);
      } catch {
        if (cancelled) return;
        setPfpUrl("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

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
    open && mounted
      ? createPortal(
          <div ref={menuRef} style={dropdownStyle} role="menu" aria-label="Account menu">
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

  // ✅ show socials on mobile too (icons)
  const showSocial = true;

  return (
    <>
      {/* ✅ Mobile game-nav “pill” (scrollable) + desktop centering helpers */}
      <style>{`
        .dripz-game-nav-pill{
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          touch-action: pan-x;
        }
        .dripz-game-nav-pill::-webkit-scrollbar{ height: 0px; }
      `}</style>

      <nav
        className="navbar navbar-expand-lg navbar-dark"
        style={{
          background: "rgba(0,0,0,0.65)",
          color: "#fff",
          borderBottom: "1px solid rgba(148,163,184,0.12)",
          backdropFilter: "blur(10px)",

          // Desktop stays sticky. Mobile scrolls away.
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
          {/* LEFT: LOGO + DRIPZ (show on mobile too) */}
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

            <span
              style={{
                fontSize: isMobile ? 14 : 16,
                fontWeight: 900,
                letterSpacing: "0.3px",
                color: "inherit",
                lineHeight: 1,
                whiteSpace: "nowrap",
              }}
            >
              Dripz
            </span>
          </Link>

          {/* CENTER: GAMES */}
          <div
            style={{
              justifySelf: "center",
              width: "100%",
              minWidth: 0,
              display: "flex",
              justifyContent: isMobile ? "flex-start" : "center", // ✅ centered on desktop
            }}
          >
            {/* ✅ Mobile: rounded pill window that scrolls horizontally */}
            <div
              className={isMobile ? "dripz-game-nav-pill" : undefined}
              style={{
                width: isMobile ? "100%" : "auto",
                maxWidth: isMobile ? "100%" : "min(760px, 100%)",
                overflowX: isMobile ? "auto" : "visible",
                overflowY: "hidden",
                whiteSpace: isMobile ? "nowrap" : "normal",

                // pill look (mobile only)
                padding: isMobile ? "6px 10px" : 0,
                borderRadius: isMobile ? 999 : 0,
                border: isMobile ? "1px solid rgba(148,163,184,0.18)" : "none",
                background: isMobile ? "rgba(255,255,255,0.04)" : "transparent",
                boxShadow: isMobile ? "0 10px 18px rgba(0,0,0,0.18)" : "none",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "nowrap",
                  paddingRight: isMobile ? 8 : 0, // little room to scroll past last item
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
                }}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                title="Account menu"
              >
                {/* PFP only (no name) */}
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
                    src={pfpUrl || DripzLogo}
                    alt="pfp"
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
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
    </>
  );
};
