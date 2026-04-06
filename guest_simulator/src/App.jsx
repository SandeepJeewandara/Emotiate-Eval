import { useEffect, useRef, useState } from "react";
import guestProfilesData from "../data/guest_profiles.json";
import storedResultsData from "../data/eval_results_store.json";
import "./App.css";

const EMOTION_COLORS = {
  FRUSTRATED: { bg: "#faece7", text: "#993c1d", border: "#d85a30" },
  HESITANT: { bg: "#faeeda", text: "#854f0b", border: "#ef9f27" },
  NEUTRAL: { bg: "#f1efe8", text: "#444441", border: "#888780" },
  INTERESTED: { bg: "#e6f1fb", text: "#185fa5", border: "#378add" },
  SATISFIED: { bg: "#eaf3de", text: "#3b6d11", border: "#639922" },
  EXCITED: { bg: "#eeedfe", text: "#3c3489", border: "#7f77dd" },
};

const DISPLAY_EMOTIONS = ["FRUSTRATED", "HESITANT", "NEUTRAL", "INTERESTED", "SATISFIED", "EXCITED"];
const RESULTS_STORAGE_KEY = "emotiate-saved-results";
const RESULTS_STORAGE_ENDPOINT = "/api/storage/results";
const RESULTS_STORAGE_FILE = "data/eval_results_store.json";
const GROQ_LIMITS = {
  rpm: 30,
  rpd: 1000,
  tpm: 8000,
  tpd: 200000,
  directCallsPerGuestReply: 1,
  backendCallsPerGuestMessage: 2,
  safetyRatio: 0.8,
  guestMaxTokens: 120,
  guestRecoveryMaxTokens: 160,
  maxGuestHistoryMessages: 6,
  maxGuestReplyRepairs: 2,
  compactGuestHistoryMessages: 2,
  compactMessageChars: 280,
  compactSystemPromptChars: 1200,
};
const SAFE_GROQ_UNITS_PER_MINUTE = Math.max(1, Math.floor(GROQ_LIMITS.rpm * GROQ_LIMITS.safetyRatio));
const SAFE_DIRECT_GROQ_GAP_MS = Math.ceil(60000 / SAFE_GROQ_UNITS_PER_MINUTE);
const SAFE_ROUND_GAP_MS = Math.ceil(
  (60000 * (GROQ_LIMITS.directCallsPerGuestReply + GROQ_LIMITS.backendCallsPerGuestMessage))
  / SAFE_GROQ_UNITS_PER_MINUTE,
);
const SAFE_MAX_ROUNDS = 10;

const DEFAULT_SETTINGS = {
  backendUrl: "http://localhost:8080",
  groqApiKey: "",
  groqGapMs: SAFE_DIRECT_GROQ_GAP_MS,
  groqModel: "llama-3.1-8b-instant",
  maxRetries: 6,
  messageGapMs: SAFE_ROUND_GAP_MS,
  delayMs: 30000,
  maxRounds: SAFE_MAX_ROUNDS,
  pollMs: 3000,
  pollTimeout: 45000,
};

const SETTINGS_FIELDS = [
  { label: "Backend URL", key: "backendUrl" },
  { label: "Groq API key", key: "groqApiKey", type: "password" },
  { label: "Groq model", key: "groqModel" },
  { label: "Min gap between Groq calls (ms)", key: "groqGapMs", type: "number" },
  { label: "Max Groq retries on 429", key: "maxRetries", type: "number" },
  { label: "Message gap (ms)", key: "messageGapMs", type: "number" },
  { label: "Delay between agents (ms)", key: "delayMs", type: "number" },
  { label: "Max rounds per session", key: "maxRounds", type: "number" },
  { label: "Poll interval (ms)", key: "pollMs", type: "number" },
  { label: "Poll timeout (ms)", key: "pollTimeout", type: "number" },
];

const GUEST_PROFILES = guestProfilesData.map((profile, index) => ({
  id: profile.id || index + 1,
  fullName: profile.fullName || `Guest ${index + 1}`,
  username: profile.username || `guest${index + 1}`,
  email: profile.email || `guest${index + 1}@example.com`,
  contactNumber: profile.contactNumber || "N/A",
  checkInDate: profile.checkInDate,
  checkOutDate: profile.checkOutDate,
  bookingDetails: {
    stayNights: Number(profile.bookingDetails?.stayNights || 1),
    guestCount: Number(profile.bookingDetails?.guestCount || 1),
    travelPurpose: profile.bookingDetails?.travelPurpose || "leisure",
  },
  budgetProfile: {
    currency: profile.budgetProfile?.currency || "LKR",
    maxBudgetPerNight: Math.round(Number(profile.budgetProfile?.maxBudgetPerNight || 0)),
  },
  priceAdoption: normalizePriceAdoption(profile.priceAdoption),
  emotionProfile: {
    primaryEmotion: profile.emotionProfile?.primaryEmotion || "NEUTRAL",
    description: profile.emotionProfile?.description || "calm and evaluating options",
    acceptanceLikelihood: Number(profile.emotionProfile?.acceptanceLikelihood || 0),
    urgencyLevel: profile.emotionProfile?.urgencyLevel || "medium",
  },
  negotiationProfile: {
    openingIntent: profile.negotiationProfile?.openingIntent || "asks about package options",
    likelyBehavior: profile.negotiationProfile?.likelyBehavior || "compares value before committing",
    specialInstruction: profile.negotiationProfile?.specialInstruction || "",
    walkAwayReason: profile.negotiationProfile?.walkAwayReason || "price exceeds budget",
  },
}));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatCurrency(amount, currency = "LKR") {
  return `${Math.round(Number(amount || 0)).toLocaleString()} ${currency}`;
}

function formatDateLabel(dateString) {
  const parsed = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatStay(profile) {
  return `${formatDateLabel(profile.checkInDate)} - ${formatDateLabel(profile.checkOutDate)}`;
}

function normalizePriceAdoption(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized.startsWith("Y") ? "YES" : "NO";
}

function shouldConfirmImmediately(profile) {
  const acceptanceLikelihood = Number(profile.emotionProfile?.acceptanceLikelihood || 0);
  const urgency = String(profile.emotionProfile?.urgencyLevel || "medium").toLowerCase();

  if (acceptanceLikelihood >= 1) return true;
  if (acceptanceLikelihood >= 0.8) return true;
  if (acceptanceLikelihood >= 0.65) return true;
  if (acceptanceLikelihood >= 0.5) return urgency !== "low";
  return false;
}

function trimConversationHistory(messages, maxMessages = GROQ_LIMITS.maxGuestHistoryMessages) {
  return messages.slice(-maxMessages);
}

function trimText(text, maxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function compactConversationHistory(messages) {
  return trimConversationHistory(messages, GROQ_LIMITS.compactGuestHistoryMessages).map(message => ({
    ...message,
    content: trimText(message.content, GROQ_LIMITS.compactMessageChars),
  }));
}

function compactSystemPrompt(prompt) {
  return trimText(prompt, GROQ_LIMITS.compactSystemPromptChars);
}

function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .join("")
    .trim();
}

function getLastWord(text) {
  return text
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z]/g, "") || "";
}

function isDigitsOnlyReply(text) {
  return /^\d+$/.test(String(text || "").trim());
}

function looksIncompleteGuestReply(text, finishReason) {
  if (!text) return true;
  if (finishReason === "length") return true;
  const trimmed = text.trim();
  if (isDigitsOnlyReply(trimmed)) return false;
  if (/[.!?]"?$/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length <= 2) return true;
  const trailingWords = new Set([
    "a", "an", "and", "around", "at", "bring", "but", "could",
    "for", "if", "like", "or", "please", "the", "to", "with",
  ]);
  return trailingWords.has(getLastWord(trimmed));
}

function normalizePackageName(name) {
  return String(name || "")
    .replace(/\*\*/g, "")
    .replace(/[""]/g, "\"")
    .replace(/['']/g, "'")
    .trim();
}

// Keys that are structural JSON field names and must never be treated as package names
const STRUCTURAL_JSON_KEYS = new Set([
  "availablepackages", "packages", "data", "items", "results", "list",
  "options", "offers", "rooms", "records", "entries", "payload",
]);

function isStructuralKey(name) {
  return STRUCTURAL_JSON_KEYS.has(String(name || "").toLowerCase().replace(/\s+/g, ""));
}

function collectPackageCandidates(source, list = []) {
  if (!source) return list;
  if (Array.isArray(source)) {
    source.forEach(item => collectPackageCandidates(item, list));
    return list;
  }
  if (typeof source === "object") {
    // FIX: read packageName first â€” this is the explicit, reliable field set by the backend
    const possibleName = source.packageName || source.name || source.title || source.package;
    const priceValue = Number(
      source.lowerBoundPrice     // FIX: prefer lowerBoundPrice which is the actual negotiable floor
      || source.pricePerNight
      || source.nightlyRate
      || source.perNight
      || source.price
      || source.totalPrice
      || source.total,
    );

    // FIX: only push if the candidate name is not a structural JSON key
    if (possibleName && !isStructuralKey(possibleName)) {
      list.push({
        name: normalizePackageName(possibleName),
        price: Number.isFinite(priceValue) ? priceValue : null,
      });
    }

    // Recurse into child values but skip array-wrapper keys to avoid picking them up
    Object.entries(source).forEach(([key, value]) => {
      if (!isStructuralKey(key)) {
        collectPackageCandidates(value, list);
      } else if (Array.isArray(value)) {
        // Still recurse into structural arrays so nested package objects are found
        value.forEach(item => collectPackageCandidates(item, list));
      }
    });
    return list;
  }
  if (typeof source === "string") {
    const quotedMatches = source.match(/[""]([^""]{4,80})[""]/g) || [];
    quotedMatches.forEach(match => {
      const name = normalizePackageName(match.slice(1, -1));
      if (/package|suite|retreat|experience|escape|stay|offer/i.test(name) && !isStructuralKey(name)) {
        list.push({ name, price: null });
      }
    });
    const boldMatches = [...source.matchAll(/\*\*([^*]{4,80})\*\*/g)];
    boldMatches.forEach(([, raw]) => {
      const name = normalizePackageName(raw);
      if (/package|suite|retreat|experience|escape|stay|offer/i.test(name) && !isStructuralKey(name)) {
        list.push({ name, price: null });
      }
    });
  }
  return list;
}

function dedupePackageCandidates(candidates) {
  const seen = new Map();
  candidates.forEach(candidate => {
    const key = candidate.name.toLowerCase();
    if (!candidate.name) return;
    if (!seen.has(key)) {
      seen.set(key, candidate);
      return;
    }
    const existing = seen.get(key);
    if (existing.price == null && candidate.price != null) {
      seen.set(key, candidate);
    }
  });
  return [...seen.values()];
}

function scorePackageName(name) {
  const lower = name.toLowerCase();
  let score = 0;
  if (/(budget|basic|standard|classic|simple|compact|essential)/.test(lower)) score -= 5;
  if (/(deluxe|premium|royal|luxury|executive|signature)/.test(lower)) score += 5;
  if (/(suite|retreat|experience)/.test(lower)) score += 3;
  return score;
}

function pickPackageOption(agentMessage) {
  const candidates = dedupePackageCandidates([
    ...collectPackageCandidates(agentMessage?.metadata),
    ...collectPackageCandidates(agentMessage?.content),
  ]);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((left, right) => {
    const leftPrice = left.price ?? Number.POSITIVE_INFINITY;
    const rightPrice = right.price ?? Number.POSITIVE_INFINITY;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    const scoreDelta = scorePackageName(left.name) - scorePackageName(right.name);
    if (scoreDelta !== 0) return scoreDelta;
    return left.name.localeCompare(right.name);
  });
  return sorted[0];
}

function findMentionedPackages(text) {
  return dedupePackageCandidates(collectPackageCandidates(text)).map(candidate => candidate.name);
}

function extractTargetNightlyRate(text) {
  const matches = [...String(text || "").matchAll(/(?:lkr\s*)?([\d,]{2,})/gi)];
  if (matches.length === 0) return null;
  const numeric = Number(matches[matches.length - 1][1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function enforceSelectedPackageReply(text, selectedPackageName) {
  if (!selectedPackageName) return text;

  const mentionedPackages = findMentionedPackages(text);
  const selectedLower = selectedPackageName.toLowerCase();
  const switchedPackage = mentionedPackages.some(name => name.toLowerCase() !== selectedLower);

  if (!switchedPackage) return text;

  const targetRate = extractTargetNightlyRate(text);
  if (targetRate != null) {
    return `I'd like to continue with the "${selectedPackageName}" package. Could you bring the nightly rate closer to LKR ${targetRate.toLocaleString()}?`;
  }

  return `I'd like to stay with the "${selectedPackageName}" package. Could you see if there's any more flexibility on the price?`;
}

function loadSavedResults() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RESULTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(({ responseTimes, ...result }) => result)
      : [];
  } catch {
    return [];
  }
}

function getBundledStoredResults() {
  return Array.isArray(storedResultsData?.sessions) ? storedResultsData.sessions : [];
}

function getBundledStoredRange(totalProfiles) {
  const start = clamp(Number(storedResultsData?.batchRange?.start) || 1, 1, totalProfiles);
  const end = clamp(
    Number(storedResultsData?.batchRange?.end) || Math.max(start, Math.min(10, totalProfiles)),
    start,
    totalProfiles,
  );

  return { start, end };
}

function summarizeResults(results) {
  const totalSessions = results.length;
  const sessionsWithoutErrors = results.filter(result => result.success).length;
  const confirmedBookings = results.filter(result => result.converted).length;
  const responseTimes = results.filter(result => result.avgRT > 0).map(result => result.avgRT);
  const avgResponseTimeMs = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
    : 0;

  return {
    totalSessions,
    sessionsWithoutErrors,
    nsr: totalSessions > 0 ? `${((sessionsWithoutErrors / totalSessions) * 100).toFixed(2)}%` : "0.00%",
    confirmedBookings,
    cr: totalSessions > 0 ? `${((confirmedBookings / totalSessions) * 100).toFixed(2)}%` : "0.00%",
    avgResponseTimeMs,
  };
}

function buildStoredResultsPayload(results, rangeStart, rangeEnd) {
  return {
    updatedAt: new Date().toISOString(),
    file: RESULTS_STORAGE_FILE,
    batchRange: { start: rangeStart, end: rangeEnd },
    summary: summarizeResults(results),
    sessions: results,
  };
}

async function fetchStoredResultsPayload() {
  const response = await fetch(RESULTS_STORAGE_ENDPOINT);
  if (!response.ok) throw new Error(`GET ${RESULTS_STORAGE_ENDPOINT} -> ${response.status}`);
  return response.json();
}

async function saveStoredResultsPayload(payload) {
  const response = await fetch(RESULTS_STORAGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`POST ${RESULTS_STORAGE_ENDPOINT} -> ${response.status}`);
  }

  return response.json();
}

function Button({ variant = "secondary", children, className = "", ...props }) {
  return (
    <button className={`button button-${variant} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

function Field({ label, children, className = "" }) {
  return (
    <label className={`field-group ${className}`.trim()}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function EmotionBadge({ emotion, compact = false }) {
  const colors = EMOTION_COLORS[emotion] || EMOTION_COLORS.NEUTRAL;
  return (
    <span
      className={`emotion-badge ${compact ? "compact" : ""}`.trim()}
      style={{
        "--badge-bg": colors.bg,
        "--badge-text": colors.text,
        "--badge-border": colors.border,
      }}
    >
      {compact ? emotion.slice(0, 4) : emotion}
    </span>
  );
}

function Panel({ title, subtitle, right, children, className = "" }) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || subtitle || right) && (
        <div className="panel-header">
          <div>
            {title && <div className="panel-title">{title}</div>}
            {subtitle && <div className="panel-subtitle">{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function MetricCard({ label, value, sub, accent }) {
  return (
    <div className="metric-card" style={{ "--metric-accent": accent }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-sub">{sub}</div>
    </div>
  );
}

function MessageBubble({ message }) {
  return (
    <div className={`message-row is-${message.side}`}>
      <div className={`message-bubble ${message.side}`}>
        <div className="message-meta">
          <span>{message.side === "guest" ? "Simulated guest" : "EMOTIATE agent"}</span>
          {message.emotion && <EmotionBadge emotion={message.emotion} />}
        </div>
        <div className="message-content">{message.content}</div>
        {message.side === "agent" && message.metadata && (
          <details className="message-details">
            <summary>Metadata</summary>
            <pre>{JSON.stringify(message.metadata, null, 2)}</pre>
          </details>
        )}
        <div className="message-time">{message.at?.toLocaleTimeString()}</div>
      </div>
    </div>
  );
}

function QueueItem({ profile, result, active }) {
  const dotColor = result
    ? (result.converted ? "#639922" : result.success ? "#ef9f27" : "#d85a30")
    : active
      ? "#378add"
      : "var(--color-background-tertiary)";
  return (
    <div className={`queue-item ${active ? "active" : ""}`.trim()}>
      <span className="queue-dot" style={{ background: dotColor }} />
      <div className="queue-copy">
        <div className="queue-name">{profile.fullName}</div>
        <div className="queue-meta">{formatStay(profile)} - {profile.bookingDetails.guestCount} guest(s)</div>
      </div>
      <EmotionBadge emotion={profile.emotionProfile.primaryEmotion} compact />
    </div>
  );
}

export default function App() {
  const totalProfiles = GUEST_PROFILES.length;
  const bundledRange = getBundledStoredRange(totalProfiles);
  const browserBackupRef = useRef(loadSavedResults());
  const bundledResultsRef = useRef(getBundledStoredResults());
  const [cfg, setCfg] = useState(DEFAULT_SETTINGS);
  const [showCfg, setShowCfg] = useState(false);
  const [rangeStart, setRangeStart] = useState(bundledRange.start);
  const [rangeEnd, setRangeEnd] = useState(bundledRange.end);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [curProfile, setCurProfile] = useState(null);
  const [curMessages, setCurMessages] = useState([]);
  const [curRound, setCurRound] = useState(0);
  const [curStatus, setCurStatus] = useState("Idle - configure settings and run a batch");
  const [results, setResults] = useState(() => (
    bundledResultsRef.current.length > 0 ? bundledResultsRef.current : browserBackupRef.current
  ));
  const [metrics, setMetrics] = useState({ total: 0, success: 0, conversions: 0, rtSum: 0, rtCount: 0 });
  const [storageReady, setStorageReady] = useState(false);

  const abortRef = useRef(false);
  const pauseRef = useRef(false);
  const cfgRef = useRef(cfg);
  const lastGroqCallRef = useRef(0);
  const groqBudgetRef = useRef([]);
  const messagesEnd = useRef(null);
  const chatContainerRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => { cfgRef.current = cfg; }, [cfg]);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadStoredResults = async () => {
      try {
        const payload = await fetchStoredResultsPayload();
        if (cancelled) return;

        const storedResults = Array.isArray(payload.sessions) ? payload.sessions : [];
        const hasStoredResults = storedResults.length > 0;
        const hasBundledResults = bundledResultsRef.current.length > 0;
        const hasBrowserBackup = browserBackupRef.current.length > 0;

        if (hasStoredResults || (!hasBundledResults && !hasBrowserBackup)) {
          setResults(storedResults);
        }

        if (payload.batchRange) {
          const nextStart = clamp(Number(payload.batchRange.start) || 1, 1, totalProfiles);
          const nextEnd = clamp(
            Number(payload.batchRange.end) || Math.max(nextStart, Math.min(10, totalProfiles)),
            nextStart,
            totalProfiles,
          );
          setRangeStart(nextStart);
          setRangeEnd(nextEnd);
        }

        if (hasStoredResults) {
          setCurStatus(`Loaded ${storedResults.length} saved sessions from ${payload.file || RESULTS_STORAGE_FILE}`);
        } else if (hasBundledResults) {
          setCurStatus(`Loaded ${bundledResultsRef.current.length} saved sessions from bundled project JSON`);
        } else if (hasBrowserBackup) {
          setCurStatus(`Using browser backup results until ${payload.file || RESULTS_STORAGE_FILE} is updated`);
        }
      } catch {
        if (!cancelled && browserBackupRef.current.length > 0) {
          setCurStatus("Using browser backup results - file storage unavailable");
        }
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    };

    void loadStoredResults();

    return () => {
      cancelled = true;
    };
  }, [totalProfiles]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
  }, [results]);

  useEffect(() => {
    if (!storageReady) return;

    const payload = buildStoredResultsPayload(results, rangeStart, rangeEnd);
    void saveStoredResultsPayload(payload).catch(error => {
      console.error("Failed to persist stored results:", error);
    });
  }, [results, rangeStart, rangeEnd, storageReady]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [curMessages]);

  const selectedProfiles = GUEST_PROFILES.slice(rangeStart - 1, rangeEnd);
  const batchSize = selectedProfiles.length;
  const progress = batchSize > 0 ? Math.min(1, metrics.total / batchSize) : 0;
  const totalSaved = results.length;
  const savedSuccess = results.filter(r => r.success).length;
  const savedConversions = results.filter(r => r.converted).length;
  const savedRTValues = results.filter(r => r.avgRT > 0).map(r => r.avgRT);
  const nsr = totalSaved > 0 ? ((savedSuccess / totalSaved) * 100).toFixed(1) : "--";
  const cr = totalSaved > 0 ? ((savedConversions / totalSaved) * 100).toFixed(1) : "--";
  const avgRT = savedRTValues.length > 0
    ? Math.round(savedRTValues.reduce((sum, v) => sum + v, 0) / savedRTValues.length)
    : 0;

  const emotionStats = DISPLAY_EMOTIONS.map(emotion => {
    const matching = results.filter(r => r.emotion === emotion);
    const successful = matching.filter(r => r.success).length;
    return { emotion, total: matching.length, successful };
  });

  const handleChatScroll = () => {
    const element = chatContainerRef.current;
    if (!element) return;
    shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  const updateNumberSetting = (key, value) => {
    setCfg(prev => ({ ...prev, [key]: Number(value) || 0 }));
  };

  const handleRangeStartChange = value => {
    const next = clamp(Number(value) || 1, 1, totalProfiles);
    setRangeStart(next);
    setRangeEnd(prev => Math.max(next, prev));
  };

  const handleRangeEndChange = value => {
    const next = clamp(Number(value) || rangeStart, 1, totalProfiles);
    setRangeEnd(Math.max(rangeStart, next));
  };

  /* â”€â”€ utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const waitWithCountdown = async (durationMs, buildLabel) => {
    let remaining = durationMs;
    while (remaining > 0 && !abortRef.current) {
      setCurStatus(buildLabel((remaining / 1000).toFixed(1)));
      await sleep(Math.min(1000, remaining));
      remaining -= 1000;
    }
  };

  const reserveGroqBudget = async (units, label) => {
    const windowMs = 60000;
    while (!abortRef.current) {
      const now = Date.now();
      groqBudgetRef.current = groqBudgetRef.current.filter(ts => now - ts < windowMs);
      if (groqBudgetRef.current.length + units <= SAFE_GROQ_UNITS_PER_MINUTE) {
        groqBudgetRef.current.push(...Array.from({ length: units }, () => now));
        return;
      }
      const oldest = groqBudgetRef.current[0];
      const waitMs = Math.max(1000, windowMs - (now - oldest) + 250);
      setCurStatus(`${label} delayed ${(waitMs / 1000).toFixed(1)}s to stay within Groq ${GROQ_LIMITS.rpm} RPM`);
      await sleep(waitMs);
    }
    throw new Error("Batch stopped");
  };

  /* â”€â”€ Groq call â€” flat async, no promise chain, with 429 retry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const callGroq = async (
    messages,
    systemPrompt,
    attempt = 0,
    maxTokens = GROQ_LIMITS.guestMaxTokens,
    useCompactPayload = false,
  ) => {
    const liveConfig = cfgRef.current;
    const conversation = useCompactPayload
      ? compactConversationHistory(messages)
      : trimConversationHistory(messages);
    const activeSystemPrompt = useCompactPayload ? compactSystemPrompt(systemPrompt) : systemPrompt;
    const elapsed = Date.now() - lastGroqCallRef.current;
    const gap = Math.max(liveConfig.groqGapMs ?? SAFE_DIRECT_GROQ_GAP_MS, SAFE_DIRECT_GROQ_GAP_MS);

    if (elapsed < gap) await sleep(gap - elapsed);
    await reserveGroqBudget(GROQ_LIMITS.directCallsPerGuestReply, "Guest reply");
    lastGroqCallRef.current = Date.now();

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${liveConfig.groqApiKey}`,
      },
      body: JSON.stringify({
        model: liveConfig.groqModel,
        messages: [{ role: "system", content: activeSystemPrompt }, ...conversation],
        max_tokens: maxTokens,
        temperature: 0.75,
      }),
    });

    if (response.status === 429) {
      const maxRetries = liveConfig.maxRetries ?? 5;
      if (attempt >= maxRetries) throw new Error(`Groq rate limit exceeded after ${maxRetries} retries`);
      const retryAfter = parseInt(response.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(Math.pow(2, attempt) * 4000, 60000);
      setCurStatus(`Groq rate limited - waiting ${(backoff / 1000).toFixed(0)}s`);
      await sleep(backoff);
      lastGroqCallRef.current = 0;
      return callGroq(messages, systemPrompt, attempt + 1, maxTokens, useCompactPayload);
    }

    if (!response.ok) {
      const errorText = await response.text();
      const shouldCompactRetry = (
        !useCompactPayload
        && response.status === 400
        && errorText.includes("Please reduce the length of the messages or completion")
      );

      if (shouldCompactRetry) {
        setCurStatus("Groq message too long - retrying with a shorter prompt");
        return callGroq(messages, systemPrompt, attempt, Math.min(maxTokens, 80), true);
      }

      throw new Error(`Groq ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    return {
      content: extractTextContent(choice?.message?.content),
      finishReason: choice?.finish_reason || "",
    };
  };

  const generateGuestReply = async ({ messages, systemPrompt, repairHint }) => {
    let activeSystemPrompt = systemPrompt;
    let activeMaxTokens = GROQ_LIMITS.guestMaxTokens;

    for (let repairAttempt = 0; repairAttempt <= GROQ_LIMITS.maxGuestReplyRepairs; repairAttempt += 1) {
      const { content, finishReason } = await callGroq(messages, activeSystemPrompt, 0, activeMaxTokens);
      if (!looksIncompleteGuestReply(content, finishReason)) return content;

      activeSystemPrompt = `${systemPrompt}

Critical output rule for the next reply:
- Return exactly one complete guest message.
- Keep it under 20 words.
- If the reply is only a phone number, return digits only with no punctuation.
- Otherwise, end with punctuation.
- Do not stop mid-sentence.
${repairHint ? `- ${repairHint}` : ""}`;
      activeMaxTokens = GROQ_LIMITS.guestRecoveryMaxTokens;
      setCurStatus("Repairing incomplete guest reply...");
    }

    throw new Error("Guest reply was empty or cut off");
  };

  /* â”€â”€ backend calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const apiPost = async (path, body, options = {}) => {
    const { attempt = 0, reserveUnits = 0, label = "Backend request" } = options;
    if (reserveUnits > 0) await reserveGroqBudget(reserveUnits, label);

    const response = await fetch(`${cfgRef.current.backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const isRateLimited = (
        response.status === 429
        || errorText.includes("429 TOO_MANY_REQUESTS")
        || errorText.toLowerCase().includes("rate limit")
      );
      if (isRateLimited && attempt < (cfgRef.current.maxRetries ?? 0)) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "0", 10);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(Math.pow(2, attempt) * 5000, 60000);
        setCurStatus(`${label} hit rate limits - retrying in ${(backoff / 1000).toFixed(0)}s`);
        await sleep(backoff);
        return apiPost(path, body, { attempt: attempt + 1, reserveUnits, label });
      }
      throw new Error(`POST ${path} -> ${response.status}${errorText ? `: ${errorText}` : ""}`);
    }

    return response.json();
  };

  const apiGet = async path => {
    const response = await fetch(`${cfgRef.current.backendUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.json();
  };

  const waitAgentReply = async (sessionId, knownCount) => {
    const liveConfig = cfgRef.current;
    const deadline = Date.now() + liveConfig.pollTimeout;
    while (Date.now() < deadline) {
      await sleep(liveConfig.pollMs);
      const data = await apiGet(`/api/chat/session/${sessionId}/messages`);
      const agentMessages = (data.data || []).filter(m => m.senderType === "AGENT");
      if (agentMessages.length > knownCount) return agentMessages[agentMessages.length - 1];
    }
    throw new Error("Timeout waiting for agent reply");
  };

  /* â”€â”€ system prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const calculateIncreasedBudget = (originalBudget, percentageIncrease = 10) => {
    return Math.round(originalBudget * (1 + percentageIncrease / 100));
  };

  const buildSystemPrompt = (profile, adjustedMaxBudget = null) => {
    const maxBudgetToUse = adjustedMaxBudget !== null ? adjustedMaxBudget : profile.budgetProfile.maxBudgetPerNight;
    const shouldBookNow = shouldConfirmImmediately(profile);
    const closingDecisionRule = shouldBookNow
      ? "When the negotiated price is acceptable, confirm the booking now instead of delaying."
      : "When the negotiated price is acceptable, do not confirm the booking right now. Politely say you will book later and thank the agent.";
    const specialInstructionLine = profile.negotiationProfile.specialInstruction
      ? `Special instruction: ${profile.negotiationProfile.specialInstruction}\n\n`
      : "";
    return `You are simulating a hotel guest in a real-time hotel booking negotiation.

Guest profile:
- Name: ${profile.fullName} (always introduce yourself as ${profile.username})
- Check-in: ${profile.checkInDate}, Check-out: ${profile.checkOutDate}
- Nights: ${profile.bookingDetails.stayNights}, Guests: ${profile.bookingDetails.guestCount}
- Purpose: ${profile.bookingDetails.travelPurpose}
- Max budget: ${maxBudgetToUse} ${profile.budgetProfile.currency} per night
- Price adoption: ${profile.priceAdoption}
- Emotional state: ${profile.emotionProfile.primaryEmotion} - ${profile.emotionProfile.description}

You MUST follow this exact conversation flow in order. Do not skip any step.

STEP 1 - PROVIDE BOOKING DETAILS
When the agent greets you or asks for your requirements, give your check-in date
(${profile.checkInDate}), check-out date (${profile.checkOutDate}), and number of guests
(${profile.bookingDetails.guestCount}). Also mention the purpose: ${profile.bookingDetails.travelPurpose}.

STEP 2 - SELECT A PACKAGE BY NAME
When the agent presents a list of available packages, you MUST pick one by its exact name.
Always choose the cheapest-sounding option. Never use a JSON key like "availablePackages" as
a package name â€” only use the actual name printed for the package (e.g. "Premium Solo Stay").

STEP 3 - NEGOTIATE THE PRICE
Once you have selected a package by name, negotiate the nightly price down toward your
budget of ${maxBudgetToUse} ${profile.budgetProfile.currency} per night.
Whenever you negotiate on price, include your exact target nightly rate as a number.
Do not switch to another package after your first selection. Keep negotiating only for the
initially selected package even if the agent asks you to change packages.

PRICE ADOPTION RULE
- If price adoption is YES, you may adapt to the hotel's final offered price if it feels reasonable and you want to close the booking.
- If price adoption is NO, you must keep negotiating for your own budget and never accept above ${maxBudgetToUse} ${profile.budgetProfile.currency} per night.
- If price adoption is NO and no budget match is reached by round 12, politely decline and leave the conversation.

CRITICAL ACCEPTANCE CHECK â€” run this before every single reply:
Look at the most recent price the agent offered. Extract just the number. Compare it to your
budget of ${maxBudgetToUse}.
If the agent's price number is LESS THAN OR EQUAL TO ${maxBudgetToUse},
the negotiation is successful â€” do not negotiate further, do not ask for more discount.
Example: if your budget is 61910 and the agent offers 60100, then 60100 <= 61910 is TRUE,
so the negotiation has succeeded. Lower numbers mean cheaper prices. A price of 60000 is cheaper than 62000.

STEP 4 - DECIDE THE CLOSE
The moment the agent's offered price is at or below ${maxBudgetToUse} ${profile.budgetProfile.currency}/night,
you must choose one of these outcomes:
- Confirm now: say something like "That works for me, I'd like to confirm the booking!"
- Book later: say something like "That works for me. I'll book it later, thank you."

Decision rule:
- Acceptance likelihood: ${profile.emotionProfile.acceptanceLikelihood}
- Urgency: ${profile.emotionProfile.urgencyLevel}
- ${closingDecisionRule}
- Only confirm now if you truly intend to complete the booking in this conversation.
- If you choose to book later, end politely and do not provide contact details.

STEP 5 - PROVIDE CONTACT DETAILS
When the agent asks for your email address or phone number, provide them IMMEDIATELY
and UNCONDITIONALLY. Do not ask for price confirmation first. Do not add conditions.
The agent asking for contact details means the price has already been agreed.
Email: ${profile.email}
Phone: ${profile.contactNumber}
When you provide the phone number, output the digits only. Do not add "." after the mobile number. Reply with only the number.

${specialInstructionLine}Hard rules:

- Keep every reply to 1-3 sentences maximum.
- Never use bullet points, numbered lists, or markdown formatting.
- Never reveal you are an AI, a simulation, or a test.
- Never skip STEP 2 - always name a package before discussing price.
- If you decide to book later, clearly say you will book later and end the conversation.
- Never refuse to give contact details when asked â€” provide them immediately.`;
  };

  const buildPackageSelectionReply = agentMessage => {
    // FIX: metadata arrives as a JSON string from the backend â€” parse it before
    // passing to pickPackageOption so nested package objects are traversed correctly
    const parsedMessage = {
      ...agentMessage,
      metadata: (() => {
        if (!agentMessage?.metadata) return null;
        if (typeof agentMessage.metadata === "object") return agentMessage.metadata;
        try { return JSON.parse(agentMessage.metadata); } catch { return null; }
      })(),
    };
    const selectedPackage = pickPackageOption(parsedMessage);
    if (!selectedPackage) return null;
    return `I'd like to explore the "${selectedPackage.name}" package, please.`;
  };

  const parseMetadata = raw => {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };

  const isBookingDone = message => {
    if (!message) return false;
    const content = (message.content || "").toLowerCase();
    const metadata = JSON.stringify(parseMetadata(message.metadata) || "").toLowerCase();
    return (
      message.messageType === "BOOKING_CARD" ||
      content.includes("booking reference") ||
      content.includes("emt-") ||
      metadata.includes("booking reference") ||
      metadata.includes("emt-")
    );
  };

  const isBookLaterReply = text => {
    const normalized = String(text || "").toLowerCase();
    return (
      normalized.includes("book it later")
      || normalized.includes("book later")
      || normalized.includes("i'll book later")
      || normalized.includes("i will book later")
      || normalized.includes("i'll confirm later")
      || normalized.includes("i will confirm later")
      || normalized.includes("come back later")
    );
  };

  /* â”€â”€ run one profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const runProfile = async profile => {
    const result = {
      profileId: profile.id,
      profileName: profile.fullName,
      priceAdoption: profile.priceAdoption,
      emotion: profile.emotionProfile.primaryEmotion,
      success: false,
      converted: false,
      rounds: 0,
      responseTimes: [],
      avgRT: 0,
      sessionId: null,
      outcome: "incomplete",
      error: null,
    };

    try {
      setCurProfile(profile);
      setCurMessages([]);
      setCurRound(0);
      setCurStatus(`Starting session for ${profile.username}...`);

      const startData = await apiPost("/api/chat/session/start", {
        guestName: profile.username,
        initialMessage: "Hello",
      }, {
        reserveUnits: GROQ_LIMITS.backendCallsPerGuestMessage,
        label: "Session start",
      });

      const sessionId = startData.data.sessionId;
      result.sessionId = sessionId;

      // Initialize budget tracking for price adoption feature
      let currentMaxBudget = profile.budgetProfile.maxBudgetPerNight;
      const budgetIncreaseThreshold = 3; // Increase budget after round 3
      const budgetIncreasePercentage = 10; // Increase by 10%
      let budgetHasBeenIncreased = false;

      const systemPrompt = buildSystemPrompt(profile, currentMaxBudget);
      const history = [];
      let agentCount = 0;
      let complete = false;
      let isFirstMessage = true;
      let lastAgentMessage = null;
      let packageSelected = false;   // FIX 2: track selection so it fires only once
      let selectedPackageName = null;

      const liveConfig = cfgRef.current;
      const roundLimit = profile.priceAdoption === "NO"
        ? Math.min(liveConfig.maxRounds, 6, SAFE_MAX_ROUNDS)
        : Math.min(liveConfig.maxRounds, SAFE_MAX_ROUNDS);

      while (result.rounds < roundLimit && !complete && !abortRef.current) {
        while (pauseRef.current && !abortRef.current) await sleep(400);
        if (abortRef.current) break;

        result.rounds += 1;
        setCurRound(result.rounds);

        // Price adoption feature: increase budget after N rounds for guests with priceAdoption: YES
        let activeSystemPrompt = systemPrompt;
        if (
          profile.priceAdoption === "YES"
          && !budgetHasBeenIncreased
          && result.rounds >= budgetIncreaseThreshold
        ) {
          budgetHasBeenIncreased = true;
          currentMaxBudget = calculateIncreasedBudget(profile.budgetProfile.maxBudgetPerNight, budgetIncreasePercentage);
          activeSystemPrompt = buildSystemPrompt(profile, currentMaxBudget);
          setCurStatus(`Round ${result.rounds} - Increased budget to ${formatCurrency(currentMaxBudget, profile.budgetProfile.currency)} for ${profile.username}`);
          await sleep(500); // Brief pause to show budget increase
        }

        // FIX 2: only attempt package selection once and only when the last agent
        // message was actually a PACKAGE_CARD â€” not on every round after round 1
        const shouldSelectPackage = !isFirstMessage
          && !packageSelected
          && lastAgentMessage?.messageType === "PACKAGE_CARD";

        const packageSelectionReply = shouldSelectPackage
          ? buildPackageSelectionReply(lastAgentMessage)
          : null;

        const rawGuestMessage = isFirstMessage
          ? await generateGuestReply({
            messages: [{
              role: "user",
              content: `Begin the negotiation following STEP 1. Greet the agent and provide your booking details: check-in ${profile.checkInDate}, check-out ${profile.checkOutDate}, ${profile.bookingDetails.guestCount} guest(s) for ${profile.bookingDetails.travelPurpose}. Your intent: ${profile.negotiationProfile.openingIntent}.`,
            }],
            systemPrompt: activeSystemPrompt,
            repairHint: "Include the stay dates, guest count, and purpose in one natural sentence.",
          })
          : packageSelectionReply
            ? packageSelectionReply
            : await generateGuestReply({
              messages: history,
              systemPrompt: activeSystemPrompt,
              repairHint: "If negotiating, include one exact nightly target price in numbers.",
            });

        const guestMessage = packageSelected
          ? enforceSelectedPackageReply(rawGuestMessage, selectedPackageName)
          : rawGuestMessage;

        isFirstMessage = false;

        // FIX 2: mark package as selected immediately after the selection reply is used
        if (packageSelectionReply) {
          packageSelected = true;
          selectedPackageName = pickPackageOption(lastAgentMessage)?.name || selectedPackageName;
        }

        setCurMessages(prev => [...prev, { side: "guest", content: guestMessage, at: new Date() }]);
        history.push({ role: "assistant", content: guestMessage });

        if (isBookLaterReply(guestMessage)) {
          await apiPost("/api/chat/session/message", { sessionId, message: guestMessage }, {
            reserveUnits: GROQ_LIMITS.backendCallsPerGuestMessage,
            label: "Guest closes later",
          });
          complete = true;
          result.success = true;
          result.converted = false;
          result.outcome = "book_later";
          setCurStatus(`${profile.username} accepted the deal but chose to book later`);
          break;
        }

        setCurStatus(`Round ${result.rounds} - waiting for agent`);
        const startTime = Date.now();

        await apiPost("/api/chat/session/message", { sessionId, message: guestMessage }, {
          reserveUnits: GROQ_LIMITS.backendCallsPerGuestMessage,
          label: "Agent reply",
        });

        const agentMessage = await waitAgentReply(sessionId, agentCount);
        const responseTime = Date.now() - startTime;
        result.responseTimes.push(responseTime);
        agentCount += 1;

        const parsedMetadata = parseMetadata(agentMessage.metadata);

        const agentContent = agentMessage.content?.trim()
          || (parsedMetadata ? JSON.stringify(parsedMetadata, null, 2) : "");

        const metadataContext = parsedMetadata
          ? `\n\n[Package/price information: ${JSON.stringify(parsedMetadata)}]`
          : "";

        setCurMessages(prev => [
          ...prev,
          {
            side: "agent",
            content: agentContent,
            emotion: agentMessage.detectedEmotion,
            metadata: parsedMetadata,
            at: new Date(),
          },
        ]);

        lastAgentMessage = agentMessage;
        history.push({ role: "user", content: agentContent + metadataContext });

        if (isBookingDone(agentMessage)) {
          complete = true;
          result.success = true;
          result.converted = true;
          result.outcome = "book_now";
          setCurStatus(`Booking confirmed for ${profile.username}`);
        } else if (result.rounds >= roundLimit) {
          if (profile.priceAdoption === "NO") {
            const leaveMessage = "Thank you, but this is still above my budget, so I will leave for now.";
            setCurMessages(prev => [...prev, { side: "guest", content: leaveMessage, at: new Date() }]);
            await apiPost("/api/chat/session/message", { sessionId, message: leaveMessage });
            result.outcome = "walk_away";
            setCurStatus(`${profile.username} left after ${roundLimit} rounds without reaching budget`);
          } else {
            result.outcome = "max_rounds";
            setCurStatus(`Max rounds reached for ${profile.username}`);
          }
        } else {
          await waitWithCountdown(
            Math.max(cfgRef.current.messageGapMs, SAFE_ROUND_GAP_MS),
            seconds => `Next message for ${profile.username} in ${seconds}s`,
          );
        }
      }

      result.avgRT = result.responseTimes.length > 0
        ? Math.round(result.responseTimes.reduce((sum, current) => sum + current, 0) / result.responseTimes.length)
        : 0;

      if (!result.error && !abortRef.current) {
        result.success = true;
        if (result.outcome === "incomplete") {
          result.outcome = result.converted ? "book_now" : "session_completed";
        }
      }

    } catch (error) {
      result.error = error.message;
      result.success = false;
      result.converted = false;
      setCurStatus(`Error: ${error.message}`);
    } finally {
      delete result.responseTimes;
    }

    return result;
  };

  /* â”€â”€ batch runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  const runBatch = async () => {
    abortRef.current = false;
    pauseRef.current = false;
    lastGroqCallRef.current = 0;
    groqBudgetRef.current = [];
    setRunning(true);
    setPaused(false);
    setMetrics({ total: 0, success: 0, conversions: 0, rtSum: 0, rtCount: 0 });

    for (let index = rangeStart - 1; index <= rangeEnd - 1 && !abortRef.current; index += 1) {
      while (pauseRef.current && !abortRef.current) await sleep(400);
      if (abortRef.current) break;

      const result = await runProfile(GUEST_PROFILES[index]);

      setResults(prev => [...prev, result]);
      setMetrics(prev => ({
        total: prev.total + 1,
        success: prev.success + (result.success ? 1 : 0),
        conversions: prev.conversions + (result.converted ? 1 : 0),
        rtSum: prev.rtSum + result.avgRT,
        rtCount: prev.rtCount + (result.avgRT > 0 ? 1 : 0),
      }));

      if (index < rangeEnd - 1 && !abortRef.current) {
        await waitWithCountdown(
          Math.max(cfgRef.current.delayMs, SAFE_ROUND_GAP_MS),
          seconds => `Next profile in ${seconds}s`,
        );
      }
    }

    setRunning(false);
    setPaused(false);
    setCurStatus(abortRef.current ? "Batch stopped" : "Batch complete");
  };

  const handlePause = () => {
    pauseRef.current = !pauseRef.current;
    setPaused(prev => !prev);
    setCurStatus(pauseRef.current ? "Batch paused" : "Batch resumed");
  };

  const handleStop = () => {
    abortRef.current = true;
    pauseRef.current = false;
    setRunning(false);
    setPaused(false);
    setCurStatus("Stopping batch...");
  };

  const handleClearResults = () => {
    if (running) return;
    if (!window.confirm("Clear all saved results?")) return;
    setResults([]);
    setMetrics({ total: 0, success: 0, conversions: 0, rtSum: 0, rtCount: 0 });
    setCurStatus("Saved results cleared");
  };

  const exportJSON = async () => {
    let payload = buildStoredResultsPayload(results, rangeStart, rangeEnd);

    try {
      const storedPayload = await fetchStoredResultsPayload();
      if (Array.isArray(storedPayload.sessions)) {
        payload = storedPayload;
      }
    } catch (error) {
      console.error("Failed to export stored results from disk:", error);
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `emotiate_eval_${payload.batchRange?.start ?? rangeStart}-${payload.batchRange?.end ?? rangeEnd}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /* â”€â”€ render â”€â”€ unchanged from original â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="brand">EMOTIATE</div>
          <h1 className="app-title">System evaluation dashboard</h1>
          <p className="app-subtitle">Simple component-based layout for running guest negotiation batches.</p>
        </div>

        <div className="header-actions">
          {results.length > 0 && (
            <Button onClick={exportJSON}>Export JSON</Button>
          )}
          {results.length > 0 && (
            <Button variant="danger" onClick={handleClearResults} disabled={running}>Clear results</Button>
          )}
          <Button onClick={() => setShowCfg(prev => !prev)}>
            {showCfg ? "Hide settings" : "Settings"}
          </Button>
        </div>
      </header>

      {showCfg && (
        <Panel title="Settings" subtitle="Backend and timing configuration" className="config-panel">
          <div className="settings-grid">
            {SETTINGS_FIELDS.map(field => (
              <Field key={field.key} label={field.label}>
                <input
                  type={field.type || "text"}
                  value={cfg[field.key]}
                  onChange={event => (
                    field.type === "number"
                      ? updateNumberSetting(field.key, event.target.value)
                      : setCfg(prev => ({ ...prev, [field.key]: event.target.value }))
                  )}
                  disabled={running}
                />
              </Field>
            ))}
          </div>

          {!cfg.groqApiKey && (
            <div className="config-alert">Groq API key required to run simulations.</div>
          )}
        </Panel>
      )}

      <Panel title="Batch controls" subtitle={curStatus} className="batch-panel">
        <div className="batch-toolbar">
          <Field label="Profile start" className="field-small">
            <input
              type="number"
              min={1}
              max={totalProfiles}
              value={rangeStart}
              onChange={event => handleRangeStartChange(event.target.value)}
              disabled={running}
            />
          </Field>

          <Field label="Profile end" className="field-small">
            <input
              type="number"
              min={1}
              max={totalProfiles}
              value={rangeEnd}
              onChange={event => handleRangeEndChange(event.target.value)}
              disabled={running}
            />
          </Field>

          <div className="batch-meta">{batchSize} profiles selected</div>

          <div className="toolbar-actions">
            {!running ? (
              <Button variant="primary" onClick={runBatch} disabled={!cfg.groqApiKey || batchSize === 0}>
                Run batch
              </Button>
            ) : (
              <>
                <Button onClick={handlePause}>{paused ? "Resume" : "Pause"}</Button>
                <Button variant="danger" onClick={handleStop}>Stop</Button>
              </>
            )}
          </div>
        </div>

        {(running || metrics.total > 0) && (
          <div className="progress-block">
            <div className="progress-meta">
              <span>{metrics.total}/{batchSize}</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}
      </Panel>

      <div className="main-grid">
        <div className="main-column">
          <div className="metrics-grid">
            <MetricCard label="Sessions done" value={String(totalSaved)} sub={`${metrics.total}/${batchSize} in current batch`} accent="#378add" />
            <MetricCard label="NSR" value={nsr === "--" ? "--" : `${nsr}%`} sub={`${savedSuccess} successful negotiations`} accent="#639922" />
            <MetricCard label="CR" value={cr === "--" ? "--" : `${cr}%`} sub={`${savedConversions} bookings`} accent="#ef9f27" />
            <MetricCard label="Avg response time" value={avgRT > 0 ? `${avgRT} ms` : "--"} sub="per round" accent="#7f77dd" />
          </div>

          <Panel
            title="Live negotiation"
            subtitle={
              curProfile
                ? `${curProfile.fullName} - round ${curRound} - budget ${formatCurrency(curProfile.budgetProfile.maxBudgetPerNight, curProfile.budgetProfile.currency)}/night`
                : "Run a batch to see live negotiations"
            }
            right={curProfile ? <EmotionBadge emotion={curProfile.emotionProfile.primaryEmotion} /> : null}
          >
            <div ref={chatContainerRef} onScroll={handleChatScroll} className="chat-stream">
              {curMessages.length === 0 ? (
                <div className="empty-state">
                  {running ? "Starting..." : "Run a batch to see live negotiations here"}
                </div>
              ) : (
                curMessages.map((message, index) => (
                  <MessageBubble key={`${message.side}-${index}`} message={message} />
                ))
              )}
              <div ref={messagesEnd} />
            </div>
          </Panel>

          <Panel title="Session log" subtitle={`${results.length} completed`}>
            <div className="table-wrap">
              {results.length === 0 ? (
                <div className="empty-state compact">No sessions yet</div>
              ) : (
                <table className="session-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Guest</th>
                      <th>Emotion</th>
                      <th>Rounds</th>
                      <th>NSR</th>
                      <th>Converted</th>
                      <th>Avg RT</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...results].reverse().map(result => (
                      <tr key={result.sessionId || result.profileId}>
                        <td>{result.profileId}</td>
                        <td className="cell-strong">{result.profileName}</td>
                        <td><EmotionBadge emotion={result.emotion} /></td>
                        <td>{result.rounds}</td>
                        <td>{result.success ? "Yes" : "No"}</td>
                        <td>{result.converted ? "Yes" : "No"}</td>
                        <td>{result.avgRT > 0 ? `${result.avgRT} ms` : "--"}</td>
                        <td className="error-cell">{result.error || "--"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        </div>

        <div className="side-column">
          <Panel title="Emotion breakdown">
            <div className="stat-stack">
              {emotionStats.map(({ emotion, total, successful }) => {
                const percentage = total > 0 ? Math.round((successful / total) * 100) : 0;
                const colors = EMOTION_COLORS[emotion] || EMOTION_COLORS.NEUTRAL;
                return (
                  <div key={emotion} className="emotion-stat">
                    <div className="emotion-row">
                      <EmotionBadge emotion={emotion} />
                      <span>{total > 0 ? `${successful}/${total} (${percentage}%)` : "0/0"}</span>
                    </div>
                    <div className="mini-progress-track">
                      <div className="mini-progress-fill" style={{ width: `${percentage}%`, background: colors.border }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Profile queue" subtitle={`Profiles ${rangeStart}-${rangeEnd}`}>
            <div className="queue-list">
              {selectedProfiles.map(profile => (
                <QueueItem
                  key={profile.id}
                  profile={profile}
                  result={results.find(item => item.profileId === profile.id)}
                  active={curProfile?.id === profile.id && running}
                />
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

