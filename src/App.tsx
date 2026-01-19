import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Navigation } from "@/components/navigation";
import Home from "@/pages/home";
import CoinFlip from "@/pages/coinflip";
import Poker from "@/pages/poker";
import ChatSidebar from "@/components/ChatSideBar";
import ProfilePanel from "@/components/ProfilePanel";
import TransactionsPanel from "@/components/TransactionsPanel";
import DripzPanel from "@/components/Dripztkn";
import LeaderBoardPanel from "@/components/leaderboard";
import { HelloNearContract, NetworkId } from "@/config";

import "@near-wallet-selector/modal-ui/styles.css";

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
import type {
  WalletModuleFactory,
  NetworkId as WSNetworkId,
} from "@near-wallet-selector/core";

const ENABLE_WALLETS = {
  ethereum: false,

  meteor: true,
  meteorApp: false,

  hot: true,
  ledger: true,
  sender: false,

  // Near Mobile Wallet intentionally removed to avoid parcel dev-server audit chain
  // nearMobile: false,
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
  // WalletSelectorProvider expects NetworkId | Network (not plain string)
  // Cast keeps your existing config unchanged while satisfying TS types.
  network: NetworkId as WSNetworkId,
  modules: [
    ENABLE_WALLETS.ethereum &&
      setupEthereumWallets({
        wagmiConfig: wagmiAdapter.wagmiConfig,
        web3Modal,
      }),

    ENABLE_WALLETS.meteor && setupMeteorWallet(),

    ENABLE_WALLETS.meteorApp &&
      setupMeteorWalletApp({ contractId: HelloNearContract }),

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

function App() {
  return (
    <WalletSelectorProvider config={walletSelectorConfig}>
      <BrowserRouter>
        {/* TOP NAV */}
        <Navigation />

        {/* BODY */}
        <div
          style={{
            display: "flex",
            height: "calc(100vh - 64px)",
            overflow: "hidden",
          }}
        >
          {/* LEFT CHAT */}
          <ChatSidebar />

          {/* RIGHT PAGES */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/coinflip" element={<CoinFlip />} />
              <Route path="/poker" element={<Poker />} />
              <Route path="/profile" element={<ProfilePanel />} />
              <Route path="/transactions" element={<TransactionsPanel />} />
              <Route path="/dripztkn" element={<DripzPanel />} />
              <Route path="/leaderboard" element={<LeaderBoardPanel />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </WalletSelectorProvider>
  );
}

export default App;
