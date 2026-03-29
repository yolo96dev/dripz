const contractPerNetwork = {
  mainnet: {
    coinflip: "dripz_cf.near",
    jackpot: "dripzjp.near",
  },
  testnet: {
    coinflip: "dripzcf.testnet",
    jackpot: "dripzjp.testnet",
  },
} as const;

export const NetworkId = "mainnet" as const;

// Export both
export const Contracts = contractPerNetwork[NetworkId];

// Export ONE “primary” contract for modules that require a single contractId
export const HelloNearContract = Contracts.coinflip;
