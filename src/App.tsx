import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Navigation } from "@/components/navigation";
import Home from "@/pages/home";
import CoinFlip from "@/pages/coinflip";
import Poker from "@/pages/poker";
import ChatSidebar from "@/components/ChatSideBar";
import SpinSidebar from "@/components/wheelBar";
import ProfilePanel from "@/components/ProfilePanel";
import TransactionsPanel from "@/components/TransactionsPanel";
import DripzPanel from "@/components/Dripztkn";
import LeaderBoardPanel from "@/components/leaderboard";
import { HelloNearContract, NetworkId } from "@/config";

import "@near-wallet-selector/modal-ui/styles.css";

// Solana (Phantom) wallets (for SOL mode / SOL Intents)
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useMemo, useState, type ReactNode } from "react";

import "@solana/wallet-adapter-react-ui/styles.css";

// Maintenance
import { MaintenanceProvider, useMaintenance } from "@/maintenance/MaintenanceProvider";

// Wallet setups
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMeteorWalletApp } from "@near-wallet-selector/meteor-wallet-app";
import { setupEthereumWallets } from "@near-wallet-selector/ethereum-wallets";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupLedger } from "@near-wallet-selector/ledger";
import { setupSender } from "@near-wallet-selector/sender";

import { setupWelldoneWallet } from "@near-wallet-selector/welldone-wallet";
import { setupMathWallet } from "@near-wallet-selector/math-wallet";
import { setupBitgetWallet } from "@near-wallet-selector/bitget-wallet";
import { setupRamperWallet } from "@near-wallet-selector/ramper-wallet";
import { setupUnityWallet } from "@near-wallet-selector/unity-wallet";
import { setupOKXWallet } from "@near-wallet-selector/okx-wallet";
import { setupCoin98Wallet } from "@near-wallet-selector/coin98-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";

import { WalletSelectorProvider } from "@near-wallet-selector/react-hook";

// Ethereum adapters
import { wagmiAdapter, web3Modal } from "@/wallets/web3modal";

// Types
import type { WalletModuleFactory, NetworkId as WSNetworkId } from "@near-wallet-selector/core";

const ENABLE_WALLETS = {
  solana: true,
  ethereum: false,
  meteor: true,
  meteorApp: false,
  hot: true,
  ledger: true,
  sender: false,
  welldone: false,
  math: false,
  bitget: false,
  ramper: false,
  unity: false,
  okx: false,
  coin98: false,
  intear: false,
};

const walletSelectorConfig = {
  network: NetworkId as WSNetworkId,
  modules: [
    ENABLE_WALLETS.ethereum &&
      setupEthereumWallets({
        wagmiConfig: wagmiAdapter.wagmiConfig,
        web3Modal,
      }),

    ENABLE_WALLETS.meteor && setupMeteorWallet(),

    ENABLE_WALLETS.meteorApp && setupMeteorWalletApp({ contractId: HelloNearContract }),

    ENABLE_WALLETS.hot && setupHotWallet(),
    ENABLE_WALLETS.ledger && setupLedger(),
    ENABLE_WALLETS.sender && setupSender(),

    ENABLE_WALLETS.welldone && setupWelldoneWallet(),
    ENABLE_WALLETS.math && setupMathWallet(),
    ENABLE_WALLETS.bitget && setupBitgetWallet(),
    ENABLE_WALLETS.ramper && setupRamperWallet(),

    ENABLE_WALLETS.unity &&
      setupUnityWallet({
        projectId: "your-project-id",
        metadata: {
          name: "Dripz",
          description: "Dripz Games",
          url: "https://dripz.xyz",
          icons: ["https://dripz.xyz/favicon.png"],
        },
      }),

    ENABLE_WALLETS.okx && setupOKXWallet(),
    ENABLE_WALLETS.coin98 && setupCoin98Wallet(),
    ENABLE_WALLETS.intear && setupIntearWallet(),
  ].filter(Boolean) as WalletModuleFactory[],
};

// Solana (Phantom) RPC endpoint (Vite env: VITE_SOLANA_RPC)
const SOLANA_RPC =
  (import.meta as any)?.env?.VITE_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

/**
 * MaintenanceGate (used only on /, /coinflip, /poker)
 * - blur page content + show ONE centered modern maintenance card
 * - overlay is visual-only (pointerEvents none) so wallet modals are always clickable & above
 * - overlay zIndex kept low so ChatSidebar can sit visually above when opened
 */
function MaintenanceGate({ children, forceEnabled }: { children: ReactNode; forceEnabled?: boolean }) {
  const { enabled, message, gifSrc } = useMaintenance();
  const [gifOk, setGifOk] = useState(true);

  const active = (forceEnabled === undefined ? !!enabled : !!forceEnabled);

  if (!active) return <>{children}</>;

  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          filter: "blur(2px)",
          opacity: 0.23,
          pointerEvents: "none",
          height: "100%",
        }}
      >
        {children}
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 50, // low: chat can overlay above it
          display: "grid",
          placeItems: "center",
          padding: 18,
          background:
            "radial-gradient(1200px 600px at 50% 15%, rgba(255,255,255,0.08), rgba(0,0,0,0) 60%), rgba(0,0,0,0.22)",
          pointerEvents: "none",
        }}
      >
        {/* modern "glass" card with gradient border */}
        <div style={{ position: "relative", width: "min(560px, 92vw)" }}>
          <div
            style={{
              position: "absolute",
              inset: -1,
              borderRadius: 22,
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.05), rgba(255,255,255,0.16))",
              filter: "blur(0px)",
              opacity: 0.9,
            }}
          />
          <div
            style={{
              position: "relative",
              borderRadius: 22,
              padding: 18,
              background:
                "linear-gradient(180deg, rgba(14,14,16,0.72), rgba(14,14,16,0.55))",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow:
                "0 20px 60px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.04) inset",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              textAlign: "center",
              overflow: "hidden",
            }}
          >
            {/* subtle shimmer */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(110deg, rgba(255,255,255,0) 20%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0) 70%)",
                transform: "translateX(-40%)",
                animation: "dripzMaintShimmer 3.2s ease-in-out infinite",
                pointerEvents: "none",
              }}
            />

            {/* status pill */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 999,
                fontWeight: 900,
                fontSize: 12,
                letterSpacing: 0.3,
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "rgba(255,255,255,0.90)",
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "rgba(255, 214, 0, 0.95)",
                  boxShadow: "0 0 14px rgba(255, 214, 0, 0.55)",
                  animation: "dripzMaintPulse 1.2s ease-in-out infinite",
                }}
              />
              UNDER MAINTENANCE
            </div>

            {/* GIF */}
            {gifSrc && gifOk ? (
              <img
                src={gifSrc}
                alt="Under maintenance"
                onError={() => setGifOk(false)}
                style={{
                  width: "min(260px, 64vw)",
                  height: "auto",
                  borderRadius: 16,
                  display: "block",
                  margin: "0 auto 12px",
                  boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
                }}
              />
            ) : null}

            {/* message */}
            <div
              style={{
                fontWeight: 950,
                fontSize: 18,
                lineHeight: 1.25,
                color: "rgba(255,255,255,0.96)",
              }}
            >
              {message}
            </div>

            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                fontWeight: 650,
                color: "rgba(255,255,255,0.70)",
              }}
            >
              We’ll be back soon!!!
            </div>

            {!gifOk ? (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, fontWeight: 700 }}>
                (maintenance gif not found)
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes dripzMaintShimmer {
          0% { transform: translateX(-60%); opacity: 0.25; }
          50% { transform: translateX(60%); opacity: 0.55; }
          100% { transform: translateX(140%); opacity: 0.25; }
        }
        @keyframes dripzMaintPulse {
          0%, 100% { transform: scale(0.9); opacity: 0.65; }
          50% { transform: scale(1.15); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function AppShell() {
  const { enabled: maintEnabled } = useMaintenance();
  const location = useLocation();
  const path = location.pathname || "/";


  const envBool = (v: any) => {
    const s = String(v ?? "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  };

  // ✅ Separate toggle for $DRIPZ page maintenance
  const maintDripzEnabled = envBool(import.meta.env.VITE_MAINTENANCE_DRIPZ_ENABLED);

  // Maintenance overlay on game routes only:
  const isMaintRoute =
    path === "/" || path.startsWith("/coinflip") || path.startsWith("/poker");

  const isDripzRoute = path.startsWith("/dripztkn");
  const showDripzMaint = maintDripzEnabled && isDripzRoute;

  // Disable wheel on these routes:
  const isNoSpinRoute =
    path.startsWith("/profile") ||
    path.startsWith("/transactions") ||
    path.startsWith("/leaderboard") ||
    path.startsWith("/dripztkn");

  const showSpinSidebar = !isNoSpinRoute && !(maintEnabled && isMaintRoute);

  // Only lock scroll on RIGHT panel during maintenance game routes
  const rightPanelScrollY = (maintEnabled && isMaintRoute) || showDripzMaint ? "hidden" : "auto";

  return (
    <>
      <Navigation />

      <div style={{ display: "flex", height: "calc(100vh - 64px)", overflow: "hidden" }}>
        {/* chat above maintenance overlay when opened */}
        <div style={{ position: "relative", zIndex: 5000 }}>
          <ChatSidebar />
        </div>

        {showSpinSidebar ? (
          <div style={{ position: "relative", zIndex: 4000 }}>
            <SpinSidebar spinContractId="dripzspin2.testnet" />
          </div>
        ) : null}

        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ height: "100%", overflowY: rightPanelScrollY as any }}>
            <Routes>
              <Route
                path="/"
                element={
                  <MaintenanceGate>
                    <Home />
                  </MaintenanceGate>
                }
              />
              <Route
                path="/coinflip"
                element={
                  <MaintenanceGate>
                    <CoinFlip />
                  </MaintenanceGate>
                }
              />
              <Route
                path="/poker"
                element={
                  <MaintenanceGate>
                    <Poker />
                  </MaintenanceGate>
                }
              />

              {/* Scrollable pages (wheel disabled) */}
              <Route path="/profile" element={<ProfilePanel />} />
              <Route path="/transactions" element={<TransactionsPanel />} />
              <Route path="/dripztkn" element={<MaintenanceGate forceEnabled={maintDripzEnabled}><DripzPanel /></MaintenanceGate>} />
              <Route path="/leaderboard" element={<LeaderBoardPanel />} />
            </Routes>
          </div>
        </div>
      </div>

      {/* Ensure wallet modals always sit above everything visually */}
      <style>{`
        .ReactModal__Overlay,
        .ReactModal__Content,
        [role="dialog"],
        [aria-modal="true"],
        [class*="wallet-selector"],
        [class*="WalletSelector"],
        [data-wallet-selector-modal],
        [data-wallet-selector-overlay] {
          z-index: 2147483000 !important;
        }
      `}</style>
    </>
  );
}

function App() {
  const solWallets = useMemo(
    () => (ENABLE_WALLETS.solana ? [new PhantomWalletAdapter()] : []),
    []
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <SolanaWalletProvider wallets={solWallets} autoConnect>
        <WalletModalProvider>
          <WalletSelectorProvider config={walletSelectorConfig}>
            <MaintenanceProvider>
              <BrowserRouter>
                <AppShell />
              </BrowserRouter>
            </MaintenanceProvider>
          </WalletSelectorProvider>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

export default App;
