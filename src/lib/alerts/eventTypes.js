/**
 * Alert event catalog: stable event-type strings, severity levels, and the
 * Discord embed colors used to tint each severity. Pure data — no imports.
 */

export const EVENT_TYPES = {
  ALL_ACCOUNTS_LOCKED: "all-accounts-locked",
  BREAKER_OPEN: "breaker-open",
  BREAKER_RECOVERED: "breaker-recovered",
  PROXY_POOL_EXHAUSTED: "proxy-pool-exhausted",
  STRICTPROXY_VIOLATION: "strictproxy-violation",
  QUOTA_NEAR_LIMIT: "quota-near-limit",
  BUDGET_THRESHOLD: "budget-threshold",
  XRAY_NODE_DOWN: "xray-node-down",
  XRAY_ROTATION_FAILED: "xray-rotation-failed",
  TOTU_FETCH_FAILED: "totu-fetch-failed",
};

export const SEVERITY = { INFO: "info", WARN: "warn", CRITICAL: "critical" };

// Discord embed colors (integers) per severity.
export const SEVERITY_COLORS = { info: 0x3498db, warn: 0xe67e22, critical: 0xe74c3c };
