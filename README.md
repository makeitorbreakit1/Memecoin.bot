# Meme Radar V6 — Solana + Robinhood Chain

This version keeps the existing Solana radar and adds a second, independent Robinhood Chain radar for coins launched through the launchpad.meme Robinhood launch feed.

## Robinhood Chain
- Chain ID: 4663
- Public RPC: https://rpc.mainnet.chain.robinhood.com
- Discovery: launchpad.meme official public Robinhood launch feed
- Market data: DexScreener Robinhood pairs
- Contract checks: Robinhood Chain RPC
- Holder count/distribution: Robinhood Chain Blockscout API
- Discord command: `/rh-radar <contract>`

## Default Robinhood gates
- Score >= 70
- Verification >= 80%
- Rug probability <= 35%
- Liquidity >= $10,000
- Holders >= 25
- Launch factory must match the known launchpad factory
- Contract checks must be available
- Token age 30 seconds to 6 hours

No Robinhood API key is required for the scanner. Do not put a private key or wallet seed phrase in Railway.
