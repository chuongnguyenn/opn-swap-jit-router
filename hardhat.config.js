require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// OPN Chain testnet. RPC/chainId default to the public OPN testnet values; the private key
// is read from .env only (never hard-coded, never committed — .env is gitignored).
const OPN_TESTNET_RPC = process.env.OPN_TESTNET_RPC || "https://testnet-rpc.iopn.tech";
const OPN_TESTNET_CHAIN_ID = process.env.OPN_TESTNET_CHAIN_ID
  ? Number(process.env.OPN_TESTNET_CHAIN_ID)
  : 984;
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

const opnTestnet = {
  opnTestnet: {
    url: OPN_TESTNET_RPC,
    chainId: OPN_TESTNET_CHAIN_ID,
    accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
  },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    ...opnTestnet,
  },
  // OPN testnet explorer is Blockscout, which exposes an Etherscan-compatible /api endpoint.
  // Blockscout ignores the API key, but hardhat-verify requires a non-empty string.
  etherscan: {
    apiKey: {
      opnTestnet: process.env.OPN_EXPLORER_API_KEY || "blockscout",
    },
    customChains: [
      {
        network: "opnTestnet",
        chainId: OPN_TESTNET_CHAIN_ID,
        urls: {
          apiURL: "https://testnet.iopn.tech/api",
          browserURL: "https://testnet.iopn.tech",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};
