// -----------------------------------------------------------------------------
// HELIUS HOLDER COUNT
// -----------------------------------------------------------------------------
//
// Gets the number of unique wallets holding a token.
//
// IMPORTANT:
// This is intentionally NOT part of the normal market-scan flow.
// It should only be called for tokens that already passed the radar filters.
//
// Helius getTokenAccounts supports filtering by mint and pagination.
// We count unique owners rather than token accounts because one wallet can
// have multiple token accounts for the same mint.
// -----------------------------------------------------------------------------

const holderCountCache = new Map();

const HOLDER_COUNT_CACHE_MS = Math.max(
  60000,
  Number(
    process.env.HOLDER_COUNT_CACHE_MS ||
    600000
  )
);

const HOLDER_LOOKUP_MAX_PAGES = Math.max(
  1,
  Number(
    process.env.HOLDER_LOOKUP_MAX_PAGES ||
    25
  )
);

let lastHolder429LogAt = 0;

async function getTokenHolderCount(
  address,
  apiKey
) {
  if (
    !address ||
    !apiKey
  ) {
    return null;
  }

  const cacheKey =
    `holders:${address}`;

  const cached =
    cacheGet(
      holderCountCache,
      cacheKey,
      HOLDER_COUNT_CACHE_MS
    );

  if (
    cached !== undefined
  ) {
    return cached;
  }

  const rpcUrl =
    heliusRpcUrl(apiKey);

  if (!rpcUrl) {
    return null;
  }

  const owners =
    new Set();

  let page = 1;

  try {
    while (
      page <=
      HOLDER_LOOKUP_MAX_PAGES
    ) {
      const body = {
        jsonrpc: "2.0",

        id:
          `holders-${Date.now()}-` +
          `${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        method:
          "getTokenAccounts",

        params: {
          mint:
            address,

          page,

          limit: 1000,

          options: {
            showZeroBalance:
              false,
          },
        },
      };

      const response =
        await requestJson(
          rpcUrl,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify(
                body
              ),
          },

          15000,

          0
        );

      if (
        response?.error
      ) {
        const errorCode =
          Number(
            response.error.code
          );

        const message =
          String(
            response.error.message ||
            ""
          );

        if (
          errorCode === -32005 ||
          /rate.?limit|too many requests|limit exceeded/i.test(
            message
          )
        ) {
          if (
            Date.now() -
              lastHolder429LogAt >
            10000
          ) {
            console.warn(
              `[holders] Helius getTokenAccounts rate limited.`
            );

            lastHolder429LogAt =
              Date.now();
          }
        }

        return null;
      }

      const result =
        response?.result;

      const accounts =
        Array.isArray(
          result?.token_accounts
        )
          ? result.token_accounts
          : [];

      if (
        accounts.length === 0
      ) {
        break;
      }

      for (
        const account of accounts
      ) {
        const owner =
          account?.owner;

        const amount =
          Number(
            account?.amount
          );

        /*
         * Only count wallets that actually hold
         * a non-zero amount.
         */
        if (
          owner &&
          Number.isFinite(amount) &&
          amount > 0
        ) {
          owners.add(owner);
        }
      }

      /*
       * If fewer than 1000 accounts came back,
       * there should be no more pages.
       */
      if (
        accounts.length < 1000
      ) {
        break;
      }

      page++;
    }

    /*
     * If the token is larger than our safety limit,
     * don't return a misleading partial number.
     */
    if (
      page >
      HOLDER_LOOKUP_MAX_PAGES &&
      owners.size >=
        HOLDER_LOOKUP_MAX_PAGES * 1000
    ) {
      console.warn(
        `[holders] ${address}: holder count exceeded lookup safety limit.`
      );

      return null;
    }

    const count =
      owners.size;

    cacheSet(
      holderCountCache,
      cacheKey,
      count,
      500
    );

    return count;
  } catch (err) {
    console.warn(
      `[holders] Holder lookup failed for ${address}: ${err.message}`
    );

    return null;
  }
}
