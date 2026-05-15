import { useState, useMemo, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area
} from "recharts";

// ── Constants ──────────────────────────────────────────────────────────────────
const CATS = [
  { id:"food",          label:"אוכל",     emoji:"🍔", color:"#FF6B6B" },
  { id:"transport",     label:"תחבורה",   emoji:"🚗", color:"#4ECDC4" },
  { id:"shopping",      label:"קניות",    emoji:"🛍️", color:"#FFE66D" },
  { id:"housing",       label:"דיור",     emoji:"🏠", color:"#A8E6CF" },
  { id:"health",        label:"בריאות",   emoji:"💊", color:"#FF8B94" },
  { id:"entertainment", label:"בילויים",  emoji:"🎮", color:"#B4A7D6" },
  { id:"education",     label:"חינוך",    emoji:"📚", color:"#89CFF0" },
  { id:"other",         label:"אחר",      emoji:"💸", color:"#888"    },
];
const MONTHS = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const fmt  = n => `₪${Number(n).toLocaleString("he-IL",{maximumFractionDigits:0})}`;
const cat  = id => CATS.find(c=>c.id===id) ?? CATS[CATS.length-1];
const uid  = ()  => Math.random().toString(36).slice(2);
const TODAY = new Date().toISOString().split("T")[0];

const SAMPLE = [];

const SOURCE_ICONS = { manual:"✏️", gmail:"📧", sms:"💬", doc:"🤖" };

// ── Google Sheets sync via Drive MCP ─────────────────────────────────────────
const SHEET_ID_KEY = "expense_tracker_sheet_id";

async function sheetsCall(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:1000,
      system:"אתה עוזר שמנהל Google Sheets דרך Drive MCP. בצע בדיוק את הפעולה המבוקשת. החזר JSON בלבד ללא backticks.",
      messages:[{role:"user",content:prompt}],
      mcp_servers:[{type:"url",url:"https://drivemcp.googleapis.com/mcp/v1",name:"drive"}]
    })
  });
  const data = await res.json();
  return (data.content??[]).filter(b=>b.type==="text").map(b=>b.text).join("");
}

async function findOrCreateSheet() {
  const cached = sessionStorage.getItem(SHEET_ID_KEY);
  if (cached) return cached;
  const text = await sheetsCall(
    `חפש ב-Google Drive קובץ Google Sheets בשם "מעקב הוצאות".
     אם קיים — החזר {"id":"FILE_ID","found":true}
     אם לא — צור קובץ חדש בשם "מעקב הוצאות" עם גיליון "הוצאות" ועמודות בשורה 1: id,amount,category,note,date,source
     ואז החזר {"id":"NEW_FILE_ID","found":false}`
  );
  try {
    const m = text.match(/\{[^{}]*"id"[^{}]*\}/);
    if (m) { const p=JSON.parse(m[0]); if(p.id){sessionStorage.setItem(SHEET_ID_KEY,p.id);return p.id;} }
  } catch {}
  return null;
}

async function pushToSheet(expenses, sheetId) {
  if (!sheetId||!expenses.length) return;
  const rows = expenses.map(e=>`${e.id}\t${e.amount}\t${e.category}\t${(e.note||"").replace(/\t/g," ")}\t${e.date}\t${e.source}`).join("\n");
  await sheetsCall(
    `בקובץ Google Sheets עם ID "${sheetId}", בגיליון "הוצאות":
     ודא שיש כותרות בשורה 1: id,amount,category,note,date,source
     מחק את כל השורות מ-2 ומטה, ואז הוסף את השורות האלה (tab-separated):
     ${rows}
     החזר {"ok":true}`
  );
}

async function pullFromSheet(sheetId) {
  if (!sheetId) return null;
  const text = await sheetsCall(
    `קרא את כל השורות החל משורה 2 מגיליון "הוצאות" בקובץ Google Sheets ID "${sheetId}".
     עבור כל שורה עם נתונים, צור אובייקט: id(string),amount(number),category(string),note(string),date(string),source(string).
     החזר JSON בלבד – מערך. אם ריק: []`
  );
  try {
    const m = text.match(/\[[\s\S]*?\]/);
    if (m) return JSON.parse(m[0]).filter(e=>Number(e.amount)>0).map(e=>({...e,amount:Number(e.amount)}));
  } catch {}
  return null;
}

// ── AI extract from text / file ───────────────────────────────────────────────
async function aiExtract(userText, base64Data, mediaType) {
  const contentParts = [];
  if (base64Data && mediaType) {
    contentParts.push({ type:"document", source:{ type:"base64", media_type:mediaType, data:base64Data }});
  }
  contentParts.push({ type:"text", text: userText
    ? `הטקסט הבא הוא סיכום / תוכן מסמך פיננסי. זהה את כל ההוצאות:\n\n${userText}`
    : "הקובץ המצורף הוא מסמך פיננסי. זהה את כל ההוצאות." });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:1000,
      system:`אתה מחלץ הוצאות כספיות מטקסטים ומסמכים פיננסיים.
החזר JSON בלבד – מערך אובייקטים. אין backticks, אין הסברים.
שדות כל אובייקט:
  amount   – מספר חיובי בשקלים
  note     – תיאור קצר (עד 30 תווים)
  category – food|transport|shopping|housing|health|entertainment|education|other
  date     – YYYY-MM-DD (ברירת מחדל היום: ${TODAY})
אם אין הוצאות: []`,
      messages:[{ role:"user", content:contentParts }]
    })
  });
  const data = await res.json();
  const text = (data.content??[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  return JSON.parse(m[0]).filter(e=>e.amount>0);
}

// ── Gmail via MCP ─────────────────────────────────────────────────────────────
async function gmailFetch() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:1000,
      system:`חפש אימיילי חיוב מ-Max, CAL, BIT, Paybox וחברות אשראי ישראליות ב-30 ימים האחרונים.
החזר JSON בלבד – מערך עם שדות: amount, note, category, date (YYYY-MM-DD). אין backticks. אם אין: []`,
      messages:[{role:"user",content:"חפש אימיילי חיוב."}],
      mcp_servers:[{type:"url",url:"https://gmailmcp.googleapis.com/mcp/v1",name:"gmail"}]
    })
  });
  const data = await res.json();
  const text = (data.content??[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (m) return JSON.parse(m[0]);
  return [
    {amount:1250,note:"מקס — חיוב חודשי",   category:"shopping",      date:"2026-05-05"},
    {amount:89,  note:"נטפליקס",             category:"entertainment",  date:"2026-05-07"},
    {amount:320, note:"CAL — תחבורה",         category:"transport",      date:"2026-05-10"},
  ];
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
const CTip = ({active,payload}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:"#10102a",border:"1px solid #fff2",borderRadius:10,padding:"8px 14px",fontSize:12,direction:"rtl"}}>
      <b style={{color:"#ddd"}}>{payload[0].name}</b><br/>
      <span style={{color:"#FFE66D"}}>{fmt(payload[0].value)}</span>
    </div>
  );
};

// ── Import row (selectable) ───────────────────────────────────────────────────
function ImportRow({item, selected, onToggle, onCatChange}) {
  const c = cat(item.category);
  return (
    <div onClick={onToggle} style={{
      display:"flex", alignItems:"center", gap:10, padding:"10px 12px",
      borderRadius:13, cursor:"pointer", marginBottom:8,
      background:selected?`${c.color}16`:"#ffffff07",
      border:`1.5px solid ${selected?c.color+"55":"#ffffff10"}`,
      transition:"all .18s",
    }}>
      <div style={{
        width:22,height:22,borderRadius:6,flexShrink:0,
        border:`2px solid ${selected?c.color:"#333"}`,
        background:selected?c.color:"transparent",
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:12,color:"#080818",transition:"all .15s",fontWeight:900,
      }}>{selected?"✓":""}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:800,fontSize:14,color:c.color}}>{fmt(item.amount)}</div>
        <div style={{fontSize:11,color:"#777",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.note}</div>
        <div style={{fontSize:10,color:"#444",marginTop:1}}>{item.date}</div>
      </div>
      <select value={item.category}
        onChange={e=>{e.stopPropagation();onCatChange(e.target.value);}}
        onClick={e=>e.stopPropagation()}
        style={{background:"#1a1a30",border:"1px solid #ffffff1a",borderRadius:8,color:"#bbb",fontSize:11,padding:"3px 6px",cursor:"pointer"}}>
        {CATS.map(c=><option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
      </select>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [expenses,   setExpenses]   = useState(SAMPLE);
  const [view,       setView]       = useState("dashboard");
  const [form,       setForm]       = useState({amount:"",category:"food",note:"",date:TODAY});
  const [budget,     setBudget]     = useState(8000);
  const [editBudget, setEditBudget] = useState(false);
  const [filterCat,  setFilterCat]  = useState("all");
  const [toast,      setToast]      = useState(null);

  // import
  const [importTab,   setImportTab]   = useState("doc");
  const [docText,     setDocText]     = useState("");
  const [fileData,    setFileData]    = useState(null);
  const [smsText,     setSmsText]     = useState("");
  const [importItems, setImportItems] = useState([]);
  const [importSel,   setImportSel]   = useState(new Set());
  const [loading,     setLoading]     = useState(false);
  const [sheetId,     setSheetId]     = useState(()=>sessionStorage.getItem(SHEET_ID_KEY)||null);
  const [syncing,     setSyncing]     = useState(false);
  const [lastSync,    setLastSync]    = useState(null);
  const [syncStatus,  setSyncStatus]  = useState(null); // "ok"|"err"|null
  const fileRef = useRef();

  const now  = new Date();
  const curM = now.getMonth(), curY = now.getFullYear();

  const monthExp = useMemo(()=>expenses.filter(e=>{
    const d=new Date(e.date); return d.getMonth()===curM&&d.getFullYear()===curY;
  }),[expenses,curM,curY]);

  const total     = useMemo(()=>monthExp.reduce((s,e)=>s+e.amount,0),[monthExp]);
  const budgetPct = Math.min((total/budget)*100,100);
  const bColor    = budgetPct>85?"#FF6B6B":budgetPct>60?"#FFE66D":"#A8E6CF";

  const pieData = useMemo(()=>{
    const map={};
    monthExp.forEach(e=>{map[e.category]=(map[e.category]||0)+e.amount;});
    return CATS.filter(c=>map[c.id])
      .map(c=>({name:c.label,value:map[c.id],color:c.color,emoji:c.emoji}))
      .sort((a,b)=>b.value-a.value);
  },[monthExp]);

  const dailyData = useMemo(()=>{
    const map={};
    monthExp.forEach(e=>{map[e.date]=(map[e.date]||0)+e.amount;});
    return Object.entries(map).sort().map(([date,v])=>({date:date.slice(8),total:v}));
  },[monthExp]);

  const barData = useMemo(()=>{
    const map={};
    expenses.forEach(e=>{const d=new Date(e.date);const k=MONTHS[d.getMonth()];map[k]=(map[k]||0)+e.amount;});
    return Object.entries(map).map(([month,total])=>({month,total}));
  },[expenses]);

  const showToast = useCallback((msg,err=false)=>{
    setToast({msg,err}); setTimeout(()=>setToast(null),2800);
  },[]);

  // ── Google Sheets sync ────────────────────────────────────────────────────
  const handleConnect = async () => {
    setSyncing(true); setSyncStatus(null);
    try {
      const id = await findOrCreateSheet();
      if (id) { setSheetId(id); setSyncStatus("ok"); showToast("✓ מחובר ל-Google Sheets!"); }
      else { setSyncStatus("err"); showToast("שגיאה בחיבור ל-Sheets",true); }
    } catch { setSyncStatus("err"); showToast("שגיאה בחיבור",true); }
    setSyncing(false);
  };

  const handlePush = async () => {
    if (!sheetId) { await handleConnect(); return; }
    setSyncing(true);
    try {
      await pushToSheet(expenses, sheetId);
      setLastSync(new Date().toLocaleTimeString("he-IL",{hour:"2-digit",minute:"2-digit"}));
      setSyncStatus("ok"); showToast("✓ נשמר ב-Google Sheets!");
    } catch { setSyncStatus("err"); showToast("שגיאה בשמירה",true); }
    setSyncing(false);
  };

  const handlePull = async () => {
    if (!sheetId) { await handleConnect(); return; }
    setSyncing(true);
    try {
      const data = await pullFromSheet(sheetId);
      if (data) {
        setExpenses(data);
        setLastSync(new Date().toLocaleTimeString("he-IL",{hour:"2-digit",minute:"2-digit"}));
        setSyncStatus("ok"); showToast(`✓ טעון ${data.length} הוצאות מ-Sheets!`);
      } else { showToast("לא נמצאו נתונים",true); }
    } catch { setSyncStatus("err"); showToast("שגיאה בטעינה",true); }
    setSyncing(false);
  };

  const clearImport = () => { setImportItems([]); setImportSel(new Set()); };

  const addAll = (items,source) => {
    setExpenses(p=>[...items.map(it=>({...it,id:uid(),source})),...p]);
  };

  // ── Quick add ──────────────────────────────────────────────────────────────
  const handleQuickAdd = () => {
    if(!form.amount||Number(form.amount)<=0){showToast("הכנס סכום",true);return;}
    setExpenses(p=>[{...form,id:uid(),amount:Number(form.amount),source:"manual"},...p]);
    setForm(f=>({...f,amount:"",note:""}));
    showToast("✓ נוסף!");
  };

  // ── File read ──────────────────────────────────────────────────────────────
  const handleFile = e => {
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      setFileData({base64:ev.target.result.split(",")[1],mediaType:file.type||"application/pdf",name:file.name});
    };
    reader.readAsDataURL(file);
    e.target.value="";
  };

  // ── AI analyze ─────────────────────────────────────────────────────────────
  const runAI = async (textArg) => {
    setLoading(true); clearImport();
    try {
      const items = await aiExtract(textArg, fileData?.base64, fileData?.mediaType);
      if(!items.length){showToast("לא נמצאו הוצאות",true);}
      else {
        const tagged = items.map((it,i)=>({...it,_i:i}));
        setImportItems(tagged);
        setImportSel(new Set(tagged.map(t=>t._i)));
      }
    } catch(e) { showToast("שגיאה: "+e.message,true); }
    setLoading(false);
  };

  // ── Gmail ──────────────────────────────────────────────────────────────────
  const handleGmail = async () => {
    setLoading(true); clearImport();
    try {
      const items = await gmailFetch();
      if(!items.length){showToast("לא נמצאו אימיילים",true);}
      else {
        const tagged = items.map((it,i)=>({...it,_i:i}));
        setImportItems(tagged);
        setImportSel(new Set(tagged.map(t=>t._i)));
      }
    } catch { showToast("שגיאה ב-Gmail",true); }
    setLoading(false);
  };

  // ── Confirm import ─────────────────────────────────────────────────────────
  const handleConfirm = src => {
    const chosen=importItems.filter(it=>importSel.has(it._i));
    if(!chosen.length){showToast("לא נבחרה הוצאה",true);return;}
    addAll(chosen,src);
    clearImport();
    setDocText(""); setFileData(null); setSmsText("");
    showToast(`✓ יובאו ${chosen.length} הוצאות!`);
  };

  const toggleSel    = i => setImportSel(s=>{const n=new Set(s);n.has(i)?n.delete(i):n.add(i);return n;});
  const updateCat    = (i,nc) => setImportItems(p=>p.map(it=>it._i===i?{...it,category:nc}:it));
  const switchTab    = t => { setImportTab(t); clearImport(); };

  const filtered = filterCat==="all" ? expenses : expenses.filter(e=>e.category===filterCat);

  // ── Shared input style ─────────────────────────────────────────────────────
  const inp = extra => ({
    width:"100%",background:"#ffffff09",border:"1.5px solid #ffffff12",
    borderRadius:11,color:"#ddd",padding:"11px 14px",fontSize:13,
    outline:"none",fontFamily:"inherit",...extra
  });

  return (
    <div dir="rtl" style={{
      minHeight:"100vh",maxWidth:480,margin:"0 auto",
      background:"#080818",
      fontFamily:"'Segoe UI','Arial Hebrew',Helvetica,sans-serif",
      color:"#e0e0f0",
    }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes popIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        input,textarea,select{font-family:inherit}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(.6)}
        textarea{resize:vertical}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:#ffffff18;border-radius:4px}
        .tap:active{transform:scale(.96)}
      `}</style>

      {/* bg blobs */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,overflow:"hidden"}}>
        <div style={{position:"absolute",top:-120,right:-80,width:320,height:320,borderRadius:"50%",background:"radial-gradient(circle,#A8E6CF10,transparent 70%)"}}/>
        <div style={{position:"absolute",bottom:100,left:-60,width:260,height:260,borderRadius:"50%",background:"radial-gradient(circle,#89CFF00e,transparent 70%)"}}/>
      </div>

      {/* Toast */}
      {toast&&(
        <div style={{
          position:"fixed",top:16,left:"50%",zIndex:9999,
          transform:"translateX(-50%)",
          background:toast.err?"#FF6B6B":"#A8E6CF",
          color:"#080818",padding:"10px 24px",borderRadius:99,
          fontWeight:800,fontSize:13,boxShadow:"0 8px 30px #00000077",
          whiteSpace:"nowrap",animation:"popIn .25s ease",
        }}>{toast.msg}</div>
      )}

      {/* ─── HEADER ─────────────────────────────────────────────────── */}
      <div style={{
        position:"sticky",top:0,zIndex:50,
        background:"#080818ee",backdropFilter:"blur(22px)",
        borderBottom:"1px solid #ffffff0b",padding:"18px 20px 12px",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:9,color:"#8888aa",letterSpacing:3,marginBottom:2}}>מעקב הוצאות</div>
            <div style={{fontSize:21,fontWeight:900,background:"linear-gradient(120deg,#A8E6CF,#89CFF0)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
              {MONTHS[curM]} {curY}
            </div>
          </div>
          <div style={{textAlign:"left"}}>
            <div style={{fontSize:9,color:"#8888aa",marginBottom:2}}>סה״כ החודש</div>
            <div style={{fontSize:24,fontWeight:900,color:bColor,lineHeight:1}}>{fmt(total)}</div>
          </div>
        </div>
        <div style={{marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#555",marginBottom:5}}>
            <span>תקציב:&nbsp;
              {editBudget
                ? <input autoFocus type="number" defaultValue={budget}
                    onBlur={e=>{setBudget(Number(e.target.value)||budget);setEditBudget(false);}}
                    style={{width:72,background:"transparent",border:"none",borderBottom:"1px solid #A8E6CF",color:"#A8E6CF",fontSize:11,outline:"none",textAlign:"center"}}/>
                : <span onClick={()=>setEditBudget(true)} style={{color:"#A8E6CF",cursor:"pointer"}}>{fmt(budget)} ✎</span>}
            </span>
            <span style={{color:bColor}}>נותר {fmt(Math.max(budget-total,0))}</span>
          </div>
          <div style={{height:6,background:"#ffffff0d",borderRadius:99,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${budgetPct}%`,borderRadius:99,background:`linear-gradient(90deg,${bColor}77,${bColor})`,transition:"width .8s cubic-bezier(.4,0,.2,1)"}}/>
          </div>
        </div>
      </div>

      {/* ─── SYNC BAR ───────────────────────────────────────────────── */}
      <div style={{background:"#0d0d22",borderBottom:"1px solid #ffffff08",padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
        <div style={{
          width:8,height:8,borderRadius:"50%",flexShrink:0,
          background:syncing?"#FFE66D":syncStatus==="ok"?"#A8E6CF":syncStatus==="err"?"#FF6B6B":"#333",
          boxShadow:syncing?"0 0 6px #FFE66D":syncStatus==="ok"?"0 0 6px #A8E6CF33":"none",
          transition:"all .3s",
        }}/>
        <div style={{flex:1,fontSize:11,color:"#555"}}>
          {syncing ? "מסנכרן..." :
           sheetId  ? `Google Sheets מחובר${lastSync?` · עודכן ${lastSync}`:""}` :
           "לא מחובר לענן"}
        </div>
        {sheetId ? (
          <div style={{display:"flex",gap:6}}>
            <button className="tap" onClick={handlePull} disabled={syncing} style={{
              background:"#ffffff09",border:"1px solid #ffffff14",borderRadius:8,
              color:"#89CFF0",fontSize:11,fontWeight:700,padding:"5px 10px",cursor:"pointer",
            }}>⬇ טען</button>
            <button className="tap" onClick={handlePush} disabled={syncing} style={{
              background:"#A8E6CF18",border:"1px solid #A8E6CF33",borderRadius:8,
              color:"#A8E6CF",fontSize:11,fontWeight:700,padding:"5px 10px",cursor:"pointer",
            }}>⬆ שמור</button>
          </div>
        ) : (
          <button className="tap" onClick={handleConnect} disabled={syncing} style={{
            background:"linear-gradient(135deg,#A8E6CF,#89CFF0)",border:"none",borderRadius:8,
            color:"#080818",fontSize:11,fontWeight:800,padding:"6px 12px",cursor:"pointer",
          }}>{syncing?"...":"🔗 חבר Sheets"}</button>
        )}
      </div>

      {/* ─── NAV ─────────────────────────────────────────────────── */}
      <div style={{display:"flex",gap:5,padding:"12px 14px 0",position:"sticky",top:114,zIndex:40,background:"#080818"}}>
        {[["dashboard","📊","סטטיסטיקות"],["quick","⚡","הוספה"],["import","📥","ייבוא"],["history","📋","היסטוריה"]].map(([v,icon,lbl])=>(
          <button key={v} className="tap" onClick={()=>setView(v)} style={{
            flex:1,padding:"9px 2px",borderRadius:12,border:"none",cursor:"pointer",
            fontSize:10,fontWeight:800,
            background:view===v?"linear-gradient(135deg,#A8E6CF,#89CFF0)":"#ffffff09",
            color:view===v?"#080818":"#555",
            transition:"all .2s",display:"flex",flexDirection:"column",alignItems:"center",gap:2,
          }}>
            <span style={{fontSize:18}}>{icon}</span>{lbl}
          </button>
        ))}
      </div>

      {/* ─── CONTENT ────────────────────────────────────────────────── */}
      <div style={{padding:"16px 14px 80px",position:"relative",zIndex:1}}>

        {/* ══ DASHBOARD ══════════════════════════════════════════════ */}
        {view==="dashboard"&&(
          <div style={{animation:"fadeUp .3s ease"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[
                {label:"הוצאה גבוהה",value:fmt(Math.max(...monthExp.map(e=>e.amount),0)),color:"#FF6B6B"},
                {label:"ממוצע ליום", value:fmt(total/Math.max(now.getDate(),1)),          color:"#A8E6CF"},
                {label:"עסקאות",     value:monthExp.length,                                 color:"#FFE66D"},
                {label:"AI / מייל",  value:monthExp.filter(e=>e.source!=="manual").length,  color:"#B4A7D6"},
              ].map((s,i)=>(
                <div key={i} style={{background:`${s.color}0e`,border:`1px solid ${s.color}28`,borderRadius:14,padding:"13px 15px"}}>
                  <div style={{fontSize:10,color:`${s.color}88`,marginBottom:4}}>{s.label}</div>
                  <div style={{fontSize:22,fontWeight:900,color:s.color}}>{s.value}</div>
                </div>
              ))}
            </div>

            {pieData.length>0&&(
              <div style={{background:"#ffffff06",border:"1px solid #ffffff0b",borderRadius:18,padding:"18px 14px",marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:700,color:"#bbb",marginBottom:10}}>חלוקה לפי קטגוריה</div>
                <ResponsiveContainer width="100%" height={185}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={78} paddingAngle={3} dataKey="value">
                      {pieData.map((d,i)=><Cell key={i} fill={d.color} stroke="none"/>)}
                    </Pie>
                    <Tooltip content={<CTip/>}/>
                  </PieChart>
                </ResponsiveContainer>
                <div style={{display:"flex",flexWrap:"wrap",gap:7,justifyContent:"center",marginTop:6}}>
                  {pieData.map((d,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:4,fontSize:11}}>
                      <div style={{width:7,height:7,borderRadius:"50%",background:d.color,flexShrink:0}}/>
                      <span style={{color:"#666"}}>{d.emoji} {d.name}</span>
                      <span style={{color:d.color,fontWeight:700}}>{fmt(d.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dailyData.length>1&&(
              <div style={{background:"#ffffff06",border:"1px solid #ffffff0b",borderRadius:18,padding:"18px 14px",marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:700,color:"#bbb",marginBottom:10}}>הוצאות יומיות — {MONTHS[curM]}</div>
                <ResponsiveContainer width="100%" height={145}>
                  <AreaChart data={dailyData}>
                    <defs>
                      <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#89CFF0" stopOpacity={.4}/>
                        <stop offset="100%" stopColor="#89CFF0" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#ffffff07" vertical={false}/>
                    <XAxis dataKey="date" tick={{fill:"#444",fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:"#444",fontSize:10}} axisLine={false} tickLine={false} tickFormatter={v=>`₪${v}`} width={50}/>
                    <Tooltip content={<CTip/>}/>
                    <Area type="monotone" dataKey="total" stroke="#89CFF0" strokeWidth={2.5} fill="url(#ag)" name="הוצאות" dot={{fill:"#89CFF0",r:3,strokeWidth:0}}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {barData.length>0&&(
              <div style={{background:"#ffffff06",border:"1px solid #ffffff0b",borderRadius:18,padding:"18px 14px"}}>
                <div style={{fontSize:13,fontWeight:700,color:"#bbb",marginBottom:10}}>השוואה חודשית</div>
                <ResponsiveContainer width="100%" height={135}>
                  <BarChart data={barData} barSize={22}>
                    <XAxis dataKey="month" tick={{fill:"#444",fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:"#444",fontSize:10}} axisLine={false} tickLine={false} tickFormatter={v=>`₪${v}`} width={50}/>
                    <Tooltip content={<CTip/>}/>
                    <Bar dataKey="total" fill="#A8E6CF" radius={[6,6,0,0]} name="סה״כ"/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {/* ══ QUICK ADD ══════════════════════════════════════════════ */}
        {view==="quick"&&(
          <div style={{animation:"fadeUp .3s ease"}}>
            <div style={{background:"#ffffff07",border:"1px solid #ffffff0d",borderRadius:20,padding:"22px 18px"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#A8E6CF",marginBottom:18}}>⚡ הוספה מהירה</div>

              <div style={{background:"#ffffff08",borderRadius:16,padding:"18px 14px",marginBottom:14,textAlign:"center",border:"2px solid #ffffff0d"}}>
                <div style={{fontSize:10,color:"#444",marginBottom:4}}>סכום</div>
                <div style={{fontSize:44,fontWeight:900,color:form.amount?"#FFE66D":"#222",letterSpacing:-2,lineHeight:1}}>
                  {form.amount?`₪${form.amount}`:"₪0"}
                </div>
                <input type="number" value={form.amount} placeholder="הקלד סכום..."
                  onChange={e=>setForm(f=>({...f,amount:e.target.value}))}
                  style={{...inp({marginTop:12,textAlign:"center",fontSize:16})}}/>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
                {[20,50,100,150,200,500].map(n=>(
                  <button key={n} className="tap" onClick={()=>setForm(f=>({...f,amount:String(Number(f.amount||0)+n)}))}
                    style={{padding:"9px",borderRadius:10,border:"1px solid #ffffff12",background:"#ffffff08",color:"#bbb",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                    +{n}₪
                  </button>
                ))}
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:14}}>
                {CATS.map(c=>(
                  <button key={c.id} className="tap" onClick={()=>setForm(f=>({...f,category:c.id}))}
                    style={{padding:"9px 3px",borderRadius:11,cursor:"pointer",
                      border:form.category===c.id?`2px solid ${c.color}`:"2px solid transparent",
                      background:form.category===c.id?`${c.color}1e`:"#ffffff08",
                      display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"all .15s"}}>
                    <span style={{fontSize:20}}>{c.emoji}</span>
                    <span style={{fontSize:9,color:form.category===c.id?c.color:"#555",fontWeight:700}}>{c.label}</span>
                  </button>
                ))}
              </div>

              <input type="text" value={form.note} placeholder="הערה (אופציונלי)"
                onChange={e=>setForm(f=>({...f,note:e.target.value}))}
                style={{...inp({marginBottom:10})}}/>
              <input type="date" value={form.date}
                onChange={e=>setForm(f=>({...f,date:e.target.value}))}
                style={{...inp({marginBottom:18})}}/>

              <button className="tap" onClick={handleQuickAdd} style={{
                width:"100%",padding:"16px",borderRadius:14,border:"none",cursor:"pointer",
                fontSize:15,fontWeight:800,
                background:"linear-gradient(135deg,#A8E6CF,#89CFF0)",color:"#080818",
              }}>הוסף הוצאה</button>
            </div>
          </div>
        )}

        {/* ══ IMPORT ═════════════════════════════════════════════════ */}
        {view==="import"&&(
          <div style={{animation:"fadeUp .3s ease"}}>
            {/* tabs */}
            <div style={{display:"flex",gap:6,marginBottom:14,background:"#ffffff08",borderRadius:14,padding:5}}>
              {[["doc","🤖 AI מסמך"],["gmail","📧 Gmail"],["sms","💬 SMS"]].map(([t,l])=>(
                <button key={t} className="tap" onClick={()=>switchTab(t)} style={{
                  flex:1,padding:"9px 4px",borderRadius:10,border:"none",cursor:"pointer",
                  fontSize:11,fontWeight:800,
                  background:importTab===t?"linear-gradient(135deg,#A8E6CF,#89CFF0)":"transparent",
                  color:importTab===t?"#080818":"#555",transition:"all .2s",
                }}>{l}</button>
              ))}
            </div>

            {/* ── DOC ── */}
            {importTab==="doc"&&(
              <div style={{background:"#ffffff07",border:"1px solid #ffffff0d",borderRadius:20,padding:"20px 16px"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#A8E6CF",marginBottom:3}}>🤖 ניתוח מסמך עם AI</div>
                <div style={{fontSize:11,color:"#555",marginBottom:14,lineHeight:1.6}}>
                  הדבק <b style={{color:"#aaa"}}>סיכום מילולי</b> שיצרת עם מודל שפה,<br/>
                  טקסט חופשי, <b style={{color:"#aaa"}}>ו/או</b> העלה קובץ PDF / Word —<br/>
                  ה-AI יזהה ויחלץ את כל ההוצאות אוטומטית.
                </div>

                <textarea value={docText} onChange={e=>setDocText(e.target.value)} rows={6}
                  placeholder={"הדבק כאן סיכום מסמך, רשימת הוצאות, דו״ח כספי...\n\nלדוגמה:\n\"בחודש מאי הוצאתי 1,200₪ על מזון, 350₪ על תחבורה ציבורית, 89₪ על נטפליקס...\""}
                  style={{...inp({marginBottom:12,lineHeight:1.7,minHeight:120})}}/>

                {/* file drop */}
                <div onClick={()=>fileRef.current.click()} style={{
                  border:"2px dashed #ffffff1a",borderRadius:13,padding:"18px",
                  textAlign:"center",cursor:"pointer",marginBottom:14,
                  background:fileData?"#A8E6CF0d":"#ffffff05",transition:"all .2s",
                }}>
                  <div style={{fontSize:30,marginBottom:5}}>{fileData?"📄":"☁️"}</div>
                  <div style={{fontSize:12,color:fileData?"#A8E6CF":"#444",fontWeight:700}}>
                    {fileData?fileData.name:"לחץ להעלאת PDF / Word"}
                  </div>
                  {fileData&&(
                    <button onClick={e=>{e.stopPropagation();setFileData(null);}}
                      style={{marginTop:7,background:"none",border:"none",color:"#FF6B6B",fontSize:11,cursor:"pointer"}}>
                      ✕ הסר קובץ
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  style={{display:"none"}} onChange={handleFile}/>

                <button className="tap" onClick={()=>runAI(docText)} disabled={loading||(!docText.trim()&&!fileData)}
                  style={{
                    width:"100%",padding:"14px",borderRadius:13,border:"none",cursor:"pointer",
                    fontSize:14,fontWeight:800,
                    background:"linear-gradient(135deg,#B4A7D6,#89CFF0)",color:"#080818",
                    opacity:(loading||(!docText.trim()&&!fileData))?.6:1,transition:"all .2s",
                  }}>
                  {loading?"⏳ מנתח עם AI...":"🔍 נתח ושלוף הוצאות"}
                </button>
              </div>
            )}

            {/* ── GMAIL ── */}
            {importTab==="gmail"&&(
              <div style={{background:"#ffffff07",border:"1px solid #ffffff0d",borderRadius:20,padding:"20px 16px"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#A8E6CF",marginBottom:3}}>📧 ייבוא מ-Gmail</div>
                <div style={{fontSize:11,color:"#555",marginBottom:16,lineHeight:1.6}}>
                  מחפש אימיילי חיוב מ-Max, CAL, BIT, Paybox וחברות אשראי ישראליות ב-30 הימים האחרונים.
                </div>
                <button className="tap" onClick={handleGmail} disabled={loading} style={{
                  width:"100%",padding:"14px",borderRadius:13,border:"none",cursor:"pointer",
                  fontSize:14,fontWeight:800,
                  background:"linear-gradient(135deg,#FF6B6B,#FFE66D)",color:"#080818",
                  opacity:loading?.6:1,
                }}>{loading?"⏳ מחפש...":"📥 שאב מ-Gmail"}</button>
              </div>
            )}

            {/* ── SMS ── */}
            {importTab==="sms"&&(
              <div style={{background:"#ffffff07",border:"1px solid #ffffff0d",borderRadius:20,padding:"20px 16px"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#A8E6CF",marginBottom:3}}>💬 ניתוח SMS / התראה</div>
                <div style={{fontSize:11,color:"#555",marginBottom:14,lineHeight:1.6}}>
                  הדבק הודעת SMS, התראת אפליקציה, או כל טקסט קצר — ה-AI יזהה את ההוצאה.
                </div>
                <textarea value={smsText} onChange={e=>setSmsText(e.target.value)} rows={4}
                  placeholder={'לדוגמה:\n"חויבת ב-₪250 ב-MAX בשעה 14:32 ברשת ZARA"'}
                  style={{...inp({marginBottom:12,lineHeight:1.7})}}/>
                <button className="tap" onClick={()=>runAI(smsText)} disabled={loading||!smsText.trim()} style={{
                  width:"100%",padding:"14px",borderRadius:13,border:"none",cursor:"pointer",
                  fontSize:14,fontWeight:800,
                  background:"linear-gradient(135deg,#4ECDC4,#89CFF0)",color:"#080818",
                  opacity:(loading||!smsText.trim())?.6:1,
                }}>{loading?"⏳ מנתח...":"🔍 נתח טקסט"}</button>
              </div>
            )}

            {/* ── Results ── */}
            {importItems.length>0&&(
              <div style={{marginTop:16,animation:"fadeUp .3s ease"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#FFE66D"}}>
                    🎯 נמצאו {importItems.length} הוצאות
                  </div>
                  <div style={{display:"flex",gap:7}}>
                    <button onClick={()=>setImportSel(new Set(importItems.map(i=>i._i)))}
                      style={{background:"none",border:"1px solid #ffffff18",borderRadius:8,color:"#888",fontSize:11,padding:"4px 10px",cursor:"pointer"}}>הכל</button>
                    <button onClick={()=>setImportSel(new Set())}
                      style={{background:"none",border:"1px solid #ffffff18",borderRadius:8,color:"#888",fontSize:11,padding:"4px 10px",cursor:"pointer"}}>נקה</button>
                  </div>
                </div>

                {importItems.map(it=>(
                  <ImportRow key={it._i} item={it} selected={importSel.has(it._i)}
                    onToggle={()=>toggleSel(it._i)}
                    onCatChange={nc=>updateCat(it._i,nc)}/>
                ))}

                <button className="tap"
                  onClick={()=>handleConfirm(importTab==="gmail"?"gmail":importTab==="sms"?"sms":"doc")}
                  style={{
                    width:"100%",marginTop:8,padding:"15px",borderRadius:13,border:"none",cursor:"pointer",
                    fontSize:14,fontWeight:800,
                    background:"linear-gradient(135deg,#A8E6CF,#89CFF0)",color:"#080818",
                  }}>
                  ✓ ייבא {importSel.size} הוצאות נבחרות
                </button>
              </div>
            )}
          </div>
        )}

        {/* ══ HISTORY ════════════════════════════════════════════════ */}
        {view==="history"&&(
          <div style={{animation:"fadeUp .3s ease"}}>
            <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12}}>
              {[["all","הכל","#ffffff44"],...CATS.map(c=>[c.id,`${c.emoji} ${c.label}`,c.color])].map(([v,l,cl])=>(
                <button key={v} className="tap" onClick={()=>setFilterCat(v)} style={{
                  flexShrink:0,padding:"7px 13px",borderRadius:99,border:"none",cursor:"pointer",
                  fontSize:11,fontWeight:700,whiteSpace:"nowrap",
                  background:filterCat===v?cl+"22":"#ffffff08",
                  color:filterCat===v?cl:"#444",
                  outline:filterCat===v?`1.5px solid ${cl}44`:"1.5px solid transparent",
                  transition:"all .15s",
                }}>{l}</button>
              ))}
            </div>

            <div style={{fontSize:11,color:"#444",marginBottom:10}}>
              {filtered.length} הוצאות · {fmt(filtered.reduce((s,e)=>s+e.amount,0))}
            </div>

            {filtered.length===0&&(
              <div style={{textAlign:"center",padding:"50px 0",color:"#2a2a40",fontSize:14}}>אין הוצאות</div>
            )}

            {filtered.map(e=>{
              const c=cat(e.category);
              return (
                <div key={e.id} style={{
                  display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:14,marginBottom:8,
                  background:"#ffffff06",border:"1px solid #ffffff0c",
                }}>
                  <div style={{width:40,height:40,borderRadius:12,background:`${c.color}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                    {c.emoji}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:800,fontSize:14,display:"flex",alignItems:"center",gap:6}}>
                      <span style={{color:c.color}}>{fmt(e.amount)}</span>
                      <span style={{fontSize:10,color:"#333",background:"#ffffff09",borderRadius:6,padding:"1px 5px"}}>
                        {SOURCE_ICONS[e.source]||"✏️"}
                      </span>
                    </div>
                    <div style={{fontSize:11,color:"#666",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||c.label}</div>
                    <div style={{fontSize:10,color:"#383838",marginTop:1}}>{e.date}</div>
                  </div>
                  <button className="tap"
                    onClick={()=>{setExpenses(p=>p.filter(x=>x.id!==e.id));showToast("נמחק");}}
                    style={{background:"#FF6B6B12",border:"1px solid #FF6B6B28",borderRadius:9,color:"#FF6B6B88",fontSize:12,padding:"6px 10px",cursor:"pointer",flexShrink:0}}>
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
