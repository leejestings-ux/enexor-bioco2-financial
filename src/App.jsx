import { useState, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend, Cell, ReferenceLine, ComposedChart, Area } from "recharts";

// ─── Design System (matched to TSA model exactly) ───
const COLORS = {
  bg: "#0b1121",
  panel: "#0f172a",
  card: "#131d32",
  cardBorder: "#1e293b",
  panelBorder: "#1e293b",
  accent: "#22c55e",
  accentDim: "#166534",
  accentGlow: "rgba(34,197,94,0.15)",
  amber: "#f59e0b",
  amberDim: "#92400e",
  red: "#ef4444",
  redDim: "#991b1b",
  cyan: "#06b6d4",
  purple: "#a78bfa",
  pink: "#f472b6",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  white: "#f8fafc",
};

const CHART_COLORS = {
  revenue_45Q: "#22c55e",
  revenue_VCM: "#06b6d4",
  revenue_offtake: "#f59e0b",
  revenue_comply: "#a78bfa",
  revenue_gh: "#10b981",
  opex: "#ef4444",
  capex: "#f97316",
  npv_line: "#22c55e",
};

// ─── Financial Model Engine ───
function runFinancialModel(inputs) {
  const {
    CO2_tpd, f_avail, E_spec, W_total,
    CR_45Q, f_45Q, T_45Q, Y_45Q_infl, r_CPI,
    P_VCM, f_VCM, r_VCM,
    P_offtake, f_offtake, r_offtake,
    P_comply, f_comply,
    C_vessels, C_adsorbent, C_HX, C_blower, C_valves,
    C_compressor, C_pretreat, C_controls, C_electrical, C_piping, C_container,
    f_install, f_engineering,
    P_elec, T_ads_life, C_valve_maint, C_cal, f_insurance, C_monitor, f_maint, r_OPEX,
    r_disc, T_project, Y_start, r_rev,
    N_units, LR, units_per_year,
  } = inputs;

  const warnings = [];

  // §4.1 Annual CO₂
  const CO2_tpy = CO2_tpd * 365 * f_avail;

  // §6.1 Single unit CAPEX
  const C_equipment = C_vessels + C_adsorbent + C_HX + C_blower + C_valves
    + C_compressor + C_pretreat + C_controls + C_electrical + C_piping + C_container;
  const CAPEX_unit1 = C_equipment * (1 + f_install + f_engineering);

  // §6.2 Fleet CAPEX with learning curve
  const lr_exp = Math.log(LR) / Math.log(2);
  const unit_capex = [];
  let capex_fleet_total = 0;
  for (let n = 1; n <= N_units; n++) {
    const c = CAPEX_unit1 * Math.pow(n, lr_exp);
    unit_capex.push(c);
    capex_fleet_total += c;
  }

  // Year-by-year simulation
  const years = [];
  let cumulative_dcf = 0;
  let payback_disc = null;
  let payback_simple = null;
  let cumulative_cf_undiscounted = 0;

  for (let y = 0; y <= T_project; y++) {
    const year = Y_start + y;

    // Fleet size
    const N_deployed = Math.min(N_units, Math.floor(y * units_per_year) + 1);
    const N_prev = y === 0 ? 0 : Math.min(N_units, Math.floor((y - 1) * units_per_year) + 1);
    const N_new = N_deployed - N_prev;

    const CO2_fleet = N_deployed * CO2_tpy;
    const is_45Q_eligible = true; // Enexor meets 12,500 t/yr at company fleet level

    // CAPEX this year
    let capex_year = 0;
    for (let n = N_prev + 1; n <= N_deployed; n++) {
      capex_year += unit_capex[n - 1] || 0;
    }

    // Cumulative CAPEX deployed
    let capex_cum = 0;
    for (let n = 0; n < N_deployed; n++) capex_cum += unit_capex[n] || 0;

    // §5 Revenue
    const escalation_rev = Math.pow(1 + r_rev / 100, y);

    // 45Q
    let R_45Q = 0;
    if (f_45Q > 0 && y <= T_45Q) {
      let cr = CR_45Q;
      if (year >= Y_45Q_infl) {
        cr = CR_45Q * Math.pow(1 + r_CPI / 100, year - Y_45Q_infl);
      }
      R_45Q = CO2_fleet * f_45Q * cr;
    }

    // VCM
    const P_VCM_y = P_VCM * Math.pow(1 + r_VCM / 100, y);
    const R_VCM = CO2_fleet * f_VCM * P_VCM_y;

    // Offtake
    const P_offtake_y = P_offtake * Math.pow(1 + r_offtake / 100, y);
    const R_offtake = CO2_fleet * f_offtake * P_offtake_y;

    // Compliance
    const R_comply = CO2_fleet * f_comply * P_comply * escalation_rev;

    const R_total = R_45Q + R_VCM + R_offtake + R_comply;

    // §7 OPEX
    const opex_escalation = Math.pow(1 + r_OPEX / 100, y);
    const C_elec = N_deployed * W_total * 8760 * f_avail * P_elec;
    const C_ads_replace = N_deployed * C_adsorbent / T_ads_life;
    const C_fixed = N_deployed * (C_valve_maint + C_cal + C_monitor);
    const C_insure = capex_cum * f_insurance / 100;
    const C_gen_maint = capex_cum * f_maint / 100;
    const OPEX = (C_elec + C_ads_replace + C_fixed + C_insure + C_gen_maint) * opex_escalation;

    // Cash flow
    const CF = R_total - OPEX - capex_year;
    const discount_factor = Math.pow(1 + r_disc / 100, y);
    const DCF = CF / discount_factor;
    cumulative_dcf += DCF;
    cumulative_cf_undiscounted += CF;

    if (payback_disc === null && cumulative_dcf >= 0 && y > 0) {
      payback_disc = y;
    }
    if (payback_simple === null && cumulative_cf_undiscounted >= 0 && y > 0) {
      payback_simple = y;
    }

    years.push({
      year, y, N_deployed, CO2_fleet, is_45Q_eligible,
      R_45Q, R_VCM, R_offtake, R_comply, R_total,
      OPEX, capex_year, CF, DCF, cumulative_dcf,
      R_per_ton: CO2_fleet > 0 ? R_total / CO2_fleet : 0,
      OPEX_per_ton: CO2_fleet > 0 ? OPEX / CO2_fleet : 0,
    });
  }

  // §8.2 NPV
  const NPV = cumulative_dcf;

  // §8.3 IRR — bisection
  let IRR = null;
  let lo = -0.5, hi = 2.0;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    let npv_test = 0;
    for (const yr of years) {
      npv_test += yr.CF / Math.pow(1 + mid, yr.y);
    }
    if (npv_test > 0) lo = mid; else hi = mid;
    if (Math.abs(hi - lo) < 0.0001) break;
  }
  if (Math.abs(lo - (-0.5)) > 0.01 && Math.abs(hi - 2.0) > 0.01) {
    IRR = (lo + hi) / 2;
  }

  // §8.6 LCCC
  const r = r_disc / 100;
  const N = T_project;
  const CRF = r > 0 ? (r * Math.pow(1 + r, N)) / (Math.pow(1 + r, N) - 1) : 1 / N;
  const CAPEX_annual = capex_fleet_total * CRF;
  const avg_OPEX = years.reduce((s, yr) => s + yr.OPEX, 0) / years.length;
  const LCCC = CO2_tpy > 0 && N_units > 0
    ? (CAPEX_annual + avg_OPEX) / (N_units * CO2_tpy)
    : 0;

  // §9.2 Breakeven credit price
  let CR_breakeven = null;
  {
    let b_lo = 0, b_hi = 300;
    for (let iter = 0; iter < 80; iter++) {
      const mid = (b_lo + b_hi) / 2;
      let npv_test = 0;
      for (const yr of years) {
        const R_45Q_test = yr.y <= T_45Q
          ? yr.CO2_fleet * f_45Q * mid : 0;
        const R_other = yr.R_VCM + yr.R_offtake + yr.R_comply;
        const cf = R_45Q_test + R_other - yr.OPEX - yr.capex_year;
        npv_test += cf / Math.pow(1 + r, yr.y);
      }
      if (npv_test < 0) b_lo = mid; else b_hi = mid;
      if (Math.abs(b_hi - b_lo) < 0.5) break;
    }
    CR_breakeven = (b_lo + b_hi) / 2;
  }

  // Revenue per ton (year 1)
  const yr1 = years[1] || years[0];
  const R_per_ton_45Q = yr1.CO2_fleet > 0 ? yr1.R_45Q / yr1.CO2_fleet : 0;
  const R_per_ton_VCM = yr1.CO2_fleet > 0 ? yr1.R_VCM / yr1.CO2_fleet : 0;
  const R_per_ton_offtake = yr1.CO2_fleet > 0 ? yr1.R_offtake / yr1.CO2_fleet : 0;
  const R_per_ton_comply = yr1.CO2_fleet > 0 ? yr1.R_comply / yr1.CO2_fleet : 0;

  // Warnings
  if (f_45Q + f_VCM + f_offtake + f_comply > 1.01) {
    warnings.push("Revenue allocation exceeds 100%. Reduce fractions.");
  }
  if (NPV < 0) {
    warnings.push(`Project NPV is negative at ${r_disc}% discount rate.`);
  }

  return {
    CO2_tpy, CO2_fleet_yr1: yr1.CO2_fleet,
    CAPEX_unit1, capex_fleet_total, unit_capex,
    NPV, IRR, payback_disc, payback_simple, LCCC, CR_breakeven,
    R_per_ton_45Q, R_per_ton_VCM, R_per_ton_offtake, R_per_ton_comply,
    years, warnings,
    yr1_revenue: yr1.R_total, yr1_opex: yr1.OPEX,
  };
}

// §9.1 Sensitivity tornado
function runSensitivity(baseInputs, baseNPV) {
  const params = [
    { key: "CR_45Q", label: "45Q Credit Rate", unit: "$/ton" },
    { key: "CO2_tpd", label: "CO₂ Capture Rate", unit: "t/day" },
    { key: "f_avail", label: "Availability", unit: "" },
    { key: "P_offtake", label: "Offtake Price", unit: "$/ton" },
    { key: "P_elec", label: "Electricity Rate", unit: "$/kWh" },
    { key: "r_disc", label: "Discount Rate", unit: "%" },
    { key: "N_units", label: "Fleet Size", unit: "units" },
    { key: "T_ads_life", label: "Adsorbent Life", unit: "years" },
  ];

  return params.map(p => {
    const lo_inputs = { ...baseInputs, [p.key]: baseInputs[p.key] * 0.8 };
    const hi_inputs = { ...baseInputs, [p.key]: baseInputs[p.key] * 1.2 };
    let npv_lo, npv_hi;
    try { npv_lo = runFinancialModel(lo_inputs).NPV; } catch { npv_lo = baseNPV; }
    try { npv_hi = runFinancialModel(hi_inputs).NPV; } catch { npv_hi = baseNPV; }
    return {
      ...p,
      npv_lo, npv_hi,
      delta: Math.abs(npv_hi - npv_lo),
      base_val: baseInputs[p.key],
    };
  }).sort((a, b) => b.delta - a.delta);
}

// ─── UI Components (matched to TSA model) ───

function SliderInput({ label, value, onChange, min, max, step, unit, decimals = 2, prefix = "" }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const handleClick = () => { setEditing(true); setEditVal(String(value)); };
  const handleBlur = () => {
    setEditing(false);
    const v = parseFloat(editVal);
    if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
  };
  const handleKey = (e) => { if (e.key === "Enter") handleBlur(); if (e.key === "Escape") setEditing(false); };
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.02em" }}>{label}</span>
        {editing ? (
          <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
            onBlur={handleBlur} onKeyDown={handleKey}
            style={{ width: 80, background: COLORS.bg, border: `1px solid ${COLORS.accent}`,
              color: COLORS.white, fontSize: 12, padding: "1px 4px", borderRadius: 3, textAlign: "right", outline: "none" }} />
        ) : (
          <span onClick={handleClick}
            style={{ fontSize: 12, color: COLORS.white, cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", borderBottom: `1px dashed ${COLORS.textMuted}` }}>
            {prefix}{typeof value === "number" ? value.toFixed(decimals) : value} {unit}
          </span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 4, appearance: "none", outline: "none",
          background: `linear-gradient(to right, ${COLORS.accent} 0%, ${COLORS.accent} ${pct}%, ${COLORS.panelBorder} ${pct}%, ${COLORS.panelBorder} 100%)`,
          borderRadius: 2, cursor: "pointer" }} />
    </div>
  );
}

function Accordion({ title, children, defaultOpen = false, icon }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 6, borderRadius: 6,
      border: `1px solid ${open ? COLORS.cardBorder : "transparent"}`,
      background: open ? COLORS.card : "transparent", transition: "all 0.2s" }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 10px", background: "none", border: "none", cursor: "pointer",
          color: open ? COLORS.accent : COLORS.textDim, fontSize: 12,
          fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <span>{icon} {title}</span>
        <span style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", fontSize: 10 }}>▼</span>
      </button>
      {open && <div style={{ padding: "2px 10px 10px" }}>{children}</div>}
    </div>
  );
}

function MetricCard({ label, value, unit, status, diagnostic, prefix = "" }) {
  const statusColor = status === "ok" ? COLORS.accent : status === "warn" ? COLORS.amber : status === "error" ? COLORS.red : COLORS.textDim;
  let displayValue;
  if (diagnostic) { displayValue = null; }
  else if (value === null || value === undefined) { displayValue = "—"; }
  else if (value === Infinity || value === -Infinity || isNaN(value)) { displayValue = "—"; }
  else if (typeof value === "number") {
    const abs = Math.abs(value);
    if (abs >= 1e6) displayValue = (value / 1e6).toFixed(1) + "M";
    else if (abs >= 1000) displayValue = Math.round(value).toLocaleString();
    else if (abs >= 100) displayValue = value.toFixed(1);
    else displayValue = value.toFixed(1);
  } else { displayValue = value; }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${status ? statusColor + "44" : COLORS.cardBorder}`,
      borderRadius: 8, padding: "14px 16px", position: "relative", overflow: "hidden", textAlign: "center" }}>
      {status && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: statusColor }} />}
      <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {diagnostic ? (
        <div style={{ fontSize: 11, color: COLORS.red, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.4, padding: "2px 0" }}>{diagnostic}</div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 4 }}>
          <span style={{ fontSize: 28, fontWeight: 700,
            color: status === "error" ? COLORS.red : status === "warn" ? COLORS.amber : COLORS.white,
            fontFamily: "'JetBrains Mono', monospace" }}>
            {prefix}{displayValue}
          </span>
          <span style={{ fontSize: 11, color: COLORS.textMuted }}>{unit}</span>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, value, onChange, note }) {
  return (
    <div style={{ marginBottom: 10, padding: "8px 10px", background: COLORS.bg, borderRadius: 6,
      border: `1px solid ${value ? COLORS.accent + "44" : COLORS.cardBorder}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: value ? COLORS.accent : COLORS.textDim }}>{label}</span>
        <div onClick={() => onChange(!value)}
          style={{ width: 36, height: 20, borderRadius: 10, cursor: "pointer", transition: "all 0.2s",
            background: value ? COLORS.accent : COLORS.panelBorder, position: "relative" }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, background: COLORS.white,
            position: "absolute", top: 2, left: value ? 18 : 2, transition: "left 0.2s" }} />
        </div>
      </div>
      {note && <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function DiagnosticHint({ text, color = "amber" }) {
  const c = color === "red" ? COLORS.red : COLORS.amber;
  return (
    <div style={{ fontSize: 10, color: c, background: c + "11", border: `1px solid ${c}33`,
      borderRadius: 4, padding: "5px 8px", marginBottom: 4, lineHeight: 1.5 }}>
      {text}
    </div>
  );
}

const fmt$ = (v) => v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(0)}`;

const customTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6,
      padding: "8px 12px", fontSize: 11, color: COLORS.text }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || p.fill, display: "flex", gap: 8, justifyContent: "space-between" }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(Math.abs(p.value))}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Scenario Presets ───
const SCENARIOS = {
  conservative: { CR_45Q: 50, P_VCM: 15, f_45Q: 0, f_offtake: 1.0, f_VCM: 0, P_offtake: 50, f_avail: 0.80, f_install: 0.25, P_elec: 0.12, N_units: 1, r_disc: 12 },
  base: { CR_45Q: 85, P_VCM: 40, f_45Q: 0.5, f_offtake: 0.5, f_VCM: 0, P_offtake: 70, f_avail: 0.90, f_install: 0.20, P_elec: 0.08, N_units: 4, r_disc: 10 },
  optimistic: { CR_45Q: 120, P_VCM: 80, f_45Q: 0.8, f_offtake: 0.2, f_VCM: 0, P_offtake: 100, f_avail: 0.95, f_install: 0.15, P_elec: 0.05, N_units: 10, r_disc: 8 },
};

// ─── Main App ───
export default function FinancialApp() {
  const [scenario, setScenario] = useState("base");
  const [inputs, setInputs] = useState({
    CO2_tpd: 3.5, f_avail: 0.90, E_spec: 1200, W_total: 65,
    CR_45Q: 85, f_45Q: 0.5, T_45Q: 12, Y_45Q_infl: 2027, r_CPI: 2.5,
    P_VCM: 40, f_VCM: 0.0, r_VCM: 3.0,
    P_offtake: 70, f_offtake: 0.5, r_offtake: 2.0,
    P_comply: 0, f_comply: 0.0,
    C_vessels: 60000, C_adsorbent: 20000, C_HX: 20000, C_blower: 15000, C_valves: 35000,
    C_compressor: 5000, C_pretreat: 15000, C_controls: 25000, C_electrical: 12000, C_piping: 18000, C_container: 12000,
    f_install: 0.20, f_engineering: 0.15,
    P_elec: 0.08, T_ads_life: 7, C_valve_maint: 5000, C_cal: 5000, f_insurance: 1.5, C_monitor: 3000, f_maint: 3.0, r_OPEX: 2.0,
    r_disc: 10, T_project: 20, Y_start: 2026, r_rev: 2.0,
    N_units: 4, LR: 0.85, units_per_year: 2,
  });

  const set = useCallback((key) => (val) => {
    setInputs((prev) => ({ ...prev, [key]: val }));
    setScenario("custom");
  }, []);

  const applyScenario = (name) => {
    setScenario(name);
    if (SCENARIOS[name]) setInputs(prev => ({ ...prev, ...SCENARIOS[name] }));
  };

  const results = useMemo(() => {
    try { return runFinancialModel(inputs); } catch (e) { return { error: e.message }; }
  }, [inputs]);

  const sensitivity = useMemo(() => {
    if (results.error) return [];
    return runSensitivity(inputs, results.NPV);
  }, [inputs, results.NPV, results.error]);

  // Cash flow chart data
  const cashFlowData = results.error ? [] : results.years.map(yr => ({
    name: yr.year, Revenue: yr.R_total, OPEX: -yr.OPEX,
    CAPEX: yr.capex_year > 0 ? -yr.capex_year : 0,
    CumNPV: yr.cumulative_dcf,
  }));

  // Revenue waterfall (year 1)
  const yr1 = results.error ? null : results.years[1] || results.years[0];
  const revenueData = yr1 ? [
    { name: "45Q", value: yr1.R_45Q, fill: CHART_COLORS.revenue_45Q },
    { name: "VCM", value: yr1.R_VCM, fill: CHART_COLORS.revenue_VCM },
    { name: "Offtake", value: yr1.R_offtake, fill: CHART_COLORS.revenue_offtake },
    { name: "Comply", value: yr1.R_comply, fill: CHART_COLORS.revenue_comply },
  ].filter(d => d.value > 0) : [];

  // Fleet learning curve
  const learningData = results.error ? [] : results.unit_capex.map((c, i) => ({
    unit: i + 1, capex: c, cumulative: results.unit_capex.slice(0, i + 1).reduce((s, v) => s + v, 0),
  }));

  // Tornado
  const tornadoData = sensitivity.slice(0, 8).map(s => ({
    name: s.label, lo: (s.npv_lo - results.NPV) / 1000, hi: (s.npv_hi - results.NPV) / 1000,
  }));

  if (results.error) {
    return <div style={{ padding: 40, color: COLORS.red, background: COLORS.bg, minHeight: "100vh" }}>
      <h2>Model Error</h2><p>{results.error}</p></div>;
  }

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, minHeight: "100vh",
      fontFamily: "'IBM Plex Sans', 'SF Pro Display', -apple-system, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* ─── Header ─── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 24px", borderBottom: `1px solid ${COLORS.panelBorder}`, background: COLORS.panel }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <svg width={32} height={32} viewBox="0 0 600 600" fill="none">
            <path d="M21.6,63.5h100.4c21.4,0,41.9,9,56.4,24.8l179.1,200.7-139.5,152.2c-14.5,15.8-35,24.9-56.5,24.9H60.2s162.8-177,162.8-177L21.6,63.5Z" fill="#fff"/>
            <path d="M375.2,269.6l145.1-158.3h-100.4c-21.4,0-41.9,9-56.4,24.8l-55,59.8,66.8,73.7Z" fill="#fff"/>
            <path d="M374.5,309.9l-67.7,73.9,113.7,127.9c14.5,15.8,35,24.9,56.5,24.9h101.4l-203.8-226.6Z" fill="#fff"/>
          </svg>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.white }}>BioCO₂ Financial Analysis</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, letterSpacing: "0.04em" }}>ENEXOR BIOENERGY · MCS v1.0 · POST-OBBBA</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["conservative", "base", "optimistic", "custom"].map(s => (
            <button key={s} onClick={() => applyScenario(s)}
              style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase",
                padding: "5px 12px", borderRadius: 4, cursor: "pointer", border: "none",
                background: scenario === s ? COLORS.accent : COLORS.card,
                color: scenario === s ? COLORS.bg : COLORS.textDim }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Three Column Layout ─── */}
      <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>

        {/* ─── LEFT: Inputs ─── */}
        <div style={{ width: 320, flexShrink: 0, borderRight: `1px solid ${COLORS.panelBorder}`,
          background: COLORS.panel, overflowY: "auto", maxHeight: "calc(100vh - 56px)", padding: "12px 14px" }}>

          <Accordion title="System Performance" icon="⬡" defaultOpen={true}>
            <SliderInput label="CO₂ Capture Rate" value={inputs.CO2_tpd} onChange={set("CO2_tpd")} min={0.5} max={10} step={0.1} unit="t/day" decimals={1} />
            <SliderInput label="Availability" value={inputs.f_avail} onChange={set("f_avail")} min={0.70} max={0.99} step={0.01} unit="" decimals={2} />
            <SliderInput label="Electrical Load" value={inputs.W_total} onChange={set("W_total")} min={10} max={200} step={1} unit="kW" decimals={0} />
          </Accordion>

          <Accordion title="45Q Tax Credit (OBBBA)" icon="◎" defaultOpen={true}>
            <SliderInput label="Credit Rate" value={inputs.CR_45Q} onChange={set("CR_45Q")} min={0} max={200} step={1} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="45Q Allocation" value={inputs.f_45Q} onChange={set("f_45Q")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="CPI Escalation" value={inputs.r_CPI} onChange={set("r_CPI")} min={0} max={5} step={0.1} unit="%" decimals={1} />
            <div style={{ fontSize: 9, color: COLORS.textMuted, padding: "4px 0", borderTop: `1px solid ${COLORS.cardBorder}`, marginTop: 4 }}>
              Utilization parity: $85/ton for ALL pathways (OBBBA §70522). Inflation adjusts from 2027.
            </div>
          </Accordion>


          <Accordion title="CO₂ Offtake & Markets" icon="⇌">
            <SliderInput label="Offtake Price" value={inputs.P_offtake} onChange={set("P_offtake")} min={0} max={200} step={1} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="Offtake Allocation" value={inputs.f_offtake} onChange={set("f_offtake")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="VCM Price" value={inputs.P_VCM} onChange={set("P_VCM")} min={0} max={200} step={1} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="VCM Allocation" value={inputs.f_VCM} onChange={set("f_VCM")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="Compliance Credit" value={inputs.P_comply} onChange={set("P_comply")} min={0} max={200} step={1} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="Compliance Allocation" value={inputs.f_comply} onChange={set("f_comply")} min={0} max={1} step={0.05} unit="" decimals={2} />
          </Accordion>

          <Accordion title="CAPEX — Equipment" icon="⚡">
            <SliderInput label="Adsorption Vessels" value={inputs.C_vessels} onChange={set("C_vessels")} min={20000} max={200000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Adsorbent (13X)" value={inputs.C_adsorbent} onChange={set("C_adsorbent")} min={5000} max={50000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Heat Exchanger" value={inputs.C_HX} onChange={set("C_HX")} min={5000} max={60000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Blower(s)" value={inputs.C_blower} onChange={set("C_blower")} min={5000} max={40000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Valves + Actuators" value={inputs.C_valves} onChange={set("C_valves")} min={10000} max={80000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="PLC + Instruments" value={inputs.C_controls} onChange={set("C_controls")} min={10000} max={50000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Pre-Treatment" value={inputs.C_pretreat} onChange={set("C_pretreat")} min={5000} max={60000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Electrical Panel" value={inputs.C_electrical} onChange={set("C_electrical")} min={5000} max={30000} step={500} unit="" decimals={0} prefix="$" />
            <SliderInput label="Piping + Manifolds" value={inputs.C_piping} onChange={set("C_piping")} min={8000} max={40000} step={1000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Container(s)" value={inputs.C_container} onChange={set("C_container")} min={5000} max={20000} step={500} unit="" decimals={0} prefix="$" />
            <SliderInput label="Installation Factor" value={inputs.f_install} onChange={set("f_install")} min={0.10} max={0.35} step={0.01} unit="" decimals={2} />
            <SliderInput label="Engineering Factor" value={inputs.f_engineering} onChange={set("f_engineering")} min={0.08} max={0.25} step={0.01} unit="" decimals={2} />
          </Accordion>

          <Accordion title="OPEX — Operating Costs" icon="⟐">
            <SliderInput label="Electricity Rate" value={inputs.P_elec} onChange={set("P_elec")} min={0.03} max={0.20} step={0.005} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Adsorbent Lifetime" value={inputs.T_ads_life} onChange={set("T_ads_life")} min={3} max={15} step={1} unit="yrs" decimals={0} />
            <SliderInput label="Valve Maintenance" value={inputs.C_valve_maint} onChange={set("C_valve_maint")} min={2000} max={15000} step={500} unit="/yr" decimals={0} prefix="$" />
            <SliderInput label="Instrument Cal." value={inputs.C_cal} onChange={set("C_cal")} min={2000} max={12000} step={500} unit="/yr" decimals={0} prefix="$" />
            <SliderInput label="Insurance (% CAPEX)" value={inputs.f_insurance} onChange={set("f_insurance")} min={0.5} max={3.0} step={0.1} unit="%" decimals={1} />
            <SliderInput label="Gen. Maint (% equip)" value={inputs.f_maint} onChange={set("f_maint")} min={1} max={5} step={0.5} unit="%" decimals={1} />
          </Accordion>

          <Accordion title="Financial Parameters" icon="◈">
            <SliderInput label="Discount Rate" value={inputs.r_disc} onChange={set("r_disc")} min={4} max={20} step={0.5} unit="%" decimals={1} />
            <SliderInput label="Project Life" value={inputs.T_project} onChange={set("T_project")} min={5} max={30} step={1} unit="yrs" decimals={0} />
          </Accordion>

          <Accordion title="Fleet Deployment" icon="▥">
            <SliderInput label="Number of Units" value={inputs.N_units} onChange={set("N_units")} min={1} max={50} step={1} unit="units" decimals={0} />
            <SliderInput label="Learning Rate" value={inputs.LR} onChange={set("LR")} min={0.75} max={0.95} step={0.01} unit="" decimals={2} />
            <SliderInput label="Deploy Rate" value={inputs.units_per_year} onChange={set("units_per_year")} min={1} max={10} step={1} unit="/yr" decimals={0} />
          </Accordion>
        </div>

        {/* ─── CENTER: Charts & Metrics ─── */}
        <div style={{ flex: 1, overflowY: "auto", maxHeight: "calc(100vh - 56px)", padding: "16px 20px" }}>

          {/* Metric Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 16 }}>
            <MetricCard label="NPV" value={results.NPV} unit="" prefix="$"
              status={results.NPV > 0 ? "ok" : "error"} />
            <MetricCard label="IRR" value={results.IRR !== null ? results.IRR * 100 : null} unit="%"
              status={results.IRR !== null ? (results.IRR * 100 > inputs.r_disc ? "ok" : results.IRR > 0 ? "warn" : "error") : undefined} />
            <MetricCard label="Payback" value={results.payback_disc || "> " + inputs.T_project} unit={results.payback_disc ? "yrs" : ""}
              status={results.payback_disc ? (results.payback_disc < 5 ? "ok" : results.payback_disc < 8 ? "warn" : "error") : "error"} />
            <MetricCard label="LCCC" value={results.LCCC} unit="$/ton" prefix="$"
              status={results.LCCC < 60 ? "ok" : results.LCCC < 100 ? "warn" : "error"} />
            <MetricCard label="Breakeven" value={results.CR_breakeven} unit="$/ton" prefix="$"
              status={results.CR_breakeven < 40 ? "ok" : results.CR_breakeven < 70 ? "warn" : "error"} />
            <MetricCard label="Fleet CO₂/yr" value={results.CO2_fleet_yr1} unit="t/yr" />
          </div>

          {/* Diagnostic Hints */}
          {results.warnings.map((w, i) => <DiagnosticHint key={i} text={w} color={w.includes("negative") ? "red" : "amber"} />)}

          {/* Revenue Waterfall */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Revenue Breakdown — Year 1 ({fmt$(yr1?.R_total || 0)} total)
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={revenueData} layout="vertical" margin={{ left: 60, right: 20 }}>
                <XAxis type="number" tickFormatter={(v) => fmt$(v)} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: COLORS.textDim, fontSize: 11 }} width={50} />
                <Tooltip content={customTooltip} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {revenueData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cash Flow Over Time */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Cash Flow & Cumulative NPV
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={cashFlowData} margin={{ left: 10, right: 10 }}>
                <CartesianGrid stroke={COLORS.panelBorder} strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis yAxisId="bar" tickFormatter={(v) => fmt$(v)} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis yAxisId="line" orientation="right" tickFormatter={(v) => fmt$(v)} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <Tooltip content={customTooltip} />
                <ReferenceLine yAxisId="line" y={0} stroke={COLORS.textMuted} strokeDasharray="4 4" />
                <Bar yAxisId="bar" dataKey="Revenue" fill={COLORS.accent} opacity={0.7} radius={[2, 2, 0, 0]} />
                <Bar yAxisId="bar" dataKey="OPEX" fill={COLORS.red} opacity={0.5} radius={[2, 2, 0, 0]} />
                <Bar yAxisId="bar" dataKey="CAPEX" fill={COLORS.amber} opacity={0.7} radius={[2, 2, 0, 0]} />
                <Line yAxisId="line" type="monotone" dataKey="CumNPV" stroke={COLORS.white} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Sensitivity Tornado */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Sensitivity Analysis — NPV Impact (±20% parameter variation)
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={tornadoData} layout="vertical" margin={{ left: 100, right: 20 }}>
                <XAxis type="number" tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}K`} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: COLORS.textDim, fontSize: 10 }} width={90} />
                <Tooltip formatter={(v) => `${v > 0 ? "+" : ""}${fmt$(v * 1000)}`} />
                <ReferenceLine x={0} stroke={COLORS.textMuted} />
                <Bar dataKey="lo" fill={COLORS.red} opacity={0.6} radius={[4, 0, 0, 4]} />
                <Bar dataKey="hi" fill={COLORS.accent} opacity={0.6} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Fleet Learning Curve */}
          {inputs.N_units > 1 && (
            <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
                Fleet CAPEX — Learning Curve ({(inputs.LR * 100).toFixed(0)}% rate)
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={learningData} margin={{ left: 10, right: 10 }}>
                  <CartesianGrid stroke={COLORS.panelBorder} strokeDasharray="3 3" />
                  <XAxis dataKey="unit" label={{ value: "Unit #", position: "bottom", fill: COLORS.textMuted, fontSize: 10 }}
                    tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                  <YAxis yAxisId="unit" tickFormatter={(v) => fmt$(v)} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                  <YAxis yAxisId="cum" orientation="right" tickFormatter={(v) => fmt$(v)} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                  <Tooltip formatter={(v) => fmt$(v)} />
                  <Bar yAxisId="unit" dataKey="capex" fill={COLORS.cyan} opacity={0.7} radius={[2, 2, 0, 0]} name="Unit CAPEX" />
                  <Line yAxisId="cum" type="monotone" dataKey="cumulative" stroke={COLORS.amber} strokeWidth={2} dot={false} name="Cumulative" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* ─── RIGHT: Cash Flow Table & Status ─── */}
        <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${COLORS.panelBorder}`,
          background: COLORS.panel, overflowY: "auto", maxHeight: "calc(100vh - 56px)", padding: "12px 14px" }}>

          {/* CAPEX Summary */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>CAPEX Summary</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>Unit 1</span>
              <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(results.CAPEX_unit1)}</span>
            </div>
            {inputs.N_units > 1 && <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>Unit {inputs.N_units}</span>
                <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(results.unit_capex[inputs.N_units - 1] || 0)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4 }}>
                <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>Fleet Total ({inputs.N_units} units)</span>
                <span style={{ fontSize: 12, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{fmt$(results.capex_fleet_total)}</span>
              </div>
            </>}
          </div>

          {/* 45Q Threshold Status */}

          {/* Revenue Per Ton */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Revenue per Ton (Year 1)</div>
            {[
              { label: "45Q Credit", value: results.R_per_ton_45Q, color: CHART_COLORS.revenue_45Q },
              { label: "VCM", value: results.R_per_ton_VCM, color: CHART_COLORS.revenue_VCM },
              { label: "Offtake", value: results.R_per_ton_offtake, color: CHART_COLORS.revenue_offtake },
              { label: "Compliance", value: results.R_per_ton_comply, color: CHART_COLORS.revenue_comply },
            ].filter(r => r.value > 0).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: 2, background: r.color }} />
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>{r.label}</span>
                </div>
                <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>
                  ${r.value.toFixed(0)}/t
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>Total</span>
              <span style={{ fontSize: 12, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                ${yr1 ? (yr1.R_per_ton).toFixed(0) : 0}/t
              </span>
            </div>
          </div>

          {/* Year-by-Year Table */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Cash Flow Table</div>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${COLORS.panelBorder}` }}>
                    {["Yr", "Units", "Rev", "OPEX", "CF"].map(h => (
                      <th key={h} style={{ padding: "3px 4px", color: COLORS.textDim, fontWeight: 600, textAlign: "right", fontSize: 9 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.years.map((yr, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${COLORS.bg}` }}>
                      <td style={{ padding: "2px 4px", color: COLORS.textMuted, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{yr.year}</td>
                      <td style={{ padding: "2px 4px", color: COLORS.textMuted, textAlign: "right" }}>{yr.N_deployed}</td>
                      <td style={{ padding: "2px 4px", color: COLORS.accent, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>
                        {yr.R_total >= 1000 ? `${(yr.R_total/1000).toFixed(0)}K` : yr.R_total.toFixed(0)}
                      </td>
                      <td style={{ padding: "2px 4px", color: COLORS.red, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>
                        {yr.OPEX >= 1000 ? `${(yr.OPEX/1000).toFixed(0)}K` : yr.OPEX.toFixed(0)}
                      </td>
                      <td style={{ padding: "2px 4px", color: yr.CF >= 0 ? COLORS.accent : COLORS.red, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                        {yr.CF >= 0 ? "" : "-"}{Math.abs(yr.CF) >= 1000 ? `${(Math.abs(yr.CF)/1000).toFixed(0)}K` : Math.abs(yr.CF).toFixed(0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 45Q Reference */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginTop: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              IRC §45Q — Post-OBBBA Reference
            </div>

            {[
              {
                title: "Authorizing Law",
                ref: "P.L. 119-21 §70522",
                text: "The One Big Beautiful Bill Act (OBBBA), signed July 4, 2025, preserved and expanded the §45Q Carbon Oxide Sequestration Credit originally established in the IRA (P.L. 117-169). OBBBA maintained the full credit structure while achieving utilization parity and adding FEOC restrictions."
              },
              {
                title: "Point Source Credit — All Pathways at Parity",
                ref: "IRC §45Q(a)(3)(A), OBBBA §70522",
                text: "Post-OBBBA, all point source pathways — geologic sequestration, enhanced oil recovery, and utilization — qualify at the same $85/ton rate with PWA compliance. Prior law set utilization at $60/ton. This 42% increase eliminates the economic penalty for productive use of captured CO₂ and applies to carbon oxide captured using equipment placed in service after the IRA effective date."
              },
              {
                title: "Inflation Adjustment",
                ref: "IRC §45Q(b)(1)(A)",
                text: "Credit amounts adjust annually for inflation starting in calendar year 2027 using the GDP implicit price deflator, with 2025 as the base year. The adjustment is cumulative — each year's credit reflects total inflation from the 2025 baseline, not just the prior year's change. This protects real credit value over the 12-year credit period."
              },
              {
                title: "Transferability",
                ref: "IRC §6418",
                text: "Credit holders may transfer all or a portion of §45Q credits to unrelated taxpayers for cash consideration. The transfer payment is not includible in the transferor's gross income and is not deductible by the transferee. Credits typically transfer at 90–95¢ per dollar of face value. This provision was preserved permanently by OBBBA and enables project developers without sufficient tax liability to monetize credits immediately."
              },
              {
                title: "Direct Pay (Elective Payment)",
                ref: "IRC §6417",
                text: "Tax-exempt entities (municipalities, tribal governments, rural electric co-ops, and certain tax-exempt organizations) may elect to treat §45Q credits as overpayments of tax, receiving direct cash payment from the IRS. For taxable entities, direct pay is available only for the first 5 tax years after equipment is placed in service. OBBBA preserved direct pay — it was not repealed. Entities must make the election on a timely-filed return for the tax year."
              },
              {
                title: "FEOC — Significant Foreign Entity (SFE) Exclusion",
                ref: "OBBBA §70522",
                text: "No §45Q credit is allowed if the taxpayer is a Significant Foreign Entity of Concern (SFE) or if the carbon capture equipment is manufactured, assembled, or produced by an SFE. This restriction applies to tax years beginning after July 4, 2025. SFEs include entities owned by, controlled by, or subject to the jurisdiction of foreign entities of concern as defined in 42 USC §18741(a)(5), which targets China, Russia, North Korea, and Iran. Separately, Foreign Interested Entities (FIEs) — entities with 10%+ foreign-of-concern ownership — are excluded for tax years beginning after July 4, 2027."
              },
            ].map((item, i) => (
              <div key={i} style={{ marginBottom: i < 5 ? 10 : 0, paddingBottom: i < 5 ? 10 : 0,
                borderBottom: i < 5 ? `1px solid ${COLORS.bg}` : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>{item.title}</span>
                </div>
                <div style={{ fontSize: 9, color: COLORS.cyan, marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                  {item.ref}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  {item.text}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 10, padding: "6px 8px", background: COLORS.bg, borderRadius: 4, fontSize: 9, color: COLORS.textMuted, lineHeight: 1.5 }}>
              <span style={{ color: COLORS.amber }}>Note:</span> This summary is for reference only and does not constitute legal or tax advice. Credit eligibility requires compliance with all applicable IRS regulations including prevailing wage & apprenticeship (PWA) requirements, lifecycle greenhouse gas analysis, adequate security measures for geologic sequestration, and timely filing of Form 8933. Consult qualified tax counsel for project-specific guidance.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
