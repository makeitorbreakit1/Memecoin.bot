# V6 Chain Routing Fix

`/radar` now automatically routes:
- Solana base58 mint -> Solana Watchlist
- Robinhood Chain EVM contract (`0x` + 40 hex characters) -> Robinhood Watchlist

`/rh-radar` remains available for an explicit Robinhood Chain check.

IMPORTANT: Upload the CONTENTS of this `meme-radar-bot` folder to the root of your GitHub repository,
so `index.js`, `package.json`, and the `lib/` folder are all at the repository root.

Example repository layout:

index.js
package.json
railway.json
lib/
  watchlist.js
  robinhoodWatchlist.js
  ...
