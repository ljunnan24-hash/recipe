/**
 * 前端调用的后端 API 封装
 * 所有 AI 请求走后端代理，不在前端暴露 DOUBAO_API_KEY
 */

const API_BASE = '/api';

async function request<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const { json, headers, ...rest } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    try {
      const parsed = text ? JSON.parse(text) : null;
      const msg = parsed?.error || parsed?.message;
      throw new Error(msg || `请求失败 ${res.status}`);
    } catch {
      throw new Error(text || `请求失败 ${res.status}`);
    }
  }
  return res.json();
}

export interface ScanResult {
  name?: string;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  /** 模型估算的当前份量重量（g），后端未命中时可能为 0 */
  estimatedWeightGrams?: number;
  /** 份量感知：small/medium/large 等 */
  portionSize?: string;
  /** 粗略食物类型：staple/meat/veg/soup 等 */
  foodType?: string;
}

/** 食物图片识别 */
export async function aiScan(imageBase64: string, mimeType: string): Promise<ScanResult> {
  return request<ScanResult>('/ai/scan', {
    method: 'POST',
    json: { imageBase64, mimeType },
  });
}

/** 生成三餐方案（selectedCanteen 为 szu_south 时后端从 Supabase 拉取深大食堂菜品并做针对性推荐） */
export async function aiPlan(
  prompt: string,
  selectedCanteen?: 'none' | 'szu_south',
  extra?: {
    profile?: unknown;
    targets?: { calories?: number };
    avoidNames?: string[];
  }
): Promise<{
  breakfast?: { name: string; calories: number; desc: string; category?: string; dishNames?: string[] };
  lunch?: { name: string; calories: number; desc: string; category?: string; dishNames?: string[] };
  dinner?: { name: string; calories: number; desc: string; category?: string; dishNames?: string[] };
}> {
  return request('/ai/plan', {
    method: 'POST',
    json: {
      prompt,
      selectedCanteen: selectedCanteen ?? 'none',
      profile: extra?.profile,
      targets: extra?.targets,
      avoidNames: extra?.avoidNames,
    },
  });
}

/** 获取食堂菜品列表（如深大南区菜单） */
export async function getCanteenDishes(canteen: string = 'szu_south'): Promise<{ dishes: Array<{ name: string; calories: number; protein: number; carbs: number; fat: number; category: string; description?: string }> }> {
  return request(`/canteen/dishes?canteen=${encodeURIComponent(canteen)}`);
}

/** AI 对话（单轮） */
export async function aiChat(message: string, systemInstruction: string): Promise<{ text: string }> {
  return request<{ text: string }>('/ai/chat', {
    method: 'POST',
    json: { message, systemInstruction },
  });
}

export interface HealthReportResponse {
  aiOk?: boolean;
  generatedAt?: string;
  reportMarkdown?: string;
  targets?: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    waterMl?: number;
    sleepHours?: number;
    steps?: number;
  };
}

/** 生成健康报告（基于用户档案 + 目标摄入） */
export async function aiHealthReport(profile: unknown, targets: unknown): Promise<HealthReportResponse> {
  return request<HealthReportResponse>('/ai/report', {
    method: 'POST',
    json: { profile, targets },
  });
}
