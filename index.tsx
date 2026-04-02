import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { API_BASE, aiScan, aiPlan, aiChat, aiHealthReport, setSupabaseAccessToken, type HealthReportResponse } from './api';
import { supabase } from './supabaseClient';
import { motion, AnimatePresence } from "framer-motion";
import Markdown from "react-markdown";
import { 
  Home, 
  ClipboardList, 
  Scan, 
  MessageSquare, 
  User, 
  MoreHorizontal, 
  Circle, 
  Trash2, 
  X, 
  Camera, 
  ArrowUp, 
  Droplets,
  Download,
  ChevronRight,
  ChevronLeft,
  ShieldCheck,
  Info,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Zap,
  RefreshCw
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Utility for Tailwind class merging */
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function downscaleToJpegBase64(
  dataUrl: string,
  maxDim: number = 1280,
  quality: number = 0.85
): Promise<{ base64: string; mimeType: string }> {
  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片解码失败'));
  });

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('图片尺寸异常');

  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.drawImage(img, 0, 0, dstW, dstH);

  const outUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = outUrl.split(',')[1] || '';
  if (!base64) throw new Error('图片编码失败');
  return { base64, mimeType: 'image/jpeg' };
}

// --- 模拟数据库操作层 (Database Layer) ---
const LocalDB = {
  getProfile: () => {
    try {
      const saved = localStorage.getItem('wx_user_profile');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  },
  saveProfile: (profile: any) => {
    localStorage.setItem('wx_user_profile', JSON.stringify(profile));
  },
  getDailyIntake: (dateKey: string) => {
    try {
      const saved = localStorage.getItem(`wx_intake_${dateKey}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  },
  saveDailyIntake: (dateKey: string, data: any[]) => {
    localStorage.setItem(`wx_intake_${dateKey}`, JSON.stringify(data));
  },
  getWaterIntake: (dateKey: string) => {
    const saved = localStorage.getItem(`wx_water_${dateKey}`);
    return saved ? Number(saved) : 0;
  },
  saveWaterIntake: (dateKey: string, amount: number) => {
    localStorage.setItem(`wx_water_${dateKey}`, amount.toString());
  },
  getSelectedCanteen: () => {
    return localStorage.getItem('wx_selected_canteen') as any || 'none';
  },
  saveSelectedCanteen: (canteen: string) => {
    localStorage.setItem('wx_selected_canteen', canteen);
  },
  getEvents: (dateKey: string) => {
    try {
      const saved = localStorage.getItem(`wx_user_events_${dateKey}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  },
  pushEvent: (dateKey: string, event: any) => {
    try {
      const key = `wx_user_events_${dateKey}`;
      const saved = localStorage.getItem(key);
      const arr = saved ? JSON.parse(saved) : [];
      const next = Array.isArray(arr) ? [...arr, event] : [event];
      // 防止无限增长（日活很低时基本不会触发，但上限要有）
      localStorage.setItem(key, JSON.stringify(next.slice(-300)));
    } catch {
      // ignore
    }
  },
  setEvents: (dateKey: string, data: any[]) => {
    try {
      const key = `wx_user_events_${dateKey}`;
      const arr = Array.isArray(data) ? data : [];
      localStorage.setItem(key, JSON.stringify(arr.slice(-300)));
    } catch {
      // ignore
    }
  },
  clearAll: () => {
    localStorage.clear();
  }
};

function calcGoalInfoFromProfile(p: UserProfile) {
  const w = Number(p.weight) || 60;
  const h = Number(p.height) || 170;
  const heightM = h / 100;
  if (heightM <= 0) return { calories: 1800, protein: 135, carbs: 203, fat: 50, bmi: '0' };
  let bmr = (10 * w) + (6.25 * h) - (5 * (Number(p.age) || 25));
  bmr = p.gender === 'male' ? bmr + 5 : bmr - 161;
  const activityMultipliers: any = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const level = p.activityLevel || 'moderate';
  const tdee = bmr * (activityMultipliers[level] ?? 1.55);
  let targetCals = p.goal === 'lose' ? tdee - 500 : p.goal === 'gain' ? tdee + 300 : tdee;
  if (!Number.isFinite(targetCals)) targetCals = 1800;
  return {
    calories: Math.round(targetCals),
    protein: Math.round(targetCals * 0.3 / 4),
    carbs: Math.round(targetCals * 0.45 / 4),
    fat: Math.round(targetCals * 0.25 / 9),
    bmi: (w / (heightM * heightM)).toFixed(1)
  };
}

// --- 类型定义 ---
type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active';
type CanteenType = 'none' | 'szu_south';
type PlanMealType = 'breakfast' | 'lunch' | 'dinner';

interface UserProfile {
  gender: 'male' | 'female';
  age: number;
  height: number;
  weight: number;
  targetWeight: number;
  wakeUpTime: string;
  sleepTime: string;
  mealFrequency: number;
  goal: 'lose' | 'gain' | 'shape' | 'maintain';
  trainingDays: number;
  trainingDuration: number;
  trainingType: 'strength' | 'cardio' | 'mixed';
  trainingTime: 'morning' | 'noon' | 'evening';
  isFasted: boolean;
  bodyFat?: number;
  waist?: number;
  healthConditions: string[];
  dietaryRestrictions: string[];
  commonIngredients: string;
  hatedIngredients: string;
  diningCondition: 'self' | 'takeout' | 'canteen';
  habits: string[];
  activityLevel: ActivityLevel;
  trackingNeeds: string[];
}

interface NutritionData {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  name: string;
  mealType: MealType;
  timestamp: number;
}

interface PlannedMeal {
  name: string;
  calories: number;
  desc: string;
  category?: string;
  dishNames?: string[];
}

type PlannedMeals = Record<PlanMealType, PlannedMeal>;

interface HealthReport {
  generatedAt: string;
  reportMarkdown: string;
  targets?: HealthReportResponse['targets'];
}

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
};

// --- 通用组件 ---

const Toast = ({ message, type = 'success', onClose }: { message: string, type?: 'success' | 'error', onClose: () => void }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 2000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] px-4 py-2 rounded-full bg-black/80 text-white text-xs flex items-center gap-2 shadow-lg"
    >
      {type === 'success' ? <CheckCircle2 className="w-3 h-3 text-green-400" /> : <AlertCircle className="w-3 h-3 text-red-400" />}
      {message}
    </motion.div>
  );
};

const CircularProgress = ({ current, target }: { current: number, target: number }) => {
  const percent = Math.min((current / target) * 100, 100);
  const offset = 251.2 - (251.2 * percent) / 100;
  return (
    <div className="relative w-32 h-32">
      <svg className="w-full h-full -rotate-90">
        <circle cx="64" cy="64" r="40" fill="none" stroke="#f3f3f3" strokeWidth="10" />
        <circle 
          cx="64" cy="64" r="40" fill="none" stroke="#07c160" strokeWidth="10" 
          strokeDasharray="251.2" strokeDashoffset={offset} strokeLinecap="round" 
          className="transition-all duration-1000 ease-out" 
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[10px] text-gray-400 font-bold">还可摄入</span>
        <span className="text-xl font-black">{Math.max(0, target - current)}</span>
        <span className="text-[8px] text-gray-300 uppercase tracking-wider">kcal</span>
      </div>
    </div>
  );
};

const NutrientBar = ({ label, current, target, color }: any) => (
  <div className="space-y-1">
    <div className="flex justify-between items-end">
      <span className="text-[10px] text-gray-400 font-bold">{label}</span>
      <span className="text-[10px] font-bold">{current}/{target}g</span>
    </div>
    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <motion.div 
        initial={{ width: 0 }}
        animate={{ width: `${Math.min((current/target)*100, 100)}%` }}
        transition={{ duration: 1, ease: "easeOut" }}
        className="h-full" 
        style={{ backgroundColor: color }} 
      />
    </div>
  </div>
);

const StatItem = ({ label, value, unit, color }: any) => (
  <div className="text-center">
    <p className="text-[10px] text-gray-400 font-bold mb-1 uppercase tracking-tighter">{label}</p>
    <p className="text-lg font-black" style={{ color: color || '#333' }}>
      {value}<span className="text-[10px] font-normal ml-0.5">{unit}</span>
    </p>
  </div>
);

const WaterTracker = ({ amount, onAdd }: { amount: number, onAdd: (v: number) => void }) => {
  const target = 2000;
  const percent = Math.min((amount / target) * 100, 100);
  
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-50 mt-4">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <Droplets className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-bold">饮水量</h3>
        </div>
        <span className="text-xs font-bold text-blue-500">{amount}/{target}ml</span>
      </div>
      <div className="h-2 bg-blue-50 rounded-full overflow-hidden mb-4">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          className="h-full bg-blue-500" 
        />
      </div>
      <div className="flex gap-2">
        {[200, 300, 500].map(v => (
          <button 
            key={v} 
            onClick={() => onAdd(v)}
            className="flex-1 py-2 rounded-xl bg-blue-50 text-blue-600 text-[10px] font-bold active:scale-95 transition-transform"
          >
            +{v}ml
          </button>
        ))}
      </div>
    </div>
  );
};

const SectionTitle = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div>
    {subtitle && (
      <p className="text-[10px] font-black tracking-[0.22em] text-gray-400 uppercase mb-1">{subtitle}</p>
    )}
    <h2 className="text-lg font-black text-gray-900 tracking-tight">{title}</h2>
  </div>
);

// --- 主应用组件 ---
const App = () => {
  const [isNewUser, setIsNewUser] = useState(() => localStorage.getItem('wx_onboarding_complete') !== 'true');
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [activeTab, setActiveTab] = useState<'home' | 'scan' | 'recipes' | 'profile' | 'coach'>('home');
  // 不同模块独立 loading，避免“AI专家生成中导致方案不可用”
  const [scanLoading, setScanLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedMeal, setSelectedMeal] = useState<MealType>('lunch');
  const [selectedCanteen, setSelectedCanteen] = useState<CanteenType>(() => LocalDB.getSelectedCanteen());
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);

  const [authEmail, setAuthEmail] = useState('');
  const [authSending, setAuthSending] = useState(false);
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);
  
  const todayKey = useMemo(() => new Date().toISOString().split('T')[0], []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setAuthedEmail(data.session?.user?.email ?? null);
      setSupabaseAccessToken(data.session?.access_token ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthedEmail(session?.user?.email ?? null);
      setSupabaseAccessToken(session?.access_token ?? null);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const sendLoginLink = async () => {
    if (!supabase) {
      showToast('未配置 Supabase（请设置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）', 'error');
      return;
    }
    const email = authEmail.trim();
    if (!email) return;
    setAuthSending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      showToast('已发送登录链接，请去邮箱点击完成登录');
    } catch (e) {
      showToast((e as any)?.message || '发送失败，请重试', 'error');
    } finally {
      setAuthSending(false);
    }
  };

  const logout = async () => {
    if (!supabase) return;
    try {
      await supabase.auth.signOut();
      setSupabaseAccessToken(null);
      setPlannedMeals(null);
      lastDailyCloudSigRef.current = '';
      lastHealthCloudSigRef.current = '';
      showToast('已退出登录');
    } catch {
      showToast('退出失败，请重试', 'error');
    }
  };

  // 从 "DB" 初始化用户信息
  const [profile, setProfile] = useState<UserProfile>(() => {
    const saved = LocalDB.getProfile();
    const defaults: UserProfile = {
      gender: 'male',
      age: 25,
      height: 175,
      weight: 70,
      targetWeight: 65,
      wakeUpTime: '07:30',
      sleepTime: '23:30',
      mealFrequency: 3,
      goal: 'lose',
      trainingDays: 3,
      trainingDuration: 60,
      trainingType: 'mixed',
      trainingTime: 'evening',
      isFasted: false,
      healthConditions: [],
      dietaryRestrictions: [],
      commonIngredients: '',
      hatedIngredients: '',
      diningCondition: 'takeout',
      habits: [],
      activityLevel: 'moderate',
      trackingNeeds: ['calories', 'protein'],
    };
    if (!saved) return defaults;
    return {
      ...defaults,
      ...saved,
      activityLevel: (saved.activityLevel && ['sedentary','light','moderate','active'].includes(saved.activityLevel)) ? saved.activityLevel : 'moderate',
      goal: (saved.goal && ['lose','gain','shape','maintain'].includes(saved.goal)) ? saved.goal : 'lose',
      healthConditions: Array.isArray(saved.healthConditions) ? saved.healthConditions : [],
      dietaryRestrictions: Array.isArray(saved.dietaryRestrictions) ? saved.dietaryRestrictions : [],
      habits: Array.isArray(saved.habits) ? saved.habits : [],
      trackingNeeds: Array.isArray(saved.trackingNeeds) ? saved.trackingNeeds : ['calories', 'protein'],
    };
  });

  const [tempProfile, setTempProfile] = useState<UserProfile>(profile);
  
  // 从 "DB" 初始化饮食记录
  const [dailyIntake, setDailyIntake] = useState<NutritionData[]>(() => {
    return LocalDB.getDailyIntake(todayKey);
  });

  const [waterIntake, setWaterIntake] = useState<number>(() => {
    return LocalDB.getWaterIntake(todayKey);
  });

  /** 事件写入 localStorage 后 bump，用于触发云端 user_daily_log 同步 */
  const [dailyLogEventsTick, setDailyLogEventsTick] = useState(0);
  const pushDayEvent = (ev: any) => {
    LocalDB.pushEvent(todayKey, ev);
    setDailyLogEventsTick((n) => n + 1);
  };

  const [scanResult, setScanResult] = useState<(Partial<NutritionData> & { estimatedWeightGrams?: number; portionSize?: string }) | null>(null);
  const [scanWeight, setScanWeight] = useState<number | null>(null);
  const [plannedMeals, setPlannedMeals] = useState<PlannedMeals | null>(null);
  const [healthReport, setHealthReport] = useState<HealthReport | null>(() => {
    try {
      const saved = localStorage.getItem('wx_health_report');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [reportLoading, setReportLoading] = useState(false);
  const [reportExporting, setReportExporting] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // AI 状态更新
  const [chatMessages, setChatMessages] = useState<any[]>([
    { role: 'model', text: '你好！我是你的 **AI营养专家**。🤖\n\n我可以基于你的身体各项指标，为你提供精确的营养配餐建议和饮食分析。今天有什么我可以帮你的吗？' }
  ]);
  const [userInput, setUserInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const remoteProfileTimerRef = useRef<number | null>(null);
  const lastPushedProfileSigRef = useRef<string>('');
  const lastDailyCloudSigRef = useRef<string>('');
  const lastHealthCloudSigRef = useRef<string>('');
  const [backendOk, setBackendOk] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/health`).then((r) => r.ok).then(setBackendOk).catch(() => setBackendOk(false));
  }, []);

  const pullRemoteProfile = async () => {
    if (!supabase) return;
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess.session?.user?.id;
    if (!uid) return;

    const { data, error } = await supabase
      .from('user_profiles')
      .select('profile,selected_canteen,updated_at')
      .eq('user_id', uid)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[user_profiles] pull failed', error.message);
      return;
    }
    if (!data?.profile || typeof data.profile !== 'object') return;

    const remotePayload = data.profile as any;
    const { profileRevision: _pr, ...remoteProfile } = remotePayload;

    setProfile((prev) => ({ ...prev, ...(remoteProfile as UserProfile) }));
    const c = data.selected_canteen;
    if (c === 'none' || c === 'szu_south') {
      setSelectedCanteen(c);
    }

    // 拉取后避免立刻把同一份数据再 push 一遍
    try {
      lastPushedProfileSigRef.current = JSON.stringify({
        profile: remoteProfile,
        selected_canteen: c === 'none' || c === 'szu_south' ? c : undefined,
      });
    } catch {
      lastPushedProfileSigRef.current = '';
    }
  };

  useEffect(() => {
    if (!supabase || !authedEmail) return;
    void pullRemoteProfile();
  }, [authedEmail, supabase]);

  // 登录后拉取当日饮食/饮水/事件与健康报告（云端）
  useEffect(() => {
    if (!supabase || !authedEmail) return;
    let cancelled = false;
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user?.id;
      if (!uid || cancelled) return;

      const { data: row, error } = await supabase
        .from('user_daily_log')
        .select('intake,water_ml,events')
        .eq('user_id', uid)
        .eq('date_key', todayKey)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        console.warn('[user_daily_log] pull failed', error.message);
      } else if (row) {
        const intake = Array.isArray(row.intake) ? row.intake : [];
        const water = Number(row.water_ml) || 0;
        const events = Array.isArray(row.events) ? row.events : [];
        setDailyIntake(intake as NutritionData[]);
        setWaterIntake(water);
        LocalDB.saveDailyIntake(todayKey, intake);
        LocalDB.saveWaterIntake(todayKey, water);
        LocalDB.setEvents(todayKey, events);
        try {
          lastDailyCloudSigRef.current = JSON.stringify({ intake, water_ml: water, events });
        } catch {
          lastDailyCloudSigRef.current = '';
        }
      }

      const { data: hrRow, error: hrErr } = await supabase
        .from('user_health_report')
        .select('report')
        .eq('user_id', uid)
        .maybeSingle();

      if (cancelled) return;
      if (hrErr) {
        console.warn('[user_health_report] pull failed', hrErr.message);
        return;
      }
      if (hrRow?.report && typeof hrRow.report === 'object') {
        const r = hrRow.report as HealthReport;
        if (typeof r.generatedAt === 'string' && typeof r.reportMarkdown === 'string') {
          setHealthReport(r);
          try {
            localStorage.setItem('wx_health_report', JSON.stringify(r));
          } catch {
            // ignore
          }
          try {
            lastHealthCloudSigRef.current = JSON.stringify(r);
          } catch {
            lastHealthCloudSigRef.current = '';
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedEmail, supabase, todayKey]);

  // 持久化同步到“数据库”
  useEffect(() => { LocalDB.saveProfile(profile); }, [profile]);
  useEffect(() => { LocalDB.saveDailyIntake(todayKey, dailyIntake); }, [dailyIntake, todayKey]);
  useEffect(() => { LocalDB.saveWaterIntake(todayKey, waterIntake); }, [waterIntake, todayKey]);
  useEffect(() => { LocalDB.saveSelectedCanteen(selectedCanteen); }, [selectedCanteen]);
  useEffect(() => {
    try {
      if (healthReport) localStorage.setItem('wx_health_report', JSON.stringify(healthReport));
      else localStorage.removeItem('wx_health_report');
    } catch {
      // ignore
    }
  }, [healthReport]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // 登录后把档案同步到 Supabase（RLS：仅本人可读写）
  useEffect(() => {
    if (!supabase || !authedEmail) return;

    if (remoteProfileTimerRef.current) {
      window.clearTimeout(remoteProfileTimerRef.current);
      remoteProfileTimerRef.current = null;
    }

    let alive = true;
    remoteProfileTimerRef.current = window.setTimeout(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const user = sess.session?.user;
        if (!user) return;

        let sig = '';
        try {
          sig = JSON.stringify({ profile, selectedCanteen });
        } catch {
          sig = '';
        }
        if (sig && sig === lastPushedProfileSigRef.current) return;

        const { error } = await supabase.from('user_profiles').upsert(
          {
            user_id: user.id,
            email: user.email,
            profile,
            selected_canteen: selectedCanteen,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
        if (error) throw error;

        if (!alive) return;
        lastPushedProfileSigRef.current = sig;
      } catch (e) {
        console.warn('[user_profiles] upsert failed', (e as any)?.message || e);
      }
    }, 700);

    return () => {
      alive = false;
      if (remoteProfileTimerRef.current) {
        window.clearTimeout(remoteProfileTimerRef.current);
        remoteProfileTimerRef.current = null;
      }
    };
  }, [profile, authedEmail, selectedCanteen, supabase]);

  // 登录用户：当日摄入 / 饮水 / 事件 → Supabase user_daily_log
  useEffect(() => {
    if (!supabase || !authedEmail) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const events = LocalDB.getEvents(todayKey);
        let sig = '';
        try {
          sig = JSON.stringify({ intake: dailyIntake, water_ml: waterIntake, events });
        } catch {
          return;
        }
        if (sig === lastDailyCloudSigRef.current) return;

        const { data: sess } = await supabase.auth.getSession();
        const user = sess.session?.user;
        if (!user || !alive) return;

        const { error } = await supabase.from('user_daily_log').upsert(
          {
            user_id: user.id,
            date_key: todayKey,
            intake: dailyIntake,
            water_ml: Math.max(0, Math.round(Number(waterIntake) || 0)),
            events,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,date_key' }
        );
        if (error) {
          console.warn('[user_daily_log] upsert failed', error.message);
          return;
        }
        if (alive) lastDailyCloudSigRef.current = sig;
      } catch (e) {
        console.warn('[user_daily_log] upsert failed', (e as any)?.message || e);
      }
    }, 700);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [dailyIntake, waterIntake, todayKey, authedEmail, supabase, dailyLogEventsTick]);

  // 登录用户：健康报告 → Supabase user_health_report
  useEffect(() => {
    if (!supabase || !authedEmail || !healthReport) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        let sig = '';
        try {
          sig = JSON.stringify(healthReport);
        } catch {
          return;
        }
        if (sig === lastHealthCloudSigRef.current) return;

        const { data: sess } = await supabase.auth.getSession();
        const user = sess.session?.user;
        if (!user || !alive) return;

        const { error } = await supabase.from('user_health_report').upsert(
          {
            user_id: user.id,
            report: healthReport,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
        if (error) {
          console.warn('[user_health_report] upsert failed', error.message);
          return;
        }
        if (alive) lastHealthCloudSigRef.current = sig;
      } catch (e) {
        console.warn('[user_health_report] upsert failed', (e as any)?.message || e);
      }
    }, 700);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [healthReport, authedEmail, supabase]);

  const goalInfo = useMemo(() => {
    const w = Number(profile.weight) || 60;
    const h = Number(profile.height) || 170;
    const heightM = h / 100;
    if (heightM <= 0) return { calories: 1800, protein: 135, carbs: 203, fat: 50, bmi: '0' };
    let bmr = (10 * w) + (6.25 * h) - (5 * (Number(profile.age) || 25));
    bmr = profile.gender === 'male' ? bmr + 5 : bmr - 161;
    const activityMultipliers: any = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
    const level = profile.activityLevel || 'moderate';
    const tdee = bmr * (activityMultipliers[level] ?? 1.55);
    let targetCals = profile.goal === 'lose' ? tdee - 500 : profile.goal === 'gain' ? tdee + 300 : tdee;
    if (!Number.isFinite(targetCals)) targetCals = 1800;
    return {
      calories: Math.round(targetCals),
      protein: Math.round(targetCals * 0.3 / 4),
      carbs: Math.round(targetCals * 0.45 / 4),
      fat: Math.round(targetCals * 0.25 / 9),
      bmi: (w / (heightM * heightM)).toFixed(1)
    };
  }, [profile]);

  const currentTotal = useMemo(() => dailyIntake.reduce((acc, curr) => ({
    calories: acc.calories + (Number(curr.calories) || 0),
    protein: acc.protein + (Number(curr.protein) || 0),
    carbs: acc.carbs + (Number(curr.carbs) || 0),
    fat: acc.fat + (Number(curr.fat) || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 }), [dailyIntake]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  };

  const generateHealthReport = async (p: UserProfile) => {
    setReportLoading(true);
    try {
      const targets = calcGoalInfoFromProfile(p);
      const resp = await aiHealthReport(p, targets);
      const reportMarkdown = resp.reportMarkdown || '';
      if (!reportMarkdown.trim()) {
        throw new Error('健康报告生成失败，请重试');
      }
      setHealthReport({
        generatedAt: resp.generatedAt || new Date().toISOString(),
        reportMarkdown,
        targets: resp.targets,
      });
      showToast(resp.aiOk === false ? "已生成基础健康报告（AI暂不可用）" : "健康报告已生成");
    } catch (e) {
      const msg = (e as any)?.message || '健康报告生成失败，请稍后重试';
      showToast(msg, 'error');
    } finally {
      setReportLoading(false);
    }
  };

  const exportHealthReportAsImage = async () => {
    if (!healthReport) return;
    setReportExporting(true);
    try {
      const safeNow = new Date();
      const ts = safeNow.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `health-report-${ts}.png`;

      const buildReportBlocks = (md: string) => {
        const lines = String(md || '').split('\n');
        const blocks: Array<{ kind: 'h1' | 'h2' | 'h3' | 'p' | 'quote'; text: string }> = [];
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) {
            blocks.push({ kind: 'p', text: '' });
            continue;
          }
          const m1 = line.match(/^#\s+(.*)$/);
          if (m1) { blocks.push({ kind: 'h1', text: m1[1].trim() }); continue; }
          const m2 = line.match(/^##\s+(.*)$/);
          if (m2) { blocks.push({ kind: 'h2', text: m2[1].trim() }); continue; }
          const m3 = line.match(/^###\s+(.*)$/);
          if (m3) { blocks.push({ kind: 'h3', text: m3[1].trim() }); continue; }
          if (line.startsWith('>')) { blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '').trim() }); continue; }
          if (line.startsWith('- ')) { blocks.push({ kind: 'p', text: `• ${line.slice(2).trim()}` }); continue; }
          blocks.push({ kind: 'p', text: line });
        }
        return blocks;
      };

      const blocks = buildReportBlocks(healthReport.reportMarkdown || '');
      const targets = healthReport.targets || {};

      const width = 1080;
      const padding = 60;
      const innerPad = 52;
      const cardGap = 16;
      const cardW = (width - padding * 2 - innerPad * 2 - cardGap) / 2;
      const cardH = 112;

      const measureCanvas = document.createElement('canvas');
      const mctx = measureCanvas.getContext('2d');
      if (!mctx) throw new Error('Canvas 不可用');

      const wrap = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number) => {
        const t = String(text || '');
        if (!t) return [''];
        const result: string[] = [];
        let buf = '';
        for (const ch of t) {
          const next = buf + ch;
          if (ctx.measureText(next).width > maxWidth && buf) {
            result.push(buf);
            buf = ch;
          } else {
            buf = next;
          }
        }
        if (buf) result.push(buf);
        return result;
      };

      // Rough height estimate (cap to avoid giant images on some devices)
      const mainW = width - padding * 2;
      const textAreaW = mainW - innerPad * 2;
      let textLines = 0;
      for (const b of blocks) {
        const font = b.kind === 'h1' ? '900 36px "Noto Sans SC", ui-sans-serif, system-ui'
          : b.kind === 'h2' ? '900 24px "Noto Sans SC", ui-sans-serif, system-ui'
          : b.kind === 'h3' ? '800 20px "Noto Sans SC", ui-sans-serif, system-ui'
          : '400 18px "Noto Sans SC", ui-sans-serif, system-ui';
        mctx.font = font;
        if (!b.text) { textLines += 1; continue; }
        textLines += wrap(mctx, b.text, textAreaW).length;
      }

      const headerH = 126;
      const targetsH = cardH * 2 + cardGap + 40;
      const reportBoxTopPad = 18;
      const reportBoxBottomPad = 26;
      const lineHeight = 30;
      const reportTextH = Math.min(2500, Math.max(520, textLines * lineHeight + reportBoxTopPad + reportBoxBottomPad));
      const height = Math.min(3600, padding * 2 + headerH + targetsH + reportTextH);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 不可用');

      const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
      };

      // Background (match app style)
      ctx.fillStyle = '#f7f7f7';
      ctx.fillRect(0, 0, width, height);

      // Main card (similar to "展开报告" 的白色弹窗质感)
      const mainX = padding;
      const mainY = padding;
      ctx.save();
      roundRect(mainX, mainY, mainW, height - padding * 2, 44);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.04)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Title area
      let y = mainY + 52;
      const x0 = mainX + innerPad;
      ctx.fillStyle = '#111827';
      ctx.font = '900 40px "Noto Sans SC", ui-sans-serif, system-ui';
      ctx.fillText('健康报告', x0, y);
      y += 40;

      ctx.fillStyle = '#9ca3af';
      ctx.font = '500 18px "Noto Sans SC", ui-sans-serif, system-ui';
      ctx.fillText(`生成时间：${new Date(healthReport.generatedAt).toLocaleString()}`, x0, y);
      y += 46;

      // Targets title
      ctx.fillStyle = '#6b7280';
      ctx.font = '900 18px "Noto Sans SC", ui-sans-serif, system-ui';
      ctx.fillText('每日目标', x0, y);
      y += 18;

      const targetItems: Array<{ label: string; value: string; accent: string }> = [
        { label: '热量', value: `${Number((targets as any).calories) || 0} kcal`, accent: '#047857' },
        { label: '蛋白质', value: `${Number((targets as any).protein) || 0} g`, accent: '#16a34a' },
        { label: '碳水', value: `${Number((targets as any).carbs) || 0} g`, accent: '#f59e0b' },
        { label: '脂肪', value: `${Number((targets as any).fat) || 0} g`, accent: '#ef4444' },
      ];

      const drawTargetCard = (x: number, y0: number, item: { label: string; value: string; accent: string }) => {
        ctx.save();
        roundRect(x, y0, cardW, cardH, 28);
        ctx.fillStyle = '#f9fafb';
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = '#9ca3af';
        ctx.font = '900 18px "Noto Sans SC", ui-sans-serif, system-ui';
        ctx.fillText(item.label, x + 24, y0 + 36);
        ctx.fillStyle = '#111827';
        ctx.font = '900 28px "Noto Sans SC", ui-sans-serif, system-ui';
        ctx.fillText(item.value, x + 24, y0 + 74);
        ctx.fillStyle = item.accent;
        ctx.fillRect(x + 24, y0 + 88, 54, 6);
      };

      y += 16;
      drawTargetCard(x0, y, targetItems[0]);
      drawTargetCard(x0 + cardW + cardGap, y, targetItems[1]);
      drawTargetCard(x0, y + cardH + cardGap, targetItems[2]);
      drawTargetCard(x0 + cardW + cardGap, y + cardH + cardGap, targetItems[3]);

      y += cardH * 2 + cardGap + 44;

      // Report text
      let ty = y;
      const tx = x0;
      const maxW = textAreaW;

      const setFontFor = (kind: 'h1' | 'h2' | 'h3' | 'p' | 'quote') => {
        if (kind === 'h1') { ctx.font = '900 36px "Noto Sans SC", ui-sans-serif, system-ui'; ctx.fillStyle = '#111827'; return 48; }
        if (kind === 'h2') { ctx.font = '900 24px "Noto Sans SC", ui-sans-serif, system-ui'; ctx.fillStyle = '#047857'; return 40; }
        if (kind === 'h3') { ctx.font = '800 20px "Noto Sans SC", ui-sans-serif, system-ui'; ctx.fillStyle = '#111827'; return 34; }
        if (kind === 'quote') { ctx.font = '500 18px "Noto Sans SC", ui-sans-serif, system-ui'; ctx.fillStyle = '#065f46'; return 30; }
        ctx.font = '400 18px "Noto Sans SC", ui-sans-serif, system-ui';
        ctx.fillStyle = '#374151';
        return 30;
      };

      const maxTextBottom = mainY + (height - padding * 2) - 44;
      for (const b of blocks) {
        const lh = setFontFor(b.kind);
        if (!b.text) {
          ty += Math.round(lh * 0.6);
          continue;
        }

        if (b.kind === 'quote') {
          const lh = setFontFor('quote');
          const lines = wrap(ctx, b.text, maxW - 36);
          const boxPadX = 18;
          const boxPadY = 14;
          const boxH = Math.max(54, lines.length * lh + boxPadY * 2 - 6);
          const boxW = maxW;
          ctx.save();
          roundRect(tx, ty - 22, boxW, boxH, 22);
          ctx.fillStyle = 'rgba(34,197,94,0.10)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(34,197,94,0.20)';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();

          let qy = ty + 10;
          ctx.fillStyle = '#065f46';
          ctx.font = '500 18px "Noto Sans SC", ui-sans-serif, system-ui';
          for (const line of lines) {
            if (qy > maxTextBottom) break;
            ctx.fillText(line, tx + boxPadX, qy);
            qy += lh;
          }
          ty += boxH + 16;
          continue;
        }

        if (b.kind === 'h2') {
          // Match expanded report: green left bar + indent
          const barW = 6;
          const barH = Math.max(24, lh - 10);
          ctx.fillStyle = '#22c55e';
          ctx.fillRect(tx, ty - barH + 8, barW, barH);
          ctx.fillStyle = '#047857';
          ctx.font = '900 24px "Noto Sans SC", ui-sans-serif, system-ui';
          const lines = wrap(ctx, b.text, maxW - 18);
          for (const line of lines) {
            if (ty > maxTextBottom) break;
            ctx.fillText(line, tx + 14, ty);
            ty += lh;
          }
          ty += 10;
          continue;
        }

        const lines = wrap(ctx, b.text, maxW);
        for (const line of lines) {
          if (ty > maxTextBottom) break;
          ctx.fillText(line, tx, ty);
          ty += lh;
        }
        ty += b.kind === 'p' ? 6 : 10;
        if (ty > maxTextBottom) break;
      }
      if (ty > maxTextBottom) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '500 18px "Noto Sans SC", ui-sans-serif, system-ui';
        ctx.fillText('内容较长，图片已自动截断。可在应用内查看完整版。', tx, maxTextBottom);
      }

      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      showToast((e as any)?.message || '保存失败，请重试', 'error');
    } finally {
      setReportExporting(false);
    }
  };

  const reportPreview = useMemo(() => {
    const src = healthReport?.reportMarkdown || '';
    const cleaned = src
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~-]/g, ' ')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
  }, [healthReport]);

  const handleScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanLoading(true);
    try {
      // 拍照图片通常很大，先压缩再上传，减少后端 body 限制触顶和 AI 端超时概率
      const dataUrl = await readFileAsDataUrl(file);
      let payload: { base64: string; mimeType: string } | null = null;
      if (file.type?.startsWith('image/')) {
        try {
          payload = await downscaleToJpegBase64(dataUrl);
        } catch {
          payload = null;
        }
      }
      const base64Data = payload?.base64 || dataUrl.split(',')[1] || '';
      const mimeType = payload?.mimeType || file.type || 'image/jpeg';
      if (!base64Data) {
        showToast("图片读取失败，请重试", "error");
        setScanLoading(false);
        return;
      }
      const result = await aiScan(base64Data, mimeType);
      setScanResult(result);
      setScanWeight(typeof result.estimatedWeightGrams === 'number' && Number.isFinite(result.estimatedWeightGrams)
        ? Math.max(0, Math.round(result.estimatedWeightGrams))
        : null);
      showToast("识别成功");
    } catch (err) {
      showToast("识别失败，请重试", "error");
    } finally {
      setScanLoading(false);
    }
  };

  const addIntake = () => {
    if (scanResult) {
      const entry: NutritionData = {
        name: scanResult.name || '未知',
        calories: Number(scanResult.calories) || 0,
        protein: Number(scanResult.protein) || 0,
        carbs: Number(scanResult.carbs) || 0,
        fat: Number(scanResult.fat) || 0,
        mealType: selectedMeal,
        timestamp: Date.now()
      };
      setDailyIntake([entry, ...dailyIntake]);
      setScanResult(null);
      setActiveTab('home');
      showToast("已记入饮食日志");
    }
  };

  const normalizePlannedMeals = (input: any): PlannedMeals | null => {
    if (!input || typeof input !== 'object') return null;
    const pick = (key: PlanMealType): PlannedMeal | null => {
      const v = (input as any)[key];
      if (!v || typeof v !== 'object') return null;
      const name = typeof v.name === 'string' ? v.name.trim() : '';
      const calories = Number(v.calories);
      const desc = typeof v.desc === 'string' ? v.desc.trim() : '';
      if (!name || !Number.isFinite(calories) || calories <= 0 || !desc) return null;
      // category 为可选字段：后端（食堂模式）可能返回，如“早餐窗口/午餐窗口/晚餐窗口”
      // 若后端未提供，则按餐段 key 给一个友好默认值，确保卡片右上角总有类别标签
      const rawCategory = typeof (v as any).category === 'string' ? (v as any).category.trim() : '';
      const fallbackCategory =
        key === 'breakfast'
          ? '早餐'
          : key === 'lunch'
            ? '午餐'
            : key === 'dinner'
              ? '晚餐'
              : '餐段';
      const category = rawCategory || fallbackCategory;
      const dishNames = Array.isArray((v as any).dishNames)
        ? (v as any).dishNames.map((x: any) => String(x)).filter(Boolean)
        : undefined;
      return { name, calories, desc, category, dishNames };
    };
    const breakfast = pick('breakfast');
    const lunch = pick('lunch');
    const dinner = pick('dinner');
    if (!breakfast || !lunch || !dinner) return null;
    return { breakfast, lunch, dinner };
  };

  // 登录后恢复云端保存的「方案」三餐（与「保存到今日」写入的 user_saved_meal_plan 对应）
  useEffect(() => {
    if (!supabase || !authedEmail) return;
    let cancelled = false;
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user?.id;
      if (!uid || cancelled) return;
      const { data, error } = await supabase
        .from('user_saved_meal_plan')
        .select('plan,selected_canteen')
        .eq('user_id', uid)
        .maybeSingle();
      if (cancelled || error) {
        if (error) console.warn('[user_saved_meal_plan] pull failed', error.message);
        return;
      }
      if (!data?.plan || typeof data.plan !== 'object') return;
      const normalized = normalizePlannedMeals(data.plan);
      if (!normalized || cancelled) return;
      setPlannedMeals(normalized);
      const c = data.selected_canteen;
      if (c === 'none' || c === 'szu_south') setSelectedCanteen(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [authedEmail, supabase]);

  const savePlannedMealsToToday = () => {
    if (!plannedMeals) return;
    const base = Date.now();
    const entries: NutritionData[] = (['breakfast', 'lunch', 'dinner'] as const).map((mealType, i) => ({
      name: plannedMeals[mealType].name,
      calories: Number(plannedMeals[mealType].calories) || 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      mealType,
      timestamp: base + i,
    }));
    setDailyIntake((prev) => [...entries.reverse(), ...prev]);
    try {
      const ev = {
        type: 'plan_saved',
        ts: base,
        selectedCanteen,
        plan: {
          breakfast: plannedMeals.breakfast?.name,
          lunch: plannedMeals.lunch?.name,
          dinner: plannedMeals.dinner?.name,
        },
      };
      pushDayEvent(ev);
    } catch {
      // ignore
    }
    showToast("已保存到今日摄入");
    setActiveTab('home');
    void (async () => {
      if (!supabase) return;
      const { data: sess } = await supabase.auth.getSession();
      const user = sess.session?.user;
      if (!user) return;
      const { error } = await supabase.from('user_saved_meal_plan').upsert(
        {
          user_id: user.id,
          plan: plannedMeals,
          selected_canteen: selectedCanteen,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
      if (error) console.warn('[user_saved_meal_plan] upsert failed', error.message);
    })();
  };

  const generatePlan = async (opts?: { refresh?: boolean }) => {
    setPlanLoading(true);
    try {
      const prevPlan = plannedMeals
        ? {
            breakfast: plannedMeals.breakfast?.name,
            lunch: plannedMeals.lunch?.name,
            dinner: plannedMeals.dinner?.name,
          }
        : null;
      // “深大食堂”模式下后端会按单个菜名去重/避开，
      // 因此此处优先使用每餐返回的 dishNames（组成该餐的真实菜品名）。
      const avoidList = opts?.refresh && plannedMeals
        ? (['breakfast', 'lunch', 'dinner'] as const)
          .flatMap((k) => {
            const dm = plannedMeals[k].dishNames;
            if (Array.isArray(dm) && dm.length) return dm.filter(Boolean);
            // 兜底：如果后端没有提供 dishNames，则退化使用 meal name
            const fallback = plannedMeals[k].name;
            return fallback ? [fallback] : [];
          })
          .filter(Boolean)
        : [];
      const context = selectedCanteen === 'szu_south' ? "针对深圳大学南区食堂特色菜。" : "通用家常菜。";
      const prompt = `你现在是AI营养专家。
      用户档案：
      - 基本信息：年龄${profile.age}，性别${profile.gender === 'male' ? '男' : '女'}，身高${profile.height}cm，体重${profile.weight}kg，目标体重${profile.targetWeight}kg。
      - 作息：起床${profile.wakeUpTime}，睡觉${profile.sleepTime}，${profile.mealFrequency}餐制。
      - 健身：目标${profile.goal}，每周训练${profile.trainingDays}天，类型${profile.trainingType}，时段${profile.trainingTime}${profile.isFasted ? '(空腹)' : ''}。
      - 身体：体脂率${profile.bodyFat || '未知'}%，腰围${profile.waist || '未知'}cm，健康状况：${(profile.healthConditions || []).join(', ') || '无'}。
      - 饮食：限制：${(profile.dietaryRestrictions || []).join(', ') || '无'}，常吃：${profile.commonIngredients || '无'}，讨厌：${profile.hatedIngredients || '无'}，用餐条件：${profile.diningCondition}，习惯：${(profile.habits || []).join(', ') || '无'}。
      - 活动量：${profile.activityLevel}。
      
      请为该用户规划今日三餐，目标总热量约为${goalInfo.calories}kcal。${context}
      分配建议：早餐约25%，午餐约40%，晚餐约35%（可微调，但全天总量要贴近目标）。
      营养分配建议：蛋白质约30%，碳水约45%，脂肪约25%。
      请确保餐食名称具体（如“香煎三文鱼配西兰花”而非“鱼和蔬菜”），描述中包含主要的食材和烹饪方式。
      ${avoidList.length ? `避免与以下菜品重复（换一批推荐）：${avoidList.join('、')}。` : ''}
      只返回严格 JSON（不要 Markdown/解释文字）：{"breakfast":{"name":"...","calories":数字,"desc":"..."},"lunch":{"name":"...","calories":数字,"desc":"..."},"dinner":{"name":"...","calories":数字,"desc":"..."}}。`;
      const result = await aiPlan(prompt, selectedCanteen, {
        profile,
        targets: { calories: goalInfo.calories },
        avoidNames: avoidList,
      });
      const normalized = normalizePlannedMeals(result);
      if (!normalized) {
        throw new Error("AI 返回格式异常，请换一批重试");
      }
      setPlannedMeals(normalized);
      try {
        const ev = {
          type: 'plan_generated',
          ts: Date.now(),
          refresh: Boolean(opts?.refresh),
          selectedCanteen,
          prevPlan,
          newPlan: {
            breakfast: normalized.breakfast?.name,
            lunch: normalized.lunch?.name,
            dinner: normalized.dinner?.name,
          },
        };
        pushDayEvent(ev);
      } catch {
        // ignore
      }
      showToast("方案已生成");
    } catch (e) {
      const msg = (e as any)?.message || "生成失败，请稍后";
      showToast(msg, "error");
    } finally {
      setPlanLoading(false);
    }
  };

  const handleSendMessage = async (textOverride?: string) => {
    const msg = textOverride || userInput;
    if (!msg.trim()) return;
    const newMsgs = [...chatMessages, { role: 'user', text: msg }];
    setChatMessages(newMsgs);
    setUserInput('');
    setChatLoading(true);
    try {
      const systemInstruction = `你是一位专业的AI营养专家。
            当前用户详细数据：
            - 身体指标：体重${profile.weight}kg, 身高${profile.height}cm, BMI ${goalInfo.bmi}
            - 目标：${profile.goal} (目标体重: ${profile.targetWeight}kg)
            - 作息与运动：${profile.mealFrequency}餐制，每周${profile.trainingDays}天${profile.trainingType}
            - 饮食偏好：限制(${(profile.dietaryRestrictions || []).join(', ') || '无'}), 讨厌(${profile.hatedIngredients || '无'})
            - 健康状况：${(profile.healthConditions || []).join(', ') || '良好'}
            
            回复要简练、专业且富有逻辑，多用 Emoji。使用 Markdown 格式。
            如果是关于饮食建议，必须给出具体的可量化指导。
            注意：你的回复仅供参考，不作为医疗诊断。`;
      const { text } = await aiChat(msg, systemInstruction, profile);
      setChatMessages([...newMsgs, { role: 'model', text }]);
    } catch (err) {
      showToast("网络连接稍显拥挤", "error");
    } finally {
      setChatLoading(false);
    }
  };

  const finishOnboarding = () => {
    const p = tempProfile;
    setProfile(p);
    localStorage.setItem('wx_onboarding_complete', 'true');
    setIsNewUser(false);
    setActiveTab('profile');
    showToast("健康报告后台生成中（预计 8-20 秒）");
    // 后台生成，不阻塞用户继续操作
    void generateHealthReport(p);
  };

  const renderOnboarding = () => {
    const steps = [
      {
        title: "欢迎来到 Recipe",
        desc: "让我们开始定制你的专属健康方案",
        content: (
          <div className="flex flex-col items-center py-10">
            <div className="text-6xl mb-6">🥗</div>
            <p className="text-gray-500 text-center px-10 leading-relaxed">我们将通过 AI 技术，为你提供精准的饮食建议和营养分析。</p>
          </div>
        )
      },
      {
        title: "一、基础信息",
        desc: "性别、年龄与身体指标",
        content: (
          <div className="space-y-4 py-4">
            <div className="flex gap-3">
              {(['male', 'female'] as const).map(g => (
                <button key={g} onClick={() => setTempProfile({...tempProfile, gender: g})} className={cn("flex-1 py-4 rounded-2xl border-2 transition-all flex items-center justify-center gap-2", tempProfile.gender === g ? 'border-green-600 bg-green-50/50' : 'border-gray-100 bg-white')}>
                  <span className="text-xl">{g === 'male' ? '👨' : '👩'}</span>
                  <span className="text-sm font-bold">{g === 'male' ? '男' : '女'}</span>
                </button>
              ))}
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100 flex items-center justify-between">
              <label className="text-xs font-bold text-gray-400">年龄</label>
              <div className="flex items-center gap-2">
                <input type="number" value={tempProfile.age || ''} onChange={e => setTempProfile({...tempProfile, age: Number(e.target.value)})} className="w-12 text-right font-black outline-none" placeholder="0" />
                <span className="text-xs text-gray-300">岁</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">身高 (cm)</label>
                <input type="number" value={tempProfile.height} onChange={e => setTempProfile({...tempProfile, height: Number(e.target.value)})} className="text-xl font-black w-full outline-none" />
              </div>
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">当前体重 (kg)</label>
                <input type="number" value={tempProfile.weight} onChange={e => setTempProfile({...tempProfile, weight: Number(e.target.value)})} className="text-xl font-black w-full outline-none" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-1">目标体重 (kg)</label>
              <input type="number" value={tempProfile.targetWeight} onChange={e => setTempProfile({...tempProfile, targetWeight: Number(e.target.value)})} className="text-xl font-black w-full outline-none text-green-600" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">起床时间</label>
                <input type="time" value={tempProfile.wakeUpTime} onChange={e => setTempProfile({...tempProfile, wakeUpTime: e.target.value})} className="text-sm font-bold w-full outline-none" />
              </div>
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">睡觉时间</label>
                <input type="time" value={tempProfile.sleepTime} onChange={e => setTempProfile({...tempProfile, sleepTime: e.target.value})} className="text-sm font-bold w-full outline-none" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">几餐制</label>
              <div className="flex gap-2">
                {[3, 4, 5].map(n => (
                  <button key={n} onClick={() => setTempProfile({...tempProfile, mealFrequency: n})} className={cn("flex-1 py-2 rounded-xl text-xs font-bold border transition-all", tempProfile.mealFrequency === n ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {n} 餐
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      },
      {
        title: "二、健身核心",
        desc: "决定你的热量与蛋白质缺口",
        content: (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'lose', label: '减脂', emoji: '🔥' },
                { id: 'gain', label: '增肌', emoji: '💪' },
                { id: 'shape', label: '塑形', emoji: '✨' },
                { id: 'maintain', label: '维持', emoji: '⚖️' }
              ].map(item => (
                <button key={item.id} onClick={() => setTempProfile({...tempProfile, goal: item.id as any})} className={cn("p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-1", tempProfile.goal === item.id ? 'border-green-600 bg-green-50/50' : 'border-gray-100 bg-white')}>
                  <span className="text-xl">{item.emoji}</span>
                  <span className="text-xs font-bold">{item.label}</span>
                </button>
              ))}
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <div className="flex justify-between mb-2">
                <label className="text-[10px] font-bold text-gray-400">每周训练天数</label>
                <span className="text-xs font-bold">{tempProfile.trainingDays} 天</span>
              </div>
              <input type="range" min="0" max="7" value={tempProfile.trainingDays} onChange={e => setTempProfile({...tempProfile, trainingDays: Number(e.target.value)})} className="w-full h-1.5 bg-gray-100 rounded-full appearance-none accent-green-600" />
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">训练类型</label>
              <div className="flex gap-2">
                {[
                  { id: 'strength', label: '力量为主' },
                  { id: 'cardio', label: '有氧为主' },
                  { id: 'mixed', label: '混合训练' }
                ].map(t => (
                  <button key={t.id} onClick={() => setTempProfile({...tempProfile, trainingType: t.id as any})} className={cn("flex-1 py-2 rounded-xl text-[10px] font-bold border transition-all", tempProfile.trainingType === t.id ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">训练时段</label>
              <div className="flex gap-2 mb-3">
                {[
                  { id: 'morning', label: '早上' },
                  { id: 'noon', label: '中午' },
                  { id: 'evening', label: '晚上' }
                ].map(t => (
                  <button key={t.id} onClick={() => setTempProfile({...tempProfile, trainingTime: t.id as any})} className={cn("flex-1 py-2 rounded-xl text-[10px] font-bold border transition-all", tempProfile.trainingTime === t.id ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {t.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setTempProfile({...tempProfile, isFasted: !tempProfile.isFasted})} className={cn("w-full py-2 rounded-xl text-[10px] font-bold border flex items-center justify-center gap-2 transition-all", tempProfile.isFasted ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-gray-50 text-gray-400 border-transparent')}>
                <Zap className={cn("w-3 h-3", tempProfile.isFasted && "fill-orange-600")} />
                空腹训练
              </button>
            </div>
          </div>
        )
      },
      {
        title: "三、身体与代谢",
        desc: "更细致的身体状态评估",
        content: (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">体脂率 (%)</label>
                <input type="number" placeholder="可选" value={tempProfile.bodyFat || ''} onChange={e => setTempProfile({...tempProfile, bodyFat: Number(e.target.value)})} className="text-xl font-black w-full outline-none" />
              </div>
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">腰围 (cm)</label>
                <input type="number" placeholder="可选" value={tempProfile.waist || ''} onChange={e => setTempProfile({...tempProfile, waist: Number(e.target.value)})} className="text-xl font-black w-full outline-none" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-3">健康状况 / 疾病史</label>
              <div className="grid grid-cols-2 gap-2">
                {['三高', '痛风', '胃病', '过敏'].map(item => (
                  <button key={item} onClick={() => {
                    const current = tempProfile.healthConditions || [];
                    const next = current.includes(item) ? current.filter(i => i !== item) : [...current, item];
                    setTempProfile({...tempProfile, healthConditions: next});
                  }} className={cn("py-2 rounded-xl text-xs font-bold border transition-all", tempProfile.healthConditions?.includes(item) ? 'bg-red-50 text-red-600 border-red-200' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      },
      {
        title: "四、饮食与偏好",
        desc: "让 AI 计划更符合你的胃口",
        content: (
          <div className="space-y-4 py-4">
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">饮食限制</label>
              <div className="flex flex-wrap gap-2">
                {['素食', '乳糖不耐', '海鲜过敏', '坚果过敏', '不吃辣'].map(item => (
                  <button key={item} onClick={() => {
                    const current = tempProfile.dietaryRestrictions || [];
                    const next = current.includes(item) ? current.filter(i => i !== item) : [...current, item];
                    setTempProfile({...tempProfile, dietaryRestrictions: next});
                  }} className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all", tempProfile.dietaryRestrictions?.includes(item) ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">常吃食材</label>
                <input type="text" placeholder="如：鸡胸肉、西兰花" value={tempProfile.commonIngredients} onChange={e => setTempProfile({...tempProfile, commonIngredients: e.target.value})} className="text-xs font-bold w-full outline-none" />
              </div>
              <div className="bg-white p-4 rounded-2xl border border-gray-100">
                <label className="text-[10px] font-bold text-gray-400 block mb-1">讨厌食材</label>
                <input type="text" placeholder="如：香菜、芹菜" value={tempProfile.hatedIngredients} onChange={e => setTempProfile({...tempProfile, hatedIngredients: e.target.value})} className="text-xs font-bold w-full outline-none" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">用餐条件</label>
              <div className="flex gap-2">
                {[
                  { id: 'self', label: '自己做饭' },
                  { id: 'takeout', label: '外卖' },
                  { id: 'canteen', label: '食堂' }
                ].map(c => (
                  <button key={c.id} onClick={() => setTempProfile({...tempProfile, diningCondition: c.id as any})} className={cn("flex-1 py-2 rounded-xl text-[10px] font-bold border transition-all", tempProfile.diningCondition === c.id ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">生活习惯</label>
              <div className="flex gap-2">
                {[
                  { id: 'alcohol', label: '饮酒' },
                  { id: 'milktea', label: '奶茶' },
                  { id: 'snack', label: '夜宵' }
                ].map(h => (
                  <button key={h.id} onClick={() => {
                    const current = tempProfile.habits || [];
                    const next = current.includes(h.id) ? current.filter(i => i !== h.id) : [...current, h.id];
                    setTempProfile({...tempProfile, habits: next});
                  }} className={cn("flex-1 py-2 rounded-xl text-[10px] font-bold border transition-all", tempProfile.habits?.includes(h.id) ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      },
      {
        title: "五、控量关键",
        desc: "最后的个性化设置",
        content: (
          <div className="space-y-4 py-4">
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">每日大致活动量</label>
              <div className="space-y-2">
                {[
                  { id: 'sedentary', label: '久坐不动', desc: '办公室工作' },
                  { id: 'light', label: '轻度走动', desc: '日常通勤、散步' },
                  { id: 'moderate', label: '中度活跃', desc: '站立工作、频繁走动' },
                  { id: 'active', label: '重体力', desc: '建筑、搬运等高强度劳动' }
                ].map(a => (
                  <button key={a.id} onClick={() => setTempProfile({...tempProfile, activityLevel: a.id as any})} className={cn("w-full p-3 rounded-xl border-2 text-left transition-all", tempProfile.activityLevel === a.id ? 'border-green-600 bg-green-50/50' : 'border-gray-100 bg-white')}>
                    <span className="text-xs font-bold block">{a.label}</span>
                    <span className="text-[9px] text-gray-400">{a.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-gray-100">
              <label className="text-[10px] font-bold text-gray-400 block mb-2">关注指标 (多选)</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'calories', label: '热量' },
                  { id: 'protein', label: '蛋白质' },
                  { id: 'carbs', label: '碳水' },
                  { id: 'fat', label: '脂肪' }
                ].map(n => (
                  <button key={n.id} onClick={() => {
                    const current = tempProfile.trackingNeeds || [];
                    const next = current.includes(n.id) ? current.filter(i => i !== n.id) : [...current, n.id];
                    setTempProfile({...tempProfile, trackingNeeds: next});
                  }} className={cn("py-2 rounded-xl text-xs font-bold border transition-all", tempProfile.trackingNeeds?.includes(n.id) ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 border-transparent text-gray-400')}>
                    {n.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      },
      {
        title: "AI 深度分析",
        desc: "正在根据你的身体指标生成专业建议...",
        content: (
          <div className="py-6 space-y-6">
            <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
               <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-2xl">📊</div>
                  <div>
                     <p className="text-[10px] font-bold text-gray-400 uppercase">预估 BMI</p>
                     <p className="text-xl font-black text-blue-600">{(tempProfile.weight / ((tempProfile.height/100)**2)).toFixed(1)}</p>
                  </div>
               </div>
               <div className="space-y-3">
                  <div className="flex justify-between text-xs">
                     <span className="text-gray-400">训练目标</span>
                     <span className="font-bold text-gray-800">{tempProfile.goal === 'lose' ? '减脂' : tempProfile.goal === 'gain' ? '增肌' : tempProfile.goal === 'shape' ? '塑形' : '维持'}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                     <span className="text-gray-400">身体状况</span>
                     <span className="font-bold text-red-600">{(tempProfile.healthConditions || []).join(' · ') || '健康'}</span>
                  </div>
               </div>
            </div>
            <div className="p-6 bg-green-50 rounded-3xl border border-green-100">
               <p className="text-xs text-green-800 leading-relaxed italic">
                  "基于你的数据，AI 建议每日摄入约 <span className="font-bold">1800-2000 kcal</span>。我们将重点关注 <span className="font-bold">{tempProfile.goal}</span>，并严格遵循你的 <span className="font-bold">{(tempProfile.dietaryRestrictions || []).join(',')}</span> 偏好。"
               </p>
            </div>
          </div>
        )
      }
    ];

    const currentStep = steps[onboardingStep];

    return (
      <div className="fixed inset-0 z-[500] bg-[#f7f7f7] flex flex-col">
        <div className="flex-1 pt-16 px-8 overflow-y-auto no-scrollbar pb-8">
          <div className="max-w-md mx-auto">
            <div className="flex gap-1 mb-8">
              {steps.map((_, i) => (
                <div key={i} className={cn("h-1 flex-1 rounded-full transition-all", i <= onboardingStep ? 'bg-green-600' : 'bg-gray-200')} />
              ))}
            </div>
            <motion.div
              key={onboardingStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <h2 className="text-2xl font-black mb-2">{currentStep.title}</h2>
              <p className="text-sm text-gray-400 mb-8">{currentStep.desc}</p>
              {currentStep.content}
            </motion.div>
          </div>
        </div>
        <div className="p-8 bg-white/80 backdrop-blur-md border-t border-gray-100">
          <div className="max-w-md mx-auto flex gap-4">
          {onboardingStep > 0 && (
            <button 
              onClick={() => setOnboardingStep(prev => prev - 1)}
              className="p-4 rounded-2xl bg-white border border-gray-200 text-gray-400"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          <button 
            onClick={() => onboardingStep < steps.length - 1 ? setOnboardingStep(prev => prev + 1) : finishOnboarding()}
            disabled={onboardingStep === 1 && (!tempProfile.age || tempProfile.age < 10)}
            className={cn(
              "flex-1 py-4 rounded-2xl font-bold shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all",
              (onboardingStep === 1 && (!tempProfile.age || tempProfile.age < 10)) 
                ? "bg-gray-200 text-gray-400 cursor-not-allowed shadow-none" 
                : "bg-[#07c160] text-white"
            )}
          >
            {onboardingStep === steps.length - 1 ? '开启健康之旅' : '下一步'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
    );
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'home':
        return (
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="pb-10"
          >
            <div className="flex justify-between items-center mb-6">
               <h2 className="text-xl font-bold">今日摄入</h2>
               <span className="text-xs text-gray-400 font-medium">{todayKey}</span>
            </div>

            <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-50">
               <div className="flex justify-between mb-8">
                  <CircularProgress current={currentTotal.calories} target={goalInfo.calories} />
                  <div className="flex-1 pl-8 space-y-4 pt-2">
                     <NutrientBar label="蛋白质" current={currentTotal.protein} target={goalInfo.protein} color="#07c160" />
                     <NutrientBar label="碳水" current={currentTotal.carbs} target={goalInfo.carbs} color="#ff9c00" />
                     <NutrientBar label="脂肪" current={currentTotal.fat} target={goalInfo.fat} color="#f44336" />
                  </div>
               </div>
               <div className="flex justify-around pt-4 border-t border-gray-50">
                  <StatItem label="已摄入" value={currentTotal.calories} unit="kcal" />
                  <StatItem label="还可吃" value={Math.max(0, goalInfo.calories - currentTotal.calories)} unit="kcal" color="#07c160" />
               </div>
            </div>

            <WaterTracker amount={waterIntake} onAdd={(v) => setWaterIntake(prev => prev + v)} />

            <div className="mt-8">
               <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-gray-900">进食明细</h3>
                  <span className="text-[10px] text-gray-300">数据已存入本地库</span>
               </div>
               {dailyIntake.length === 0 ? (
                 <div className="bg-white rounded-2xl p-10 text-center text-gray-400 text-sm border border-dashed border-gray-200">
                   还没有记录，快去扫一扫吧
                 </div>
               ) : (
                 <div className="space-y-3">
                   {dailyIntake.map(item => (
                     <div key={item.timestamp} className="bg-white p-4 rounded-2xl flex items-center justify-between shadow-sm border border-gray-50">
                        <div className="flex items-center gap-3">
                           <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center text-lg">🥗</div>
                           <div>
                              <p className="text-sm font-bold text-gray-800">{item.name}</p>
                              <p className="text-[10px] text-gray-400">{MEAL_LABELS[item.mealType]}</p>
                           </div>
                        </div>
                        <div className="flex items-center gap-3">
                           <span className="text-sm font-bold">{item.calories}kcal</span>
                           <button onClick={() => {
                             setDailyIntake(prev => prev.filter(i => i.timestamp !== item.timestamp));
                             showToast("已删除记录");
                           }} className="text-gray-300 p-1 active:text-red-500 transition-colors">
                             <Trash2 className="w-4 h-4" />
                           </button>
                        </div>
                     </div>
                   ))}
                 </div>
               )}
            </div>
          </motion.div>
        );
      case 'recipes':
        return (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="pb-10"
          >
            {plannedMeals ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => setPlannedMeals(null)}
                    className="p-2 -ml-2 rounded-xl active:bg-gray-100 text-gray-700"
                    aria-label="返回"
                    title="返回"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <h2 className="text-xl font-bold flex-1 text-center">每日定制方案</h2>
                  <div className="w-9" />
                </div>
                <div className="text-[10px] text-gray-400 text-center">
                  {selectedCanteen === 'szu_south' ? '深大南区食堂（来自数据库菜谱）' : '均衡家常'}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={savePlannedMealsToToday}
                    disabled={planLoading}
                    className="py-3 rounded-2xl bg-[#07c160] text-white font-bold text-sm shadow-md active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 className="w-5 h-5" />
                    保存到今日
                  </button>
                  <button
                    onClick={() => {
                      // 记录“用户主动换一批”行为，用于评估推荐是否合适
                      try {
                        const ev = {
                          type: 'plan_refresh_clicked',
                          ts: Date.now(),
                          selectedCanteen,
                          prevPlan: plannedMeals
                            ? {
                                breakfast: plannedMeals.breakfast?.name,
                                lunch: plannedMeals.lunch?.name,
                                dinner: plannedMeals.dinner?.name,
                              }
                            : null,
                        };
                        pushDayEvent(ev);
                      } catch {
                        // ignore
                      }
                      void generatePlan({ refresh: true });
                    }}
                    disabled={planLoading}
                    className={cn(
                      "py-3 rounded-2xl bg-white border font-bold text-sm shadow-sm active:scale-[0.98] transition-transform flex items-center justify-center gap-2",
                      planLoading ? "border-gray-100 text-gray-300" : "border-gray-200 text-gray-800"
                    )}
                  >
                    <RefreshCw className={cn("w-5 h-5", planLoading ? "animate-spin" : "")} />
                    {planLoading ? "生成中（预计 5-10 秒）" : "换一批推荐"}
                  </button>
                </div>
                {(['breakfast', 'lunch', 'dinner'] as const).map(type => {
                  const meal = plannedMeals[type];
                  return (
                  <div key={type} className="bg-white rounded-3xl overflow-hidden shadow-sm border border-gray-100">
                    <div
                      className="w-full h-40 relative"
                      style={{
                        backgroundImage: "url(/meal-bg.png)",
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                        backgroundColor: '#f7f7f7',
                      }}
                    >
                      <div className="absolute inset-0 bg-gradient-to-t from-white/95 via-white/40 to-white/20" />
                      <div className="absolute inset-0 p-4 flex items-end justify-between">
                        <span className="text-[10px] font-bold text-green-700 bg-white/80 backdrop-blur px-2 py-0.5 rounded-md border border-white/40">
                          {MEAL_LABELS[type as MealType]}
                        </span>
                        <div className="flex flex-col items-end gap-1">
                          {meal?.category && (
                            <span className="text-[10px] font-bold text-green-700 bg-white/80 backdrop-blur px-2 py-0.5 rounded-md border border-white/40">
                              {meal.category}
                            </span>
                          )}
                          <span className="text-xs font-bold text-gray-900 bg-white/80 backdrop-blur px-2 py-0.5 rounded-md border border-white/40">
                            {meal?.calories} kcal
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="p-4">
                      <h3 className="text-base font-bold mb-1 truncate">{meal?.name}</h3>
                      <p className="text-[11px] text-gray-400 leading-relaxed">{meal?.desc}</p>
                    </div>
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-6">
                <h2 className="text-xl font-bold mb-4">定制你的健康配餐</h2>
                <div className="grid grid-cols-2 gap-4">
                   <button onClick={() => setSelectedCanteen('none')} className={cn("p-6 rounded-3xl border-2 text-left transition-all", selectedCanteen === 'none' ? 'border-green-600 bg-green-50/30' : 'border-gray-100 bg-white')}>
                      <p className="text-2xl mb-2">🥘</p>
                      <p className="text-sm font-bold">均衡家常</p>
                      <p className="text-[9px] text-gray-400 mt-1">适合自己下厨或点外卖</p>
                   </button>
                   <button onClick={() => setSelectedCanteen('szu_south')} className={cn("p-6 rounded-3xl border-2 text-left transition-all", selectedCanteen === 'szu_south' ? 'border-green-600 bg-green-50/30' : 'border-gray-100 bg-white')}>
                      <p className="text-2xl mb-2">🎓</p>
                      <p className="text-sm font-bold">深大南区</p>
                      <p className="text-[9px] text-gray-400 mt-1">针对校园窗口菜式优化</p>
                   </button>
                </div>
                <div className="bg-white rounded-[2rem] p-10 flex flex-col items-center border border-gray-50 shadow-sm mt-4">
                   <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center text-3xl mb-4">🤖</div>
                   <h3 className="font-bold mb-2">由 AI营养专家 为你规划</h3>
                   <p className="text-xs text-gray-400 text-center mb-8">我们将结合你的 BMI 和活动强度<br/>精准计算全天能量分布</p>
                   <button
                     onClick={() => generatePlan()}
                     disabled={planLoading}
                     className={cn(
                       "px-10 py-3.5 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2",
                       planLoading ? "bg-gray-200 text-gray-400 shadow-none" : "bg-[#07c160] text-white"
                     )}
                   >
                     {planLoading && <RefreshCw className="w-4 h-4 animate-spin" />}
                     {planLoading ? "生成中（预计 5-10 秒）" : "立即生成方案"}
                   </button>
                </div>
              </div>
            )}
          </motion.div>
        );
      case 'scan':
        return (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center pt-10"
          >
            {scanResult ? (
              <div className="bg-white w-full rounded-[2rem] p-8 shadow-xl border border-gray-50 max-w-sm">
                <div className="flex justify-between items-start mb-6">
                   <h3 className="text-lg font-bold">AI营养识别</h3>
                   <button onClick={() => setScanResult(null)} className="text-gray-300 active:text-gray-900"><X className="w-6 h-6" /></button>
                </div>
                <div className="mb-6">
                  <label className="text-[10px] text-gray-400 font-bold block mb-1">食物名称</label>
                  <input 
                    className="text-2xl font-bold border-none outline-none w-full focus:ring-0 p-0" 
                    value={scanResult.name} 
                    onChange={e => setScanResult({...scanResult, name: e.target.value})} 
                  />
                </div>
                <div className="mb-1">
                  <div className="grid grid-cols-3 gap-3">
                    <EditField label="卡路里" value={scanResult.calories} unit="kcal" onChange={(v: number) => setScanResult({...scanResult, calories: v})} />
                    <EditField label="蛋白质" value={scanResult.protein} unit="g" onChange={(v: number) => setScanResult({...scanResult, protein: v})} />
                    <EditField
                      label="估算重量"
                      value={scanWeight ?? scanResult.estimatedWeightGrams ?? 0}
                      unit="g"
                      onChange={(v: number) => setScanWeight(Number.isFinite(v) ? Math.max(0, v) : 0)}
                    />
                  </div>
                  <p className="mt-1 text-[9px] text-gray-400">
                    仅估算可食用部分（如汤面不含汤、带骨肉主要算肉），可根据实际情况微调。
                  </p>
                </div>
                <div className="flex gap-2 mb-8">
                   {(['breakfast', 'lunch', 'dinner'] as const).map(m => (
                     <button 
                       key={m} 
                       onClick={() => setSelectedMeal(m)} 
                       className={cn("flex-1 py-3 rounded-2xl text-xs font-bold border transition-all", selectedMeal === m ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 text-gray-400 border-transparent')}
                     >
                       {MEAL_LABELS[m]}
                     </button>
                   ))}
                </div>
                <button onClick={addIntake} className="w-full bg-[#07c160] text-white py-4 rounded-2xl font-bold shadow-md active:scale-[0.98] transition-transform">记入饮食日志</button>
              </div>
            ) : (
              <div className="w-64 h-64 bg-white rounded-[3rem] border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-300 group hover:border-green-500 transition-colors relative overflow-hidden shadow-sm">
                {scanLoading ? (
                  <div className="flex flex-col items-center gap-4">
                    <div className="animate-spin w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full"></div>
                    <p className="text-[10px] font-bold text-green-600">AI正在识别中（预计 5-15 秒）</p>
                  </div>
                ) : (
                  <>
                    <Camera className="w-12 h-12 mb-4" />
                    <p className="text-xs font-bold">拍摄食物图片</p>
                    <p className="text-[10px] mt-1">AI 自动识别营养成分</p>
                    <input type="file" accept="image/*" capture="environment" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleScan} />
                  </>
                )}
              </div>
            )}
          </motion.div>
        );
      case 'coach':
        return (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="h-[calc(100vh-180px)] flex flex-col"
          >
             <div className="flex-1 overflow-y-auto space-y-4 pr-1 mb-4 no-scrollbar">
                {chatMessages.map((m, i) => (
                  <div key={i} className={cn("flex", m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div>
                      <div className={cn(
                        "max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm prose prose-sm",
                        m.role === 'user' ? 'bg-[#07c160] text-white rounded-tr-none' : 'bg-white text-gray-800 rounded-tl-none border border-gray-50'
                      )}>
                        <Markdown>{m.text}</Markdown>
                      </div>

                      {i === 0 && m.role !== 'user' && (
                        <div className="mt-3">
                          <div className="flex items-center gap-2 text-[10px] text-gray-300 mb-2 pl-1 uppercase tracking-wider">
                              <Zap className="w-4 h-4" />
                              suggestions
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            {[
                              {
                                label: "今天怎么吃",
                                text: `基于我的目标（${profile.goal}）和活动量（${profile.activityLevel}），给我今天三餐怎么分配热量/蛋白/碳水/脂肪，并给出3个可执行例子。`
                              },
                              {
                                label: "外食怎么选",
                                text: `我大多数是外食/食堂（${profile.diningCondition}），请给我“点菜/选菜”的规则和避坑清单（要可量化）。`
                              },
                              healthReport ? {
                                label: "解读报告",
                                text: `请用要点帮我解读我的健康报告，并说明后续7天我最该优先做的3件事。`
                              } : {
                                label: "训练日策略",
                                text: `我每周训练${profile.trainingDays}天，类型${profile.trainingType}。请分别给我训练日与休息日的饮食策略（包含加餐建议）。`
                              },
                            ].map((s) => (
                              <button
                                key={s.label}
                                onClick={() => handleSendMessage(s.text)}
                                disabled={chatLoading}
                                className={cn(
                                  "px-3 py-1.5 rounded-full text-xs font-medium border transition-all active:scale-95",
                                  chatLoading ? "bg-gray-50 text-gray-300 border-gray-100" : "bg-gray-50 text-gray-600 border-gray-100 hover:bg-gray-100"
                                )}
                              >
                                {s.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-2 text-[10px] text-gray-300 pl-2">
                    <div className="flex gap-1">
                      <motion.div animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 bg-gray-300 rounded-full" />
                      <motion.div animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 bg-gray-300 rounded-full" />
                      <motion.div animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 bg-gray-300 rounded-full" />
                    </div>
                    AI营养专家思考中...
                  </div>
                )}
                <div ref={chatEndRef} />
             </div>
             <div className="bg-white p-2 rounded-2xl border border-gray-100 flex items-center shadow-sm">
                <input 
                  className="flex-1 bg-transparent border-none outline-none px-3 text-sm py-2" 
                  placeholder="咨询 AI营养专家..." 
                  value={userInput} 
                  onChange={e => setUserInput(e.target.value)} 
                  onKeyDown={e => e.key === 'Enter' && handleSendMessage()} 
                />
                <button 
                  onClick={() => handleSendMessage()} 
                  disabled={!userInput.trim() || chatLoading}
                  className={cn("p-2.5 rounded-xl transition-all", userInput.trim() ? 'bg-green-600 text-white' : 'bg-gray-50 text-gray-300')}
                >
                  <ArrowUp className="w-5 h-5" />
                </button>
             </div>
          </motion.div>
        );
      case 'profile':
        return (
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="pb-10"
          >
             <div className="flex flex-col items-center mb-10">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center text-3xl mb-4 border-4 border-white shadow-md">👤</div>
                <h3 className="font-bold">健康档案</h3>
                <p className="text-[10px] text-gray-400">{authedEmail ? `已登录：${authedEmail}` : '未登录（当前仅本地存储）'}</p>
             </div>

             <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-50 mb-6">
               <div className="flex items-center justify-between mb-3">
                 <SectionTitle title="邮箱登录" subtitle="SIGN IN" />
                 {authedEmail ? (
                   <button
                     onClick={logout}
                     className="px-4 py-2 rounded-2xl text-xs font-bold border border-gray-100 bg-gray-50 text-gray-600 active:scale-95 transition-transform"
                   >
                     退出
                   </button>
                 ) : null}
               </div>
               {authedEmail ? (
                 <div className="text-xs text-gray-500 leading-relaxed">
                   登录后可以把身高体重、目标等档案同步到云端，并用于 AI 推荐。
                 </div>
               ) : (
                 <div className="space-y-3">
                   <input
                     value={authEmail}
                     onChange={(e) => setAuthEmail(e.target.value)}
                     placeholder="输入邮箱，如 name@example.com"
                     className="w-full bg-gray-50 p-3 rounded-2xl font-bold focus:ring-2 focus:ring-green-500 outline-none transition-all"
                     inputMode="email"
                   />
                   <button
                     onClick={sendLoginLink}
                     disabled={!authEmail.trim() || authSending}
                     className={cn(
                       "w-full py-3.5 rounded-2xl font-bold text-sm shadow-md active:scale-[0.98] transition-transform",
                       !authEmail.trim() || authSending ? "bg-gray-200 text-gray-400 shadow-none" : "bg-[#07c160] text-white"
                     )}
                   >
                     {authSending ? '发送中…' : '发送登录链接（免密码）'}
                   </button>
                   <p className="text-[10px] text-gray-400 leading-relaxed">
                     说明：会发送一封登录邮件，点击后自动回到当前网站完成登录。
                   </p>
                 </div>
               )}
             </div>

             <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-50 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <SectionTitle title="健康报告" subtitle="HEALTH REPORT" />
                  <button
                    onClick={() => generateHealthReport(profile)}
                    disabled={reportLoading}
                    className={cn(
                      "px-4 py-2 rounded-2xl text-xs font-bold border transition-all active:scale-95",
                      reportLoading ? "bg-gray-50 text-gray-300 border-gray-100" : "bg-green-50 text-green-700 border-green-100"
                    )}
                  >
                    {reportLoading ? "生成中…" : (healthReport ? "更新报告" : "生成报告")}
                  </button>
                </div>

                {healthReport ? (
                  <div className="space-y-3">
                    <p className="text-[10px] text-gray-300">生成时间：{new Date(healthReport.generatedAt).toLocaleString()}</p>
                    {healthReport.targets && (
                      <div>
                        <p className="text-[10px] text-gray-300 mb-2">每日目标</p>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-gray-50 rounded-2xl p-3">
                            <p className="text-[10px] text-gray-400 font-bold">热量</p>
                            <p className="text-sm font-black">{healthReport.targets.calories} kcal</p>
                          </div>
                          <div className="bg-gray-50 rounded-2xl p-3">
                            <p className="text-[10px] text-gray-400 font-bold">蛋白质</p>
                            <p className="text-sm font-black">{healthReport.targets.protein} g</p>
                          </div>
                          <div className="bg-gray-50 rounded-2xl p-3">
                            <p className="text-[10px] text-gray-400 font-bold">碳水</p>
                            <p className="text-sm font-black">{healthReport.targets.carbs} g</p>
                          </div>
                          <div className="bg-gray-50 rounded-2xl p-3">
                            <p className="text-[10px] text-gray-400 font-bold">脂肪</p>
                            <p className="text-sm font-black">{healthReport.targets.fat} g</p>
                          </div>
                        </div>
                      </div>
                    )}
                    {reportPreview && (
                      <div className="bg-gradient-to-br from-green-50/60 to-white rounded-2xl p-4 border border-green-100">
                        <p className="text-[10px] font-bold text-green-700 mb-1 uppercase tracking-wider">摘要</p>
                        <p className="text-xs text-gray-700 leading-relaxed">{reportPreview}</p>
                      </div>
                    )}
                    <div className="flex justify-center pt-1">
                      <button
                        onClick={() => setShowReport(true)}
                        className="px-6 py-2 rounded-full text-sm font-medium border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 active:scale-95 transition-transform"
                      >
                        展开报告
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 leading-relaxed">
                    生成报告后，方案推荐会明确说明“为什么这样推荐”，并给出饮食、作息、运动的量化建议。
                  </div>
                )}
             </div>
             
             <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-50 space-y-6">
                <SectionTitle title="基础信息" subtitle="PROFILE" />
                <div className="grid grid-cols-2 gap-6">
                   <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">当前体重 (kg)</label>
                      <input type="number" className="w-full bg-gray-50 p-3 rounded-2xl font-bold focus:ring-2 focus:ring-green-500 outline-none transition-all" value={profile.weight} onChange={e => setProfile({...profile, weight: Number(e.target.value)})} />
                   </div>
                   <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">身高 (cm)</label>
                      <input type="number" className="w-full bg-gray-50 p-3 rounded-2xl font-bold focus:ring-2 focus:ring-green-500 outline-none transition-all" value={profile.height} onChange={e => setProfile({...profile, height: Number(e.target.value)})} />
                   </div>
                </div>
                
                <div className="space-y-2">
                   <div className="pt-2">
                     <SectionTitle title="目标与计划" subtitle="GOALS" />
                   </div>
                   <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'lose', label: '减脂' },
                        { id: 'gain', label: '增肌' },
                        { id: 'shape', label: '塑形' },
                        { id: 'maintain', label: '维持' }
                      ].map(g => (
                        <button 
                          key={g.id} 
                          onClick={() => setProfile({...profile, goal: g.id as any})} 
                          className={cn("py-3 rounded-2xl text-xs font-bold border transition-all", profile.goal === g.id ? 'bg-green-600 text-white border-green-600 shadow-md' : 'bg-gray-50 border-transparent text-gray-400')}
                        >
                          {g.label}
                        </button>
                      ))}
                   </div>
                </div>
                
                <button 
                   onClick={() => {
                     setTempProfile(profile);
                     setOnboardingStep(0);
                     setIsNewUser(true);
                     // 重新评估时清空现有健康报告，避免旧报告内容残留
                     setHealthReport(null);
                   }}
                   className="w-full py-4 bg-green-50 text-green-600 rounded-2xl font-bold text-xs active:scale-95 transition-transform flex items-center justify-center gap-2"
                >
                   <RefreshCw className="w-4 h-4" />
                   重新评估身体状态
                </button>

                <div className="pt-4 space-y-3">
                  <button onClick={() => setShowPrivacy(true)} className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-2xl active:bg-gray-100 transition-colors text-left">
                    <div className="flex items-center gap-3">
                      <ShieldCheck className="w-4 h-4 text-green-600" />
                      <span className="text-xs font-bold">隐私与合规</span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-300" />
                  </button>
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl">
                    <div className="flex items-center gap-3">
                      <Info className="w-4 h-4 text-blue-600" />
                      <span className="text-xs font-bold">关于 Recipe</span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-300" />
                  </div>
                  
                  <button 
                    onClick={() => {
                      console.log("Opening clear database confirm modal");
                      showToast("正在打开确认窗口...", "success");
                      setShowClearConfirm(true);
                    }} 
                    className="w-full py-4 text-red-500 text-xs font-bold border border-red-100 rounded-2xl mt-2 bg-red-50/20 active:bg-red-50 transition-colors flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    清空数据库记录
                  </button>
                </div>
             </div>
             <p className="text-center text-[9px] text-gray-300 mt-8">版本 2.2.0 · 含邮箱登录与云端同步 · Recipe</p>
          </motion.div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="max-w-[500px] mx-auto bg-[#f7f7f7] min-h-screen relative flex flex-col">
      <AnimatePresence>
        {isNewUser && renderOnboarding()}
      </AnimatePresence>
      
      {/* 微信风格顶栏 (Capsule Header) */}
      {/* z-index 须高于引导层 z-[500]，否则新用户全屏引导会挡住「登录」与标题 */}
      <div className="fixed top-0 left-0 right-0 h-16 bg-white/80 backdrop-blur-md flex items-center px-4 z-[520] border-b border-gray-100 max-w-[500px] mx-auto">
         <div className="flex-1 flex items-center gap-3 min-w-0">
            <h1 className="text-base font-bold text-gray-900 shrink-0">Recipe</h1>
            {!authedEmail && (
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className="text-xs font-bold text-[#07c160] px-2 py-1 rounded-lg bg-green-50 border border-green-100 active:scale-95 transition-transform shrink-0"
              >
                登录
              </button>
            )}
         </div>
         <div className="flex items-center bg-gray-50 border border-gray-200 rounded-full px-3 py-1.5 space-x-3">
            <MoreHorizontal className="w-4 h-4 text-gray-800" />
            <div className="w-[1px] h-3 bg-gray-300"></div>
            <Circle className="w-4 h-4 text-gray-800" />
         </div>
      </div>

      {backendOk === false && (
        <div className="fixed top-16 left-0 right-0 max-w-[500px] mx-auto z-[90] bg-amber-500/95 text-white text-center text-xs py-2 px-4">
          后端未连接，方案 / 扫码 / AI专家 可能不可用。请先运行 npm run dev:all 再刷新页面。
        </div>
      )}

      <div className={cn("px-4 flex-1 safe-area-pb", backendOk === false ? "pt-28" : "pt-20")}>
        <AnimatePresence mode="wait">
          {renderTabContent()}
        </AnimatePresence>
      </div>

      {/* 底部导航栏 */}
      <nav className="fixed bottom-0 inset-x-0 mx-auto w-full max-w-[500px] bg-white/95 backdrop-blur-md border-t border-gray-100 grid grid-cols-5 items-center pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] z-[520] shadow-[0_-1px_10px_rgba(0,0,0,0.02)]">
        <TabItem active={activeTab === 'home'} onClick={() => setActiveTab('home')} icon={<Home className="w-6 h-6" />} label="数据" />
        <TabItem active={activeTab === 'recipes'} onClick={() => setActiveTab('recipes')} icon={<ClipboardList className="w-6 h-6" />} label="方案" />
        <div className="relative flex flex-col items-center justify-start">
          <div className="relative -top-5">
            <button 
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg transition-all active:scale-90",
                activeTab === 'scan' ? 'bg-green-700' : 'bg-[#07c160]'
              )} 
              onClick={() => setActiveTab('scan')}
            >
              <Scan className="w-7 h-7" />
            </button>
          </div>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noreferrer"
            className="mt-1 text-[9px] leading-none text-gray-400 hover:text-gray-500"
          >
            粤ICP备2026032930号-1
          </a>
        </div>
        <TabItem active={activeTab === 'coach'} onClick={() => setActiveTab('coach')} icon={<MessageSquare className="w-6 h-6" />} label="AI专家" />
        <TabItem active={activeTab === 'profile'} onClick={() => setActiveTab('profile')} icon={<User className="w-6 h-6" />} label="档案" />
      </nav>

      {reportLoading && (
        <div className="fixed top-16 left-0 right-0 max-w-[500px] mx-auto z-[95] px-4">
          <div className="bg-white/95 backdrop-blur-md border border-gray-100 rounded-2xl px-4 py-2 shadow-sm flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-700">
              <RefreshCw className="w-4 h-4 text-green-600 animate-spin" />
              健康报告后台生成中（预计 8-20 秒）
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {showPrivacy && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] p-8 max-w-sm w-full shadow-2xl"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-bold">隐私与合规说明</h3>
                <button onClick={() => setShowPrivacy(false)} className="text-gray-300"><X className="w-6 h-6" /></button>
              </div>
              <div className="space-y-4 text-xs text-gray-500 leading-relaxed max-h-[60vh] overflow-y-auto no-scrollbar pr-2">
                <p className="font-bold text-gray-800">1. 数据存储</p>
                <p>您的所有健康数据（体重、身高、饮食记录等）均存储在您的本地浏览器缓存中。我们不会在未经您许可的情况下将这些数据上传至任何第三方服务器。</p>
                <p className="font-bold text-gray-800">2. AI 服务</p>
                <p>为了提供智能识别和咨询服务，我们会将您上传的图片或咨询文字发送至豆包（火山方舟）AI。这些数据仅用于生成回复，不用于其他商业用途。</p>
                <p className="font-bold text-gray-800">3. 医疗免责</p>
                <p>Recipe 提供的所有建议均为 AI 生成，仅供参考。在做出重大饮食调整或医疗决定前，请咨询专业医生或营养师。</p>
                <p className="font-bold text-gray-800">4. 微信规范</p>
                <p>本应用严格遵守微信小程序设计规范与内容安全标准，致力于为您提供绿色、健康的营养管理环境。</p>
              </div>
              <button 
                onClick={() => setShowPrivacy(false)}
                className="w-full bg-[#07c160] text-white py-4 rounded-2xl font-bold mt-8 shadow-md active:scale-95 transition-transform"
              >
                我知道了
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showReport && healthReport && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[400] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              className="bg-white rounded-[2.5rem] p-8 max-w-md w-full shadow-2xl"
            >
              <div className="flex justify-between items-center mb-5">
                <div>
                  <h3 className="text-lg font-bold">健康报告</h3>
                  <p className="text-[10px] text-gray-300">生成时间：{new Date(healthReport.generatedAt).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={exportHealthReportAsImage}
                    disabled={reportExporting}
                    className={cn(
                      "px-3 py-2 rounded-xl text-xs font-bold border flex items-center gap-2 active:scale-95 transition-transform",
                      reportExporting ? "bg-gray-50 text-gray-300 border-gray-100" : "bg-white text-gray-800 border-gray-200"
                    )}
                    title="保存为图片"
                  >
                    <Download className="w-4 h-4" />
                    {reportExporting ? "生成中…" : "保存为图片"}
                  </button>
                  <button onClick={() => setShowReport(false)} className="text-gray-300"><X className="w-6 h-6" /></button>
                </div>
              </div>

              {healthReport.targets && (
                <div className="mb-5">
                  <p className="text-[10px] text-gray-300 mb-2">每日目标</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 rounded-2xl p-3">
                      <p className="text-[10px] text-gray-400 font-bold">热量</p>
                      <p className="text-sm font-black">{healthReport.targets.calories} kcal</p>
                    </div>
                    <div className="bg-gray-50 rounded-2xl p-3">
                      <p className="text-[10px] text-gray-400 font-bold">蛋白质</p>
                      <p className="text-sm font-black">{healthReport.targets.protein} g</p>
                    </div>
                    <div className="bg-gray-50 rounded-2xl p-3">
                      <p className="text-[10px] text-gray-400 font-bold">碳水</p>
                      <p className="text-sm font-black">{healthReport.targets.carbs} g</p>
                    </div>
                    <div className="bg-gray-50 rounded-2xl p-3">
                      <p className="text-[10px] text-gray-400 font-bold">脂肪</p>
                      <p className="text-sm font-black">{healthReport.targets.fat} g</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="max-h-[60vh] overflow-y-auto no-scrollbar pr-2">
                <Markdown
                  components={{
                    h1: ({ children }) => (
                      <h1 className="text-xl font-black text-gray-900 mb-3 tracking-tight">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="mt-6 mb-2 text-sm font-black text-green-700 border-l-4 border-green-500 pl-3">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="mt-4 mb-2 text-sm font-extrabold text-gray-900">{children}</h3>
                    ),
                    p: ({ children }) => (
                      <p className="text-xs text-gray-700 leading-relaxed mb-2">{children}</p>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-5 space-y-1 mb-2 text-xs text-gray-700">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal pl-5 space-y-1 mb-2 text-xs text-gray-700">{children}</ol>
                    ),
                    li: ({ children }) => (
                      <li className="leading-relaxed">{children}</li>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="my-3 bg-green-50/60 border border-green-100 rounded-2xl px-4 py-3 text-xs text-green-900">
                        {children}
                      </blockquote>
                    ),
                    strong: ({ children }) => (
                      <strong className="font-extrabold text-gray-900">{children}</strong>
                    ),
                    hr: () => <div className="h-px bg-gray-100 my-4" />,
                  }}
                >
                  {healthReport.reportMarkdown}
                </Markdown>
              </div>

              <div className="pt-5">
                <button
                  onClick={() => setShowReport(false)}
                  className="w-full bg-[#07c160] text-white py-4 rounded-2xl font-bold shadow-md active:scale-95 transition-transform"
                >
                  关闭
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showClearConfirm && (
          <motion.div 
            key="clear-confirm-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div 
              key="clear-confirm-content"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] p-8 max-w-sm w-full shadow-2xl text-center relative z-[10000]"
            >
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center text-2xl mx-auto mb-4">⚠️</div>
              <h3 className="text-lg font-bold mb-2">确定清空数据吗？</h3>
              <p className="text-xs text-gray-400 mb-8 px-4">此操作将永久删除您的健康档案、饮食记录和所有个性化设置，且无法撤销。</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowClearConfirm(false)}
                  className="flex-1 py-4 rounded-2xl font-bold text-sm bg-gray-50 text-gray-400 active:scale-95 transition-transform"
                >
                  取消
                </button>
                <button 
                  onClick={() => {
                    console.log("Clearing all data...");
                    LocalDB.clearAll();
                    // Explicitly reset all states and show onboarding
                    setIsNewUser(true);
                    setOnboardingStep(0);
                    const defaultProfile: UserProfile = {
                      gender: 'male',
                      age: 22,
                      height: 175,
                      weight: 65,
                      targetWeight: 60,
                      wakeUpTime: '07:30',
                      sleepTime: '23:30',
                      mealFrequency: 3,
                      goal: 'lose',
                      trainingDays: 3,
                      trainingDuration: 60,
                      trainingType: 'mixed',
                      trainingTime: 'evening',
                      isFasted: false,
                      healthConditions: [],
                      dietaryRestrictions: [],
                      commonIngredients: '',
                      hatedIngredients: '',
                      diningCondition: 'takeout',
                      habits: [],
                      activityLevel: 'moderate',
                      trackingNeeds: ['calories', 'protein']
                    };
                    setProfile(defaultProfile);
                    setTempProfile(defaultProfile);
                    setDailyIntake([]);
                    setWaterIntake(0);
                    setShowClearConfirm(false);
                    setActiveTab('home');
                    showToast("数据已清空，请重新设置", "success");
                  }}
                  className="flex-1 py-4 rounded-2xl font-bold text-sm bg-red-500 text-white shadow-lg shadow-red-200 active:scale-95 transition-transform"
                >
                  确定清空
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- 子组件 ---

const EditField = ({ label, value, unit, onChange }: any) => (
  <div className="bg-gray-50 p-3 rounded-2xl border border-transparent focus-within:border-green-100 transition-all">
    <label className="text-[8px] text-gray-400 font-bold block mb-1 uppercase tracking-wider">{label}</label>
    <div className="flex items-end">
      <input 
        type="number" 
        className="bg-transparent border-none outline-none font-bold text-sm w-full p-0 focus:ring-0" 
        value={value} 
        onChange={e => onChange(Number(e.target.value))} 
      />
      <span className="text-[10px] text-gray-400 ml-1">{unit}</span>
    </div>
  </div>
);

const TabItem = ({ active, onClick, icon, label }: any) => (
  <button 
    className={cn(
      "w-full flex flex-col items-center gap-1 transition-colors py-1", 
      active ? 'text-[#07c160]' : 'text-gray-400'
    )} 
    onClick={onClick}
  >
    {icon}
    <span className="text-[10px] font-bold">{label}</span>
  </button>
);

// 错误边界：捕获渲染错误，避免白屏并显示原因
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 560 }}>
          <h2 style={{ color: '#c00' }}>页面出错了</h2>
          <pre style={{ background: '#f5f5f5', padding: 12, overflow: 'auto', fontSize: 12 }}>
            {this.state.error.message}
          </pre>
          <p style={{ color: '#666', fontSize: 14 }}>请打开 F12 → Console 查看完整报错，或清除浏览器本地数据后刷新。</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
