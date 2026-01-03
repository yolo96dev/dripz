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
}

type MenuPos = { top: number; left: number };

export const Navigation = () => {
  const { signedAccountId, signIn, signOut } =
    useWalletSelector() as WalletSelectorHook;

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const [hoverKey, setHoverKey] = useState<string>("");

  // portal mount (avoid SSR issues)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // where to place the dropdown (fixed, relative to viewport)
  const [menuPos, setMenuPos] = useState<MenuPos>({ top: 0, left: 0 });

  const DROPDOWN_MIN_WIDTH = 190;
  const DROPDOWN_GAP = 10;

  const computeMenuPos = () => {
    const btn = btnRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();

    // right-align dropdown to button
    const left = Math.max(8, Math.round(r.right - DROPDOWN_MIN_WIDTH));
    const top = Math.round(r.bottom + DROPDOWN_GAP);

    setMenuPos({ top, left });
  };

  // compute position when opening + keep it synced on scroll/resize
  useLayoutEffect(() => {
    if (!open) return;

    computeMenuPos();

    const onScroll = () => computeMenuPos();
    const onResize = () => computeMenuPos();

    // capture scroll from any scroll container
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
    const onDown = (e: MouseEvent) => {
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

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
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
    padding: "0 12px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
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

  // ✅ CHANGED: fixed + very high zIndex (rendered in portal)
  const dropdownStyle: React.CSSProperties = {
    position: "fixed",
    top: menuPos.top,
    left: menuPos.left,
    marginTop: 0,
    minWidth: DROPDOWN_MIN_WIDTH,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(7, 12, 24, 0.96)",
    boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
    padding: 6,
    zIndex: 999999, // 👈 always above everything
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
          <div ref={menuRef} style={dropdownStyle} role="menu">
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
              <span style={{ opacity: 0.9 }}></span>
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
              <span style={{ opacity: 0.9 }}></span>
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
              <span style={{ opacity: 0.9 }}></span>
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

  return (
    <>
      <nav
        className="navbar navbar-expand-lg navbar-dark"
        style={{
          background: "rgba(0,0,0,0.65)",
          color: "#fff",
          borderBottom: "1px solid rgba(148,163,184,0.12)",
          backdropFilter: "blur(10px)",
          position: "sticky",
          top: 0,
          zIndex: 5000, // keep navbar itself above page sections too
        }}
      >
        <div
          className="container-fluid"
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            alignItems: "center",
            gap: 14,
          }}
        >
          {/* LEFT: LOGO */}
          <Link
            to="/"
            className="d-flex align-items-center gap-2 text-decoration-none"
            style={{ color: "inherit", justifySelf: "start" }}
            aria-label="Dripz Home"
          >
            <img
              src={DripzLogo}
              alt="Dripz"
              width={30}
              height={24}
              className={styles.logo}
              style={{
                filter: "none",
                mixBlendMode: "normal",
                opacity: 1,
              }}
            />

            <span
              style={{
                fontSize: 16,
                fontWeight: 900,
                letterSpacing: "0.3px",
                color: "inherit",
                lineHeight: 1,
              }}
            >
              Dripz
            </span>
          </Link>

          {/* CENTER: GAME NAV (centered) */}
          <div style={{ justifySelf: "center" }}>
            <GameNav />
          </div>

          {/* RIGHT: SOCIAL + AUTH */}
          <div
            className="d-flex align-items-center gap-3 position-relative"
            style={{ justifySelf: "end" }}
          >
            <SocialLinks />

            {!signedAccountId && (
              <button
                style={navBtnPrimary}
                onClick={signIn}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.filter =
                    "brightness(1.05)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.filter = "none";
                }}
              >
                Login
              </button>
            )}

            {signedAccountId && (
              <div className="position-relative">
                <button
                  ref={btnRef}
                  style={navBtnBase}
                  onClick={() => setOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(255,255,255,0.04)";
                  }}
                >
                  <span
                    style={{
                      maxWidth: 140,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {signedAccountId}
                  </span>
                  <Chevron open={open} />
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ✅ dropdown rendered at document.body level */}
      {dropdownNode}
    </>
  );
};
