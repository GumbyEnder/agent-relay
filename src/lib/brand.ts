/** Brand configuration — BeeZilla skin is opt-in via BZ_BRAND env var. */

export const BZ_BRAND =
  typeof process !== "undefined"
    ? process.env.BZ_BRAND === "beezilla"
    : import.meta.env.VITE_BZ_BRAND === "beezilla";
