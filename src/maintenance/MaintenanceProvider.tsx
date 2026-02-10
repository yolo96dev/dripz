import React, { createContext, useContext, useMemo } from "react";

// ✅ Your gif is in src/assets — import it so Vite bundles it.
// Change the filename if yours is different.
import MaintGif from "@/assets/shuffle.svg";

type MaintenanceState = {
  enabled: boolean;
  message: string;
  gifSrc: string;
};

const MaintenanceCtx = createContext<MaintenanceState>({
  enabled: false,
  message: "Under maintenance.",
  gifSrc: "",
});

function envBool(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Vite env:
 *  - VITE_MAINTENANCE_ENABLED=true|false
 *  - VITE_MAINTENANCE_MESSAGE="Under maintenance"
 * Optional override:
 *  - VITE_MAINTENANCE_GIF="https://.../file.gif"
 *
 * NOTE: We DO NOT lock body scrolling here.
 * Locking body scroll can break wallet login/connect modals.
 * We only disable scroll inside the right panel in App.tsx.
 */
export function MaintenanceProvider({ children }: { children: React.ReactNode }) {
  const enabled = envBool(import.meta.env.VITE_MAINTENANCE_ENABLED);
  const message = import.meta.env.VITE_MAINTENANCE_MESSAGE || "Under maintenance.";

  const importedSrc = (MaintGif as any)?.src ?? (MaintGif as any);
  const gifSrc = import.meta.env.VITE_MAINTENANCE_GIF || importedSrc || "";

  const value = useMemo(() => ({ enabled, message, gifSrc }), [enabled, message, gifSrc]);

  return <MaintenanceCtx.Provider value={value}>{children}</MaintenanceCtx.Provider>;
}

export function useMaintenance() {
  return useContext(MaintenanceCtx);
}
