/**
 * NewAPI (tokenrouter / totu-ai) per-account balance.
 *
 * TokenRouter and TOTU are both NewAPI gateways. The account balance is not
 * queryable with the sk- inference key — it requires the dashboard login
 * session token (stored server-side in providerSpecificData.loginToken):
 *   GET <base>/api/user/self  with  Authorization: Bearer <login token>
 * Response: data.quota (quota units), data.used_quota.
 *   USD = quota / quota_per_unit * price
 *
 * quota_per_unit is 500000 for both providers; TokenRouter price is 7,
 * TOTU price is 0.5. A connection without a stored login token cannot query
 * the balance at all — reflect that honestly instead of making a network call.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * @param {object} opts
 * @param {string} opts.baseUrl - NewAPI dashboard origin, e.g. "https://api.tokenrouter.com"
 * @param {number} opts.price - USD per quota_per_unit
 * @param {number} [opts.quotaPerUnit=500000]
 * @param {string} opts.providerName - Display name, e.g. "TokenRouter"
 * @param {string|null|undefined} [opts.loginToken] - Dashboard session token / PAT
 * @param {object|null} [opts.proxyOptions]
 */
export async function getNewApiBalanceUsage({
  baseUrl,
  price,
  quotaPerUnit = 500000,
  providerName,
  loginToken,
  proxyOptions,
}) {
  if (!loginToken || typeof loginToken !== "string" || !loginToken.trim()) {
    return {
      plan: providerName,
      message: `${providerName}: no dashboard login token stored. Manual API keys cannot query balance — use Lấy acc (auto-fetch) to add an account and view the remaining $ balance.`,
    };
  }

  try {
    const response = await proxyAwareFetch(
      `${baseUrl}/api/user/self`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${loginToken.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: providerName,
        message: `${providerName} login token expired or invalid. Re-add the account (Lấy acc).`,
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: providerName,
        message: `${providerName} balance API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const json = await response.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return {
        plan: providerName,
        message: `${providerName} balance response was not JSON.`,
      };
    }

    const data = json.data ?? json;
    const quota = Math.max(0, toFiniteNumber(data.quota, 0));
    const usedQuota = Math.max(0, toFiniteNumber(data.used_quota, 0));
    const usd = (n) => (n / quotaPerUnit) * price;

    // Never emit an absolute `remaining` — QuotaTable / getRemainingPercentage
    // treat `remaining` as a 0–100 percentage (default parseQuotaData branch).
    return {
      plan: providerName,
      quotas: {
        "Remaining ($)": {
          used: 0,
          total: round2(usd(quota)),
          remainingPercentage: quota > 0 ? 100 : 0,
          resetAt: null,
          unlimited: false,
        },
        "Used ($)": {
          used: round2(usd(usedQuota)),
          total: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
      },
    };
  } catch (error) {
    return {
      plan: providerName,
      message: `${providerName} balance error: ${error.message}`,
    };
  }
}