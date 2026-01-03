const contractPerNetwork = {
  mainnet: {
    coinflip: "dripz_cfv4.near",
    jackpot: "dripz_jpv2.near",
  },
  testnet: {
    coinflip: "dripzcf.testnet",
    jackpot: "dripzjp.testnet",
  },
} as const;

export const NetworkId = "testnet" as const;

// Export both
export const Contracts = contractPerNetwork[NetworkId];

// Export ONE “primary” contract for modules that require a single contractId
export const HelloNearContract = Contracts.coinflip;
