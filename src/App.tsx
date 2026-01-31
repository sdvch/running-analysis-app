import React, {
  useState,
  useRef,
  useEffect,
  useMemo,
  ChangeEvent,
} from "react";
import "./App.css";
import { supabase } from "./lib/supabaseClient";
import Chart from "chart.js/auto";
import { generateRunningEvaluation, type RunningEvaluation } from "./runningEvaluation";
// New multi-camera components
import { MultiCameraSetup } from './components/MultiCameraSetup';
import CanvasRoiSelector from './components/CanvasRoiSelector';
import { CanvasRoi, getCanvasCoordinates, drawFrameWithOverlay, extractRoiForPoseEstimation } from './utils/canvasUtils';
import { Step5Simple } from './components/Step5Simple';
import { Step5Complete } from './components/Step5Complete';
import Step5IntervalSetting, { Roi as Step5Roi } from './components/Step5IntervalSetting';
import type {
  Run,
  RunSegment,
  RunAnalysisResult,
  MultiCameraAnalysisState,
} from "./types/multiCameraTypes";
// Old imports kept for compatibility during transition
import { combineSegmentSteps, calculateMultiCameraStats } from './utils/multiCameraUtils';
import MobileSimplifier from './components/MobileSimplifier';
import MobileHeader from './components/MobileHeader';
import MultiCameraAnalyzer from "./components/MultiCameraAnalyzer";
import { parseMedia } from "@remotion/media-parser";
import { calculateHFVP, type HFVPResult, type StepDataForHFVP } from './utils/hfvpCalculator';

/** ウィザードのステップ */
type WizardStep = 0 | 1 | 2 | 3 | 3.5 | 4 | 5 | 5.5 | 6 | 6.5 | 7 | 8 | 9;

/** 解析モード */
type AnalysisMode = 'single' | 'panning';

/** 測定者情報 */
type AthleteInfo = {
  name: string;
  age: number | null;
  gender: 'male' | 'female' | 'other' | null;
  affiliation: string;
  height_cm: number | null;
  weight_kg?: number | null;  // 体重（kg）- オプショナル
  current_record: string;
  target_record: string;
};

type AthleteOption = {
  id: string;
  full_name: string;
  gender: "male" | "female" | "other" | null;
  affiliation: string | null;
  birthdate: string | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  current_record_s: number | null;
  target_record_s: number | null;
};


/** Supabase の running_analysis_sessions の型 */
type RunningAnalysisSession = {
  id: string;
  created_at: string;
  source_video_name: string | null;
  distance_m: number | null;
  frames_count: number | null;
  section_start_frame: number | null;
  section_end_frame: number | null;
  section_frame_count: number | null;
  section_time_s: number | null;
  avg_speed_mps: number | null;
  label: string | null;
  notes: string | null;
  target_fps: number | null;
};

/** 接地／離地マーカーから計算した 1 歩ごとのデータ */
type StepMetric = {
  index: number;
  contactFrame: number;
  toeOffFrame: number;
  nextContactFrame: number | null;
  contactTime: number | null;
  flightTime: number | null;
  stepTime: number | null;
  stepPitch: number | null;
  stride: number | null;
  speedMps: number | null;
  acceleration: number | null; // 加速度 (m/s²)
  // ブレーキ/キック比率
  brakeTimeRatio?: number;     // 接地中の「減速している時間の割合」
  kickTimeRatio?: number;      // 接地中の「加速している時間の割合」
  brakeImpulseRatio?: number;  // 速度変化量ベースのブレーキ比率
  kickImpulseRatio?: number;   // 速度変化量ベースのキック比率
  // 🎯 ストライド詳細（新仕様）
  fullStride?: number;         // その一歩の本来のストライド長 (contact → contact)
  sectionStride?: number;      // 10m区間内で担当した距離
  distanceAtContact?: number;  // 接地時のスタートラインからの距離 [m]
  isFirstStepFromStart?: boolean; // スタートダッシュの1歩目かどうか
  // 🆕 追加フィールド
  leg?: "left" | "right";      // どちらの足のステップか（現時点では未使用でOK）
  quality?: "good" | "warning" | "bad"; // 解析の信頼度（色分けに使用）
  isInterpolated?: boolean;    // 補間ステップかどうか（ストライド再計算から除外）
  // 🎯 ステップごとの姿勢データ（加速局面の段階的評価用）
  trunkAngleAtContact?: number | null;  // 接地時の体幹角度
  kneeFlexAtContact?: number | null;    // 接地時の膝角度（支持脚）
  // 🎯 マルチカメラ用：ピクセル座標（Homography変換用）
  contactPixelX?: number;      // 接地時の足のX座標（ピクセル）
  segmentId?: string;          // マルチカメラ: どのセグメントのステップか
  contactPixelY?: number;      // 接地時の足のY座標（ピクセル）
  toeOffPixelX?: number;       // 離地時の足のX座標（ピクセル）
  toeOffPixelY?: number;       // 離地時の足のY座標（ピクセル）
};
type MarkerMode = "semi" | "manual";
type MultiCameraState = {
  run: Run;
  segments: RunSegment[];
  videoFiles: { [key: string]: File };
  currentIndex: number;
  segmentMetrics: Record<string, StepMetric[]>;
  initialFps?: number; // マルチカメラ解析開始時のFPS設定を保持
  segmentFrames?: Record<string, ImageData[]>; // 各セグメントのフレームデータ
  segmentPoseResults?: Record<string, (FramePoseData | null)[]>; // 各セグメントのポーズデータ
};

type MultiCameraSummary = {
  totalDistance: number;
  totalSegments: number;
  totalSteps: number;
  avgStride: number | null;
  avgContact: number | null;
  avgFlight: number | null;
  avgSpeed: number | null;
  totalTime?: number;
  avgSpeedCalculated?: number | null;
};

/** 走行タイプ: accel=加速走（フライングスタート）, dash=スタートダッシュ */
type RunType = 'accel' | 'dash';

/** 各フレームの姿勢推定結果 */
type FramePoseData = {
  landmarks: Array<{ x: number; y: number; z: number; visibility: number }>;
};

/** 関節角度データ */
type AngleData = {
  frame: number;
  trunkAngle: number | null;
  hipAnkleAngle: { left: number | null; right: number | null };
  thighAngle: { left: number | null; right: number | null };
  shankAngle: { left: number | null; right: number | null };
  kneeFlex: { left: number | null; right: number | null };
  ankleFlex: { left: number | null; right: number | null };
  elbowAngle: { left: number | null; right: number | null };
  toeHorizontalDistance: { left: number | null; right: number | null };
};

/** 3局面での角度データ */
type PhaseAngles = {
  stepIndex: number;
  phase: "initial" | "mid" | "late";
  frame: number;
  angles: Omit<AngleData, "frame">;
};

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/** 角度計算 */
const calculateAngles = (
  landmarks: FramePoseData["landmarks"]
): Omit<AngleData, "frame"> => {
  const getPoint = (idx: number) => landmarks[idx];
  
  // 主要なランドマークの信頼度をチェック
  const CONFIDENCE_THRESHOLD = 0.05; // さらに認識率を向上（0.1 → 0.05）

  const leftHip = getPoint(23);
  const rightHip = getPoint(24);
  const leftShoulder = getPoint(11);
  const rightShoulder = getPoint(12);
  
  // 主要なポイントの信頼度が低い場合、nullを返す
  if (
    leftHip.visibility < CONFIDENCE_THRESHOLD ||
    rightHip.visibility < CONFIDENCE_THRESHOLD ||
    leftShoulder.visibility < CONFIDENCE_THRESHOLD ||
    rightShoulder.visibility < CONFIDENCE_THRESHOLD
  ) {
    return {
      trunkAngle: null,
      hipAnkleAngle: { left: null, right: null },
      thighAngle: { left: null, right: null },
      shankAngle: { left: null, right: null },
      kneeFlex: { left: null, right: null },
      ankleFlex: { left: null, right: null },
      elbowAngle: { left: null, right: null },
      toeHorizontalDistance: { left: null, right: null },
    };
  }

  const hipCenter = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };
  const shoulderCenter = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  const dx = shoulderCenter.x - hipCenter.x;
  const dy = shoulderCenter.y - hipCenter.y;

  // 体幹角度: 垂直=90°、前傾で減少（80-40°）、後傾で増加（95-100°+）
  // atan2(dx, -dy) で計算し、垂直を基準に調整
  let trunkAngle = 90 - (Math.atan2(dx, -dy) * 180) / Math.PI;
  
  // 角度を0-180の範囲に正規化
  while (trunkAngle < 0) trunkAngle += 180;
  while (trunkAngle > 180) trunkAngle -= 180;

  const calcLegAngles = (side: "left" | "right") => {
    const hipIdx = side === "left" ? 23 : 24;
    const kneeIdx = side === "left" ? 25 : 26;
    const ankleIdx = side === "left" ? 27 : 28;
    const toeIdx = side === "left" ? 31 : 32;

    const hip = getPoint(hipIdx);
    const knee = getPoint(kneeIdx);
    const ankle = getPoint(ankleIdx);
    const toe = getPoint(toeIdx);

    // Hip-Ankle角度：腰から足首への角度（参考値）
    const hipAnkleAngle =
      (Math.atan2(ankle.x - hip.x, -(ankle.y - hip.y)) * 180) / Math.PI;

    // 大腿角度：鉛直下向きを0°として、前方がマイナス、後方がプラス
    // atan2(dx, dy)で計算し、符号を反転（右方向がマイナス、左方向がプラス）
    const dx = knee.x - hip.x;
    const dy = knee.y - hip.y; // yは下向きが正
    let thighAngle = (Math.atan2(dx, dy) * 180) / Math.PI;
    // 符号を反転：右（前方）をマイナス、左（後方）をプラス
    thighAngle = -thighAngle;

    // 下腿角度：鉛直下向きを0°として計算
    const shankDx = ankle.x - knee.x;
    const shankDy = ankle.y - knee.y;
    let shankAngle = (Math.atan2(shankDx, shankDy) * 180) / Math.PI;
    shankAngle = -shankAngle;

    const v1 = { x: knee.x - hip.x, y: knee.y - hip.y };
    const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
    const cosAngle = dot / (mag1 * mag2);
    const kneeAngleRad = Math.acos(clamp(cosAngle, -1, 1));
    const kneeFlex = 180 - (kneeAngleRad * 180) / Math.PI;

    const v3 = { x: toe.x - ankle.x, y: toe.y - ankle.y };
    const dot2 = v2.x * v3.x + v2.y * v3.y;
    const mag3 = Math.sqrt(v3.x * v3.x + v3.y * v3.y);
    const cosAngle2 = dot2 / (mag2 * mag3);
    const ankleAngleRad = Math.acos(clamp(cosAngle2, -1, 1));
    const ankleFlex = 180 - (ankleAngleRad * 180) / Math.PI;

    // 足先の水平距離を計算
    // 大転子（hip）から鉛直下方向に対する足先（toe）の水平距離
    // 正規化座標（0-1）なので、大腿長を基準にcm換算する
    const thighLength = mag1; // 大腿の長さ（正規化座標）
    const toeHorizontalOffset = toe.x - hip.x; // 水平方向のオフセット
    // 符号を反転：右（前方）をマイナス、左（後方）をプラス
    const toeHorizontalDistance = -toeHorizontalOffset;
    
    // 実際の距離に変換するため、平均的な大腿長を50cmと仮定
    // これにより、正規化座標を実際のcmに変換
    const ASSUMED_THIGH_LENGTH_CM = 50;
    const toeHorizontalDistanceCm = thighLength > 0 
      ? (toeHorizontalDistance / thighLength) * ASSUMED_THIGH_LENGTH_CM 
      : null;

    return {
      hipAnkleAngle,
      thighAngle,
      shankAngle,
      kneeFlex,
      ankleFlex,
      toeHorizontalDistanceCm,
    };
  };

  const left = calcLegAngles("left");
  const right = calcLegAngles("right");

  // 腕振り角度の計算（肘の屈曲角度）
  const calcElbowAngle = (side: "left" | "right"): number | null => {
    const shoulderIdx = side === "left" ? 11 : 12;
    const elbowIdx = side === "left" ? 13 : 14;
    const wristIdx = side === "left" ? 15 : 16;

    const shoulder = getPoint(shoulderIdx);
    const elbow = getPoint(elbowIdx);
    const wrist = getPoint(wristIdx);

    // 肘、肩、手首の信頼度をチェック
    if (
      shoulder.visibility < CONFIDENCE_THRESHOLD ||
      elbow.visibility < CONFIDENCE_THRESHOLD ||
      wrist.visibility < CONFIDENCE_THRESHOLD
    ) {
      return null;
    }

    // 肘角度の計算：上腕（肩→肘）と前腕（肘→手首）のベクトルから
    const v1 = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y };
    const v2 = { x: wrist.x - elbow.x, y: wrist.y - elbow.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
    
    if (mag1 === 0 || mag2 === 0) return null;
    
    const cosAngle = dot / (mag1 * mag2);
    const elbowAngleRad = Math.acos(clamp(cosAngle, -1, 1));
    // 肘屈曲角度：180° - アーク角度
    const elbowFlex = 180 - (elbowAngleRad * 180) / Math.PI;

    return elbowFlex;
  };

  const leftElbow = calcElbowAngle("left");
  const rightElbow = calcElbowAngle("right");

  return {
    trunkAngle,
    hipAnkleAngle: { left: left.hipAnkleAngle, right: right.hipAnkleAngle },
    thighAngle: { left: left.thighAngle, right: right.thighAngle },
    shankAngle: { left: left.shankAngle, right: right.shankAngle },
    kneeFlex: { left: left.kneeFlex, right: right.kneeFlex },
    ankleFlex: { left: left.ankleFlex, right: right.ankleFlex },
    elbowAngle: { left: leftElbow, right: rightElbow },
    toeHorizontalDistance: { left: left.toeHorizontalDistanceCm, right: right.toeHorizontalDistanceCm },
  };
};

/** グラフ用の指標キー */
type GraphMetricKey =
  | "contactTime"
  | "flightTime"
  | "stepPitch"
  | "stride"
  | "speedMps"
  | "brakeRatio"
  | "kickRatio";

const metricLabels: Record<GraphMetricKey, string> = {
  contactTime: "接地時間 [s]",
  flightTime: "滞空時間 [s]",
  stepPitch: "ピッチ [歩/s]",
  stride: "ストライド [m]",
  speedMps: "スピード [m/s]",
  brakeRatio: "ブレーキ率 [%]",
  kickRatio: "キック率 [%]",
};

const metricColors: Record<GraphMetricKey, string> = {
  contactTime: "#2563eb",
  flightTime: "#10b981",
  stepPitch: "#f97316",
  stride: "#7c3aed",
  speedMps: "#dc2626",
  brakeRatio: "#ef4444",
  kickRatio: "#22c55e",
};

type AppProps = {
  userProfile?: {
    height_cm?: number | null;
    name: string;
    membership?: 'free' | 'pro' | null;
  } | null;
};

// ============================================================
// ブレーキ/キック比率計算用のヘルパー関数
// ============================================================

/**
 * COM（重心）のx座標配列から水平速度を計算
 * @param comX - 各フレームの重心x座標配列
 * @param fps - フレームレート
 * @returns 各フレームの速度配列
 */
function computeHorizontalVelocity(comX: number[], fps: number): number[] {
  const dt = 1 / fps;
  const v: number[] = new Array(comX.length).fill(0);

  if (comX.length < 2) return v;

  // 端のフレームは片側差分
  v[0] = (comX[1] - comX[0]) / dt;
  for (let i = 1; i < comX.length - 1; i++) {
    v[i] = (comX[i + 1] - comX[i - 1]) / (2 * dt); // 中央差分
  }
  v[comX.length - 1] = (comX[comX.length - 1] - comX[comX.length - 2]) / dt;

  return v;
}

/**
 * 1歩分のブレーキ/キック比率を計算
 * @param step - ステップメトリクス
 * @param velocity - 速度配列
 * @returns ブレーキ/キック比率 + quality
 */
function computeBrakeKickRatiosForStep(
  step: StepMetric,
  velocity: number[]
): Pick<StepMetric, "brakeTimeRatio" | "kickTimeRatio" | "brakeImpulseRatio" | "kickImpulseRatio" | "quality"> {
  const { contactFrame, toeOffFrame } = step;

  // dv[k] = v[k+1] - v[k] を使うので -2 しておく
  const start = Math.max(0, contactFrame);
  const end = Math.min(velocity.length - 2, toeOffFrame);

  const stanceFrames = end - start + 1;
  if (stanceFrames <= 1) {
    return {
      brakeTimeRatio: undefined,
      kickTimeRatio: undefined,
      brakeImpulseRatio: undefined,
      kickImpulseRatio: undefined,
      quality: "bad", // フレーム数不足
    };
  }

  let brakeFrameCount = 0;
  let kickFrameCount = 0;
  let brakeImpulse = 0;
  let kickImpulse = 0;

  for (let k = start; k <= end; k++) {
    const dv = velocity[k + 1] - velocity[k];

    if (dv < 0) {
      brakeFrameCount++;
      brakeImpulse += -dv; // 減速量を正の値として加算
    } else if (dv > 0) {
      kickFrameCount++;
      kickImpulse += dv;
    }
    // dv ≈ 0 はどちらにも入れない
  }

  const usedFrames = brakeFrameCount + kickFrameCount;
  let brakeTimeRatio: number | undefined;
  let kickTimeRatio: number | undefined;
  let brakeImpulseRatio: number | undefined;
  let kickImpulseRatio: number | undefined;
  
  // 🆕 quality の判定
  let quality: "good" | "warning" | "bad" | undefined;
  if (usedFrames < 3) {
    quality = "bad";
  } else if (usedFrames < 6) {
    quality = "warning";
  } else {
    quality = "good";
  }

  if (usedFrames > 0) {
    brakeTimeRatio = brakeFrameCount / usedFrames;
    kickTimeRatio = kickFrameCount / usedFrames;
  }

  const totalImpulse = brakeImpulse + kickImpulse;
  if (totalImpulse > 0) {
    brakeImpulseRatio = brakeImpulse / totalImpulse;
    kickImpulseRatio = kickImpulse / totalImpulse;
  }

  return {
    brakeTimeRatio,
    kickTimeRatio,
    brakeImpulseRatio,
    kickImpulseRatio,
    quality,
  };
}

/**
 * 全ステップにブレーキ/キック比率を追加
 * @param steps - ステップメトリクス配列
 * @param comX - 重心x座標配列
 * @param fps - フレームレート
 * @returns ブレーキ/キック比率が追加されたステップメトリクス配列
 */
function attachBrakeKickRatiosToSteps(
  steps: StepMetric[],
  comX: number[],
  fps: number
): StepMetric[] {
  const velocity = computeHorizontalVelocity(comX, fps);

  return steps.map((step) => {
    const ratios = computeBrakeKickRatiosForStep(step, velocity);
    return {
      ...step,
      ...ratios,
    };
  });
}

const App: React.FC<AppProps> = ({ userProfile }) => {
  // userProfile は AppWithAuth から渡される（認証済み）

  // デバイス判定（PC/モバイル/タブレット）
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);

  useEffect(() => {
    const checkDevice = () => {
      const ua = navigator.userAgent;
      const width = window.innerWidth;
      
      // モバイル判定（iPhone, Android phone）
      // iPad含むモバイルデバイスとして統一（モバイルUI強制）
      const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(ua) || width < 1024;
      
      setIsMobile(isMobileDevice);
      setIsTablet(false); // iPadもモバイルとして扱うため、タブレット判定は常にfalse
      
      console.log(`📱 デバイス判定: ${isMobileDevice ? 'モバイル（iPad含む）' : 'PC'} (幅: ${width}px, UA: ${ua.substring(0, 50)})`);
    };
    
    checkDevice();
    window.addEventListener('resize', checkDevice);
    return () => window.removeEventListener('resize', checkDevice);
  }, []);

const [wizardStep, setWizardStep] = useState<WizardStep>(0);
  const [selectedFps, setSelectedFps] = useState<number>(120); 
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('single');
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [runSegments, setRunSegments] = useState<RunSegment[]>([]);
  const [isMultiCameraSetup, setIsMultiCameraSetup] = useState(false);
  const [multiCameraData, setMultiCameraData] = useState<MultiCameraState | null>(null);
// ✅ multiで setState が反映される前に参照できるようにする（同期Ref）
  const videoFileRef = useRef<File | null>(null);
  const setVideoFileSync = (f: File | null) => { videoFileRef.current = f; setVideoFile(f); };
  // ✅ multi/単一どちらでも「今使うべき動画ファイル」を返す
const getActiveVideoFile = (): File | null => {
  // single は従来通り
  if (true /* single mode */) return videoFile ?? null;

  // 1) 同期Refがあれば最優先
  if (videoFileRef.current) return videoFileRef.current;

  // 2) multiCameraData から「現在セグメントのfile」を復元
  const data = multiCameraData;
  if (data) {
    const idx = data.currentIndex ?? 0;
    const seg = data.segments?.[idx];
    const idxKey = String((seg as any)?.segmentIndex ?? idx);

    const f =
      (seg ? data.videoFiles?.[seg.id] : null) ??
      data.videoFiles?.[idxKey] ??
      null;

    if (f) return f;
  }

  // 3) 最後に state の videoFile にフォールバック
  return videoFile ?? null;
};


  const [multiCameraSummary, setMultiCameraSummary] = useState<MultiCameraSummary | null>(null);
  const [multiRun, setMultiRun] = useState<Run | null>(null);
  const [multiSegments, setMultiSegments] = useState<RunSegment[] | null>(null);
  const [isMultiCameraAnalyzing, setIsMultiCameraAnalyzing] = useState(false);
  const [mergedStepMetrics, setMergedStepMetrics] = useState<StepMetric[]>([]);
  const [currentVideoSegmentIndex, setCurrentVideoSegmentIndex] = useState<number>(0);

// ------------- 測定者情報 -------------------
const initialAthleteInfo: AthleteInfo = {
  name: "",
  age: null,
  gender: null,
  affiliation: "",
  height_cm: null,
  weight_kg: null,  // 体重（kg）
  current_record: "",
  target_record: "",
};

const [athleteInfo, setAthleteInfo] =
  useState<AthleteInfo>(initialAthleteInfo);

// ------------- 登録済み選手リスト -------------------
const [athleteOptions, setAthleteOptions] = useState<AthleteOption[]>([]);
const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);

// ログイン中ユーザーの選手一覧を読み込む
useEffect(() => {
  const loadAthletes = async () => {
    console.log('🔄 選手リスト読み込み開始...');
    
    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession();

    if (sessionError) {
      console.error('❌ セッションエラー:', sessionError);
      return;
    }

    if (!sessionData.session) {
      console.log('⚠️ セッションなし - ログインが必要');
      return;
    }

    const authUserId = sessionData.session.user.id;
    console.log('✅ ユーザーID:', authUserId);

    // 一時的に weight_kg を除外（カラムが存在しない場合のフォールバック）
    let { data, error } = await supabase
      .from("athletes")
      .select(
        "id, full_name, sex, birth_date, affiliation, height_cm, weight_kg, current_record_s, target_record_s"
      )
      .eq("owner_auth_user_id", authUserId)
      .order("created_at", { ascending: false });

    // weight_kg カラムが存在しない場合、weight_kg なしで再試行
    if (error && error.code === '42703' && error.message.includes('weight_kg')) {
      console.warn('⚠️ weight_kg カラムが存在しません。weight_kg なしで取得します。');
      const retry = await supabase
        .from("athletes")
        .select(
          "id, full_name, sex, birth_date, affiliation, height_cm, current_record_s, target_record_s"
        )
        .eq("owner_auth_user_id", authUserId)
        .order("created_at", { ascending: false });
      
      // weight_kg フィールドを null で追加
      data = retry.data?.map((row: any) => ({ ...row, weight_kg: null })) ?? null;
      error = retry.error;
    }

    if (error) {
      console.error("❌ athletes の取得に失敗:", error);
      console.error("エラー詳細:", JSON.stringify(error, null, 2));
      return;
    }

    const rows = data ?? [];
    console.log(`📊 取得した選手数: ${rows.length}`, rows);

    const options: AthleteOption[] = rows.map((row: any) => {
      // ① 誕生日（birth_date など）から年齢を計算
      const birthRaw: string | null =
        row.birth_date ?? row.birthdate ?? row.date_of_birth ?? null;

      let computedAge: number | null = null;
      if (birthRaw) {
        const birth = new Date(birthRaw);
        if (!isNaN(birth.getTime())) {
          const today = new Date();
          computedAge = today.getFullYear() - birth.getFullYear();
          const m = today.getMonth() - birth.getMonth();
          if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
            computedAge--;
          }
        }
      }

      // テーブルに age カラムがあればそちらを優先。なければ計算結果
      const age: number | null =
        typeof row.age === "number" ? row.age : computedAge;

      // ② gender / sex を統一（日本語 → male / female / other に変換）
      const rawGender: string | null =
        (row.gender as string | null) ?? (row.sex as string | null) ?? null;

      let genderValue: "male" | "female" | "other" | null = null;
      if (rawGender) {
        switch (rawGender) {
          case "male":
          case "男性":
          case "男":
            genderValue = "male";
            break;
          case "female":
          case "女性":
          case "女":
            genderValue = "female";
            break;
          case "other":
          case "その他":
            genderValue = "other";
            break;
          default:
            genderValue = "other";
        }
      }

      // ③ affiliation も候補カラムを全部見て拾う
      const affiliationValue: string | null =
        row.affiliation ?? row.team ?? null;

      return {
        id: row.id,
        full_name: row.full_name ?? "",
        gender: genderValue,
        affiliation: affiliationValue,
        height_cm: row.height_cm ?? null,
        weight_kg: row.weight_kg ?? null,
        current_record_s: row.current_record_s ?? null,
        target_record_s: row.target_record_s ?? null,
        birthdate: birthRaw,
        age,
      };
    });

    console.log('✅ 選手オプション作成完了:', options);
    setAthleteOptions(options);
  };

  loadAthletes();
}, []);






  // 選手をプルダウンで選んだら測定者情報フォームに反映
  useEffect(() => {
    if (!selectedAthleteId) return;

    const selected = athleteOptions.find(
      (a) => a.id === selectedAthleteId
    );
    if (!selected) return;

    setAthleteInfo((prev) => ({
      ...prev,
      name: selected.full_name,
      height_cm: selected.height_cm,
      weight_kg: selected.weight_kg,
      current_record:
        selected.current_record_s != null
          ? String(selected.current_record_s)
          : "",
      target_record:
        selected.target_record_s != null
          ? String(selected.target_record_s)
          : "",
    }));
  }, [selectedAthleteId, athleteOptions]);

  // ------------- 動画・フレーム関連 -------------------
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [sourceVideoFile, setSourceVideoFile] = useState<File | null>(null);

  const [isExtracting, setIsExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);
  const [status, setStatus] = useState<string>("");

  const framesRef = useRef<ImageData[]>([]);
  const [framesCount, setFramesCount] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  
  // パーン撮影モード用スプリットタイム
  interface PanningSplit {
    frame: number;
    time: number;
    distance: number;
    isStart?: boolean;
    isEnd?: boolean;
  }
  const [panningSplits, setPanningSplits] = useState<PanningSplit[]>([]);
  const [panningStartIndex, setPanningStartIndex] = useState<number | null>(null);
  const [panningEndIndex, setPanningEndIndex] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoWidth, setVideoWidth] = useState<number | null>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const panningCanvasRef = useRef<HTMLCanvasElement | null>(null); // パーン撮影専用

  const [usedTargetFps, setUsedTargetFps] = useState<number | null>(null);

  // ===== 新しい解析を開始（リセット）ボタン用 =====



  // チュートリアル
  // チュートリアルの表示設定をローカルストレージから取得
  const [showTutorial, setShowTutorial] = useState(() => {
    const savedPreference = localStorage.getItem('hideTutorial');
    return savedPreference !== 'true'; // 'true'の場合は表示しない
  });
  const [tutorialStep, setTutorialStep] = useState(0); // 現在のステップ
  // チュートリアルステップをリセットする関数
  const resetTutorialStep = () => {
    setTutorialStep(0);
  };

  // URLパラメータからセッションビューモードを確認
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const viewMode = urlParams.get('viewMode');
    const sessionId = urlParams.get('sessionId');
    const step = urlParams.get('step');
    
    if (viewMode === 'true' && sessionId) {
      // ローカルストレージからセッションデータを読み込む
      const storedData = localStorage.getItem('viewSessionData');
      const fullSession = localStorage.getItem('viewFullSession');
      
      if (storedData) {
        try {
          const sessionData = JSON.parse(storedData);
          console.log('Loading session data for viewing:', sessionData);
          
          // データを復元（実装は後で調整）
          if (step === '6' && sessionData) {
            // ステップ6（結果表示）へジャンプ
            setWizardStep(6);
            
            // セッションデータから各種データを復元
            // Note: ステート更新関数が存在する場合のみ実行
            // これは読み取り専用モードのため、将来的な実装として残す
            console.log('Session data loaded for viewing:', {
              hasStepMetrics: !!sessionData.stepMetrics,
              hasThreePhaseAngles: !!sessionData.threePhaseAngles,
              hasStepSummary: !!sessionData.stepSummary,
              hasAthleteInfo: !!sessionData.athleteInfo
            });
            
            // URLをクリーンにする
            window.history.replaceState({}, document.title, '/');
          }
        } catch (e) {
          console.error('Failed to load session data:', e);
        }
      }
    }
  }, []);


  // 足元拡大
  const [footZoomEnabled, setFootZoomEnabled] = useState(false);
  const [zoomScale, setZoomScale] = useState(3);

  // ------------ 動画最適化関連 -----------------
  // ------------ 姿勢推定関連 -----------------
  const [poseResults, setPoseResults] = useState<(FramePoseData | null)[]>([]);
  const [isPoseProcessing, setIsPoseProcessing] = useState(false);
  const [poseProgress, setPoseProgress] = useState(0);
  const [showSkeleton, setShowSkeleton] = useState(true);  // デフォルトでON（姿勢データの確認用）

  // ------------ 区間指定 ------------
  const [sectionStartFrame, setSectionStartFrame] = useState<number | null>(
    null
  );
  const [sectionMidFrame, setSectionMidFrame] = useState<number | null>(null);
  const [sectionEndFrame, setSectionEndFrame] = useState<number | null>(null);
  
  // 線の水平オフセット（ピクセル単位）
  const [startLineOffset, setStartLineOffset] = useState(0);
  const [midLineOffset, setMidLineOffset] = useState(0);
  const [endLineOffset, setEndLineOffset] = useState(0);
  
  // 設定時の腰の位置を記憶（正規化座標 0-1）
  const [savedStartHipX, setSavedStartHipX] = useState<number | null>(null);
  const [savedMidHipX, setSavedMidHipX] = useState<number | null>(null);
  const [savedEndHipX, setSavedEndHipX] = useState<number | null>(null);
  
  // 🎥 パン撮影対応: 絶対ピクセル位置を保存（腰の位置ではなく、画面上の固定位置）
  const [savedStartPixelX, setSavedStartPixelX] = useState<number | null>(null);
  const [savedMidPixelX, setSavedMidPixelX] = useState<number | null>(null);
  const [savedEndPixelX, setSavedEndPixelX] = useState<number | null>(null);
  
  // ------------ 走行タイプ選択 ------------
  // accel = 加速走（フライングスタート）: 助走あり、スタートラインからの1歩目は特別扱いしない
  // dash = スタートダッシュ: 静止スタート、1歩目は 0m → 1st contact として重要
  const [runType, setRunType] = useState<RunType>('accel');

  const sectionRange = useMemo(() => {
    const rawStart = sectionStartFrame ?? 0;
    // スタートの50フレーム前から解析開始（助走部分も含める）
    const start = Math.max(0, rawStart - 50);

    const end =
      sectionEndFrame ??
      (framesRef.current.length > 0 ? framesRef.current.length - 1 : 0);
    const count = end >= start ? end - start + 1 : 0;
    
    // 実際の選択範囲のフレーム数（スタート地点～フィニッシュ地点）
    const actualCount = (sectionStartFrame != null && sectionEndFrame != null) 
      ? sectionEndFrame - sectionStartFrame
      : 0;

    return { start, end, count, displayStart: rawStart, actualCount };
  }, [sectionStartFrame, sectionEndFrame, framesCount]);

  const sectionTime =
  usedTargetFps && sectionRange.actualCount > 0
    ? sectionRange.actualCount / usedTargetFps
    : null;

// ★ 新しい解析を最初からやり直すハンドラ
const handleStartNewAnalysis = () => {
  // ウィザードをステップ0に戻す
  setWizardStep(0);

  // 測定者情報をリセット
  setSelectedAthleteId(null);
  setAthleteInfo(initialAthleteInfo);

  // 動画・フレーム関連
  setVideoFile(null);
  setVideoUrl(null);
  setIsExtracting(false);
  setExtractProgress(0);
  setStatus("");               // ← あなたのコードは status / setStatus なのでここは setStatus

  // フレーム情報
  framesRef.current = [];      // ← setFrames は存在しないので、ref を直接クリア
  setFramesCount(0);
  setCurrentFrame(0);
  setUsedTargetFps(null);

  // 姿勢推定結果
  setPoseResults([]);
  setIsPoseProcessing(false);
  setPoseProgress(0);

  // 区間設定
  setSectionStartFrame(null);
  setSectionMidFrame(null);
  setSectionEndFrame(null);
  
  // パーン撮影モード: スプリットタイムをリセット
  setPanningSplits([]);

  // 必要ならラインオフセット類もリセット（あれば）
  // setStartLineOffset(0);
  // setMidLineOffset(0);
  // setEndLineOffset(0);

  // 一番上までスクロール
  window.scrollTo({ top: 0, behavior: "smooth" });
};

// ------------- 距離・速度・ラベル -------------
const [distanceInput, setDistanceInput] = useState<string>("0");
const [labelInput, setLabelInput] = useState<string>("");
const [notesInput, setNotesInput] = useState<string>("");

  
  // ------------ 被検者の身長・体重（athleteInfo から取得） ---------------
  // ※ ステップ1の入力欄は削除済み。ステップ0で登録した選手情報を使用
  
  // ------------ 100m目標記録 ---------------
  const [target100mInput, setTarget100mInput] = useState<string>("");
  const [targetAdvice, setTargetAdvice] = useState<string>("");

  const distanceValue = useMemo(() => {
    const d = parseFloat(distanceInput);
    return !isNaN(d) && d > 0 ? d : null;
  }, [distanceInput]);

  const avgSpeed =
    distanceValue != null && sectionTime != null && sectionTime > 0
      ? distanceValue / sectionTime
      : null;

  // ------------ 選手情報の保存 ------------
  const handleSaveAthlete = async () => {
    console.log('💾 選手情報保存開始');
    console.log('athleteInfo:', athleteInfo);
    
    // バリデーション
    if (!athleteInfo.name || !athleteInfo.age || !athleteInfo.gender || !athleteInfo.height_cm || !athleteInfo.weight_kg) {
      console.error('❌ バリデーションエラー:', {
        name: athleteInfo.name,
        age: athleteInfo.age,
        gender: athleteInfo.gender,
        height_cm: athleteInfo.height_cm,
        weight_kg: athleteInfo.weight_kg,
      });
      alert('選手情報を保存するには、氏名・年齢・性別・身長・体重が必須です。');
      return;
    }

    try {
      console.log('🔐 認証チェック...');
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session) {
        console.error('❌ 認証エラー:', sessionError);
        alert('ログインが必要です。');
        return;
      }

      const authUserId = sessionData.session.user.id;
      console.log('✅ 認証成功 - User ID:', authUserId);

      // 現在の記録と目標記録を数値に変換
      const currentRecordValue = athleteInfo.current_record 
        ? parseFloat(athleteInfo.current_record) 
        : null;
      const targetRecordValue = athleteInfo.target_record 
        ? parseFloat(athleteInfo.target_record) 
        : null;

      // weight_kg カラムが存在するか確認するため、まず insert を試みる
      const payload: any = {
        owner_auth_user_id: authUserId,
        full_name: athleteInfo.name,
        sex: athleteInfo.gender,
        birth_date: athleteInfo.age 
          ? new Date(new Date().getFullYear() - athleteInfo.age, 0, 1).toISOString().split('T')[0]
          : null,
        affiliation: athleteInfo.affiliation || null,
        height_cm: athleteInfo.height_cm,
        current_record_s: currentRecordValue,
        target_record_s: targetRecordValue,
      };

      // weight_kg を含めて試す
      if (athleteInfo.weight_kg != null) {
        payload.weight_kg = athleteInfo.weight_kg;
      }

      console.log('📤 保存ペイロード:', payload);

      let { data, error } = await supabase
        .from('athletes')
        .insert(payload)
        .select();

      // もし weight_kg カラムが見つからないエラーなら、weight_kg なしで再試行
      if (error && error.code === 'PGRST204' && error.message.includes('weight_kg')) {
        console.warn('⚠️ weight_kg カラムが見つかりません。weight_kg なしで保存を試みます...');
        delete payload.weight_kg;
        
        const retry = await supabase
          .from('athletes')
          .insert(payload)
          .select();
        
        data = retry.data;
        error = retry.error;
        
        if (!error) {
          console.log('✅ weight_kg なしで保存成功');
          alert('選手情報を保存しました！\n\n※ 体重情報はデータベースに保存されていません。\nSupabase で weight_kg カラムを追加後、再度保存してください。');
        }
      }

      if (error) {
        console.error('❌ Supabase保存エラー:', error);
        console.error('エラー詳細:', JSON.stringify(error, null, 2));
        alert(`選手情報の保存に失敗しました。\n\nエラー: ${error.message}`);
        return;
      }

      console.log('✅ 保存成功:', data);
      alert('選手情報を保存しました！');
      
      // 選手リストを再読み込み
      const { data: athletesData } = await supabase
        .from("athletes")
        .select("id, full_name, sex, birth_date, affiliation, height_cm, weight_kg, current_record_s, target_record_s")
        .eq("owner_auth_user_id", authUserId)
        .order("created_at", { ascending: false });

      if (athletesData) {
        const options: AthleteOption[] = athletesData.map((row: any) => {
          const birthRaw: string | null = row.birth_date ?? null;
          let computedAge: number | null = null;
          if (birthRaw) {
            const birth = new Date(birthRaw);
            if (!isNaN(birth.getTime())) {
              const today = new Date();
              computedAge = today.getFullYear() - birth.getFullYear();
              const m = today.getMonth() - birth.getMonth();
              if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
                computedAge--;
              }
            }
          }

          const age: number | null = typeof row.age === "number" ? row.age : computedAge;
          const rawGender: string | null = (row.sex as string | null) ?? null;

          let genderValue: "male" | "female" | "other" | null = null;
          if (rawGender) {
            switch (rawGender) {
              case "male":
              case "男性":
              case "男":
                genderValue = "male";
                break;
              case "female":
              case "女性":
              case "女":
                genderValue = "female";
                break;
              case "other":
              case "その他":
                genderValue = "other";
                break;
              default:
                genderValue = "other";
            }
          }

          return {
            id: row.id,
            full_name: row.full_name ?? "",
            gender: genderValue,
            affiliation: row.affiliation ?? null,
            height_cm: row.height_cm ?? null,
            weight_kg: row.weight_kg ?? null,
            current_record_s: row.current_record_s ?? null,
            target_record_s: row.target_record_s ?? null,
            birthdate: birthRaw,
            age,
          };
        });

        setAthleteOptions(options);
        
        // 保存した選手を自動選択
        if (data && data[0]) {
          setSelectedAthleteId(data[0].id);
        }
      }
    } catch (err) {
      console.error('選手情報の保存エラー:', err);
      alert('選手情報の保存中にエラーが発生しました。');
    }
  };

  // ------------ 区間設定クリックモード ------------
  const [sectionClickMode, setSectionClickMode] = useState<'start' | 'mid' | 'end' | null>(null);

  // 🎥 パン撮影モード（カメラ追従撮影対応）
  const [isPanMode, setIsPanMode] = useState<boolean>(false);
  
  // 👤 人物選択モード（姿勢推定が遅い場合の手動選択）
  const [isPersonSelectMode, setIsPersonSelectMode] = useState<boolean>(false);
  const [manualRoi, setManualRoi] = useState<CanvasRoi | null>(null);
  const [isSelectingPerson, setIsSelectingPerson] = useState<boolean>(false);
  
  // 🎯 補間ステップの表示/非表示トグル
  const [showInterpolatedSteps, setShowInterpolatedSteps] = useState<boolean>(false);
  
  // 🎯 4コーンキャリブレーション（Homography変換用）
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [coneClicks, setConeClicks] = useState<Array<{ x: number; y: number }>>([]);
  const [calibrationInstructions, setCalibrationInstructions] = useState<string>('');
  
  // 🎓 1歩目学習データ（検出精度向上）
  const [learnedStepPattern, setLearnedStepPattern] = useState<{
    contactDuration: number;  // 接地時間（フレーム数）
    toeOffRise: number;        // 離地時のつま先上昇量
    contactToeY: number;       // 接地時のつま先Y座標
    toeOffToeY: number;        // 離地時のつま先Y座標
  } | null>(null);

  // ------------ 接地／離地マーカー（検出モード） ------------
  // 検出モード: 
  // 1 = 自動検出（接地・離地とも自動）
  // 2 = 接地のみ手動（離地なし、ピッチ・ストライド解析用）
  // 3 = 接地・離地とも手動（接地時間も解析）
  const [detectionMode, setDetectionMode] = useState<1 | 2 | 3 | null>(null);
  
  // 旧変数（互換性のため残す）
  const [calibrationType, setCalibrationType] = useState<1 | 2 | 3 | null>(null);
  const [calibrationMode, setCalibrationMode] = useState<number>(0); // キャリブレーション進捗 (0-2: 接地1→離地1→完了)
  const [calibrationData, setCalibrationData] = useState<{
    contactFrame: number | null;
    toeOffFrame: number | null;
    contact1?: number;
    toeOff1?: number;
  }>({
    contactFrame: null,
    toeOffFrame: null
  });
    // ステップ6に入ったら自動的に「半自動設定」を選択する
    useEffect(() => {
      // まだモードが決まっていない状態でステップ6になったら
      if (wizardStep === 6 && !calibrationType) {
        // 「② 半自動設定」ボタンの onClick と同じ処理
        setDetectionMode(2);
        setCalibrationType(2);
        setCalibrationMode(2);
        setCalibrationData({ contactFrame: null, toeOffFrame: null });

        // スタートフレームに移動
        if (sectionStartFrame !== null) {
          setCurrentFrame(sectionStartFrame);
        }
      }
    }, [wizardStep, calibrationType, sectionStartFrame]);


  const [toeOffThreshold, setToeOffThreshold] = useState<number | null>(null); // つま先上昇閾値（ピクセル）
  const [baseThreshold, setBaseThreshold] = useState<number | null>(null); // 元の閾値（調整用）
  const [manualContactFrames, setManualContactFrames] = useState<number[]>([]); // 接地フレーム（手動）
  const [autoToeOffFrames, setAutoToeOffFrames] = useState<number[]>([]); // 離地フレーム（自動判定）
  const [manualToeOffFrames, setManualToeOffFrames] = useState<number[]>([]); // 離地フレーム（手動、方式3用）
  
  // 水平補正は使用しない（常に0度）が、座標変換関数の互換性のため変数は保持
  const horizonAngle = 0; // 水平補正角度（使用しない）
  const isHorizonCalibrated = false; // 水平キャリブレーション不要
  
  // 互換性のため、contactFrames を計算で生成（接地・離地を交互に並べる）
  // 🔥 バリデーション追加：離地フレームは必ず接地フレームより後でなければならない
  const contactFrames = useMemo(() => {
    const result: number[] = [];
    for (let i = 0; i < manualContactFrames.length; i++) {
      const contactFrame = manualContactFrames[i];
      result.push(contactFrame);
      
      // 方式3（完全手動）の場合はmanualToeOffFramesを使用
      if (calibrationType === 3) {
        if (i < manualToeOffFrames.length) {
          let toeOffFrame = manualToeOffFrames[i];
          // 🔥 バリデーション：離地が接地以前なら、接地+10フレームに自動修正
          if (toeOffFrame <= contactFrame) {
            console.warn(`⚠️ ステップ${i + 1}: 離地(${toeOffFrame})が接地(${contactFrame})以前です。自動修正します。`);
            toeOffFrame = contactFrame + 10;
          }
          result.push(toeOffFrame);
        }
      } else {
        // 方式1,2の場合はautoToeOffFramesを使用
        if (i < autoToeOffFrames.length) {
          let toeOffFrame = autoToeOffFrames[i];
          // 🔥 バリデーション：離地が接地以前なら、接地+10フレームに自動修正
          if (toeOffFrame <= contactFrame) {
            console.warn(`⚠️ ステップ${i + 1}: 離地(${toeOffFrame})が接地(${contactFrame})以前です。自動修正します。`);
            toeOffFrame = contactFrame + 10;
          }
          result.push(toeOffFrame);
        }
      }
    }
    return result;
  }, [manualContactFrames, autoToeOffFrames, manualToeOffFrames, calibrationType]);

  const handleClearMarkers = () => {
    setManualContactFrames([]);
    setAutoToeOffFrames([]);
    setManualToeOffFrames([]);
    setCalibrationMode(0);
    setCalibrationData({ contactFrame: null, toeOffFrame: null });
    setToeOffThreshold(null);
    setBaseThreshold(null);
    setCalibrationType(null); // 方式選択もリセット
  };

  // 🎓 多関節統合：身体全体の動きから接地・離地を判定
  const getMultiJointFeatures = (poseData: FramePoseData | null) => {
    if (!poseData || !poseData.landmarks) return null;
    
    const landmarks = poseData.landmarks;
    
    // 必要な関節点
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];
    const leftToe = landmarks[31];
    const rightToe = landmarks[32];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    
    if (!leftHip || !rightHip || !leftKnee || !rightKnee || 
        !leftAnkle || !rightAnkle || !leftToe || !rightToe ||
        !leftShoulder || !rightShoulder) {
      return null;
    }
    
    // 1. つま先の高さ（地面からの距離）
    const hipY = (leftHip.y + rightHip.y) / 2;
    // ⚠️ 両足のうち下にある方（接地している足）を追跡
    // Y座標系：大きいほど下（地面に近い）
    const toeY = Math.max(leftToe.y, rightToe.y);
    const relativeToeHeight = toeY - hipY;
    
    // 2. 膝の角度（接地時は膝が曲がる）
    const leftKneeAngle = Math.atan2(leftAnkle.y - leftKnee.y, leftAnkle.x - leftKnee.x) - 
                          Math.atan2(leftHip.y - leftKnee.y, leftHip.x - leftKnee.x);
    const rightKneeAngle = Math.atan2(rightAnkle.y - rightKnee.y, rightAnkle.x - rightKnee.x) - 
                           Math.atan2(rightHip.y - rightKnee.y, rightHip.x - rightKnee.x);
    
    // 3. 足首の高さ（接地時は低い）
    const ankleY = Math.max(leftAnkle.y, rightAnkle.y);
    const relativeAnkleHeight = ankleY - hipY;
    
    // 4. 上半身の前傾角度（スタート加速時は前傾）
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const torsoAngle = Math.atan2(shoulderY - hipY, 0.01); // 垂直からの角度
    
    // 5. 腰の高さ（接地時は低くなる）
    const hipHeight = hipY;
    
    return {
      relativeToeHeight,
      leftKneeAngle,
      rightKneeAngle,
      relativeAnkleHeight,
      torsoAngle,
      hipHeight,
      toeY,
      ankleY
    };
  };

  // 🎥 パン撮影対応：腰からの相対的なつま先の高さを取得
  // カメラが移動しても、体幹からの相対位置で足の動きを検出
  const getRelativeToeHeight = (poseData: FramePoseData | null): number | null => {
    if (!poseData || !poseData.landmarks) return null;
    
    // 腰の位置（基準点）
    const leftHip = poseData.landmarks[23];
    const rightHip = poseData.landmarks[24];
    if (!leftHip || !rightHip) return null;
    const hipY = (leftHip.y + rightHip.y) / 2;
    
    // つま先の位置
    let leftToe = poseData.landmarks[31];
    let rightToe = poseData.landmarks[32];
    if (!leftToe || !rightToe) return null;
    
    // 水平補正を適用
    if (isHorizonCalibrated && horizonAngle !== 0) {
      const centerX = displayCanvasRef.current?.width ? displayCanvasRef.current.width / 2 : 0;
      const centerY = displayCanvasRef.current?.height ? displayCanvasRef.current.height / 2 : 0;
      leftToe = rotatePoint(leftToe.x, leftToe.y, leftToe.z, leftToe.visibility, horizonAngle, centerX, centerY);
      rightToe = rotatePoint(rightToe.x, rightToe.y, rightToe.z, rightToe.visibility, horizonAngle, centerX, centerY);
    }
    
    const toeY = Math.max(leftToe.y, rightToe.y);
    
    // 腰からつま先までの相対的な高さ（パン撮影でも安定）
    return toeY - hipY;
  };

  // つま先のY座標を取得（地面に近い方を基準）
  // 離地判定には、地面から離れる足（上昇する足）を検出する必要がある
  // つま先のY座標取得（離地判定に使用）
  const getToeY = (poseData: FramePoseData | null): number | null => {
    if (!poseData || !poseData.landmarks) return null;
    let leftToe = poseData.landmarks[31]; // 左足つま先
    let rightToe = poseData.landmarks[32]; // 右足つま先
    if (!leftToe || !rightToe) return null;
    
    // 水平補正を適用
    if (isHorizonCalibrated && horizonAngle !== 0) {
      const centerX = displayCanvasRef.current?.width ? displayCanvasRef.current.width / 2 : 0;
      const centerY = displayCanvasRef.current?.height ? displayCanvasRef.current.height / 2 : 0;
      leftToe = rotatePoint(leftToe.x, leftToe.y, leftToe.z, leftToe.visibility, horizonAngle, centerX, centerY);
      rightToe = rotatePoint(rightToe.x, rightToe.y, rightToe.z, rightToe.visibility, horizonAngle, centerX, centerY);
    }
    
    // 離地判定用：つま先が地面から離れる瞬間を検出（より地面に近い方）
    return Math.max(leftToe.y, rightToe.y);
  };
  
  // 足底部のY座標取得（接地判定に使用）
  // つま先と足首の平均で、足底部全体が地面についた状態を判定
  const getFootBaseY = (poseData: FramePoseData | null): number | null => {
    if (!poseData || !poseData.landmarks) return null;
    let leftToe = poseData.landmarks[31]; // 左足つま先
    let rightToe = poseData.landmarks[32]; // 右足つま先
    let leftAnkle = poseData.landmarks[27]; // 左足首
    let rightAnkle = poseData.landmarks[28]; // 右足首
    
    if (!leftToe || !rightToe || !leftAnkle || !rightAnkle) return null;
    
    // 水平補正を適用
    if (isHorizonCalibrated && horizonAngle !== 0) {
      const centerX = displayCanvasRef.current?.width ? displayCanvasRef.current.width / 2 : 0;
      const centerY = displayCanvasRef.current?.height ? displayCanvasRef.current.height / 2 : 0;
      leftToe = rotatePoint(leftToe.x, leftToe.y, leftToe.z, leftToe.visibility, horizonAngle, centerX, centerY);
      rightToe = rotatePoint(rightToe.x, rightToe.y, rightToe.z, rightToe.visibility, horizonAngle, centerX, centerY);
      leftAnkle = rotatePoint(leftAnkle.x, leftAnkle.y, leftAnkle.z, leftAnkle.visibility, horizonAngle, centerX, centerY);
      rightAnkle = rotatePoint(rightAnkle.x, rightAnkle.y, rightAnkle.z, rightAnkle.visibility, horizonAngle, centerX, centerY);
    }
    
    // 接地判定用：足底部（つま先と足首の平均）が地面についた状態を検出
    // 左右それぞれの足底部を計算し、より地面に近い（Y座標が大きい）方を返す
    const leftFootBase = (leftToe.y + leftAnkle.y) / 2;
    const rightFootBase = (rightToe.y + rightAnkle.y) / 2;
    return Math.max(leftFootBase, rightFootBase);
  };
  
  // 足首のY座標も取得（補助的な判定）
  const getAnkleY = (poseData: FramePoseData | null): number | null => {
    if (!poseData || !poseData.landmarks) return null;
    let leftAnkle = poseData.landmarks[27]; // 左足首
    let rightAnkle = poseData.landmarks[28]; // 右足首
    if (!leftAnkle || !rightAnkle) return null;
    
    // 水平補正を適用
    if (isHorizonCalibrated && horizonAngle !== 0) {
      const centerX = displayCanvasRef.current?.width ? displayCanvasRef.current.width / 2 : 0;
      const centerY = displayCanvasRef.current?.height ? displayCanvasRef.current.height / 2 : 0;
      leftAnkle = rotatePoint(leftAnkle.x, leftAnkle.y, leftAnkle.z, leftAnkle.visibility, horizonAngle, centerX, centerY);
      rightAnkle = rotatePoint(rightAnkle.x, rightAnkle.y, rightAnkle.z, rightAnkle.visibility, horizonAngle, centerX, centerY);
    }
    
    // 接地している足の足首を基準
    return Math.max(leftAnkle.y, rightAnkle.y);
  };

  // キャリブレーション：1歩分のデータを登録（新方式では閾値計算不要）
  // つま先の動き（速度変化）で判定するため、基準高さや閾値は不要
  const handleCalibration = (contactFrame: number, toeOffFrame: number) => {
    // つま先が検出できるか確認
    const contactToeY = getToeY(poseResults[contactFrame]);
    const toeOffToeY = getToeY(poseResults[toeOffFrame]);
    
    if (contactToeY === null || toeOffToeY === null) {
      alert('足の検出に失敗しました。姿勢推定が完了しているか確認してください。');
      return false;
    }
    
    // 新方式では閾値不要だが、後方互換性のため設定
    const threshold = Math.abs(contactToeY - toeOffToeY);
    setToeOffThreshold(threshold);
    setBaseThreshold(threshold);
    setCalibrationMode(2); // キャリブレーション完了
    
    console.log(`✅ キャリブレーション完了（つま先動き検出方式）: 接地=${contactFrame}, 離地=${toeOffFrame}`);
    console.log(`   接地つま先Y=${contactToeY.toFixed(4)}, 離地つま先Y=${toeOffToeY.toFixed(4)}, 差=${threshold.toFixed(4)}`);
    
    return true;
  };

  // Step5、Step6、Step7でフレームを表示するためのuseEffect
  useEffect(() => {
    // Step 7 パーン撮影モードの場合は専用canvasを使用
    const canvasRef = (wizardStep === 7 && analysisMode === 'panning') ? panningCanvasRef : displayCanvasRef;
    
    if ((wizardStep === 5 || wizardStep === 6 || wizardStep === 7) && canvasRef.current && framesRef.current[currentFrame]) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const frame = framesRef.current[currentFrame];
      
      // デバッグ情報を出力
      console.log('🎨 Canvas Debug:', {
        frameWidth: frame.width,
        frameHeight: frame.height,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        canvasStyleWidth: canvas.style.width,
        canvasClientWidth: canvas.clientWidth,
        canvasClientHeight: canvas.clientHeight
      });
      
      // canvasサイズを元のフレームサイズに設定
      canvas.width = frame.width;
      canvas.height = frame.height;
      
      // フレームを描画
      ctx.putImageData(frame, 0, 0);
      
      // スタート/フィニッシュラインを描画
      if (currentFrame === sectionStartFrame) {
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(canvas.width * 0.3, 0);
        ctx.lineTo(canvas.width * 0.3, canvas.height);
        ctx.stroke();
      }
      
      if (currentFrame === sectionEndFrame) {
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(canvas.width * 0.7, 0);
        ctx.lineTo(canvas.width * 0.7, canvas.height);
        ctx.stroke();
      }
      
      // ポーズがある場合は骨格を描画
      const pose = poseResults[currentFrame];
      if (pose?.landmarks) {
        drawSkeleton(ctx, pose.landmarks, canvas.width, canvas.height);
      }
      
      // キャリブレーション中はコーン位置を描画
      if (isCalibrating && coneClicks.length > 0) {
        coneClicks.forEach((click, index) => {
          ctx.fillStyle = index < 2 ? '#00ff00' : '#ff0000'; // スタート=緑、フィニッシュ=赤
          ctx.beginPath();
          ctx.arc(click.x, click.y, 10, 0, 2 * Math.PI);
          ctx.fill();
          
          // 番号を表示
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 16px Arial';
          ctx.fillText(`${index + 1}`, click.x - 5, click.y + 5);
        });
      }
    }
  }, [wizardStep, analysisMode, currentFrame, sectionStartFrame, sectionEndFrame, contactFrames, showSkeleton, isCalibrating, coneClicks]);

  // 完全自動検出：全フレームから接地と離地を検出（つま先の動き検出方式）
  // 新方式では閾値不要、つま先の速度変化のみで判定
  const autoDetectAllContactsAndToeOffs = () => {
    if (!poseResults.length) return;
    if (!sectionStartFrame || !sectionEndFrame) {
      console.warn('⚠️ 区間が設定されていません');
      return;
    }

    console.log('🤖 完全自動検出を開始...');
    
    const detectedContacts: number[] = [];
    const detectedToeOffs: number[] = [];
    
    // ✅ キャリブレーションデータがあれば最初の1歩として追加
    if (calibrationData.contactFrame !== null && calibrationData.toeOffFrame !== null) {
      detectedContacts.push(calibrationData.contactFrame);
      detectedToeOffs.push(calibrationData.toeOffFrame);
      console.log(`🎯 キャリブレーション: 最初の1歩を追加 (接地=${calibrationData.contactFrame}, 離地=${calibrationData.toeOffFrame})`);
    }
    
    // 検索開始位置の決定
    let searchStartFrame = sectionStartFrame;
    
    // 🚀 ステップ5.5削除後：常にスタートフレームから検索
    console.log(`📍 検索範囲: Frame ${searchStartFrame} ～ ${sectionEndFrame} (区間スタートから全自動検出)`);
    console.log(`🎯 検出モード: ${calibrationType === 1 ? '⚡自動検出' : calibrationType === 2 ? '🎯接地のみ' : '✋完全手動'}`);
    
    // 区間内を順次検索
    let loopCount = 0;
    const maxLoops = 100; // 無限ループ防止（50→100に増加）
    while (searchStartFrame < sectionEndFrame && loopCount < maxLoops) {
      loopCount++;
      console.log(`🔄 ループ ${loopCount}: 検索開始フレーム=${searchStartFrame}, 終了=${sectionEndFrame}`);
      
      // 次の接地を検出
      const contactFrame = detectNextContactFrame(searchStartFrame, sectionEndFrame);
      if (contactFrame === null) {
        console.warn(`⚠️ ループ ${loopCount}: 接地が検出できませんでした（開始=${searchStartFrame}）`);
        break;
      }
      
      console.log(`✅ ループ ${loopCount}: 接地検出 Frame ${contactFrame}`);
      
      // 接地フレームを記録
      detectedContacts.push(contactFrame);
      
      // その接地に対応する離地を検出
      const toeOffFrame = detectToeOffFrame(contactFrame);
      if (toeOffFrame !== null) {
        console.log(`✅ ループ ${loopCount}: 離地検出 Frame ${toeOffFrame}`);
        detectedToeOffs.push(toeOffFrame);
        // 次の検索は離地フレームの直後から（5→3に短縮）
        searchStartFrame = toeOffFrame + 3;
        console.log(`➡️ 次の検索開始: ${searchStartFrame}`);
      } else {
        console.warn(`⚠️ ループ ${loopCount}: 離地が検出できませんでした（接地=${contactFrame}）`);
        // 離地が見つからない場合でも、接地の直後から次を検索（10→5に短縮）
        searchStartFrame = contactFrame + 5;
        console.log(`➡️ 離地未検出、次の検索開始: ${searchStartFrame}`);
      }
    }
    
    if (loopCount >= maxLoops) {
      console.warn(`⚠️ 最大ループ数 ${maxLoops} に達しました`);
    }
    
    console.log(`✅ 自動検出完了: 接地 ${detectedContacts.length}回, 離地 ${detectedToeOffs.length}回`);
    console.log(`📊 検出された接地フレーム: [${detectedContacts.join(', ')}]`);
    console.log(`📊 検出された離地フレーム: [${detectedToeOffs.join(', ')}]`);
    
    // 🔥 バリデーション：各ペアで離地が接地より後であることを保証
    const validatedContacts: number[] = [];
    const validatedToeOffs: number[] = [];
    
    for (let i = 0; i < detectedContacts.length; i++) {
      const contact = detectedContacts[i];
      let toeOff = i < detectedToeOffs.length ? detectedToeOffs[i] : contact + 15;
      
      // 離地が接地以前の場合は、接地+15フレームに設定
      if (toeOff <= contact) {
        console.warn(`⚠️ ステップ${i + 1}: 検出した離地(${toeOff})が接地(${contact})以前。自動修正: ${contact + 15}`);
        toeOff = contact + 15;
      }
      
      // 前のステップの離地より後であることを確認
      if (validatedToeOffs.length > 0) {
        const prevToeOff = validatedToeOffs[validatedToeOffs.length - 1];
        if (contact <= prevToeOff) {
          console.warn(`⚠️ ステップ${i + 1}: 接地(${contact})が前の離地(${prevToeOff})以前。スキップ。`);
          continue;
        }
      }
      
      validatedContacts.push(contact);
      validatedToeOffs.push(toeOff);
    }
    
    console.log(`📊 バリデーション後の接地フレーム: [${validatedContacts.join(', ')}]`);
    console.log(`📊 バリデーション後の離地フレーム: [${validatedToeOffs.join(', ')}]`);
    
    if (detectionMode === 1) {
      // モード1: 全て自動検出結果を使用
      setManualContactFrames(validatedContacts);
      setAutoToeOffFrames(validatedToeOffs);
    } else {
      // モード2・3: キャリブレーションの1歩目を保持し、その後に自動検出結果を追加
      const firstContact = manualContactFrames[0];
      // キャリブレーションの接地が自動検出と重複しないように
      const newContacts = validatedContacts.filter(c => c > firstContact + 10);
      const newToeOffs = validatedToeOffs.slice(validatedContacts.length - newContacts.length);
      
      setManualContactFrames([firstContact, ...newContacts]);
      // 最初の離地も含める
      if (autoToeOffFrames.length > 0) {
        setAutoToeOffFrames([autoToeOffFrames[0], ...newToeOffs]);
      } else {
        setAutoToeOffFrames([firstContact + 15, ...newToeOffs]);
      }
    }
  };

  // ========== 水平キャリブレーション関数 ==========
  
  // 2点から回転角度を計算（ラジアン）
  const calculateHorizonAngle = (p1: {x: number, y: number}, p2: {x: number, y: number}): number => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const angle = Math.atan2(dy, dx); // Y軸下向きなので符号反転不要
    console.log(`📐 水平角度計算: dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}, angle=${(angle * 180 / Math.PI).toFixed(2)}°`);
    return angle;
  };
  
  // 座標を回転変換（水平補正）
  const rotatePoint = (x: number, y: number, z: number, visibility: number, angle: number, centerX: number, centerY: number): {x: number, y: number, z: number, visibility: number} => {
    const cosA = Math.cos(-angle); // 逆回転（画像を水平にする）
    const sinA = Math.sin(-angle);
    
    // 中心を原点に移動
    const dx = x - centerX;
    const dy = y - centerY;
    
    // 回転
    const rotatedX = dx * cosA - dy * sinA;
    const rotatedY = dx * sinA + dy * cosA;
    
    // 中心を戻す
    return {
      x: rotatedX + centerX,
      y: rotatedY + centerY,
      z, // zとvisibilityは変更しない
      visibility
    };
  };

   // 【新方式】つま先のY座標の動きを検出して接地・離地を判定
  // 接地：つま先の下降が停止した瞬間（谷＋プラトー）
  // 離地：つま先が上昇を始めた瞬間

  // 移動平均でY座標のトレンドを計算（ノイズ除去）
  const calculateMovingAverage = (frame: number, windowSize: number = 3): number | null => {
    if (!poseResults[frame]) return null;

    const start = Math.max(0, frame - Math.floor(windowSize / 2));
    const end = Math.min(poseResults.length - 1, frame + Math.floor(windowSize / 2));

    let sum = 0;
    let count = 0;

    for (let i = start; i <= end; i++) {
      const toeValue = isPanMode
        ? getRelativeToeHeight(poseResults[i])
        : getToeY(poseResults[i]);
      if (toeValue !== null) {
        sum += toeValue;
        count++;
      }
    }

    return count > 0 ? sum / count : null;
  };

  // つま先のY座標の速度を計算（フレーム間の変化量）
  const calculateToeVelocity = (frame: number, windowSize: number = 5): number | null => {
    if (frame < windowSize || frame >= poseResults.length - windowSize) return null;

    const beforeY = calculateMovingAverage(frame - windowSize, 3);
    const afterY = calculateMovingAverage(frame + windowSize, 3);

    if (beforeY === null || afterY === null) return null;

    // Y座標の変化量（正：下降、負：上昇）※Y軸は下向きが正
    return (afterY - beforeY) / (windowSize * 2);
  };

  // 🎓 NEW: 多関節統合検出（高精度・シンプル版）
  // 「つま先が下がってきて → いちばん下でほぼ止まる」最初のポイントを接地とみなす
  const detectNextContactFrameAdvanced = (
    startFrame: number,
    endFrame: number
  ): number | null => {
    if (!poseResults.length) return null;

    const from = Math.max(0, startFrame);
    const to = Math.min(endFrame, poseResults.length - 1);

    console.log(`🎓 高度な接地検出(シンプル版): 検索範囲=${from}～${to}`);

    type ToePoint = { frame: number; y: number };

    const toePoints: ToePoint[] = [];
    for (let f = from; f <= to; f++) {
      const features = getMultiJointFeatures(poseResults[f]);
      if (!features) continue;
      // relativeToeHeight: 値が大きいほど つま先が下（地面側）
      toePoints.push({ frame: f, y: features.relativeToeHeight });
    }

    if (toePoints.length < 5) {
      console.warn(`⚠️ データ不足（toePoints=${toePoints.length}）`);
      return null;
    }

    const N = toePoints.length;

    // 3点移動平均で Y を平滑化
    const smoothY = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      if (i === 0 || i === N - 1) {
        smoothY[i] = toePoints[i].y;
      } else {
        smoothY[i] =
          (toePoints[i - 1].y + toePoints[i].y + toePoints[i + 1].y) / 3;
      }
    }

    // 速度（フレーム間差分）
    const vel = new Array<number>(N).fill(0);
    for (let i = 1; i < N; i++) {
      vel[i] = smoothY[i] - smoothY[i - 1]; // 正: 下降, 負: 上昇（Yは下向きが正）
    }

    // 動きのレンジから動的に閾値を決める（動画によってスケールが違うため）
    let minY = smoothY[0];
    let maxY = smoothY[0];
    for (let i = 1; i < N; i++) {
      if (smoothY[i] < minY) minY = smoothY[i];
      if (smoothY[i] > maxY) maxY = smoothY[i];
    }
    const range = maxY - minY;
    if (range < 1e-4) {
      console.warn(
        `⚠️ つま先の上下動がほとんどありません（range=${range.toExponential(2)}）`
      );
      return null;
    }

    // 🔥🔥 超高精度：つま先下降→完全停止を検出
    const minDesc = range * 0.002; // これ以上なら「下降している」（さらに感度UP）
    const flatEps = range * 0.001; // これ以内なら「完全停止」（最も厳しく）
    
    // 接地候補を探す：下降から完全停止への遷移
    const candidates: Array<{frame: number, idx: number, score: number, flatDuration: number}> = [];
    
    for (let i = 4; i < N - 4; i++) {
      // 直前4フレーム平均の下降量（より長期トレンド）
      const prevAvg = (vel[i - 4] + vel[i - 3] + vel[i - 2] + vel[i - 1]) / 4;
      
      // 現在から3フレーム後までの停止状態を確認（プラトー検出）
      const stopFrames = [];
      for (let j = 0; j <= 3 && i + j < N; j++) {
        stopFrames.push(Math.abs(vel[i + j]));
      }
      const stopAvg = stopFrames.reduce((a, b) => a + b, 0) / stopFrames.length;
      const flatDuration = stopFrames.filter(v => v <= flatEps).length;
      
      // 条件1：明確な下降後に停止
      // 条件2：少なくとも2フレーム以上停止している（プラトー確認）
      if (prevAvg > minDesc && stopAvg <= flatEps * 1.5 && flatDuration >= 2) {
        // スコア：下降量が大きく、停止が長く安定しているほど高い
        const score = prevAvg * flatDuration * (1 - stopAvg / (flatEps * 1.5));
        candidates.push({
          frame: toePoints[i].frame,
          idx: i,
          score: score,
          flatDuration: flatDuration
        });
      }
    }
    
    // ★ 最もスコアの高い候補を接地として採用
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      console.log(
        `✅ 超高精度接地検出: Frame=${best.frame} (idx=${best.idx}, score=${best.score.toFixed(5)}, flatDuration=${best.flatDuration}, candidates=${candidates.length})`
      );
      return best.frame;
    }

    console.warn(
      "⚠️ シンプル接地検出に失敗（条件を満たす下降→停止パターンが見つからない）"
    );
    return null;
  };

  // 次の接地フレームを検出：
  // まず高度な検出を試し、それでもダメなときだけ単純なフォールバック
  const detectNextContactFrame = (
    startFrame: number,
    endFrame: number
  ): number | null => {
    if (!poseResults.length) return null;

    // 🔒 前の接地から「最大○フレーム先」までだけを見る（飛び歩き防止）
    const maxSearchFrames = 90; // 120fpsなら ≒0.75秒分
    const from = Math.max(0, startFrame);
    const to = Math.min(
      poseResults.length - 1,
      endFrame,
      startFrame + maxSearchFrames
    );

    console.log(
      `🔍 接地検出: 検索範囲=${from}～${to}（maxSearchFrames=${maxSearchFrames}）`
    );

    // 1) シンプル版の高度検出
    const advanced = detectNextContactFrameAdvanced(from, to);
    if (advanced !== null) return advanced;

    // 2) フォールバック：この区間で一番下がったところを使う
    type ToePoint = { frame: number; y: number };
    const toePoints: ToePoint[] = [];
    for (let f = from; f <= to; f++) {
      const features = getMultiJointFeatures(poseResults[f]);
      if (!features) continue;
      toePoints.push({ frame: f, y: features.relativeToeHeight });
    }

    if (toePoints.length < 3) {
      console.warn(`⚠️ フォールバック用データ不足（toePoints=${toePoints.length}）`);
      return null;
    }

    let bestIdx = 0;
    let bestY = toePoints[0].y;
    for (let i = 1; i < toePoints.length; i++) {
      if (toePoints[i].y > bestY) {
        bestY = toePoints[i].y;
        bestIdx = i;
      }
    }

    const contactFrame = toePoints[bestIdx].frame;
    console.log(
      `✅ 接地検出（フォールバック）: Frame=${contactFrame}, toeY=${bestY.toFixed(
        4
      )}`
    );
    return contactFrame;
  };

  // 離地検出：
  // 「接地してしばらくほぼ止まって → そこから上昇し始めた瞬間」を toe の速度から検出
  const detectToeOffFrame = (contactFrame: number): number | null => {
    if (!poseResults.length) return null;

    console.log(`🔍 離地検出開始（改訂版）: 接地フレーム=${contactFrame}`);

    const minContactDuration = 8; // 少なくともこれだけは接地していると仮定
    const searchStart = contactFrame; // プラトー判定のため接地直後から見る
    const searchEnd = Math.min(contactFrame + 60, poseResults.length - 1); // 最大 ≒0.5秒@120fps

    type ToePoint = { frame: number; y: number };
    const toePoints: ToePoint[] = [];

    for (let f = searchStart; f <= searchEnd; f++) {
      const features = getMultiJointFeatures(poseResults[f]);
      if (!features) continue;
      toePoints.push({ frame: f, y: features.relativeToeHeight });
    }

    if (toePoints.length < minContactDuration + 3) {
      console.warn(`⚠️ 離地検出用データ不足（${toePoints.length}フレーム）`);
      return null;
    }

    const N = toePoints.length;

    // 平滑化と速度
    const smoothY = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      if (i === 0 || i === N - 1) {
        smoothY[i] = toePoints[i].y;
      } else {
        smoothY[i] =
          (toePoints[i - 1].y + toePoints[i].y + toePoints[i + 1].y) / 3;
      }
    }

    const vel = new Array<number>(N).fill(0);
    for (let i = 1; i < N; i++) {
      vel[i] = smoothY[i] - smoothY[i - 1]; // 正: 下降, 負: 上昇
    }

    // 動的閾値
    let minY = smoothY[0];
    let maxY = smoothY[0];
    for (let i = 1; i < N; i++) {
      if (smoothY[i] < minY) minY = smoothY[i];
      if (smoothY[i] > maxY) maxY = smoothY[i];
    }
    const range = maxY - minY;
    if (range < 1e-4) {
      console.warn(
        `⚠️ 離地検出: つま先の上下動がほとんどありません（range=${range.toExponential(
          2
        )}）`
      );
      return null;
    }

    // 🔥🔥 超高精度：接地後の完全停止→明確な上昇開始を検出
    const velPlateau = range * 0.001; // プラトーとみなす速度（最も厳しく）
    const velUp = range * 0.0015; // 「上昇開始」とみなす速度（さらに感度UP）

    // ① contactFrame に対応するインデックスを探す
    let contactIdx = toePoints.findIndex((p) => p.frame === contactFrame);
    if (contactIdx < 0) {
      contactIdx = 0;
    }

    // ② 接地プラトーを推定（停止している区間）
    let plateauEnd = contactIdx;
    const plateauMinIdx = Math.min(contactIdx + minContactDuration, N - 1);
    for (let i = contactIdx + 1; i < N; i++) {
      if (i < plateauMinIdx || Math.abs(vel[i]) <= velPlateau) {
        plateauEnd = i;
      } else {
        break;
      }
    }

    console.log(
      `  📊 接地プラトー推定: インデックス=${contactIdx}～${plateauEnd} (総フレーム=${N})`
    );

    // ③ 離地候補を探す：プラトー終了後、明確な上昇開始点
    const toeOffCandidates: Array<{frame: number, idx: number, score: number, riseDuration: number}> = [];
    
    for (let i = plateauEnd + 1; i < N - 3; i++) {
      // 連続する4フレームの速度を確認（より長期トレンド）
      const v1 = vel[i];
      const v2 = vel[i + 1];
      const v3 = vel[i + 2];
      const v4 = vel[i + 3];
      const avgVel = (v1 + v2 + v3 + v4) / 4;
      
      // 上昇が継続しているフレーム数をカウント
      const riseFrames = [v1, v2, v3, v4].filter(v => v < -velUp * 0.3);
      const riseDuration = riseFrames.length;
      
      // 条件1：明確に上昇開始（負の速度）
      // 条件2：継続的に上昇（少なくとも3フレーム）
      if (v1 < -velUp && avgVel < -velUp * 0.4 && riseDuration >= 3) {
        // スコア：上昇速度が大きく、継続期間が長いほど高い
        const score = Math.abs(avgVel) * riseDuration;
        toeOffCandidates.push({
          frame: toePoints[i].frame,
          idx: i,
          score: score,
          riseDuration: riseDuration
        });
      }
    }
    
    // ★ 最初の明確な上昇開始点を離地として採用（最も早い候補）
    if (toeOffCandidates.length > 0) {
      const best = toeOffCandidates[0]; // 最初の候補（最も早い）
      console.log(
        `✅ 超高精度離地検出: Frame=${best.frame} (idx=${best.idx}, score=${best.score.toFixed(5)}, riseDuration=${best.riseDuration}, candidates=${toeOffCandidates.length})`
      );
      return best.frame;
    }

    console.warn(`⚠️ 離地が検出できませんでした（接地Frame=${contactFrame}）`);
    return null;
  };



  // ステップ5に入ったら初期値を設定
  useEffect(() => {
    if (wizardStep === 5 && framesCount > 0 && poseResults.length > 0) {
      // 初期値が未設定の場合のみ設定
      if (sectionStartFrame === null) {
        const initialStart = 0; // 🔥 最初のフレームから開始できるように変更
        setSectionStartFrame(initialStart);
        
        // 腰の位置を計算
        const pose = poseResults[initialStart];
        let hipX = null;
        if (pose && pose.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            hipX = (leftHip.x + rightHip.x) / 2;
          }
        }
        setSavedStartHipX(hipX);
        setStartLineOffset(0);
        // 🎥 パン撮影対応: 初期ピクセル位置を保存
        if (hipX !== null && displayCanvasRef.current) {
          const pixelX = hipX * displayCanvasRef.current.width;
          setSavedStartPixelX(pixelX);
          console.log(`🟢 スタート地点初期値設定: Frame ${initialStart}, HipX=${hipX}, PixelX=${pixelX.toFixed(0)}`);
        } else {
          console.warn(`⚠️ スタート地点で姿勢認識失敗: Frame ${initialStart} - 距離計算は不正確になります`);
          setSavedStartPixelX(null);
        }
      }
      
      if (sectionEndFrame === null) {
        const initialEnd = Math.max(0, framesCount - 1); // 🔥 最後のフレームまで設定
        setSectionEndFrame(initialEnd);
        
        // 腰の位置を計算
        const pose = poseResults[initialEnd];
        let hipX = null;
        if (pose && pose.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            hipX = (leftHip.x + rightHip.x) / 2;
          }
        }
        setSavedEndHipX(hipX);
        setEndLineOffset(0);
        // 🎥 パン撮影対応: 初期ピクセル位置を保存
        if (hipX !== null && displayCanvasRef.current) {
          const pixelX = hipX * displayCanvasRef.current.width;
          setSavedEndPixelX(pixelX);
          console.log(`🔴 フィニッシュ地点初期値設定: Frame ${initialEnd}, HipX=${hipX}, PixelX=${pixelX.toFixed(0)}`);
        } else {
          console.log(`🔴 フィニッシュ地点初期値設定: Frame ${initialEnd}, HipX=${hipX}`);
        }
      }
      
      if (sectionMidFrame === null) {
        const initialMid = Math.floor(framesCount / 2);
        setSectionMidFrame(initialMid);
        
        // 腰の位置を計算
        const pose = poseResults[initialMid];
        let hipX = null;
        if (pose && pose.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            hipX = (leftHip.x + rightHip.x) / 2;
          }
        }
        setSavedMidHipX(hipX);
        setMidLineOffset(0);
        // 🎥 パン撮影対応: 初期ピクセル位置を保存
        if (hipX !== null && displayCanvasRef.current) {
          const pixelX = hipX * displayCanvasRef.current.width;
          setSavedMidPixelX(pixelX);
          console.log(`🟡 中間地点初期値設定: Frame ${initialMid}, HipX=${hipX}, PixelX=${pixelX.toFixed(0)}`);
        } else {
          console.log(`🟡 中間地点初期値設定: Frame ${initialMid}, HipX=${hipX}`);
        }
      }
    }
  }, [wizardStep, framesCount, poseResults, sectionStartFrame, sectionEndFrame, sectionMidFrame]);
// 接地/離地を追加（半自動/手動どちらもここを通す）
type MarkKind = "contact" | "toeOff";

// 接地/離地を追加（半自動/手動どちらもここを通す）
function handleMarkAtCurrentFrame(kind?: MarkKind) {
  if (!ready) return;
  if (!framesCount) return;

  const f = Math.round(currentFrame);

  // 半自動：接地だけ手動、離地は自動検出
  if (calibrationType === 2) {
    const nextContacts = [...manualContactFrames, f];
    setManualContactFrames(nextContacts);
    console.log(`📍 接地マーク: フレーム ${f}`);

    const toeOff = detectToeOffFrame(f);
    if (toeOff != null) {
      setAutoToeOffFrames([...autoToeOffFrames, toeOff]);
      console.log(`📍 離地(自動): フレーム ${toeOff}`);
    } else {
      console.warn(`⚠️ 離地が検出できませんでした（接地: ${f}）`);
    }
    return;
  }

  // 手動：接地/離地をボタンで選ぶ（kind が無ければ交互）
  if (calibrationType === 3) {
    const nextKind: MarkKind =
      kind ??
      (manualContactFrames.length === manualToeOffFrames.length ? "contact" : "toeOff");

    if (nextKind === "contact") {
      setManualContactFrames([...manualContactFrames, f]);
      console.log(`📍 接地マーク: フレーム ${f}`);
      return;
    }

    // toeOff
    if (manualContactFrames.length === 0) {
      alert("先に接地フレームをマークしてください。");
      return;
    }
    const lastContact = manualContactFrames[manualContactFrames.length - 1];
    if (typeof lastContact === "number" && f <= lastContact) {
      alert("離地フレームは接地フレームより後にしてください。");
      return;
    }
    setManualToeOffFrames([...manualToeOffFrames, f]);
    console.log(`📍 離地マーク: フレーム ${f}`);
    return;
  }
}



  
  // キーボード操作
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!framesCount) return;

     if (e.code === "Space") {
  e.preventDefault();
  handleMarkAtCurrentFrame(); // 半自動/手動どちらでも動く
  return;
}


      if (e.code === "ArrowRight") {
        e.preventDefault();
        setCurrentFrame((prev) =>
          clamp(prev + 1, 0, Math.max(0, framesRef.current.length - 1))
        );
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setCurrentFrame((prev) =>
          clamp(prev - 1, 0, Math.max(0, framesRef.current.length - 1))
        );
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        setCurrentFrame((prev) =>
          clamp(prev + 10, 0, Math.max(0, framesRef.current.length - 1))
        );
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        setCurrentFrame((prev) =>
          clamp(prev - 10, 0, Math.max(0, framesRef.current.length - 1))
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentFrame, framesCount]);

  // ===== 追加：ボタン操作（半自動/手動） =====
const addMarkByButton = () => {
  if (!framesCount) return;

  // 半自動設定: 接地のみ手動マーク、離地は自動検出
  if (calibrationType === 2) {
    const newContactFrames = [...manualContactFrames, currentFrame];
    setManualContactFrames(newContactFrames);
    console.log(`📍 接地マーク: フレーム ${currentFrame}`);

    const toeOffFrame = detectToeOffFrame(currentFrame);
    if (toeOffFrame !== null) {
      setAutoToeOffFrames([...autoToeOffFrames, toeOffFrame]);
    } else {
      console.warn(`⚠️ 離地が検出できませんでした（接地: ${currentFrame}）`);
    }
    return;
  }

  // 手動マーク設定: すべて手動（接地→離地→接地→離地…交互）
  if (calibrationType === 3) {
    if (manualContactFrames.length === manualToeOffFrames.length) {
      setManualContactFrames([...manualContactFrames, currentFrame]);
      console.log(`📍 接地マーク: フレーム ${currentFrame}`);
    } else {
      const lastContact = manualContactFrames[manualContactFrames.length - 1];
      if (currentFrame <= lastContact) {
        alert("離地フレームは接地フレームより後にしてください。");
        return;
      }
      setManualToeOffFrames([...manualToeOffFrames, currentFrame]);
      console.log(`📍 離地マーク: フレーム ${currentFrame}`);
    }
  }
};

const clearMarksByButton = () => {
  setManualContactFrames([]);
  setManualToeOffFrames([]);
  setAutoToeOffFrames([]);
  console.log("🧹 マークをクリアしました");
};

  // ------------ ステップメトリクス ------------
  const stepMetrics: StepMetric[] = useMemo(() => {
    // パーン撮影モード: ステップ検出をスキップ（フレームレートから直接計算）
    if (analysisMode === 'panning') {
      console.log(`🎥 Panning mode: Skipping step detection, using frame-based calculation only`);
      return [];
    }
    
    // マルチカメラモードで結合データがある場合は、それを返す
    if (false /* multi mode disabled */ && mergedStepMetrics.length > 0) {
      console.log(`📊 Using merged step metrics: ${mergedStepMetrics.length} steps`);
      return mergedStepMetrics;
    }
    
    if (!usedTargetFps) return [];
    
    // calibrationType=2（接地のみ）の場合は最低2つの接地が必要
    // それ以外（接地・離地ペア）の場合は最低3つ必要
    const minFrames = calibrationType === 2 ? 2 : 3;
    if (contactFrames.length < minFrames) return [];

    // 🎯 新仕様: トルソー位置からピクセル→メートル変換
    // スタートラインのx座標とフィニッシュラインのx座標から距離スケールを計算
    const sectionLengthM = distanceValue ?? 10; // 入力距離（デフォルト10m）
    
    // 各フレームでのトルソー（腰の中心）の正規化x座標（0-1）を取得
    const getTorsoX = (frame: number): number | null => {
      if (poseResults[frame]?.landmarks) {
        const hip23 = poseResults[frame]!.landmarks[23];
        const hip24 = poseResults[frame]!.landmarks[24];
        return (hip23.x + hip24.x) / 2; // 正規化座標 (0-1)
      }
      return null;
    };
    
    // 🎯 Homography変換: ピクセル座標 → 実世界座標（メートル）
    const applyHomography = (pixelX: number, pixelY: number, H: number[][]): { x: number; y: number } | null => {
      if (!H || H.length !== 3 || H[0].length !== 3) {
        console.warn('⚠️ Invalid Homography matrix');
        return null;
      }
      
      try {
        // 同次座標系での変換: [x', y', w'] = H * [x, y, 1]
        const w = H[2][0] * pixelX + H[2][1] * pixelY + H[2][2];
        if (Math.abs(w) < 1e-10) {
          console.warn('⚠️ Homography division by zero');
          return null;
        }
        
        const worldX = (H[0][0] * pixelX + H[0][1] * pixelY + H[0][2]) / w;
        const worldY = (H[1][0] * pixelX + H[1][1] * pixelY + H[1][2]) / w;
        
        return { x: worldX, y: worldY };
      } catch (e) {
        console.error('❌ Homography transformation error:', e);
        return null;
      }
    };
    
    // 🎯 ビデオの実際の解像度を取得（キャリブレーションと一致させる）
    const actualVideoWidth = videoRef.current?.videoWidth || 1920;
    const actualVideoHeight = videoRef.current?.videoHeight || 1080;
    
    // 接地時の足のピクセル座標を取得（左右の足首・つま先から判定）
    const getContactFootPixel = (frame: number): { x: number; y: number } | null => {
      if (!poseResults[frame]?.landmarks) return null;
      
      const landmarks = poseResults[frame]!.landmarks;
      // 左足: 足首27, つま先31
      const leftAnkle = landmarks[27];
      const leftToe = landmarks[31];
      // 右足: 足首28, つま先32
      const rightAnkle = landmarks[28];
      const rightToe = landmarks[32];
      
      // 接地している方の足（Y座標が大きい = 画面下側）を選択
      const leftY = Math.max(leftAnkle.y, leftToe.y);
      const rightY = Math.max(rightAnkle.y, rightToe.y);
      
      let footX: number, footY: number;
      if (leftY > rightY) {
        // 左足が接地
        footX = (leftAnkle.x + leftToe.x) / 2;
        footY = leftY;
      } else {
        // 右足が接地
        footX = (rightAnkle.x + rightToe.x) / 2;
        footY = rightY;
      }
      
      // 🎯 CRITICAL FIX: キャリブレーションと同じ解像度を使用
      // 正規化座標(0-1)をピクセル座標に変換（videoRef.currentから取得）
      const pixelX = footX * actualVideoWidth;
      const pixelY = footY * actualVideoHeight;
      
      // 🔍 デバッグ: 初回のみビデオサイズとサンプル座標を出力
      if (frame === (contactFrames[0] || 0)) {
        console.log(`🔍 [DEBUG] Video dimensions for pixel conversion: ${actualVideoWidth}x${actualVideoHeight} (from videoRef.current)`);
        console.log(`🔍 [DEBUG] Sample: normalized(${footX.toFixed(3)}, ${footY.toFixed(3)}) → pixel(${pixelX.toFixed(0)}, ${pixelY.toFixed(0)})`);
      }
      
      return { x: pixelX, y: pixelY };
    };
    
    // スタートライン・フィニッシュラインの正規化x座標を取得
    // savedStartHipX/savedEndHipXが設定されている場合はそれを使用
    // なければsectionStartFrame/sectionEndFrameでの腰位置を使用
    let startLineX: number | null = null;
    let finishLineX: number | null = null;
    
    if (savedStartHipX != null) {
      startLineX = savedStartHipX;
    } else if (sectionStartFrame != null) {
      startLineX = getTorsoX(sectionStartFrame);
    }
    
    if (savedEndHipX != null) {
      finishLineX = savedEndHipX;
    } else if (sectionEndFrame != null) {
      finishLineX = getTorsoX(sectionEndFrame);
    }
    
    // ライン座標が取得できない場合はフォールバック
    if (startLineX == null || finishLineX == null || startLineX === finishLineX) {
      console.warn('⚠️ スタート/フィニッシュラインの座標が取得できません。従来計算にフォールバック');
      startLineX = 0;
      finishLineX = 1;
    }
    
    // ピクセル→メートル変換係数
    const distancePerNormalized = sectionLengthM / Math.abs(finishLineX - startLineX);
    const isLeftToRight = finishLineX > startLineX; // 走行方向
    
    // 各フレームでのスタートラインからの距離[m]を計算
    const distanceAtFrame = (frame: number): number | null => {
      const torsoX = getTorsoX(frame);
      if (torsoX == null) return null;
      const rawDistance = isLeftToRight 
        ? (torsoX - startLineX) * distancePerNormalized
        : (startLineX - torsoX) * distancePerNormalized;
      return rawDistance;
    };
    
    console.log(`📏 ストライド計算（新仕様）:`);
    console.log(`   入力距離: ${sectionLengthM}m`);
    console.log(`   スタートラインX: ${startLineX?.toFixed(4)}, フィニッシュラインX: ${finishLineX?.toFixed(4)}`);
    console.log(`   走行方向: ${isLeftToRight ? '左→右' : '右→左'}`);
    console.log(`   距離変換係数: ${distancePerNormalized.toFixed(4)} m/正規化単位`);
    console.log(`   走行タイプ: ${runType === 'dash' ? 'スタートダッシュ' : '加速走（フライング）'}`);
    
    // 接地フレームリストを取得
    const contactFrameList: number[] = calibrationType === 2 
      ? [...manualContactFrames]
      : contactFrames.filter((_, i) => i % 2 === 0); // 偶数インデックス = 接地
    
    // 🔴 CRITICAL FIX: 接地フレームを昇順にソート（時系列順に並べる）
    console.log(`   ⚠️ BEFORE SORT: 接地フレーム: ${contactFrameList.join(', ')}`);
    contactFrameList.sort((a, b) => a - b);
    console.log(`   ✅ AFTER SORT: 接地フレーム: ${contactFrameList.join(', ')}`);
    
    // 各接地時のスタートラインからの距離を計算
    const sContacts = contactFrameList.map(f => distanceAtFrame(f));
    
    console.log(`   接地フレーム: ${contactFrameList.join(', ')}`);
    console.log(`   各接地距離[m]: ${sContacts.map(d => d?.toFixed(2) ?? 'N/A').join(', ')}`);

    const metrics: StepMetric[] = [];

    if (calibrationType === 2) {
      // 🎯 モード2（半自動設定）：接地フレーム間でステップを計算
      // 🔥 autoToeOffFrames から離地データを取得して接地時間・滞空時間を計算
      console.log(`🎯 モード2（半自動設定）: ${manualContactFrames.length}個の接地フレーム, ${autoToeOffFrames.length}個の離地フレーム`);
      
      // 🔴 CRITICAL FIX: 接地と離地のペアを作成してソート
      const originalPairs = manualContactFrames.map((contact, i) => ({
        contact,
        toeOff: autoToeOffFrames[i],
        originalIndex: i
      }));
      
      // 接地フレームでソート（時系列順）
      originalPairs.sort((a, b) => a.contact - b.contact);
      
      for (let i = 0; i < originalPairs.length - 1; i++) {
        const contact = originalPairs[i].contact;
        const nextContact = originalPairs[i + 1].contact;
        
        // 🔥 autoToeOffFrames から離地フレームを取得（存在しなければ推定）
        let toeOff = originalPairs[i].toeOff;
        if (toeOff === undefined || toeOff <= contact) {
          // 離地データがない or 不正な場合は、次の接地との中間点を離地と推定
          toeOff = Math.floor(contact + (nextContact - contact) * 0.4);
        }
        // 離地が次の接地以降にならないように制限
        if (toeOff >= nextContact) {
          toeOff = nextContact - 1;
        }

        // 🔥 接地時間・滞空時間を計算
        const contactTime = toeOff > contact ? (toeOff - contact) / usedTargetFps : null;
        const flightTime = nextContact > toeOff ? (nextContact - toeOff) / usedTargetFps : null;
        
        // ステップタイム = 次の接地までの時間
        const stepTime = (nextContact - contact) / usedTargetFps;
        const stepPitch = stepTime > 0 ? 1 / stepTime : null;

        // 🎯 新仕様: ストライド計算
        const s_i = sContacts[i];
        const s_i1 = sContacts[i + 1];
        
        let fullStride: number | null = null;
        let sectionStride: number | null = null;
        let distanceAtContact = s_i;
        let isFirstStepFromStart = false;
        
        if (s_i != null && s_i1 != null) {
          // fullStride = contact → contact の距離
          fullStride = s_i1 - s_i;
          
          // スタートダッシュの1歩目は特別扱い
          if (runType === 'dash' && i === 0) {
            isFirstStepFromStart = true;
            // 1歩目は 0m → 1st contact
            fullStride = s_i; // s_start = 0 と仮定
          }
          
          // sectionStride = 10m区間内で担当した距離
          const stepStart = Math.min(s_i, s_i1);
          const stepEnd = Math.max(s_i, s_i1);
          const segStart = Math.max(0, stepStart);
          const segEnd = Math.min(sectionLengthM, stepEnd);
          sectionStride = Math.max(0, segEnd - segStart);
        }
        
        // 速度 = ストライド / 時間
        const stride = fullStride;
        const speedMps = stride != null && stepTime > 0 ? stride / stepTime : null;
        
        // 接地時の足のピクセル座標を取得
        const contactFootPixel = getContactFootPixel(contact);

        metrics.push({
          index: i + 1,
          contactFrame: contact,
          toeOffFrame: toeOff, // 🔥 離地フレームを設定
          nextContactFrame: nextContact,
          contactTime,
          flightTime,
          stepTime,
          stepPitch,
          stride,
          speedMps,
          acceleration: null,
          fullStride: fullStride ?? undefined,
          sectionStride: sectionStride ?? undefined,
          distanceAtContact: distanceAtContact ?? undefined,
          isFirstStepFromStart,
          contactPixelX: contactFootPixel?.x,
          contactPixelY: contactFootPixel?.y,
        });
      }
    } else {
      // ⚡ モード1/3（自動検出 or 完全手動）：接地・離地ペアでステップを計算
      console.log(`⚡ モード1/3: ${Math.floor(contactFrames.length / 2)}ステップ`);
      
      for (let i = 0; i + 2 < contactFrames.length; i += 2) {
        const contact = contactFrames[i];
        const toeOff = contactFrames[i + 1];
        const nextContact = contactFrames[i + 2];

        const contactTime = toeOff > contact ? (toeOff - contact) / usedTargetFps : null;
        const flightTime = nextContact > toeOff ? (nextContact - toeOff) / usedTargetFps : null;
        const stepTime = nextContact > contact ? (nextContact - contact) / usedTargetFps : null;
        const stepPitch = stepTime && stepTime > 0 ? 1 / stepTime : null;

        // 🎯 新仕様: ストライド計算
        const stepIndex = i / 2;
        const s_i = sContacts[stepIndex];
        const s_i1 = sContacts[stepIndex + 1];
        
        let fullStride: number | null = null;
        let sectionStride: number | null = null;
        let distanceAtContact = s_i;
        let isFirstStepFromStart = false;
        
        if (s_i != null && s_i1 != null) {
          // fullStride = contact → contact の距離
          fullStride = s_i1 - s_i;
          
          // スタートダッシュの1歩目は特別扱い
          if (runType === 'dash' && stepIndex === 0) {
            isFirstStepFromStart = true;
            // 1歩目は 0m → 1st contact
            fullStride = s_i; // s_start = 0 と仮定
          }
          
          // sectionStride = 10m区間内で担当した距離
          const stepStart = Math.min(s_i, s_i1);
          const stepEnd = Math.max(s_i, s_i1);
          const segStart = Math.max(0, stepStart);
          const segEnd = Math.min(sectionLengthM, stepEnd);
          sectionStride = Math.max(0, segEnd - segStart);
        }
        
        // 速度 = ストライド / 時間
        const stride = fullStride;
        const speedMps = stride != null && stepTime != null && stepTime > 0 ? stride / stepTime : null;
        
        // 接地時の足のピクセル座標を取得
        const contactFootPixel = getContactFootPixel(contact);

        metrics.push({
          index: metrics.length + 1,
          contactFrame: contact,
          toeOffFrame: toeOff,
          nextContactFrame: nextContact ?? null,
          contactTime,
          flightTime,
          stepTime,
          stepPitch,
          stride,
          speedMps,
          acceleration: null,
          fullStride: fullStride ?? undefined,
          sectionStride: sectionStride ?? undefined,
          distanceAtContact: distanceAtContact ?? undefined,
          isFirstStepFromStart,
          contactPixelX: contactFootPixel?.x,
          contactPixelY: contactFootPixel?.y,
        });
      }
    }
    
    // 加速度を計算（各ステップ間の速度変化）
    for (let i = 0; i < metrics.length - 1; i++) {
      const currentSpeed = metrics[i].speedMps;
      const nextSpeed = metrics[i + 1].speedMps;
      const stepTime = metrics[i].stepTime;
      
      if (currentSpeed != null && nextSpeed != null && stepTime != null && stepTime > 0) {
        metrics[i].acceleration = (nextSpeed - currentSpeed) / stepTime;
      }
    }
    
    // ✅ ブレーキ/キック比率を計算
    const comX: number[] = [];
    for (let i = 0; i < poseResults.length; i++) {
      if (poseResults[i]?.landmarks) {
        const hip23 = poseResults[i]!.landmarks[23];
        const hip24 = poseResults[i]!.landmarks[24];
        const hipX = (hip23.x + hip24.x) / 2;
        comX.push(hipX);
      } else {
        comX.push(comX.length > 0 ? comX[comX.length - 1] : 0);
      }
    }
    
    console.log('🔍 COM X (first 20 frames):', comX.slice(0, 20).map(x => x.toFixed(4)));
    console.log(`📊 Total frames with pose data: ${comX.length}, FPS: ${usedTargetFps}`);
    
    const metricsWithRatios = attachBrakeKickRatiosToSteps(metrics, comX, usedTargetFps);
    
    // 🎯 各ステップの接地時の体幹角度と膝角度を追加（加速局面の段階的評価用）
    for (const step of metricsWithRatios) {
      const frameIndex = step.contactFrame;
      if (poseResults[frameIndex]?.landmarks) {
        const angles = calculateAngles(poseResults[frameIndex]!.landmarks);
        step.trunkAngleAtContact = angles.trunkAngle;
        // 膝角度は左右のうち、より伸展している（大きい）方を支持脚と推定
        const leftKnee = angles.kneeFlex.left;
        const rightKnee = angles.kneeFlex.right;
        if (leftKnee != null && rightKnee != null) {
          // 接地時は支持脚の膝角度を使用（より伸展している方）
          step.kneeFlexAtContact = Math.max(leftKnee, rightKnee);
        } else {
          step.kneeFlexAtContact = leftKnee ?? rightKnee;
        }
      }
    }
    
    if (metricsWithRatios.length > 0) {
      const firstStep = metricsWithRatios[0];
      console.log(`📈 Step 1:
        - Full Stride: ${firstStep.fullStride?.toFixed(2) ?? 'N/A'}m
        - Section Stride: ${firstStep.sectionStride?.toFixed(2) ?? 'N/A'}m
        - Distance at Contact: ${firstStep.distanceAtContact?.toFixed(2) ?? 'N/A'}m
        - Is First Step (Dash): ${firstStep.isFirstStepFromStart}
        - Brake/Kick Ratios: ${firstStep.brakeImpulseRatio != null ? (firstStep.brakeImpulseRatio * 100).toFixed(1) : 'N/A'}% / ${firstStep.kickImpulseRatio != null ? (firstStep.kickImpulseRatio * 100).toFixed(1) : 'N/A'}%
        - Trunk Angle at Contact: ${firstStep.trunkAngleAtContact?.toFixed(1) ?? 'N/A'}°
        - Knee Flex at Contact: ${firstStep.kneeFlexAtContact?.toFixed(1) ?? 'N/A'}°
      `);
    }
    
    return metricsWithRatios;
  }, [analysisMode, mergedStepMetrics, contactFrames, manualContactFrames, usedTargetFps, poseResults, distanceValue, isPanMode, calibrationType, runType, savedStartHipX, savedEndHipX, sectionStartFrame, sectionEndFrame]);

  // ⚡ H-FVP 計算（Horizontal Force-Velocity Profile）
  const hfvpResult = useMemo((): HFVPResult | null => {
    const mode = analysisMode === 'panning' ? 'PANNING' : 'FIXED';
    console.log(`🔍 H-FVP check [${mode}]:`, {
      analysisMode,
      panningSplitsLength: panningSplits.length,
      panningStartIndex,
      panningEndIndex,
      athleteWeight: athleteInfo.weight_kg,
      athleteHeight: athleteInfo.height_cm
    });
    
    // 固定カメラモード: H-FVP計算を無効化
    if (analysisMode !== 'panning') {
      console.log(`⚠️ H-FVP [FIXED]: H-FVP calculation is disabled for fixed camera mode`);
      return null;
    }
    
    // パーン撮影モード: スプリットから測定区間を取得
    if (panningStartIndex === null || panningEndIndex === null || panningStartIndex >= panningEndIndex) {
      console.log(`⚠️ H-FVP [PANNING]: No valid measurement interval selected`, {
        panningStartIndex,
        panningEndIndex
      });
      return null;
    }
    
    const startSplit = panningSplits[panningStartIndex];
    const endSplit = panningSplits[panningEndIndex];
    const intervalSplits = panningSplits.slice(panningStartIndex, panningEndIndex + 1);
    
    console.log(`📊 H-FVP [PANNING]: Interval splits:`, {
      start: startSplit,
      end: endSplit,
      intervalLength: intervalSplits.length,
      allSplits: intervalSplits
    });
    
    if (intervalSplits.length < 3) {
      console.log(`⚠️ H-FVP [PANNING]: Need at least 3 splits for H-FVP calculation (found ${intervalSplits.length})`);
      return null;
    }
    
    // 選手情報から体重と身長を取得
    const bodyMass = athleteInfo.weight_kg ?? 70; // デフォルト70kg
    const athleteHeight = (athleteInfo.height_cm ?? 170) / 100; // cm → m、デフォルト170cm
    
    // バリデーション
    if (isNaN(bodyMass) || bodyMass <= 0 || bodyMass > 200) {
      console.warn('⚠️ Invalid body mass for H-FVP calculation');
      return null;
    }
    
    if (isNaN(athleteHeight) || athleteHeight <= 0 || athleteHeight > 2.5) {
      console.warn('⚠️ Invalid height for H-FVP calculation');
      return null;
    }
    
    // スプリットから速度データを生成
    const hfvpSteps: StepDataForHFVP[] = [];
    for (let i = 1; i < intervalSplits.length; i++) {
      const prevSplit = intervalSplits[i - 1];
      const currSplit = intervalSplits[i];
      const distanceDelta = currSplit.distance - prevSplit.distance;
      const timeDelta = currSplit.time - prevSplit.time;
      const speed = distanceDelta / timeDelta;
      
      hfvpSteps.push({
        distanceAtContactM: currSplit.distance,
        speedMps: speed,
        strideM: distanceDelta, // 近似値
        contactTimeS: timeDelta * 0.5, // 近似値（接地時間を区間時間の半分と仮定）
        flightTimeS: timeDelta * 0.5, // 近似値（滞空時間を区間時間の半分と仮定）
      });
    }
    
    console.log(`🔍 H-FVP [PANNING]: Generated ${hfvpSteps.length} speed data points from splits`);
    
    const result = calculateHFVP(hfvpSteps, bodyMass, athleteHeight);
    
    if (result) {
      console.log(`✅ H-FVP [PANNING] calculated: ${result.quality.isValid ? 'SUCCESS' : 'FAILED'}`, result);
      
      // パーン撮影モードの品質情報を追加
      result.measurementMode = 'panning';
      result.isPanningHighQuality = hfvpSteps.length >= 8;
    }
    
    return result;
  }, [analysisMode, panningSplits, panningStartIndex, panningEndIndex, athleteInfo.weight_kg, athleteInfo.height_cm]);

  // 🎯 タイム・スピード計算
  const sectionTimeSpeed = useMemo(() => {
    if (!usedTargetFps || distanceValue == null) {
      return { time: null as number | null, speed: null as number | null };
    }
    
    const sectionLengthM = distanceValue;
    
    // パーン撮影モード: フレーム数からシンプルに計算
    if (analysisMode === 'panning') {
      const totalFrames = framesRef.current.length;
      if (totalFrames === 0) {
        return { time: null, speed: null };
      }
      
      const time = totalFrames / usedTargetFps; // タイム = フレーム数 ÷ FPS
      const speed = sectionLengthM / time; // 速度 = 距離 ÷ タイム
      
      console.log(`🎥 Panning mode simple calculation: ${totalFrames} frames @ ${usedTargetFps} fps = ${time.toFixed(3)}s, ${speed.toFixed(2)}m/s`);
      
      return { time, speed };
    }
    
    // 固定カメラモード: トルソー位置から詳細計算
    if (!poseResults.length) {
      return { time: null, speed: null };
    }
    
    // トルソー位置取得関数
    const getTorsoX = (frame: number): number | null => {
      if (poseResults[frame]?.landmarks) {
        const hip23 = poseResults[frame]!.landmarks[23];
        const hip24 = poseResults[frame]!.landmarks[24];
        return (hip23.x + hip24.x) / 2;
      }
      return null;
    };
    
    // スタート/フィニッシュラインの座標
    let startLineX: number | null = savedStartHipX;
    let finishLineX: number | null = savedEndHipX;
    
    if (startLineX == null && sectionStartFrame != null) {
      startLineX = getTorsoX(sectionStartFrame);
    }
    if (finishLineX == null && sectionEndFrame != null) {
      finishLineX = getTorsoX(sectionEndFrame);
    }
    
    if (startLineX == null || finishLineX == null || startLineX === finishLineX) {
      return { time: null, speed: null };
    }
    
    const distancePerNormalized = sectionLengthM / Math.abs(finishLineX - startLineX);
    const isLeftToRight = finishLineX > startLineX;
    
    // 各フレームでの距離[m]
    const distanceAtFrame = (frame: number): number | null => {
      const torsoX = getTorsoX(frame);
      if (torsoX == null) return null;
      return isLeftToRight 
        ? (torsoX - startLineX!) * distancePerNormalized
        : (startLineX! - torsoX) * distancePerNormalized;
    };
    
    // トルソーが0mを超える瞬間を探す（線形補間）
    let tStart: number | null = null;
    for (let f = 0; f < poseResults.length - 1; f++) {
      const d1 = distanceAtFrame(f);
      const d2 = distanceAtFrame(f + 1);
      if (d1 != null && d2 != null && d1 < 0 && d2 >= 0) {
        // 線形補間でサブフレーム精度を出す
        const ratio = (0 - d1) / (d2 - d1);
        tStart = (f + ratio) / usedTargetFps;
        break;
      } else if (d1 != null && d1 >= 0 && tStart == null) {
        // 最初から0m以上の場合
        tStart = f / usedTargetFps;
        break;
      }
    }
    
    // トルソーが10mを超える瞬間を探す（線形補間）
    let tFinish: number | null = null;
    for (let f = 0; f < poseResults.length - 1; f++) {
      const d1 = distanceAtFrame(f);
      const d2 = distanceAtFrame(f + 1);
      if (d1 != null && d2 != null && d1 < sectionLengthM && d2 >= sectionLengthM) {
        const ratio = (sectionLengthM - d1) / (d2 - d1);
        tFinish = (f + ratio) / usedTargetFps;
        break;
      }
    }
    
    if (tStart != null && tFinish != null && tFinish > tStart) {
      const time = tFinish - tStart;
      const speed = sectionLengthM / time;
      console.log(`🏃 ${sectionLengthM}mタイム: ${time.toFixed(3)}秒, 平均速度: ${speed.toFixed(2)} m/s`);
      console.log(`   (トルソー通過: ${tStart.toFixed(3)}s → ${tFinish.toFixed(3)}s)`);
      return { time, speed };
    }
    
    return { time: null, speed: null };
  }, [usedTargetFps, poseResults, distanceValue, savedStartHipX, savedEndHipX, sectionStartFrame, sectionEndFrame]);

  const stepSummary = useMemo(() => {
    if (!stepMetrics.length) {
      return {
        stepCount: 0,
        avgContact: null as number | null,
        avgFlight: null as number | null,
        avgStepTime: null as number | null,
        avgStepPitch: null as number | null,
        avgStride: null as number | null,
        avgSpeedMps: null as number | null,
        sectionTime: sectionTimeSpeed.time,
        sectionSpeed: sectionTimeSpeed.speed,
      };
    }

    let sumContact = 0,
      nContact = 0;
    let sumFlight = 0,
      nFlight = 0;
    let sumStep = 0,
      nStep = 0;
    let sumPitch = 0,
      nPitch = 0;
    let sumStride = 0,
      nStride = 0;
    let sumSpeed = 0,
      nSpeed = 0;

    // 🎯 補間ステップ（quality='warning'）を除外して統計計算
    const realSteps = stepMetrics.filter(s => s.quality !== 'warning');
    
    for (const s of realSteps) {
      if (s.contactTime != null) {
        sumContact += s.contactTime;
        nContact++;
      }
      if (s.flightTime != null) {
        sumFlight += s.flightTime;
        nFlight++;
      }
      if (s.stepTime != null) {
        sumStep += s.stepTime;
        nStep++;
      }
      if (s.stepPitch != null) {
        sumPitch += s.stepPitch;
        nPitch++;
      }
      if (s.stride != null) {
        sumStride += s.stride;
        nStride++;
      }
      if (s.speedMps != null) {
        sumSpeed += s.speedMps;
        nSpeed++;
      }
    }

    const stepCount = nStep;
    const avgContact = nContact ? sumContact / nContact : null;
    const avgFlight = nFlight ? sumFlight / nFlight : null;
    const avgStepTime = nStep ? sumStep / nStep : null;
    const avgStepPitch = nPitch ? sumPitch / nPitch : null;
    const avgStride = nStride ? sumStride / nStride : null;
    const avgSpeedMps = nSpeed ? sumSpeed / nSpeed : null;

    return {
      stepCount,
      avgContact,
      avgFlight,
      avgStepTime,
      avgStepPitch,
      avgStride,
      avgSpeedMps,
      sectionTime: sectionTimeSpeed.time,
      sectionSpeed: sectionTimeSpeed.speed,
    };
  }, [stepMetrics, sectionTimeSpeed]);

  // 現在フレームの角度
  const currentAngles = useMemo((): AngleData | null => {
    if (!poseResults[currentFrame]?.landmarks) return null;
    const angles = calculateAngles(poseResults[currentFrame]!.landmarks);
    return { frame: currentFrame, ...angles };
  }, [currentFrame, poseResults]);

  // 3局面の角度計算（大腿角度ベース）
  // 接地期前半：接地時点（大腿が前方）
  // 接地期中半：大腿が鉛直（0°に最も近い時点）
  // 接地期後半：離地時点（大腿が後方）
  const threePhaseAngles = useMemo((): PhaseAngles[] => {
    if (contactFrames.length < 3 || poseResults.length === 0) return [];

    const results: PhaseAngles[] = [];

    // 各ステップ（接地から離地まで）を処理
    for (let i = 0; i + 1 < contactFrames.length; i += 2) {
      const contactFrame = contactFrames[i];
      const toeOffFrame = contactFrames[i + 1];
      const stepIndex = Math.floor(i / 2);

      if (toeOffFrame <= contactFrame) continue;

      // 接地期前半：接地時点のフレーム
      if (poseResults[contactFrame]?.landmarks) {
        const angles = calculateAngles(poseResults[contactFrame]!.landmarks);
        results.push({
          stepIndex,
          phase: "initial",
          frame: contactFrame,
          angles,
        });
      }

      // 接地期中半：大腿角度が0°に最も近いフレームを探す
      let minAngleDiff = Infinity;
      let midFrame = contactFrame;
      
      for (let f = contactFrame; f <= toeOffFrame; f++) {
        const pose = poseResults[f];
        if (!pose?.landmarks) continue;

        const angles = calculateAngles(pose.landmarks);
        // 左右の大腿角度の平均を取る（どちらが接地脚か不明なため）
        const avgThighAngle = (
          (angles.thighAngle.left ?? 0) + (angles.thighAngle.right ?? 0)
        ) / 2;
        const angleDiff = Math.abs(avgThighAngle);

        if (angleDiff < minAngleDiff) {
          minAngleDiff = angleDiff;
          midFrame = f;
        }
      }

      if (poseResults[midFrame]?.landmarks) {
        const angles = calculateAngles(poseResults[midFrame]!.landmarks);
        results.push({
          stepIndex,
          phase: "mid",
          frame: midFrame,
          angles,
        });
      }

      // 接地期後半：離地時点のフレーム
      if (poseResults[toeOffFrame]?.landmarks) {
        const angles = calculateAngles(poseResults[toeOffFrame]!.landmarks);
        results.push({
          stepIndex,
          phase: "late",
          frame: toeOffFrame,
          angles,
        });
      }
    }

    return results;
  }, [contactFrames, poseResults]);

  // ------------ 欠損フレームの補間処理 ------------
  const interpolateMissingPoses = (results: (FramePoseData | null)[]): (FramePoseData | null)[] => {
    const interpolated = [...results];
    
    for (let i = 0; i < interpolated.length; i++) {
      // 欠損フレームを発見
      if (interpolated[i] === null || !interpolated[i]?.landmarks) {
        // 前後の有効なフレームを探す
        let prevIndex = i - 1;
        let nextIndex = i + 1;
        
        // 🔥 前の有効なフレームを探す（最大20フレーム前まで：バランス調整）
        while (prevIndex >= 0 && prevIndex >= i - 20) {
          if (interpolated[prevIndex]?.landmarks) break;
          prevIndex--;
        }
        
        // 🔥 次の有効なフレームを探す（最大20フレーム後まで：バランス調整）
        while (nextIndex < interpolated.length && nextIndex <= i + 20) {
          if (interpolated[nextIndex]?.landmarks) break;
          nextIndex++;
        }
        
        // 前後両方が見つかった場合、線形補間
        if (prevIndex >= 0 && prevIndex >= i - 20 && 
            nextIndex < interpolated.length && nextIndex <= i + 20 &&
            interpolated[prevIndex]?.landmarks && interpolated[nextIndex]?.landmarks) {
          
          const prevLandmarks = interpolated[prevIndex]!.landmarks;
          const nextLandmarks = interpolated[nextIndex]!.landmarks;
          const ratio = (i - prevIndex) / (nextIndex - prevIndex);
          
          // ランドマークを線形補間
          const interpolatedLandmarks = prevLandmarks.map((prevLm, idx) => {
            const nextLm = nextLandmarks[idx];
            return {
              x: prevLm.x + (nextLm.x - prevLm.x) * ratio,
              y: prevLm.y + (nextLm.y - prevLm.y) * ratio,
              z: prevLm.z + (nextLm.z - prevLm.z) * ratio,
              visibility: Math.min(prevLm.visibility, nextLm.visibility) * 0.8 // 信頼度を少し下げる
            };
          });
          
          interpolated[i] = { landmarks: interpolatedLandmarks };
          // ログを減らす（10フレームごとに1回）
          if (i % 10 === 0) {
            console.log(`🔧 Frame ${i} interpolated from ${prevIndex} and ${nextIndex}`);
          }
        }
        // 🔥 前のフレームのみが見つかった場合、そのままコピー（範囲拡大）
        else if (prevIndex >= 0 && prevIndex >= i - 15 && interpolated[prevIndex]?.landmarks) {
          interpolated[i] = {
            landmarks: interpolated[prevIndex]!.landmarks.map(lm => ({
              ...lm,
              visibility: lm.visibility * 0.6 // 信頼度を下げる
            }))
          };
          // ログを減らす（10フレームごとに1回）
          if (i % 10 === 0) {
            console.log(`🔧 Frame ${i} copied from ${prevIndex}`);
          }
        }
        // 🔥 次のフレームのみが見つかった場合、そのままコピー（範囲調整）
        else if (nextIndex < interpolated.length && nextIndex <= i + 10 && interpolated[nextIndex]?.landmarks) {
          interpolated[i] = {
            landmarks: interpolated[nextIndex]!.landmarks.map(lm => ({
              ...lm,
              visibility: lm.visibility * 0.6 // 信頼度を下げる
            }))
          };
          // ログを減らす（10フレームごとに1回）
          if (i % 10 === 0) {
            console.log(`🔧 Frame ${i} copied from ${nextIndex}`);
          }
        }
      }
    }
    
    return interpolated;
  };

  // ------------ 姿勢推定実行 ------------
  const runPoseEstimation = async () => {
    if (!framesRef.current.length) {
      alert("先にフレーム抽出を実行してください。");
      return;
    }

    // 🔥 CRITICAL: 前回の結果を完全にクリア（メモリリークと状態汚染を防ぐ）
    console.log('🧹 Clearing previous pose estimation results...');
    setPoseResults([]);
    
    // 少し待ってから処理開始（状態のクリアを確実にする）
    await new Promise(resolve => setTimeout(resolve, 100));

    setIsPoseProcessing(true);
    setPoseProgress(0);
    setStatus("姿勢推定を実行中...");

    try {
      // MediaPipeの存在を詳細にチェック
      console.log('🔍 Checking MediaPipe availability...');
      console.log('window.Pose:', typeof (window as any).Pose);
      console.log('User Agent:', navigator.userAgent);
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Pose: any = (window as any).Pose;

      if (!Pose) {
        // iPadでMediaPipeが読み込まれていない場合の詳細エラー
        console.error('❌ MediaPipe Pose not found!');
        console.error('Available globals:', Object.keys(window).filter(k => k.toLowerCase().includes('pose') || k.toLowerCase().includes('media')));
        
        // MediaPipeの手動読み込みを試みる
        if (/iPad|iPhone/i.test(navigator.userAgent)) {
          console.log('🔄 Attempting to reload MediaPipe for iOS...');
          
          // スクリプトの再読み込みを試みる
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/pose.min.js';
            script.crossOrigin = 'anonymous';
            script.onload = () => {
              console.log('✅ MediaPipe Pose script reloaded');
              resolve(true);
            };
            script.onerror = (e) => {
              console.error('❌ Failed to reload MediaPipe:', e);
              reject(e);
            };
            document.head.appendChild(script);
          });
          
          // 少し待ってから再チェック
          await new Promise(resolve => setTimeout(resolve, 500));
          const PoseRetry: any = (window as any).Pose;
          
          if (!PoseRetry) {
            throw new Error("MediaPipe PoseライブラリがiPadで読み込めませんでした。ページをリロードしてください。");
          }
        } else {
          throw new Error("MediaPipe Poseライブラリが読み込まれていません。");
        }
      }

      // 再度Poseを取得（リロードした場合のため）
      const PoseClass: any = (window as any).Pose || Pose;
      
      console.log('🎯 Creating Pose instance...');
      const pose = new PoseClass({
        locateFile: (file: string) => {
          const url = `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
          console.log(`📁 Loading MediaPipe file: ${file} from ${url}`);
          return url;
        },
      });

      // 🚀 デバイスに応じた設定（メモリ効率を考慮）
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isIPad = /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      
      // 🔧 デバイスごとの最適化設定
      let modelComplexity = 2; // 🔥 高精度モデルをデフォルトに（精度優先）
      let minDetectionConfidence = 0.1; // 🔥 認識率を大幅に向上
      let minTrackingConfidence = 0.1; // 🔥 認識率を大幅に向上
      let staticImageMode = false;
      let smoothLandmarks = true;
      
      if (isIPad) {
        console.log('📱 iPad detected - applying optimized settings');
        modelComplexity = 1; // 中精度モデル（iPadはメモリ制限あり）
        minDetectionConfidence = 0.05; // 認識率を最大化
        minTrackingConfidence = 0.05; // 認識率を最大化
        staticImageMode = false; // ストリーミングモードで連続性を保つ
        smoothLandmarks = true; // スムージングを有効化
      } else if (isMobile) {
        console.log('📱 Mobile device detected - optimized settings');
        modelComplexity = 1; // 中精度モデル（モバイルはメモリ制限）
        minDetectionConfidence = 0.05; // 認識率を最大化
        minTrackingConfidence = 0.05; // 認識率を最大化
      } else {
        console.log('💻 Desktop detected - high accuracy settings');
        modelComplexity = 2; // デスクトップは高精度
        minDetectionConfidence = 0.05; // 認識率を最大化
        minTrackingConfidence = 0.05; // 認識率を最大化
      }
      
      console.log(`🔧 Setting options: modelComplexity=${modelComplexity}, detection=${minDetectionConfidence}, tracking=${minTrackingConfidence}`);
      
      pose.setOptions({
        modelComplexity,
        smoothLandmarks,
        enableSegmentation: false,
        smoothSegmentation: false,
        minDetectionConfidence,
        minTrackingConfidence,
        selfieMode: false,
        staticImageMode,
      });
      
      console.log(`🚀 Pose estimation config: mobile=${isMobile}, iOS=${isIOS}, iPad=${isIPad}, modelComplexity=${modelComplexity}`);
      
      // iPadでは初期化を待つ
      if (isIPad) {
        console.log('⏳ Waiting for MediaPipe initialization on iPad...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const results: (FramePoseData | null)[] = [];
      const totalFrames = framesRef.current.length;
      
      // 🔧 メモリ効率のため、再利用可能なcanvasを作成
      const tempCanvas = document.createElement("canvas");
      const firstFrame = framesRef.current[0];
      tempCanvas.width = firstFrame.width;
      tempCanvas.height = firstFrame.height;
      const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
      
      if (!tempCtx) {
        throw new Error("Canvas context の作成に失敗しました");
      }

      // MediaPipe入力用に縮小したキャンバスを用意
      const maxPoseWidth = isIPad ? 540 : 960;
      const poseScale = Math.min(1, maxPoseWidth / tempCanvas.width);
      const poseCanvas = document.createElement("canvas");
      poseCanvas.width = Math.max(1, Math.round(tempCanvas.width * poseScale));
      poseCanvas.height = Math.max(1, Math.round(tempCanvas.height * poseScale));
      const poseCtx = poseCanvas.getContext("2d", { willReadFrequently: true });
      if (!poseCtx) {
        throw new Error("Pose canvas context の作成に失敗しました");
      }

      const drawPoseInput = () => {
        poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
        poseCtx.drawImage(
          tempCanvas,
          0,
          0,
          tempCanvas.width,
          tempCanvas.height,
          0,
          0,
          poseCanvas.width,
          poseCanvas.height
        );
      };

      // 🔧 バッチ処理のサイズ（メモリ解放のタイミング）
      const batchSize = isIPad ? 3 : (isMobile ? 5 : 20); // iPadは3フレームごと
      const timeoutDuration = isIPad ? 15000 : (isMobile ? 10000 : 5000); // iPadは15秒

      // 最初のフレームで動作確認
      if (totalFrames > 0) {
        console.log('🧪 Testing pose estimation on first frame...');
        tempCtx.putImageData(framesRef.current[0], 0, 0);
        
        try {
          const testResult = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => {
              console.error('❌ Test frame timeout');
              reject(new Error("Test timeout"));
            }, isIPad ? 10000 : 5000);
            
            pose.onResults((r: any) => {
              clearTimeout(timeout);
              console.log('✅ Test frame processed:', r.poseLandmarks ? 'Landmarks found' : 'No landmarks');
              resolve(r);
            });
            
            drawPoseInput();
            pose.send({ image: poseCanvas }).catch((e: any) => {
              console.error('❌ Test frame send error:', e);
              reject(e);
            });
          });
          
          if (!testResult.poseLandmarks) {
            console.warn('⚠️ First frame test: No landmarks detected');
            if (isIPad) {
              console.log('🔄 iPad: Retrying with different settings...');
              // 設定を変更して再試行
              pose.setOptions({
                modelComplexity: 0, // 最軽量モデルに変更
                staticImageMode: true,
                minDetectionConfidence: 0.01,
                minTrackingConfidence: 0.01,
              });
            }
          }
        } catch (e) {
          console.error('❌ First frame test failed:', e);
        }
      }

      for (let i = 0; i < totalFrames; i++) {
        const frame = framesRef.current[i];

        // 🔧 canvasを再利用（毎回作成しない）
        tempCtx.putImageData(frame, 0, 0);
        

        try {
          const result = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(
              () => {
                console.warn(`⏱️ Frame ${i} timeout after ${timeoutDuration}ms`);
                reject(new Error("Timeout"));
              },
              timeoutDuration
            );

            pose.onResults((r: any) => {
              clearTimeout(timeout);
              if (i < 3 || i % 50 === 0) {
                console.log(`📊 Frame ${i} result:`, r.poseLandmarks ? 'Detected' : 'Not detected');
              }
              resolve(r);
            });

            drawPoseInput();
            pose.send({ image: poseCanvas }).catch((e: any) => {
              console.error(`❌ Frame ${i} send error:`, e);
              reject(e);
            });
          });

          if (result.poseLandmarks) {
            results.push({
              landmarks: result.poseLandmarks.map((lm: any) => ({
                x: lm.x,
                y: lm.y,
                z: lm.z,
                visibility: lm.visibility ?? 0,
              })),
            });
            if (i < 5) {
              console.log(`✅ Frame ${i}: Pose detected`);
            }
          } else {
            results.push(null);
            if (i < 5) {
              console.warn(`❌ Frame ${i}: No pose landmarks`);
            }
          }
        } catch (e: any) {
          if (e.message === "Timeout") {
            console.warn(`⏱️ Frame ${i} timed out`);
          } else {
            console.error(`❌ Frame ${i} error:`, e.message);
          }
          results.push(null);
        }
        
        // 🔧 バッチごとにメモリ解放とUI更新
        if ((i + 1) % batchSize === 0) {
          // ガベージコレクションのヒントを与える
          await new Promise(resolve => setTimeout(resolve, isMobile ? 100 : 10));
          
          // 進捗更新
          const progress = Math.round(((i + 1) / totalFrames) * 100);
          setPoseProgress(progress);
          setStatus(`姿勢推定中... ${i + 1}/${totalFrames} フレーム (${progress}%)`);
          
          // 🔧 メモリ監視（可能な場合）
          if ((window as any).performance?.memory) {
            const mem = (window as any).performance.memory;
            const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
            const limitMB = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
            console.log(`📊 Memory: ${usedMB}MB / ${limitMB}MB (${Math.round(usedMB/limitMB*100)}%)`);
            
            // メモリ使用量が80%を超えたら警告
            if (usedMB / limitMB > 0.8) {
              console.warn('⚠️ High memory usage detected!');
              // 少し長めに待ってGCを促す
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        } else {
          // バッチ以外でも進捗更新
          const progress = Math.round(((i + 1) / totalFrames) * 100);
          setPoseProgress(progress);
          setStatus(`姿勢推定中... ${i + 1}/${totalFrames} フレーム`);
        }
      }

      // 🔧 tempCanvasの参照をクリア
      tempCanvas.width = 0;
      tempCanvas.height = 0;
      poseCanvas.width = 0;
      poseCanvas.height = 0;

      // MediaPipe Pose インスタンスを明示的にクローズ（メモリ解放）
      try {
        pose.close();
        console.log('🧹 MediaPipe Pose instance closed successfully');
      } catch (e) {
        console.warn('⚠️ Failed to close Pose instance:', e);
      }
      
      // 🔧 GCを促すために少し待つ
      await new Promise(resolve => setTimeout(resolve, 200));

      // 欠損フレームの補間処理
      console.log('🔧 欠損フレームを補間中...');
      setStatus('🔧 欠損フレームを補間中...');
      setPoseProgress(100);
      
      // UIをブロックしないように少し待つ
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const interpolatedResults = interpolateMissingPoses(results);
      
      setPoseResults(interpolatedResults);
      
      // 成功率を計算（補間前）
      const successCount = results.filter(r => r !== null && r.landmarks).length;
      const successRateNum = successCount / results.length * 100;
      const successRateStr = successRateNum.toFixed(1);
      
      // 補間後の成功率を計算
      const interpolatedCount = interpolatedResults.filter(r => r !== null && r.landmarks).length;
      const interpolatedRateNum = interpolatedCount / interpolatedResults.length * 100;
      const interpolatedRateStr = interpolatedRateNum.toFixed(1);
      
      console.log(`📊 Pose estimation complete: ${successCount}/${results.length} frames (${successRateStr}%)`);
      console.log(`✨ After interpolation: ${interpolatedCount}/${interpolatedResults.length} frames (${interpolatedRateStr}%)`);
      
      // 🔥 補間後の成功率を使用して表示
      if (successCount === 0) {
        setStatus("❌ 姿勢推定が完全に失敗しました。動画を変更してください。");
        alert("姿勢推定が失敗しました。\n\n【推奨事項】\n・人物が画面の中央に大きく映っている動画を使用\n・照明が明るく、人物がはっきり見える動画を使用\n・背景がシンプルな動画を使用\n・カメラが固定されている（手ブレが少ない）動画を使用\n・動画の長さを5-10秒程度に制限\n\nこれらの条件を満たす動画で再度お試しください。");
        return;
      } else if (interpolatedRateNum < 50) {
        setStatus(`⚠️ 姿勢推定完了（成功率: ${interpolatedRateStr}%、補間前: ${successRateStr}%）- 精度が低い可能性があります`);
        if (!confirm(`⚠️ 姿勢推定の成功率が低いです（${interpolatedRateStr}%）。\n\n続行しますか？\n\n※ 成功率が低いと、解析精度が大幅に低下します。\n\n【動画品質の推奨条件】\n✅ 人物が画面の50%以上を占めている\n✅ 照明が十分明るい（日中の屋外など）\n✅ 背景がシンプル（トラックや運動場など）\n✅ カメラが完全に固定されている\n✅ 解像度がHD（1280x720）以上\n✅ フレームレートが30fps以上\n\n❌ 人物が小さい動画は検出率が極端に低下します`)) {
          return;
        }
      } else {
        setStatus(`✅ 姿勢推定完了！（成功率: ${interpolatedRateStr}%、補間前: ${successRateStr}%）`);
      }
      
      // 🔧 モバイル端末でもフレームと姿勢データのインデックスを一致させるため、
      //     解析後のフレーム間引きは行わない（表示のズレを防止）
      const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      if (isMobileDevice) {
        console.log(`📱 Mobile device detected → keeping all ${framesRef.current.length} frames for accurate overlay`);
      }
      
      // 自動で次のステップへ（区間設定）
      setTimeout(() => {
        setWizardStep(5);
      }, 1000);
    } catch (e: any) {
      console.error("Pose estimation error:", e);
      setStatus("❌ 姿勢推定でエラーが発生しました: " + e.message);
      
      // 🔧 エラー時もメモリ解放を試みる
      try {
        if (framesRef.current.length > 50) {
          console.log('🧹 Error recovery: Clearing frame data...');
          framesRef.current.length = 0;
        }
      } catch (cleanupError) {
        console.warn('⚠️ Failed to cleanup frames:', cleanupError);
      }
    } finally {
      setIsPoseProcessing(false);
      
      // 🔧 GCを促す
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };

  // ------------ スケルトン描画 ------------
  const drawSkeleton = (
    ctx: CanvasRenderingContext2D,
    landmarks: FramePoseData["landmarks"],
    width: number,
    height: number
  ) => {
    // デバイス判定
    const isIPad = /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const CONFIDENCE_THRESHOLD = isIPad ? 0.01 : 0.05;
    
    // 主要な関節の妥当性をチェック
    const isValidPose = () => {
      const leftShoulder = landmarks[11];
      const rightShoulder = landmarks[12];
      const leftHip = landmarks[23];
      const rightHip = landmarks[24];
      
      if (
        leftShoulder.visibility < CONFIDENCE_THRESHOLD ||
        rightShoulder.visibility < CONFIDENCE_THRESHOLD ||
        leftHip.visibility < CONFIDENCE_THRESHOLD ||
        rightHip.visibility < CONFIDENCE_THRESHOLD
      ) {
        return false;
      }
      
      // 肩が腰より上にあるか確認
      const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
      const hipY = (leftHip.y + rightHip.y) / 2;
      
      if (shoulderY >= hipY) {
        return false;
      }
      
      return true;
    };
    
    if (!isValidPose()) {
      return;
    }

    ctx.strokeStyle = "#00ff00";  // より見やすい緑色
    ctx.lineWidth = 10;  // 4 → 10に変更（さらに太く）

    const connections: [number, number][] = [
      [11, 12],
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
      [11, 23],
      [12, 24],
      [23, 24],
      [23, 25],
      [25, 27],
      [27, 31],
      [24, 26],
      [26, 28],
      [28, 32],
    ];

    connections.forEach(([a, b]) => {
      const pointA = landmarks[a];
      const pointB = landmarks[b];
      if (
        pointA &&
        pointB &&
        pointA.visibility > CONFIDENCE_THRESHOLD &&
        pointB.visibility > CONFIDENCE_THRESHOLD
      ) {
        // 2点間の距離が異常に遠い場合は描画しない
        const dx = (pointB.x - pointA.x) * width;
        const dy = (pointB.y - pointA.y) * height;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // フレーム幅の50%以上離れている接続は異常
        if (distance > width * 0.5) {
          return;
        }
        
        // 座標を計算（iPad補正を適用）
        const x1 = pointA.x * width;
        const y1 = pointA.y * height;
        const x2 = pointB.x * width;
        const y2 = pointB.y * height;
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    });

    ctx.fillStyle = "#f97316";
    landmarks.forEach((lm: FramePoseData["landmarks"][number], index: number) => {
      if (lm.visibility > CONFIDENCE_THRESHOLD) {
        const x = lm.x * width;
        const y = lm.y * height;
        
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, 2 * Math.PI);  // 4 → 10に拡大（さらに大きく）
        ctx.fill();
        
        // iPadデバッグ: 主要ポイントの位置をログ出力（高頻度でログが出ないよう制限）
        if (isIPad && Math.random() < 0.01 && (index === 0 || index === 11 || index === 23)) {
          console.log(`🎯 Point ${index}: x=${(lm.x * 100).toFixed(1)}%, y=${(lm.y * 100).toFixed(1)}%, vis=${lm.visibility.toFixed(2)}`);
        }
      }
    });
    
    // 🎯 大転子から垂直線を描画し、つま先までの水平距離を表示（cm単位）
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    const leftToe = landmarks[31];
    const rightToe = landmarks[32];
    
    // 大転子（腰）の中心を計算
    if (leftHip.visibility > CONFIDENCE_THRESHOLD && rightHip.visibility > CONFIDENCE_THRESHOLD) {
      const hipCenterX = ((leftHip.x + rightHip.x) / 2) * width;
      const hipCenterY = ((leftHip.y + rightHip.y) / 2) * height;
      
      // 大腿長を計算（cm換算用の基準）
      const ASSUMED_THIGH_LENGTH_CM = 50;
      const leftThighLength = Math.sqrt(
        Math.pow(leftKnee.x - leftHip.x, 2) + Math.pow(leftKnee.y - leftHip.y, 2)
      );
      const rightThighLength = Math.sqrt(
        Math.pow(rightKnee.x - rightHip.x, 2) + Math.pow(rightKnee.y - rightHip.y, 2)
      );
      const avgThighLength = (leftThighLength + rightThighLength) / 2;
      
      // 垂直線を描画（大転子から下方向）
      ctx.strokeStyle = "#dc2626"; // 赤色
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]); // 破線
      ctx.beginPath();
      ctx.moveTo(hipCenterX, hipCenterY);
      ctx.lineTo(hipCenterX, height); // 画面下まで
      ctx.stroke();
      ctx.setLineDash([]); // 破線解除
      
      // 大転子マーカー
      ctx.fillStyle = "#dc2626";
      ctx.beginPath();
      ctx.arc(hipCenterX, hipCenterY, 8, 0, 2 * Math.PI);
      ctx.fill();
      
      // 「大転子」ラベル
      ctx.fillStyle = "#dc2626";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("大転子", hipCenterX + 12, hipCenterY - 5);
      
      // 左つま先までの距離を表示（cm単位）
      if (leftToe.visibility > CONFIDENCE_THRESHOLD) {
        const leftToeX = leftToe.x * width;
        const leftToeY = leftToe.y * height;
        
        // 正規化座標での水平距離
        const leftDistNorm = leftToe.x - (leftHip.x + rightHip.x) / 2;
        // cm換算：前方がマイナス、後方がプラス（符号反転）
        const leftDistCm = avgThighLength > 0 
          ? (-leftDistNorm / avgThighLength) * ASSUMED_THIGH_LENGTH_CM 
          : 0;
        
        // つま先から垂直線への水平線
        ctx.strokeStyle = "#22c55e"; // 緑色
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(hipCenterX, leftToeY);
        ctx.lineTo(leftToeX, leftToeY);
        ctx.stroke();
        
        // つま先マーカー
        ctx.fillStyle = "#22c55e";
        ctx.beginPath();
        ctx.arc(leftToeX, leftToeY, 6, 0, 2 * Math.PI);
        ctx.fill();
        
        // 距離ラベル（左、cm単位）
        const leftDistLabel = leftDistCm < 0 
          ? `L: ${Math.abs(leftDistCm).toFixed(1)}cm前` 
          : `L: ${leftDistCm.toFixed(1)}cm後`;
        
        // 背景付きラベル
        ctx.font = "bold 14px sans-serif";
        const textWidth = ctx.measureText(leftDistLabel).width;
        const labelX = (hipCenterX + leftToeX) / 2 - textWidth / 2;
        const labelY = leftToeY - 8;
        
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        ctx.fillRect(labelX - 4, labelY - 14, textWidth + 8, 18);
        ctx.fillStyle = "#16a34a";
        ctx.textAlign = "left";
        ctx.fillText(leftDistLabel, labelX, labelY);
      }
      
      // 右つま先までの距離を表示（cm単位）
      if (rightToe.visibility > CONFIDENCE_THRESHOLD) {
        const rightToeX = rightToe.x * width;
        const rightToeY = rightToe.y * height;
        
        // 正規化座標での水平距離
        const rightDistNorm = rightToe.x - (leftHip.x + rightHip.x) / 2;
        // cm換算：前方がマイナス、後方がプラス（符号反転）
        const rightDistCm = avgThighLength > 0 
          ? (-rightDistNorm / avgThighLength) * ASSUMED_THIGH_LENGTH_CM 
          : 0;
        
        // つま先から垂直線への水平線
        ctx.strokeStyle = "#3b82f6"; // 青色
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(hipCenterX, rightToeY);
        ctx.lineTo(rightToeX, rightToeY);
        ctx.stroke();
        
        // つま先マーカー
        ctx.fillStyle = "#3b82f6";
        ctx.beginPath();
        ctx.arc(rightToeX, rightToeY, 6, 0, 2 * Math.PI);
        ctx.fill();
        
        // 距離ラベル（右、cm単位）
        const rightDistLabel = rightDistCm < 0 
          ? `R: ${Math.abs(rightDistCm).toFixed(1)}cm前` 
          : `R: ${rightDistCm.toFixed(1)}cm後`;
        
        // 背景付きラベル
        ctx.font = "bold 14px sans-serif";
        const textWidth = ctx.measureText(rightDistLabel).width;
        const labelX = (hipCenterX + rightToeX) / 2 - textWidth / 2;
        const labelY = rightToeY - 8;
        
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        ctx.fillRect(labelX - 4, labelY - 14, textWidth + 8, 18);
        ctx.fillStyle = "#2563eb";
        ctx.textAlign = "left";
        ctx.fillText(rightDistLabel, labelX, labelY);
      }
    }
  };

  // ------------ CSV エクスポート ------------
  const exportAnglesToCSV = () => {
    if (!poseResults.length) {
      alert("姿勢推定を先に実行してください。");
      return;
    }

    let csv =
      "Frame,Trunk_Angle,Left_HipAnkle,Right_HipAnkle,Left_Thigh_deg,Right_Thigh_deg,Left_Shank_deg,Right_Shank_deg,Left_Knee,Right_Knee,Left_Ankle,Right_Ankle,Left_Elbow,Right_Elbow,Left_Toe_Distance_cm,Right_Toe_Distance_cm\n" +
      "# 大腿角度(Thigh)と下腿角度(Shank)は鉛直下向きを0°、前方がマイナス、後方がプラス\n" +
      "# 足先距離(Toe_Distance)は大転子から鉛直下方向を0cm、前方がマイナス、後方がプラス\n";

    for (let i = 0; i < poseResults.length; i++) {
      const pose = poseResults[i];
      if (!pose?.landmarks) {
        csv += `${i},,,,,,,,,,,,,,,\n`;
        continue;
      }

      const angles = calculateAngles(pose.landmarks);
      csv += `${i},${angles.trunkAngle?.toFixed(2) ?? ""},${
        angles.hipAnkleAngle.left?.toFixed(2) ?? ""
      },${angles.hipAnkleAngle.right?.toFixed(2) ?? ""},${
        angles.thighAngle.left?.toFixed(2) ?? ""
      },${angles.thighAngle.right?.toFixed(2) ?? ""},${
        angles.shankAngle.left?.toFixed(2) ?? ""
      },${angles.shankAngle.right?.toFixed(2) ?? ""},${
        angles.kneeFlex.left?.toFixed(2) ?? ""
      },${angles.kneeFlex.right?.toFixed(2) ?? ""},${
        angles.ankleFlex.left?.toFixed(2) ?? ""
      },${angles.ankleFlex.right?.toFixed(2) ?? ""},${
        angles.elbowAngle.left?.toFixed(2) ?? ""
      },${angles.elbowAngle.right?.toFixed(2) ?? ""},${
        angles.toeHorizontalDistance.left?.toFixed(2) ?? ""
      },${angles.toeHorizontalDistance.right?.toFixed(2) ?? ""}\n`;
    }

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `angles_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ------------ サーバー保存関連 ------------
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);

  const handleSaveSession = async () => {
    setSaveResult(null);
    const videoName = videoFile?.name ?? "(名称なし)";
    const distance_m = distanceValue;
    const section_frame_count =
      sectionRange.count > 0 ? sectionRange.count : null;
    const section_time_s = sectionTime;
    const avg_speed_mps = avgSpeed;

    try {
      setSaving(true);
      
      // ステップサマリーから追加データを取得
      const avgStride = stepSummary?.avgStride ?? null;
      const avgCadence = stepSummary?.avgStepPitch ?? null;
      const avgContactTime = stepSummary?.avgContact ?? null;
      const avgFlightTime = stepSummary?.avgFlight ?? null;

      const runMode: 'dash' | 'accel' = detectionMode === 1 ? 'dash' : 'accel';
      const analysisType: 'acceleration' | 'topSpeed' =
        runMode === 'dash' ? 'acceleration' : 'topSpeed';

      const evalSummary = {
        avgContact: stepSummary?.avgContact ?? 0,
        avgFlight: stepSummary?.avgFlight ?? 0,
        avgStepPitch: stepSummary?.avgStepPitch ?? 0,
        avgStride: stepSummary?.avgStride ?? 0,
        avgSpeed: stepSummary?.avgSpeedMps ?? 0,
      };

      const aiEvaluation = generateRunningEvaluation(
        stepMetrics ?? [],
        threePhaseAngles ?? [],
        evalSummary,
        analysisType,
        {
          heightCm: athleteInfo?.height_cm,
          gender: athleteInfo?.gender as 'male' | 'female' | 'other' | null,
        },
        runMode
      );

      let targetAdvice: string | null = null;
      if (athleteInfo?.target_record) {
        const targetTime = parseFloat(athleteInfo.target_record);
        if (!isNaN(targetTime) && targetTime > 0) {
          targetAdvice = generateTargetAdvice(targetTime, analysisType);
        }
      }

      const fullAnalysisData = {
        athleteInfo,
        analysisType,
        runMode,
        stepMetrics,
        stepSummary,
        threePhaseAngles,
        distance: distanceValue,
        sectionTime,
        avgSpeed,
        sectionRange,
        usedTargetFps,
        framesCount,
        aiEvaluation,
        targetAdvice,
        timestamp: new Date().toISOString(),
        version: "1.0",
      };

      const metadataPayload = {
        has_ai_evaluation: !!aiEvaluation,
        has_target_advice: !!targetAdvice,
        analysis_type: analysisType,
        athlete_name: athleteInfo?.name || null,
        run_type: runMode,
      };
      
      // 基本データを保存（存在するカラムのみ）
      const payload: any = {
        source_video_name: videoName,
        distance_m,
        section_time_s,
        avg_speed_mps,
        target_fps: usedTargetFps,
        label: labelInput || null,
        notes: notesInput || null,
      };
      
      // オプションカラム（存在する場合のみ追加）
      if (framesCount) payload.frames_count = framesCount;
      if (framesCount) payload.frame_count = framesCount;
      if (sectionRange.start !== null) payload.section_start_frame = sectionRange.start;
      if (sectionRange.end !== null) payload.section_end_frame = sectionRange.end;
      if (section_frame_count) payload.section_frame_count = section_frame_count;
      if (avgStride) payload.avg_stride_m = avgStride;
      if (avgCadence) payload.avg_cadence_hz = avgCadence;
      if (avgContactTime) payload.avg_contact_time_s = avgContactTime;
      if (avgFlightTime) payload.avg_flight_time_s = avgFlightTime;
      if (videoRef.current?.duration) payload.source_video_duration_s = videoRef.current.duration;
      
      // video_filenameカラムが存在する場合
      payload.video_filename = videoName;
      
      // section_typeカラムが存在する場合
      payload.section_start_type = "manual";
      payload.section_end_type = "manual";

      payload.session_data = fullAnalysisData;
      payload.metadata = metadataPayload;

      // まず最小限のデータで保存を試みる
      let sessionData: any = null;
      let sessionError: any = null;
      
      try {
        const result = await supabase
          .from("running_analysis_sessions")
          .insert(payload)
          .select()
          .single();
        
        sessionData = result.data;
        sessionError = result.error;
      } catch (insertError: any) {
        // カラムエラーの場合、最小限のデータで再試行
        if (insertError?.message?.includes("column")) {
          console.warn("一部のカラムが存在しません。基本データのみ保存します。");
          
          const minimalPayload = {
            source_video_name: videoName,
            distance_m,
            section_time_s,
            avg_speed_mps,
            label: labelInput || null,
            notes: notesInput || null,
            session_data: fullAnalysisData,
            metadata: metadataPayload,
          };
          
          const result = await supabase
            .from("running_analysis_sessions")
            .insert(minimalPayload)
            .select()
            .single();
          
          sessionData = result.data;
          sessionError = result.error;
        } else {
          throw insertError;
        }
      }

      if (sessionError) throw sessionError;
      
      const sessionId = (sessionData as any).id;
      
      // ステップメトリクスを保存（別テーブルが存在する場合）
      if (stepMetrics && stepMetrics.length > 0) {
        try {
          const metricsPayload = stepMetrics.map((metric, index) => ({
            session_id: sessionId,
            step_index: index,
            contact_frame: metric.contactFrame,
            toe_off_frame: metric.toeOffFrame,
            next_contact_frame: metric.nextContactFrame,
            contact_time: metric.contactTime,
            flight_time: metric.flightTime,
            step_time: metric.stepTime,
            stride_length: metric.stride,
            speed: metric.speedMps,
          }));
          
          const { error: metricsError } = await supabase
            .from("step_metrics")
            .insert(metricsPayload);
          
          if (metricsError) {
            console.warn("ステップメトリクスの保存に失敗（テーブルが存在しない可能性）:", metricsError);
          }
        } catch (e) {
          console.warn("ステップメトリクスの保存をスキップ:", e);
        }
      }
      
      // 3局面角度データを保存（別テーブルが存在する場合）
      if (threePhaseAngles && threePhaseAngles.length > 0) {
        try {
          const phaseNameMap: Record<PhaseAngles["phase"], string> = {
            initial: "contact",
            mid: "mid_support",
            late: "toe_off",
          };

          const averageValue = (values: Array<number | null | undefined>) => {
            const valid = values.filter(
              (value): value is number => typeof value === "number" && Number.isFinite(value)
            );
            if (!valid.length) {
              return null;
            }
            return valid.reduce((sum, value) => sum + value, 0) / valid.length;
          };

          const normalizeNumeric = (value: number | null | undefined) =>
            typeof value === "number" && Number.isFinite(value) ? value : null;

          const anglesPayload = threePhaseAngles
            .map((entry, idx) => {
              const { stepIndex, phase, frame, angles } = entry;
              const dbStepIndex =
                typeof stepIndex === "number" && Number.isFinite(stepIndex)
                  ? stepIndex
                  : Math.floor(idx / 3);

              return {
                session_id: sessionId,
                step_index: dbStepIndex,
                phase: phaseNameMap[phase] ?? phase,
                frame_number: typeof frame === "number" ? frame : null,
                trunk_angle: normalizeNumeric(angles.trunkAngle),
                hip_angle: normalizeNumeric(
                  averageValue([angles.hipAnkleAngle.left, angles.hipAnkleAngle.right])
                ),
                knee_angle: normalizeNumeric(
                  averageValue([angles.kneeFlex.left, angles.kneeFlex.right])
                ),
                ankle_angle: normalizeNumeric(
                  averageValue([angles.ankleFlex.left, angles.ankleFlex.right])
                ),
                shoulder_angle: null,
                elbow_angle: normalizeNumeric(
                  averageValue([angles.elbowAngle.left, angles.elbowAngle.right])
                ),
              };
            })
            .filter((item) => item.phase && typeof item.step_index === "number");

          if (anglesPayload.length > 0) {
            await supabase.from("three_phase_angles").delete().eq("session_id", sessionId);

            const { error: anglesError } = await supabase
              .from("three_phase_angles")
              .insert(anglesPayload);

            if (anglesError) {
              console.warn(
                "3局面角度データの保存に失敗（テーブルが存在しない可能性）:",
                anglesError
              );
            }
          }
        } catch (e) {
          console.warn("3局面角度データの保存をスキップ:", e);
        }
      }
      
      // ステップサマリーを保存（別テーブルが存在する場合）
      if (stepSummary) {
        try {
          const summaryPayload = {
            session_id: sessionId,
            avg_stride_length: stepSummary.avgStride,
            avg_contact_time: stepSummary.avgContact,
            avg_flight_time: stepSummary.avgFlight,
            avg_speed: stepSummary.avgSpeedMps,
            avg_cadence: avgCadence,
            total_steps: stepMetrics?.length || 0,
          };
          
          const { error: summaryError } = await supabase
            .from("step_summaries")
            .insert(summaryPayload);
          
          if (summaryError) {
            console.warn("ステップサマリーの保存に失敗（テーブルが存在しない可能性）:", summaryError);
          }
        } catch (e) {
          console.warn("ステップサマリーの保存をスキップ:", e);
        }
      }
      
      // session_data とメタデータは初回保存時に含めているため、ここでの追加更新は不要

      setSaveResult(`✅ 保存成功: セッションID=${sessionId}\n詳細データとAIアドバイスも保存されました。`);
    } catch (e: any) {
      console.error("保存エラー詳細:", e);
      // エラーメッセージを分かりやすく
      let errorMsg = "❌ 保存エラー: ";
      if (e.message?.includes("column")) {
        errorMsg += "データベースの構造に問題があります。管理者にお問い合わせください。";
      } else if (e.message?.includes("permission") || e.message?.includes("policy")) {
        errorMsg += "権限エラーです。ログインし直してください。";
      } else if (e.message?.includes("network")) {
        errorMsg += "ネットワークエラーです。接続を確認してください。";
      } else {
        errorMsg += e.message || "不明なエラーが発生しました。";
      }
      setSaveResult(errorMsg);
    } finally {
      setSaving(false);
    }
  };

// ===== 実時間換算用FPS（接地・滞空など） =====
// usedTargetFps があればそれを優先（＝ユーザーが選んだ120/240を保持している想定）
const analysisFps = (usedTargetFps ?? selectedFps ?? 30);
const framesToMs = (frames: number) => (frames * 1000) / analysisFps;
const framesToSec = (frames: number) => frames / analysisFps;

  // ------------ ファイル選択 & リセット ------------
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0] ?? null;

  // ★ まず必ず保存（初回選択でも入る）
  setSourceVideoFile(file);

  // 既存URLがあれば破棄
  if (videoUrl) {
    URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
  }

    framesRef.current = [];
    setFramesCount(0);
    setCurrentFrame(0);
    setExtractProgress(0);
    setUsedTargetFps(null);
    setStatus("");
    setSectionStartFrame(null);
    setSectionMidFrame(null);
    setSectionEndFrame(null);
    setStartLineOffset(0);
    setMidLineOffset(0);
    setEndLineOffset(0);
    setSavedStartHipX(null);
    setSavedMidHipX(null);
    setSavedEndHipX(null);
    // 🎥 パン撮影対応: ピクセル位置もクリア
    setSavedStartPixelX(null);
    setSavedMidPixelX(null);
    setSavedEndPixelX(null);
    setManualContactFrames([]);
    setAutoToeOffFrames([]);
    setCalibrationMode(0);
    setToeOffThreshold(null);
    setBaseThreshold(null);
    setPoseResults([]);

    if (file && file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      setVideoFileSync(file);
      setVideoUrl(url);
      
      // ビデオ要素の事前ロード
      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.load();
      }
    } else {
      setVideoFile(null);
      if (file) {
        alert("mp4 などの動画ファイルを選択してください。");
      }
    }
  };

  // ------------ 動画最適化 ------------
  // Note: 動画最適化はフレーム抽出時に適用されます
  // このステップでは設定のみを行い、実際の処理はhandleExtractFramesで行います

  // ------------ フレーム抽出 ------------
type ExtractFramesOpts = {
  mode?: "single" | "multi";
  file?: File | null;
  url?: string | null;
  fps?: number; // マルチカメラモードで明示的にFPSを指定
  forcedDuration?: number; // マルチカメラモードで強制的にdurationを指定（videoのdurationを無視）
};

const handleExtractFrames = async (opts: ExtractFramesOpts = {}) => {
  console.log("🎬 === Frame Extraction Started ===");
  console.log("🎬 opts:", { file: opts.file?.name, url: opts.url, mode: opts.mode });

  // stateを信じない（stale対策）。引数→stateの順で確定させる
  const mode = opts.mode ?? analysisMode;
  const vf = opts.file ?? videoFile;
  const vu = opts.url ?? videoUrl;
  
  // activeFileは引数から優先的に取得
  const activeFile = opts.file ?? getActiveVideoFile();
  console.log("🎬 activeFile:", activeFile?.name, activeFile?.size);

  // single のときだけ必須チェック（multi は vf/vu を後段で使う）
  if (mode !== "multi" && !vf) {
    alert("動画ファイルを選択してください。");
    return;
  }

  // multi で vf/vu が両方 null の場合はここで止める（原因が明確になる）
  if (mode === "multi" && !vf && !vu) {
    alert("動画ファイルが未設定です。セグメント動画の読み込みを確認してください。");
    return;
  }

  // 以降の処理で使えるように、UI側stateも合わせる（任意だが安全）
  if (mode === "multi" && vf) {
    setVideoFileSync(vf);
    if (vu) {
      setVideoUrl(vu);
    } else {
      // URLが無いならここで作ってセット（後段は vu/vf を使うこと）
      const url = URL.createObjectURL(vf);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    }
  }

  // ★ここから先（3672行目以降）は、いまある処理をそのまま残す

    
    // DOM要素の準備を確認
    let retryCount = 0;
    const maxRetries = 5;
    
    while ((!videoRef.current || !canvasRef.current) && retryCount < maxRetries) {
      console.log(`Waiting for DOM elements... retry ${retryCount + 1}`);
      await new Promise(resolve => setTimeout(resolve, 200));
      retryCount++;
    }
    
    if (!videoRef.current || !canvasRef.current) {
      alert("システムの初期化に失敗しました。もう一度お試しください。");
      setWizardStep(1);
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      alert("キャンバスの初期化に失敗しました。");
      return;
    }

    setIsExtracting(true);
    setExtractProgress(0);
    setStatus("動画情報を読み込んでいます...");

    try {
      await new Promise<void>((resolve, reject) => {
        const onLoaded = async () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("error", onError);
          
          // ビデオサイズが取得できるまで少し待つ（一部のブラウザで必要）
          let actualWidth = video.videoWidth;
          let actualHeight = video.videoHeight;
          let retries = 0;
          
          while ((actualWidth === 0 || actualHeight === 0) && retries < 10) {
            console.log(`⏳ Waiting for video dimensions... retry ${retries + 1}`);
            await new Promise(r => setTimeout(r, 100));
            actualWidth = video.videoWidth;
            actualHeight = video.videoHeight;
            retries++;
          }
          
          console.log(`📹 実際の動画サイズ: ${actualWidth} × ${actualHeight}`);
          console.log(`📹 ビデオ要素の表示サイズ: ${video.width || 'N/A'} × ${video.height || 'N/A'}`);
          
          // サイズが取得できない場合はエラー
          if (actualWidth === 0 || actualHeight === 0) {
            console.error("❌ ビデオサイズが取得できませんでした");
            reject(new Error("動画サイズが取得できません。"));
            return;
          }
          
          // 異常な値の場合は修正
          let correctedWidth = actualWidth;
          let correctedHeight = actualHeight;
          
          // 3840x2160が誤って報告される場合の修正
          // iPhoneやiPadで撮影した動画は誤って4K報告されることがある
          if (actualWidth === 3840 && actualHeight === 2160) {
            const fileSizeMB = (vf?.size ?? activeFile?.size ?? 0) / (1024 * 1024);
            console.log(`📹 ファイルサイズ: ${fileSizeMB.toFixed(2)}MB`);
            
            // 200MB以下は確実にHD動画（4K動画は最低でも300MB以上）
            if (fileSizeMB < 250) {
              console.log(`⚠️ ファイルサイズ ${fileSizeMB.toFixed(0)}MB から判定: HD動画として処理`);
              correctedWidth = 1920;
              correctedHeight = 1080;
            } else {
              // 本当の4K動画
              console.log(`✅ ファイルサイズ ${fileSizeMB.toFixed(0)}MB から判定: 真の4K動画`);
            }
          }
          
          // その他の誤認識パターンも修正
          // 1920x1080なのに高解像度として報告される場合
          if ((actualWidth > 1920 && actualWidth < 3840) || (actualHeight > 1080 && actualHeight < 2160)) {
            console.log(`⚠️ 中途半端な解像度 ${actualWidth}x${actualHeight} → HD動画として処理`);
            correctedWidth = 1920;
            correctedHeight = 1080;
          }
          
          setVideoWidth(correctedWidth);
          setVideoHeight(correctedHeight);
          console.log(`📹 設定された動画サイズ: ${correctedWidth} × ${correctedHeight}`);
          resolve();
        };
        const onError = () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("error", onError);
          reject(new Error("動画の読み込みに失敗しました。"));
        };

        video.addEventListener("loadedmetadata", onLoaded);
        video.addEventListener("error", onError);

       // --- video の入力ソースを確定（multi は state が間に合わないことがあるのでここで確実に作る） ---
      // 優先順位: opts.url > vu > videoUrl > activeFile から作成
      let srcUrl: string | null = opts.url ?? vu ?? videoUrl ?? null;

      // videoUrl がまだ state に乗っていない / クリアされた場合でも、File が取れればここで必ず復元する
      if (!srcUrl && activeFile) {
        console.log("🎬 Creating new URL from activeFile:", activeFile.name);
        const created = URL.createObjectURL(activeFile);
        srcUrl = created;

        // 古い blob URL が残っているとメモリリークするので revoke して差し替え
        setVideoUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return created;
        });
      }

      if (!srcUrl) {
        console.error("⚠️ active video source is missing", {
          mode,
          opts_url: opts.url,
          vu,
          videoUrl,
          hasActiveFile: !!activeFile,
          hasOptsFile: !!opts.file,
        });
        setStatus("⚠️ 動画ファイルが未設定です。セグメント動画の読み込みを確認してください。");
        alert("動画ファイルを選択してください。");
        setIsExtracting(false);
        return;
      }

      console.log("🎬 Setting video.src:", srcUrl);
      video.src = srcUrl;


      });
    } catch (err) {
      console.error(err);
      setIsExtracting(false);
      setStatus("❌ 動画の読み込みに失敗しました。");
      alert("動画の読み込みに失敗しました。別のファイルを選択してください。");
      setWizardStep(1);
      return;
    }

    if (!video.videoWidth || !video.videoHeight) {
      setIsExtracting(false);
      setStatus("❌ 動画サイズが取得できません。");
      return;
    }

    // デバイス検出（モバイルかどうか）
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    
    // 動画サイズとデバイスに応じた制限設定
    const videoSizeMB = (video.videoWidth * video.videoHeight * video.duration * 24) / (1024 * 1024);
    console.log(`📹 Video info: ${video.videoWidth}x${video.videoHeight}, duration: ${video.duration.toFixed(2)}s, estimated size: ${videoSizeMB.toFixed(1)}MB`);
    console.log(`📱 Device: ${isMobile ? 'Mobile' : 'Desktop'}, iOS: ${isIOS}`);

    const duration = opts.forcedDuration ?? video.duration;
    if (opts.forcedDuration) {
      console.log(`🔴 FORCING DURATION: ${opts.forcedDuration}s (ignoring video.duration=${video.duration}s)`);
    }
    
    // 🔧 デバイスに応じたメモリ制限（メモリ問題対策で厳しめに設定）
    let MAX_FRAMES: number;
    let MAX_WIDTH: number;
    let preferredFps: number;
    
    if (isIOS) {
      // iOS（iPhone/iPad）: メモリ制限が厳しいため、控えめに設定
      MAX_FRAMES = 300; // 🔧 60fps × 5秒 or 120fps × 2.5秒（メモリ節約）
      MAX_WIDTH = 640;  // 🔧 SD品質（メモリ節約）
      preferredFps = selectedFps;
      console.log(`📱 iOS detected: ${selectedFps}fps mode (640px, max 300 frames - memory optimized)`);
    } else if (isMobile) {
      // その他のモバイル（Android等）: やや厳しめに設定
      MAX_FRAMES = 400; // 🔧 60fps × 6.7秒 or 120fps × 3.3秒
      MAX_WIDTH = 720;  // 🔧 HD品質（メモリ節約）
      preferredFps = selectedFps;
      console.log(`📱 Mobile detected: ${selectedFps}fps mode (720px, max 400 frames - memory optimized)`);
    } else {
      // デスクトップ: 比較的余裕があるが、大きな動画には注意
      MAX_FRAMES = 600;   // 🔧 60fps × 10秒 or 120fps × 5秒
      MAX_WIDTH = 1280;   // 🔧 HD品質
      preferredFps = selectedFps;
      console.log(`💻 Desktop detected: ${selectedFps}fps mode (1280px, max 600 frames)`);
    }
    
    // ユーザーが選択したFPSを使用
    const detectedFps = preferredFps;
    let confirmedFps = detectedFps;
    
    // 120fps以下は自動処理（アラート不要）
    if (detectedFps <= 120) {
      confirmedFps = detectedFps;
      console.log(`✅ Auto-detected FPS: ${confirmedFps}fps (no prompt for ≤120fps)`);
    } else {
      // 240fpsなど高フレームレートの場合のみ確認
      const userFpsInput = prompt(
        `高フレームレート動画が検出されました。\n\n` +
        `検出された値: ${detectedFps}fps\n` +
        `一般的な値: 30fps, 60fps, 120fps, 240fps\n\n` +
        `※ 正確なFPSを入力することで、解析精度が向上します。`,
        detectedFps.toString()
      );
      
      if (userFpsInput) {
        const parsed = parseInt(userFpsInput);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 240) {
          confirmedFps = parsed;
          console.log(`✅ User confirmed FPS: ${confirmedFps}fps`);
        } else {
          console.warn(`⚠️ Invalid FPS input: ${userFpsInput}, using default: ${detectedFps}fps`);
        }
      }
    }
    
    
  const maxFpsForLength = Math.floor(MAX_FRAMES / Math.max(duration, 0.001));

// ✅ analysisFps（接地・滞空など“時間換算”用）＝ユーザーが選択/確認したFPS
const targetFps = Number((opts.fps ?? confirmedFps ?? selectedFps) ?? 30) || 30;
setUsedTargetFps(targetFps);
console.log(`🎯 Target FPS set to: ${targetFps} (opts.fps=${opts.fps}, confirmedFps=${confirmedFps}, selectedFps=${selectedFps})`);

const analysisFpsLocal = targetFps;
const framesToMsLocal = (f: number) => (f * 1000) / analysisFpsLocal;
const framesToSecLocal = (f: number) => f / analysisFpsLocal;


// ✅ マルチカメラモードでは、targetFpsを強制使用（parseMedia解析をスキップ）
let totalFrames: number;
let seekDt: number;
let extractFps: number;

// ✅ マルチカメラモードでもparseMediaを実行して実際のFPSを取得
let detectedFileFps: number | null = null;

if (mode === "multi" && vf) {
  console.log(`🔴 MULTI-CAMERA MODE: Detecting actual FPS...`);
  console.log(`🔴 duration=${duration}s, targetFps=${targetFps}, opts.fps=${opts.fps}`);
  
  try {
    const r = await parseMedia({
      src: vf,
      acknowledgeRemotionLicense: true,
      fields: {
        slowNumberOfFrames: true,
        slowDurationInSeconds: true,
      },
    });
    
    const frames = Math.max(1, r.slowNumberOfFrames);
    const dur = Math.max(0.001, r.slowDurationInSeconds);
    detectedFileFps = frames / dur;
    
    console.log(`📊 Detected file FPS: ${detectedFileFps.toFixed(2)} (${frames} frames / ${dur.toFixed(2)}s)`);
  } catch (err) {
    console.warn(`⚠️ parseMedia failed for multi-camera, using fallback`, err);
  }
}

if (mode === "multi") {
  // 🔴 CRITICAL FIX: 実際のコンテナFPSに基づいて補正を決定
  // タイプA（スロー焼き込み）: fileFps=30 → duration × 30 でフレーム数計算
  // タイプB（オリジナル高FPS）: fileFps=120 → duration × 120 でフレーム数計算
  
  if (detectedFileFps !== null) {
    // ✅ 実際のFPSを検出できた場合
    const isSlowBaked = detectedFileFps < 40; // 30fps前後 → スロー焼き込み
    
    if (isSlowBaked) {
      // タイプA: スロー焼き込み（30fps container）
      console.log(`🔴 TYPE A: Slow-motion baked (fileFps=${detectedFileFps.toFixed(2)})`);
      console.log(`  - Using fileFps as extractFps`);
      totalFrames = Math.floor(duration * detectedFileFps);
      seekDt = 1 / detectedFileFps;
      extractFps = detectedFileFps;
    } else {
      // タイプB: オリジナル高FPS（120fps container）
      console.log(`🔴 TYPE B: Original high FPS (fileFps=${detectedFileFps.toFixed(2)})`);
      console.log(`  - Using targetFps=${targetFps} for analysis`);
      totalFrames = Math.floor(duration * targetFps);
      seekDt = 1 / targetFps;
      extractFps = targetFps;
    }
    
    console.log(`🔴 RESULT: totalFrames=${totalFrames}, seekDt=${seekDt.toFixed(5)}, extractFps=${extractFps}`);
  } else {
    // ⚠️ FPS検出失敗時のフォールバック
    console.warn(`⚠️ Could not detect FPS, using targetFps=${targetFps}`);
    totalFrames = Math.floor(duration * targetFps);
    seekDt = 1 / targetFps;
    extractFps = targetFps;
  }
} else {
  // 🔴 SINGLE-CAMERA MODE: Use same TYPE A/B detection as multi-camera
  totalFrames = Math.max(1, Math.floor(duration * 30)); // フォールバック
  seekDt = 1 / 30;
  extractFps = 30;

  // マルチカメラモードではvf（opts.file）を使用、シングルモードではsourceVideoFileを使用
  const fileToAnalyze = vf ?? sourceVideoFile;

  console.log(`🔧 DEBUG: vf=${vf?.name}, sourceVideoFile=${sourceVideoFile?.name}, fileToAnalyze=${fileToAnalyze?.name}`);

  if (fileToAnalyze) {
    console.log(`🔍 Analyzing video file: ${fileToAnalyze.name} (${(fileToAnalyze.size / 1024 / 1024).toFixed(2)}MB)`);
    
    try {
      const r = await parseMedia({
      src: fileToAnalyze,
      acknowledgeRemotionLicense: true, 
      fields: {
        slowNumberOfFrames: true,
        slowDurationInSeconds: true,
        metadata: true,
      },
    });

  console.log("🎞 parseMedia:", {
  slowFps: (r as any).slowFps,
  slowNumberOfFrames: (r as any).slowNumberOfFrames,
  slowDurationInSeconds: (r as any).slowDurationInSeconds,
  fps: (r as any).fps,
  durationInSeconds: (r as any).durationInSeconds,
});

console.log(
  "📎 metadata keys (first 40):",
  (r as any).metadata?.slice(0, 40)?.map((m: any) => [m.key, m.value])
);

console.log(
  "📎 metadata filter frame:",
  (r as any).metadata?.filter((m: any) =>
    String(m.key).toLowerCase().includes("frame")
  )
);

  const frames = Math.max(1, r.slowNumberOfFrames);
  const dur = Math.max(0.001, r.slowDurationInSeconds);

  // ファイル上のフレーム数とFPS
  const fileFrames = frames;
  const fileFps = frames / dur;
  
  console.log(`📊 File metadata: frames=${fileFrames}, duration=${dur.toFixed(2)}s, fileFps=${fileFps.toFixed(2)}`);

  // 🔴 CRITICAL FIX: Same TYPE A/B detection logic as multi-camera mode
  // TYPE A (Slow-baked): fileFps=30 → calculate frames with fileFps
  // TYPE B (Original high FPS): fileFps=120 → calculate frames with targetFps
  
  const isSlowBaked = fileFps < 40; // 30fps前後 → スロー焼き込み
  
  if (isSlowBaked) {
    // タイプA: スロー焼き込み（30fps container）
    console.log(`🟢 SINGLE-CAM TYPE A: Slow-motion baked (fileFps=${fileFps.toFixed(2)})`);
    console.log(`  - Container duration: ${duration}s`);
    console.log(`  - Using fileFps (${fileFps.toFixed(2)}) for extraction`);
    totalFrames = Math.floor(duration * fileFps);
    seekDt = 1 / fileFps;
    extractFps = fileFps;
  } else {
    // タイプB: オリジナル高FPS（120fps container）
    console.log(`🟢 SINGLE-CAM TYPE B: Original high FPS (fileFps=${fileFps.toFixed(2)})`);
    console.log(`  - Container duration: ${duration}s`);
    console.log(`  - Using targetFps (${targetFps}) for analysis`);
    totalFrames = Math.floor(duration * targetFps);
    seekDt = 1 / targetFps;
    extractFps = targetFps;
  }

  console.log(
    `🎬 SINGLE-CAM RESULT: analysisFps=${targetFps} / extractFps=${extractFps.toFixed(2)} / totalFrames=${totalFrames} / isSlowBaked=${isSlowBaked}`
  );

    } catch (error) {
      console.error('❌ parseMedia failed:', error);
      console.log('⚠️ Falling back to default frame extraction (30fps × duration)');
      // フォールバック：デフォルト値を使用
    }
  } else {
    console.warn('⚠️ No file to analyze! Using fallback: totalFrames = duration * 30');
  }
}

console.log(`🎬 Video specs: analysisFps=${targetFps}fps, extractFrames=${totalFrames}, duration=${duration.toFixed(2)}s`);

// ✅ 重すぎる時は fps を落とすのではなく「警告して中止」
if (totalFrames > MAX_FRAMES) {
  const ok = confirm(
    `⚠️ 動画が長いため、抽出フレーム数が ${totalFrames} になります。\n` +
      `iPhoneではメモリ不足になる可能性があります。\n\n` +
      `接地マーク精度のため analysisFps は落とさず、抽出はこのフレーム数で続行しますか？\n\n` +
      `（重い場合は、解析区間を短くする / 解像度を下げる を推奨）`
  );
  if (!ok) return;
}


setUsedTargetFps(targetFps);


    // 4K動画の検出と確認（保存された補正済みの解像度を使用）
    const actualVideoWidth = videoWidth || video.videoWidth;
    const actualVideoHeight = videoHeight || video.videoHeight;
    
    console.log(`🎬 動画解像度確認: ${actualVideoWidth}x${actualVideoHeight}`);
    console.log(`🎬 HD判定: ${actualVideoWidth === 1920 && actualVideoHeight === 1080 ? 'HD (1920x1080)' : 
                 actualVideoWidth === 1280 && actualVideoHeight === 720 ? 'HD (1280x720)' : 
                 '他の解像度'}`);
    const is4K = actualVideoWidth >= 3840 && actualVideoHeight >= 2160;
    console.log(`🎬 4K判定結果: ${is4K ? '4K動画' : '非4K動画'}`);
    const is240Fps = targetFps >= 240;
    
    let scale = Math.min(1, MAX_WIDTH / actualVideoWidth);
    
    // 4K動画または240fpsの場合のみ確認（120fps以下は自動処理）
    if (is4K && !isMobile) {
      const fullResMemoryMB = (actualVideoWidth * actualVideoHeight * totalFrames * 4) / (1024 * 1024);
      const scaledMemoryMB = (MAX_WIDTH * (actualVideoHeight * MAX_WIDTH / actualVideoWidth) * totalFrames * 4) / (1024 * 1024);
      
      console.log(`📹 4K video detected: ${actualVideoWidth}x${actualVideoHeight}`);
      console.log(`💾 Full resolution would use: ${fullResMemoryMB.toFixed(0)}MB`);
      console.log(`💾 Scaled to ${MAX_WIDTH}px would use: ${scaledMemoryMB.toFixed(0)}MB`);
      
      if (confirm(`4K動画が検出されました（${actualVideoWidth}x${actualVideoHeight}）\n\nフル解像度で処理しますか？\n\n「OK」: フル解像度（${fullResMemoryMB.toFixed(0)}MB使用、高精度）\n「キャンセル」: ${MAX_WIDTH}pxにスケール（${scaledMemoryMB.toFixed(0)}MB使用、推奨）`)) {
        scale = 1; // フル解像度
        console.log('✅ Processing at full 4K resolution');
      } else {
        console.log(`✅ Scaling to ${MAX_WIDTH}px for performance`);
      }
    }
    
    const targetWidth = Math.round(actualVideoWidth * scale);
    const targetHeight = Math.round(actualVideoHeight * scale);
    
    // メモリ使用量の推定と警告
    const estimatedMemoryMB = (targetWidth * targetHeight * totalFrames * 4) / (1024 * 1024);
    console.log(`💾 Estimated memory usage: ${estimatedMemoryMB.toFixed(1)}MB for ${totalFrames} frames at ${targetWidth}x${targetHeight}`);
    console.log(`📊 Video specs: ${targetFps}fps, ${totalFrames} frames, ${duration.toFixed(2)}s`);
    
    // 240fps動画の警告（120fps以下は警告不要）
    if (is240Fps && estimatedMemoryMB > 500) {
      console.warn(`⚠️ Very high FPS video (${targetFps}fps) with large memory usage`);
      if (!confirm(`超高フレームレート動画（${targetFps}fps）が検出されました。\nメモリ使用量: 約${estimatedMemoryMB.toFixed(0)}MB\n\n処理には時間がかかる場合があります。続行しますか？`)) {
        setIsExtracting(false);
        setStatus("キャンセルされました");
        return;
      }
    }
    
    if (isIOS && estimatedMemoryMB > 200) {
      console.warn('⚠️ High memory usage detected on iOS. May cause crash.');
      if (!confirm(`この動画の処理には約${estimatedMemoryMB.toFixed(0)}MBのメモリが必要です。\niPhoneでは処理中にクラッシュする可能性があります。\n\n続行しますか？`)) {
        setIsExtracting(false);
        setStatus("キャンセルされました");
        return;
      }
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    framesRef.current = [];
    setFramesCount(0);
    setCurrentFrame(0);

    setStatus(
      `フレーム抽出中... 長さ ${duration.toFixed(2)} 秒, fps ≒ ${targetFps}`
    );

    let index = 0;

    // Promise でラップして、フレーム抽出の完了を await できるようにする
    return new Promise<void>((resolveExtraction, rejectExtraction) => {
      const grabFrame = () => {
        if (index >= totalFrames) {
          setIsExtracting(false);
          setExtractProgress(100);
          setFramesCount(framesRef.current.length);
          setCurrentFrame(0);
          setStatus(`✅ フレーム抽出完了（${framesRef.current.length} フレーム）`);
          console.log(`✅ フレーム抽出完了: ${framesRef.current.length}フレーム`);
          
          // マルチカメラモードの場合は、ここでは何もせず、呼び出し元に制御を返す
          // （loadMultiCameraSegment が次の処理を行う）
          if (mode === "multi") {
            console.log('📹 Multi-camera mode: Extraction complete, returning control to loadMultiCameraSegment');
            resolveExtraction(); // フレーム抽出完了を通知
            return;
          }
          
          // シングルカメラモード
          setTimeout(async () => {
            // パーン撮影モードの場合は姿勢推定をスキップしてスプリットタイマーへ
            if (analysisMode === 'panning') {
              console.log('📹 Panning mode: Skipping pose estimation, going to split timer...');
              setWizardStep(7);
              resolveExtraction();
              return;
            }
            
            // 固定カメラモードの場合は姿勢推定を実行
            console.log('📹 Fixed camera mode: Starting pose estimation...');
            setWizardStep(4);
            await runPoseEstimation();
            resolveExtraction(); // フレーム抽出完了を通知
          }, 1000);
          return;
        }

      const currentTime = index * seekDt;

      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);

        requestAnimationFrame(() => {
          try {
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            
            const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
            framesRef.current.push(imageData);

            const progress = Math.round(((index + 1) / totalFrames) * 100);
            setExtractProgress(clamp(progress, 0, 99));
            setStatus(`フレーム抽出中... ${index + 1}/${totalFrames} フレーム`);

            index += 1;
            grabFrame();
          } catch (error) {
            // メモリエラーをキャッチしてクラッシュを防ぐ
            console.error('❌ Frame extraction error:', error);
            setIsExtracting(false);
            setStatus(`⚠️ フレーム抽出中にエラーが発生しました（${index}/${totalFrames}フレームまで処理）`);
            
            // エラーが発生しても、それまでに抽出したフレームは使用可能にする
            if (framesRef.current.length > 0) {
              setFramesCount(framesRef.current.length);
              setCurrentFrame(0);
              alert(`メモリ不足のため、${index}フレームまでで処理を中断しました。\n抽出済みの${framesRef.current.length}フレームは使用できます。\n\nより短い動画や低解像度の動画をお試しください。`);
              resolveExtraction(); // 部分的に完了として通知
            } else {
              alert('フレーム抽出中にエラーが発生しました。\nより短い動画や低解像度の動画をお試しください。');
              setWizardStep(1);
              rejectExtraction(error); // エラーを通知
            }
          }
        });
      };

      const onSeekError = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onSeekError);
        console.error('❌ Video seek error at frame', index);
        
        // シークエラーの場合もクラッシュを防ぐ
        setIsExtracting(false);
        setStatus(`⚠️ 動画シークエラー（${index}/${totalFrames}フレーム）`);
        
        if (framesRef.current.length > 0) {
          setFramesCount(framesRef.current.length);
          setCurrentFrame(0);
          alert(`動画の読み込み中にエラーが発生しました。\n抽出済みの${framesRef.current.length}フレームは使用できます。`);
          resolveExtraction(); // 部分的に完了として通知
        } else {
          alert('動画の読み込み中にエラーが発生しました。\n別の動画ファイルをお試しください。');
          setWizardStep(1);
          rejectExtraction(new Error('Video seek error')); // エラーを通知
        }
      };

      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onSeekError);
      video.currentTime = clamp(currentTime, 0, duration);
    };

      // フレーム抽出開始
      console.log('🎬 Starting grabFrame loop...');
      grabFrame();
    }); // Promise の終わり
  };

  // ------------ 腰の位置を計算するヘルパー関数 ------------
  const calculateHipPosition = (frameIndex: number): number | null => {
    console.log(`🔍 calculateHipPosition called: frameIndex=${frameIndex}, poseResults.length=${poseResults.length}`);
    
    // poseResults全体のサマリーを表示（初回のみ）
    if (frameIndex >= 0) {
      let validCount = 0;
      let nullCount = 0;
      let noLandmarksCount = 0;
      
      for (let i = 0; i < Math.min(poseResults.length, 100); i++) {
        const p = poseResults[i];
        if (p === null || p === undefined) {
          nullCount++;
        } else if (!p.landmarks) {
          noLandmarksCount++;
        } else {
          validCount++;
        }
      }
      
      console.log(`📊 PoseResults summary (first 100 frames):`);
      console.log(`  - Valid poses with landmarks: ${validCount}`);
      console.log(`  - Null/undefined poses: ${nullCount}`);
      console.log(`  - Poses without landmarks: ${noLandmarksCount}`);
    }
    
    if (poseResults.length === 0 || frameIndex >= poseResults.length || frameIndex < 0) {
      console.log(`⚠️ calculateHipPosition: Invalid frame ${frameIndex} (poseResults.length=${poseResults.length})`);
      return null;
    }
    
    // まず指定されたフレームを試す
    const tryGetHipPosition = (idx: number): number | null => {
      if (idx < 0 || idx >= poseResults.length) return null;
      
      const pose = poseResults[idx];
      
      // デバッグ: poseオブジェクトの詳細を確認
      if (idx === frameIndex) {
        console.log(`🔍 Detailed check for frame ${idx}:`);
        console.log(`  - pose is null: ${pose === null}`);
        console.log(`  - pose is undefined: ${pose === undefined}`);
        console.log(`  - typeof pose: ${typeof pose}`);
        if (pose) {
          console.log(`  - pose has landmarks: ${'landmarks' in pose}`);
          console.log(`  - landmarks value:`, pose.landmarks);
          if (pose.landmarks) {
            console.log(`  - landmarks.length: ${pose.landmarks.length}`);
            console.log(`  - landmarks[23] (leftHip):`, pose.landmarks[23]);
            console.log(`  - landmarks[24] (rightHip):`, pose.landmarks[24]);
          }
        }
      }
      
      if (!pose?.landmarks) return null;
      
      const leftHip = pose.landmarks[23];
      const rightHip = pose.landmarks[24];
      
      if (!leftHip || !rightHip || leftHip.visibility < 0.3 || rightHip.visibility < 0.3) { // 🔥 閾値を下げて検出率向上
        if (idx === frameIndex) {
          console.log(`  - Hip visibility too low or missing: L=${leftHip?.visibility}, R=${rightHip?.visibility}`);
        }
        return null;
      }
      
      const hipCenterX = (leftHip.x + rightHip.x) / 2;
      return hipCenterX;
    };
    
    // 指定されたフレームで試す
    let hipX = tryGetHipPosition(frameIndex);
    if (hipX !== null) {
      console.log(`✅ calculateHipPosition: Frame ${frameIndex} → hipX=${(hipX * 100).toFixed(1)}%`);
      return hipX;
    }
    
    console.log(`⚠️ Frame ${frameIndex} has no valid hip data, searching nearby frames...`);
    
    // 前後±20フレームを探索（モバイルでは姿勢推定失敗が多いため範囲を拡大）
    const searchRange = 20;
    for (let offset = 1; offset <= searchRange; offset++) {
      // 前方を探索
      const prevIdx = frameIndex - offset;
      hipX = tryGetHipPosition(prevIdx);
      if (hipX !== null) {
        console.log(`✅ calculateHipPosition: Using frame ${prevIdx} (offset: ${-offset}) → hipX=${(hipX * 100).toFixed(1)}%`);
        return hipX;
      }
      
      // 後方を探索
      const nextIdx = frameIndex + offset;
      hipX = tryGetHipPosition(nextIdx);
      if (hipX !== null) {
        console.log(`✅ calculateHipPosition: Using frame ${nextIdx} (offset: +${offset}) → hipX=${(hipX * 100).toFixed(1)}%`);
        return hipX;
      }
    }
    
    console.log(`❌ calculateHipPosition: No valid hip data found within ±${searchRange} frames of ${frameIndex}`);
    return null;
  };

  // ------------ 区間マーカー線を描画 ------------
  // 接地/離地マーカーを描画（交互に色を変える）
  const drawContactMarkers = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    currentFrameNum: number
  ) => {
    // キャンバス上のマーカー描画は不要（コントロール下のエリアに表示）
    // 空の関数として残す
  };

  const drawSectionMarkers = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    currentFrameNum: number,
    viewParams?: { srcX: number; srcY: number; srcW: number; srcH: number; scale: number }
  ) => {
    const markers = [
      { frame: sectionStartFrame, color: "#10b981", label: "スタート", offset: startLineOffset, savedHipX: savedStartHipX, savedPixelX: savedStartPixelX },
      { frame: sectionMidFrame, color: "#f59e0b", label: "中間", offset: midLineOffset, savedHipX: savedMidHipX, savedPixelX: savedMidPixelX },
      { frame: sectionEndFrame, color: "#ef4444", label: "フィニッシュ", offset: endLineOffset, savedHipX: savedEndHipX, savedPixelX: savedEndPixelX },
    ];

    markers.forEach(({ frame, color, label, offset, savedHipX, savedPixelX }) => {
      // フレームが設定されていない場合はスキップ
      if (frame == null) return;
      
      // ✅ 改善: 現在のフレームと一致する場合のみ表示（確定後は消える）
      if (currentFrameNum !== frame) return;

      let torsoX: number;
      let fromPose = false;
      
      // 🎥 パン撮影モード: 現在のフレームの腰位置をリアルタイムで取得
      if (isPanMode) {
        // 姿勢推定データから現在フレームの腰位置を取得
        const hipX = calculateHipPosition(frame);
        if (hipX !== null) {
          torsoX = hipX * width;
          fromPose = true;
          console.log(`🎥 [${label}] Pan mode: Using current frame hip position: ${(hipX * 100).toFixed(1)}% → ${torsoX.toFixed(0)}px`);
        } else {
          // 姿勢推定データがない場合は保存されたピクセル位置を使用
          if (savedPixelX !== null) {
            torsoX = savedPixelX;
            console.log(`🎥 [${label}] Pan mode: Using saved pixel position (no pose): ${torsoX.toFixed(0)}px`);
          } else {
            torsoX = width / 2;
            console.log(`📍 [${label}] Pan mode: No data, using center: ${torsoX.toFixed(0)}px`);
          }
        }
      } else if (savedHipX !== null) {
        // 固定カメラモード: 腰の位置を使用（従来通り）
        if (viewParams) {
          // 拡大表示時の座標変換
          const origX = savedHipX * width;
          const relX = origX - viewParams.srcX;
          torsoX = (relX / viewParams.srcW) * width;
        } else {
          // 通常表示
          torsoX = savedHipX * width;
        }
        fromPose = true;
        console.log(`📌 [${label}] Fixed camera: Using saved hip position: ${(savedHipX * 100).toFixed(1)}% → ${torsoX.toFixed(0)}px`);
      } else {
        // 保存された位置がない場合はデフォルト（センター）
        torsoX = width / 2;
        console.log(`📍 [${label}] No saved position, using center: ${torsoX.toFixed(0)}px`);
      }
      
      // 手動オフセットを適用
      const finalX = torsoX + offset;
      console.log(`📐 [${label}] Frame ${frame}: Final position: ${finalX.toFixed(0)} (base=${torsoX.toFixed(0)} + offset=${offset})`);

      // 画面内に収まるように調整
      const clampedX = Math.max(20, Math.min(width - 20, finalX));

      // 垂直線を描画（太く目立つように）
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;  // 3 → 8に変更（より太く）
      ctx.setLineDash([15, 8]);  // 破線も大きく
      ctx.beginPath();
      ctx.moveTo(clampedX, height);
      ctx.lineTo(clampedX, 0);
      ctx.stroke();
      ctx.setLineDash([]);

      // ラベルの背景（より大きく目立つように）
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.font = "bold 18px sans-serif";  // 14px → 18px
      const textWidth = ctx.measureText(label).width;
      ctx.fillRect(clampedX - textWidth / 2 - 10, 8, textWidth + 20, 32);  // より大きく
      
      // ラベルを描画
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(label, clampedX, 30);
      
      // 姿勢推定からの位置かどうかのインジケーター
      if (!fromPose) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
        ctx.font = "10px sans-serif";
        ctx.fillText("手動", clampedX, 45);
      }
    });
  };

  // ------------ 現在フレームの描画 ------------
  useEffect(() => {
    const canvas = displayCanvasRef.current;
    const frames = framesRef.current;
    if (!canvas || !frames.length) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const idx = clamp(currentFrame, 0, frames.length - 1);
    const frame = frames[idx];

    // フレームが存在しない場合は描画をスキップ
    if (!frame || !frame.width || !frame.height) {
      console.warn(`⚠️ フレーム ${idx} が存在しないか無効です`);
      return;
    }

    const w = frame.width;
    const h = frame.height;

    const offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;
    offCtx.putImageData(frame, 0, 0);

    // キャンバスサイズを動画サイズに設定（ChatGPT推奨: 座標系の統一）
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    
    // デバイス判定
    const isIPad = /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    if (isIPad) {
      // iPadの場合: CSSサイズを削除してブラウザに任せる
      canvas.style.width = '';
      canvas.style.height = '';
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '40vh';
      // アスペクト比を保持
      canvas.style.objectFit = 'contain';
    } else {
      // PC/その他の場合: 従来通りCSSサイズを計算
      const containerWidth = canvas.parentElement?.clientWidth || window.innerWidth;
      const containerHeight = window.innerHeight * 0.4;
      
      const videoAspectRatio = w / h;
      const containerAspectRatio = containerWidth / containerHeight;
      
      let displayWidth, displayHeight;
      
      if (videoAspectRatio > containerAspectRatio) {
        displayWidth = containerWidth;
        displayHeight = containerWidth / videoAspectRatio;
      } else {
        displayHeight = containerHeight;
        displayWidth = containerHeight * videoAspectRatio;
      }
      
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '40vh';
    }

    if (!footZoomEnabled) {
      ctx.drawImage(offscreen, 0, 0, w, h, 0, 0, w, h);

      if (showSkeleton && poseResults[idx]?.landmarks) {
        drawSkeleton(ctx, poseResults[idx]!.landmarks, w, h);
      }
      
      // 区間マーカー線を描画
      drawSectionMarkers(ctx, w, h, currentFrame);
      
      // 接地/離地マーカーを描画
      drawContactMarkers(ctx, w, h, currentFrame);
    } else {
      let footCenterY = 0.75;
      let footCenterX = 0.5;

      if (poseResults[idx]?.landmarks) {
        const landmarks = poseResults[idx]!.landmarks;
        const leftAnkle = landmarks[27];
        const rightAnkle = landmarks[28];
        const leftFoot = landmarks[31];
        const rightFoot = landmarks[32];

        let validPoints = 0;
        let sumX = 0;
        let sumY = 0;

        if (leftAnkle.visibility > 0.5) {
          sumX += leftAnkle.x;
          sumY += leftAnkle.y;
          validPoints++;
        }
        if (rightAnkle.visibility > 0.5) {
          sumX += rightAnkle.x;
          sumY += rightAnkle.y;
          validPoints++;
        }

        if (validPoints > 0) {
          footCenterX = sumX / validPoints;
          footCenterY = sumY / validPoints;

          let footValidPoints = 0;
          let footSumY = 0;

          if (leftFoot.visibility > 0.5) {
            footSumY += leftFoot.y;
            footValidPoints++;
          }
          if (rightFoot.visibility > 0.5) {
            footSumY += rightFoot.y;
            footValidPoints++;
          }

          if (footValidPoints > 0) {
            const avgFootY = footSumY / footValidPoints;
            footCenterY = footCenterY * 0.7 + avgFootY * 0.3;
          }
        }
      }

      const srcW = w / zoomScale;
      const srcH = h / zoomScale;

      let srcX = footCenterX * w - srcW / 2;
      let srcY = footCenterY * h - srcH / 2;

      srcX = clamp(srcX, 0, w - srcW);
      srcY = clamp(srcY, 0, h - srcH);

      ctx.drawImage(offscreen, srcX, srcY, srcW, srcH, 0, 0, w, h);

      if (showSkeleton && poseResults[idx]?.landmarks) {
        const landmarks = poseResults[idx]!.landmarks;

        ctx.strokeStyle = "#00ff00";  // より見やすい緑色
        ctx.lineWidth = 5;  // 3 → 5に変更（より太く）

        const connections: [number, number][] = [
          [11, 12],
          [11, 13],
          [13, 15],
          [12, 14],
          [14, 16],
          [11, 23],
          [12, 24],
          [23, 24],
          [23, 25],
          [25, 27],
          [27, 31],
          [24, 26],
          [26, 28],
          [28, 32],
        ];

        const transformPoint = (lm: { x: number; y: number }) => {
          const origX = lm.x * w;
          const origY = lm.y * h;

          const relX = origX - srcX;
          const relY = origY - srcY;

          const canvasX = (relX / srcW) * w;
          const canvasY = (relY / srcH) * h;

          return { x: canvasX, y: canvasY };
        };

        connections.forEach(([a, b]) => {
          const pointA = landmarks[a];
          const pointB = landmarks[b];

          if (pointA.visibility > 0.5 && pointB.visibility > 0.5) {
            const transA = transformPoint(pointA);
            const transB = transformPoint(pointB);

            if (
              transA.x >= -10 &&
              transA.x <= w + 10 &&
              transA.y >= -10 &&
              transA.y <= h + 10 &&
              transB.x >= -10 &&
              transB.x <= w + 10 &&
              transB.y >= -10 &&
              transB.y <= h + 10
            ) {
              ctx.beginPath();
              ctx.moveTo(transA.x, transA.y);
              ctx.lineTo(transB.x, transB.y);
              ctx.stroke();
            }
          }
        });

        ctx.fillStyle = "#f97316";
        const POINT_CONFIDENCE_THRESHOLD = 0.15; // 🔥 姿勢認識率向上のため低めに設定
        landmarks.forEach((lm: FramePoseData["landmarks"][number]) => {
          if (lm.visibility > POINT_CONFIDENCE_THRESHOLD) {
            const trans = transformPoint(lm);

            if (
              trans.x >= -10 &&
              trans.x <= w + 10 &&
              trans.y >= -10 &&
              trans.y <= h + 10
            ) {
              ctx.beginPath();
              ctx.arc(trans.x, trans.y, 6, 0, 2 * Math.PI);
              ctx.fill();
            }
          }
        });
        
        // 🎯 足元拡大ビュー: 大転子から垂直線を描画し、つま先までの水平距離を表示（cm単位）
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];
        const leftKnee = landmarks[25];
        const rightKnee = landmarks[26];
        const leftToe = landmarks[31];
        const rightToe = landmarks[32];
        
        if (leftHip.visibility > POINT_CONFIDENCE_THRESHOLD && rightHip.visibility > POINT_CONFIDENCE_THRESHOLD) {
          // 大腿長を計算（cm換算用の基準）
          const ASSUMED_THIGH_LENGTH_CM = 50;
          const leftThighLength = Math.sqrt(
            Math.pow(leftKnee.x - leftHip.x, 2) + Math.pow(leftKnee.y - leftHip.y, 2)
          );
          const rightThighLength = Math.sqrt(
            Math.pow(rightKnee.x - rightHip.x, 2) + Math.pow(rightKnee.y - rightHip.y, 2)
          );
          const avgThighLength = (leftThighLength + rightThighLength) / 2;
          
          // 大転子中心を変換
          const hipCenterNorm = { 
            x: (leftHip.x + rightHip.x) / 2, 
            y: (leftHip.y + rightHip.y) / 2 
          };
          const hipCenterTrans = transformPoint(hipCenterNorm);
          
          // 垂直線を描画（大転子から下方向）
          ctx.strokeStyle = "#dc2626"; // 赤色
          ctx.lineWidth = 4;
          ctx.setLineDash([10, 5]); // 破線
          ctx.beginPath();
          ctx.moveTo(hipCenterTrans.x, hipCenterTrans.y);
          ctx.lineTo(hipCenterTrans.x, h); // 画面下まで
          ctx.stroke();
          ctx.setLineDash([]); // 破線解除
          
          // 大転子マーカー
          ctx.fillStyle = "#dc2626";
          ctx.beginPath();
          ctx.arc(hipCenterTrans.x, hipCenterTrans.y, 10, 0, 2 * Math.PI);
          ctx.fill();
          
          // 「大転子」ラベル
          ctx.fillStyle = "#dc2626";
          ctx.font = "bold 16px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText("大転子", hipCenterTrans.x + 15, hipCenterTrans.y - 5);
          
          // 左つま先までの距離を表示（cm単位）
          if (leftToe.visibility > POINT_CONFIDENCE_THRESHOLD) {
            const leftToeTrans = transformPoint(leftToe);
            
            // 正規化座標での水平距離
            const leftDistNorm = leftToe.x - hipCenterNorm.x;
            // cm換算：前方がマイナス、後方がプラス（符号反転）
            const leftDistCm = avgThighLength > 0 
              ? (-leftDistNorm / avgThighLength) * ASSUMED_THIGH_LENGTH_CM 
              : 0;
            
            // つま先から垂直線への水平線
            ctx.strokeStyle = "#22c55e"; // 緑色
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(hipCenterTrans.x, leftToeTrans.y);
            ctx.lineTo(leftToeTrans.x, leftToeTrans.y);
            ctx.stroke();
            
            // つま先マーカー
            ctx.fillStyle = "#22c55e";
            ctx.beginPath();
            ctx.arc(leftToeTrans.x, leftToeTrans.y, 8, 0, 2 * Math.PI);
            ctx.fill();
            
            // 距離ラベル（左、cm単位）
            const leftDistLabel = leftDistCm < 0 
              ? `L: ${Math.abs(leftDistCm).toFixed(1)}cm前` 
              : `L: ${leftDistCm.toFixed(1)}cm後`;
            
            // 背景付きラベル
            ctx.font = "bold 16px sans-serif";
            const textWidth = ctx.measureText(leftDistLabel).width;
            const labelX = (hipCenterTrans.x + leftToeTrans.x) / 2 - textWidth / 2;
            const labelY = leftToeTrans.y - 10;
            
            ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
            ctx.fillRect(labelX - 6, labelY - 16, textWidth + 12, 22);
            ctx.fillStyle = "#16a34a";
            ctx.textAlign = "left";
            ctx.fillText(leftDistLabel, labelX, labelY);
          }
          
          // 右つま先までの距離を表示（cm単位）
          if (rightToe.visibility > POINT_CONFIDENCE_THRESHOLD) {
            const rightToeTrans = transformPoint(rightToe);
            
            // 正規化座標での水平距離
            const rightDistNorm = rightToe.x - hipCenterNorm.x;
            // cm換算：前方がマイナス、後方がプラス（符号反転）
            const rightDistCm = avgThighLength > 0 
              ? (-rightDistNorm / avgThighLength) * ASSUMED_THIGH_LENGTH_CM 
              : 0;
            
            // つま先から垂直線への水平線
            ctx.strokeStyle = "#3b82f6"; // 青色
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(hipCenterTrans.x, rightToeTrans.y);
            ctx.lineTo(rightToeTrans.x, rightToeTrans.y);
            ctx.stroke();
            
            // つま先マーカー
            ctx.fillStyle = "#3b82f6";
            ctx.beginPath();
            ctx.arc(rightToeTrans.x, rightToeTrans.y, 8, 0, 2 * Math.PI);
            ctx.fill();
            
            // 距離ラベル（右、cm単位）
            const rightDistLabel = rightDistCm < 0 
              ? `R: ${Math.abs(rightDistCm).toFixed(1)}cm前` 
              : `R: ${rightDistCm.toFixed(1)}cm後`;
            
            // 背景付きラベル
            ctx.font = "bold 16px sans-serif";
            const textWidth = ctx.measureText(rightDistLabel).width;
            const labelX = (hipCenterTrans.x + rightToeTrans.x) / 2 - textWidth / 2;
            const labelY = rightToeTrans.y - 10;
            
            ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
            ctx.fillRect(labelX - 6, labelY - 16, textWidth + 12, 22);
            ctx.fillStyle = "#2563eb";
            ctx.textAlign = "left";
            ctx.fillText(rightDistLabel, labelX, labelY);
          }
        }
      }
      
      // 拡大表示時も区間マーカー線を描画
      drawSectionMarkers(ctx, w, h, currentFrame, {
        srcX,
        srcY,
        srcW,
        srcH,
        scale: zoomScale,
      });
      
      // 拡大表示時も接地/離地マーカーを描画
      drawContactMarkers(ctx, w, h, currentFrame);
    }
  }, [
    currentFrame,
    framesCount,
    footZoomEnabled,
    zoomScale,
    showSkeleton,
    poseResults,
    sectionStartFrame,
    sectionMidFrame,
    sectionEndFrame,
    startLineOffset,
    midLineOffset,
    endLineOffset,
    contactFrames,
  ]);

  const ready = framesCount > 0;

  const changeFrame = (delta: number) => {
    if (!ready) return;
    const newFrame = clamp(
      currentFrame + delta,
      0,
      Math.max(0, framesRef.current.length - 1)
    );
    setCurrentFrame(newFrame);
  };

  const handleSliderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!ready) return;
    const idx = Number(e.target.value) || 0;
    setCurrentFrame(idx);
  };
  // 接地フレームを 1 コマずつ微調整
  const handleAdjustContactFrame = (stepIndex: number, delta: number) => {
    setManualContactFrames(prev => {
      if (!prev.length) return prev;
      if (stepIndex < 0 || stepIndex >= prev.length) return prev;

      const framesMax = framesCount > 0 ? framesCount - 1 : 0;
      const next = [...prev];

      let updated = next[stepIndex] + delta;
      if (updated < 0) updated = 0;
      if (updated > framesMax) updated = framesMax;

      next[stepIndex] = updated;
      return next;
    });
  };

  // 離地フレームを 1 コマずつ微調整
  const handleAdjustToeOffFrame = (stepIndex: number, delta: number) => {
    const framesMax = framesCount > 0 ? framesCount - 1 : 0;

    if (calibrationType === 2) {
      // 半自動設定：autoToeOffFrames を修正
      setAutoToeOffFrames(prev => {
        if (!prev.length) return prev;
        if (stepIndex < 0 || stepIndex >= prev.length) return prev;

        const next = [...prev];

        let updated = next[stepIndex] + delta;
        if (updated < 0) updated = 0;
        if (updated > framesMax) updated = framesMax;

        next[stepIndex] = updated;
        return next;
      });
    } else {
      // 手動マーク設定：manualToeOffFrames を修正
      setManualToeOffFrames(prev => {
        if (!prev.length) return prev;
        if (stepIndex < 0 || stepIndex >= prev.length) return prev;

        const next = [...prev];

        let updated = next[stepIndex] + delta;
        if (updated < 0) updated = 0;
        if (updated > framesMax) updated = framesMax;

        next[stepIndex] = updated;
        return next;
      });
    }
  };

  const currentLabel = ready ? currentFrame + 1 : 0;
  const maxLabel = ready ? framesCount : 0;

  // ------------ グラフ（Chart.js） ------------
  const graphCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<any | null>(null);
  const [selectedGraphMetrics, setSelectedGraphMetrics] = useState<
    GraphMetricKey[]
  >(["stride", "stepPitch", "speedMps"]);
  const [graphType, setGraphType] = useState<"line" | "bar">("line");
  
  // 各項目ごとのグラフタイプ（折れ線/棒グラフ）
  const [metricChartTypes, setMetricChartTypes] = useState<Record<GraphMetricKey, "line" | "bar">>({
    contactTime: "bar",
    flightTime: "bar",
    stepPitch: "line",
    stride: "bar",
    speedMps: "line",
    brakeRatio: "bar",
    kickRatio: "bar",
  });

  const toggleMetric = (key: GraphMetricKey) => {
    setSelectedGraphMetrics((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((k) => k !== key);
        return next.length ? next : [key];
      }
      return [...prev, key];
    });
  };
  
  const toggleMetricChartType = (key: GraphMetricKey) => {
    setMetricChartTypes((prev) => ({
      ...prev,
      [key]: prev[key] === "line" ? "bar" : "line"
    }));
  };

  useEffect(() => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!stepMetrics.length || !selectedGraphMetrics.length) {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
      return;
    }

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }

    const labels = stepMetrics.map((s) => `#${s.index}`);

    const datasets = selectedGraphMetrics.map((key) => {
      const color = metricColors[key];
      const chartType = metricChartTypes[key]; // 各項目ごとのチャートタイプ
      const data = stepMetrics.map((s) => {
        let v: number | null | undefined = null;
        
        // ブレーキ/キック率は特別処理（Impulse比率を使用し、パーセント表示）
        if (key === "brakeRatio") {
          v = s.brakeImpulseRatio != null ? s.brakeImpulseRatio * 100 : null;
        } else if (key === "kickRatio") {
          v = s.kickImpulseRatio != null ? s.kickImpulseRatio * 100 : null;
        } else {
          v = s[key as keyof StepMetric] as number | null | undefined;
        }
        
        return v != null ? Number(v.toFixed(4)) : null;
      });

      return {
        label: metricLabels[key],
        data,
        type: chartType, // 各項目ごとのチャートタイプを使用
        borderColor: color,
        backgroundColor: chartType === "bar" ? `${color}33` : color,
        borderWidth: 2,
        tension: 0.25,
        pointRadius: chartType === "line" ? 3 : 0,
        pointHoverRadius: chartType === "line" ? 4 : 0,
      };
    });

    // 混合チャートの場合は 'bar' をベースタイプとして使用
    chartInstanceRef.current = new Chart(ctx, {
      type: 'bar', // 混合チャートのベースタイプ
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 350,
        },
        scales: {
          x: {
            grid: {
              color: "rgba(148, 163, 184, 0.15)",
            },
            ticks: {
              color: "#6b7280",
              font: {
                size: 11,
              },
            },
          },
          y: {
            grid: {
              color: "rgba(148, 163, 184, 0.15)",
            },
            ticks: {
              color: "#6b7280",
              font: {
                size: 11,
              },
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: "#374151",
              font: {
                size: 11,
              },
              boxWidth: 14,
            },
          },
          tooltip: {
            backgroundColor: "#0f172a",
            titleColor: "#e5e7eb",
            bodyColor: "#e5e7eb",
            padding: 8,
          },
        },
      },
    });

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [stepMetrics, selectedGraphMetrics, graphType, metricChartTypes]);

  // ステップ7に移動したときにグラフを強制再描画
  useEffect(() => {
    if (wizardStep === 7 && stepMetrics.length > 0) {
      // グラフを再描画するために、少し遅延させる
      const timer = setTimeout(() => {
        const canvas = graphCanvasRef.current;
        if (canvas && chartInstanceRef.current) {
          chartInstanceRef.current.update();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [wizardStep, stepMetrics.length]);

  // AI評価機能
  // 🔥 runType に基づいて analysisType を決定
  // - 'dash' (スタートダッシュ) → 'acceleration' (静止状態からの加速評価)
  // - 'accel' (加速走) → 'topSpeed' (すでにスピードに乗った状態の評価)
  // 加速走は助走があるため、トップスピード維持に近い評価基準を適用
  const runningEvaluation: RunningEvaluation | null = useMemo(() => {
    // スタートダッシュは加速局面、加速走はトップスピード評価
    const analysisType: 'acceleration' | 'topSpeed' = runType === 'dash' ? 'acceleration' : 'topSpeed';
    
    return generateRunningEvaluation(stepMetrics, threePhaseAngles, {
      avgContact: stepSummary.avgContact ?? 0,
      avgFlight: stepSummary.avgFlight ?? 0,
      avgStepPitch: stepSummary.avgStepPitch ?? 0,
      avgStride: stepSummary.avgStride ?? 0,
      avgSpeed: stepSummary.avgSpeedMps ?? 0
    }, analysisType, {
      heightCm: athleteInfo.height_cm,
      gender: athleteInfo.gender
    }, runType);
  }, [stepMetrics, threePhaseAngles, stepSummary, athleteInfo.height_cm, athleteInfo.gender, runType]);

  // 研究データベース（目標記録に対する最適なピッチとストライド）
  // 出典: これまでの研究報告「身体の大きさ、四肢の長さがピッチに大きく影響し、体型によって至適ピッチが選択され、
  //        そのときのストライド長によってパフォーマンスが決まる」
  const getOptimalPitchStride = (targetTime: number, currentPitch: number, currentStride: number) => {
    const targetSpeed = 100 / targetTime;
    
    // 研究データ: 男子競技者の3つの体型パターン
    // ピッチ型: 4.66歩/秒、平均型: 4.84歩/秒、ストライド型: ~5.03歩/秒
    // 女子競技者: ピッチ型: 4.44歩/秒、平均型: 4.65歩/秒、ストライド型: 4.86歩/秒
    
    const matsuoData: { [key: string]: { pitch: number; stride: number }[] } = {
      "9.50": [{ pitch: 4.66, stride: 2.65 }, { pitch: 4.84, stride: 2.54 }, { pitch: 5.03, stride: 2.45 }],
      "9.60": [{ pitch: 4.66, stride: 2.62 }, { pitch: 4.84, stride: 2.52 }, { pitch: 5.03, stride: 2.42 }],
      "9.70": [{ pitch: 4.66, stride: 2.59 }, { pitch: 4.84, stride: 2.49 }, { pitch: 5.03, stride: 2.40 }],
      "9.80": [{ pitch: 4.66, stride: 2.56 }, { pitch: 4.84, stride: 2.46 }, { pitch: 5.03, stride: 2.37 }],
      "9.90": [{ pitch: 4.66, stride: 2.53 }, { pitch: 4.84, stride: 2.43 }, { pitch: 5.03, stride: 2.34 }],
      "10.00": [{ pitch: 4.66, stride: 2.50 }, { pitch: 4.84, stride: 2.40 }, { pitch: 5.03, stride: 2.32 }],
      "10.10": [{ pitch: 4.66, stride: 2.47 }, { pitch: 4.84, stride: 2.38 }, { pitch: 5.03, stride: 2.29 }],
      "10.20": [{ pitch: 4.66, stride: 2.44 }, { pitch: 4.84, stride: 2.35 }, { pitch: 5.03, stride: 2.26 }],
      "10.30": [{ pitch: 4.66, stride: 2.41 }, { pitch: 4.84, stride: 2.32 }, { pitch: 5.03, stride: 2.24 }],
      "10.50": [{ pitch: 4.44, stride: 2.36 }, { pitch: 4.65, stride: 2.26 }, { pitch: 4.86, stride: 2.18 }],
      "10.60": [{ pitch: 4.44, stride: 2.33 }, { pitch: 4.65, stride: 2.24 }, { pitch: 4.86, stride: 2.15 }],
      "10.80": [{ pitch: 4.44, stride: 2.27 }, { pitch: 4.65, stride: 2.18 }, { pitch: 4.86, stride: 2.10 }],
      "11.00": [{ pitch: 4.44, stride: 2.21 }, { pitch: 4.65, stride: 2.12 }, { pitch: 4.86, stride: 2.05 }],
      "11.20": [{ pitch: 4.44, stride: 2.15 }, { pitch: 4.65, stride: 2.07 }, { pitch: 4.86, stride: 1.99 }],
      "11.50": [{ pitch: 4.44, stride: 2.24 }, { pitch: 4.65, stride: 2.14 }, { pitch: 4.86, stride: 2.05 }],
      "12.00": [{ pitch: 4.44, stride: 1.92 }, { pitch: 4.65, stride: 1.84 }, { pitch: 4.86, stride: 1.78 }],
    };
    
    // 目標タイムに最も近いデータを取得
    const timeStr = targetTime.toFixed(2);
    let data = matsuoData[timeStr];
    
    if (!data) {
      // 補間または近似
      const times = Object.keys(matsuoData).map(t => parseFloat(t)).sort((a, b) => a - b);
      const closestTime = times.reduce((prev, curr) => 
        Math.abs(curr - targetTime) < Math.abs(prev - targetTime) ? curr : prev
      );
      data = matsuoData[closestTime.toFixed(2)];
    }
    
    // 現在のピッチ/ストライド比から体型を判定
    const pitchStrideRatio = currentPitch / currentStride;
    
    let selectedType = 1; // 平均型をデフォルト
    if (pitchStrideRatio > 2.4) {
      selectedType = 0; // ピッチ型
    } else if (pitchStrideRatio < 2.2) {
      selectedType = 2; // ストライド型
    }
    
    const optimal = data[selectedType];
    
    return {
      pitch: optimal.pitch,
      stride: optimal.stride,
      type: selectedType === 0 ? "ピッチ型" : selectedType === 2 ? "ストライド型" : "平均型"
    };
  };

  // 100m目標記録に基づく科学的アドバイス生成（研究データ使用）
  const generateTargetAdvice = (targetTime: number, currentAnalysisType: 'acceleration' | 'topSpeed' = 'topSpeed') => {
    if (!stepSummary.avgSpeedMps || !stepSummary.avgStride || !stepSummary.avgStepPitch) {
      return "現在の走行データが不足しています。マーカーを設定して解析を完了してください。";
    }

    const currentSpeed = stepSummary.avgSpeedMps;
    const currentStride = stepSummary.avgStride;
    const currentPitch = stepSummary.avgStepPitch;
    
    // 目標タイム（秒）から必要な平均速度を計算
    const targetSpeed = 100 / targetTime; // m/s
    const speedGap = targetSpeed - currentSpeed;
    const speedGapPercent = (speedGap / currentSpeed) * 100;

    // 研究データから最適なピッチとストライドを取得
    const optimal = getOptimalPitchStride(targetTime, currentPitch, currentStride);
    const optimalPitch = optimal.pitch;
    const optimalStride = optimal.stride;
    const bodyType = optimal.type;
    
    // 現在との差分を計算
    const strideGap = optimalStride - currentStride;
    const pitchGap = optimalPitch - currentPitch;
    
    // ストライドとピッチのバランスを評価
    const strideRatio = currentStride / optimalStride;
    const pitchRatio = currentPitch / optimalPitch;

    let advice = `## 🎯 100m ${targetTime}秒達成のためのアドバイス\n\n`;
    advice += `### 📊 現状分析\n`;
    advice += `- **現在の平均速度**: ${currentSpeed.toFixed(2)} m/s\n`;
    advice += `- **現在のピッチ**: ${currentPitch.toFixed(2)} 歩/秒\n`;
    advice += `- **現在のストライド**: ${currentStride.toFixed(2)} m\n`;
    advice += `- **判定された体型**: ${bodyType}\n\n`;
    
    advice += `### 🎯 目標値（これまでの研究報告に基づく）\n`;
    advice += `- **必要な平均速度**: ${targetSpeed.toFixed(2)} m/s\n`;
    advice += `- **最適なピッチ（${bodyType}）**: ${optimalPitch.toFixed(2)} 歩/秒\n`;
    advice += `- **最適なストライド（${bodyType}）**: ${optimalStride.toFixed(2)} m\n\n`;
    
    advice += `> 📚 **科学的根拠**: これまでの研究報告によると「身体の大きさ、四肢の長さがピッチに大きく影響し、体型によって至適ピッチが選択され、そのときのストライド長によってパフォーマンスが決まる」\n\n`;
    
    advice += `### 📈 改善が必要な項目\n`;
    advice += `- **速度**: ${speedGap >= 0 ? '+' : ''}${speedGap.toFixed(2)} m/s (${speedGapPercent >= 0 ? '+' : ''}${speedGapPercent.toFixed(1)}%)\n`;
    advice += `- **ピッチ**: ${pitchGap >= 0 ? '+' : ''}${pitchGap.toFixed(2)} 歩/秒 (現在は最適値の${(pitchRatio * 100).toFixed(1)}%)\n`;
    advice += `- **ストライド**: ${strideGap >= 0 ? '+' : ''}${strideGap.toFixed(2)} m (現在は最適値の${(strideRatio * 100).toFixed(1)}%)\n\n`;
    
    advice += `### 💡 体型別の特徴\n`;
    if (bodyType === "ピッチ型") {
      advice += `あなたは**ピッチ型**です。以下の特徴があります：\n`;
      advice += `- 高いピッチ（歩/秒）で走るタイプ\n`;
      advice += `- 接地時間が短く、素早い足の回転が得意\n`;
      advice += `- ストライドは相対的に短め\n`;
      advice += `- **強化ポイント**: 接地時間の短縮、爆発的な地面反力の向上\n\n`;
    } else if (bodyType === "ストライド型") {
      advice += `あなたは**ストライド型**です。以下の特徴があります：\n`;
      advice += `- 大きなストライド（歩幅）で走るタイプ\n`;
      advice += `- 股関節の可動域が広く、滞空時間が長い\n`;
      advice += `- ピッチは相対的に低め\n`;
      advice += `- **強化ポイント**: 股関節周辺の筋力強化、柔軟性向上\n\n`;
    } else {
      advice += `あなたは**平均型**です。以下の特徴があります：\n`;
      advice += `- ピッチとストライドのバランスが取れたタイプ\n`;
      advice += `- 両方の要素を均等に活用できる\n`;
      advice += `- 汎用性が高く、様々なトレーニングに対応可能\n`;
      advice += `- **強化ポイント**: ピッチとストライドの両方を段階的に向上\n\n`;
    }
    
    advice += `### 🔬 速度の方程式\n`;
    advice += `速度 = ピッチ × ストライド の関係式から、目標速度達成には以下の組み合わせが必要です：\n`;
    advice += `${targetSpeed.toFixed(2)} m/s = ${optimalPitch.toFixed(2)} 歩/秒 × ${optimalStride.toFixed(2)} m\n\n`;

    // ===== 3つのアプローチを計算 =====
    // アプローチ1: 現在のストライドでピッチを上げる
    const requiredPitchForCurrentStride = targetSpeed / currentStride;
    const pitchIncreaseNeeded = requiredPitchForCurrentStride - currentPitch;
    const pitchIncreasePercent = (pitchIncreaseNeeded / currentPitch) * 100;
    
    // アプローチ2: 現在のピッチでストライドを上げる
    const requiredStrideForCurrentPitch = targetSpeed / currentPitch;
    const strideIncreaseNeeded = requiredStrideForCurrentPitch - currentStride;
    const strideIncreasePercent = (strideIncreaseNeeded / currentStride) * 100;
    
    // アプローチ3: バランスよく両方を上げる
    // 速度向上率の平方根でバランスを取る
    const speedRatio = targetSpeed / currentSpeed;
    const balancedIncreaseFactor = Math.sqrt(speedRatio);
    const balancedPitch = currentPitch * balancedIncreaseFactor;
    const balancedStride = currentStride * balancedIncreaseFactor;
    const balancedPitchIncrease = balancedPitch - currentPitch;
    const balancedStrideIncrease = balancedStride - currentStride;
    const balancedPitchIncreasePercent = (balancedPitchIncrease / currentPitch) * 100;
    const balancedStrideIncreasePercent = (balancedStrideIncrease / currentStride) * 100;

    // ===== 3つのアプローチのアドバイス =====
    advice += `---\n\n`;
    advice += `## 📋 目標達成への3つのアプローチ\n\n`;
    
    // アプローチ1: ピッチ向上
    advice += `### 🔵 アプローチ1: ピッチ向上（現在のストライド維持）\n\n`;
    advice += `**目標値**\n`;
    advice += `- 現在のストライド: ${currentStride.toFixed(2)} m（維持）\n`;
    advice += `- 必要なピッチ: **${requiredPitchForCurrentStride.toFixed(2)} 歩/秒**\n`;
    advice += `- ピッチ向上幅: +${pitchIncreaseNeeded.toFixed(2)} 歩/秒（+${pitchIncreasePercent.toFixed(1)}%）\n\n`;
    
    if (pitchIncreasePercent <= 15) {
      advice += `✅ **実現可能性: 高い** - 短期間（4-8週間）で達成可能な範囲です\n\n`;
    } else if (pitchIncreasePercent <= 25) {
      advice += `⚠️ **実現可能性: 中程度** - 中期間（8-16週間）のトレーニングが必要です\n\n`;
    } else {
      advice += `❌ **実現可能性: 低い** - ピッチのみでの達成は困難です。他のアプローチも検討してください\n\n`;
    }
    
    advice += `**トレーニング方法**\n`;
    advice += `1. **接地時間短縮ドリル**\n`;
    advice += `   - クイックステップ走 20m × 6本（メトロノーム ${(requiredPitchForCurrentStride * 60).toFixed(0)} BPM）\n`;
    advice += `   - 目標接地時間: 0.08-0.10秒（現在より10-20%短縮）\n`;
    advice += `   - 真下への踏み込みを意識（鉛直成分の強化）\n\n`;
    advice += `2. **腕振り高速化**\n`;
    advice += `   - 腕振り単独練習 30秒 × 5セット（${(requiredPitchForCurrentStride * 60).toFixed(0)} BPM）\n`;
    advice += `   - 肘角度90°を維持、コンパクトな動き\n`;
    advice += `   - 腕振り速度がピッチを決定する重要因子\n\n`;
    advice += `3. **プライオメトリクス**\n`;
    advice += `   - アンクルホップ 20回 × 4セット（足首の反発力強化）\n`;
    advice += `   - ポゴジャンプ 30秒 × 3セット（接地時間最小化）\n`;
    advice += `   - 下り坂ダッシュ 30m × 4本（重力を利用したピッチ感覚）\n\n`;
    
    // アプローチ2: ストライド向上
    advice += `### 🟢 アプローチ2: ストライド向上（現在のピッチ維持）\n\n`;
    advice += `**目標値**\n`;
    advice += `- 現在のピッチ: ${currentPitch.toFixed(2)} 歩/秒（維持）\n`;
    advice += `- 必要なストライド: **${requiredStrideForCurrentPitch.toFixed(2)} m**\n`;
    advice += `- ストライド向上幅: +${strideIncreaseNeeded.toFixed(2)} m（+${strideIncreasePercent.toFixed(1)}%）\n\n`;
    
    if (strideIncreasePercent <= 10) {
      advice += `✅ **実現可能性: 高い** - 短期間（4-8週間）で達成可能な範囲です\n\n`;
    } else if (strideIncreasePercent <= 20) {
      advice += `⚠️ **実現可能性: 中程度** - 中期間（8-16週間）のトレーニングが必要です\n\n`;
    } else {
      advice += `❌ **実現可能性: 低い** - ストライドのみでの達成は困難です。他のアプローチも検討してください\n\n`;
    }
    
    advice += `**トレーニング方法**\n`;
    advice += `1. **股関節可動域拡大**\n`;
    advice += `   - 動的ストレッチ（レッグスイング）各脚20回 × 3セット\n`;
    advice += `   - ハードルドリル 30m × 6本（ストライド感覚）\n`;
    advice += `   - 目標可動域: 前後70°以上\n\n`;
    advice += `2. **下肢筋力強化**\n`;
    advice += `   - スクワット 3セット × 6回（体重の1.5-2倍の重量）\n`;
    advice += `   - ランジウォーク 20m × 4本（股関節伸展の強化）\n`;
    advice += `   - ヒップスラスト 4セット × 8回（臀筋の強化）\n\n`;
    advice += `3. **バウンディング**\n`;
    advice += `   - バウンディング 40m × 5本（滞空時間を意識）\n`;
    advice += `   - 1歩あたり${requiredStrideForCurrentPitch.toFixed(2)}m以上を目標\n`;
    advice += `   - 股関節伸展と膝の引き上げを意識\n\n`;
    
    // アプローチ3: バランス向上
    advice += `### 🟡 アプローチ3: バランス向上（両方を改善）【推奨】\n\n`;
    advice += `**目標値**\n`;
    advice += `- 目標ピッチ: **${balancedPitch.toFixed(2)} 歩/秒**（+${balancedPitchIncrease.toFixed(2)}、+${balancedPitchIncreasePercent.toFixed(1)}%）\n`;
    advice += `- 目標ストライド: **${balancedStride.toFixed(2)} m**（+${balancedStrideIncrease.toFixed(2)}、+${balancedStrideIncreasePercent.toFixed(1)}%）\n`;
    advice += `- 検算: ${balancedPitch.toFixed(2)} × ${balancedStride.toFixed(2)} = ${(balancedPitch * balancedStride).toFixed(2)} m/s ≈ ${targetSpeed.toFixed(2)} m/s ✓\n\n`;
    
    if (balancedPitchIncreasePercent <= 10 && balancedStrideIncreasePercent <= 10) {
      advice += `✅ **実現可能性: 最も高い** - 両方を少しずつ向上させるのが最も現実的です\n\n`;
    } else if (balancedPitchIncreasePercent <= 15 && balancedStrideIncreasePercent <= 15) {
      advice += `✅ **実現可能性: 高い** - バランスよく向上させることで達成可能です\n\n`;
    } else {
      advice += `⚠️ **実現可能性: 中程度** - 中長期的なトレーニング計画が必要です\n\n`;
    }
    
    advice += `**週間トレーニングプラン**\n\n`;
    advice += `**Day 1: ピッチ強化日**\n`;
    advice += `- ウォームアップ: 動的ストレッチ 10分\n`;
    advice += `- クイックステップ走 20m × 6本（目標: ${balancedPitch.toFixed(2)}歩/秒）\n`;
    advice += `- アンクルホップ 20回 × 3セット\n`;
    advice += `- 腕振り練習 30秒 × 4セット（${(balancedPitch * 60).toFixed(0)} BPM）\n`;
    advice += `- 30m加速走 × 4本（ピッチ意識）\n\n`;
    
    advice += `**Day 2: ストライド強化日**\n`;
    advice += `- ウォームアップ: 動的ストレッチ 10分\n`;
    advice += `- バウンディング 40m × 5本（目標: ${balancedStride.toFixed(2)}m/歩）\n`;
    advice += `- ハードルドリル 30m × 4本\n`;
    advice += `- ランジウォーク 20m × 4本\n`;
    advice += `- 50m走 × 3本（ストライド意識）\n\n`;
    
    advice += `**Day 3: 筋力トレーニング**\n`;
    advice += `- スクワット 4セット × 6回（85% 1RM）\n`;
    advice += `- ヒップスラスト 4セット × 8回\n`;
    advice += `- ルーマニアンデッドリフト 3セット × 8回\n`;
    advice += `- カーフレイズ 3セット × 15回\n\n`;
    
    advice += `**Day 4: 統合トレーニング**\n`;
    advice += `- ウォームアップ: 動的ストレッチ 10分\n`;
    advice += `- 60m走 × 4本（目標速度: ${targetSpeed.toFixed(2)}m/s）\n`;
    advice += `  - ピッチ ${balancedPitch.toFixed(2)}歩/秒 + ストライド ${balancedStride.toFixed(2)}m を同時意識\n`;
    advice += `- 80m走 × 2本（95%強度）\n`;
    advice += `- クールダウン: 静的ストレッチ 10分\n\n`;
    
    advice += `**週間スケジュール例**\n`;
    advice += `| 月 | 火 | 水 | 木 | 金 | 土 | 日 |\n`;
    advice += `|---|---|---|---|---|---|---|\n`;
    advice += `| Day1 | Day3 | 休息 | Day2 | Day3 | Day4 | 休息 |\n\n`;

    // ===== スタート能力向上の場合 =====
    if (currentAnalysisType === 'acceleration') {
      advice += `## 🚀 スタート能力向上のための専門アドバイス\n\n`;
      advice += `スタートからの加速局面（0-30m）に特化した技術とトレーニングメニューを提供します。\n\n`;

      advice += `### 🎯 スタート技術の科学的原理\n\n`;
      advice += `#### 1️⃣ ブロッククリアランス後の姿勢（最初の2-3歩）\n`;
      advice += `**目標体幹角度**: 42-48°の強い前傾\n`;
      advice += `- ブロック離脚後、体幹を一直線に保ったまま前方へ倒れ込む\n`;
      advice += `- 頭部から足首まで一直線のライン（「体幹の剛性」を保つ）\n`;
      advice += `- 重心を前方に位置させ、身体の重さを利用した推進力を生む\n\n`;

      advice += `**膝角度の固定**: 150-160°を維持\n`;
      advice += `- 最初の2-3歩は膝を曲げない（膝関節の屈曲・伸展を抑制）\n`;
      advice += `- 膝を引き上げる動作は水平加速を妨げる\n`;
      advice += `- 膝を伸ばしたまま、股関節伸展のみでストライドを獲得\n\n`;

      advice += `**股関節主導の伸展**: 大臀筋・ハムストリングスの活用\n`;
      advice += `- 接地は身体の後方で行い、地面を後ろに押す意識\n`;
      advice += `- 股関節伸展により、強力な水平推進力を発揮\n`;
      advice += `- 接地時間を最小限に抑え、素早く次の一歩へ\n\n`;

      advice += `#### 2️⃣ 力のベクトルの変化（1-12歩）\n`;
      advice += `**1〜3歩目**: 後方＆下方向への力発揮\n`;
      advice += `- 地面を後ろに押す水平成分が最大\n`;
      advice += `- 体幹角度42-48°で最大推進力\n`;
      advice += `- ストライドは徐々に伸びていく（段階的伸長）\n\n`;

      advice += `**4〜8歩目**: 水平成分から鉛直成分への移行\n`;
      advice += `- やや後ろ方向だが、徐々に真下への踏み込みに移行\n`;
      advice += `- 体幹角度は徐々に起き上がる（48° → 60° → 75°）\n`;
      advice += `- ストライドは最大に達し、ピッチが上がり始める\n\n`;

      advice += `**9〜12歩目**: 最高速度域への移行\n`;
      advice += `- ほぼ真下への踏み込み（鉛直成分が主）\n`;
      advice += `- 体幹角度は80-85°（ほぼ垂直）\n`;
      advice += `- 初期加速が完了し、最高速度維持フェーズへ\n\n`;

      advice += `### 💪 スタート能力向上のためのトレーニングメニュー\n\n`;

      advice += `#### 週間トレーニング構成（週3-4回推奨）\n\n`;

      advice += `**Day 1: スタートダッシュ技術 + 爆発力**\n`;
      advice += `1. **ブロックスタート練習** (30分)\n`;
      advice += `   - 10m加速走 × 8本（完全回復: 各3-4分）\n`;
      advice += `   - フォーカス: 体幹42-48°、膝固定、股関節伸展\n`;
      advice += `   - ビデオ撮影で姿勢チェック\n\n`;
      
      advice += `2. **スレッドプッシュ** (20分)\n`;
      advice += `   - 20m × 5本（重さ: 体重の50-70%）\n`;
      advice += `   - フォーカス: 水平推進力、前傾姿勢の維持\n\n`;

      advice += `3. **パワークリーン** (20分)\n`;
      advice += `   - 3セット × 3回（体重の80-90%の重量）\n`;
      advice += `   - 爆発的な股関節伸展動作の習得\n\n`;

      advice += `**Day 2: 臀筋・ハムストリングス強化**\n`;
      advice += `1. **ヒップスラスト** (重点種目)\n`;
      advice += `   - 5セット × 5回（体重の1.5-2倍の重量）\n`;
      advice += `   - スタートで最も重要な大臀筋の最大筋力強化\n\n`;

      advice += `2. **ノルディックハムストリングカール**\n`;
      advice += `   - 4セット × 6-8回\n`;
      advice += `   - ハムストリングスの離心性収縮強化\n`;
      advice += `   - 怪我予防と加速力向上\n\n`;

      advice += `3. **ルーマニアンデッドリフト**\n`;
      advice += `   - 4セット × 6回（体重の1.2-1.5倍の重量）\n`;
      advice += `   - 股関節伸展の主働筋群を総合的に強化\n\n`;

      advice += `4. **シングルレッグRDL**\n`;
      advice += `   - 3セット × 8回（左右各）\n`;
      advice += `   - バランスと片脚での股関節伸展力を強化\n\n`;

      advice += `**Day 3: プライオメトリクスとスタート反復**\n`;
      advice += `1. **デプスジャンプ** (高さ40-60cm)\n`;
      advice += `   - 5セット × 3回（完全回復）\n`;
      advice += `   - 伸張反射の強化、爆発的な力発揮\n\n`;

      advice += `2. **バウンディング** (低く長く)\n`;
      advice += `   - 30m × 6本（水平方向重視）\n`;
      advice += `   - フォーカス: 接地は身体の後方、膝を伸ばしたまま\n\n`;

      advice += `3. **ヒルスプリント** (傾斜5-10度)\n`;
      advice += `   - 20m × 6本（完全回復）\n`;
      advice += `   - 自然に前傾姿勢が強制され、スタート姿勢の習得\n\n`;

      advice += `4. **スタートダッシュ反復** (テクニック重視)\n`;
      advice += `   - 15m × 8本（80-90%の力で）\n`;
      advice += `   - 膝固定・股関節伸展・ストライド段階的伸長を意識\n\n`;

      advice += `**Day 4 (オプション): スピード持久力**\n`;
      advice += `1. **30m加速走**\n`;
      advice += `   - 8本（90-95%の力）\n`;
      advice += `   - 完全回復（5分）\n\n`;

      advice += `2. **50m加速走**\n`;
      advice += `   - 5本（85-90%の力）\n`;
      advice += `   - スタート〜最高速度までの一連の動きを反復\n\n`;

      advice += `### 🎯 重点強化エクササイズの詳細\n\n`;

      advice += `#### スタート姿勢ドリル（毎回のウォームアップで実施）\n`;
      advice += `1. **ウォールドリル**\n`;
      advice += `   - 壁に手をつき、体幹を42-45°に保つ練習\n`;
      advice += `   - 膝を曲げず、股関節伸展のみで片脚を後方へ伸ばす\n`;
      advice += `   - 左右各10回 × 3セット\n\n`;

      advice += `2. **フォールスタート**\n`;
      advice += `   - 直立から前方に倒れ込み、自然に走り出す\n`;
      advice += `   - 最初の3歩で膝を固定し、股関節伸展のみを意識\n`;
      advice += `   - 5回 × 3セット\n\n`;

      advice += `3. **マウンテンクライマー** (スロー版)\n`;
      advice += `   - プランク姿勢から、スタート動作をスローモーションで練習\n`;
      advice += `   - 膝の位置と股関節の動きを確認\n`;
      advice += `   - 30秒 × 3セット\n\n`;

      advice += `### 📊 8週間プログレッション計画\n\n`;
      advice += `**週1-2: 技術習得フェーズ**\n`;
      advice += `- フォーカス: 正しいスタート姿勢の習得\n`;
      advice += `- 負荷: 軽めの重量（70-80% 1RM）\n`;
      advice += `- スピード: 80%の力でテクニック重視\n\n`;

      advice += `**週3-4: 筋力構築フェーズ**\n`;
      advice += `- フォーカス: 臀筋・ハムストリングスの最大筋力\n`;
      advice += `- 負荷: 重い重量（85-90% 1RM）\n`;
      advice += `- スピード: 90%の力でパワー重視\n\n`;

      advice += `**週5-6: パワー変換フェーズ**\n`;
      advice += `- フォーカス: 筋力を爆発的な力へ変換\n`;
      advice += `- 負荷: 中程度の重量（75-85% 1RM）+ プライオ重視\n`;
      advice += `- スピード: 95%の力で実戦的なスタート練習\n\n`;

      advice += `**週7-8: ピーキングフェーズ**\n`;
      advice += `- フォーカス: 疲労回復とコンディション調整\n`;
      advice += `- 負荷: 軽めの重量（60-70% 1RM）\n`;
      advice += `- スピード: 短い距離で100%の力、本数を減らす\n\n`;

      advice += `### 🔬 効果測定と進捗確認\n\n`;
      advice += `**週に1回測定すべき指標**:\n`;
      advice += `1. **10m走タイム**（スタート能力の直接的指標）\n`;
      advice += `2. **30m走タイム**（初期加速の総合力）\n`;
      advice += `3. **最初の3歩のストライド長**（股関節伸展力の指標）\n`;
      advice += `4. **ヒップスラスト1RM**（臀筋の最大筋力）\n\n`;

      advice += `**ビデオ分析チェックポイント**:\n`;
      advice += `- ブロック離脚時の体幹角度（目標: 42-48°）\n`;
      advice += `- 最初の3歩の膝角度（目標: 150-160°を維持）\n`;
      advice += `- ストライドの段階的伸長（一歩ごとに伸びているか）\n`;
      advice += `- 早期起き上がりの有無（5歩目までは前傾維持）\n\n`;

      advice += `### ⚠️ よくある間違いと修正方法\n\n`;
      advice += `**❌ 間違い1: スタート直後に膝を引き上げる**\n`;
      advice += `✅ 修正: 最初の2-3歩は膝を伸ばしたまま、股関節伸展のみ\n\n`;

      advice += `**❌ 間違い2: 早期に体幹を起こす**\n`;
      advice += `✅ 修正: 5歩目まで42-48°の前傾を維持、自然に起き上がる\n\n`;

      advice += `**❌ 間違い3: 接地が身体の真下または前方**\n`;
      advice += `✅ 修正: 接地は身体の後方、地面を後ろに押す意識\n\n`;

      advice += `**❌ 間違い4: 膝の屈曲・伸展で加速しようとする**\n`;
      advice += `✅ 修正: 膝は固定し、股関節伸展（臀筋・ハム）で推進力を生む\n\n`;

      advice += `### 📚 参考: 世界トップスプリンターのスタート技術\n\n`;
      advice += `- **ウサイン・ボルト**: 最初の10歩で7mストライド達成（強力な股関節伸展）\n`;
      advice += `- **ノア・ライルズ**: ブロック離脚角度42°（科学的に最適）\n`;
      advice += `- **クリスチャン・コールマン**: 最初の3歩で膝角度ほぼ固定（160°維持）\n\n`;

      advice += `---\n\n`;
      advice += `**このプログラムを8週間実施することで、10m走タイムで0.1-0.2秒、30m走タイムで0.2-0.4秒の改善が期待できます。**\n`;
    }
    // ===== トップスピードの場合（既存ロジック） =====
    else if (speedGap <= 0) {
      advice += `### ✅ 目標達成可能！\n`;
      advice += `現在の走力で100m ${targetTime}秒は十分に達成可能です！\n\n`;
      
      // スタートダッシュの基本技術（目標達成済みでも最適化のため）
      advice += `### 🏃 高野進氏のスプリント理論に基づくスタートダッシュ技術の最適化\n\n`;
      advice += `#### スタートダッシュ（1〜12歩）の洗練\n`;
      advice += `**飛び出し角度**: 42-45°を維持\n`;
      advice += `- ノア・ライルズ（9秒83）などトップスプリンターの科学的分析結果\n`;
      advice += `- 無理な前傾姿勢は推進力に繋がらない\n`;
      advice += `- **力のベクトルの変化**:\n`;
      advice += `  - 1〜3歩目: **後ろ方向＆下方向**への力発揮\n`;
      advice += `  - 4〜12歩: やや後ろ方向だが、ほぼ**下方向**へ移行\n`;
      advice += `  - 8〜12歩程度で初期加速が終わり、真下への踏み込み（鉛直成分）が強くなる\n\n`;
      advice += `**加速局面の技術**:\n`;
      advice += `- 膝の角度変化は少なく保つ\n`;
      advice += `- 膝の伸展動作よりも、**臀部を使った伸展動作**が重要\n`;
      advice += `- 膝を軽度屈曲位に維持したまま股関節伸展を行う\n`;
      advice += `- 接地時の膝角度を維持し、臀部の力を最大限に活用\n\n`;
      advice += `#### 最高速度域の技術\n`;
      advice += `**接地時間の短縮**: 目標 0.08-0.10秒\n`;
      advice += `- 真下への踏み込み（鉛直成分）を強化\n`;
      advice += `- 地面からの反発力を最大化\n`;
      advice += `**接地位置の最適化**:\n`;
      advice += `- 体の真下で接地\n`;
      advice += `- ブレーキング効果を最小限に\n`;
      advice += `- スムーズな重心移動\n\n`;
      advice += `---\n\n`;
      
      advice += `**維持・微調整すべきポイント**:\n`;
      advice += `1. **ピッチの微調整**: ${currentPitch.toFixed(2)} → ${optimalPitch.toFixed(2)}歩/秒\n`;
      advice += `   - メトロノームを使った一定リズムの練習\n`;
      advice += `   - 接地時間を短くする意識（0.08-0.10秒が理想）\n\n`;
      advice += `2. **ストライドの効率化**: ${currentStride.toFixed(2)} → ${optimalStride.toFixed(2)}m\n`;
      advice += `   - 無駄な動きを削減（上下動を最小限に）\n`;
      advice += `   - 接地位置を最適化（体の真下で接地）\n\n`;
      advice += `3. **レース戦略**\n`;
      advice += `   - スタート〜30m: 加速フェーズ（ピッチ重視、水平成分の力発揮）\n`;
      advice += `   - 30-60m: 最高速度維持（ピッチとストライドのバランス）\n`;
      advice += `   - 60-100m: 速度維持（リラックスして走る、真下への踏み込み）\n`;
    } else if (currentAnalysisType === 'topSpeed' && speedGapPercent < 5) {
      advice += `### 🔥 目標達成まであと少し！\n`;
      advice += `あと${speedGapPercent.toFixed(1)}%の速度向上で目標達成です！\n\n`;
      
      // スタートダッシュの基本技術（速度差5%未満）
      advice += `### 🏃 高野進氏のスプリント理論：スタートダッシュ技術の最適化\n\n`;
      advice += `#### スタートダッシュ（1〜12歩）の洗練\n`;
      advice += `**飛び出し角度**: 42-45°を維持\n`;
      advice += `- 1〜3歩目: **後ろ方向＆下方向**への力発揮\n`;
      advice += `- 4〜12歩: やや後ろ方向だが、ほぼ**下方向**へ移行\n`;
      advice += `- 接地時に水平成分を最大化（膝を上げすぎない）\n`;
      advice += `- 臀部を使った伸展動作（膝の伸展に頼らない）\n\n`;
      advice += `---\n\n`;
      
      // ピッチとストライドの改善優先度を科学的に判定
      const pitchDeficit = Math.abs(pitchGap);
      const strideDeficit = Math.abs(strideGap);
      
      if (pitchRatio < 0.9) {
        // ピッチが最適値の90%未満 → ピッチ優先
        advice += `### 🎯 優先改善項目: ピッチ向上\n`;
        advice += `現在のピッチ（${currentPitch.toFixed(2)}歩/秒）は最適値の${(pitchRatio * 100).toFixed(1)}%です。\n\n`;
        advice += `**ピッチ向上トレーニング** (目標: ${optimalPitch.toFixed(2)}歩/秒)\n`;
        advice += `1. **接地時間短縮ドリル**\n`;
        advice += `   - 目標接地時間: 0.08-0.10秒（現在より10-20%短縮）\n`;
        advice += `   - クイックステップドリル（20m × 3本）\n`;
        advice += `   - メトロノーム練習（目標ピッチに設定）\n`;
        advice += `   - **真下への踏み込み**を意識（鉛直成分の強化）\n\n`;
        advice += `2. **プライオメトリクス**\n`;
        advice += `   - アンクルホップ（足首の反発力強化）\n`;
        advice += `   - バウンディング（短距離・高頻度）\n`;
        advice += `   - ボックスジャンプ（爆発的な力発揮）\n`;
        advice += `   - 地面反力の最大化（体重の3-5倍の力を発揮）\n\n`;
        advice += `3. **技術練習**\n`;
        advice += `   - 腕振りの高速化（腕振り速度がピッチを決定）\n`;
        advice += `   - 下り坂ダッシュ（重力を利用したピッチ感覚）\n`;
        advice += `   - スタートダッシュ1〜12歩の水平成分重視\n`;
      } else if (strideRatio < 0.9) {
        // ストライドが最適値の90%未満 → ストライド優先
        advice += `### 🎯 優先改善項目: ストライド向上\n`;
        advice += `現在のストライド（${currentStride.toFixed(2)}m）は最適値の${(strideRatio * 100).toFixed(1)}%です。\n\n`;
        advice += `**ストライド向上トレーニング** (目標: ${optimalStride.toFixed(2)}m)\n`;
        advice += `1. **筋力強化**\n`;
        advice += `   - スクワット（体重の1.5-2倍の重量）\n`;
        advice += `   - ランジ（股関節の可動域と筋力）\n`;
        advice += `   - レッグカール（ハムストリングス強化）\n`;
        advice += `   - **臀部（グルート）の強化**: 股関節伸展の主要筋\n\n`;
        advice += `2. **柔軟性向上**\n`;
        advice += `   - 動的ストレッチ（練習前）\n`;
        advice += `   - 股関節の可動域を広げるドリル（目標: 70°以上）\n`;
        advice += `   - ハードルドリル（ストライド感覚）\n`;
        advice += `   - **膝を軽度屈曲位に維持**しながら股関節伸展を行う\n\n`;
        advice += `3. **技術練習**\n`;
        advice += `   - バウンディング（滞空時間を意識）\n`;
        advice += `   - 高膝走（膝を高く上げる意識）\n`;
        advice += `   - 接地位置の最適化（体の真下で接地）\n`;
        advice += `   - スタートダッシュで**臀部を使った伸展動作**を意識\n`;
      } else {
        // バランス型
        advice += `### 🎯 バランス型改善アプローチ\n`;
        advice += `ピッチ・ストライドともに最適値に近づいています。\n\n`;
        advice += `**統合トレーニング**\n`;
        advice += `1. **スピード持久力**\n`;
        advice += `   - 80m走 × 3-5本（95%の強度）\n`;
        advice += `   - 目標ピッチとストライドを意識\n`;
        advice += `   - 休息時間: 完全回復（5-8分）\n`;
        advice += `   - **接地位置の最適化**（体の真下で接地、ブレーキング効果の最小化）\n\n`;
        advice += `2. **レースペース走**\n`;
        advice += `   - 50-60m × 3本（目標速度で走る）\n`;
        advice += `   - ピッチ: ${optimalPitch.toFixed(2)}歩/秒を維持\n`;
        advice += `   - ストライド: ${optimalStride.toFixed(2)}mを維持\n`;
        advice += `   - 速度 = ${targetSpeed.toFixed(2)}m/s = ${optimalPitch.toFixed(2)}歩/秒 × ${optimalStride.toFixed(2)}m\n\n`;
        advice += `3. **技術統合**\n`;
        advice += `   - 加速走（30-60mで最高速度到達）\n`;
        advice += `   - 4〜12歩で水平成分から鉛直成分へ移行\n`;
        advice += `   - フライング走（助走をつけて最高速度を体験）\n`;
        advice += `   - 真下への踏み込み、地面反力の最大化\n`;
      }
    } else if (currentAnalysisType === 'topSpeed' && speedGapPercent < 10) {
      advice += `### 💪 目標達成には計画的なトレーニングが必要\n`;
      advice += `${speedGapPercent.toFixed(1)}%の速度向上が必要です。\n\n`;
      
      advice += `### 🏃 高野進氏のスプリント理論に基づく技術ポイント\n\n`;
      
      advice += `#### 1️⃣ スタートダッシュ（1〜12歩）のポイント\n`;
      advice += `**飛び出し角度**: 42-45°が最適\n`;
      advice += `- ノア・ライルズ（9秒83）などトップスプリンターの分析結果\n`;
      advice += `- 無理な前傾姿勢は推進力に繋がらない\n`;
      advice += `- 加速時は接地時に**水平成分**を生み出す（膝を上に引き上げない）\n`;
      advice += `- 滞空フェーズで加速成分は生み出せないので、浮きすぎないようにする\n\n`;
      
      advice += `**力のベクトルの変化**:\n`;
      advice += `- 1〜3歩目: **後ろ方向＆下方向**への力発揮\n`;
      advice += `- 4〜12歩: やや後ろ方向だが、ほぼ**下方向**へ移行\n`;
      advice += `- 8〜12歩程度で初期加速が終わり、真下への踏み込み（鉛直成分）が強くなる\n\n`;
      
      advice += `#### 2️⃣ 加速局面の技術\n`;
      advice += `**前傾姿勢の維持**:\n`;
      advice += `- 膝の角度変化は少なく保つ\n`;
      advice += `- 膝の伸展動作よりも、**臀部を使った伸展動作**が重要\n`;
      advice += `- 膝を軽度屈曲位に維持したまま股関節伸展を行う\n\n`;
      
      advice += `**挟み込み動作の優先**:\n`;
      advice += `- 1〜3歩目は特に水平方向への力発揮を意識\n`;
      advice += `- 接地時の膝角度を維持し、臀部の力を最大限に活用\n\n`;
      
      advice += `#### 3️⃣ 最高速度域の技術\n`;
      advice += `**接地時間の短縮**:\n`;
      advice += `- 目標: 0.08-0.10秒\n`;
      advice += `- 真下への踏み込み（鉛直成分）を強化\n`;
      advice += `- 地面からの反発力を最大化\n\n`;
      
      advice += `**接地位置の最適化**:\n`;
      advice += `- 体の真下で接地\n`;
      advice += `- ブレーキング効果を最小限に\n`;
      advice += `- スムーズな重心移動\n\n`;
      
      advice += `---\n\n`;
      
      advice += `### 📋 8週間トレーニングプラン\n\n`;
      
      advice += `**週1-2: 基礎フェーズ**\n`;
      advice += `目的: 筋力と神経系の適応\n`;
      advice += `- 筋力: スクワット 3セット×8回（80-85% 1RM）\n`;
      advice += `- 爆発力: ボックスジャンプ 3セット×5回\n`;
      advice += `- スピード: 30m加速走 5本（ピッチ意識）\n`;
      advice += `- 技術: ドリル（高膝走、もも上げ等）\n\n`;
      
      advice += `**週3-4: 強化フェーズ**\n`;
      advice += `目的: ピッチとストライドの統合\n`;
      advice += `- 筋力: クリーン 3セット×5回（爆発的動作）\n`;
      advice += `- ピッチ: クイックステップ 20m×5本（${optimalPitch.toFixed(1)}歩/秒目標）\n`;
      advice += `- ストライド: バウンディング 30m×4本\n`;
      advice += `- スピード: 50m走 4本（90%強度）\n\n`;
      
      advice += `**週5-6: 統合フェーズ**\n`;
      advice += `目的: レースペースでの走り込み\n`;
      advice += `- スピード持久力: 80m走 3本（95%強度）\n`;
      advice += `- レースペース: 60m走 4本（目標速度: ${targetSpeed.toFixed(2)}m/s）\n`;
      advice += `- 技術: フライング30m 4本（最高速度体験）\n\n`;
      
      advice += `**週7-8: ピーキングフェーズ**\n`;
      advice += `目的: コンディション調整と記録挑戦\n`;
      advice += `- 軽めのスピード: 40m走 3本（95%強度）\n`;
      advice += `- タイムトライアル: 100m全力走（週1回）\n`;
      advice += `- 回復: ストレッチと軽いジョギング\n\n`;
      
      advice += `### 🔬 重要な科学的ポイント\n`;
      advice += `1. **接地時間**: 0.08-0.10秒が理想（短いほどピッチが上がる）\n`;
      advice += `2. **地面反力**: 体重の3-5倍の力を発揮（筋力トレーニングで向上）\n`;
      advice += `3. **腕振り**: ピッチを決定する重要因子（肘角度90度を保つ）\n`;
      advice += `4. **体幹安定性**: 上下動を最小限にしてエネルギーロスを防ぐ\n`;
    } else if (currentAnalysisType === 'topSpeed') {
      advice += `### 🏃 長期的なトレーニングで目標達成を目指しましょう\n`;
      advice += `${speedGapPercent.toFixed(1)}%の速度向上には、段階的なトレーニングが必要です。\n\n`;
      
      advice += `### 📋 16週間（4ヶ月）トレーニングプラン\n\n`;
      
      advice += `**フェーズ1（週1-4）: 基礎体力向上**\n`;
      advice += `目的: 筋力・柔軟性・持久力の基礎を構築\n`;
      advice += `- 筋力: 週3回（スクワット、デッドリフト、ランジ）\n`;
      advice += `  - 目標: 体重の1.5倍のスクワット達成\n`;
      advice += `- 柔軟性: 毎日20分（動的・静的ストレッチ）\n`;
      advice += `  - 股関節可動域を20%向上\n`;
      advice += `- 有酸素: 週2回（30分ジョギング）\n`;
      advice += `- スピード: 週1回（30m加速走×5本）\n\n`;
      
      advice += `**フェーズ2（週5-8）: スピード基礎強化**\n`;
      advice += `目的: ピッチとストライドの個別強化\n`;
      advice += `- ピッチ強化: 週2回\n`;
      advice += `  - クイックステップ 20m×6本（目標: ${(optimalPitch * 0.9).toFixed(2)}歩/秒）\n`;
      advice += `  - プライオメトリクス（アンクルホップ、バウンディング）\n`;
      advice += `- ストライド強化: 週2回\n`;
      advice += `  - バウンディング 40m×5本（目標: ${(optimalStride * 0.9).toFixed(2)}m）\n`;
      advice += `  - ハードルドリル\n`;
      advice += `- 筋力: 週2回（維持レベル）\n\n`;
      
      advice += `**フェーズ3（週9-12）: スピード統合**\n`;
      advice += `目的: ピッチとストライドを統合し、最高速度を向上\n`;
      advice += `- レースペース走: 週2回\n`;
      advice += `  - 60m走×4本（目標速度: ${(targetSpeed * 0.95).toFixed(2)}m/s）\n`;
      advice += `  - ピッチ ${optimalPitch.toFixed(2)}歩/秒、ストライド ${optimalStride.toFixed(2)}m を意識\n`;
      advice += `- スピード持久力: 週1回\n`;
      advice += `  - 80m走×3本（95%強度、完全回復）\n`;
      advice += `- 技術練習: 週1回\n`;
      advice += `  - フライング30m、下り坂ダッシュ\n\n`;
      
      advice += `**フェーズ4（週13-16）: ピーキングと記録挑戦**\n`;
      advice += `目的: 最高のコンディションで目標タイム達成\n`;
      advice += `- タイムトライアル: 週1回（100m全力走）\n`;
      advice += `- スピード維持: 週1回（40m走×3本、軽め）\n`;
      advice += `- 回復重視: ストレッチ、マッサージ\n`;
      advice += `- 記録会参加: 本番環境でのレース経験\n\n`;
      
      advice += `### 🔬 科学的根拠とトレーニング原理\n\n`;
      advice += `**1. 速度 = ピッチ × ストライド の関係**\n`;
      advice += `- 目標: ${targetSpeed.toFixed(2)}m/s = ${optimalPitch.toFixed(2)}歩/秒 × ${optimalStride.toFixed(2)}m\n`;
      advice += `- 両方を10%向上させると、速度は約21%向上\n`;
      advice += `- バランスの取れた改善が最も効果的\n\n`;
      
      advice += `**2. 接地時間と地面反力**\n`;
      advice += `- トップスプリンター: 接地時間 0.08-0.10秒\n`;
      advice += `- 地面反力: 体重の3-5倍\n`;
      advice += `- プライオメトリクスで向上可能\n\n`;
      
      advice += `**3. 筋力と加速力の関係**\n`;
      advice += `- スクワット1RMが体重の2倍: 優れたスプリント能力\n`;
      advice += `- 爆発的筋力（RFD）が最高速度を決定\n`;
      advice += `- クリーン、スナッチで向上\n\n`;
      
      advice += `**4. エネルギーシステム**\n`;
      advice += `- 100m走: 主にATP-PC系（無酸素的解糖）\n`;
      advice += `- 休息時間: 完全回復（5-8分）が必要\n`;
      advice += `- 質の高い練習が量よりも重要\n`;
    }

    // 姿勢に関するアドバイス
    if (runningEvaluation) {
      advice += `\n### 🎯 フォーム改善ポイント\n`;
      advice += runningEvaluation.overallMessage + '\n\n';
      
      if (runningEvaluation.evaluations.length > 0) {
        advice += `**具体的な改善提案**:\n`;
        runningEvaluation.evaluations.forEach((evaluation, i) => {
          advice += `${i + 1}. **${evaluation.category}**: ${evaluation.advice}\n`;
        });
      }
    }

    return advice;
  };

  // 認証は AppWithAuth で処理済み

  // ステップ変更時にフレームを10に設定
  useEffect(() => {
    if (wizardStep === 4 || wizardStep === 5) {
      if (ready && framesCount > 10) {
        setCurrentFrame(10);
      }
    }
  }, [wizardStep, ready, framesCount]);

  // 認証ハンドラー
  // 認証は AppWithAuth で処理済み

  // ------------ ウィザードステップの内容 ------------
  
  // マルチカメラの各セグメントを順次処理
  const processMultiCameraSegments = async () => {
    if (!multiCameraData) return;
    
    const { segments, videoFiles, currentIndex } = multiCameraData;
    
    // すべてのセグメントを処理済みの場合
    if (currentIndex >= segments.length) {
      console.log('🎆 All segments processed!');
      // 結果を集約
      const allMetrics = Object.values(multiCameraData.segmentMetrics).flat();
      const average = (values: Array<number | null | undefined>): number | null => {
        const filtered = values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
        return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : null;
      };
      
      setMultiCameraSummary({
        totalDistance: multiCameraData.run.totalDistanceM,
        totalSegments: segments.length,
        totalSteps: allMetrics.length,
        avgStride: average(allMetrics.map((m) => m.stride)),
        avgContact: average(allMetrics.map((m) => m.contactTime)),
        avgFlight: average(allMetrics.map((m) => m.flightTime)),
        avgSpeed: average(allMetrics.map((m) => m.speedMps)),
      });
      
      alert('マルチカメラ解析が完了しました！');
      setWizardStep(7); // 結果表示へ
      return;
    }
    
    const currentSegment = segments[currentIndex];
    const file = videoFiles[currentSegment.id];
    
    if (!file) {
      console.error(`Segment ${currentIndex + 1} has no video file`);
      return;
    }
    
    console.log(`🎥 Processing segment ${currentIndex + 1}/${segments.length} (${currentSegment.startDistanceM}m〜${currentSegment.endDistanceM}m)`);
    
    // 現在のセグメントを読み込んで処理
    await loadMultiCameraSegment(multiCameraData, currentIndex);
    
    // フレーム抽出と姿勢推定は loadMultiCameraSegment 内で実行されるが、
    // その後の処理の継続はステップの遷移を通じて行われる
    // （handleMultiSegmentNextで次のセグメントへ）
  };
  
  // マルチカメラ: 指定したセグメントの動画を読み込み、解析ステップを初期化
  const loadMultiCameraSegment = async (data: MultiCameraState, index: number) => {
    console.log(`🎬🎬🎬 === loadMultiCameraSegment CALLED === index: ${index}`);
    const targetSegment = data.segments[index];
    if (!targetSegment) {
      console.error("マルチカメラ: 無効なセグメントインデックスです", index, data.segments.length);
      return;
    }
    console.log(`🎬 targetSegment:`, targetSegment);

const idxKey = String((targetSegment as any).segmentIndex ?? index);

// ✅ id / segmentIndex の両方で拾う（どちらのキーで保存されていても対応）
const file =
  data.videoFiles?.[targetSegment.id] ??
  data.videoFiles?.[idxKey];

if (!file) {
  alert(`セグメント${index + 1}の動画ファイルが見つかりません。アップロードを確認してください。`);
  return;
}

// ✅ 重要：single UI が参照する state + ref を必ずセット（multi は setState 遅延があるため）
setVideoFileSync(file);

// ✅ URL を一度だけ作って、state と video 要素の両方に同じものを流す
const segmentUrl = URL.createObjectURL(file);

setVideoUrl((prev) => {
  if (prev) URL.revokeObjectURL(prev);
  return segmentUrl;
});

if (videoRef.current) {
  videoRef.current.src = segmentUrl;
  videoRef.current.load();
}



    console.log(`📹 マルチカメラ: セグメント${index + 1}/${data.segments.length} (${targetSegment.startDistanceM}m〜${targetSegment.endDistanceM}m) を処理開始`);
    
    
    // フレーム関連
    framesRef.current = [];
    setFramesCount(0);
    setCurrentFrame(0);
    setExtractProgress(0);
    setUsedTargetFps(null);
    
    // セクション関連
    setSectionStartFrame(null);
    setSectionMidFrame(null);
    setSectionEndFrame(null);
    setStartLineOffset(0);
    setMidLineOffset(0);
    setEndLineOffset(0);
    
    // 姿勢推定関連
    setPoseResults([]);
    setSavedStartHipX(null);
    setSavedMidHipX(null);
    setSavedEndHipX(null);
    setSavedStartPixelX(null);
    setSavedMidPixelX(null);
    setSavedEndPixelX(null);
    
    // マーカー関連
    setManualContactFrames([]);
    setAutoToeOffFrames([]);
    setManualToeOffFrames([]);
    
    // キャリブレーション関連
    setCalibrationMode(0);
    setCalibrationData({ 
      contactFrame: null, 
      toeOffFrame: null 
    });
    setToeOffThreshold(null);
    setBaseThreshold(null);
    
    setStatus("");
    


    
    // 距離とラベルを設定
    setDistanceInput(String(targetSegment.endDistanceM - targetSegment.startDistanceM));
    setLabelInput(`${targetSegment.startDistanceM}m〜${targetSegment.endDistanceM}m セグメント`);
    setStatus(`セグメント${index + 1}/${data.segments.length} の処理を開始します...`);
    
    // 自動的にフレーム抽出と姿勢推定を実行
    console.log(`📹 セグメント ${index + 1}: フレーム抽出を開始します...`);
    setWizardStep(3);
    
    // 動画のメタデータ読み込みを待つ
    await new Promise((resolve) => {
      if (!videoRef.current) {
        resolve(null);
        return;
      }
      
      let attempts = 0;
      const maxAttempts = 50; // 最大5秒待つ
      
      const checkVideo = () => {
        attempts++;
        if (videoRef.current?.duration && videoRef.current?.duration > 0) {
          const duration = videoRef.current.duration;
          console.log(`📹 Video ready: duration=${duration}s, readyState=${videoRef.current.readyState}`);
          resolve(null);
        } else if (attempts >= maxAttempts) {
          console.error('Video metadata loading timeout');
          resolve(null);
        } else {
          setTimeout(checkVideo, 100);
        }
      };
      
      // メタデータロードイベントを追加
      const handleMetadata = () => {
        if (videoRef.current?.duration && videoRef.current?.duration > 0) {
          console.log(`📹 Metadata loaded: duration=${videoRef.current.duration}s`);
        }
      };
      
      videoRef.current.addEventListener('loadedmetadata', handleMetadata);
      checkVideo();
    });
    
    // FPSを取得（マルチカメラ解析開始時のFPSを優先）
    const fpsToUse = data.initialFps ?? selectedFps ?? 120;
    console.log(`📹 Using FPS: ${fpsToUse} for segment ${index + 1} (initialFps=${data.initialFps}, selectedFps=${selectedFps})`);
    
    // 念のためstateも更新
    if (data.initialFps && data.initialFps !== selectedFps) {
      setSelectedFps(data.initialFps);
    }
    
    // 🔴 CRITICAL FIX: 120fpsスロー動画の実際のdurationを待つ
    // video.durationはコンテナのduration（30fps相当の時間）を返す可能性がある
    // しかし、実際のフレーム数は120fpsで抽出する必要がある
    
    // videoのdurationを取得（メタデータ完全ロード済み）
    const videoDuration = videoRef.current?.duration || 5;
    
    console.log(`🔴 VIDEO ANALYSIS:`);
    console.log(`  - video.duration: ${videoDuration}s`);
    console.log(`  - targetFps: ${fpsToUse}`);
    console.log(`  - file name: ${file.name}`);
    
    // ✅ マルチカメラモードでは、常にtargetFps × video.durationで計算
    // これにより、120fpsスロー動画でも正しいフレーム数が得られる
    const expectedFrames = Math.floor(videoDuration * fpsToUse);
    console.log(`  - Expected frames: ${expectedFrames} (${videoDuration}s × ${fpsToUse}fps)`);
    
    // 少し待機してから開始（状態更新を確実にする）
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // フレーム抽出を実行（fpsを明示的に渡す）
    console.log(`🚀 === ABOUT TO CALL handleExtractFrames ===`);
    console.log(`🚀 file:`, file?.name, file?.size);
    console.log(`🚀 segmentUrl:`, segmentUrl);
    console.log(`🚀 fps:`, fpsToUse);
    console.log(`📹 Starting frame extraction for segment ${index + 1}...`);
    await handleExtractFrames({ 
      file, 
      url: segmentUrl, 
      mode: 'multi', 
      fps: fpsToUse
      // forcedDurationは使用しない - video.durationを信頼
    });
    console.log(`✅ === handleExtractFrames COMPLETED ===`);
    
    // フレーム抽出が完了したら、姿勢推定を自動で開始
    console.log(`📹 セグメント ${index + 1}: 姿勢推定を開始します...`);
    setWizardStep(4);
    await runPoseEstimation();
    
    // 姿勢推定が完了したら、キャリブレーションステップへ（既にキャリブレーション済みならスキップ）
    const segment = data.segments[index];
    if (segment.calibration?.H_img_to_world) {
      console.log(`📹 セグメント ${index + 1}: キャリブレーション済みです。マーカー設定へ進みます`);
      setStatus(`キャリブレーション済み。マーカー設定へ進みます`);
      setWizardStep(6); // 手動マーカー設定へ
    } else {
      console.log(`📹 セグメント ${index + 1}: 4コーンキャリブレーションを開始します`);
      startConeCalibration(data, index);
    }
  };
  
  // 🎯 4コーンキャリブレーションを開始
  const startConeCalibration = (data: MultiCameraState, segmentIndex: number) => {
    const segment = data.segments[segmentIndex];
    setIsCalibrating(true);
    setConeClicks([]);
    setCalibrationInstructions(
      `セグメント${segmentIndex + 1}: ${segment.startDistanceM}m地点の手前コーン（カメラ側）をクリック`
    );
    setStatus(`4コーンキャリブレーション: 1/4コーンを設定してください`);
  };
  
  // 🎯 キャンバスクリックでコーンを設定
  const handleConeClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isCalibrating || !multiCameraData) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const clickX = (event.clientX - rect.left) * scaleX;
    const clickY = (event.clientY - rect.top) * scaleY;
    
    const newClicks = [...coneClicks, { x: clickX, y: clickY }];
    setConeClicks(newClicks);
    
    const { currentIndex, segments } = multiCameraData;
    const segment = segments[currentIndex];
    
    // 次のコーンの指示を設定
    if (newClicks.length === 1) {
      setCalibrationInstructions(
        `セグメント${currentIndex + 1}: ${segment.startDistanceM}m地点の奥コーン（レーン反対側）をクリック`
      );
      setStatus(`4コーンキャリブレーション: 2/4コーンを設定してください`);
    } else if (newClicks.length === 2) {
      setCalibrationInstructions(
        `セグメント${currentIndex + 1}: ${segment.endDistanceM}m地点の手前コーン（カメラ側）をクリック`
      );
      setStatus(`4コーンキャリブレーション: 3/4コーンを設定してください`);
    } else if (newClicks.length === 3) {
      setCalibrationInstructions(
        `セグメント${currentIndex + 1}: ${segment.endDistanceM}m地点の奥コーン（レーン反対側）をクリック`
      );
      setStatus(`4コーンキャリブレーション: 4/4コーンを設定してください`);
    } else if (newClicks.length === 4) {
      // 4つのコーンが設定されたので、Homography行列を計算
      completeCalibration(newClicks, currentIndex);
    }
  };
  
  // 🎯 キャリブレーション完了：Homography行列を計算して保存
  const completeCalibration = async (clicks: Array<{ x: number; y: number }>, segmentIndex: number) => {
    if (!multiCameraData) return;
    
    const { segments } = multiCameraData;
    const segment = segments[segmentIndex];
    
    console.log(`🎯 Calculating Homography for segment ${segmentIndex + 1}...`);
    console.log(`  Cone clicks (pixels):`, clicks);
    
    // Import computeHomographyImgToWorld
    const { computeHomographyImgToWorld } = await import('./utils/multiCameraAnalysis');
    
    // 画像上の4点（ピクセル座標）
    const imgPoints = {
      x0_near: [clicks[0].x, clicks[0].y] as [number, number],
      x0_far: [clicks[1].x, clicks[1].y] as [number, number],
      x1_near: [clicks[2].x, clicks[2].y] as [number, number],
      x1_far: [clicks[3].x, clicks[3].y] as [number, number],
    };
    
    // 実世界座標（メートル）
    // World coordinate system:
    //   x-axis = レーン幅方向 (0=カメラ側, 1.22=反対側)
    //   y-axis = 走行方向 (startDistanceM ~ endDistanceM)
    const laneWidth = 1.22; // 標準レーン幅
    const worldPoints = {
      x0_near: [0, segment.startDistanceM] as [number, number],         // カメラ側スタート
      x0_far: [laneWidth, segment.startDistanceM] as [number, number],  // 反対側スタート
      x1_near: [0, segment.endDistanceM] as [number, number],           // カメラ側エンド
      x1_far: [laneWidth, segment.endDistanceM] as [number, number],    // 反対側エンド
    };
    
    console.log(`  Image points:`, imgPoints);
    console.log(`  World points:`, worldPoints);
    
    // 座標検証: 4点が有効かチェック
    const clicksValid = clicks.every(c => !isNaN(c.x) && !isNaN(c.y) && c.x > 0 && c.y > 0);
    if (!clicksValid) {
      throw new Error('Invalid cone click coordinates detected');
    }
    
    try {
      // Homography行列を計算
      const H = computeHomographyImgToWorld(imgPoints, worldPoints);
      
      console.log(`✅ Homography matrix calculated:`);
      console.log(`  H[0]: [${H[0][0].toFixed(6)}, ${H[0][1].toFixed(6)}, ${H[0][2].toFixed(6)}]`);
      console.log(`  H[1]: [${H[1][0].toFixed(6)}, ${H[1][1].toFixed(6)}, ${H[1][2].toFixed(6)}]`);
      console.log(`  H[2]: [${H[2][0].toFixed(6)}, ${H[2][1].toFixed(6)}, ${H[2][2].toFixed(6)}]`);
      
      // セグメントのキャリブレーションデータを更新
      const updatedSegments = [...segments];
      updatedSegments[segmentIndex] = {
        ...segment,
        calibration: {
          laneWidthM: laneWidth,
          x0_m: segment.startDistanceM,
          x1_m: segment.endDistanceM,
          imgPoints,
          H_img_to_world: H,
        },
      };
      
      // MultiCameraDataを更新
      setMultiCameraData({
        ...multiCameraData,
        segments: updatedSegments,
      });
      
      console.log(`✅ Segment ${segmentIndex + 1} calibration saved`);
      setStatus(`キャリブレーション完了！マーカー設定へ進みます`);
      
      // キャリブレーションモードを終了してマーカー設定へ
      setIsCalibrating(false);
      setConeClicks([]);
      setCalibrationInstructions('');
      setWizardStep(6); // 手動マーカー設定へ
      
    } catch (error) {
      console.error('❌ Homography calculation failed:', error);
      alert(`キャリブレーションエラー: ${error instanceof Error ? error.message : 'Unknown error'}\n\nコーンの位置を正しく指定してください。`);
      
      // リトライ
      setConeClicks([]);
      setCalibrationInstructions(
        `セグメント${segmentIndex + 1}: ${segment.startDistanceM}m地点の手前コーン（カメラ側）をクリック`
      );
      setStatus(`4コーンキャリブレーション: 1/4コーンを設定してください (エラーのため再試行)`);
    }
  };

  // 新しいマルチカメラシステムのハンドラー
  const [multiCameraProcessing, setMultiCameraProcessing] = useState(false);
  const [multiCameraResult, setMultiCameraResult] = useState<RunAnalysisResult | null>(null);
  
  
  // セグメント単体を解析する専用関数（簡易版 - デモ用）
  const analyzeSegmentInBackground = async (file: File): Promise<any> => {
    console.log('🎥 Analyzing segment (simplified):', file.name);
    
    // 簡易的な解析結果を生成
    const mockStepMetrics = [];
    const numSteps = Math.floor(Math.random() * 3) + 4; // 4-6歩
    
    for (let i = 0; i < numSteps; i++) {
      mockStepMetrics.push({
        index: i,
        contactFrame: i * 30,
        toeOffFrame: i * 30 + 15,
        nextContactFrame: (i + 1) * 30,
        contactTime: 0.14 + Math.random() * 0.04,
        flightTime: 0.11 + Math.random() * 0.03,
        stepTime: 0.25 + Math.random() * 0.04,
        stride: 1.8 + Math.random() * 0.4,
        speedMps: 6.5 + Math.random() * 2,
        stepPitch: 3.5 + Math.random() * 0.5
      });
    }
    
    return {
      stepMetrics: mockStepMetrics,
      totalFrames: 180,
      successfulPoseFrames: 144,
      poseSuccessRate: 80
    };
  };
  
// ✅ 新 MultiCameraSetup 用：解析開始ボタンから呼ばれる
// ✅ 新 MultiCameraSetup 用：解析開始ボタンから呼ばれる
const handleNewMultiCameraStart = (run: Run, segments: RunSegment[]) => {
  console.log("✅ マルチカメラ解析開始（既存フロー使用）:", { run, segments });

  // セグメントにキャリブレーションが設定されているか確認
  const hasCalibration = segments.every(seg => !!seg.calibration);
  console.log(`📊 Calibration check: ${hasCalibration ? 'All segments calibrated ✅' : 'Missing calibration ❌'}`);

  // キャリブレーション情報は保持するが、既存の解析フローを使用
  // （将来的にキャリブレーション情報を活用する場合のために保持）

  // videoFiles マップを作成
  const videoFiles: Record<string, File> = {};
  segments.forEach((seg, i) => {
    const f = seg.videoFile;
    if (!f) return;
    if (seg.id) videoFiles[seg.id] = f;
    const idxKey = String(seg.segmentIndex ?? i);
    videoFiles[idxKey] = f;
  });

  // 解析対象（動画あり）だけに絞る
  const availableSegments = segments.filter((seg, i) => {
    const idxKey = String(seg.segmentIndex ?? i);
    return !!videoFiles[seg.id] || !!videoFiles[idxKey];
  });

  if (availableSegments.length === 0) {
    alert("動画がアップロードされているセグメントがありません。");
    return;
  }

  const nextState: MultiCameraState = {
    run,
    segments: availableSegments,
    videoFiles,
    currentIndex: 0,
    segmentMetrics: {},
    initialFps: selectedFps, // 現在のFPS設定を保存
  };
  
  console.log(`💾 Saving initial FPS: ${selectedFps} for multi-camera analysis`);

  // 最初のセグメントのファイルを設定
  const firstSeg = availableSegments[0];
  const firstIdxKey = String(firstSeg.segmentIndex ?? 0);
  const firstFile = videoFiles[firstSeg.id] ?? videoFiles[firstIdxKey];

  if (firstFile) {
    setVideoFile(firstFile);
    const newUrl = URL.createObjectURL(firstFile);
    setVideoUrl(newUrl);
  }

  // Multi-camera flow disabled
  // setCurrentRun(run);
  // setRunSegments(availableSegments);
  // setAnalysisMode("multi");
  setIsMultiCameraSetup(false);
  setMultiCameraSummary(null);
  setMultiCameraData(nextState);

  // Step 3（フレーム抽出）へ
  setWizardStep(3);

  // 最初のセグメントを読み込み
  setTimeout(() => {
    loadMultiCameraSegment(nextState, 0);
  }, 100);
};


  // マルチカメラ解析を中断して設定画面へ戻る
  const handleCancelMultiCamera = () => {
    setAnalysisMode("single");
    setMultiCameraData(null);
    setMultiCameraSummary(null);
    setIsMultiCameraSetup(true);
    setStatus("マルチカメラ設定に戻りました。");
    setWizardStep(0);
  };

  // 現在のセグメントを保存し、次のセグメントまたは総合結果へ進む
  const handleMultiSegmentNext = () => {
    if (!multiCameraData) return;

    const { currentIndex, segments, segmentMetrics, run } = multiCameraData;
    const currentSegment = segments[currentIndex];
    if (!currentSegment) {
      console.error("現在のセグメント情報が取得できません", currentIndex);
      return;
    }

    const metricsSnapshot = stepMetrics.map((metric) => ({ ...metric }));
    if (!metricsSnapshot.length) {
      const shouldSkip = confirm(
        "ステップデータが検出されていません。姿勢推定やマーカー設定が完了していない可能性があります。\nこのセグメントをスキップして次へ進みますか？"
      );
      if (!shouldSkip) {
        return;
      }
    }

    const updatedMetrics: Record<string, StepMetric[]> = {
      ...segmentMetrics,
      [currentSegment.id]: metricsSnapshot,
    };
    
    // フレームデータとポーズデータも保存
    const updatedFrames: Record<string, ImageData[]> = {
      ...(multiCameraData.segmentFrames || {}),
      [currentSegment.id]: [...framesRef.current],
    };
    
    const updatedPoseResults: Record<string, (FramePoseData | null)[]> = {
      ...(multiCameraData.segmentPoseResults || {}),
      [currentSegment.id]: [...poseResults],
    };

    const nextIndex = currentIndex + 1;
    const hasNext = nextIndex < segments.length;

    const updatedState: MultiCameraState = {
      ...multiCameraData,
      segmentMetrics: updatedMetrics,
      segmentFrames: updatedFrames,
      segmentPoseResults: updatedPoseResults,
      currentIndex: hasNext ? nextIndex : currentIndex,
    };

    setMultiCameraData(updatedState);

    if (hasNext) {
      console.log(`📹 Saving segment ${currentIndex + 1} and loading segment ${nextIndex + 1}`);
      setStatus(`セグメント${currentIndex + 1}を保存しました。セグメント${nextIndex + 1}の動画を読み込みます。`);
      
      // 状態をリセットしてから次のセグメントを処理
      setTimeout(async () => {
        // すべての状態をクリア
        setPoseResults([]);
        setManualContactFrames([]);
        setAutoToeOffFrames([]);
        setManualToeOffFrames([]);
        framesRef.current = [];
        setFramesCount(0);
        
        // 次のセグメントを処理
        // updatedStateを使用して次のセグメントを処理
        setMultiCameraData(updatedState);
        await loadMultiCameraSegment(updatedState, nextIndex);
      }, 500);
      return;
    }

    // ==========================================
    // 🎯 本格的なキャリブレーションベース結合
    // ==========================================
    console.log("🔗 Merging all segment steps with calibration-based coordinates...");
    
    // Homography適用関数（multiCameraAnalysis.tsから）
    const applyHomography = (H: number[][], u: number, v: number): [number, number] => {
      const x = H[0][0] * u + H[0][1] * v + H[0][2];
      const y = H[1][0] * u + H[1][1] * v + H[1][2];
      const w = H[2][0] * u + H[2][1] * v + H[2][2];
      if (Math.abs(w) < 1e-12) return [NaN, NaN];
      return [x / w, y / w];
    };
    
    const mergedSteps: StepMetric[] = [];
    let globalStepIndex = 0;
    let totalTime = 0;
    
    segments.forEach((segment, segIdx) => {
      const segmentSteps = updatedMetrics[segment.id] || [];
      const calibration = segment.calibration;
      
      console.log(`📊 Segment ${segIdx + 1} (${segment.startDistanceM}-${segment.endDistanceM}m): ${segmentSteps.length} steps, segment.id=${segment.id}`);
      
      if (!calibration || !calibration.H_img_to_world) {
        console.warn(`⚠️ Segment ${segIdx + 1} has no calibration data. Using fallback distance calculation.`);
        
        // キャリブレーションがない場合はフォールバック
        segmentSteps.forEach((step, localIdx) => {
          const localDistance = step.distanceAtContact || (localIdx * (step.stride || 0));
          const globalDistance = segment.startDistanceM + localDistance;
          
          console.log(`  [Fallback] Step ${localIdx}: localDistance=${localDistance.toFixed(2)}m + offset=${segment.startDistanceM}m = globalDistance=${globalDistance.toFixed(2)}m`);
          
          mergedSteps.push({
            ...step,
            distanceAtContact: globalDistance,
            index: globalStepIndex++,
            segmentId: segment.id, // セグメント識別子を追加
          });
          
          totalTime += (step.contactTime || 0) + (step.flightTime || 0);
        });
        return;
      }
      
      // ✅ キャリブレーションがある場合：Homographyを使って正確な距離を計算
      console.log(`✅ Segment ${segIdx + 1} has calibration. Applying Homography transformation.`);
      const H = calibration.H_img_to_world;
      console.log(`  📐 H matrix for segment ${segIdx + 1}:`);
      console.log(`    H[0]: [${H[0][0]}, ${H[0][1]}, ${H[0][2]}]`);
      console.log(`    H[1]: [${H[1][0]}, ${H[1][1]}, ${H[1][2]}]`);
      console.log(`    H[2]: [${H[2][0]}, ${H[2][1]}, ${H[2][2]}]`);
      
      // Homography変換ヘルパー関数（ここで定義）
      const applyHomographyLocal = (pixelX: number, pixelY: number): { x: number; y: number } | null => {
        if (!H || H.length !== 3 || H[0].length !== 3) {
          console.warn('⚠️ Invalid Homography matrix');
          return null;
        }
        
        try {
          const w = H[2][0] * pixelX + H[2][1] * pixelY + H[2][2];
          if (Math.abs(w) < 1e-10) return null;
          
          const worldX = (H[0][0] * pixelX + H[0][1] * pixelY + H[0][2]) / w;
          const worldY = (H[1][0] * pixelX + H[1][1] * pixelY + H[1][2]) / w;
          
          return { x: worldX, y: worldY };
        } catch (e) {
          console.error('❌ Homography error:', e);
          return null;
        }
      };
      
      segmentSteps.forEach((step, localIdx) => {
        let localDistance = step.distanceAtContact || 0;
        let recalculatedStride = step.stride;
        
        // 🎯 Homography変換を使用して実世界座標を取得
        if (step.contactPixelX != null && step.contactPixelY != null) {
          const worldPos = applyHomographyLocal(step.contactPixelX, step.contactPixelY);
          
          if (worldPos) {
            // 実世界座標のY成分を距離として使用（走行方向＝y軸）
            // X成分はレーン幅方向（0〜1.22m）、Y成分は走行方向（0〜15m）
            localDistance = Math.abs(worldPos.y - segment.startDistanceM);
            
            console.log(`  🎯 Step ${localIdx}: Pixel(${step.contactPixelX.toFixed(0)}, ${step.contactPixelY.toFixed(0)}) → World(${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)})m (x=lane, y=distance) → localDistance=${localDistance.toFixed(2)}m`);
            
            // 次のステップのピクセル座標があれば、ストライドも再計算
            const nextStep = segmentSteps[localIdx + 1];
            if (nextStep?.contactPixelX != null && nextStep?.contactPixelY != null) {
              const nextWorldPos = applyHomographyLocal(nextStep.contactPixelX, nextStep.contactPixelY);
              if (nextWorldPos) {
                // 実世界座標でのストライドを計算（ユークリッド距離）
                // dx = レーン幅方向の移動, dy = 走行方向の移動
                const dx = nextWorldPos.x - worldPos.x;
                const dy = nextWorldPos.y - worldPos.y;
                recalculatedStride = Math.sqrt(dx * dx + dy * dy);
                
                console.log(`    ✅ Recalculated stride using Homography: ${recalculatedStride.toFixed(2)}m (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}) (was ${step.stride?.toFixed(2) ?? 'N/A'}m)`);
              }
            }
          } else {
            console.warn(`  ⚠️ Step ${localIdx}: Homography failed, using fallback distance`);
          }
        } else {
          console.warn(`  ⚠️ Step ${localIdx}: No pixel coordinates, using fallback distance`);
        }
        
        const globalDistance = segment.startDistanceM + localDistance;
        
        console.log(`  Step ${localIdx}: localDistance=${localDistance.toFixed(2)}m + offset=${segment.startDistanceM}m = globalDistance=${globalDistance.toFixed(2)}m`);
        
        mergedSteps.push({
          ...step,
          stride: recalculatedStride, // TrueStride: Homographyで再計算されたストライド
          fullStride: recalculatedStride ?? undefined, // UIで表示されるfullStrideも更新
          distanceAtContact: globalDistance,
          index: globalStepIndex++,
          segmentId: segment.id,
        });
        
        totalTime += (step.contactTime || 0) + (step.flightTime || 0);
      });
    });
    
    // ==========================================
    // 🔗 セグメント間の重複ステップを検出・統合
    // ==========================================
    console.log("🔍 Detecting and merging overlapping steps between segments...");
    
    // 🎯 Homography補正後の代表ストライドを計算（欠損補間用）
    const validStrides = mergedSteps
      .map(s => s.stride)
      .filter((s): s is number => typeof s === 'number' && s > 0.5 && s < 3.0);
    
    // 中央値を使用（外れ値の影響を受けにくい）
    const sortedStrides = [...validStrides].sort((a, b) => a - b);
    const medianStride = sortedStrides.length > 0 
      ? sortedStrides[Math.floor(sortedStrides.length / 2)]
      : 1.5; // デフォルトは1.5m（補正後の期待値）
    
    console.log(`📏 Representative stride for gap interpolation: ${medianStride.toFixed(2)}m (median of ${validStrides.length} Homography-corrected strides)`);
    console.log(`   Valid strides: ${validStrides.map(s => s.toFixed(2)).join(', ')}`);
    
    const finalSteps: StepMetric[] = [];
    let prevSegmentEndDistance = 0;
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentSteps = mergedSteps.filter(s => {
        // このセグメントに属するステップを抽出
        const dist = s.distanceAtContact || 0;
        return dist >= segment.startDistanceM && dist < segment.endDistanceM;
      });
      
      if (i === 0) {
        // 最初のセグメントはそのまま追加
        finalSteps.push(...segmentSteps);
        prevSegmentEndDistance = segment.endDistanceM;
      } else {
        // 2つ目以降のセグメント：重複区間をチェック
        const overlapThreshold = 0.5; // 0.5m以内なら重複とみなす
        const crossSegmentThreshold = 2.0; // セグメント境界を跨ぐステップの閾値
        
        segmentSteps.forEach(step => {
          const stepDist = step.distanceAtContact || 0;
          
          // 前のセグメントの最後のステップとの距離を確認
          const lastStep = finalSteps[finalSteps.length - 1];
          const lastStepDist = lastStep?.distanceAtContact || 0;
          
          // 重複判定とギャップ補間
          const gap = stepDist - lastStepDist;
          
          // 🎯 改善された重複検出：セグメント境界付近（前セグメント終端±0.5m）のステップをチェック
          const prevSegmentEnd = segments[i - 1]?.endDistanceM || 0;
          const isNearBoundary = Math.abs(lastStepDist - prevSegmentEnd) < 0.5;
          const isStepAcrossBoundary = lastStepDist < prevSegmentEnd && stepDist > prevSegmentEnd;
          
          // セグメント境界を跨ぐステップで、ギャップが通常ストライドの1.5倍以内なら重複の可能性
          const isLikelyDuplicate = isNearBoundary && gap < (medianStride * 1.5);
          
          if (gap < overlapThreshold) {
            // 重複している可能性が高い → スキップ（前のセグメントのデータを優先）
            console.log(`⚠️ Skipping duplicate step at ${stepDist.toFixed(2)}m (gap: ${gap.toFixed(2)}m)`);
          } else if (isLikelyDuplicate && isStepAcrossBoundary) {
            // 🆕 セグメント境界を跨ぐ重複ステップ（同じ接地を両セグメントでマーク）
            console.log(`⚠️ Skipping cross-segment duplicate at ${stepDist.toFixed(2)}m (boundary at ${prevSegmentEnd.toFixed(2)}m, gap: ${gap.toFixed(2)}m)`);
          } else if (gap > crossSegmentThreshold) {
            // 🔴 CRITICAL: ギャップが大きすぎる（2m以上）→ 境界を跨ぐステップが欠落
            // Homography補正後の代表ストライド（中央値）を使用して補間
            const estimatedMissingSteps = Math.floor(gap / medianStride) - 1;
            
            console.log(`🔶 Large gap detected: ${gap.toFixed(2)}m between segments`);
            console.log(`   Last step: ${lastStepDist.toFixed(2)}m, Current step: ${stepDist.toFixed(2)}m`);
            console.log(`   Estimated missing steps: ${estimatedMissingSteps} (using Homography-corrected median stride: ${medianStride.toFixed(2)}m)`);
            
            // 欠落ステップを補間
            for (let j = 1; j <= estimatedMissingSteps; j++) {
              const interpolatedDistance = lastStepDist + (medianStride * j);
              
              // 補間ステップを作成（前のステップをベースに）
              const interpolatedStep: StepMetric = {
                ...lastStep,
                index: finalSteps.length,
                distanceAtContact: interpolatedDistance,
                stride: medianStride, // Homography補正後の代表ストライドを使用
                fullStride: medianStride, // UIで表示されるfullStrideも設定
                // 補間データであることを示すフラグ
                quality: 'warning', // 警告として表示
                isInterpolated: true, // 補間ステップフラグ（ストライド再計算から除外）
              };
              
              console.log(`   ➕ Interpolating step at ${interpolatedDistance.toFixed(2)}m`);
              finalSteps.push(interpolatedStep);
            }
            
            // 現在のステップを追加
            finalSteps.push(step);
          } else {
            // 通常のステップとして追加
            finalSteps.push(step);
          }
        });
        
        prevSegmentEndDistance = segment.endDistanceM;
      }
    }
    
    // 🎯 ChatGPT推奨: TrueStrideをマージ後に再計算（正しい実装）
    // ============================================================
    // 修正A: ストライドは「マージ後」に必ず再計算する
    // - セグメント内計算は捨てる
    // - 全接地をglobalDistでソート後、連続する差分がTrueStride
    // ============================================================
    console.log("\n🔧 === Recalculating TrueStride from globalDistance (ChatGPT method) ===");
    
    // 実測ステップのみをフィルタ（補間は除外）
    const realStepsForStride = finalSteps.filter(s => !s.isInterpolated && Number.isFinite(s.distanceAtContact));
    
    // globalDistでソート（時系列順）
    realStepsForStride.sort((a, b) => (a.distanceAtContact || 0) - (b.distanceAtContact || 0));
    
    console.log(`\n📊 Real steps (excluding interpolated): ${realStepsForStride.length}`);
    console.log(`📋 Calculating TrueStride[i] = globalDist[i+1] - globalDist[i]\n`);
    
    // TrueStrideを計算（各ステップで次の接地までの距離）
    for (let i = 0; i < realStepsForStride.length; i++) {
      const currentDist = realStepsForStride[i].distanceAtContact || 0;
      const nextStep = realStepsForStride[i + 1];
      const nextDist = nextStep?.distanceAtContact;
      
      // 🎯 ChatGPT詳細ログ
      console.log(`[Step ${i}] contactFrame=${realStepsForStride[i].contactFrame}, segmentId=${realStepsForStride[i].segmentId ?? 'N/A'}`);
      console.log(`  contact_globalDist: ${currentDist.toFixed(3)}m`);
      
      if (nextDist != null) {
        const trueStride = nextDist - currentDist;
        console.log(`  next_contact_globalDist: ${nextDist.toFixed(3)}m`);
        console.log(`  TrueStride (difference): ${trueStride.toFixed(3)}m`);
        
        // 異常値フラグ（0.6m未満、2.2m超）
        if (trueStride < 0.6 || trueStride > 2.2) {
          console.warn(`  ⚠️ strideAnomaly: true (unusual stride)`);
          realStepsForStride[i].quality = 'warning'; // UIで赤く表示
        }
        
        // ストライドを更新（1歩分 = trueStride / 2）
        const stepLength = trueStride / 2; // 1歩分の長さ
        realStepsForStride[i].stride = stepLength;
        realStepsForStride[i].fullStride = trueStride; // 2歩分は fullStride に保存
        
        console.log(`  → UPDATED stride to ${stepLength.toFixed(3)}m (full: ${trueStride.toFixed(3)}m)`);
      } else {
        // 最後のステップ: 前のステップの stride を使用
        console.log(`  → Last step, using previous stride if available`);
        if (i > 0 && realStepsForStride[i - 1].stride != null) {
          realStepsForStride[i].stride = realStepsForStride[i - 1].stride;
          realStepsForStride[i].fullStride = realStepsForStride[i - 1].fullStride;
          console.log(`  → COPIED stride from previous step: ${realStepsForStride[i].stride!.toFixed(3)}m`);
        } else {
          realStepsForStride[i].stride = null;
          realStepsForStride[i].fullStride = undefined;
          console.log(`  → No previous stride available, set to null`);
        }
      }
    }
    
    console.log("\n✅ TrueStride recalculation complete (ChatGPT method)\n");
    
    // 🔍 重要: realStepsForStrideは更新されているので、finalStepsも自動的に更新されている
    // （フィルタで作成したrealStepsForStrideは元のfinalStepsの要素への参照を保持）
    // 補間ステップは既にfinalStepsに含まれているので、再構築は不要
    
    // globalDistで再ソート（時系列順に戻す）
    finalSteps.sort((a, b) => (a.distanceAtContact || 0) - (b.distanceAtContact || 0));
    
    console.log(`\n📊 Final steps after TrueStride recalculation: ${finalSteps.length} (real: ${realStepsForStride.length}, interpolated: ${finalSteps.filter(s => s.isInterpolated).length})`);
    
    // グローバルインデックスを再割り当て
    finalSteps.forEach((step, idx) => {
      step.index = idx;
    });
    
    console.log(`✅ Final merged steps: ${finalSteps.length} (removed ${mergedSteps.length - finalSteps.length} duplicates)`);
    
    // 🔍 セグメントごとの整合性チェック（ChatGPT推奨）
    console.log(`\n🔍 === Per-Segment Validation ===`);
    segments.forEach((seg, idx) => {
      const segSteps = finalSteps.filter(s => {
        const dist = s.distanceAtContact || 0;
        return dist >= seg.startDistanceM && dist < seg.endDistanceM;
      });
      
      if (segSteps.length === 0) {
        console.warn(`⚠️ Segment ${idx + 1} (${seg.startDistanceM}-${seg.endDistanceM}m): No steps found`);
        return;
      }
      
      // 最初と最後のステップの距離から区間内カバー距離を計算
      const firstDist = segSteps[0].distanceAtContact || seg.startDistanceM;
      const lastDist = segSteps[segSteps.length - 1].distanceAtContact || seg.endDistanceM;
      const coveredDistance = lastDist - firstDist;
      const segmentLength = seg.endDistanceM - seg.startDistanceM;
      
      console.log(`   Segment ${idx + 1} (${seg.startDistanceM}-${seg.endDistanceM}m):`);
      console.log(`      Steps: ${segSteps.length}`);
      console.log(`      First step: ${firstDist.toFixed(2)}m`);
      console.log(`      Last step: ${lastDist.toFixed(2)}m`);
      console.log(`      Covered distance: ${coveredDistance.toFixed(2)}m`);
      console.log(`      Expected: ${segmentLength.toFixed(2)}m`);
      console.log(`      Avg stride in segment: ${(coveredDistance / segSteps.length).toFixed(2)}m`);
      
      // 整合性警告
      if (Math.abs(coveredDistance - segmentLength) > 0.5) {
        console.warn(`      ⚠️ Distance mismatch: ${Math.abs(coveredDistance - segmentLength).toFixed(2)}m difference`);
      }
    });
    
    const average = (values: Array<number | null | undefined>): number | null => {
      const filtered = values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : null;
    };

    const totalDistance = segments.length
      ? segments[segments.length - 1].endDistanceM - segments[0].startDistanceM
      : run.totalDistanceM;

    // 最終的な総合結果を計算（重複除去後のfinalStepsを使用）
    const finalTotalTime = finalSteps.reduce((sum, s) => sum + (s.contactTime || 0) + (s.flightTime || 0), 0);
    
    // 🎯 重要: 平均ストライドは totalDistance / totalSteps で計算（ChatGPT推奨）
    // これにより、シングルカメラと同じ定義になる
    const realSteps = finalSteps.filter(s => !s.isInterpolated); // 補間ステップを除外
    const avgStrideFromDistance = realSteps.length > 0 ? totalDistance / realSteps.length : null;
    
    // 🔍 整合性チェックログ
    console.log(`\n📊 === Multi-Camera Summary Statistics ===`);
    console.log(`   Total Distance: ${totalDistance.toFixed(2)}m`);
    console.log(`   Total Steps (real): ${realSteps.length}`);
    console.log(`   Avg Stride (totalDist/steps): ${avgStrideFromDistance?.toFixed(2) ?? 'N/A'}m`);
    console.log(`   Total Time: ${finalTotalTime.toFixed(2)}s`);
    console.log(`   Avg Speed (totalDist/time): ${(totalDistance / finalTotalTime).toFixed(2)}m/s`);
    
    setMultiCameraSummary({
      totalDistance,
      totalSegments: segments.length,
      totalSteps: realSteps.length, // 補間ステップを除外
      avgStride: avgStrideFromDistance, // totalDistance / totalSteps
      avgContact: average(realSteps.map((m) => m.contactTime)),
      avgFlight: average(realSteps.map((m) => m.flightTime)),
      avgSpeed: finalTotalTime > 0 ? totalDistance / finalTotalTime : null, // totalDistance / totalTime
      totalTime: finalTotalTime,
      avgSpeedCalculated: finalTotalTime > 0 ? totalDistance / finalTotalTime : null,
    });
    
    // ✅ 結合されたステップデータを保存（Step 9で表示するため）
    setMergedStepMetrics(finalSteps);
    console.log(`💾 Saved ${finalSteps.length} merged steps to state`);

    setStatus("全てのセグメントの解析が完了しました。総合結果を表示します。");
    
    // 結果画面（Step 7）に遷移
    setTimeout(() => {
      setWizardStep(7);
      alert("全てのセグメントの解析が完了しました！\n総合結果を表示しました。");
    }, 500);
  };

  const renderStepContent = () => {
    // マルチカメラモードの専用画面（isMultiCameraSetupがtrueの場合のみ）
if (false /* multi mode disabled */ && isMultiCameraSetup) {
  return (
    <MultiCameraSetup
      athleteId={selectedAthleteId || undefined}
      athleteName={athleteInfo.name || undefined}
      onStartAnalysis={handleNewMultiCameraStart}
      onCancel={() => {
        setIsMultiCameraSetup(false);
        setAnalysisMode('single');
      }}
    />
  );
}

    // マルチカメラ解析処理中（MultiCameraAnalyzer使用）
    // 注: 現在は既存のloadMultiCameraSegmentフローを使用するため、この分岐は使用しない
    // 将来的にキャリブレーション情報を活用する場合はこちらを有効化
    /*
    if (analysisMode === 'multi' && multiCameraProcessing && currentRun && runSegments.length > 0) {
      return (
        <MultiCameraAnalyzer
          run={currentRun}
          segments={runSegments}
          analyzeSingle={async (file: File) => {
            console.log(`🎥 Analyzing segment: ${file.name}`);
            return {
              stepMetrics: [],
              totalFrames: 0,
              successfulPoseFrames: 0,
              poseSuccessRate: 0
            };
          }}
          onBackToSetup={() => {
            setMultiCameraProcessing(false);
            setIsMultiCameraSetup(true);
          }}
        />
      );
    }
    */

    // 通常のシングルカメラモードのステップ処理
    switch (wizardStep) {
      case 0:
      return (
        <div className="wizard-content">
          <div className="wizard-step-header">
            <h2 className="wizard-step-title">ステップ 0: 測定者情報</h2>
            <p className="wizard-step-desc">
              測定者の基本情報を入力してください。身長や目標記録は解析に活用されます。
            </p>
          </div>

          <div
            style={{
              maxWidth: "600px",
              margin: "0 auto",
              background: "white",
              padding: "32px",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            }}
          >
            {/* 登録済み選手から選択 */}
            {athleteOptions.length > 0 && (
              <div
                style={{
                  marginBottom: "24px",
                  padding: "12px 16px",
                  borderRadius: "8px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                }}
              >
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "6px",
                    color: "#0f172a",
                    fontWeight: 600,
                  }}
                >
                  登録済みの選手から選ぶ
                </label>
                <select
                  value={selectedAthleteId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    setSelectedAthleteId(id);

                    // 「選択しない」を選んだらフォームをリセット
                    if (!id) {
                      setAthleteInfo({
                        name: "",
                        age: null,
                        gender: null,
                        affiliation: "",
                        height_cm: null,
                        weight_kg: null,
                        current_record: "",
                        target_record: "",
                      });
                      return;
                    }

                    const selected = athleteOptions.find(
                      (ath) => ath.id === id
                    );
                    if (selected) {
                      setAthleteInfo({
                        name: selected.full_name ?? "",
                        age: selected.age ?? null,
                        gender:
                          (selected.gender as
                            | "male"
                            | "female"
                            | "other"
                            | null) ?? null,
                        affiliation: selected.affiliation ?? "",
                        height_cm: selected.height_cm ?? null,
                        weight_kg: selected.weight_kg ?? null,
                        current_record:
                          selected.current_record_s != null
                            ? String(selected.current_record_s)
                            : "",
                        target_record:
                          selected.target_record_s != null
                            ? String(selected.target_record_s)
                            : "",
                      });
                    }
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    fontSize: "0.95rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: "white",
                  }}
                >
                  <option value="">
                    （選択しない・新しい選手として入力）
                  </option>
                  {athleteOptions.map((ath) => (
                    <option key={ath.id} value={ath.id}>
                      {ath.full_name}
                      {ath.current_record_s != null
                        ? ` / 現在: ${ath.current_record_s.toFixed(2)} 秒`
                        : ""}
                    </option>
                  ))}
                </select>
                <p
                  style={{
                    fontSize: "0.8rem",
                    color: "#64748b",
                    marginTop: "4px",
                  }}
                >
                  選手を選択すると、氏名や身長・記録が下のフォームに自動入力されます。
                </p>
              </div>
            )}

            {/* ここから下は従来のフォーム部分 */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "24px",
              }}
            >
              {/* 氏名 */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontWeight: "bold",
                    marginBottom: "8px",
                    color: "#374151",
                  }}
                >
                  氏名 <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="text"
                  value={athleteInfo.name}
                  onChange={(e) =>
                    setAthleteInfo({ ...athleteInfo, name: e.target.value })
                  }
                  placeholder="山田 太郎"
                  style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "1rem",
                    border: "1px solid #d1d5db",
                    borderRadius: "8px",
                    outline: "none",
                  }}
                />
              </div>

              {/* 年齢と性別 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    年齢 <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="number"
                    value={athleteInfo.age ?? ""}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        age: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                    placeholder="25"
                    min="1"
                    max="120"
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    性別 <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <select
                    value={athleteInfo.gender ?? ""}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        gender: e.target.value
                          ? (e.target.value as
                              | "male"
                              | "female"
                              | "other")
                          : null,
                      })
                    }
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  >
                    <option value="">選択してください</option>
                    <option value="male">男性</option>
                    <option value="female">女性</option>
                    <option value="other">その他</option>
                  </select>
                </div>
              </div>

              {/* 所属 */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontWeight: "bold",
                    marginBottom: "8px",
                    color: "#374151",
                  }}
                >
                  所属（任意）
                </label>
                <input
                  type="text"
                  value={athleteInfo.affiliation}
                  onChange={(e) =>
                    setAthleteInfo({
                      ...athleteInfo,
                      affiliation: e.target.value,
                    })
                  }
                  placeholder="〇〇高校陸上部"
                  style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "1rem",
                    border: "1px solid #d1d5db",
                    borderRadius: "8px",
                    outline: "none",
                  }}
                />
              </div>

              {/* 身長と体重 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                }}
              >
                {/* 身長 */}
                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    身長（cm） <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="number"
                    value={athleteInfo.height_cm ?? ""}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        height_cm: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                    placeholder="170"
                    min="100"
                    max="250"
                    step="0.1"
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  />
                  <p
                    style={{
                      fontSize: "0.85rem",
                      color: "#6b7280",
                      marginTop: "4px",
                    }}
                  >
                    ※ ストライド比の計算に使用されます
                  </p>
                </div>

                {/* 体重 */}
                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    体重（kg） <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="number"
                    value={athleteInfo.weight_kg ?? ""}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        weight_kg: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                    placeholder="48"
                    min="20"
                    max="200"
                    step="0.1"
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  />
                  <p
                    style={{
                      fontSize: "0.85rem",
                      color: "#6b7280",
                      marginTop: "4px",
                    }}
                  >
                    ※ H-FVP計算に使用されます
                  </p>
                </div>
              </div>

              {/* 現在の記録と目標記録 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    現在の記録（任意）
                  </label>
                  <input
                    type="text"
                    value={athleteInfo.current_record}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        current_record: e.target.value,
                      })
                    }
                    placeholder="12.50秒"
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontWeight: "bold",
                      marginBottom: "8px",
                      color: "#374151",
                    }}
                  >
                    目標記録（任意）
                  </label>
                  <input
                    type="text"
                    value={athleteInfo.target_record}
                    onChange={(e) =>
                      setAthleteInfo({
                        ...athleteInfo,
                        target_record: e.target.value,
                      })
                    }
                    placeholder="12.00秒"
                    style={{
                      width: "100%",
                      padding: "12px",
                      fontSize: "1rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "8px",
                      outline: "none",
                    }}
                  />
                  <p
                    style={{
                      fontSize: "0.85rem",
                      color: "#6b7280",
                      marginTop: "4px",
                    }}
                  >
                    ※ AIアドバイスに使用されます
                  </p>
                </div>
              </div>

              {/* 選手情報を保存ボタン */}
              {!selectedAthleteId && (
                <div style={{ 
                  marginTop: '24px',
                  padding: '16px',
                  background: '#f0f9ff',
                  border: '1px solid #bae6fd',
                  borderRadius: '8px'
                }}>
                  <p style={{ 
                    fontSize: '0.9rem', 
                    color: '#0369a1',
                    marginBottom: '12px',
                    fontWeight: '600'
                  }}>
                    💾 この選手情報を保存しますか？
                  </p>
                  <p style={{ 
                    fontSize: '0.85rem', 
                    color: '#0c4a6e',
                    marginBottom: '12px'
                  }}>
                    保存すると、次回から選手を選択するだけで身長・体重が自動入力されます。
                  </p>
                  <button
                    onClick={handleSaveAthlete}
                    style={{
                      padding: '10px 20px',
                      fontSize: '0.95rem',
                      fontWeight: 'bold',
                      color: 'white',
                      background: '#0ea5e9',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#0284c7';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#0ea5e9';
                    }}
                  >
                    💾 選手情報を保存
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 解析モード選択 */}
          <div style={{
            maxWidth: "600px",
            margin: "24px auto",
            background: "white",
            padding: "32px",
            borderRadius: "12px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}>
            <h3 style={{ marginBottom: '16px', fontSize: '1.2rem', fontWeight: 'bold' }}>
              解析モードを選択
            </h3>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '12px 20px',
                background: analysisMode === 'single' ? '#3b82f6' : '#f3f4f6',
                color: analysisMode === 'single' ? 'white' : '#374151',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}>
                <input
                  type="radio"
                  name="analysisMode"
                  value="single"
                  checked={analysisMode === 'single'}
                  onChange={() => setAnalysisMode('single')}
                  style={{ display: 'none' }}
                />
                📹 シングル固定カメラ
              </label>
              
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '12px 20px',
                background: analysisMode === 'panning' ? '#3b82f6' : '#f3f4f6',
                color: analysisMode === 'panning' ? 'white' : '#374151',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}>
                <input
                  type="radio"
                  name="analysisMode"
                  value="panning"
                  checked={analysisMode === 'panning'}
                  onChange={() => setAnalysisMode('panning')}
                  style={{ display: 'none' }}
                />
                🎥 パーン撮影（30-40m推奨）
              </label>
            </div>
          </div>

          <div className="wizard-nav">
            <div></div>
            <button
              className="btn-primary-large"
              onClick={() => {
                if (false /* multi mode disabled */) {
                  // マルチカメラモードの場合は専用UIへ
                  setIsMultiCameraSetup(true);
                } else {
                  // シングルカメラモードは既存フローへ
                  setWizardStep(1);
                  // ローカルストレージの設定を確認してチュートリアルを表示
                  const savedPreference = localStorage.getItem('hideTutorial');
                  if (savedPreference !== 'true') {
                    setShowTutorial(true);
                    setTutorialStep(0);
                  }
                }
              }}
              disabled={
                !athleteInfo.name ||
                !athleteInfo.age ||
                !athleteInfo.gender ||
                !athleteInfo.height_cm ||
                !athleteInfo.weight_kg
              }
            >
              次へ：動画アップロード
            </button>
          </div>
        </div>
      );


      case 1:
  return (
    <div className="wizard-content">
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">ステップ 1: 動画をアップロード</h2>
        <p className="wizard-step-desc">
          {analysisMode === 'panning' 
            ? 'パーン撮影した動画をアップロードしてください。距離は後でスプリット地点ごとに入力します。'
            : '解析したいランニング動画を選択し、走行距離とラベルを入力してください。'
          }
        </p>
        {analysisMode === 'panning' && (
          <div style={{
            marginTop: '12px',
            padding: '12px 16px',
            background: '#dbeafe',
            border: '2px solid #3b82f6',
            borderRadius: '8px',
            fontSize: '0.9rem',
            color: '#1e40af'
          }}>
            <strong>⏱️ パーン撮影モード:</strong> シンプルなタイム測定モードです。動画内でスプリット地点を選択し、区間タイムと距離からH-FVPを算出します。姿勢推定は行いません。
          </div>
        )}
      </div>

      {/* 登録済み選手から選択 */}
      {athleteOptions.length > 0 && (
        <div
          style={{
            marginBottom: "24px",
            padding: "16px",
            borderRadius: "12px",
            background: "#f8fafc",
            border: "2px solid #e2e8f0",
          }}
        >
          <label
            style={{
              display: "block",
              fontSize: "0.95rem",
              marginBottom: "8px",
              color: "#1e293b",
              fontWeight: 600,
            }}
          >
            👤 測定する選手を選択
          </label>
          <select
            value={selectedAthleteId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              setSelectedAthleteId(id);

              if (!id) {
                setAthleteInfo({
                  name: "",
                  age: null,
                  gender: null,
                  affiliation: "",
                  height_cm: null,
                  weight_kg: null,
                  current_record: "",
                  target_record: "",
                });
                return;
              }

              const selected = athleteOptions.find((ath) => ath.id === id);
              if (selected) {
                setAthleteInfo({
                  name: selected.full_name ?? "",
                  age: selected.age ?? null,
                  gender:
                    (selected.gender as "male" | "female" | "other" | null) ??
                    null,
                  affiliation: selected.affiliation ?? "",
                  height_cm: selected.height_cm ?? null,
                  weight_kg: selected.weight_kg ?? null,
                  current_record:
                    selected.current_record_s != null
                      ? String(selected.current_record_s)
                      : "",
                  target_record:
                    selected.target_record_s != null
                      ? String(selected.target_record_s)
                      : "",
                });
              }
            }}
            style={{
              width: "100%",
              padding: "12px",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "2px solid #cbd5e1",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            <option value="">選手を選択してください</option>
            {athleteOptions.map((ath) => (
              <option key={ath.id} value={ath.id}>
                {ath.full_name}
                {ath.height_cm && ` (${ath.height_cm}cm)`}
                {ath.weight_kg && ` ${ath.weight_kg}kg`}
                {ath.current_record_s != null &&
                  ` - 記録: ${ath.current_record_s.toFixed(2)}秒`}
              </option>
            ))}
          </select>
          {selectedAthleteId && athleteInfo.name && (
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                background: "#e0f2fe",
                borderRadius: "8px",
                fontSize: "0.9rem",
                color: "#0c4a6e",
              }}
            >
              ✅ 選択中: <strong>{athleteInfo.name}</strong>
              {athleteInfo.height_cm && ` | 身長: ${athleteInfo.height_cm}cm`}
              {athleteInfo.weight_kg && ` | 体重: ${athleteInfo.weight_kg}kg`}
            </div>
          )}
          <p
            style={{
              fontSize: "0.85rem",
              color: "#64748b",
              marginTop: "8px",
            }}
          >
            💡 H-FVP計算に選手の身長・体重が自動的に使用されます
          </p>
        </div>
      )}

      {/* 1. 走行距離（固定カメラのみ） */}
      {analysisMode !== 'panning' && (
        <div className="input-group">
          <label className="input-label">
            <span className="label-text">
              走行距離 (m) <span style={{ color: "red" }}>*</span>
            </span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={distanceInput}
              onChange={(e) => setDistanceInput(e.target.value)}
              className="input-field"
              placeholder="例: 10"
              style={{
                borderColor:
                  distanceValue && distanceValue > 0
                    ? "var(--success)"
                    : "var(--gray-300)",
              }}
            />
            {distanceValue && distanceValue > 0 && (
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--success)",
                }}
              >
                ✓ 入力済み
              </span>
            )}
          </label>
        </div>
      )}

      {/* 2. 読み込みFPS（コンパクト版） */}
      <div
        style={{
          background: "#f0f9ff",
          border: "1px solid #0ea5e9",
          borderRadius: "12px",
          padding: "12px 16px",
          marginTop: "8px",
          marginBottom: "12px",
        }}
      >
        <div
          style={{
            fontWeight: "bold",
            marginBottom: "8px",
            color: "#0369a1",
            fontSize: "0.95rem",
          }}
        >
          読み込みFPSを選択 <span style={{ color: "#ef4444" }}>※</span>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          {[60, 120, 240].map((fps) => (
            <label
              key={fps}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                padding: "6px 10px",
                borderRadius: 999,
                border:
                  selectedFps === fps
                    ? "2px solid #3b82f6"
                    : "1px solid #e5e7eb",
                background: selectedFps === fps ? "#dbeafe" : "#ffffff",
                fontSize: "0.9rem",
              }}
            >
              <input
                type="radio"
                name="fpsSelection"
                value={fps}
                checked={selectedFps === fps}
                onChange={() => setSelectedFps(fps)}
                style={{
                  width: "16px",
                  height: "16px",
                  accentColor: "#3b82f6",
                }}
              />
              {fps} fps
            </label>
          ))}
        </div>
      </div>

      {/* 3. ラベル（任意） / 4. メモ（任意） */}
      <div className="input-group">
        <label className="input-label">
          <span className="label-text">ラベル（任意）</span>
          <input
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            className="input-field"
            placeholder="例: 100m全力走, フォームチェック など"
          />
        </label>

        <label className="input-label">
          <span className="label-text">メモ（任意）</span>
          <textarea
            value={notesInput}
            onChange={(e) => setNotesInput(e.target.value)}
            className="textarea-field"
            placeholder="気になるポイント・撮影条件などをメモできます。"
            rows={3}
          />
        </label>
      </div>

      {/* 5. 動画ファイルを選択 */}
      <div className="upload-area">
        <label
          className="upload-box"
          style={{
            borderColor: videoFile ? "var(--success)" : "var(--gray-300)",
            background: videoFile
              ? "rgba(16, 185, 129, 0.05)"
              : "var(--gray-50)",
          }}
        >
          <div className="upload-icon">
            {videoFile ? "✅" : "🎥"}
          </div>
          <div className="upload-text">
            {videoFile ? (
              <>
                <strong style={{ color: "var(--success)" }}>
                  ✓ {videoFile.name}
                </strong>
                <span>クリックで別のファイルを選択</span>
              </>
            ) : (
              <>
                <strong>動画ファイルを選択</strong>
                <span>MP4, MOV, AVI など</span>
              </>
            )}
          </div>
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {/* 6. 動画読み込み → 次へ */}
      <div className="wizard-nav">
        <button className="btn-ghost" onClick={() => setWizardStep(0)}>
          前へ：測定者情報
        </button>
        <button
          className="btn-primary-large"
          onClick={() => {
           // ✅ multi の時は multiCameraData から videoFile を復元してみる
if (!videoFile && false /* multi mode disabled */ && multiCameraData) {
  const idx = (multiCameraData as any).currentIndex ?? 0;
  const seg = (multiCameraData as any).segments?.[idx];
  const segAny = seg as any;

  const map = ((multiCameraData as any).videoFiles ?? {}) as Record<string, File>;

  const bySegVideoFile = segAny?.videoFile as File | undefined;
  const byId = seg?.id ? map[seg.id] : undefined;
  const bySegIndex =
    typeof segAny?.segmentIndex === "number" ? map[String(segAny.segmentIndex)] : undefined;
  const byIndex = map[String(idx)];

  const recovered = bySegVideoFile || byId || bySegIndex || byIndex;

  if (recovered) {
    setVideoFile(recovered);

    // videoUrl を使っている構成ならURLも作る（既存のvideoUrlを使っている場合のみ）
    try {
      const url = URL.createObjectURL(recovered);
      setVideoUrl((prev: string | null) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch {
      // videoUrl を使っていない構成なら無視でOK
    }
  }
}

if (true /* single mode */ && !videoFile) {
  alert("動画ファイルを選択してください。");
  return;
}

            // パーン撮影モードは距離チェック不要
            if (
              analysisMode !== 'panning' &&
              (!distanceValue || distanceValue <= 0)
            ) {
              alert("有効な距離を入力してください。");
              return;
            }

            setWizardStep(3);
            setTimeout(() => {
              handleExtractFrames();
            }, 300);
          }}
          disabled={
            !videoFile ||
            (analysisMode !== 'panning' &&
              (!distanceValue || distanceValue <= 0))
          }
        >
          次へ：フレーム抽出（{selectedFps}fps）
        </button>
      </div>
    </div>
  );

      case 3:
        return (
          <div className="wizard-content">
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">ステップ 3: フレーム抽出中</h2>
              <p className="wizard-step-desc">
                動画からフレームを抽出しています。しばらくお待ちください。
              </p>
            </div>

            <div className="progress-area">
              <div className="progress-circle">
                <svg viewBox="0 0 100 100" className="progress-ring">
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="8"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="8"
                    strokeDasharray={`${extractProgress * 2.827}, 282.7`}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="progress-text">{extractProgress}%</div>
              </div>
              <div className="progress-status">{status}</div>
            </div>
            
            {status.includes('❌') && (
              <div className="wizard-actions">
                <button className="btn-ghost" onClick={() => setWizardStep(1)}>
                  最初に戻る
                </button>
              </div>
            )}
          </div>
        );

      case 3.5:
        return (
          <div className="wizard-content">
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">🎥 撮影モード選択</h2>
              <p className="wizard-step-desc">
                動画の撮影方法を選択してください。
              </p>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '24px',
              margin: '32px 0'
            }}>
              {/* 固定カメラモード */}
              <div 
                onClick={() => {
                  setIsPanMode(false);
                  setWizardStep(4);
                  runPoseEstimation();
                }}
                style={{
                  background: !isPanMode ? '#dbeafe' : 'white',
                  border: !isPanMode ? '3px solid #3b82f6' : '2px solid #e5e7eb',
                  borderRadius: '16px',
                  padding: '32px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textAlign: 'center'
                }}
              >
                <div style={{ fontSize: '4rem', marginBottom: '16px' }}>📹</div>
                <h3 style={{ fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '12px', color: '#1f2937' }}>
                  固定カメラ
                </h3>
                <p style={{ fontSize: '0.95rem', color: '#6b7280', marginBottom: '16px', lineHeight: '1.6' }}>
                  カメラを三脚で固定して撮影<br/>
                  <strong>推奨:</strong> 4-6m区間を高精度測定
                </p>
                <div style={{ 
                  background: '#f0f9ff', 
                  padding: '12px', 
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  color: '#0369a1'
                }}>
                  ✅ 高精度<br/>
                  ✅ 安定した検出
                </div>
              </div>

              {/* パン撮影モード */}
              <div 
                onClick={() => {
                  setIsPanMode(true);
                  setWizardStep(4);
                  runPoseEstimation();
                }}
                style={{
                  background: isPanMode ? '#dbeafe' : 'white',
                  border: isPanMode ? '3px solid #3b82f6' : '2px solid #e5e7eb',
                  borderRadius: '16px',
                  padding: '32px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textAlign: 'center'
                }}
              >
                <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🎥</div>
                <h3 style={{ fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '12px', color: '#1f2937' }}>
                  パン撮影（追従）
                </h3>
                <p style={{ fontSize: '0.95rem', color: '#6b7280', marginBottom: '16px', lineHeight: '1.6' }}>
                  カメラで人物を追いながら撮影<br/>
                  <strong>推奨:</strong> 10-20m全体を測定
                </p>
                <div style={{ 
                  background: '#fef3c7', 
                  padding: '12px', 
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  color: '#92400e'
                }}>
                  🚀 10m以上対応<br/>
                  ⚡ 人物を大きく撮影
                </div>
              </div>
            </div>

            <div style={{
              background: '#fffbeb',
              border: '2px solid #fbbf24',
              borderRadius: '12px',
              padding: '20px',
              marginTop: '24px'
            }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#92400e' }}>
                💡 パン撮影のコツ
              </div>
              <ul style={{ fontSize: '0.9rem', color: '#78350f', margin: 0, paddingLeft: '20px' }}>
                <li>人物を画面の中央・大きく保つ（画面の60-80%）</li>
                <li>スムーズに追従（急な動きを避ける）</li>
                <li>120fps で撮影（モーションブラー軽減）</li>
                <li>光学ズームを活用</li>
              </ul>
            </div>
          </div>
        );

      case 4:
        // 人物選択モード
        if (isPersonSelectMode && framesRef.current.length > 0) {
          return (
            <div className="wizard-content">
              <div className="wizard-step-header">
                <h2 className="wizard-step-title">ステップ 4: 人物領域の選択</h2>
                <p className="wizard-step-desc">
                  姿勢推定する人物をマウスでドラッグして囲んでください。
                </p>
              </div>
              
              <div className="video-wrapper">
                <canvas
                  ref={canvasRef}
                  className="video-layer"
                />
                <CanvasRoiSelector
                  canvas={canvasRef.current}
                  enabled={isSelectingPerson}
                  currentFrame={framesRef.current[0] || null}
                  onChangeRoi={(roi: CanvasRoi | null) => {
                    setManualRoi(roi);
                    setIsSelectingPerson(false);
                    if (roi) {
                      // ROIが設定されたら姿勢推定を開始
                      setTimeout(() => {
                        setIsPersonSelectMode(false);
                        runPoseEstimation();
                      }, 500);
                    }
                  }}
                  onCancel={() => {
                    setIsSelectingPerson(false);
                    setIsPersonSelectMode(false);
                    setWizardStep(4);
                  }}
                />
              </div>
              
              {!isSelectingPerson && (
                <div className="wizard-nav">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setIsPersonSelectMode(false);
                      setManualRoi(null);
                      setWizardStep(4);
                    }}
                  >
                    ← 戻る
                  </button>
                  <button
                    className="btn-primary-large"
                    onClick={() => {
                      // 最初のフレームを表示
                      if (framesRef.current[0] && canvasRef.current) {
                        const ctx = canvasRef.current.getContext('2d');
                        if (ctx) {
                          ctx.putImageData(framesRef.current[0], 0, 0);
                        }
                      }
                      setIsSelectingPerson(true);
                    }}
                  >
                    人物を選択 →
                  </button>
                </div>
              )}
            </div>
          );
        }
        
        // 通常の姿勢推定処理
        return (
          <div className="wizard-content">
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">ステップ 4: 姿勢推定中</h2>
              <p className="wizard-step-desc">
                各フレームから姿勢を推定しています。しばらくお待ちください。
              </p>
            </div>

            <div className="progress-area">
              <div className="progress-circle">
                <svg viewBox="0 0 100 100" className="progress-ring">
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="8"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="8"
                    strokeDasharray={`${poseProgress * 2.827}, 282.7`}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="progress-text">{poseProgress}%</div>
              </div>
              <div className="progress-status">{status}</div>
            </div>
            
            
            
            {status.includes('❌') && (
              <div className="wizard-actions">
                <button className="btn-ghost" onClick={() => setWizardStep(1)}>
                  最初に戻る
                </button>
              </div>
            )}
          </div>
        );

      case 5:

        // パーン撮影モードの場合は区間設定・マーカー設定をスキップして結果へ
        if (analysisMode === 'panning') {
          // パーン撮影モード: フレームレートからタイムを算出するのみ
          setSectionStartFrame(0);
          setSectionEndFrame(framesRef.current.length - 1);
          setWizardStep(7); // 直接結果画面へ
          return null;
        }
        
        // マルチカメラモードの場合は区間設定をスキップ
        if (false /* multi mode disabled */) {
          // マルチカメラモードでは区間はすでに設定済みなのでスキップ
          setSectionStartFrame(0);
          setSectionEndFrame(framesRef.current.length - 1);
          setWizardStep(6);
          return null;
        }
        
        // 姿勢推定データがない場合は強制的にステップ4に戻す
        if (poseResults.length === 0) {
          return (
            <div className="wizard-content">
              <div className="wizard-step-header">
                <h2 className="wizard-step-title">⚠️ 姿勢推定が必要です</h2>
              </div>
              <div style={{
                background: '#fef2f2',
                border: '3px solid #dc2626',
                padding: '32px',
                borderRadius: '12px',
                margin: '32px 0',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🚫</div>
                <div style={{ fontWeight: 'bold', marginBottom: '16px', color: '#dc2626', fontSize: '1.3rem' }}>
                  姿勢推定データがありません
                </div>
                <div style={{ fontSize: '1rem', color: '#7f1d1d', marginBottom: '16px' }}>
                  区間設定を行うには、先にステップ4で姿勢推定を実行する必要があります。
                </div>
                <div style={{ fontSize: '0.9rem', color: '#7f1d1d', marginBottom: '24px', padding: '16px', background: 'rgba(255,255,255,0.5)', borderRadius: '8px' }}>
                  <strong>手順:</strong><br/>
                  1. ステップ4に戻る<br/>
                  2. 「姿勢推定を開始」ボタンをクリック<br/>
                  3. 完了まで待つ（数分かかります）<br/>
                  4. 自動的にステップ5に進みます
                </div>
                <button 
                  className="btn-primary-large"
                  onClick={() => {
                    setWizardStep(4);
                    // 姿勢推定を自動開始
                    setTimeout(() => runPoseEstimation(), 500);
                  }}
                  style={{ fontSize: '1.1rem', padding: '16px 32px' }}
                >
                  ステップ4に戻って姿勢推定を実行
                </button>
              </div>
            </div>
          );
        }
        
        // 初回表示時にフレームを描画
        setTimeout(() => {
          if (displayCanvasRef.current && framesRef.current[currentFrame]) {
            const canvas = displayCanvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const frame = framesRef.current[currentFrame];
              
              // canvasサイズを元のフレームサイズに設定
              canvas.width = frame.width;
              canvas.height = frame.height;
              
              // フレームを描画
              ctx.putImageData(frame, 0, 0);
            }
          }
        }, 100);
        
        // スライダーによる区間設定UI（トリミング機能時代のシンプル方式に戻す）
        return (
          <div
            className="wizard-content"
            style={{
              display: 'block',        // flex をやめる
              minHeight: 'auto',       // 余計な縦の高さをなくす
              paddingTop: 16,          // 上の余白はお好みで（px 単位）
            }}
          >
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">ステップ 5: 区間設定</h2>
              <p className="wizard-step-desc">
                スライダーを動かして、スタート・フィニッシュ・中間地点を設定してください。
              </p>
            </div>
            {/* ビデオプレビュー - フレームを直接表示 */}
            <div style={{ marginBottom: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
              <canvas 
                ref={displayCanvasRef}
                style={{
                  width: '100%',
                  height: 'auto',
                  display: 'block',
                  border: '2px solid #e5e7eb',
                  borderRadius: '8px',
                  backgroundColor: '#000'
                }}
              />
              <div style={{ textAlign: 'center', marginTop: '10px', color: '#6b7280' }}>
                現在のフレーム: {currentFrame} / {framesCount - 1}
              </div>
            </div>

{/* 3つのスライダーでの区間設定（コンパクト版） */}
<div
  style={{
    background: '#f9fafb',
    padding: '1rem',
    borderRadius: '12px',
    border: '1px solid #e5e7eb',
  }}
>
  <h3
    style={{
      fontSize: '1rem',
      fontWeight: 'bold',
      marginBottom: '0.75rem',
      color: '#374151',
      textAlign: 'center',
    }}
  >
    ✨ スライダーで区間を設定
  </h3>

  {/* スタート地点スライダー（コンパクト） */}
  <div style={{ marginBottom: '1rem' }}>
    <span
      style={{
        fontSize: '0.9rem',
        fontWeight: 'bold',
        color: '#10b981',
      }}
    >
      🟢 スタート地点
    </span>

    <input
      type="range"
      min={0}
      max={Math.max(framesCount - 1, 0)}
      step={1}
      value={sectionStartFrame ?? 0}
      onChange={(e) => {
        const newFrame = Number(e.target.value);
        setSectionStartFrame(newFrame);
        setCurrentFrame(newFrame);

        const pose = poseResults[newFrame];
        if (pose?.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            setSavedStartHipX((leftHip.x + rightHip.x) / 2);
          }
        }
        setStartLineOffset(0);

        if (displayCanvasRef.current && framesRef.current[newFrame]) {
          const canvas = displayCanvasRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const frame = framesRef.current[newFrame];
            canvas.width = frame.width;
            canvas.height = frame.height;
            ctx.putImageData(frame, 0, 0);
          }
        }
      }}
      className="section-slider start-slider"
      style={{
        width: '100%',
        height: '4px', // 細く
        cursor: 'pointer',
        marginTop: '4px',
        borderRadius: '999px',
      }}
    />
  </div>

  {/* フィニッシュ地点スライダー（コンパクト） */}
  <div style={{ marginBottom: '1rem' }}>
    <span
      style={{
        fontSize: '0.9rem',
        fontWeight: 'bold',
        color: '#ef4444',
      }}
    >
      🔴 フィニッシュ地点
    </span>

    <input
      type="range"
      min={0}
      max={Math.max(framesCount - 1, 0)}
      step={1}
      value={sectionEndFrame ?? framesCount - 1}
      onChange={(e) => {
        const newFrame = Number(e.target.value);
        setSectionEndFrame(newFrame);
        setCurrentFrame(newFrame);

        const pose = poseResults[newFrame];
        if (pose?.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            setSavedEndHipX((leftHip.x + rightHip.x) / 2);
          }
        }
        setEndLineOffset(0);

        if (displayCanvasRef.current && framesRef.current[newFrame]) {
          const canvas = displayCanvasRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const frame = framesRef.current[newFrame];
            canvas.width = frame.width;
            canvas.height = frame.height;
            ctx.putImageData(frame, 0, 0);
          }
        }
      }}
      className="section-slider end-slider"
      style={{
        width: '100%',
        height: '4px',
        cursor: 'pointer',
        marginTop: '4px',
        borderRadius: '999px',
      }}
    />
  </div>

  {/* 中間地点スライダー（コンパクト） */}
  <div style={{ marginBottom: '0.75rem' }}>
    <span
      style={{
        fontSize: '0.9rem',
        fontWeight: 'bold',
        color: '#f59e0b',
      }}
    >
      🟡 中間地点（任意）
    </span>

    <input
      type="range"
      min={0}
      max={Math.max(framesCount - 1, 0)}
      step={1}
      value={sectionMidFrame ?? Math.floor(framesCount / 2)}
      onChange={(e) => {
        const newFrame = Number(e.target.value);
        setSectionMidFrame(newFrame);
        setCurrentFrame(newFrame);

        const pose = poseResults[newFrame];
        if (pose?.landmarks) {
          const leftHip = pose.landmarks[23];
          const rightHip = pose.landmarks[24];
          if (leftHip && rightHip) {
            setSavedMidHipX((leftHip.x + rightHip.x) / 2);
          }
        }
        setMidLineOffset(0);

        if (displayCanvasRef.current && framesRef.current[newFrame]) {
          const canvas = displayCanvasRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const frame = framesRef.current[newFrame];
            canvas.width = frame.width;
            canvas.height = frame.height;
            ctx.putImageData(frame, 0, 0);
          }
        }
      }}
      className="section-slider mid-slider"
      style={{
        width: '100%',
        height: '4px',
        cursor: 'pointer',
        marginTop: '4px',
        borderRadius: '999px',
      }}
    />
  </div>

  {/* 選択範囲の表示（少しだけ残す・高さも縮小） */}
  <div
    style={{
      marginTop: '0.25rem',
      height: '24px',
      background: 'linear-gradient(90deg, #e5e7eb 0%, #e5e7eb 100%)',
      borderRadius: '8px',
      position: 'relative',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        position: 'absolute',
        left: `${
          ((sectionStartFrame ?? 0) / Math.max(framesCount - 1, 1)) * 100
        }%`,
        right: `${
          100 -
          ((sectionEndFrame ?? framesCount - 1) /
            Math.max(framesCount - 1, 1)) *
            100
        }%`,
        height: '100%',
        background: 'linear-gradient(90deg, #10b981 0%, #059669 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: '0.8rem',
        fontWeight: 'bold',
      }}
    >
      選択範囲:{' '}
      {sectionRange.actualCount != null ? sectionRange.actualCount : 0} フレーム
    </div>
  </div>



              {/* 区間情報の表示 */}
              <div style={{
                marginTop: '1.5rem',
                padding: '1rem',
                background: 'white',
                borderRadius: '8px',
                border: '1px solid #d1d5db'
              }}>
                <div style={{ 
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '1rem',
                  textAlign: 'center'
                }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '4px' }}>区間フレーム数</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#374151' }}>
                      {sectionRange.actualCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '4px' }}>区間時間</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#374151' }}>
                      {(() => {
                        const time = sectionTime;
                        if (time === null || time === undefined) return "ー";
                        return time!.toFixed(3);
                      })()} 秒
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '4px' }}>平均速度</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#374151' }}>
                      {(() => {
                        const speed = avgSpeed;
                        if (speed === null || speed === undefined) return "ー";
                        return speed!.toFixed(3);
                      })()} m/s
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 🎯 走行タイプ選択（加速走/スタートダッシュ） */}
            <div style={{
              marginTop: '2rem',
              background: '#f0fdf4',
              border: '2px solid #10b981',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '24px'
            }}>
              <h3 style={{
                fontSize: '1.1rem',
                fontWeight: 'bold',
                marginBottom: '12px',
                color: '#059669'
              }}>
                🏁 走行タイプを選択
              </h3>
              <div style={{
                display: 'flex',
                gap: '12px',
                flexWrap: 'wrap'
              }}>
                <button
                  onClick={() => setRunType('accel')}
                  style={{
                    flex: 1,
                    minWidth: '180px',
                    padding: '16px',
                    borderRadius: '8px',
                    border: runType === 'accel' ? '3px solid #10b981' : '2px solid #d1d5db',
                    background: runType === 'accel' ? '#d1fae5' : 'white',
                    cursor: 'pointer',
                    fontWeight: runType === 'accel' ? 'bold' : 'normal',
                    transition: 'all 0.2s',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ fontSize: '1.3rem', marginBottom: '8px' }}>🏃‍♂️ 加速走（フライング）</div>
                  <div style={{ fontSize: '0.85rem', color: '#065f46', lineHeight: '1.5' }}>
                    <strong>助走あり</strong>のスタート<br/>
                    • スタートラインからの1歩目は特別扱いしない<br/>
                    • 各ストライドは接地→接地で計算<br/>
                    • 10m区間内での貢献距離も表示
                  </div>
                </button>
                <button
                  onClick={() => setRunType('dash')}
                  style={{
                    flex: 1,
                    minWidth: '180px',
                    padding: '16px',
                    borderRadius: '8px',
                    border: runType === 'dash' ? '3px solid #10b981' : '2px solid #d1d5db',
                    background: runType === 'dash' ? '#d1fae5' : 'white',
                    cursor: 'pointer',
                    fontWeight: runType === 'dash' ? 'bold' : 'normal',
                    transition: 'all 0.2s',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ fontSize: '1.3rem', marginBottom: '8px' }}>🚀 スタートダッシュ</div>
                  <div style={{ fontSize: '0.85rem', color: '#065f46', lineHeight: '1.5' }}>
                    <strong>静止状態</strong>からのスタート<br/>
                    • 1歩目は「0m→1st接地」として記録<br/>
                    • スタートダッシュの1歩目として重要<br/>
                    • 2歩目以降は接地→接地で計算
                  </div>
                </button>
              </div>
              <div style={{
                marginTop: '12px',
                padding: '10px',
                background: '#ecfdf5',
                borderRadius: '8px',
                fontSize: '0.85rem',
                color: '#047857'
              }}>
                <strong>📝 選択中:</strong> {runType === 'dash' 
                  ? 'スタートダッシュ - 1歩目は0mからの距離として特別計算'
                  : '加速走 - 全てのステップを接地→接地で均一に計算'}
              </div>
            </div>

           

            <div className="wizard-actions">
              <button className="btn-ghost" onClick={() => setWizardStep(1)}>
                最初に戻る
              </button>
              <button
                className="btn-primary-large"
                onClick={() => {
                  // スライダー値がnullの場合はデフォルト値を設定してから進む
                  if (sectionStartFrame === null) {
                    setSectionStartFrame(Math.floor(framesCount * 0.1));
                  }
                  if (sectionEndFrame === null) {
                    setSectionEndFrame(Math.floor(framesCount * 0.9));
                  }
                  if (sectionMidFrame === null) {
                    setSectionMidFrame(Math.floor(framesCount / 2));
                  }
                  setWizardStep(6);
                }}
              >
                次へ：検出モード選択
              </button>
            </div>
          </div>
        );

/* ===== case 6 START ===== */
case 6: {
  // ✅ case6 内で参照するFPS（未定義変数を使わず、安全に）
  // 基本は selectedFps（あなたのUIで選んだfps）を表示・基準にします。
  // ※ “実際に抽出に使ったfps” を state で持っているなら、その変数に差し替えてOKです。
  const step6Fps = typeof selectedFps === "number" && selectedFps > 0 ? selectedFps : 60;

  return (
    <div className={`wizard-content step-6 ${calibrationType ? "mode-on" : "mode-off"}`}>
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">ステップ 6: 接地・離地マーク</h2>
{/* ✅ 半自動 / 手動 切替（calibrationType=2/3 に直結） */}
<div style={{ display: "flex", gap: 10, margin: "10px 0 14px" }}>
  <button
    type="button"
    className={calibrationType === 2 ? "toggle-btn active" : "toggle-btn"}
    onClick={() => {
      setCalibrationType(2);
      // 切替時は混線防止で一旦クリア（必要なら外してOK）
      setManualContactFrames([]);
      setManualToeOffFrames([]);
      setAutoToeOffFrames([]);
       }}
  >
    半自動
  </button>

  <button
    type="button"
    className={calibrationType === 3 ? "toggle-btn active" : "toggle-btn"}
    onClick={() => {
      setCalibrationType(3);
      setManualContactFrames([]);
      setManualToeOffFrames([]);
      setAutoToeOffFrames([]);
     
    }}
  >
    手動
  </button>
</div>



<div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
  {calibrationType === 3
    ? "手動：接地→離地→接地→離地…の順でマークします（Spaceキー/ボタンどちらでも可）"
    : "半自動：接地のみ手動、離地は自動検出します（Spaceキー/ボタンどちらでも可）"}
</div>

  {/* スマホ・PC共通：説明カード（半自動 / 手動で切替） */}
<div className="step6-helpcard">
  <h3 className="step6-helpcard-title">
    {calibrationType === 3 ? "手動設定" : "半自動設定"}
  </h3>

  {calibrationType === 3 ? (
    <>
      <p className="step6-helpcard-text">
        画面下のボタン（または <strong>Space</strong> キー）で
        <strong>接地 → 離地 → 接地 → 離地…</strong> の順に登録します。
      </p>
      <p className="step6-helpcard-note">
        下の<strong>マーカー一覧</strong>から微調整ができます。
      </p>
    </>
  ) : (
    <>
      <p className="step6-helpcard-text">
        画面下の「<strong>接地マーク</strong>」ボタン（または <strong>Space</strong> キー）で
        <strong>接地</strong>を登録します（離地は自動検出）。
      </p>
      <p className="step6-helpcard-note">
        下の<strong>マーカー一覧</strong>から微調整ができます。
      </p>
    </>
  )}
</div>

      </div>

      {/* モードが有効なときだけ、以下の UI を表示 */}
      {calibrationType ? (
        <div className="step6-layout">
          {/* ===== Sticky（動画/キャンバス + 操作系）===== */}
          <div className="step6-sticky">
            <div className="step6-sticky-inner">
              {/* キャンバス */}
              <div className="step6-canvas-area">
                <div className="step6-canvas-frame">
                  <canvas 
                    ref={displayCanvasRef} 
                    className="preview-canvas"
                    onClick={isCalibrating ? handleConeClick : undefined}
                    style={isCalibrating ? { cursor: 'crosshair' } : undefined}
                  />
                </div>
                {isCalibrating && (
                  <div style={{
                    position: 'absolute',
                    top: '10px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    color: 'white',
                    padding: '15px 25px',
                    borderRadius: '10px',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    zIndex: 1000,
                    textAlign: 'center',
                    maxWidth: '80%',
                  }}>
                    🎯 {calibrationInstructions}
                    <br />
                    <small style={{ fontSize: '12px', opacity: 0.8 }}>
                      ({coneClicks.length}/4) コーンをクリック
                    </small>
                  </div>
                )}
              </div>

              {/* 表示オプション（PC/モバイル） */}
              <div className="step6-controls-row">
                {!isMobile ? (
                  <div className="marker-controls">
                    <button
                      className={footZoomEnabled ? "toggle-btn active" : "toggle-btn"}
                      onClick={() => setFootZoomEnabled((v) => !v)}
                    >
                      足元拡大 {footZoomEnabled ? "ON" : "OFF"}
                    </button>

                    {footZoomEnabled && (
                      <label className="zoom-control">
                        倍率:
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={0.5}
                          value={zoomScale}
                          onChange={(e) => setZoomScale(Number(e.currentTarget.value))}
                        />
                        {zoomScale.toFixed(1)}x
                      </label>
                    )}

                    <button
                      className={showSkeleton ? "toggle-btn active" : "toggle-btn"}
                      onClick={() => setShowSkeleton((v) => !v)}
                      disabled={!poseResults.length}
                    >
                      スケルトン {showSkeleton ? "ON" : "OFF"}
                    </button>

                    <button className="btn-ghost-small" onClick={handleClearMarkers}>
                      マーカークリア
                    </button>
                  </div>
                ) : (
                  <div className="mobile-view-options">
                    <button
                      className={footZoomEnabled ? "toggle-btn active" : "toggle-btn"}
                      onClick={() =>
                        setFootZoomEnabled((prev) => {
                          const next = !prev;
                          if (next) setZoomScale(4.5); // スマホはONで最大寄り
                          return next;
                        })
                      }
                    >
                      足元拡大 {footZoomEnabled ? "ON" : "OFF"}
                    </button>

                    <button
                      className={showSkeleton ? "toggle-btn active" : "toggle-btn"}
                      onClick={() => setShowSkeleton((v) => !v)}
                      disabled={!poseResults.length}
                    >
                      スケルトン {showSkeleton ? "ON" : "OFF"}
                    </button>

                    <button className="btn-ghost-small" onClick={handleClearMarkers}>
                      マーカークリア
                    </button>
                  </div>
                )}
              </div>

              {/* フレームスライダー（PC / モバイル共通） */}
              <div className="frame-control step6-frame-control">
                <div className="frame-info">
                  フレーム: {currentLabel} / {maxLabel} | マーカー数: {contactFrames.length}
                  <span style={{ marginLeft: 10, color: "#6b7280" }}>FPS: {step6Fps}</span>
                </div>

                <input
                  type="range"
                  min={0}
                  max={Math.max(ready ? framesCount - 1 : 0, 0)}
                  step={1}
                  value={ready ? currentFrame : 0}
                  onChange={handleSliderChange}
                  disabled={!ready}
                  className="frame-range"
                />

                <div className="frame-buttons-compact">
                  <button onClick={() => changeFrame(-10)} disabled={!ready}>
                    -10
                  </button>
                  <button onClick={() => changeFrame(-1)} disabled={!ready}>
                    -1
                  </button>
                  <button onClick={() => changeFrame(1)} disabled={!ready}>
                    +1
                  </button>
                  <button onClick={() => changeFrame(10)} disabled={!ready}>
                    +10
                  </button>
                </div>
              </div>

              {/* モバイル：接地/離地インジケータ or 接地マークボタン */}
              {isMobile && (
                <div className="mobile-marker-display step6-mobile-mark">
                  {contactFrames.map((markerFrame, index) => {
                    if (markerFrame === currentFrame) {
                      const isContact = index % 2 === 0;
                      const color = isContact ? "#10b981" : "#ef4444";
                      const label = isContact ? "接地" : "離地";
                      const isAuto = !isContact && calibrationType === 2;

                      return (
                        <div
                          key={index}
                          className="marker-indicator"
                          style={{
                            backgroundColor: color,
                            color: "white",
                            padding: "16px",
                            borderRadius: "12px",
                            fontSize: "22px",
                            fontWeight: "bold",
                            textAlign: "center",
                            boxShadow: "0 4px 8px rgba(0,0,0,0.25)",
                            marginTop: 8,
                          }}
                        >
                          {label} #{Math.floor(index / 2) + 1}
                          {isAuto && (
                            <div style={{ fontSize: "13px", marginTop: "4px" }}>（自動判定）</div>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })}

                  {contactFrames.every((f) => f !== currentFrame) && (
                    <button
                      className="btn-mark-contact-large"
                      onClick={() => {
                        if (!ready) return;

                        if (calibrationType === 2) {
                          // 半自動: 接地のみ手動、離地は自動
                          const newContactFrames = [...manualContactFrames, currentFrame];
                          setManualContactFrames(newContactFrames);

                          const toeOffFrame = detectToeOffFrame(currentFrame);
                          if (toeOffFrame !== null) {
                            setAutoToeOffFrames([...autoToeOffFrames, toeOffFrame]);
                          }
                        } else if (calibrationType === 3) {
                          // 手動: すべて手動
                          if (manualContactFrames.length === manualToeOffFrames.length) {
                            setManualContactFrames([...manualContactFrames, currentFrame]);
                          } else {
                            const lastContact = manualContactFrames[manualContactFrames.length - 1];
                            if (currentFrame <= lastContact) {
                              alert("離地フレームは接地フレームより後にしてください。");
                              return;
                            }
                            setManualToeOffFrames([...manualToeOffFrames, currentFrame]);
                          }
                        }
                      }}
                      disabled={!ready}
                      style={{
                        width: "100%",
                        padding: "18px",
                        fontSize: "18px",
                        fontWeight: "bold",
                        background:
                          calibrationType === 3 && manualContactFrames.length !== manualToeOffFrames.length
                            ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                            : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "white",
                        border: "none",
                        borderRadius: "12px",
                        cursor: "pointer",
                        boxShadow: "0 4px 10px rgba(0,0,0,0.25)",
                        marginTop: 10,
                        touchAction: "manipulation",
                      }}
                    >
                      {calibrationType === 2
                        ? "接地マーク（離地自動）"
                        : manualContactFrames.length === manualToeOffFrames.length
                        ? "接地マーク"
                        : "離地マーク"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ===== Body（スクロールされる領域）===== */}
          <div className="step6-body">
            {/* マーカー一覧（接地・離地の微調整） */}
            {contactFrames.length >= 2 && (
              <div
                style={{
                  marginTop: 16,
                  padding: isMobile ? "12px" : "16px",
                  borderRadius: 12,
                  background: "#f9fafb",
                  maxHeight: isMobile ? "none" : "420px",
                  overflowY: isMobile ? "visible" : "auto",
                }}
              >
                <h4 style={{ margin: "0 0 12px 0", fontWeight: "bold", fontSize: isMobile ? "0.95rem" : "1rem" }}>
                  マーカー一覧（全 {Math.floor(contactFrames.length / 2)} ステップ）
                </h4>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Array.from({ length: Math.floor(contactFrames.length / 2) }, (_: unknown, i: number) => {
                    const contactIdx = i * 2;
                    const toeOffIdx = i * 2 + 1;
                    const contactFrame = contactFrames[contactIdx];
                    const toeOffFrame = contactFrames[toeOffIdx];
                    const isAuto = calibrationType === 2;

                    const isCurrentStep = currentFrame === contactFrame || currentFrame === toeOffFrame;
                    const lastIndex = framesCount && framesCount > 0 ? framesCount - 1 : 0;
                    const clampFrame = (f: number) => Math.min(Math.max(f, 0), lastIndex);

                    return (
                      <div
                        key={i}
                        style={{
                          border: isCurrentStep ? "2px solid #3b82f6" : "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: isMobile ? "8px 10px" : "10px 12px",
                          background: "#ffffff",
                          cursor: ready ? "pointer" : "default",
                        }}
                        onClick={() => {
                          if (!ready) return;
                          const base = manualContactFrames[i] ?? contactFrame ?? currentFrame;
                          const target = clampFrame(typeof base === "number" ? base : 0);
                          changeFrame(target - currentFrame);
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            flexWrap: "wrap",
                            marginBottom: 4,
                          }}
                        >
                          <div>
                            <strong>ステップ {i + 1}</strong>
                            {isAuto && (
                              <span style={{ fontSize: "0.75rem", marginLeft: 6, color: "#6b7280" }}>
                                （離地は自動検出）
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                            接地 {contactFrame} / 離地 {toeOffFrame}
                          </div>
                        </div>

                        {/* 接地微調整 */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                          <span style={{ color: "#10b981", fontWeight: "bold", minWidth: "60px" }}>接地</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!ready) return;
                              const base = manualContactFrames[i] ?? contactFrame ?? currentFrame;
                              const updated = clampFrame((typeof base === "number" ? base : 0) - 1);
                              setManualContactFrames((prev) => {
                                const next = [...prev];
                                next[i] = updated;
                                return next;
                              });
                              changeFrame(updated - currentFrame);
                            }}
                            disabled={!ready}
                          >
                            -1
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!ready) return;
                              const base = manualContactFrames[i] ?? contactFrame ?? currentFrame;
                              const updated = clampFrame((typeof base === "number" ? base : 0) + 1);
                              setManualContactFrames((prev) => {
                                const next = [...prev];
                                next[i] = updated;
                                return next;
                              });
                              changeFrame(updated - currentFrame);
                            }}
                            disabled={!ready}
                          >
                            +1
                          </button>
                        </div>

                        {/* 離地微調整 */}
                        {toeOffFrame != null && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ color: "#ef4444", fontWeight: "bold", minWidth: "60px" }}>離地</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!ready) return;

                                const baseFrame =
                                  (isAuto ? autoToeOffFrames[i] : manualToeOffFrames[i]) ?? toeOffFrame ?? currentFrame;

                                const updated = clampFrame((typeof baseFrame === "number" ? baseFrame : 0) - 1);

                                if (isAuto) {
                                  setAutoToeOffFrames((prev) => {
                                    const next = [...prev];
                                    next[i] = updated;
                                    return next;
                                  });
                                } else {
                                  setManualToeOffFrames((prev) => {
                                    const next = [...prev];
                                    next[i] = updated;
                                    return next;
                                  });
                                }

                                changeFrame(updated - currentFrame);
                              }}
                              disabled={!ready}
                            >
                              -1
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!ready) return;

                                const baseFrame =
                                  (isAuto ? autoToeOffFrames[i] : manualToeOffFrames[i]) ?? toeOffFrame ?? currentFrame;

                                const updated = clampFrame((typeof baseFrame === "number" ? baseFrame : 0) + 1);

                                if (isAuto) {
                                  setAutoToeOffFrames((prev) => {
                                    const next = [...prev];
                                    next[i] = updated;
                                    return next;
                                  });
                                } else {
                                  setManualToeOffFrames((prev) => {
                                    const next = [...prev];
                                    next[i] = updated;
                                    return next;
                                  });
                                }

                                changeFrame(updated - currentFrame);
                              }}
                              disabled={!ready}
                            >
                              +1
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* PC用：キーボード操作説明 */}
            {!isMobile && (
              <div
                style={{
                  background: "#f3f4f6",
                  padding: "16px",
                  borderRadius: "8px",
                  margin: "16px 0",
                  fontSize: "0.9rem",
                }}
              >
                <h4 style={{ margin: "0 0 8px 0", fontWeight: "bold" }}>⌨️ キーボード操作</h4>
                <ul style={{ margin: 0, paddingLeft: "20px" }}>
                  <li>
                    <strong>Space</strong>
                    {calibrationType === 2
                      ? "：接地マーク（離地自動）"
                      : manualContactFrames.length === manualToeOffFrames.length
                      ? "：接地マーク"
                      : "：離地マーク"}
                  </li>
                  <li>
                    <strong>← / →</strong>: 1フレーム移動
                  </li>
                  <li>
                    <strong>↑ / ↓</strong>: 10フレーム移動
                  </li>
                </ul>
              </div>
            )}

            {/* 角度表示：PCのみ */}
            {!isMobile && currentAngles && (
              <div className="angle-display-compact">
                <h4>現在フレームの角度</h4>
                <div className="angle-grid-compact">
                  <div>
                    体幹: {currentAngles.trunkAngle?.toFixed(1)}°
                    <span style={{ fontSize: "0.7rem", marginLeft: "4px", color: "var(--gray-500)" }}>
                      {currentAngles.trunkAngle && currentAngles.trunkAngle < 85
                        ? "(前傾)"
                        : currentAngles.trunkAngle && currentAngles.trunkAngle > 95
                        ? "(後傾)"
                        : "(垂直)"}
                    </span>
                  </div>
                  <div>左膝: {currentAngles.kneeFlex.left?.toFixed(1)}°</div>
                  <div>右膝: {currentAngles.kneeFlex.right?.toFixed(1)}°</div>
                  <div>左肘: {currentAngles.elbowAngle.left?.toFixed(1) ?? "ー"}°</div>
                  <div>右肘: {currentAngles.elbowAngle.right?.toFixed(1) ?? "ー"}°</div>
                </div>
              </div>
            )}

            {/* ナビゲーションボタン */}
            <div className="wizard-actions">
              <button className="btn-ghost" onClick={() => setWizardStep(1)}>
                最初に戻る
              </button>
              <div style={{ display: "flex", gap: "12px" }}>
                <button className="btn-ghost" onClick={() => setWizardStep(5)}>
                  前へ
                </button>
                {false /* multi mode disabled */ && multiCameraData ? (
                  <button 
                    className="btn-primary-large" 
                    onClick={handleMultiSegmentNext} 
                    disabled={contactFrames.length < 3}
                  >
                    {multiCameraData.currentIndex < multiCameraData.segments.length - 1
                      ? `次のセグメントへ (${multiCameraData.currentIndex + 2}/${multiCameraData.segments.length})`
                      : "マルチカメラ解析を完了する"}
                  </button>
                ) : (
                  <button className="btn-primary-large" onClick={() => setWizardStep(7)} disabled={contactFrames.length < 3}>
                    次へ：解析結果
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="step6-mode-hint">
          先にマーカー設定モード（半自動/手動）を選択してください。
        </div>
      )}
    </div>
  );
}
/* ===== case 6 END ===== */







      case 7: {
        const isMultiModeActive = false /* multi mode disabled */ && multiCameraData;
        const currentMultiSegment = isMultiModeActive
          ? multiCameraData.segments[multiCameraData.currentIndex]
          : null;
        const hasNextSegment = isMultiModeActive
          ? multiCameraData.currentIndex < multiCameraData.segments.length - 1
          : false;
        const segmentProgress = isMultiModeActive
          ? multiCameraData.segments.map((segment, idx) => ({
              segment,
              steps: multiCameraData.segmentMetrics[segment.id]?.length ?? 0,
              isCurrent: idx === multiCameraData.currentIndex,
            }))
          : [];
        const isMultiCompleted =
          isMultiModeActive && !hasNextSegment && multiCameraSummary !== null;
        const totalSegments = isMultiModeActive ? multiCameraData.segments.length : 0;
        const currentSegmentIndex = isMultiModeActive ? multiCameraData.currentIndex : -1;
        const nextButtonLabel = hasNextSegment
          ? `次のセグメントへ (${currentSegmentIndex + 2}/${totalSegments})`
          : isMultiCompleted
            ? "解析は完了しています"
            : "マルチカメラ解析を完了する";

        return (
          <div className="wizard-content">
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">
                {analysisMode === 'panning' ? 'ステップ 7: パーン撮影結果' : 'ステップ 8: 解析結果'}
              </h2>
              <p className="wizard-step-desc">
                {analysisMode === 'panning' 
                  ? 'フレームレートから算出したタイムと速度を表示します。'
                  : 'ステップ解析結果とグラフを確認できます。スライダーで各フレームの角度を確認できます。'}
              </p>
            </div>
            
            {/* パーン撮影モード: クリック式スプリットタイマー */}
            {analysisMode === 'panning' && (
              <div>
                {/* 動画プレビューとスプリット登録 */}
                <div style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white',
                  padding: '24px',
                  borderRadius: '12px',
                  marginBottom: '24px',
                  boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                }}>
                  <h3 style={{ 
                    margin: '0 0 16px 0', 
                    fontSize: '1.3rem',
                    fontWeight: 'bold',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                  }}>
                    ⏱️ パーン撮影 - スプリットタイマー
                  </h3>
                  
                  {/* 使い方説明 */}
                  <div style={{
                    marginBottom: '16px',
                    padding: '12px',
                    background: 'rgba(255,255,255,0.15)',
                    borderRadius: '8px',
                    fontSize: '0.9rem',
                    lineHeight: '1.6'
                  }}>
                    <div><strong>📌 使い方:</strong></div>
                    <div>1. 動画下の登録ボタンで各地点を登録</div>
                    <div>2. 最初にスタート地点（0m）を登録</div>
                    <div>3. 次にスプリット地点（10m, 20m...）を登録</div>
                    <div>4. 測定開始点と終了点を選択してH-FVP計算</div>
                  </div>
                  
                  {/* 動画情報 */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: '12px',
                    fontSize: '0.85rem',
                    marginBottom: '16px',
                    padding: '12px',
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: '8px'
                  }}>
                    <div>
                      <div style={{ opacity: 0.8 }}>動画情報</div>
                      <div style={{ fontWeight: 'bold' }}>{framesRef.current.length} frames @ {usedTargetFps ?? '---'} fps</div>
                    </div>
                    <div>
                      <div style={{ opacity: 0.8 }}>総時間</div>
                      <div style={{ fontWeight: 'bold' }}>
                        {usedTargetFps ? (framesRef.current.length / usedTargetFps).toFixed(3) : '---'}s
                      </div>
                    </div>
                    <div>
                      <div style={{ opacity: 0.8 }}>現在フレーム</div>
                      <div style={{ fontWeight: 'bold' }}>{currentFrame} / {framesRef.current.length - 1}</div>
                    </div>
                  </div>

                  {/* 動画プレビュー */}
                  <div style={{ marginBottom: '16px' }}>
                    <canvas 
                      ref={panningCanvasRef}
                      style={{
                        width: '100%',
                        maxWidth: '1400px',
                        height: 'auto',
                        display: 'block',
                        border: '2px solid rgba(255,255,255,0.3)',
                        borderRadius: '8px',
                        backgroundColor: '#000',
                        margin: '0 auto'
                      }}
                    />
                  </div>

                  {/* フレームスライダー */}
                  <div style={{ marginBottom: '16px' }}>
                    <input
                      type="range"
                      min={0}
                      max={framesRef.current.length - 1}
                      value={currentFrame}
                      onChange={(e) => setCurrentFrame(Number(e.target.value))}
                      style={{
                        width: '100%',
                        height: '8px',
                        borderRadius: '4px',
                        background: 'rgba(255,255,255,0.2)',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    />
                  </div>

                </div>
                

                {/* パーン撮影モード: スプリット登録ボタン（動画の下） */}
                {analysisMode === 'panning' && (
                  <div style={{
                    marginTop: '16px',
                    padding: '16px',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    borderRadius: '12px',
                    color: 'white'
                  }}>
                    <div style={{ marginBottom: '12px', fontWeight: 'bold', fontSize: '1.1rem' }}>
                      {panningSplits.length === 0 ? '🏁 スタート地点を登録' : '⏱️ スプリット地点を登録'}
                    </div>
                    
                    {/* 距離入力 */}
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ 
                        display: 'block', 
                        marginBottom: '6px',
                        fontSize: '0.9rem',
                        opacity: 0.9
                      }}>
                        📏 距離 (m):
                      </label>
                      <input
                        type="number"
                        value={distanceInput}
                        onChange={(e) => setDistanceInput(e.target.value)}
                        placeholder={panningSplits.length === 0 ? "0" : `例: ${parseFloat(distanceInput) || 10}`}
                        step="0.1"
                        min="0"
                        style={{
                          width: '100%',
                          padding: '10px',
                          fontSize: '1rem',
                          border: '2px solid rgba(255,255,255,0.3)',
                          borderRadius: '8px',
                          background: 'rgba(255,255,255,0.2)',
                          color: 'white'
                        }}
                      />
                    </div>
                    
                    {/* 登録ボタン */}
                    <button
                      onClick={() => {
                        const frame = currentFrame;
                        const time = usedTargetFps ? frame / usedTargetFps : 0;
                        const distance = parseFloat(distanceInput);
                        
                        // 数値チェック
                        if (isNaN(distance) || distance < 0) {
                          alert('有効な距離を入力してください（0以上の数値）');
                          return;
                        }
                        
                        // スタート地点は0m必須
                        if (panningSplits.length === 0 && distance !== 0) {
                          alert('最初はスタート地点（0m）を登録してください');
                          return;
                        }
                        
                        // 2地点目以降は0より大きい必要
                        if (panningSplits.length > 0 && distance <= 0) {
                          alert('0mより大きい距離を入力してください');
                          return;
                        }
                        
                        // 重複チェック
                        if (panningSplits.some(s => s.distance === distance)) {
                          alert(`${distance}m地点は既に登録されています`);
                          return;
                        }
                        
                        const newSplits: PanningSplit[] = [...(panningSplits || []), { 
                          frame, 
                          time, 
                          distance 
                        }];
                        setPanningSplits(newSplits);
                        
                        // 次の距離提案
                        if (panningSplits.length === 0) {
                          setDistanceInput('10'); // スタート後は10m
                        } else {
                          setDistanceInput(String(distance + 10));
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '14px',
                        fontSize: '1.1rem',
                        fontWeight: 'bold',
                        background: 'rgba(255,255,255,0.3)',
                        border: '2px solid rgba(255,255,255,0.5)',
                        borderRadius: '8px',
                        color: 'white',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.4)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.3)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      {panningSplits.length === 0 
                        ? `🏁 スタート地点を登録 (フレーム ${currentFrame})` 
                        : `➕ スプリット追加 (フレーム ${currentFrame})`
                      }
                    </button>
                    
                    {panningSplits.length === 0 && (
                      <div style={{ 
                        marginTop: '8px', 
                        fontSize: '0.85rem', 
                        opacity: 0.8,
                        textAlign: 'center'
                      }}>
                        💡 まずスタート地点（0m）を登録してください
                      </div>
                    )}
                  </div>
                )}
                
                {/* 測定区間選択（スプリットが2つ以上ある場合のみ表示） */}
                {analysisMode === 'panning' && panningSplits.length >= 2 && (
                  <div style={{
                    marginTop: '16px',
                    padding: '16px',
                    background: 'rgba(59, 130, 246, 0.15)',
                    borderRadius: '12px',
                    border: '2px solid rgba(59, 130, 246, 0.3)'
                  }}>
                    <div style={{ 
                      fontWeight: 'bold', 
                      marginBottom: '12px', 
                      fontSize: '1.1rem',
                      color: '#1e40af'
                    }}>
                      📍 測定区間を選択
                    </div>
                    
                    {/* 開始点選択 */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '0.85rem', marginBottom: '6px', opacity: 0.9, color: '#374151' }}>
                        🟢 開始点を選択: <span style={{ color: '#ef4444', fontWeight: 'bold' }}>（通常は0.0mを選択）</span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {panningSplits.map((split, idx) => (
                          <button
                            key={`start-${idx}`}
                            onClick={() => {
                              // 開始点が終了点より後の場合は警告
                              if (panningEndIndex !== null && idx > panningEndIndex) {
                                alert('開始点は終了点より前に設定してください');
                                return;
                              }
                              setPanningStartIndex(idx);
                            }}
                            style={{
                              padding: '8px 16px',
                              fontSize: '0.9rem',
                              background: panningStartIndex === idx 
                                ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)' 
                                : idx === 0 
                                  ? 'rgba(34, 197, 94, 0.5)' /* 0.0mを強調 */
                                  : 'rgba(34, 197, 94, 0.3)',
                              border: panningStartIndex === idx 
                                ? '2px solid #22c55e' 
                                : idx === 0 
                                  ? '2px solid #22c55e' /* 0.0mを強調 */
                                  : '1px solid rgba(34, 197, 94, 0.5)',
                              borderRadius: '8px',
                              color: panningStartIndex === idx ? 'white' : idx === 0 ? '#065f46' : '#065f46',
                              cursor: 'pointer',
                              fontWeight: panningStartIndex === idx || idx === 0 ? 'bold' : 'normal',
                              transition: 'all 0.2s'
                            }}
                          >
                            {panningStartIndex === idx ? '✓ ' : ''}{idx === 0 ? '🏁 ' : ''}{split.distance.toFixed(1)}m
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    {/* 終了点選択 */}
                    <div>
                      <div style={{ fontSize: '0.85rem', marginBottom: '6px', opacity: 0.9, color: '#374151' }}>
                        🔴 終了点を選択:
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {panningSplits.map((split, idx) => (
                          <button
                            key={`end-${idx}`}
                            onClick={() => {
                              // 終了点が開始点より前の場合は警告
                              if (panningStartIndex !== null && idx < panningStartIndex) {
                                alert('終了点は開始点より後に設定してください');
                                return;
                              }
                              // 開始点と終了点の間隔が1の場合は警告（最低2区間必要）
                              if (panningStartIndex !== null && idx - panningStartIndex < 2) {
                                alert('H-FVP計算には最低3点（2区間）が必要です');
                                return;
                              }
                              setPanningEndIndex(idx);
                            }}
                            style={{
                              padding: '8px 16px',
                              fontSize: '0.9rem',
                              background: panningEndIndex === idx 
                                ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' 
                                : 'rgba(239, 68, 68, 0.3)',
                              border: panningEndIndex === idx ? '2px solid #ef4444' : '1px solid rgba(239, 68, 68, 0.5)',
                              borderRadius: '8px',
                              color: panningEndIndex === idx ? 'white' : '#991b1b',
                              cursor: 'pointer',
                              fontWeight: panningEndIndex === idx ? 'bold' : 'normal',
                              transition: 'all 0.2s'
                            }}
                          >
                            {panningEndIndex === idx ? '✓ ' : ''}{split.distance.toFixed(1)}m
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                
                {/* パーン撮影モード: H-FVP分析結果 デバッグ情報 */}
                {analysisMode === 'panning' && (
                  <div style={{
                    marginTop: '16px',
                    padding: '12px',
                    background: '#f3f4f6',
                    borderRadius: '8px',
                    fontSize: '0.85rem',
                    color: '#1f2937'
                  }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>🔍 H-FVP デバッグ情報:</div>
                    <div>analysisMode: {analysisMode}</div>
                    <div>hfvpResult: {hfvpResult ? '✅ 計算済み' : '❌ null'}</div>
                    <div>panningSplits数: {panningSplits.length}</div>
                    <div>開始点Index: {panningStartIndex !== null ? panningStartIndex : 'null'}</div>
                    <div>終了点Index: {panningEndIndex !== null ? panningEndIndex : 'null'}</div>
                    <div>体重: {athleteInfo.weight_kg ?? 'null'} kg</div>
                    <div>身長: {athleteInfo.height_cm ?? 'null'} cm</div>
                    {hfvpResult && (
                      <div style={{ marginTop: '8px', color: '#10b981', fontWeight: 'bold' }}>
                        ✅ H-FVP計算成功: F0={hfvpResult.F0.toFixed(1)}N, V0={hfvpResult.V0.toFixed(2)}m/s
                      </div>
                    )}
                  </div>
                )}
                
                {/* パーン撮影モード: H-FVP分析結果 */}
                {analysisMode === 'panning' && hfvpResult && (
                  <div style={{
                    background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                    borderRadius: '16px',
                    padding: '24px',
                    marginTop: '24px',
                    marginBottom: '24px',
                    color: 'white',
                    boxShadow: '0 10px 30px rgba(139, 92, 246, 0.3)'
                  }}>
                    <h3 style={{ 
                      margin: '0 0 20px 0', 
                      fontSize: '1.3rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px'
                    }}>
                      ⚡ H-FVP 分析
                      <span style={{ 
                        fontSize: '0.75rem', 
                        padding: '2px 8px', 
                        background: 'rgba(255,255,255,0.2)', 
                        borderRadius: '4px' 
                      }}>
                        Horizontal Force-Velocity Profile
                      </span>
                    </h3>
                    
                    {/* データ品質インジケーター */}
                    <div style={{
                      padding: '12px',
                      background: 'rgba(255,255,255,0.15)',
                      borderRadius: '8px',
                      marginBottom: '16px',
                      fontSize: '0.9rem'
                    }}>
                      {/* 測定モード表示 */}
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '8px',
                        paddingBottom: '8px',
                        borderBottom: '1px solid rgba(255,255,255,0.2)'
                      }}>
                        <span>測定モード:</span>
                        <span style={{ 
                          fontWeight: 'bold',
                          padding: '4px 12px',
                          borderRadius: '12px',
                          background: 'rgba(34, 197, 94, 0.3)',
                          border: '1px solid rgba(34, 197, 94, 0.5)'
                        }}>
                          🎥 パーン撮影
                          {hfvpResult.isPanningHighQuality && ' (高品質)'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>データ品質:</span>
                        <span style={{ fontWeight: 'bold' }}>
                          {hfvpResult.quality.dataQuality === 'excellent' && '🌟 Excellent'}
                          {hfvpResult.quality.dataQuality === 'good' && '✅ Good'}
                          {hfvpResult.quality.dataQuality === 'fair' && '⚠️ Fair'}
                          {hfvpResult.quality.dataQuality === 'poor' && '❌ Poor'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <span>R² (回帰精度):</span>
                        <span style={{ fontWeight: 'bold' }}>{hfvpResult.rSquared.toFixed(3)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <span>データ点数:</span>
                        <span style={{ fontWeight: 'bold' }}>{hfvpResult.dataPoints.length} 区間</span>
                      </div>
                    </div>

                    {/* コアパラメータ */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '12px',
                      marginBottom: '20px'
                    }}>
                      <div style={{
                        padding: '16px',
                        background: 'rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>F0</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.F0.toFixed(1)}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>N</div>
                      </div>
                      <div style={{
                        padding: '16px',
                        background: 'rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>V0</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.V0.toFixed(2)}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>m/s</div>
                      </div>
                      <div style={{
                        padding: '16px',
                        background: 'rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>Pmax</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.Pmax.toFixed(0)}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>W</div>
                      </div>
                      <div style={{
                        padding: '16px',
                        background: 'rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>RFmax</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.RFmax.toFixed(1)}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>%</div>
                      </div>
                    </div>
                    
                    {/* H-FVP評価とトレーニング推奨 */}
                    {(() => {
                      // 目標タイムの取得（文字列 "MM:SS.SSS" から秒数に変換）
                      const parseTimeToSeconds = (timeStr: string): number | null => {
                        if (!timeStr) return null;
                        const parts = timeStr.split(':');
                        if (parts.length === 2) {
                          const minutes = parseFloat(parts[0]);
                          const seconds = parseFloat(parts[1]);
                          return minutes * 60 + seconds;
                        } else if (parts.length === 1) {
                          return parseFloat(parts[0]);
                        }
                        return null;
                      };
                      
                      const targetTime = parseTimeToSeconds(athleteInfo.target_record);
                      const distance = panningEndIndex !== null && panningStartIndex !== null 
                        ? panningSplits[panningEndIndex].distance - panningSplits[panningStartIndex].distance 
                        : 30; // デフォルト30m
                      
                      // 基準値（スプリント専門家の平均的な値）
                      const referenceF0 = athleteInfo.weight_kg ? athleteInfo.weight_kg * 8.5 : 70 * 8.5; // 体重×8.5 N/kg
                      const referenceV0 = 10.5; // m/s (100m 10秒台の選手の平均)
                      
                      // 現在のF0とV0の評価
                      const f0Ratio = hfvpResult.F0 / referenceF0;
                      const v0Ratio = hfvpResult.V0 / referenceV0;
                      
                      // F0評価
                      let f0Status = '';
                      let f0Color = '';
                      if (f0Ratio >= 1.1) {
                        f0Status = '✅ 優位';
                        f0Color = '#10b981';
                      } else if (f0Ratio >= 0.9) {
                        f0Status = '🔵 標準';
                        f0Color = '#3b82f6';
                      } else {
                        f0Status = '⚠️ 改善推奨';
                        f0Color = '#f59e0b';
                      }
                      
                      // V0評価
                      let v0Status = '';
                      let v0Color = '';
                      if (v0Ratio >= 1.1) {
                        v0Status = '✅ 優位';
                        v0Color = '#10b981';
                      } else if (v0Ratio >= 0.9) {
                        v0Status = '🔵 標準';
                        v0Color = '#3b82f6';
                      } else {
                        v0Status = '⚠️ 改善推奨';
                        v0Color = '#f59e0b';
                      }
                      
                      // バランス評価
                      const balanceRatio = f0Ratio / v0Ratio;
                      let balanceStatus = '';
                      let trainingRecommendation = '';
                      
                      if (balanceRatio > 1.2) {
                        balanceStatus = '💪 力（F）優位型';
                        trainingRecommendation = '最大速度トレーニングを重点的に実施してください。\n• 最大速度走（30-60m）\n• フライングスプリント\n• 技術改善（ストライド長の向上）';
                      } else if (balanceRatio < 0.8) {
                        balanceStatus = '⚡ 速度（V）優位型';
                        trainingRecommendation = 'パワー・筋力トレーニングを重点的に実施してください。\n• ウエイトトレーニング（スクワット、デッドリフト）\n• プライオメトリクス（ジャンプ系）\n• 加速トレーニング（0-30m）';
                      } else {
                        balanceStatus = '⚖️ バランス型';
                        trainingRecommendation = 'バランスの取れたプロフィールです。\n• F0とV0の両方を維持しながら総合的に向上\n• 定期的なスピードとパワーの統合トレーニング';
                      }
                      
                      // 目標達成のための分析
                      let targetAnalysis = '';
                      if (targetTime && targetTime > 0) {
                        const requiredSpeed = distance / targetTime;
                        const currentMaxSpeed = hfvpResult.V0;
                        const speedGap = requiredSpeed - currentMaxSpeed;
                        
                        if (speedGap > 0) {
                          targetAnalysis = `目標記録 ${targetTime.toFixed(2)}秒を達成するには、最高速度を ${requiredSpeed.toFixed(2)}m/s まで向上させる必要があります（現在: ${currentMaxSpeed.toFixed(2)}m/s、不足: ${speedGap.toFixed(2)}m/s）。`;
                        } else {
                          targetAnalysis = `現在の最高速度（${currentMaxSpeed.toFixed(2)}m/s）は目標記録達成に十分です。加速能力（F0）とスピード維持を重点的に強化しましょう。`;
                        }
                      }
                      
                      return (
                        <div style={{
                          marginTop: '20px',
                          padding: '20px',
                          background: 'rgba(255,255,255,0.1)',
                          borderRadius: '12px',
                          border: '2px solid rgba(255,255,255,0.2)'
                        }}>
                          <h4 style={{ 
                            margin: '0 0 16px 0',
                            fontSize: '1.1rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                          }}>
                            📊 H-FVPプロフィール評価
                          </h4>
                          
                          {/* F0とV0の評価 */}
                          <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                            gap: '12px',
                            marginBottom: '16px'
                          }}>
                            <div style={{
                              padding: '12px',
                              background: 'rgba(255,255,255,0.08)',
                              borderRadius: '8px',
                              borderLeft: `4px solid ${f0Color}`
                            }}>
                              <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>
                                力（F0）評価
                              </div>
                              <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: f0Color }}>
                                {f0Status}
                              </div>
                              <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '4px' }}>
                                基準値の {(f0Ratio * 100).toFixed(0)}%
                              </div>
                            </div>
                            
                            <div style={{
                              padding: '12px',
                              background: 'rgba(255,255,255,0.08)',
                              borderRadius: '8px',
                              borderLeft: `4px solid ${v0Color}`
                            }}>
                              <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>
                                速度（V0）評価
                              </div>
                              <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: v0Color }}>
                                {v0Status}
                              </div>
                              <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '4px' }}>
                                基準値の {(v0Ratio * 100).toFixed(0)}%
                              </div>
                            </div>
                          </div>
                          
                          {/* バランス評価 */}
                          <div style={{
                            padding: '16px',
                            background: 'rgba(139, 92, 246, 0.2)',
                            borderRadius: '8px',
                            border: '1px solid rgba(139, 92, 246, 0.3)',
                            marginBottom: '16px'
                          }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '1rem' }}>
                              {balanceStatus}
                            </div>
                            <div style={{ fontSize: '0.9rem', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                              {trainingRecommendation}
                            </div>
                          </div>
                          
                          {/* 目標達成分析 */}
                          {targetAnalysis && (
                            <div style={{
                              padding: '16px',
                              background: 'rgba(251, 191, 36, 0.2)',
                              borderRadius: '8px',
                              border: '1px solid rgba(251, 191, 36, 0.3)'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '1rem' }}>
                                🎯 目標達成のための分析
                              </div>
                              <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                                {targetAnalysis}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
                
                {/* パーン撮影モード: 保存ボタン */}
                {analysisMode === 'panning' && panningSplits.length > 0 && (
                  <div className="result-card" style={{ 
                    background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                    border: '3px solid #f59e0b',
                    boxShadow: '0 8px 24px rgba(245, 158, 11, 0.3)',
                    marginTop: '24px'
                  }}>
                    <h3 className="result-card-title" style={{ 
                      fontSize: '1.5rem',
                      color: '#92400e',
                      marginBottom: '20px'
                    }}>
                      💾 保存とエクスポート
                    </h3>

                    <div style={{ display: 'flex', gap: '16px', flexDirection: 'column' }}>
                      <button
                        onClick={handleSaveSession}
                        disabled={saving}
                        style={{
                          padding: '20px 32px',
                          fontSize: '1.3rem',
                          fontWeight: 'bold',
                          borderRadius: '12px',
                          border: '3px solid #10b981',
                          background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                          color: 'white',
                          cursor: saving ? 'not-allowed' : 'pointer',
                          transition: 'all 0.2s',
                          boxShadow: '0 4px 12px rgba(16, 185, 129, 0.4)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '12px',
                          opacity: saving ? 0.6 : 1
                        }}
                        onMouseEnter={(e) => {
                          if (!saving) {
                            (e.target as HTMLButtonElement).style.transform = 'translateY(-4px)';
                            (e.target as HTMLButtonElement).style.boxShadow = '0 8px 20px rgba(16, 185, 129, 0.5)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          (e.target as HTMLButtonElement).style.transform = 'translateY(0)';
                          (e.target as HTMLButtonElement).style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.4)';
                        }}
                      >
                        <span style={{ fontSize: '1.5rem' }}>💾</span>
                        <span>{saving ? '保存中...' : 'サーバーに保存する'}</span>
                      </button>
                    </div>

                    {saveResult && (
                      <div style={{ 
                        marginTop: '16px',
                        padding: '12px 16px',
                        background: saveResult.includes('成功') ? '#d1fae5' : '#fee2e2',
                        color: saveResult.includes('成功') ? '#065f46' : '#991b1b',
                        borderRadius: '8px',
                        fontWeight: 'bold',
                        fontSize: '1.05rem',
                        textAlign: 'center'
                      }}>
                        {saveResult}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {isMultiModeActive && currentMultiSegment && (
              <div
                style={{
                  border: "1px solid #bfdbfe",
                  background: "#eff6ff",
                  padding: "16px",
                  borderRadius: "12px",
                  marginBottom: "20px",
                  color: "#1e3a8a",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: "4px" }}>マルチカメラモード</div>
                <div style={{ fontSize: "0.95rem", marginBottom: "4px" }}>
                  セグメント {currentSegmentIndex + 1} / {totalSegments} （{currentMultiSegment.startDistanceM}m〜{currentMultiSegment.endDistanceM}m）
                </div>
                <div style={{ fontSize: "0.8rem", color: "#475569" }}>
                  ステップのマーキングを完了したら、下のボタンで次のセグメントに進んでください。
                </div>
              </div>
            )}

            {isMultiModeActive && segmentProgress.length > 0 && (
              <div
                style={{
                  border: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  padding: "16px",
                  borderRadius: "12px",
                  marginBottom: "20px",
                }}
              >
                <h4 style={{ margin: "0 0 8px", fontSize: "0.95rem", color: "#1e293b" }}>セグメント進捗</h4>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "0.9rem", color: "#1f2937" }}>
                  {segmentProgress.map(({ segment, steps, isCurrent }, idx) => (
                    <li key={segment.id}>
                      セグメント {idx + 1} （{segment.startDistanceM}m〜{segment.endDistanceM}m）:
                      ステップ {steps}件 {isCurrent ? "（解析中）" : steps > 0 ? "✓" : "未解析"}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isMultiModeActive && multiCameraSummary && (
              <div
                style={{
                  border: "1px solid #d1fae5",
                  background: "#ecfdf5",
                  padding: "16px",
                  borderRadius: "12px",
                  marginBottom: "20px",
                  color: "#065f46",
                }}
              >
                <h4 style={{ margin: "0 0 8px", fontSize: "0.95rem" }}>マルチカメラ総合結果</h4>
                <div style={{ fontSize: "0.9rem" }}>
                  <div>総距離: {multiCameraSummary.totalDistance.toFixed(1)}m</div>
                  <div>セグメント数: {multiCameraSummary.totalSegments}</div>
                  <div>総ステップ数: {multiCameraSummary.totalSteps}歩</div>
                  <div>平均ストライド: {multiCameraSummary.avgStride != null ? `${multiCameraSummary.avgStride.toFixed(2)}m` : "ー"}</div>
                  <div>平均接地時間: {multiCameraSummary.avgContact != null ? `${multiCameraSummary.avgContact.toFixed(3)}s` : "ー"}</div>
                  <div>平均滞空時間: {multiCameraSummary.avgFlight != null ? `${multiCameraSummary.avgFlight.toFixed(3)}s` : "ー"}</div>
                  <div>平均速度: {multiCameraSummary.avgSpeed != null ? `${multiCameraSummary.avgSpeed.toFixed(2)}m/s` : "ー"}</div>
                </div>
              </div>
            )}

            {isMultiModeActive && (
              <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap" }}>
                <button
                  className="btn-primary-large"
                  onClick={handleMultiSegmentNext}
                  disabled={!hasNextSegment && !!isMultiCompleted}
                >
                  {nextButtonLabel}
                </button>
                <button className="btn-ghost" onClick={handleCancelMultiCamera}>
                  マルチカメラ設定に戻る
                </button>
              </div>
            )}
            
            {/* スクロールボタン（iPad/モバイル用） */}
            <div style={{
              position: 'fixed',
              bottom: '20px',
              right: '20px',
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px'
            }}>
              <button
                onClick={() => document.getElementById('frame-viewer')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                style={{
                  width: '50px',
                  height: '50px',
                  borderRadius: '50%',
                  background: 'rgba(103, 126, 234, 0.9)',
                  color: 'white',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                title="フレームビューアーへ"
              >
                ↑
              </button>
              <button
                onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}
                style={{
                  width: '50px',
                  height: '50px',
                  borderRadius: '50%',
                  background: 'rgba(118, 75, 162, 0.9)',
                  color: 'white',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                title="ページ下部へ"
              >
                ↓
              </button>
            </div>

            {/* フレームビューアー */}
            <div className="result-viewer-card" id="frame-viewer">
              <div className="viewer-controls">
                <button
                  className={footZoomEnabled ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setFootZoomEnabled((v) => !v)}
                >
                  足元拡大 {footZoomEnabled ? "ON" : "OFF"}
                </button>
                {footZoomEnabled && (
                  <label className="zoom-control">
                    倍率:
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={0.5}
                      value={zoomScale}
                      onChange={(e) => setZoomScale(Number(e.target.value))}
                    />
                    {zoomScale.toFixed(1)}x
                  </label>
                )}
                <button
                  className={showSkeleton ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setShowSkeleton((v) => !v)}
                  disabled={!poseResults.length}
                >
                  スケルトン {showSkeleton ? "ON" : "OFF"}
                </button>
              </div>

              {/* マルチカメラの場合：動画セグメント切り替えタブ */}
              {isMultiModeActive && multiCameraData && multiCameraData.segments.length > 1 && (
                <div style={{
                  display: 'flex',
                  gap: '8px',
                  marginBottom: '12px',
                  flexWrap: 'wrap'
                }}>
                  {multiCameraData.segments.map((segment, idx) => (
                    <button
                      key={segment.id}
                      onClick={() => {
                        setCurrentVideoSegmentIndex(idx);
                        
                        // 対応する動画を読み込む
                        const videoFile = multiCameraData.videoFiles[segment.id];
                        if (videoFile && videoRef.current) {
                          const url = URL.createObjectURL(videoFile);
                          videoRef.current.src = url;
                          videoRef.current.load();
                          console.log(`📹 Switched to segment ${idx + 1} video`);
                        }
                        
                        // フレームデータを復元
                        const segmentFrames = multiCameraData.segmentFrames?.[segment.id];
                        if (segmentFrames && segmentFrames.length > 0) {
                          framesRef.current = segmentFrames;
                          setFramesCount(segmentFrames.length);
                          setCurrentFrame(0);
                          console.log(`🖼️ Restored ${segmentFrames.length} frames for segment ${idx + 1}`);
                        }
                        
                        // ポーズデータを復元
                        const segmentPoses = multiCameraData.segmentPoseResults?.[segment.id];
                        if (segmentPoses && segmentPoses.length > 0) {
                          setPoseResults(segmentPoses);
                          console.log(`🤸 Restored ${segmentPoses.length} pose results for segment ${idx + 1}`);
                        }
                      }}
                      style={{
                        padding: '8px 16px',
                        borderRadius: '8px',
                        border: currentVideoSegmentIndex === idx ? '2px solid #3b82f6' : '1px solid #cbd5e1',
                        background: currentVideoSegmentIndex === idx ? '#dbeafe' : '#f8fafc',
                        color: currentVideoSegmentIndex === idx ? '#1e40af' : '#475569',
                        fontWeight: currentVideoSegmentIndex === idx ? 600 : 400,
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                      }}
                    >
                      📹 {segment.startDistanceM}-{segment.endDistanceM}m
                    </button>
                  ))}
                </div>
              )}

              <div className="canvas-area" style={{ position: 'relative' }}>
                <canvas 
                  ref={displayCanvasRef} 
                  className="preview-canvas"
                  onClick={isCalibrating ? handleConeClick : undefined}
                  style={isCalibrating ? { cursor: 'crosshair' } : undefined}
                />
                {isCalibrating && (
                  <div style={{
                    position: 'absolute',
                    top: '10px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    color: 'white',
                    padding: '15px 25px',
                    borderRadius: '10px',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    zIndex: 1000,
                    textAlign: 'center',
                    maxWidth: '80%',
                  }}>
                    🎯 {calibrationInstructions}
                    <br />
                    <small style={{ fontSize: '12px', opacity: 0.8 }}>
                      ({coneClicks.length}/4) コーンをクリック
                    </small>
                  </div>
                )}
              </div>

              {/* フレームスライダー（PC / モバイル共通） */}
              <div
                className="frame-control"
                style={{ marginTop: 8, position: 'static', zIndex: 1 }}
              >
                <div className="frame-info">
                  フレーム: {currentLabel} / {maxLabel} | マーカー数: {contactFrames.length}
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(ready ? framesCount - 1 : 0, 0)}
                  step={1}
                  value={ready ? currentFrame : 0}
                  onChange={handleSliderChange}
                  disabled={!ready}
                  className="frame-range"
                />
                <div className="frame-buttons-compact">
                  <button onClick={() => changeFrame(-10)} disabled={!ready}>
                    -10
                  </button>
                  <button onClick={() => changeFrame(-1)} disabled={!ready}>
                    -1
                  </button>
                  <button onClick={() => changeFrame(1)} disabled={!ready}>
                    +1
                  </button>
                  <button onClick={() => changeFrame(10)} disabled={!ready}>
                    +10
                  </button>
                </div>
              </div>



              {/* 現在フレームの関節角度（フレームスライダー連動） */}
              {currentAngles && (
                <div className="angle-display-result">
                  <h4>現在フレーム ({currentFrame}) の関節角度と足先距離</h4>
                  <p style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem', marginBottom: '0.75rem' }}>
                    ※ 大腿角度：鉛直下向きを0°、前方がマイナス（-）、後方がプラス（+）<br/>
                    ※ 足先距離：大転子から鉛直下方向を0cm、前方がマイナス（-）、後方がプラス（+）
                  </p>
                  
                  <div className="angle-grid-result">
                    <div className="angle-item">
                      <span className="angle-label">体幹角度</span>
                      <span className="angle-value">{currentAngles.trunkAngle?.toFixed(1)}°</span>
                      <span className="angle-hint">
                        {currentAngles.trunkAngle && currentAngles.trunkAngle < 85 ? '前傾' : 
                         currentAngles.trunkAngle && currentAngles.trunkAngle > 95 ? '後傾' : '垂直'}
                      </span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">左 大腿角</span>
                      <span className="angle-value">{currentAngles.thighAngle.left?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">右 大腿角</span>
                      <span className="angle-value">{currentAngles.thighAngle.right?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">左 足先距離</span>
                      <span className="angle-value">{currentAngles.toeHorizontalDistance.left?.toFixed(1) ?? 'ー'}cm</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">右 足先距離</span>
                      <span className="angle-value">{currentAngles.toeHorizontalDistance.right?.toFixed(1) ?? 'ー'}cm</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">左 膝屈曲</span>
                      <span className="angle-value">{currentAngles.kneeFlex.left?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">右 膝屈曲</span>
                      <span className="angle-value">{currentAngles.kneeFlex.right?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">左 足首</span>
                      <span className="angle-value">{currentAngles.ankleFlex.left?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">右 足首</span>
                      <span className="angle-value">{currentAngles.ankleFlex.right?.toFixed(1)}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">左 肘屈曲</span>
                      <span className="angle-value">{currentAngles.elbowAngle.left?.toFixed(1) ?? 'ー'}°</span>
                    </div>
                    <div className="angle-item">
                      <span className="angle-label">右 肘屈曲</span>
                      <span className="angle-value">{currentAngles.elbowAngle.right?.toFixed(1) ?? 'ー'}°</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="results-layout">
              {/* AI評価セクション */}
              {runningEvaluation && (
                <div className="result-card" style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white'
                }}>
                  <h3 className="result-card-title" style={{ color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    🤖 AI フォーム評価
                  </h3>
                  
                  {/* 総合評価 */}
                  <div style={{
                    padding: '20px',
                    background: 'rgba(255,255,255,0.15)',
                    borderRadius: '12px',
                    marginBottom: '20px',
                    textAlign: 'center'
                  }}>
                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '8px' }}>
                      {runningEvaluation.overallRating}
                    </div>
                    <div style={{ fontSize: '0.95rem', opacity: 0.9 }}>
                      {runningEvaluation.overallMessage}
                    </div>
                    <div style={{ 
                      marginTop: '12px', 
                      display: 'flex', 
                      gap: '4px', 
                      justifyContent: 'center',
                      alignItems: 'center'
                    }}>
                      {[1, 2, 3, 4].map(i => (
                        <div
                          key={i}
                          style={{
                            width: '40px',
                            height: '8px',
                            borderRadius: '4px',
                            background: i <= runningEvaluation.avgScore 
                              ? 'rgba(255,255,255,0.9)' 
                              : 'rgba(255,255,255,0.2)'
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* 詳細評価 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {runningEvaluation.evaluations.map((evaluation, index) => (
                      <div
                        key={index}
                        style={{
                          padding: '16px',
                          background: 'rgba(255,255,255,0.1)',
                          borderRadius: '12px',
                          borderLeft: '4px solid ' + (
                            evaluation.score === 'excellent' ? '#10b981' :
                            evaluation.score === 'good' ? '#3b82f6' :
                            evaluation.score === 'fair' ? '#f59e0b' :
                            '#ef4444'
                          )
                        }}
                      >
                        <div style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '8px',
                          marginBottom: '8px'
                        }}>
                          <span style={{ fontSize: '1.5rem' }}>{evaluation.icon}</span>
                          <div>
                            <div style={{ fontWeight: 'bold', fontSize: '1rem' }}>
                              {evaluation.category}
                            </div>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>
                              {evaluation.message}
                            </div>
                          </div>
                        </div>
                        <div style={{ 
                          fontSize: '0.85rem', 
                          lineHeight: '1.5',
                          opacity: 0.85,
                          paddingLeft: '36px'
                        }}>
                          💡 {evaluation.advice}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 100m目標記録入力セクション */}
              <div className="result-card">
                <h3 className="result-card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  🎯 100m 目標記録アドバイス
                </h3>
                
                <div style={{ marginBottom: '20px' }}>
                  {/* 被検者情報から目標記録を自動表示 */}
                  {athleteInfo.target_record && (
                    <div style={{
                      padding: '12px 16px',
                      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                      borderRadius: '8px',
                      marginBottom: '16px',
                      border: '1px solid #7dd3fc'
                    }}>
                      <div style={{ fontSize: '0.85rem', color: '#0369a1', marginBottom: '4px' }}>
                        📋 被検者情報で設定した目標記録
                      </div>
                      <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#0c4a6e' }}>
                        {athleteInfo.target_record}
                      </div>
                    </div>
                  )}
                  
                  <label style={{ 
                    display: 'block', 
                    marginBottom: '8px',
                    fontSize: '0.95rem',
                    fontWeight: 'bold',
                    color: '#374151'
                  }}>
                    100mの目標タイム（秒）{athleteInfo.target_record ? '※修正可能' : ''}
                  </label>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <input
                      type="number"
                      step="0.1"
                      min="10"
                      max="30"
                      value={target100mInput || (athleteInfo.target_record ? parseFloat(athleteInfo.target_record.replace(/[^0-9.]/g, '')) || '' : '')}
                      onChange={(e) => setTarget100mInput(e.target.value)}
                      placeholder="例: 14.5"
                      style={{
                        flex: 1,
                        padding: '12px',
                        fontSize: '1.1rem',
                        borderRadius: '8px',
                        border: '2px solid #e5e7eb',
                        background: 'white',
                        color: '#1f2937'
                      }}
                    />
                    <button
                      onClick={() => {
                        // 入力値または被検者情報の目標記録を使用
                        const inputValue = target100mInput || (athleteInfo.target_record ? athleteInfo.target_record.replace(/[^0-9.]/g, '') : '');
                        const targetTime = parseFloat(inputValue);
                        if (isNaN(targetTime) || targetTime <= 0) {
                          alert('正しい目標タイムを入力してください（例: 14.5秒）');
                          return;
                        }
                        if (targetTime < 9 || targetTime > 30) {
                          alert('目標タイムは9秒〜30秒の範囲で入力してください');
                          return;
                        }
                        const advice = generateTargetAdvice(targetTime, 'topSpeed');
                        setTargetAdvice(advice);
                      }}
                      style={{
                        padding: '12px 24px',
                        fontSize: '1rem',
                        fontWeight: 'bold',
                        borderRadius: '8px',
                        border: 'none',
                        background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                        color: 'white',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        boxShadow: '0 4px 6px rgba(245, 87, 108, 0.3)'
                      }}
                    >
                      アドバイス生成
                    </button>
                  </div>
                </div>

                {targetAdvice && (
                  <div style={{
                    padding: '24px',
                    background: 'white',
                    borderRadius: '12px',
                    border: '1px solid #e5e7eb',
                    fontSize: '0.95rem',
                    lineHeight: '1.8',
                    maxHeight: '600px',
                    overflowY: 'auto',
                    color: '#1f2937'
                  }}>
                    {/* Markdownスタイルのテキストを見やすく表示 */}
                    <div style={{
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                    }}>
                      {targetAdvice.split('\n').map((line, i) => {
                        // 見出し1 (###)
                        if (line.startsWith('### ')) {
                          return (
                            <h3 key={i} style={{
                              fontSize: '1.3rem',
                              fontWeight: 'bold',
                              marginTop: i === 0 ? '0' : '24px',
                              marginBottom: '12px',
                              color: '#1f2937',
                              borderBottom: '2px solid #f093fb',
                              paddingBottom: '8px'
                            }}>
                              {line.replace('### ', '')}
                            </h3>
                          );
                        }
                        // 見出し2 (####)
                        if (line.startsWith('#### ')) {
                          return (
                            <h4 key={i} style={{
                              fontSize: '1.15rem',
                              fontWeight: 'bold',
                              marginTop: '16px',
                              marginBottom: '8px',
                              color: '#374151'
                            }}>
                              {line.replace('#### ', '')}
                            </h4>
                          );
                        }
                        // 見出し3 (#)
                        if (line.startsWith('## ')) {
                          return (
                            <h2 key={i} style={{
                              fontSize: '1.5rem',
                              fontWeight: 'bold',
                              marginTop: i === 0 ? '0' : '28px',
                              marginBottom: '16px',
                              color: '#111827',
                              borderBottom: '3px solid #f5576c',
                              paddingBottom: '10px'
                            }}>
                              {line.replace('## ', '')}
                            </h2>
                          );
                        }
                        // 箇条書き (-)
                        if (line.trim().startsWith('- ')) {
                          return (
                            <div key={i} style={{
                              marginLeft: '20px',
                              marginBottom: '6px',
                              display: 'flex',
                              gap: '8px'
                            }}>
                              <span style={{ color: '#f093fb', fontWeight: 'bold' }}>•</span>
                              <span>{line.trim().replace('- ', '')}</span>
                            </div>
                          );
                        }
                        // 数字付き箇条書き (1. 2. など)
                        if (/^\d+\.\s/.test(line.trim())) {
                          return (
                            <div key={i} style={{
                              marginLeft: '20px',
                              marginBottom: '6px',
                              display: 'flex',
                              gap: '8px'
                            }}>
                              <span style={{ 
                                color: '#f5576c', 
                                fontWeight: 'bold',
                                minWidth: '24px'
                              }}>
                                {line.trim().match(/^\d+\./)?.[0]}
                              </span>
                              <span>{line.trim().replace(/^\d+\.\s/, '')}</span>
                            </div>
                          );
                        }
                        // 引用 (>)
                        if (line.trim().startsWith('> ')) {
                          return (
                            <div key={i} style={{
                              background: '#f3f4f6',
                              borderLeft: '4px solid #f093fb',
                              padding: '12px 16px',
                              marginTop: '12px',
                              marginBottom: '12px',
                              borderRadius: '0 8px 8px 0',
                              fontStyle: 'italic',
                              color: '#4b5563'
                            }}>
                              {line.replace('> ', '')}
                            </div>
                          );
                        }
                        // 区切り線 (---)
                        if (line.trim() === '---') {
                          return (
                            <hr key={i} style={{
                              border: 'none',
                              borderTop: '2px solid #e5e7eb',
                              margin: '24px 0'
                            }} />
                          );
                        }
                        // 太字 (**)
                        if (line.includes('**')) {
                          const parts = line.split('**');
                          return (
                            <p key={i} style={{ marginBottom: '8px', color: '#374151' }}>
                              {parts.map((part, j) => 
                                j % 2 === 1 ? <strong key={j} style={{ color: '#1f2937' }}>{part}</strong> : part
                              )}
                            </p>
                          );
                        }
                        // 通常のテキスト
                        if (line.trim()) {
                          return (
                            <p key={i} style={{ 
                              marginBottom: '8px',
                              color: '#374151'
                            }}>
                              {line}
                            </p>
                          );
                        }
                        // 空行
                        return <div key={i} style={{ height: '8px' }} />;
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* ナビゲーションボタン */}
              <div style={{ marginTop: '32px', display: 'flex', gap: '12px', justifyContent: 'space-between', alignItems: 'center' }}>
                <button
                  className="btn-ghost"
                  onClick={() => setWizardStep(1)}
                >
                  最初に戻る
                </button>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    className="wizard-btn secondary"
                    onClick={() => setWizardStep(7)}
                  >
                    前へ: マーカー設定
                  </button>
                  <button
                    className="wizard-btn"
                    onClick={() => setWizardStep(8)}
                    style={{
                      background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
                      border: 'none',
                      boxShadow: '0 4px 12px rgba(251, 191, 36, 0.4)'
                    }}
                  >
                    次へ: データ詳細（プロ版） 🔒
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case 8:
        return (
          <div className="wizard-content">
            <div className="wizard-step-header">
              <h2 className="wizard-step-title">ステップ 9: データ詳細（プロ版）</h2>
              <p className="wizard-step-desc">
                詳細なステップメトリクス、グラフ、関節角度データを確認できます。
              </p>
              
              {/* ベータ版案内 */}
              <div style={{
                padding: '16px',
                background: 'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)',
                borderRadius: '12px',
                marginTop: '20px',
                color: 'white',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(6, 182, 212, 0.3)'
              }}>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '8px' }}>
                  🚀 ベータ版として公開中
                </div>
                <div style={{ fontSize: '0.95rem', lineHeight: '1.6' }}>
                  現在、このページの機能は全ユーザーに無料で公開されています。<br />
                  正式版リリース後は、プロ版会員限定機能となります。
                </div>
              </div>
            </div>

            {/* 全ユーザーに表示（ベータ版） */}
            <>
                {/* ステップメトリクス */}
                <div className="result-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 className="result-card-title" style={{ margin: 0 }}>ステップメトリクス</h3>
                  
                  {/* マルチカメラモードで補間ステップがある場合のみトグル表示 */}
                  {false /* multi mode disabled */ && stepMetrics.some(s => s.quality === 'warning') && (
                    <label style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '8px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      background: 'rgba(255, 193, 7, 0.1)',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255, 193, 7, 0.3)'
                    }}>
                      <input
                        type="checkbox"
                        checked={showInterpolatedSteps}
                        onChange={(e) => setShowInterpolatedSteps(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <span>🔶 補間ステップを表示</span>
                    </label>
                  )}
                </div>
                {stepMetrics.length > 0 ? (
                  <>
                    {/* 中間地点がある場合は前半・後半の比較を表示 */}
                    {sectionMidFrame != null && (
                      <div style={{
                        padding: '16px',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        borderRadius: '12px',
                        marginBottom: '20px',
                        color: 'white'
                      }}>
                        <h4 style={{ fontSize: '1.1rem', marginBottom: '12px', fontWeight: '600' }}>
                          前半 vs 後半 比較
                        </h4>
                        {(() => {
                          const firstHalf = stepMetrics.filter(m => m.contactFrame < sectionMidFrame);
                          const secondHalf = stepMetrics.filter(m => m.contactFrame >= sectionMidFrame);
                          
                          const calcAvg = (arr: StepMetric[], key: keyof StepMetric) => {
                            const values = arr.map(m => m[key] as number).filter(v => v != null && !isNaN(v));
                            return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
                          };
                          
                          const firstHalfAvg = {
                            contact: calcAvg(firstHalf, 'contactTime'),
                            flight: calcAvg(firstHalf, 'flightTime'),
                            pitch: calcAvg(firstHalf, 'stepPitch'),
                            stride: calcAvg(firstHalf, 'stride'),
                            speed: calcAvg(firstHalf, 'speedMps'),
                            acceleration: calcAvg(firstHalf, 'acceleration'),
                          };
                          
                          const secondHalfAvg = {
                            contact: calcAvg(secondHalf, 'contactTime'),
                            flight: calcAvg(secondHalf, 'flightTime'),
                            pitch: calcAvg(secondHalf, 'stepPitch'),
                            stride: calcAvg(secondHalf, 'stride'),
                            speed: calcAvg(secondHalf, 'speedMps'),
                            acceleration: calcAvg(secondHalf, 'acceleration'),
                          };
                          
                          return (
                            <div style={{ 
                              display: 'grid', 
                              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', 
                              gap: '12px' 
                            }}>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>前半 接地時間</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {firstHalfAvg.contact?.toFixed(3) ?? 'ー'}s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>後半 接地時間</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {secondHalfAvg.contact?.toFixed(3) ?? 'ー'}s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>前半 ピッチ</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {firstHalfAvg.pitch?.toFixed(2) ?? 'ー'}歩/s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>後半 ピッチ</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {secondHalfAvg.pitch?.toFixed(2) ?? 'ー'}歩/s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>前半 ストライド</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {firstHalfAvg.stride?.toFixed(2) ?? 'ー'}m
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>後半 ストライド</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {secondHalfAvg.stride?.toFixed(2) ?? 'ー'}m
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>前半 スピード</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {firstHalfAvg.speed?.toFixed(2) ?? 'ー'}m/s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>後半 スピード</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px' }}>
                                  {secondHalfAvg.speed?.toFixed(2) ?? 'ー'}m/s
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>前半 加速度</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px', color: firstHalfAvg.acceleration != null && firstHalfAvg.acceleration > 0 ? '#10b981' : firstHalfAvg.acceleration != null && firstHalfAvg.acceleration < 0 ? '#ef4444' : 'white' }}>
                                  {firstHalfAvg.acceleration != null ? `${firstHalfAvg.acceleration > 0 ? '+' : ''}${firstHalfAvg.acceleration.toFixed(2)}` : 'ー'}m/s²
                                </div>
                              </div>
                              <div style={{ background: 'rgba(255,255,255,0.15)', padding: '12px', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>後半 加速度</div>
                                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginTop: '4px', color: secondHalfAvg.acceleration != null && secondHalfAvg.acceleration > 0 ? '#10b981' : secondHalfAvg.acceleration != null && secondHalfAvg.acceleration < 0 ? '#ef4444' : 'white' }}>
                                  {secondHalfAvg.acceleration != null ? `${secondHalfAvg.acceleration > 0 ? '+' : ''}${secondHalfAvg.acceleration.toFixed(2)}` : 'ー'}m/s²
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    
                    {/* 🎯 10mタイム・スピード（トルソー基準） */}
                    {stepSummary.sectionTime != null && stepSummary.sectionSpeed != null && (
                      <div style={{
                        background: 'linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%)',
                        border: '3px solid #f59e0b',
                        borderRadius: '12px',
                        padding: '16px 24px',
                        marginBottom: '16px',
                        display: 'flex',
                        gap: '32px',
                        alignItems: 'center',
                        flexWrap: 'wrap'
                      }}>
                        <div>
                          <div style={{ fontSize: '0.85rem', color: '#92400e', marginBottom: '4px' }}>
                            🏃 {distanceValue}mタイム（トルソー基準）
                          </div>
                          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#78350f' }}>
                            {stepSummary.sectionTime.toFixed(3)} 秒
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: '0.85rem', color: '#92400e', marginBottom: '4px' }}>
                            ⚡ 平均速度
                          </div>
                          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#78350f' }}>
                            {stepSummary.sectionSpeed.toFixed(2)} m/s
                          </div>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#b45309', marginLeft: 'auto' }}>
                          ※ トルソー（腰）が0m→{distanceValue}mを通過する時間で計算<br/>
                          （線形補間によるサブフレーム精度）
                        </div>
                      </div>
                    )}

                    <div className="metrics-summary">
                      <div className="metric-item">
                        <span className="metric-label">ステップ数</span>
                        <span className="metric-value">{stepSummary.stepCount}</span>
                      </div>
                      <div className="metric-item">
                        <span className="metric-label">平均接地時間</span>
                        <span className="metric-value">
                          {stepSummary.avgContact != null
                            ? stepSummary.avgContact.toFixed(3)
                            : "ー"}{" "}
                          s
                        </span>
                      </div>
                      <div className="metric-item">
                        <span className="metric-label">平均滞空時間</span>
                        <span className="metric-value">
                          {stepSummary.avgFlight != null
                            ? stepSummary.avgFlight.toFixed(3)
                            : "ー"}{" "}
                          s
                        </span>
                      </div>
                      <div className="metric-item">
                        <span className="metric-label">平均ピッチ</span>
                        <span className="metric-value">
                          {stepSummary.avgStepPitch != null
                            ? stepSummary.avgStepPitch.toFixed(2)
                            : "ー"}{" "}
                          歩/s
                        </span>
                      </div>
                      <div className="metric-item">
                        <span className="metric-label">平均ストライド</span>
                        <span className="metric-value">
                          {stepSummary.avgStride != null
                            ? stepSummary.avgStride.toFixed(2)
                            : "ー"}{" "}
                          m
                        </span>
                      </div>
                      <div className="metric-item">
                        <span className="metric-label">平均スピード</span>
                        <span className="metric-value">
                          {stepSummary.avgSpeedMps != null
                            ? stepSummary.avgSpeedMps.toFixed(2)
                            : "ー"}{" "}
                          m/s
                        </span>
                      </div>
                    </div>

                    {/* ⚡ H-FVP セクション */}
                    {(() => {
                      console.log('🎯 H-FVP RENDER CHECK:', {
                        hfvpResult: hfvpResult ? 'EXISTS' : 'NULL',
                        F0: hfvpResult?.F0,
                        stepMetricsLength: stepMetrics.length
                      });
                      return null;
                    })()}
                    {hfvpResult && (
                      <div style={{
                        background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                        borderRadius: '16px',
                        padding: '24px',
                        marginTop: '24px',
                        marginBottom: '24px',
                        color: 'white',
                        boxShadow: '0 10px 30px rgba(139, 92, 246, 0.3)'
                      }}>
                        <h3 style={{ 
                          margin: '0 0 20px 0', 
                          fontSize: '1.3rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px'
                        }}>
                          ⚡ H-FVP 分析
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '2px 8px', 
                            background: 'rgba(255,255,255,0.2)', 
                            borderRadius: '4px' 
                          }}>
                            Horizontal Force-Velocity Profile
                          </span>
                        </h3>
                        
                        {/* データ品質インジケーター */}
                        <div style={{
                          padding: '12px',
                          background: 'rgba(255,255,255,0.15)',
                          borderRadius: '8px',
                          marginBottom: '16px',
                          fontSize: '0.9rem'
                        }}>
                          {/* 測定モード表示 */}
                          {hfvpResult.measurementMode && (
                            <div style={{ 
                              display: 'flex', 
                              justifyContent: 'space-between', 
                              alignItems: 'center',
                              marginBottom: '8px',
                              paddingBottom: '8px',
                              borderBottom: '1px solid rgba(255,255,255,0.2)'
                            }}>
                              <span>測定モード:</span>
                              <span style={{ 
                                fontWeight: 'bold',
                                padding: '4px 12px',
                                borderRadius: '12px',
                                background: hfvpResult.measurementMode === 'panning' 
                                  ? 'rgba(34, 197, 94, 0.3)' 
                                  : 'rgba(251, 191, 36, 0.3)',
                                border: hfvpResult.measurementMode === 'panning'
                                  ? '1px solid rgba(34, 197, 94, 0.5)'
                                  : '1px solid rgba(251, 191, 36, 0.5)'
                              }}>
                                {hfvpResult.measurementMode === 'panning' ? '🎥 パーン撮影' : '📹 固定カメラ'}
                                {hfvpResult.isPanningHighQuality && ' (高品質)'}
                              </span>
                            </div>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>データ品質:</span>
                            <span style={{ fontWeight: 'bold' }}>
                              {hfvpResult.quality.dataQuality === 'excellent' && '🌟 Excellent'}
                              {hfvpResult.quality.dataQuality === 'good' && '✅ Good'}
                              {hfvpResult.quality.dataQuality === 'fair' && '⚠️ Fair'}
                              {hfvpResult.quality.dataQuality === 'poor' && '❌ Poor'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                            <span>R² (回帰精度):</span>
                            <span style={{ fontWeight: 'bold' }}>{hfvpResult.rSquared.toFixed(3)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                            <span>データ点数:</span>
                            <span style={{ fontWeight: 'bold' }}>{hfvpResult.dataPoints.length} ステップ</span>
                          </div>
                        </div>

                        {/* コアパラメータ */}
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                          gap: '12px',
                          marginBottom: '20px'
                        }}>
                          <div style={{
                            padding: '16px',
                            background: 'rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>F0</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.F0.toFixed(1)}</div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>N</div>
                          </div>
                          <div style={{
                            padding: '16px',
                            background: 'rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>V0</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.V0.toFixed(2)}</div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>m/s</div>
                          </div>
                          <div style={{
                            padding: '16px',
                            background: 'rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>Pmax</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.Pmax.toFixed(0)}</div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>W</div>
                          </div>
                          <div style={{
                            padding: '16px',
                            background: 'rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>RFmax</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.RFmax.toFixed(1)}</div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>%</div>
                          </div>
                          <div style={{
                            padding: '16px',
                            background: 'rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '4px' }}>DRF</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{hfvpResult.DRF.toFixed(2)}</div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>%/(m/s)</div>
                          </div>
                        </div>

                        {/* サマリー情報 */}
                        <div style={{
                          padding: '16px',
                          background: 'rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                          fontSize: '0.85rem'
                        }}>
                          <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>📊 分析サマリー</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
                            <div>平均パワー: {hfvpResult.summary.avgPower.toFixed(0)} W</div>
                            <div>ピーク速度: {hfvpResult.summary.peakVelocity.toFixed(2)} m/s</div>
                            <div>平均加速度: {hfvpResult.summary.avgAcceleration.toFixed(2)} m/s²</div>
                          </div>
                        </div>

                        {/* 評価とアドバイス */}
                        <div style={{
                          marginTop: '20px',
                          padding: '20px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          borderRadius: '12px',
                          color: 'white'
                        }}>
                          <h4 style={{ marginBottom: '16px', fontSize: '1.1rem', fontWeight: 'bold' }}>
                            💡 パフォーマンス評価とアドバイス
                          </h4>
                          
                          {/* データ品質警告 */}
                          {hfvpResult.summary.totalDistance < 20 && (
                            <div style={{
                              marginBottom: '16px',
                              padding: '12px',
                              background: 'rgba(255, 193, 7, 0.2)',
                              border: '2px solid rgba(255, 193, 7, 0.5)',
                              borderRadius: '8px'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>⚠️ データ品質に関する注意</div>
                              <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                                測定距離が {hfvpResult.summary.totalDistance.toFixed(1)}m と短いため、H-FVP の精度が制限されます。
                                科学的文献（Samozino et al. 2016）では、正確な測定のために <strong>30-60m</strong> の加速区間を推奨しています。
                                現在の値は参考値として扱い、より長い距離での測定を推奨します。
                              </div>
                            </div>
                          )}
                          
                          {/* F0 評価 */}
                          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.15)', borderRadius: '8px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>⚡ 最大理論推進力 (F0): {hfvpResult.F0.toFixed(1)} N</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                              {(() => {
                                const bodyMass = athleteInfo.weight_kg ?? 70;
                                const f0PerKg = hfvpResult.F0 / bodyMass;
                                return (
                                  <>
                                    <div>体重比F0: {f0PerKg.toFixed(1)} N/kg</div>
                                    {f0PerKg > 9.5 && <div>🌟 優れた推進力！エリートスプリンターレベル（参考: Rabita et al. 2015）</div>}
                                    {f0PerKg >= 7.5 && f0PerKg <= 9.5 && <div>✅ 良好な推進力。トレーニングでさらに向上が見込めます。</div>}
                                    {f0PerKg < 7.5 && <div>⚠️ 推進力の強化が必要です。最大筋力トレーニング（スクワット、デッドリフト）を推奨。</div>}
                                    <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                      📚 基準値（Rabita et al. 2015）: エリート男子 9-10 N/kg、エリート女子 8-9 N/kg
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* V0 評価 */}
                          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.15)', borderRadius: '8px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>🚀 最大理論速度 (V0): {hfvpResult.V0.toFixed(2)} m/s</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                              {(() => {
                                const gender = athleteInfo.gender;
                                const isFemale = gender === 'female';
                                
                                // 基準値（Morin et al. 2012）
                                const eliteThreshold = isFemale ? 10.5 : 11.5;
                                const goodThreshold = isFemale ? 9.0 : 10.0;
                                
                                return (
                                  <>
                                    {hfvpResult.V0 > eliteThreshold && <div>🌟 卓越したスピード能力！トップスプリンターレベル（Morin et al. 2012）</div>}
                                    {hfvpResult.V0 >= goodThreshold && hfvpResult.V0 <= eliteThreshold && <div>✅ 優れた最高速度。技術トレーニングとフライングスプリントで向上可能。</div>}
                                    {hfvpResult.V0 < goodThreshold && <div>⚠️ 最高速度の向上が課題。スピードドリル、技術改善、神経系トレーニングを推奨。</div>}
                                    <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                      📚 基準値（Morin et al. 2012）: エリート男子 11-13 m/s、エリート女子 10-11.5 m/s
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* Pmax 評価 */}
                          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.15)', borderRadius: '8px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>💪 最大パワー (Pmax): {hfvpResult.Pmax.toFixed(0)} W</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                              {(() => {
                                const bodyMass = athleteInfo.weight_kg ?? 70;
                                const pmaxPerKg = hfvpResult.Pmax / bodyMass;
                                const gender = athleteInfo.gender;
                                const isFemale = gender === 'female';
                                
                                // 基準値（Samozino et al. 2016, Cross et al. 2017）
                                const eliteThreshold = isFemale ? 20 : 25;
                                const goodThreshold = isFemale ? 15 : 20;
                                
                                return (
                                  <>
                                    <div>体重比パワー: {pmaxPerKg.toFixed(1)} W/kg</div>
                                    {pmaxPerKg > eliteThreshold && <div>🌟 非常に高いパワー出力！エリートレベル（Samozino et al. 2016）</div>}
                                    {pmaxPerKg >= goodThreshold && pmaxPerKg <= eliteThreshold && <div>✅ 良好なパワー出力。バランスの取れた能力です。</div>}
                                    {pmaxPerKg < goodThreshold && <div>⚠️ パワー出力の向上余地。爆発的トレーニング（ジャンプ、プライオメトリクス）推奨。</div>}
                                    <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                      📚 基準値（Samozino et al. 2016）: エリート男子 25-30 W/kg、エリート女子 20-25 W/kg
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* RFmax 評価 */}
                          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.15)', borderRadius: '8px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>📐 最大力比率 (RFmax): {hfvpResult.RFmax.toFixed(1)}%</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                              {(() => {
                                // 基準値（Morin & Samozino 2016）
                                // 加速初期: RFmax = 45-55%
                                return (
                                  <>
                                    {hfvpResult.RFmax > 50 && <div>🌟 優れた力の方向性！効率的な水平推進力発揮（Morin & Samozino 2016）</div>}
                                    {hfvpResult.RFmax >= 40 && hfvpResult.RFmax <= 50 && <div>✅ 標準的な力比率。技術改善で効率向上が見込めます。</div>}
                                    {hfvpResult.RFmax < 40 && <div>⚠️ 垂直方向への力が多い可能性。前傾姿勢、接地位置、プッシュ角度を見直しましょう。</div>}
                                    <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                      📚 基準値（Morin & Samozino 2016）: 加速初期 45-55%、最高速度時 20-25%
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* DRF 評価 */}
                          <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.15)', borderRadius: '8px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>📉 力減少率 (DRF): {hfvpResult.DRF.toFixed(2)} %/(m/s)</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                              {(() => {
                                const drfAbs = Math.abs(hfvpResult.DRF);
                                // 基準値（Morin et al. 2021）
                                // 典型値: -8 to -12 %/(m/s)
                                // 優秀: < -8, 課題あり: > -12
                                return (
                                  <>
                                    {drfAbs < 8 && <div>🌟 優れた加速持続能力！効率的なストライド技術（Morin et al. 2021）</div>}
                                    {drfAbs >= 8 && drfAbs <= 12 && <div>✅ 標準的な力減少率。技術トレーニングで改善の余地あり。</div>}
                                    {drfAbs > 12 && <div>⚠️ 速度上昇時の力低下が大きい。ランニング効率、ストライド長/頻度の最適化が必要。</div>}
                                    <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                      📚 基準値（Morin et al. 2021）: エリート -8 to -10 %/(m/s)、一般 -10 to -14 %/(m/s)
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* 測定品質に関するメッセージ */}
                          {hfvpResult.measurementMode === 'fixed' && !hfvpResult.isPanningHighQuality && hfvpResult.dataPoints.length < 8 && (
                            <div style={{ 
                              padding: '16px', 
                              background: 'rgba(251, 191, 36, 0.2)', 
                              borderRadius: '8px', 
                              marginTop: '16px',
                              border: '2px solid rgba(251, 191, 36, 0.4)'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '1rem' }}>⚠️ 測定精度について</div>
                              <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                                <div>• 現在の測定: 固定カメラ（{hfvpResult.dataPoints.length}ステップ）</div>
                                <div>• 推奨: パーン撮影モード + 30-40m測定（8ステップ以上）</div>
                                <div>• より多くのデータ点で、H-FVP精度が向上します</div>
                                <div style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.9 }}>
                                  💡 Step 0で「🎥 パーン撮影（30-40m推奨）」を選択すると、より正確な力-速度プロファイルを取得できます
                                </div>
                              </div>
                            </div>
                          )}
                          
                          {hfvpResult.isPanningHighQuality && (
                            <div style={{ 
                              padding: '16px', 
                              background: 'rgba(34, 197, 94, 0.2)', 
                              borderRadius: '8px', 
                              marginTop: '16px',
                              border: '2px solid rgba(34, 197, 94, 0.4)'
                            }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '1rem' }}>✅ 高品質測定</div>
                              <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
                                <div>• パーン撮影モード: {hfvpResult.dataPoints.length}ステップ検出</div>
                                <div>• データ点数が十分で、H-FVP精度が高いです</div>
                                <div>• 文献推奨値（30-60m、8ステップ以上）を満たしています</div>
                              </div>
                            </div>
                          )}

                          {/* 総合アドバイス */}
                          <div style={{ padding: '16px', background: 'rgba(255,255,255,0.2)', borderRadius: '8px', marginTop: '16px' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '12px', fontSize: '1rem' }}>🎯 トレーニング推奨</div>
                            <div style={{ fontSize: '0.9rem', lineHeight: '1.8' }}>
                              {(() => {
                                const f0 = hfvpResult.F0;
                                const v0 = hfvpResult.V0;
                                const bodyMass = athleteInfo.weight_kg ?? 70;
                                const optimalF0 = 6.0 * bodyMass; // 目安値
                                const f0Deficit = ((optimalF0 - f0) / optimalF0) * 100;
                                
                                if (f0Deficit > 10) {
                                  return (
                                    <>
                                      <div>• 力不足型：重量トレーニング（スクワット、デッドリフト）を強化</div>
                                      <div>• スレッド引きやヒルスプリントで推進力を鍛える</div>
                                      <div>• 週2-3回、下半身の筋力強化を優先</div>
                                    </>
                                  );
                                } else if (v0 < 9.5) {
                                  return (
                                    <>
                                      <div>• 速度不足型：技術ドリルとフライングスプリント</div>
                                      <div>• 高速ランニングの神経系トレーニング</div>
                                      <div>• ストライドとピッチの最適化練習</div>
                                    </>
                                  );
                                } else if (Math.abs(hfvpResult.DRF) > 10) {
                                  return (
                                    <>
                                      <div>• 効率改善型：ランニング技術の見直し</div>
                                      <div>• 加速局面での姿勢とフォームの最適化</div>
                                      <div>• ビデオ分析による動作改善</div>
                                    </>
                                  );
                                } else {
                                  return (
                                    <>
                                      <div>• バランス型：現在の能力を維持しつつ総合強化</div>
                                      <div>• 力と速度をバランスよくトレーニング</div>
                                      <div>• 専門性を高めるための個別プログラム作成を推奨</div>
                                    </>
                                  );
                                }
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div style={{
                      background: '#f0f9ff',
                      border: '2px solid #3b82f6',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      margin: '16px 0',
                      fontSize: '0.9rem',
                      color: '#1e40af'
                    }}>
                      ✏️ <strong>接地・離地フレームを直接編集できます</strong><br/>
                      数値をクリックして修正し、Enterキーで確定してください。
                    </div>

                    <div className="table-scroll">
                      <table className="metrics-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>接地 ✏️</th>
                            <th>離地 ✏️</th>
                            <th>接地時間</th>
                            <th>滞空時間</th>
                            <th>ピッチ</th>
                            <th>ストライド{runType === 'dash' ? ' (0m→)' : ''}</th>
                            <th>区間内貢献</th>
                            <th>接地位置</th>
                            <th>スピード</th>
                            <th>加速度</th>
                            <th>減速率 / 推進率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stepMetrics
                            .filter(s => showInterpolatedSteps || s.quality !== 'warning')
                            .map((s, idx) => (
                            <tr 
                              key={s.index}
                              style={{
                                // 🆕 quality による行の色分け
                                background: s.quality === 'warning' ? '#fefce8' : s.quality === 'bad' ? '#fef2f2' : 'inherit',
                                color: s.quality === 'bad' ? '#9ca3af' : 'inherit'
                              }}
                            >
                              <td>{s.index}</td>
                              <td>
                                <input
                                  type="number"
                                  value={calibrationType === 2 ? (manualContactFrames[idx] ?? s.contactFrame) : (manualContactFrames[idx * 2] ?? s.contactFrame)}
                                  onChange={(e) => {
                                    const newValue = parseInt(e.target.value);
                                    if (!isNaN(newValue)) {
                                      const updated = [...manualContactFrames];
                                      if (calibrationType === 2) {
                                        updated[idx] = newValue;
                                      } else {
                                        updated[idx * 2] = newValue;
                                      }
                                      setManualContactFrames(updated);
                                    }
                                  }}
                                  style={{
                                    width: '60px',
                                    padding: '4px',
                                    border: '1px solid #d1d5db',
                                    borderRadius: '4px',
                                    fontSize: '0.9rem'
                                  }}
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  value={autoToeOffFrames[idx] ?? s.toeOffFrame}
                                  onChange={(e) => {
                                    const newValue = parseInt(e.target.value);
                                    if (!isNaN(newValue)) {
                                      const updated = [...autoToeOffFrames];
                                      updated[idx] = newValue;
                                      setAutoToeOffFrames(updated);
                                    }
                                  }}
                                  style={{
                                    width: '60px',
                                    padding: '4px',
                                    border: '1px solid #d1d5db',
                                    borderRadius: '4px',
                                    fontSize: '0.9rem'
                                  }}
                                />
                              </td>
                              <td>{s.contactTime?.toFixed(3) ?? "ー"}</td>
                              <td>{s.flightTime?.toFixed(3) ?? "ー"}</td>
                              <td>{s.stepPitch?.toFixed(2) ?? "ー"}</td>
                              <td style={{ 
                                background: s.isFirstStepFromStart ? '#fef3c7' : 'inherit',
                                fontWeight: s.isFirstStepFromStart ? 'bold' : 'normal'
                              }}>
                                {s.fullStride?.toFixed(2) ?? s.stride?.toFixed(2) ?? "ー"}
                                {s.isFirstStepFromStart && <span style={{ fontSize: '0.7rem', color: '#d97706' }}> 🚀</span>}
                              </td>
                              <td style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                                {s.sectionStride?.toFixed(2) ?? "ー"}
                              </td>
                              <td style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                                {s.distanceAtContact?.toFixed(2) ?? "ー"}m
                              </td>
                              <td>{s.speedMps?.toFixed(2) ?? "ー"}</td>
                              <td style={{ color: s.acceleration != null && s.acceleration > 0 ? '#10b981' : s.acceleration != null && s.acceleration < 0 ? '#ef4444' : 'inherit' }}>
                                {s.acceleration != null ? `${s.acceleration > 0 ? '+' : ''}${s.acceleration.toFixed(2)}` : "ー"} {s.acceleration != null && 'm/s²'}
                              </td>
                              <td style={{ fontSize: '0.9rem' }}>
                                {s.brakeImpulseRatio != null && s.kickImpulseRatio != null ? (
                                  <span>
                                    <span style={{ 
                                      color: s.brakeImpulseRatio > 0.5 ? '#dc2626' : '#555',
                                      fontWeight: s.brakeImpulseRatio > 0.5 ? 'bold' : 'normal'
                                    }}>
                                      {(s.brakeImpulseRatio * 100).toFixed(0)}%
                                    </span>
                                    {' / '}
                                    <span style={{ color: '#1a7f37' }}>
                                      {(s.kickImpulseRatio * 100).toFixed(0)}%
                                    </span>
                                  </span>
                                ) : "ー"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    
                    {/* 新しいステップを追加 */}
                    <div style={{ marginTop: '16px', textAlign: 'center' }}>
                      <button
                        className="btn-primary"
                        onClick={() => {
                          const lastContact = manualContactFrames[manualContactFrames.length - 1] || 0;
                          const newContact = lastContact + 30;  // 前のステップの30フレーム後
                          const newToeOff = newContact + 20;    // 接地の20フレーム後
                          
                          setManualContactFrames([...manualContactFrames, newContact]);
                          setAutoToeOffFrames([...autoToeOffFrames, newToeOff]);
                          alert(`新しいステップを追加しました！\n接地: ${newContact}\n離地: ${newToeOff}\n\n値を修正してください。`);
                        }}
                      >
                        ➕ 新しいステップを追加
                      </button>
                    </div>
                  </>
                ) : (
                  <div>
                    <div className="empty-state">
                      ステップメトリクスがありません
                    </div>
                    
                    {/* 完全手動モード：最初のステップを追加 */}
                    <div style={{ marginTop: '24px', textAlign: 'center' }}>
                      <button
                        className="btn-primary-large"
                        onClick={() => {
                          const firstContact = sectionStartFrame || 50;
                          const firstToeOff = firstContact + 20;
                          
                          setManualContactFrames([firstContact]);
                          setAutoToeOffFrames([firstToeOff]);
                          alert(`最初のステップを追加しました！\n接地: ${firstContact}\n離地: ${firstToeOff}\n\n値を修正してください。`);
                        }}
                        style={{ fontSize: '1.1rem', padding: '16px 32px' }}
                      >
                        ➕ 最初のステップを追加
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* グラフ */}
              <div className="result-card">
                <h3 className="result-card-title">ステップ解析グラフ</h3>

                {stepMetrics.length > 0 ? (
                  <>
                    <div className="graph-controls-compact">
                      <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '8px' }}>
                        📊 項目をクリックで表示/非表示、右の📈/📊でグラフタイプを切替
                      </div>
                      <div className="metric-chips-compact" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {(Object.keys(metricLabels) as GraphMetricKey[]).map(
                          (key) => {
                            const active = selectedGraphMetrics.includes(key);
                            const chartType = metricChartTypes[key];
                            return (
                              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <button
                                  className={
                                    active
                                      ? "metric-chip active"
                                      : "metric-chip"
                                  }
                                  onClick={() => toggleMetric(key)}
                                  style={{ 
                                    borderRadius: '8px 0 0 8px',
                                    paddingRight: '8px'
                                  }}
                                >
                                  {metricLabels[key]}
                                </button>
                                <button
                                  onClick={() => toggleMetricChartType(key)}
                                  style={{
                                    padding: '6px 10px',
                                    border: active ? '2px solid #3b82f6' : '1px solid #d1d5db',
                                    borderLeft: 'none',
                                    borderRadius: '0 8px 8px 0',
                                    background: active ? (chartType === 'line' ? '#dbeafe' : '#fef3c7') : '#f9fafb',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    transition: 'all 0.2s'
                                  }}
                                  title={chartType === 'line' ? '折れ線グラフ → 棒グラフに変更' : '棒グラフ → 折れ線グラフに変更'}
                                >
                                  {chartType === 'line' ? '📈' : '📊'}
                                </button>
                              </div>
                            );
                          }
                        )}
                      </div>

                      <div className="graph-type-switch" style={{ marginTop: '12px' }}>
                        <span style={{ fontSize: '0.85rem', color: '#6b7280', marginRight: '8px' }}>一括変更:</span>
                        <button
                          className={
                            graphType === "line"
                              ? "type-btn active"
                              : "type-btn"
                          }
                          onClick={() => {
                            setGraphType("line");
                            setMetricChartTypes({
                              contactTime: "line",
                              flightTime: "line",
                              stepPitch: "line",
                              stride: "line",
                              speedMps: "line",
                              brakeRatio: "line",
                              kickRatio: "line",
                            });
                          }}
                        >
                          全て折れ線
                        </button>
                        <button
                          className={
                            graphType === "bar" ? "type-btn active" : "type-btn"
                          }
                          onClick={() => {
                            setGraphType("bar");
                            setMetricChartTypes({
                              contactTime: "bar",
                              flightTime: "bar",
                              stepPitch: "bar",
                              stride: "bar",
                              speedMps: "bar",
                              brakeRatio: "bar",
                              kickRatio: "bar",
                            });
                          }}
                        >
                          全て棒グラフ
                        </button>
                      </div>
                    </div>

                    <div className="graph-container">
                      <canvas ref={graphCanvasRef} />
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    マーカーを打つとグラフが表示されます
                  </div>
                )}
              </div>

              {/* 3局面角度テーブル */}
              {threePhaseAngles.length > 0 && (
                <div className="result-card">
                  <h3 className="result-card-title">3局面の関節角度と足先距離（詳細データ）</h3>
                  <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                    ※ 接地期前半：接地脚が大転子から鉛直に下ろした線より前方にある接地ポイント<br/>
                    ※ 接地期中半：接地脚が大転子から鉛直に下ろした線と重なる接地ポイント（大腿角0°）<br/>
                    ※ 接地期後半：接地脚が大転子から鉛直に下ろした線より後方にある離地ポイント
                  </p>
                  <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '0.5rem' }}>
                    ※ 大腿角度：鉛直下向きを0°、前方がマイナス（-）、後方がプラス（+）<br/>
                    ※ 足先距離：大転子から鉛直下方向を0cm、前方がマイナス（-）、後方がプラス（+）
                  </p>
                  <p style={{ 
                    fontSize: '0.9rem', 
                    color: '#3b82f6', 
                    marginBottom: '1rem',
                    padding: '8px 12px',
                    background: '#eff6ff',
                    borderRadius: '6px',
                    border: '1px solid #bfdbfe'
                  }}>
                    👆 <strong>行をクリックすると、そのフレームのスティックピクチャーを表示します</strong>
                  </p>
                  
                  {/* フレームビューアー（3局面用） */}
                  <div style={{
                    marginBottom: '20px',
                    padding: '16px',
                    background: '#f8fafc',
                    borderRadius: '12px',
                    border: '1px solid #e2e8f0'
                  }}>
                    <div style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      marginBottom: '12px'
                    }}>
                      <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: '#374151' }}>
                        📹 フレーム {currentFrame} のスティックピクチャー
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          className={footZoomEnabled ? "toggle-btn active" : "toggle-btn"}
                          onClick={() => setFootZoomEnabled((v) => !v)}
                          style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                        >
                          足元拡大 {footZoomEnabled ? "ON" : "OFF"}
                        </button>
                        <button
                          className={showSkeleton ? "toggle-btn active" : "toggle-btn"}
                          onClick={() => setShowSkeleton((v) => !v)}
                          disabled={!poseResults.length}
                          style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                        >
                          スケルトン {showSkeleton ? "ON" : "OFF"}
                        </button>
                      </div>
                    </div>
                    <div className="canvas-area" style={{ maxHeight: '600px', overflow: 'hidden', display: 'flex', justifyContent: 'center', position: 'relative' }}>
                      <canvas 
                        ref={displayCanvasRef} 
                        className="preview-canvas" 
                        style={{ maxHeight: '560px', maxWidth: '100%', objectFit: 'contain', ...(isCalibrating ? { cursor: 'crosshair' } : {}) }}
                        onClick={isCalibrating ? handleConeClick : undefined}
                      />
                      {isCalibrating && (
                        <div style={{
                          position: 'absolute',
                          top: '10px',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          backgroundColor: 'rgba(0, 0, 0, 0.8)',
                          color: 'white',
                          padding: '15px 25px',
                          borderRadius: '10px',
                          fontSize: '16px',
                          fontWeight: 'bold',
                          zIndex: 1000,
                          textAlign: 'center',
                          maxWidth: '80%',
                        }}>
                          🎯 {calibrationInstructions}
                          <br />
                          <small style={{ fontSize: '12px', opacity: 0.8 }}>
                            ({coneClicks.length}/4) コーンをクリック
                          </small>
                        </div>
                      )}
                    </div>
                    <div style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      gap: '8px',
                      marginTop: '12px'
                    }}>
                      <button onClick={() => changeFrame(-10)} disabled={!ready} style={{ padding: '6px 12px' }}>-10</button>
                      <button onClick={() => changeFrame(-1)} disabled={!ready} style={{ padding: '6px 12px' }}>-1</button>
                      <span style={{ padding: '0 12px', fontWeight: 'bold' }}>Frame {currentFrame}</span>
                      <button onClick={() => changeFrame(1)} disabled={!ready} style={{ padding: '6px 12px' }}>+1</button>
                      <button onClick={() => changeFrame(10)} disabled={!ready} style={{ padding: '6px 12px' }}>+10</button>
                    </div>
                  </div>
                  
                  <div className="table-scroll">
                    <table className="phase-table-compact">
                      <thead>
                        <tr>
                          <th>局面</th>
                          <th>フレーム</th>
                          <th>体幹</th>
                          <th>L 大腿</th>
                          <th>R 大腿</th>
                          <th>L 足先距離</th>
                          <th>R 足先距離</th>
                          <th>L 膝</th>
                          <th>R 膝</th>
                          <th>L 肘</th>
                          <th>R 肘</th>
                        </tr>
                      </thead>
                      <tbody>
                        {threePhaseAngles.map((p, i) => (
                          <tr 
                            key={i}
                            onClick={() => {
                              setCurrentFrame(p.frame);
                              // スクロールしてフレームビューアーを表示
                              const viewer = document.querySelector('.canvas-area');
                              if (viewer) {
                                viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              }
                            }}
                            style={{ 
                              cursor: 'pointer',
                              background: currentFrame === p.frame ? '#dbeafe' : 'inherit',
                              transition: 'background 0.2s'
                            }}
                            onMouseEnter={(e) => {
                              if (currentFrame !== p.frame) {
                                (e.currentTarget as HTMLTableRowElement).style.background = '#f0f9ff';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (currentFrame !== p.frame) {
                                (e.currentTarget as HTMLTableRowElement).style.background = 'inherit';
                              }
                            }}
                          >
                            <td>
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                gap: '6px' 
                              }}>
                                {currentFrame === p.frame && <span>👁️</span>}
                                {p.phase === 'initial' ? '接地期前半（接地）' : p.phase === 'mid' ? '接地期中半（垂直）' : '接地期後半（離地）'}
                              </span>
                            </td>
                            <td style={{ 
                              fontWeight: currentFrame === p.frame ? 'bold' : 'normal',
                              color: currentFrame === p.frame ? '#2563eb' : 'inherit'
                            }}>
                              {p.frame}
                            </td>
                            <td>{p.angles.trunkAngle?.toFixed(1)}°</td>
                            <td>{p.angles.thighAngle.left?.toFixed(1)}°</td>
                            <td>{p.angles.thighAngle.right?.toFixed(1)}°</td>
                            <td>{p.angles.toeHorizontalDistance.left?.toFixed(1) ?? 'ー'}cm</td>
                            <td>{p.angles.toeHorizontalDistance.right?.toFixed(1) ?? 'ー'}cm</td>
                            <td>{p.angles.kneeFlex.left?.toFixed(1)}°</td>
                            <td>{p.angles.kneeFlex.right?.toFixed(1)}°</td>
                            <td>{p.angles.elbowAngle.left?.toFixed(1) ?? 'ー'}°</td>
                            <td>{p.angles.elbowAngle.right?.toFixed(1) ?? 'ー'}°</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 保存・エクスポート */}
              <div className="result-card" style={{ 
                background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                border: '3px solid #f59e0b',
                boxShadow: '0 8px 24px rgba(245, 158, 11, 0.3)'
              }}>
                <h3 className="result-card-title" style={{ 
                  fontSize: '1.5rem',
                  color: '#92400e',
                  marginBottom: '20px'
                }}>
                  💾 保存とエクスポート
                </h3>

                <div style={{ display: 'flex', gap: '16px', flexDirection: 'column' }}>
                  <button
                    onClick={handleSaveSession}
                    disabled={saving}
                    style={{
                      padding: '20px 32px',
                      fontSize: '1.3rem',
                      fontWeight: 'bold',
                      borderRadius: '12px',
                      border: '3px solid #10b981',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      color: 'white',
                      cursor: saving ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s',
                      boxShadow: '0 4px 12px rgba(16, 185, 129, 0.4)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '12px',
                      opacity: saving ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!saving) {
                        (e.target as HTMLButtonElement).style.transform = 'translateY(-4px)';
                        (e.target as HTMLButtonElement).style.boxShadow = '0 8px 20px rgba(16, 185, 129, 0.5)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLButtonElement).style.transform = 'translateY(0)';
                      (e.target as HTMLButtonElement).style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.4)';
                    }}
                  >
                    <span style={{ fontSize: '1.5rem' }}>💾</span>
                    <span>{saving ? '保存中...' : 'サーバーに保存する'}</span>
                  </button>

                  <button
                    onClick={exportAnglesToCSV}
                    disabled={!poseResults.length}
                    style={{
                      padding: '16px 28px',
                      fontSize: '1.1rem',
                      fontWeight: 'bold',
                      borderRadius: '10px',
                      border: '2px solid #3b82f6',
                      background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                      color: 'white',
                      cursor: !poseResults.length ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s',
                      boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '10px',
                      opacity: !poseResults.length ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (poseResults.length) {
                        (e.target as HTMLButtonElement).style.transform = 'translateY(-2px)';
                        (e.target as HTMLButtonElement).style.boxShadow = '0 6px 16px rgba(59, 130, 246, 0.5)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLButtonElement).style.transform = 'translateY(0)';
                      (e.target as HTMLButtonElement).style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.4)';
                    }}
                  >
                    <span style={{ fontSize: '1.3rem' }}>📊</span>
                    <span>角度をCSV出力</span>
                  </button>
                </div>

                {saveResult && (
                  <div style={{ 
                    marginTop: '16px',
                    padding: '12px 16px',
                    background: saveResult.includes('成功') ? '#d1fae5' : '#fee2e2',
                    color: saveResult.includes('成功') ? '#065f46' : '#991b1b',
                    borderRadius: '8px',
                    fontWeight: 'bold',
                    fontSize: '1.05rem',
                    textAlign: 'center'
                  }}>
                    {saveResult}
                  </div>
                )}
              </div>
            </>

            {/* ナビゲーションボタン */}
            <div style={{ marginTop: '32px', display: 'flex', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {/* 前へボタン（マーカーを保持したまま戻る） */}
                <button
                  className="wizard-btn secondary"
                  onClick={() => setWizardStep(6)}
                  style={{
                    padding: '14px 28px',
                    fontSize: '1rem',
                    fontWeight: 'bold',
                    borderRadius: '8px',
                    border: '2px solid #3b82f6',
                    background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                    color: '#1d4ed8',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLButtonElement).style.transform = 'translateY(-2px)';
                    (e.target as HTMLButtonElement).style.boxShadow = '0 4px 8px rgba(59, 130, 246, 0.3)';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLButtonElement).style.transform = 'translateY(0)';
                    (e.target as HTMLButtonElement).style.boxShadow = 'none';
                  }}
                >
                  ⬅️ 前へ（マーキング画面）
                </button>
                
                {/* 検出モードをやり直す */}
                <button
                  className="wizard-btn secondary"
                  onClick={() => {
                    if (window.confirm('検出モードをやり直しますか？\n（現在のマーカーはすべてクリアされます）')) {
                      setDetectionMode(null);
                      setCalibrationType(null);
                      setManualContactFrames([]);
                      setAutoToeOffFrames([]);
                      setCalibrationData({ contactFrame: null, toeOffFrame: null });
                      setCalibrationMode(0);
                      setWizardStep(6);
                    }
                  }}
                  style={{
                    padding: '14px 28px',
                    fontSize: '1rem',
                    fontWeight: 'bold',
                    borderRadius: '8px',
                    border: '2px solid #f59e0b',
                    background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                    color: '#92400e',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLButtonElement).style.transform = 'translateY(-2px)';
                    (e.target as HTMLButtonElement).style.boxShadow = '0 4px 8px rgba(245, 158, 11, 0.3)';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLButtonElement).style.transform = 'translateY(0)';
                    (e.target as HTMLButtonElement).style.boxShadow = 'none';
                  }}
                >
                  🔄 検出モードをやり直す
                </button>
              </div>
              <button
                className="wizard-btn danger"
                onClick={() => {
                  if (
                    window.confirm(
                      "最初からやり直しますか？現在のデータはリセットされます。"
                    )
                  ) {
                    // リセット処理
                    if (videoUrl) URL.revokeObjectURL(videoUrl);
                    setVideoUrl(null);
                    setVideoFile(null);
                    framesRef.current = [];
                    setFramesCount(0);
                    setCurrentFrame(0);
                    setExtractProgress(0);
                    setIsExtracting(false);
                    setUsedTargetFps(null);
                    setSectionStartFrame(null);
                    setSectionMidFrame(null);
                    setSectionEndFrame(null);
                    setStartLineOffset(0);
                    setMidLineOffset(0);
                    setEndLineOffset(0);
                    setSavedStartHipX(null);
                    setSavedMidHipX(null);
                    setSavedEndHipX(null);
                    setManualContactFrames([]);
                    setAutoToeOffFrames([]);
                    setCalibrationMode(0);
                    setToeOffThreshold(null);
                    setBaseThreshold(null);
                    setPoseResults([]);
                    setStatus("");
                    setWizardStep(0);
                    setDistanceInput("10");
                    setLabelInput("");
                    setNotesInput("");
                    setAthleteInfo({
                      name: '',
                      age: null,
                      gender: null,
                      affiliation: '',
                      height_cm: null,
                      current_record: '',
                      target_record: '',
                    });
                  }
                }}
              >
                最初からやり直す
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // デバッグ: 画面幅を検出
  const [screenWidth, setScreenWidth] = React.useState(window.innerWidth);
  React.useEffect(() => {
    const handleResize = () => setScreenWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 認証は AppWithAuth で処理済み

  // チュートリアルのステップデータ
  const tutorialSteps = [
    {
      title: "ようこそ！ランニング動作解析システムへ",
      content: "このアプリでは、動画からランニングフォームを科学的に分析できます。\n7つのステップで解析を進めていきましょう。"
    },
    {
      title: "ステップ0: 測定者情報の入力",
      content: "測定者の基本情報を入力します。\n\n• 氏名、年齢、性別（必須）\n• 身長（ストライド分析に使用）\n• 目標記録（AIアドバイスに使用）"
    },
    {
      title: "ステップ1: 動画のアップロード",
      content: "ランニング動画をアップロードしてください。\n\n• 横から撮影した動画が最適です\n• 10m以上の走行が収まっている動画を推奨\n• MP4、MOV、WebM形式に対応"
    },
    {
      title: "ステップ2: フレーム抽出",
      content: "動画を個別のフレームに分割します。\n\n• 目標FPSを設定（推奨: 30fps）\n• 抽出開始をクリック\n• 処理には数秒かかります"
    },
    {
      title: "ステップ3: 姿勢推定",
      content: "各フレームから骨格情報を抽出します。\n\n• MediaPipe Poseを使用\n• 自動的に関節位置を検出\n• スケルトン表示で確認可能"
    },
    {
      title: "ステップ4: 区間設定",
      content: "解析する区間を設定します。\n\n• スタート地点を設定\n• エンド地点を設定\n• 距離（m）を入力（例: 10m）"
    },
    {
      title: "ステップ5: マーカー設定",
      content: "接地・離地のタイミングをマークします。\n\n• 最初の2歩：手動でマーク（2歩分キャリブレーション）\n  - 1歩目: 接地→離地\n  - 2歩目: 接地→離地\n• 3歩目以降：接地のみマーク（離地は自動検出）\n• PC: Spaceキー、モバイル: タップでマーク"
    },
    {
      title: "ステップ6: 結果確認",
      content: "解析結果を確認しましょう！\n\n• AI評価：フォームの総合評価\n• 100m目標記録：目標達成のためのアドバイス"
    },
    {
      title: "ステップ7: データ詳細（プロ版）",
      content: "詳細なデータ分析（プロ版機能）\n\n• ステップメトリクス：詳細な数値データ\n• グラフ：各指標の推移を可視化\n• 3局面の関節角度：詳細な姿勢データ\n\n※ プロ版会員のみ閲覧可能"
    }
  ];

  return (
    <div className={`app-container wizard-step-${wizardStep}`}>
      {/* モバイル簡素化 */}
      <MobileSimplifier />
      {/* モバイル用ハンバーガーメニュー */}
      {isMobile && (
        <MobileHeader 
          userProfile={userProfile ? { name: userProfile.name } : undefined}
          onNewAnalysis={handleStartNewAnalysis}
          onShowTutorial={() => {
            localStorage.removeItem('hideTutorial');
            setShowTutorial(true);
            setTutorialStep(0);
          }}
        />
      )}
      {/* モバイル用の修正を適用 */}

      {/* チュートリアルモーダル */}
      {showTutorial && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          padding: '20px'
        }}>
          <div style={{
            background: 'white',
            borderRadius: '16px',
            maxWidth: '600px',
            width: '100%',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
          }}>
            {/* ヘッダー */}
            <div style={{
              padding: '24px',
              borderBottom: '2px solid #f0f0f0',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              borderRadius: '16px 16px 0 0'
            }}>
              <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 'bold' }}>
                {tutorialSteps[tutorialStep].title}
              </h2>
              <div style={{ marginTop: '12px', fontSize: '0.9rem', opacity: 0.9 }}>
                ステップ {tutorialStep + 1} / {tutorialSteps.length}
              </div>
            </div>

            {/* コンテンツ */}
            <div style={{
              padding: '32px 24px',
              fontSize: '1rem',
              lineHeight: '1.8',
              color: '#374151',
              whiteSpace: 'pre-line'
            }}>
              {tutorialSteps[tutorialStep].content}
            </div>

            {/* プログレスバー */}
            <div style={{
              padding: '0 24px 24px',
              display: 'flex',
              gap: '8px'
            }}>
              {tutorialSteps.map((_, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: '4px',
                    borderRadius: '2px',
                    background: i <= tutorialStep ? '#667eea' : '#e5e7eb'
                  }}
                />
              ))}
            </div>

            {/* ボタン */}
            <div style={{
              padding: '0 24px 24px',
              display: 'flex',
              gap: '12px',
              justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={() => setShowTutorial(false)}
                  style={{
                    padding: '12px 24px',
                    borderRadius: '8px',
                    border: '2px solid #e5e7eb',
                    background: 'white',
                    color: '#6b7280',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: '1rem'
                  }}
                >
                  スキップ
                </button>
                {tutorialStep === 0 && (
                  <button
                    onClick={() => {
                      localStorage.setItem('hideTutorial', 'true');
                      setShowTutorial(false);
                    }}
                    style={{
                      padding: '12px 24px',
                      borderRadius: '8px',
                      border: '2px solid #f59e0b',
                      background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                      color: '#92400e',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      transition: 'all 0.2s',
                      boxShadow: '0 2px 4px rgba(251, 191, 36, 0.2)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'linear-gradient(135deg, #fde68a 0%, #fcd34d 100%)';
                      e.currentTarget.style.boxShadow = '0 4px 8px rgba(251, 191, 36, 0.3)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)';
                      e.currentTarget.style.boxShadow = '0 2px 4px rgba(251, 191, 36, 0.2)';
                    }}
                  >
                    🚫 次回から表示しない
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                {tutorialStep > 0 && (
                  <button
                    onClick={() => setTutorialStep(tutorialStep - 1)}
                    style={{
                      padding: '12px 24px',
                      borderRadius: '8px',
                      border: '2px solid #667eea',
                      background: 'white',
                      color: '#667eea',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: '1rem'
                    }}
                  >
                    戻る
                  </button>
                )}
                <button
                  onClick={() => {
                    if (tutorialStep < tutorialSteps.length - 1) {
                      setTutorialStep(tutorialStep + 1);
                    } else {
                      setShowTutorial(false);
                    }
                  }}
                  style={{
                    padding: '12px 32px',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    color: 'white',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: '1rem',
                    boxShadow: '0 4px 12px rgba(102, 126, 234, 0.4)'
                  }}
                >
                  {tutorialStep < tutorialSteps.length - 1 ? '次へ' : '始める！'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    {/* ヘッダー - ステップ1のみ表示 */}
    {wizardStep === 1 && (
      <header className="app-header-new">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          {/* 左側：タイトル */}
          <div>
            <h1 className="app-title-new">🏃 Running Analysis Studio</h1>
            <p className="app-subtitle-new">
              フレーム抽出・姿勢推定・関節角度とステップ指標を一括解析
            </p>
          </div>

          {/* 右側：チュートリアル＋新しい解析ボタン＋ユーザー名 */}
          {userProfile && (
            <div
              style={{
                display: "flex",
                gap: "12px",
                alignItems: "center",
              }}
            >
              {/* 使い方ボタン（チュートリアル） */}
              <button
                onClick={() => {
                  // 一時的にチュートリアルの非表示設定を解除して表示
                  localStorage.removeItem('hideTutorial');
                  setShowTutorial(true);
                  setTutorialStep(0);
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "2px solid rgba(59,130,246,0.3)",
                  background: "rgba(59,130,246,0.1)",
                  color: "white",
                  fontWeight: "bold",
                  fontSize: "0.9rem",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>？</span>
                <span>使い方</span>
              </button>

              {/* ★ 新しい解析を開始ボタン */}
              <button
                type="button"
                onClick={handleStartNewAnalysis}
                style={{
                  padding: "8px 16px",
                  borderRadius: 999,
                  border: "none",
                  background:
                    "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                  color: "white",
                  fontSize: "0.9rem",
                  fontWeight: 600,
                  boxShadow: "0 8px 20px rgba(34,197,94,0.4)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                ＋ 新しい解析を開始
              </button>

              {/* ユーザー名表示（おまけ） */}
              <span
                style={{
                  fontSize: "0.9rem",
                  color: "#0f172a",
                  opacity: 0.8,
                }}
              >
                {userProfile.name}
              </span>
            </div>
          )}
        </div>
      </header>
    )}


      {/* ステップインジケーター */}
      <div className="step-progress">
        {[1, 2, 3, 4, 5, 6].map((step) => (
          <div
            key={step}
            className={
              wizardStep === step
                ? "step-item active"
                : wizardStep > step
                ? "step-item completed"
                : "step-item"
            }
          >
            <div className="step-circle">{step}</div>
            <div className="step-name">
              {step === 1 && "アップロード"}
              {step === 2 && "フレーム抽出"}
              {step === 3 && "姿勢推定"}
              {step === 4 && "区間設定"}
              {step === 5 && "マーカー"}
              {step === 6 && "結果"}
            </div>
          </div>
        ))}
      </div>

      {/* コンテンツエリア */}
      <main className="wizard-main">{renderStepContent()}</main>

      {/* 非表示のビデオ要素とキャンバス */}
      <div style={{ display: "none" }}>
        <video
          ref={videoRef}
          playsInline
          muted
          preload="auto"
        />
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};

export default App;
