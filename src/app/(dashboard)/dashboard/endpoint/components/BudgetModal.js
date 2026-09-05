"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Select, Toggle } from "@/shared/components";
import { BUDGET_TYPE_OPTIONS, BUDGET_WINDOW_OPTIONS } from "../endpointConstants";

/** Per-key budget editor (PUT /api/keys/{id} — budget fields only) */
export default function BudgetModal({ isOpen, keyData, onClose, onSaved }) {
  const [budgetType, setBudgetType] = useState("off");
  const [budgetLimit, setBudgetLimit] = useState("");
  const [budgetWindow, setBudgetWindow] = useState("daily");
  const [softThresholdPct, setSoftThresholdPct] = useState("80");
  const [hardBlock, setHardBlock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Prefill from the key row each time the modal opens.
  useEffect(() => {
    if (!isOpen || !keyData) return;
    setBudgetType(keyData.budgetType || "off");
    setBudgetLimit(keyData.budgetLimit > 0 ? String(keyData.budgetLimit) : "");
    setBudgetWindow(keyData.budgetWindow === "monthly" ? "monthly" : "daily");
    setSoftThresholdPct(String(keyData.softThresholdPct || 80));
    setHardBlock(!!keyData.hardBlock);
    setError(null);
  }, [isOpen, keyData]);

  const limitNum = Number(budgetLimit);
  const pctNum = Number(softThresholdPct);
  const limitInvalid = budgetType !== "off" && !(Number.isFinite(limitNum) && limitNum > 0);
  const pctInvalid = !(Number.isInteger(pctNum) && pctNum >= 1 && pctNum <= 100);

  const handleSave = async () => {
    if (!keyData || limitInvalid || pctInvalid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/keys/${keyData.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budgetType,
          budgetLimit: budgetType === "off" ? 0 : limitNum,
          budgetWindow,
          softThresholdPct: pctNum,
          hardBlock,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onSaved();
      } else {
        setError(data.error || "Failed to save budget");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!keyData) return null;

  return (
    <Modal
      isOpen={isOpen}
      title={`Budget — ${keyData.name}`}
      onClose={() => { if (!saving) onClose(); }}
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Budget Type"
          value={budgetType}
          onChange={(e) => setBudgetType(e.target.value)}
          options={BUDGET_TYPE_OPTIONS}
        />
        {budgetType !== "off" && (
          <Input
            label={`Budget Limit (${budgetType === "usd" ? "USD" : "Tokens"})`}
            type="number"
            value={budgetLimit}
            onChange={(e) => setBudgetLimit(e.target.value)}
            placeholder={budgetType === "usd" ? "5" : "1000000"}
            error={limitInvalid ? "Enter a number greater than 0" : undefined}
          />
        )}
        <Select
          label="Reset Window"
          value={budgetWindow}
          onChange={(e) => setBudgetWindow(e.target.value)}
          options={BUDGET_WINDOW_OPTIONS}
        />
        <Input
          label="Soft Threshold (%)"
          type="number"
          value={softThresholdPct}
          onChange={(e) => setSoftThresholdPct(e.target.value)}
          error={pctInvalid ? "Enter an integer between 1 and 100" : undefined}
          hint="Alert when this % of the budget is used"
        />
        <Toggle
          checked={hardBlock}
          onChange={(v) => setHardBlock(v)}
          label="Hard block"
          description="Reject requests once the budget is exceeded"
        />

        <p className="text-xs text-text-muted">
          Budgets apply only when Require API Key is enabled.
        </p>
        <p className="text-xs text-text-muted">
          USD budgets count only models with pricing configured — unpriced models cost $0 and under-count. Token budgets are exact.
        </p>

        {error && (
          <p className="text-xs text-red-500 break-words">{error}</p>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={saving || limitInvalid || pctInvalid}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BudgetModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  keyData: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    budgetType: PropTypes.string,
    budgetLimit: PropTypes.number,
    budgetWindow: PropTypes.string,
    softThresholdPct: PropTypes.number,
    hardBlock: PropTypes.bool,
  }),
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
