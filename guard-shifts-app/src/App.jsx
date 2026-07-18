import { useState, useEffect, useCallback, Component } from "react";
import { X, Plus, Trash2, ShieldCheck, ChevronLeft, User, LogOut, Phone, Pencil, RefreshCw } from "lucide-react";
import {
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db } from "./firebase";

const STATE_REF = doc(db, "app", "state");
const AUTH_KEY = "guard-shifts-auth-v1";
const ADMIN_KEY = "guard-shifts-admin-v1";
const WRITE_TIMEOUT_MS = 10000;

// Firestore's write calls have no built-in timeout - on a network that
// silently drops the connection, the returned promise can hang forever
// with no error. This wraps any write so it always settles within
// WRITE_TIMEOUT_MS, turning a permanent hang into a clear, catchable error.
function withTimeout(promise, ms = WRITE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

const COLORS = {
  bg: "#f1f5f9",
  surface: "#ffffff",
  surfaceRaised: "#eef2f7",
  border: "#dde6ee",
  textPrimary: "#37454f",
  textMuted: "#8493a1",
  accent: "#f0bd8a",
  accentText: "#5c3d1c",
  open: "#a9dcc0",
  openText: "#2f6b4a",
  full: "#f2aeae",
  fullText: "#8a3d3d",
};

const DEFAULT_INFO = { instructions: "", notes: "", phones: [] };

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateLabel(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function isToday(d) {
  return fmtDate(d) === fmtDate(new Date());
}
function isPastDate(d) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return d.getTime() < t.getTime();
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function shiftsForDate(templates, date) {
  const dow = date.getDay();
  return templates
    .filter((t) => t.dayOfWeek === dow)
    .map((t) => ({
      id: `${t.id}_${fmtDate(date)}`,
      templateId: t.id,
      date: fmtDate(date),
      label: t.label,
      start: t.start,
      end: t.end,
      capacity: t.capacity,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}
function generateUpcoming(templates, daysAhead = 30) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const byDate = [];
  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(today, i);
    const shifts = shiftsForDate(templates, date);
    if (shifts.length === 0) continue;
    byDate.push({ date, shifts });
  }
  return byDate;
}
function weeklyOccurrenceDates(startDateStr, endDateStr) {
  const start = new Date(startDateStr + "T00:00:00");
  const end = new Date(endDateStr + "T00:00:00");
  const dates = [];
  let d = start;
  while (d.getTime() <= end.getTime()) {
    dates.push(new Date(d));
    d = addDays(d, 7);
  }
  return dates;
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl p-4 text-sm" style={{ background: COLORS.surface, border: `1px solid ${COLORS.full}`, color: COLORS.fullText }}>
          <p className="font-bold mb-1">קרתה שגיאה בהצגת המסך הזה</p>
          <p className="text-xs mb-2" style={{ color: COLORS.textMuted }}>שלח צילום מסך של ההודעה הבאה:</p>
          <p className="mono text-xs whitespace-pre-wrap" style={{ direction: "ltr", textAlign: "left" }}>{String(this.state.error && this.state.error.message)}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myName, setMyName] = useState(null);
  const [pendingCreds, setPendingCreds] = useState(undefined); // undefined = not checked yet
  const [authError, setAuthError] = useState(null);
  const [view, setView] = useState("calendar");
  const [calendarMode, setCalendarMode] = useState("month");
  const [activeOnly, setActiveOnly] = useState(false);
  const [currentDate, setCurrentDate] = useState(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  });
  const [selectedShift, setSelectedShift] = useState(null);
  const [toast, setToast] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingAdminCode, setPendingAdminCode] = useState(undefined);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminError, setAdminError] = useState(null);
  const [adminCallback, setAdminCallback] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // subscribe to shared Firestore state in realtime.
  // Re-runs when refreshKey changes, which happens automatically when the
  // tab regains focus/visibility or the network comes back online - this
  // recovers from a realtime listener that silently died on a flaky
  // network, without requiring the user to reload the page.
  useEffect(() => {
    const loadTimeout = setTimeout(() => {
      setLoadError("הטעינה לוקחת יותר מדי זמן - כנראה בעיית רשת. בדוק את החיבור לאינטרנט ונסה שוב.");
    }, 15000);
    const unsub = onSnapshot(
      STATE_REF,
      (snap) => {
        if (snap.exists()) {
          clearTimeout(loadTimeout);
          setLoadError(null);
          const d = snap.data();
          setData({
            templates: d.templates || [],
            registrations: d.registrations || {},
            users: d.users || {},
            info: { ...DEFAULT_INFO, ...(d.info || {}) },
            adminCode: d.adminCode || "",
            reports: d.reports || {},
          });
          setLoading(false);
        } else if (!snap.metadata.fromCache) {
          // The server itself confirmed there is truly no document yet
          // (this should only ever happen once, the very first time the
          // app is ever used). Only now is it safe to create it.
          //
          // Critical: if this snapshot came fromCache instead, it does NOT
          // mean "no document exists" - it means "we haven't heard from the
          // server yet" (e.g. slow/unstable connection). Treating that as
          // real and writing empty defaults would overwrite genuine data
          // the moment the connection recovers. This was the bug behind
          // shifts disappearing on a second login - never repeat it.
          clearTimeout(loadTimeout);
          setLoadError(null);
          const emptyDefaults = { templates: [], registrations: {}, users: {}, info: DEFAULT_INFO, adminCode: "", reports: {} };
          setData(emptyDefaults);
          setDoc(STATE_REF, emptyDefaults).catch((e) => console.error("bootstrap write failed", e));
          setLoading(false);
        }
        // else: fromCache && !exists -> unknown state, not yet confirmed by
        // the server. This is the NORMAL first event for almost every fresh
        // session (empty local cache). Deliberately do nothing and keep
        // waiting for a decisive answer - crucially, the loadTimeout is
        // NOT cleared here, so if a real answer never comes, the 15s
        // safety net still fires and shows the retry screen instead of
        // hanging forever with no feedback.
      },
      (err) => {
        clearTimeout(loadTimeout);
        console.error(err);
        setLoadError("שגיאת חיבור למסד הנתונים - בדוק את החיבור לאינטרנט ונסה שוב.");
      }
    );
    return () => {
      clearTimeout(loadTimeout);
      unsub();
    };
  }, [refreshKey]);

  // auto-recover: re-subscribe when the tab becomes visible again or the
  // network reconnects, in case the realtime channel died silently
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setRefreshKey((k) => k + 1);
    };
    const onOnline = () => setRefreshKey((k) => k + 1);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // load locally-remembered login (this device only)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      setPendingCreds(raw ? JSON.parse(raw) : null);
    } catch (e) {
      setPendingCreds(null);
    }
    try {
      const rawAdmin = localStorage.getItem(ADMIN_KEY);
      setPendingAdminCode(rawAdmin || null);
    } catch (e) {
      setPendingAdminCode(null);
    }
  }, []);

  // once both data + pending creds are available, try auto-login
  useEffect(() => {
    if (!myName && data && pendingCreds && pendingCreds.name) {
      if (data.users[pendingCreds.name] === pendingCreds.pin) {
        setMyName(pendingCreds.name);
      }
    }
  }, [data, pendingCreds, myName]);

  // once both data + a remembered admin code are available, try auto-unlock admin
  useEffect(() => {
    if (!isAdmin && data && pendingAdminCode && data.adminCode && data.adminCode === pendingAdminCode) {
      setIsAdmin(true);
    }
  }, [data, pendingAdminCode, isAdmin]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const attemptAuth = async (rawName, pin) => {
    const name = rawName.trim();
    if (!name || pin.length < 4) {
      setAuthError("נא להזין שם וקוד בן 4 ספרות");
      return;
    }
    const existingPin = data.users[name];
    if (existingPin !== undefined) {
      if (existingPin !== pin) {
        setAuthError("הקוד שגוי עבור השם הזה");
        return;
      }
      // returning user, correct pin - nothing to write, log in instantly
      try {
        localStorage.setItem(AUTH_KEY, JSON.stringify({ name, pin }));
      } catch (e) {}
      setAuthError(null);
      setMyName(name);
      return;
    }
    // new user - log in immediately, persist to the server in the background
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ name, pin }));
    } catch (e) {}
    setAuthError(null);
    setMyName(name);
    try {
      await withTimeout(updateDoc(STATE_REF, { [`users.${name}`]: pin }));
    } catch (e) {
      showToast("שים לב: הרישום שלך לא נשמר בשרת (בעיית רשת) - ייתכן שתתבקש להזין קוד שוב בכניסה הבאה");
    }
  };

  const logout = () => {
    try {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(ADMIN_KEY);
    } catch (e) {}
    setPendingCreds(null);
    setMyName(null);
    // Critical: admin unlock must not survive a personal logout. Without
    // this, a second person logging in with their own name on the same
    // device/tab would silently inherit admin visibility (including other
    // people's private reports) without ever entering the admin code.
    setIsAdmin(false);
    setPendingAdminCode(null);
  };

  const requestAdmin = (afterSuccess) => {
    if (isAdmin) {
      afterSuccess && afterSuccess();
      return;
    }
    setAdminCallback(() => afterSuccess || null);
    setAdminError(null);
    setAdminModalOpen(true);
  };

  const attemptAdminUnlock = async (code) => {
    if (!code || code.length < 4) {
      setAdminError("נא להזין קוד תקין");
      return;
    }
    if (data.adminCode && data.adminCode !== code) {
      setAdminError("קוד שגוי");
      return;
    }
    const isBootstrap = !data.adminCode;
    const prevData = data;
    // unlock immediately - no reason to make the user wait on a network
    // round trip just to flip a local permission flag
    if (isBootstrap) setData({ ...data, adminCode: code });
    try {
      localStorage.setItem(ADMIN_KEY, code);
    } catch (e) {}
    setAdminError(null);
    setIsAdmin(true);
    setAdminModalOpen(false);
    if (adminCallback) {
      adminCallback();
      setAdminCallback(null);
    }
    if (isBootstrap) {
      try {
        await withTimeout(updateDoc(STATE_REF, { adminCode: code }));
        showToast("קוד ניהול הוגדר - שמור אותו!");
      } catch (e) {
        setData(prevData);
        setIsAdmin(false);
        showToast("שגיאה בשמירת קוד הניהול - נסה שוב");
      }
    }
  };

  const register = async (shift) => {
    if (!myName) return;
    const list = data.registrations[shift.id] || [];
    if (list.includes(myName)) return;
    if (list.length >= shift.capacity) {
      showToast("המשמרת התמלאה");
      return;
    }
    const prevData = data;
    setData({ ...data, registrations: { ...data.registrations, [shift.id]: [...list, myName] } });
    try {
      await withTimeout(updateDoc(STATE_REF, { [`registrations.${shift.id}`]: arrayUnion(myName) }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - ההרשמה לא נשמרה, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const unregister = async (shift) => {
    if (!myName) return;
    const list = data.registrations[shift.id] || [];
    const prevData = data;
    setData({ ...data, registrations: { ...data.registrations, [shift.id]: list.filter((n) => n !== myName) } });
    try {
      await withTimeout(updateDoc(STATE_REF, { [`registrations.${shift.id}`]: arrayRemove(myName) }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - הביטול לא נשמר, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const registerRecurring = async (shift, endDateStr) => {
    if (!myName || !endDateStr) return;
    const occurrences = weeklyOccurrenceDates(shift.date, endDateStr);
    const updatePayload = {};
    const nextRegs = { ...data.registrations };
    let added = 0;
    let skipped = 0;
    occurrences.forEach((d) => {
      const id = `${shift.templateId}_${fmtDate(d)}`;
      const list = nextRegs[id] || [];
      if (list.includes(myName)) return;
      if (list.length >= shift.capacity) {
        skipped++;
        return;
      }
      nextRegs[id] = [...list, myName];
      updatePayload[`registrations.${id}`] = arrayUnion(myName);
      added++;
    });
    const prevData = data;
    setData({ ...data, registrations: nextRegs });
    showToast(
      skipped > 0
        ? `נרשמת ל-${added} משמרות (${skipped} היו מלאות ודולגו)`
        : `נרשמת ל-${added} משמרות עד ${endDateStr.split("-").reverse().join("/")}`
    );
    try {
      if (Object.keys(updatePayload).length > 0) {
        await withTimeout(updateDoc(STATE_REF, updatePayload));
      }
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - ההרשמה לא נשמרה, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const addTemplates = async (baseTpl, days) => {
    const newTemplates = days.map((d) => ({ ...baseTpl, dayOfWeek: d, id: uid() }));
    const prevData = data;
    setData({ ...data, templates: [...data.templates, ...newTemplates] });
    try {
      await withTimeout(updateDoc(STATE_REF, { templates: arrayUnion(...newTemplates) }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - המשמרת לא נשמרה, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const deleteTemplate = async (id) => {
    const prevData = data;
    const filtered = data.templates.filter((t) => t.id !== id);
    setData({ ...data, templates: filtered });
    try {
      await withTimeout(updateDoc(STATE_REF, { templates: filtered }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - המחיקה לא נשמרה, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const updateInfo = async (nextInfo) => {
    const prevData = data;
    setData({ ...data, info: nextInfo });
    try {
      await withTimeout(updateDoc(STATE_REF, { info: nextInfo }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const resetRegistrations = async () => {
    const prevData = data;
    setData({ ...data, registrations: {} });
    showToast("כל ההרשמות אופסו");
    try {
      await withTimeout(updateDoc(STATE_REF, { registrations: {} }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  const addReport = async (shiftId, text) => {
    if (!myName || !text.trim()) return;
    const newReport = { id: uid(), author: myName, text: text.trim(), timestamp: Date.now() };
    const prevData = data;
    const list = data.reports[shiftId] || [];
    setData({ ...data, reports: { ...data.reports, [shiftId]: [...list, newReport] } });
    showToast("הדיווח נשלח");
    try {
      await withTimeout(updateDoc(STATE_REF, { [`reports.${shiftId}`]: arrayUnion(newReport) }));
    } catch (e) {
      setData(prevData);
      showToast(e.message === "timeout" ? "החיבור לוקח יותר מדי זמן - הדיווח לא נשמר, נסה שוב" : "שגיאה בשמירה - נסה שוב");
    }
  };

  if (loading || pendingCreds === undefined) {
    return (
      <div style={{ background: COLORS.bg, color: COLORS.textMuted }} className="min-h-screen flex items-center justify-center p-6">
        {loadError ? (
          <div className="text-center max-w-xs">
            <p className="text-sm mb-4" style={{ color: COLORS.fullText }}>{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                setRefreshKey((k) => k + 1);
              }}
              className="rounded-xl px-5 py-2.5 font-bold text-sm"
              style={{ background: COLORS.accent, color: COLORS.accentText }}
            >
              נסה שוב
            </button>
          </div>
        ) : (
          "טוען..."
        )}
      </div>
    );
  }

  if (!myName) {
    return <AuthGate onSubmit={attemptAuth} error={authError} />;
  }

  return (
    <div dir="rtl" style={{ background: COLORS.bg, color: COLORS.textPrimary, fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" }} className="min-h-screen">
      <style>{`
        .mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace; }
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>

      <Header myName={myName} onLogout={logout} onRefresh={() => setRefreshKey((k) => k + 1)} />
      <TopTabs view={view} setView={setView} isAdmin={isAdmin} requestAdmin={requestAdmin} />

      <main className="max-w-md mx-auto px-4 pb-24 pt-4">
        <ErrorBoundary key={view}>
          {view === "calendar" && (
            <>
              <CalendarNav mode={calendarMode} setMode={setCalendarMode} currentDate={currentDate} setCurrentDate={setCurrentDate} activeOnly={activeOnly} setActiveOnly={setActiveOnly} />
              <CalendarView
                mode={calendarMode}
                currentDate={currentDate}
                setCurrentDate={setCurrentDate}
                setMode={setCalendarMode}
                data={data}
                myName={myName}
                activeOnly={activeOnly}
                onSelect={(shift) => setSelectedShift({ ...shift, _registered: data.registrations[shift.id] || [] })}
              />
            </>
          )}
          {view === "mine" && (
            <MyShiftsView data={data} myName={myName} onSelect={(shift) => setSelectedShift({ ...shift, _registered: data.registrations[shift.id] || [] })} />
          )}
          {view === "info" && <GuidelinesView info={data.info} onSave={updateInfo} isAdmin={isAdmin} requestAdmin={requestAdmin} />}
          {view === "settings" && (
            <SettingsView templates={data.templates} onAdd={addTemplates} onDelete={deleteTemplate} onDone={() => setView("calendar")} onResetRegistrations={resetRegistrations} />
          )}
        </ErrorBoundary>
      </main>

      {selectedShift && (
        <ShiftModal
          shift={selectedShift}
          myName={myName}
          isAdmin={isAdmin}
          reports={data.reports[selectedShift.id] || []}
          onClose={() => setSelectedShift(null)}
          onRegister={register}
          onRegisterRecurring={registerRecurring}
          onUnregister={unregister}
          onAddReport={addReport}
        />
      )}

      {adminModalOpen && (
        <AdminUnlockModal
          hasCode={!!data.adminCode}
          error={adminError}
          onClose={() => {
            setAdminModalOpen(false);
            setAdminCallback(null);
            setAdminError(null);
          }}
          onSubmit={attemptAdminUnlock}
        />
      )}

      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-sm font-medium shadow-lg"
          style={{ background: COLORS.surfaceRaised, color: COLORS.textPrimary, border: `1px solid ${COLORS.border}` }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function AuthGate({ onSubmit, error }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");

  const handleSubmit = () => {
    if (!name.trim() || pin.length < 4) return;
    onSubmit(name, pin);
  };

  return (
    <div
      dir="rtl"
      style={{ background: COLORS.bg, color: COLORS.textPrimary, fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" }}
      className="min-h-screen flex items-center justify-center p-4"
    >
      <style>{`.mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace; }`}</style>
      <div className="w-full max-w-sm rounded-2xl p-6" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-1" style={{ color: COLORS.accentText }}>
          <ShieldCheck size={22} />
          <span className="text-xs tracking-widest font-bold mono" style={{ color: COLORS.textMuted }}>רישום משמרות שמירה</span>
        </div>
        <h1 className="text-xl font-extrabold mt-2 mb-1">כניסה</h1>
        <p className="text-sm mb-4" style={{ color: COLORS.textMuted }}>
          הזן שם וקוד אישי בן 4 ספרות. בפעם הבאה תיכנס אוטומטית מהמכשיר הזה.
        </p>
        <div className="space-y-3 mb-2">
          <input
            autoFocus
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="שם מלא"
            className="w-full rounded-xl px-4 py-3 text-base outline-none"
            style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          />
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="קוד אישי (4 ספרות)"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            dir="ltr"
            className="w-full rounded-xl px-4 py-3 text-base outline-none text-center mono tracking-[0.5em]"
            style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          />
        </div>
        {error && <p className="text-xs mb-3" style={{ color: COLORS.fullText }}>{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || pin.length < 4}
          className="w-full rounded-xl py-3 font-bold text-base disabled:opacity-40"
          style={{ background: COLORS.accent, color: COLORS.accentText }}
        >
          כניסה
        </button>
        <p className="text-[11px] mt-3" style={{ color: COLORS.textMuted }}>
          שם חדש? הקוד שתבחר ישמש אותך גם בכניסות הבאות ומכל מכשיר.
        </p>
      </div>
    </div>
  );
}

function Header({ myName, onLogout, onRefresh }) {
  return (
    <header className="sticky top-0 z-20 backdrop-blur" style={{ background: "rgba(241,245,249,0.92)", borderBottom: `1px solid ${COLORS.border}` }}>
      <div className="max-w-md mx-auto px-4 pt-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2" style={{ color: COLORS.accentText }}>
          <ShieldCheck size={20} />
          <span className="font-extrabold text-base">משמרות שמירה</span>
        </div>
        <div className="flex items-center gap-2 text-xs" style={{ color: COLORS.textMuted }}>
          <button onClick={onRefresh} className="flex items-center gap-1" style={{ color: COLORS.accentText }} aria-label="רענון">
            <RefreshCw size={13} />
          </button>
          <User size={13} />
          <span>{myName}</span>
          <button onClick={onLogout} className="flex items-center gap-1 underline underline-offset-2" style={{ color: COLORS.accentText }}>
            <LogOut size={12} /> יציאה
          </button>
        </div>
      </div>
    </header>
  );
}

function TopTabs({ view, setView, isAdmin, requestAdmin }) {
  const tabs = [
    { id: "calendar", label: "יומן" },
    { id: "mine", label: "השמירות שלי" },
    { id: "info", label: "הנחיות" },
    { id: "settings", label: "ניהול" },
  ];
  const handleClick = (id) => {
    if (id === "settings" && !isAdmin) {
      requestAdmin(() => setView("settings"));
      return;
    }
    setView(id);
  };
  return (
    <div className="sticky z-20" style={{ top: 61, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}` }}>
      <div className="max-w-md mx-auto px-2 flex gap-1 pt-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => handleClick(t.id)}
            className="flex-1 text-xs sm:text-sm font-bold py-2.5 rounded-t-lg px-1"
            style={{
              color: view === t.id ? COLORS.accentText : COLORS.textMuted,
              borderBottom: `2px solid ${view === t.id ? COLORS.accent : "transparent"}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarNav({ mode, setMode, currentDate, setCurrentDate, activeOnly, setActiveOnly }) {
  const modes = [
    { id: "month", label: "חודש" },
    { id: "week", label: "שבוע" },
    { id: "day", label: "יום" },
    { id: "list", label: "רשימה" },
  ];

  const step = (dir) => {
    if (mode === "day") setCurrentDate(addDays(currentDate, dir));
    else if (mode === "week") setCurrentDate(addDays(currentDate, dir * 7));
    else setCurrentDate(addMonths(currentDate, dir));
  };

  const goToday = () => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    setCurrentDate(t);
  };

  let label;
  if (mode === "day") label = `יום ${DAY_NAMES[currentDate.getDay()]}, ${fmtDateLabel(currentDate)}`;
  else if (mode === "week") {
    const ws = startOfWeek(currentDate);
    label = `${fmtDateLabel(ws)} – ${fmtDateLabel(addDays(ws, 6))}`;
  } else if (mode === "month") label = `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
  else label = "כל המשמרות הקרובות";

  return (
    <div className="mb-4 pt-3">
      <div className="flex rounded-lg overflow-hidden mb-3" style={{ border: `1px solid ${COLORS.border}` }}>
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className="flex-1 text-xs font-bold py-2"
            style={{
              background: mode === m.id ? COLORS.accent : COLORS.surface,
              color: mode === m.id ? COLORS.accentText : COLORS.textMuted,
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode !== "month" && (
        <div className="flex rounded-lg overflow-hidden mb-3" style={{ border: `1px solid ${COLORS.border}` }}>
          <button
            onClick={() => setActiveOnly(false)}
            className="flex-1 text-[11px] font-bold py-1.5"
            style={{ background: !activeOnly ? COLORS.surfaceRaised : COLORS.surface, color: !activeOnly ? COLORS.textPrimary : COLORS.textMuted }}
          >
            כל המשמרות
          </button>
          <button
            onClick={() => setActiveOnly(true)}
            className="flex-1 text-[11px] font-bold py-1.5"
            style={{ background: activeOnly ? COLORS.surfaceRaised : COLORS.surface, color: activeOnly ? COLORS.textPrimary : COLORS.textMuted }}
          >
            רק עם נרשמים
          </button>
        </div>
      )}
      {mode === "list" ? (
        <div className="text-center text-sm font-bold" style={{ color: COLORS.textMuted }}>{label}</div>
      ) : (
        <div className="flex items-center justify-between">
          <button onClick={() => step(-1)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: COLORS.surfaceRaised, color: COLORS.textMuted }}>
            <ChevronLeft size={16} style={{ transform: "rotate(180deg)" }} />
          </button>
          <button onClick={goToday} className="text-center">
            <div className="font-extrabold text-sm mono">{label}</div>
            <div className="text-[10px]" style={{ color: COLORS.accentText }}>היום</div>
          </button>
          <button onClick={() => step(1)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: COLORS.surfaceRaised, color: COLORS.textMuted }}>
            <ChevronLeft size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function CapacityDots({ taken, capacity, tone }) {
  const dots = Array.from({ length: capacity }, (_, i) => i < taken);
  return (
    <div className="flex gap-1">
      {dots.map((filled, i) => (
        <span key={i} className="inline-block rounded-full" style={{ width: 7, height: 7, background: filled ? tone : "transparent", border: `1.5px solid ${tone}` }} />
      ))}
    </div>
  );
}

function ShiftBlock({ shift, registered, onSelect }) {
  const taken = registered.length;
  const isFull = taken >= shift.capacity;
  const shiftDate = new Date(shift.date + "T00:00:00");
  const past = isPastDate(shiftDate);
  const tone = past ? COLORS.border : isFull ? COLORS.full : COLORS.open;
  const toneText = past ? COLORS.textMuted : isFull ? COLORS.fullText : COLORS.openText;

  return (
    <button
      onClick={() => onSelect(shift)}
      className="w-full text-right rounded-xl p-3 flex flex-col gap-2 transition-transform active:scale-[0.98]"
      style={{ background: past ? COLORS.surfaceRaised : `${tone}33`, border: `1px solid ${tone}`, borderInlineStart: `4px solid ${tone}`, opacity: past ? 0.75 : 1 }}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm truncate">{shift.label || "משמרת"}</div>
          <div className="mono text-xs mt-0.5" style={{ color: COLORS.textMuted }}>{shift.start} – {shift.end}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full mono" style={{ background: COLORS.surface, color: toneText }}>
            {past ? "עבר" : isFull ? "מלא" : `${taken}/${shift.capacity}`}
          </span>
          {!past && <CapacityDots taken={taken} capacity={shift.capacity} tone={toneText} />}
        </div>
      </div>
      <div className="text-xs truncate text-right" style={{ color: COLORS.textMuted }}>
        {registered.length > 0 ? registered.join(", ") : "אין נרשמים עדיין"}
      </div>
    </button>
  );
}

function filterActiveShifts(shifts, registrations) {
  return shifts.filter((s) => (registrations[s.id] || []).length > 0);
}

function DayGroup({ date, shifts, data, onSelect, emptyMessage }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 px-1">
        <span
          className="text-xs font-extrabold px-2 py-0.5 rounded-md mono"
          style={{ background: isToday(date) ? COLORS.accent : "transparent", color: isToday(date) ? COLORS.accentText : COLORS.textMuted }}
        >
          {DAY_NAMES[date.getDay()]}
        </span>
        <span className="text-xs mono" style={{ color: COLORS.textMuted }}>{fmtDateLabel(date)}</span>
      </div>
      {shifts.length === 0 ? (
        <p className="text-xs px-1" style={{ color: COLORS.textMuted }}>{emptyMessage || "אין משמרות ביום זה"}</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((shift) => (
            <ShiftBlock key={shift.id} shift={shift} registered={data.registrations[shift.id] || []} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function MonthGrid({ currentDate, data, onPickDay }) {
  const monthStart = startOfMonth(currentDate);
  const gridStart = startOfWeek(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const month = currentDate.getMonth();

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_NAMES.map((d) => (
          <div key={d} className="text-center text-[10px] font-bold" style={{ color: COLORS.textMuted }}>{d.slice(0, 2)}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((date) => {
          const shifts = shiftsForDate(data.templates, date);
          const inMonth = date.getMonth() === month;
          const anyOpen = shifts.some((s) => (data.registrations[s.id] || []).length < s.capacity);
          const anyShift = shifts.length > 0;
          const dotColor = !anyShift ? null : anyOpen ? COLORS.openText : COLORS.fullText;
          return (
            <button
              key={fmtDate(date)}
              onClick={() => onPickDay(date)}
              className="aspect-square rounded-lg flex flex-col items-center justify-center gap-1"
              style={{ background: isToday(date) ? COLORS.accent : COLORS.surface, border: `1px solid ${COLORS.border}`, opacity: inMonth ? 1 : 0.4 }}
            >
              <span className="text-xs mono font-bold" style={{ color: isToday(date) ? COLORS.accentText : COLORS.textPrimary }}>{date.getDate()}</span>
              <span className="rounded-full" style={{ width: 5, height: 5, background: dotColor || "transparent" }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CalendarView({ mode, currentDate, setCurrentDate, setMode, data, myName, activeOnly, onSelect }) {
  if (data.templates.length === 0) {
    return (
      <div className="text-center py-16" style={{ color: COLORS.textMuted }}>
        <ShieldCheck size={36} className="mx-auto mb-3 opacity-40" />
        <p className="font-bold mb-1">עדיין לא הוגדרו משמרות</p>
        <p className="text-sm">עברו ל"ניהול" כדי להוסיף משמרות</p>
      </div>
    );
  }

  const applyFilter = (shifts) => (activeOnly ? filterActiveShifts(shifts, data.registrations) : shifts);
  const emptyMsg = activeOnly ? "אין משמרות עם נרשמים ביום זה" : undefined;

  if (mode === "day") {
    return <DayGroup date={currentDate} shifts={applyFilter(shiftsForDate(data.templates, currentDate))} data={data} onSelect={onSelect} emptyMessage={emptyMsg} />;
  }
  if (mode === "week") {
    const ws = startOfWeek(currentDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    return (
      <div className="space-y-5">
        {days.map((date) => (
          <DayGroup key={fmtDate(date)} date={date} shifts={applyFilter(shiftsForDate(data.templates, date))} data={data} onSelect={onSelect} emptyMessage={emptyMsg} />
        ))}
      </div>
    );
  }
  if (mode === "list") {
    const days = generateUpcoming(data.templates, 30)
      .map(({ date, shifts }) => ({ date, shifts: applyFilter(shifts) }))
      .filter(({ shifts }) => shifts.length > 0);
    if (days.length === 0) {
      return (
        <p className="text-sm text-center py-8" style={{ color: COLORS.textMuted }}>
          {activeOnly ? "אין משמרות עם נרשמים בקרוב" : "אין משמרות קרובות"}
        </p>
      );
    }
    return (
      <div className="space-y-5">
        {days.map(({ date, shifts }) => (
          <DayGroup key={fmtDate(date)} date={date} shifts={shifts} data={data} onSelect={onSelect} />
        ))}
      </div>
    );
  }
  return (
    <div>
      <MonthGrid currentDate={currentDate} data={data} onPickDay={(date) => { setCurrentDate(date); setMode("day"); }} />
      <p className="text-[11px] text-center mt-3" style={{ color: COLORS.textMuted }}>לחצו על תאריך כדי לראות ולהירשם למשמרות של אותו יום</p>
    </div>
  );
}

function MyShiftsView({ data, myName, onSelect }) {
  const days = generateUpcoming(data.templates, 60);
  const grouped = days
    .map(({ date, shifts }) => ({
      date,
      shifts: shifts.filter((s) => (data.registrations[s.id] || []).includes(myName)),
    }))
    .filter((d) => d.shifts.length > 0);

  if (grouped.length === 0) {
    return (
      <div className="text-center py-16" style={{ color: COLORS.textMuted }}>
        <User size={32} className="mx-auto mb-3 opacity-40" />
        <p className="font-bold mb-1">עדיין לא נרשמת לאף משמרת</p>
        <p className="text-sm">עברו ליומן ובחרו משמרת פנויה</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {grouped.map(({ date, shifts }) => (
        <DayGroup key={fmtDate(date)} date={date} shifts={shifts} data={data} onSelect={onSelect} />
      ))}
    </div>
  );
}

function ShiftModal({ shift, myName, isAdmin, reports, onClose, onRegister, onRegisterRecurring, onUnregister, onAddReport }) {
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurEnd, setRecurEnd] = useState("");
  const [reportText, setReportText] = useState("");
  const registered = shift._registered || [];
  const taken = registered.length;
  const isFull = taken >= shift.capacity;
  const iAmIn = registered.includes(myName);
  const dateObj = new Date(shift.date + "T00:00:00");
  const past = isPastDate(dateObj);

  const visibleReports = (reports || []).filter((r) => isAdmin || r.author === myName);

  const handleRegister = () => {
    onRegister(shift);
    onClose();
  };
  const handleUnregister = () => {
    onUnregister(shift);
    onClose();
  };
  const handleRecurring = () => {
    onRegisterRecurring(shift, recurEnd);
    onClose();
  };
  const handleSubmitReport = () => {
    if (!reportText.trim()) return;
    onAddReport(shift.id, reportText);
    setReportText("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: "rgba(55,69,79,0.45)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-5" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-xs mono mb-1" style={{ color: COLORS.textMuted }}>{DAY_NAMES[dateObj.getDay()]}, {fmtDateLabel(dateObj)}</div>
            <h2 className="text-lg font-extrabold">{shift.label || "משמרת"}</h2>
            <div className="mono text-sm mt-1" style={{ color: COLORS.accentText }}>{shift.start} – {shift.end}</div>
          </div>
          <button onClick={onClose} style={{ color: COLORS.textMuted }}><X size={20} /></button>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold" style={{ color: COLORS.textMuted }}>נרשמים ({taken}/{shift.capacity})</span>
            <CapacityDots taken={taken} capacity={shift.capacity} tone={isFull ? COLORS.fullText : COLORS.openText} />
          </div>
          {registered.length === 0 ? (
            <p className="text-sm" style={{ color: COLORS.textMuted }}>אף אחד עדיין לא נרשם</p>
          ) : (
            <ul className="space-y-1.5">
              {registered.map((name) => (
                <li key={name} className="flex items-center justify-between text-sm rounded-lg px-3 py-2" style={{ background: COLORS.surfaceRaised }}>
                  <span className={name === myName ? "font-bold" : ""} style={{ color: name === myName ? COLORS.accentText : COLORS.textPrimary }}>
                    {name} {name === myName && "(אני)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {past ? (
          <p className="text-sm text-center py-2" style={{ color: COLORS.textMuted }}>משמרת זו כבר עברה</p>
        ) : iAmIn ? (
          <button
            onClick={handleUnregister}
            className="w-full rounded-xl py-3 font-bold text-sm"
            style={{ background: `${COLORS.full}55`, color: COLORS.fullText, border: `1px solid ${COLORS.full}` }}
          >
            בטל את ההרשמה שלי
          </button>
        ) : isFull ? (
          <button disabled className="w-full rounded-xl py-3 font-bold text-sm opacity-60" style={{ background: COLORS.surfaceRaised, color: COLORS.textMuted }}>
            המשמרת מלאה
          </button>
        ) : (
          <div className="space-y-2">
            <button
              onClick={handleRegister}
              className="w-full rounded-xl py-3 font-bold text-sm"
              style={{ background: COLORS.accent, color: COLORS.accentText }}
            >
              הירשם למשמרת הזו בלבד
            </button>
            {!showRecurring ? (
              <button onClick={() => setShowRecurring(true)} className="w-full text-xs font-bold py-2" style={{ color: COLORS.accentText }}>
                הרשמה קבועה (כל שבוע) עד תאריך →
              </button>
            ) : (
              <div className="rounded-xl p-3 space-y-2" style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}` }}>
                <label className="text-xs font-bold block" style={{ color: COLORS.textMuted }}>
                  הרשמה קבועה כל {DAY_NAMES[dateObj.getDay()]} ב-{shift.start}, עד תאריך:
                </label>
                <input
                  type="date"
                  dir="ltr"
                  value={recurEnd}
                  min={shift.date}
                  onChange={(e) => setRecurEnd(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none mono"
                  style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
                />
                <button
                  onClick={handleRecurring}
                  disabled={!recurEnd}
                  className="w-full rounded-lg py-2.5 font-bold text-sm disabled:opacity-40"
                  style={{ background: COLORS.accent, color: COLORS.accentText }}
                >
                  אשר הרשמה קבועה
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <h3 className="text-xs font-bold mb-2" style={{ color: COLORS.textMuted }}>דיווח מהמשמרת</h3>

          {visibleReports.length > 0 && (
            <ul className="space-y-2 mb-3">
              {visibleReports.map((r) => (
                <li key={r.id} className="rounded-lg px-3 py-2 text-sm" style={{ background: COLORS.surfaceRaised }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-xs" style={{ color: COLORS.accentText }}>{r.author}</span>
                    <span className="text-[10px] mono" style={{ color: COLORS.textMuted }}>
                      {new Date(r.timestamp).toLocaleDateString("he-IL")} {new Date(r.timestamp).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap" style={{ color: COLORS.textPrimary }}>{r.text}</p>
                </li>
              ))}
            </ul>
          )}

          <textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            placeholder="דגשים, הערות או ממצאים מהשמירה..."
            rows={3}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none mb-2"
            style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          />
          <button
            onClick={handleSubmitReport}
            disabled={!reportText.trim()}
            className="w-full rounded-lg py-2 font-bold text-sm disabled:opacity-40"
            style={{ background: COLORS.surfaceRaised, color: COLORS.accentText, border: `1px solid ${COLORS.accent}` }}
          >
            שלח דיווח
          </button>
          <p className="text-[10px] mt-1.5" style={{ color: COLORS.textMuted }}>הדיווח גלוי רק לך ולמנהל.</p>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ templates: rawTemplates, onAdd, onDelete, onDone, onResetRegistrations }) {
  const templates = Array.isArray(rawTemplates) ? rawTemplates : [];
  const [showForm, setShowForm] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [form, setForm] = useState({ label: "", days: [0], start: "20:00", end: "06:00", capacity: 2 });

  const toggleDay = (i) => {
    setForm((f) => {
      const has = f.days.includes(i);
      return { ...f, days: has ? f.days.filter((d) => d !== i) : [...f.days, i].sort() };
    });
  };

  const selectRange = (fromIdx, toIdx) => {
    const range = [];
    for (let i = fromIdx; i <= toIdx; i++) range.push(i);
    setForm((f) => ({ ...f, days: range }));
  };

  const submit = () => {
    if (!form.start || !form.end || form.capacity < 1 || form.days.length === 0) return;
    const { days, ...base } = form;
    onAdd({ ...base, capacity: Number(base.capacity) }, days); // fire-and-forget, UI reacts instantly
    setForm({ label: "", days: [0], start: "20:00", end: "06:00", capacity: 2 });
    setShowForm(false);
    onDone();
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await onResetRegistrations();
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-extrabold text-base">הגדרת משמרות</h2>
        <button onClick={() => setShowForm((s) => !s)} className="flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: COLORS.accent, color: COLORS.accentText }}>
          <Plus size={14} /> משמרת חדשה
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl p-4 mb-5 space-y-3" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          <Field label="שם המשמרת (אופציונלי)">
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="לדוגמה: שמירה ראשית" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }} />
          </Field>
          <Field label="ימים (אפשר לבחור כמה, למשל ראשון עד חמישי)">
            <div className="flex gap-1 flex-wrap">
              {DAY_NAMES.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className="w-9 h-9 rounded-lg text-xs font-bold"
                  style={{
                    background: form.days.includes(i) ? COLORS.accent : COLORS.bg,
                    color: form.days.includes(i) ? COLORS.accentText : COLORS.textMuted,
                    border: `1px solid ${form.days.includes(i) ? COLORS.accent : COLORS.border}`,
                  }}
                >
                  {d.slice(0, 2)}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => selectRange(0, 4)} className="text-[11px] font-bold mt-1.5" style={{ color: COLORS.accentText }}>
              בחר ראשון-חמישי
            </button>
          </Field>
          <div className="flex gap-3">
            <Field label="שעת התחלה">
              <input type="time" dir="ltr" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm outline-none mono" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }} />
            </Field>
            <Field label="שעת סיום">
              <input type="time" dir="ltr" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm outline-none mono" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }} />
            </Field>
          </div>
          <Field label="מספר מקומות">
            <input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm outline-none mono" style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }} />
          </Field>
          <button onClick={submit} disabled={form.days.length === 0} className="w-full rounded-lg py-2.5 font-bold text-sm mt-1 disabled:opacity-40" style={{ background: COLORS.accent, color: COLORS.accentText }}>
            שמור משמרת{form.days.length > 1 ? ` (${form.days.length} ימים)` : ""}
          </button>
        </div>
      )}

      {templates.length > 0 && (
        <button onClick={onDone} className="w-full text-center text-xs font-bold py-2 mb-4 rounded-lg" style={{ color: COLORS.accentText, background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          ← למעבר ליומן ולהרשמה למשמרות
        </button>
      )}

      {templates.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: COLORS.textMuted }}>אין משמרות מוגדרות עדיין</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-xl p-3" style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}` }}>
              <div>
                <div className="font-bold text-sm">{t.label || "משמרת"}</div>
                <div className="text-xs mt-0.5" style={{ color: COLORS.textMuted }}>
                  יום {DAY_NAMES[t.dayOfWeek]} · <span className="mono">{t.start}–{t.end}</span> · {t.capacity} מקומות
                </div>
              </div>
              <button onClick={() => onDelete(t.id)} style={{ color: COLORS.fullText }} aria-label="מחק"><Trash2 size={17} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 pt-4" style={{ borderTop: `1px solid ${COLORS.border}` }}>
        <h3 className="text-xs font-bold mb-2" style={{ color: COLORS.fullText }}>איפוס נתוני הרשמה</h3>
        <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>
          מוחק את כל ההרשמות של כולם למשמרות (לא מוחק את הגדרות המשמרות עצמן). פעולה בלתי הפיכה.
        </p>
        {!confirmingReset ? (
          <button
            onClick={() => setConfirmingReset(true)}
            className="text-xs font-bold px-3 py-2 rounded-lg"
            style={{ color: COLORS.fullText, background: COLORS.surface, border: `1px solid ${COLORS.full}` }}
          >
            אפס את כל ההרשמות
          </button>
        ) : (
          <div className="rounded-lg p-3 space-y-2" style={{ background: `${COLORS.full}22`, border: `1px solid ${COLORS.full}` }}>
            <p className="text-xs font-bold" style={{ color: COLORS.fullText }}>בטוח? זה ימחק את ההרשמות של כולם ולא ניתן לבטל.</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmingReset(false)}
                className="flex-1 rounded-lg py-2 text-xs font-bold"
                style={{ background: COLORS.surface, color: COLORS.textMuted, border: `1px solid ${COLORS.border}` }}
              >
                ביטול
              </button>
              <button
                onClick={handleReset}
                disabled={resetting}
                className="flex-1 rounded-lg py-2 text-xs font-bold disabled:opacity-60"
                style={{ background: COLORS.full, color: COLORS.fullText }}
              >
                {resetting ? "מאפס..." : "כן, אפס הכל"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GuidelinesView({ info, onSave, isAdmin, requestAdmin }) {
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(info.instructions || "");
  const [notes, setNotes] = useState(info.notes || "");
  const [phones, setPhones] = useState(info.phones || []);
  const [newPhoneName, setNewPhoneName] = useState("");
  const [newPhoneNum, setNewPhoneNum] = useState("");

  const startEdit = () => {
    setInstructions(info.instructions || "");
    setNotes(info.notes || "");
    setPhones(info.phones || []);
    setEditing(true);
  };

  const addPhone = () => {
    if (!newPhoneName.trim() || !newPhoneNum.trim()) return;
    setPhones([...phones, { id: uid(), name: newPhoneName.trim(), phone: newPhoneNum.trim() }]);
    setNewPhoneName("");
    setNewPhoneNum("");
  };

  const save = async () => {
    await onSave({ instructions, notes, phones });
    setEditing(false);
  };

  if (!editing) {
    const hasContent = info.instructions || info.notes || (info.phones && info.phones.length > 0);
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold text-base">הנחיות כלליות</h2>
          <button onClick={() => (isAdmin ? startEdit() : requestAdmin(startEdit))} className="flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: COLORS.accent, color: COLORS.accentText }}>
            <Pencil size={13} /> עריכה
          </button>
        </div>

        {!hasContent && <p className="text-sm text-center py-8" style={{ color: COLORS.textMuted }}>עדיין לא הוזנו הנחיות</p>}

        {info.instructions && (
          <div className="rounded-xl p-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <h3 className="text-xs font-bold mb-2" style={{ color: COLORS.textMuted }}>הנחיות ביצוע הסיור</h3>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{info.instructions}</p>
          </div>
        )}

        {info.phones && info.phones.length > 0 && (
          <div className="rounded-xl p-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <h3 className="text-xs font-bold mb-2" style={{ color: COLORS.textMuted }}>מספרי טלפון</h3>
            <div className="space-y-2">
              {info.phones.map((p) => (
                <a key={p.id} href={`tel:${p.phone}`} className="flex items-center justify-between text-sm rounded-lg px-3 py-2" style={{ background: COLORS.surfaceRaised }}>
                  <span className="font-bold">{p.name}</span>
                  <span className="mono flex items-center gap-1" style={{ color: COLORS.accentText }} dir="ltr">
                    <Phone size={13} /> {p.phone}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {info.notes && (
          <div className="rounded-xl p-4" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            <h3 className="text-xs font-bold mb-2" style={{ color: COLORS.textMuted }}>הערות כלליות</h3>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{info.notes}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-extrabold text-base">עריכת הנחיות</h2>

      <Field label="הנחיות ביצוע הסיור">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          placeholder="לדוגמה: יש לעבור בציר המערבי, לבדוק את השער הראשי..."
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        />
      </Field>

      <Field label="מספרי טלפון">
        <div className="space-y-2 mb-2">
          {phones.map((p) => (
            <div key={p.id} className="flex items-center justify-between text-sm rounded-lg px-3 py-2" style={{ background: COLORS.surfaceRaised }}>
              <span>{p.name} <span className="mono" style={{ color: COLORS.textMuted }} dir="ltr">{p.phone}</span></span>
              <button onClick={() => setPhones(phones.filter((x) => x.id !== p.id))} style={{ color: COLORS.fullText }}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newPhoneName}
            onChange={(e) => setNewPhoneName(e.target.value)}
            placeholder="שם / תפקיד"
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          />
          <input
            value={newPhoneNum}
            onChange={(e) => setNewPhoneNum(e.target.value)}
            placeholder="טלפון"
            dir="ltr"
            className="w-28 rounded-lg px-3 py-2 text-sm outline-none mono"
            style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          />
          <button onClick={addPhone} className="px-3 rounded-lg" style={{ background: COLORS.accent, color: COLORS.accentText }}>
            <Plus size={16} />
          </button>
        </div>
      </Field>

      <Field label="הערות כלליות">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="לדוגמה: יש להחזיר את הציוד לעמדה בסיום המשמרת..."
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        />
      </Field>

      <div className="flex gap-2">
        <button onClick={() => setEditing(false)} className="flex-1 rounded-lg py-2.5 font-bold text-sm" style={{ background: COLORS.surfaceRaised, color: COLORS.textMuted, border: `1px solid ${COLORS.border}` }}>
          ביטול
        </button>
        <button onClick={save} className="flex-1 rounded-lg py-2.5 font-bold text-sm" style={{ background: COLORS.accent, color: COLORS.accentText }}>
          שמירה
        </button>
      </div>
    </div>
  );
}

function AdminUnlockModal({ hasCode, error, onClose, onSubmit }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(code);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: "rgba(55,69,79,0.45)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-6" style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-lg font-extrabold">גישת ניהול</h2>
          <button onClick={onClose} style={{ color: COLORS.textMuted }}><X size={20} /></button>
        </div>
        <p className="text-sm mb-4" style={{ color: COLORS.textMuted }}>
          {hasCode
            ? "פעולה זו דורשת את קוד הניהול המשותף."
            : "עדיין לא הוגדר קוד ניהול. הקוד שתזין כאן יהפוך לקוד הניהול הקבוע - שמור אותו ושתף רק עם מי שצריך."}
        </p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="קוד ניהול"
          dir="ltr"
          className="w-full rounded-xl px-4 py-3 text-base outline-none text-center mono tracking-[0.3em] mb-2"
          style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        />
        {error && <p className="text-xs mb-3" style={{ color: COLORS.fullText }}>{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={code.length < 4 || submitting}
          className="w-full rounded-xl py-3 font-bold text-base disabled:opacity-40"
          style={{ background: COLORS.accent, color: COLORS.accentText }}
        >
          {submitting ? "בודק..." : hasCode ? "אישור" : "הגדרת קוד ניהול"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-bold block mb-1" style={{ color: COLORS.textMuted }}>{label}</label>
      {children}
    </div>
  );
}
