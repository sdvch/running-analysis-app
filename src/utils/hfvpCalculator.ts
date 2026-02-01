/**
 * H-FVP (Horizontal Force-Velocity Profile) Calculator
 * 
 * シングルカメラ走行分析から水平方向の力-速度プロファイルを計算
 * 
 * Based on:
 * - Samozino et al. (2016). A simple method for measuring power, force, velocity properties, 
 *   and mechanical effectiveness in sprint running. Scandinavian Journal of Medicine & Science in Sports.
 * - Morin & Samozino (2016). Interpreting Power-Force-Velocity Profiles for Individualized 
 *   and Specific Training. International Journal of Sports Physiology and Performance.
 */

export interface HFVPResult {
  // Core parameters
  F0: number;           // Maximum horizontal force (N)
  V0: number;           // Maximum velocity (m/s)
  Pmax: number;         // Maximum power (W)
  RFmax: number;        // Maximum ratio of force (%)
  DRF: number;          // Decrease in ratio of force (%/(m/s))
  
  // Mechanical effectiveness
  FVSlope: number;      // Force-velocity slope (N/(m/s))
  mechanicalEffectiveness: number; // Ratio of actual vs optimal FV profile (%)
  
  // Data points for visualization
  dataPoints: {
    velocity: number;       // m/s
    horizontalForce: number; // N
    verticalForce: number;  // N (estimated)
    resultantForce: number; // N
    power: number;          // W
    forceRatio: number;     // %
    distance: number;       // m
    acceleration: number;   // m/s²
    contactAngle: number;   // degrees (estimated)
  }[];
  
  // Regression quality
  rSquared: number;       // Coefficient of determination (force-velocity)
  
  // Summary
  summary: {
    avgForce: number;         // Average horizontal force (N)
    avgPower: number;         // Average power (W)
    peakVelocity: number;     // Peak velocity in the run (m/s)
    avgAcceleration: number;  // Average acceleration (m/s²)
    peakAcceleration: number; // Peak acceleration (m/s²)
    avgForceRatio: number;    // Average RF (%)
    totalDistance: number;    // Total distance covered (m)
    totalTime: number;        // Total time (s)
  };
  
  // Quality indicators
  quality: {
    isValid: boolean;
    warnings: string[];
    dataQuality: 'excellent' | 'good' | 'fair' | 'poor';
  };
  
  // Measurement mode (added for panning support)
  measurementMode?: 'fixed' | 'panning';
  isPanningHighQuality?: boolean;
}

export interface StepDataForHFVP {
  distanceAtContactM: number;
  speedMps: number | null;
  strideM: number | null;
  contactTimeS: number;
  flightTimeS: number;
}

/**
 * Split data for panning mode (simplified, no contact/flight time needed)
 */
export interface PanningSplitDataForHFVP {
  distance: number;    // Distance from start (m)
  time: number;        // Time from start (s)
  velocity: number;    // Average velocity in this segment (m/s)
}

/**
 * Calculate H-FVP from step data using Samozino method
 * 
 * @param steps - Array of step data from single-camera analysis
 * @param bodyMassKg - Athlete's body mass (kg)
 * @param athleteHeightM - Athlete's height (m)
 * @returns HFVPResult or null if insufficient data
 */
export function calculateHFVP(
  steps: StepDataForHFVP[],
  bodyMassKg: number,
  athleteHeightM: number = 1.75
): HFVPResult | null {
  console.log(`\n📊 === H-FVP Calculation (Detailed Model) ===`);
  console.log(`   Body mass: ${bodyMassKg.toFixed(1)} kg`);
  console.log(`   Height: ${athleteHeightM.toFixed(2)} m`);
  console.log(`   Total steps: ${steps.length}`);
  
  // Validation
  if (steps.length < 3) {
    console.warn('⚠️ Not enough steps for H-FVP calculation (minimum: 3)');
    return null;
  }
  
  if (bodyMassKg <= 0 || bodyMassKg > 200) {
    console.warn('⚠️ Invalid body mass for H-FVP calculation');
    return null;
  }
  
  if (athleteHeightM <= 0 || athleteHeightM > 2.5) {
    console.warn('⚠️ Invalid height for H-FVP calculation');
    return null;
  }
  
  const g = 9.81; // Gravity (m/s²)
  const warnings: string[] = [];
  
  // Filter valid steps (with speed and stride)
  const validSteps = steps.filter(
    step => step.speedMps !== null && 
            step.speedMps > 0 && 
            step.strideM !== null && 
            step.strideM > 0 &&
            step.contactTimeS > 0 &&
            step.flightTimeS >= 0
  );
  
  if (validSteps.length < 3) {
    console.warn('⚠️ Not enough valid steps with complete data (minimum: 3)');
    return null;
  }
  
  console.log(`   Valid steps: ${validSteps.length}`);
  
  // Calculate velocities and accelerations
  const dataPoints: HFVPResult['dataPoints'] = [];
  const velocities: number[] = [];
  const horizontalForces: number[] = [];
  
  for (let i = 0; i < validSteps.length; i++) {
    const step = validSteps[i];
    const velocity = step.speedMps!;
    velocities.push(velocity);
    
    // Calculate acceleration
    let acceleration = 0;
    if (i < validSteps.length - 1) {
      const nextStep = validSteps[i + 1];
      const nextVelocity = nextStep.speedMps!;
      const deltaT = step.contactTimeS + step.flightTimeS;
      
      if (deltaT > 0) {
        acceleration = (nextVelocity - velocity) / deltaT;
      }
    } else if (i > 0) {
      // Last step: use previous acceleration
      const prevStep = validSteps[i - 1];
      const prevVelocity = prevStep.speedMps!;
      const deltaT = prevStep.contactTimeS + prevStep.flightTimeS;
      
      if (deltaT > 0) {
        acceleration = (velocity - prevVelocity) / deltaT;
      }
    }
    
    // Air resistance (drag force)
    // F_drag = 0.5 * ρ * C_d * A * v²
    // ρ = air density (1.225 kg/m³ at sea level)
    // C_d = drag coefficient for running human (~0.9)
    // A = frontal area (estimated from height: A ≈ 0.2025 * height²)
    const rho = 1.225; // kg/m³
    const Cd = 0.9;
    const frontalArea = 0.2025 * athleteHeightM * athleteHeightM; // m²
    const dragForce = 0.5 * rho * Cd * frontalArea * velocity * velocity;
    
    // Net horizontal force (Newton's 2nd law + air resistance)
    // F_horizontal = m * a + F_drag
    const horizontalForce = bodyMassKg * acceleration + dragForce;
    horizontalForces.push(horizontalForce);
    
    // Estimate contact angle and vertical force
    // Contact angle decreases with velocity (more horizontal at higher speeds)
    // θ ≈ 60° at start → 45° at max speed (rough estimation)
    const maxVelocity = Math.max(...velocities);
    const velocityRatio = maxVelocity > 0 ? velocity / maxVelocity : 0;
    const contactAngle = 60 - 15 * velocityRatio; // degrees (60° → 45°)
    const contactAngleRad = (contactAngle * Math.PI) / 180;
    
    // Vertical force (assuming constant vertical support)
    // F_vertical = m * g / sin(θ)
    const verticalForce = bodyMassKg * g;
    
    // Resultant force
    const resultantForce = Math.sqrt(
      horizontalForce * horizontalForce + 
      verticalForce * verticalForce
    );
    
    // Power = F_horizontal * v
    const power = horizontalForce * velocity;
    
    // Force ratio: RF = F_horizontal / F_resultant
    const forceRatio = resultantForce > 0 
      ? (horizontalForce / resultantForce) * 100 
      : 0;
    
    dataPoints.push({
      velocity,
      horizontalForce,
      verticalForce,
      resultantForce,
      power,
      forceRatio,
      distance: step.distanceAtContactM,
      acceleration,
      contactAngle,
    });
  }
  
  console.log(`   Data points generated: ${dataPoints.length}`);
  
  // Check for negative forces (quality check)
  const negativeForces = dataPoints.filter(p => p.horizontalForce < 0).length;
  if (negativeForces > dataPoints.length * 0.2) {
    warnings.push(`${negativeForces} data points with negative horizontal force detected`);
    console.warn(`⚠️ ${negativeForces} negative force values detected`);
  }
  
  // Linear regression: F_horizontal = F0 - (F0/V0) * velocity
  // This is the Samozino linear force-velocity relationship
  // TEMPORARY: Allow negative forces for debugging 5m distances
  const validDataPoints = dataPoints; // Use all data points
  
  console.log(`   🔍 DEBUG: Using ${validDataPoints.length} data points (including ${negativeForces} negative forces)`);
  
  if (validDataPoints.length < 3) {
    console.warn('⚠️ Not enough valid data points after filtering (minimum: 3)');
    return null;
  }
  
  const { slope, intercept, rSquared } = linearRegression(
    validDataPoints.map(p => p.velocity),
    validDataPoints.map(p => p.horizontalForce)
  );
  
  console.log(`   Regression - Slope: ${slope.toFixed(2)}, Intercept: ${intercept.toFixed(2)}, R²: ${rSquared.toFixed(3)}`);
  
  // F0: Maximum horizontal force (when velocity = 0)
  const F0 = intercept;
  
  // V0: Theoretical maximum velocity (when force = 0)
  // From F = F0 - slope * V
  // 0 = F0 - slope * V0
  // V0 = F0 / |slope|
  const FVSlope = -slope; // Store as positive value (F0/V0)
  const V0 = FVSlope !== 0 ? F0 / FVSlope : 0;
  
  // Pmax: Maximum power = F0 * V0 / 4
  // (occurs at V = V0/2 and F = F0/2)
  const Pmax = (F0 * V0) / 4;
  
  // RFmax: Maximum ratio of force (at start, lowest velocity)
  // RF = F_horizontal / F_resultant
  // Use the first data point (lowest velocity) for RFmax calculation
  const firstDataPoint = validDataPoints[0];
  const RFmax = firstDataPoint.resultantForce > 0 
    ? (firstDataPoint.horizontalForce / firstDataPoint.resultantForce) * 100 
    : 0;
  
  // DRF: Decrease in ratio of force per unit velocity
  // DRF = -100 * d(RF)/dv
  // Samozino formula: DRF ≈ RFmax / V0
  const DRF = V0 !== 0 ? RFmax / V0 : 0;
  
  // Mechanical effectiveness
  // Optimal FV profile: F_opt = F0_opt - (F0_opt/V0_opt) * v
  // Where F0_opt and V0_opt maximize power for given Pmax
  // Optimal: F0_opt = V0_opt = √(4 * Pmax)
  const optimalFV = Math.sqrt(4 * Pmax);
  const FVimbalance = Math.abs(F0 - V0) / (F0 + V0); // 0 = balanced, 1 = very imbalanced
  const mechanicalEffectiveness = (1 - FVimbalance) * 100; // %
  
  // Summary statistics
  const avgForce = validDataPoints.reduce((sum, p) => sum + p.horizontalForce, 0) / validDataPoints.length;
  const avgPower = validDataPoints.reduce((sum, p) => sum + p.power, 0) / validDataPoints.length;
  const peakVelocity = Math.max(...validDataPoints.map(p => p.velocity));
  const avgAcceleration = validDataPoints.reduce((sum, p) => sum + Math.abs(p.acceleration), 0) / validDataPoints.length;
  const peakAcceleration = Math.max(...validDataPoints.map(p => Math.abs(p.acceleration)));
  const avgForceRatio = validDataPoints.reduce((sum, p) => sum + p.forceRatio, 0) / validDataPoints.length;
  const totalDistance = validSteps[validSteps.length - 1].distanceAtContactM - validSteps[0].distanceAtContactM;
  const totalTime = validSteps.reduce((sum, s) => sum + s.contactTimeS + s.flightTimeS, 0);
  
  // Quality assessment
  let dataQuality: 'excellent' | 'good' | 'fair' | 'poor' = 'poor';
  
  if (rSquared >= 0.9 && validDataPoints.length >= 10 && negativeForces === 0) {
    dataQuality = 'excellent';
  } else if (rSquared >= 0.8 && validDataPoints.length >= 8 && negativeForces <= 1) {
    dataQuality = 'good';
  } else if (rSquared >= 0.7 && validDataPoints.length >= 6 && negativeForces <= 2) {
    dataQuality = 'fair';
  }
  
  if (rSquared < 0.7) {
    warnings.push(`Low R² value (${rSquared.toFixed(3)}) - regression quality is poor`);
  }
  
  if (F0 <= 0 || V0 <= 0) {
    warnings.push('Invalid F0 or V0 values - check input data quality');
    console.error('❌ Invalid F0 or V0');
    return null;
  }
  
  if (V0 < peakVelocity * 0.9) {
    warnings.push('V0 is too close to peak velocity - may indicate incomplete acceleration phase');
  }
  
  const isValid = F0 > 0 && V0 > 0 && Pmax > 0 && rSquared > 0.5;
  
  console.log(`\n✅ H-FVP Results (Detailed Model):`);
  console.log(`   F0 (Max Force): ${F0.toFixed(1)} N`);
  console.log(`   V0 (Max Velocity): ${V0.toFixed(2)} m/s`);
  console.log(`   Pmax (Max Power): ${Pmax.toFixed(1)} W`);
  console.log(`   RFmax (Max Force Ratio): ${RFmax.toFixed(1)} %`);
  console.log(`   DRF (Force Decrease Rate): ${DRF.toFixed(2)} %/(m/s)`);
  console.log(`   FV Slope: ${FVSlope.toFixed(2)} N/(m/s)`);
  console.log(`   Mechanical Effectiveness: ${mechanicalEffectiveness.toFixed(1)} %`);
  console.log(`   R² (Regression Quality): ${rSquared.toFixed(3)}`);
  console.log(`   Data Quality: ${dataQuality}`);
  console.log(`   Warnings: ${warnings.length}`);
  
  return {
    F0,
    V0,
    Pmax,
    RFmax,
    DRF,
    FVSlope,
    mechanicalEffectiveness,
    dataPoints,
    rSquared,
    summary: {
      avgForce,
      avgPower,
      peakVelocity,
      avgAcceleration,
      peakAcceleration,
      avgForceRatio,
      totalDistance,
      totalTime,
    },
    quality: {
      isValid,
      warnings,
      dataQuality,
    },
  };
}

/**
 * Linear regression: y = intercept + slope * x
 */
function linearRegression(
  x: number[],
  y: number[]
): { slope: number; intercept: number; rSquared: number } {
  const n = x.length;
  
  if (n < 2) {
    return { slope: 0, intercept: 0, rSquared: 0 };
  }
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
  
  const meanX = sumX / n;
  const meanY = sumY / n;
  
  // Slope
  const numerator = n * sumXY - sumX * sumY;
  const denominator = n * sumX2 - sumX * sumX;
  const slope = denominator !== 0 ? numerator / denominator : 0;
  
  // Intercept
  const intercept = meanY - slope * meanX;
  
  // R-squared
  const ssTotal = sumY2 - n * meanY * meanY;
  const ssResidual = y.reduce((sum, yi, i) => {
    const predicted = intercept + slope * x[i];
    const residual = yi - predicted;
    return sum + residual * residual;
  }, 0);
  
  const rSquared = ssTotal !== 0 ? Math.max(0, 1 - (ssResidual / ssTotal)) : 0;
  
  return { slope, intercept, rSquared };
}

/**
 * Calculate optimal F-V profile for comparison
 * Based on Samozino et al. optimal profile theory
 */
export function calculateOptimalProfile(
  actualF0: number,
  actualV0: number,
  bodyMassKg: number
): {
  optimalF0: number;
  optimalV0: number;
  FVimbalance: number;
  deficit: 'force' | 'velocity' | 'balanced';
} {
  const Pmax = (actualF0 * actualV0) / 4;
  
  // Optimal: F0 = V0 for maximum effectiveness
  const optimal = Math.sqrt(4 * Pmax);
  
  const optimalF0 = optimal;
  const optimalV0 = optimal;
  
  // FV imbalance: 0 = perfectly balanced, 100 = completely imbalanced
  const FVimbalance = Math.abs(actualF0 - actualV0) / (actualF0 + actualV0) * 100;
  
  // Determine deficit type
  let deficit: 'force' | 'velocity' | 'balanced' = 'balanced';
  
  if (actualF0 / actualV0 > 1.1) {
    deficit = 'velocity'; // Force-oriented profile → need more velocity
  } else if (actualV0 / actualF0 > 1.1) {
    deficit = 'force'; // Velocity-oriented profile → need more force
  }
  
  return {
    optimalF0,
    optimalV0,
    FVimbalance,
    deficit,
  };
}

/**
 * Format H-FVP results for display
 */
export function formatHFVPResults(hfvp: HFVPResult): string {
  const optimal = calculateOptimalProfile(hfvp.F0, hfvp.V0, 70); // Default 70kg for display
  
  return `
H-FVP Analysis Results (Detailed Model)
========================================

Core Parameters:
- F0 (Maximum Force): ${hfvp.F0.toFixed(1)} N
- V0 (Maximum Velocity): ${hfvp.V0.toFixed(2)} m/s
- Pmax (Maximum Power): ${hfvp.Pmax.toFixed(1)} W
- RFmax (Maximum Force Ratio): ${hfvp.RFmax.toFixed(1)} %
- DRF (Force Decrease Rate): ${hfvp.DRF.toFixed(2)} %/(m/s)

Mechanical Profile:
- FV Slope: ${hfvp.FVSlope.toFixed(2)} N/(m/s)
- Mechanical Effectiveness: ${hfvp.mechanicalEffectiveness.toFixed(1)} %
- FV Imbalance: ${optimal.FVimbalance.toFixed(1)} %
- Profile Type: ${optimal.deficit === 'force' ? 'Velocity-Oriented (Need more Force)' : optimal.deficit === 'velocity' ? 'Force-Oriented (Need more Velocity)' : 'Balanced'}

Quality:
- R² (Regression): ${hfvp.rSquared.toFixed(3)}
- Data Quality: ${hfvp.quality.dataQuality}
- Valid: ${hfvp.quality.isValid ? 'Yes' : 'No'}
${hfvp.quality.warnings.length > 0 ? `- Warnings: ${hfvp.quality.warnings.join(', ')}` : ''}

Summary:
- Average Force: ${hfvp.summary.avgForce.toFixed(1)} N
- Average Power: ${hfvp.summary.avgPower.toFixed(1)} W
- Peak Velocity: ${hfvp.summary.peakVelocity.toFixed(2)} m/s
- Avg Acceleration: ${hfvp.summary.avgAcceleration.toFixed(2)} m/s²
- Peak Acceleration: ${hfvp.summary.peakAcceleration.toFixed(2)} m/s²
- Avg Force Ratio: ${hfvp.summary.avgForceRatio.toFixed(1)} %
- Total Distance: ${hfvp.summary.totalDistance.toFixed(2)} m
- Total Time: ${hfvp.summary.totalTime.toFixed(2)} s

Optimal Profile (for comparison):
- Optimal F0: ${optimal.optimalF0.toFixed(1)} N
- Optimal V0: ${optimal.optimalV0.toFixed(2)} m/s
- Current F0/Optimal: ${(hfvp.F0 / optimal.optimalF0 * 100).toFixed(1)} %
- Current V0/Optimal: ${(hfvp.V0 / optimal.optimalV0 * 100).toFixed(1)} %
`.trim();
}

/**
 * Generate training recommendations based on H-FVP
 */
export function generateTrainingRecommendations(hfvp: HFVPResult): string[] {
  const optimal = calculateOptimalProfile(hfvp.F0, hfvp.V0, 70);
  const recommendations: string[] = [];
  
  // Profile-specific recommendations
  if (optimal.deficit === 'force') {
    recommendations.push('🏋️ Focus on maximum strength training (heavy squats, deadlifts)');
    recommendations.push('⚡ Add explosive strength exercises (jump squats, power cleans)');
    recommendations.push('🏃 Sled pushing/pulling for horizontal force development');
  } else if (optimal.deficit === 'velocity') {
    recommendations.push('⚡ Focus on maximum velocity training (flying sprints 30-40m)');
    recommendations.push('🎯 Improve running technique and stride frequency');
    recommendations.push('🏃 Assisted sprints (downhill, bungee-assisted)');
  } else {
    recommendations.push('✅ Well-balanced profile - maintain current training balance');
    recommendations.push('📈 Focus on increasing both F0 and V0 proportionally');
  }
  
  // Data quality recommendations
  if (hfvp.quality.dataQuality === 'fair' || hfvp.quality.dataQuality === 'poor') {
    recommendations.push('⚠️ Improve data quality: ensure full acceleration phase is captured');
    recommendations.push('📹 Use longer sprint distance (minimum 20-30m)');
  }
  
  // Mechanical effectiveness
  if (hfvp.mechanicalEffectiveness < 80) {
    recommendations.push('🔧 Low mechanical effectiveness - work on force application technique');
    recommendations.push('👟 Consider sprint drills focusing on horizontal force projection');
  }
  
  return recommendations;
}

/**
 * Calculate H-FVP from panning mode split data
 * Simplified calculation using only distance, time, and velocity
 * 
 * @param splits - Array of split data from panning mode
 * @param bodyMassKg - Athlete's body mass (kg)
 * @param athleteHeightM - Athlete's height (m)
 * @returns HFVPResult or null if insufficient data
 */
/**
 * パンモード用 H-FVP 計算
 * 
 * Samozino et al. (2016) の手法に基づき、距離-時間データから H-FVP を計算
 * 
 * 主要な式:
 * 1. 各地点での速度: v = d / t
 * 2. 加速度: a = (v_next² - v_prev²) / (2 × d)
 * 3. 水平力: F_h = m × a + F_air
 * 4. 線形回帰: F_h = F0 - (F0/V0) × v
 */
export function calculateHFVPFromPanningSplits(
  splits: PanningSplitDataForHFVP[],
  bodyMassKg: number,
  athleteHeightM: number = 1.75
): HFVPResult | null {
  console.log(`\n📊 === H-FVP Calculation (Panning Mode - Samozino Method) ===`);
  console.log(`   Body mass: ${bodyMassKg.toFixed(1)} kg`);
  console.log(`   Height: ${athleteHeightM.toFixed(2)} m`);
  console.log(`   Total splits: ${splits.length}`);
  
  // Validation
  if (splits.length < 3) {
    console.warn('⚠️ Not enough splits for H-FVP calculation (minimum: 3)');
    return null;
  }
  
  if (bodyMassKg <= 0 || bodyMassKg > 200) {
    console.warn('⚠️ Invalid body mass for H-FVP calculation');
    return null;
  }
  
  if (athleteHeightM <= 0 || athleteHeightM > 2.5) {
    console.warn('⚠️ Invalid height for H-FVP calculation');
    return null;
  }
  
  const g = 9.81; // Gravity (m/s²)
  const warnings: string[] = [];
  
  // Samozino et al. (2016) の正確な方法：区間ベースの計算
  const dataPoints: HFVPResult['dataPoints'] = [];
  const velocities: number[] = [];
  const horizontalForces: number[] = [];
  
  // 各区間の平均速度を先に計算
  const intervalVelocities: number[] = [];
  for (let i = 1; i < splits.length; i++) {
    const deltaD = splits[i].distance - splits[i-1].distance;
    const deltaT = splits[i].time - splits[i-1].time;
    intervalVelocities.push(deltaD / deltaT);
  }
  
  // 各区間で計算
  for (let i = 1; i < splits.length; i++) {
    const prevSplit = splits[i - 1];
    const currSplit = splits[i];
    
    // 区間の距離と時間
    const deltaD = currSplit.distance - prevSplit.distance;
    const deltaT = currSplit.time - prevSplit.time;
    
    if (deltaT <= 0 || deltaD <= 0) {
      console.warn(`⚠️ Invalid interval ${i}: deltaD=${deltaD}, deltaT=${deltaT}`);
      continue;
    }
    
    // 区間の平均速度
    const v_avg = intervalVelocities[i - 1];
    
    // 加速度の計算（シンプルな方法）
    // 前の区間との速度差から計算
    let a_avg = 0;
    if (i === 1) {
      // 最初の区間：0から加速
      a_avg = v_avg / deltaT;
    } else {
      // 速度の変化率
      const v_prev = intervalVelocities[i - 2];
      const v_curr = intervalVelocities[i - 1];
      a_avg = (v_curr - v_prev) / deltaT;
    }
    
    // 線形回帰用の速度（区間の平均速度）
    const velocity = v_avg;
    velocities.push(velocity);
    
    // 空気抵抗（平均速度で計算）
    const rho = 1.225; // kg/m³
    const Cd = 0.9;
    const frontalArea = 0.2025 * athleteHeightM * athleteHeightM; // m²
    const dragForce = 0.5 * rho * Cd * frontalArea * v_avg * v_avg;
    
    // 水平方向の正味力（Newtonの第2法則 + 空気抵抗）
    const horizontalForce = bodyMassKg * a_avg + dragForce;
    horizontalForces.push(horizontalForce);
    
    // 接地角度を速度から推定
    // 低速: ~65°, 高速: ~48°
    const maxVelocity = velocities.length > 0 ? Math.max(...velocities) : v_avg;
    const minVelocity = velocities.length > 0 ? Math.min(...velocities) : 0;
    const velocityRange = maxVelocity - minVelocity;
    const velocityRatio = velocityRange > 0 ? (velocity - minVelocity) / velocityRange : 0;
    const contactAngleDeg = 65 - 17 * velocityRatio; // 65° → 48°
    const contactAngleRad = (contactAngleDeg * Math.PI) / 180;
    
    // 垂直力を接地角度から推定
    // F_v / F_h = tan(θ) より F_v = F_h × tan(θ)
    const tanAngle = Math.tan(contactAngleRad);
    const verticalForce = horizontalForce * tanAngle;
    
    // 合成力
    const resultantForce = Math.sqrt(
      horizontalForce * horizontalForce + 
      verticalForce * verticalForce
    );
    
    // パワー
    const power = horizontalForce * velocity;
    
    // 力比率
    const forceRatio = resultantForce > 0 
      ? (horizontalForce / resultantForce) * 100 
      : 0;
    
    console.log(`   Interval ${i} (${prevSplit.distance.toFixed(0)}-${currSplit.distance.toFixed(0)}m): v_avg=${v_avg.toFixed(2)} m/s, a=${a_avg.toFixed(2)} m/s², F_h=${horizontalForce.toFixed(1)} N`);
    
    dataPoints.push({
      velocity: v_avg,  // 線形回帰用に平均速度を使用
      horizontalForce,
      verticalForce,
      resultantForce,
      power,
      forceRatio,
      distance: currSplit.distance,
      acceleration: a_avg,
      contactAngle: contactAngleDeg,
    });
  }
  
  console.log(`   Data points generated: ${dataPoints.length}`);
  
  // Linear regression: F_horizontal = F0 - (F0/V0) * velocity
  const { slope, intercept, rSquared } = linearRegression(
    dataPoints.map(p => p.velocity),
    dataPoints.map(p => p.horizontalForce)
  );
  
  console.log(`   Regression - Slope: ${slope.toFixed(2)}, Intercept: ${intercept.toFixed(2)}, R²: ${rSquared.toFixed(3)}`);
  
  // F0: Maximum horizontal force (when velocity = 0)
  const F0 = intercept;
  
  // V0: Theoretical maximum velocity (when force = 0)
  const FVSlope = -slope;
  const V0 = FVSlope !== 0 ? F0 / FVSlope : 0;
  
  console.log(`   F0: ${F0.toFixed(2)} N, V0: ${V0.toFixed(2)} m/s`);
  
  // Validation
  if (F0 <= 0 || V0 <= 0 || !isFinite(F0) || !isFinite(V0)) {
    console.error(`❌ calculateHFVP (hfvpCalculator.ts): Invalid F0 or V0`, { F0, V0, slope, intercept });
    return null;
  }
  
  // Pmax: Maximum power = F0 * V0 / 4
  const Pmax = (F0 * V0) / 4;
  
  // RFmax: Maximum ratio of force (at first data point)
  const firstDataPoint = dataPoints[0];
  const RFmax = firstDataPoint.resultantForce > 0
    ? (firstDataPoint.horizontalForce / firstDataPoint.resultantForce) * 100
    : 0;
  
  // DRF: Decrease in RF per unit velocity
  // DRF = (RF at v=0 - RF at v=V0) / V0
  // Simplified: DRF ≈ -RFmax / V0
  const DRF = V0 > 0 ? -RFmax / V0 : 0;
  
  // Calculate optimal profile
  const optimal = calculateOptimalProfile(F0, V0, bodyMassKg);
  const optimalPmax = (optimal.optimalF0 * optimal.optimalV0) / 4;
  const mechanicalEffectiveness = (Pmax / optimalPmax) * 100;
  
  // Summary statistics
  const avgForce = horizontalForces.reduce((sum, f) => sum + f, 0) / horizontalForces.length;
  const avgPower = dataPoints.reduce((sum, p) => sum + p.power, 0) / dataPoints.length;
  const peakVelocity = Math.max(...velocities);
  const allAccelerations = dataPoints.map(p => p.acceleration);
  const avgAcceleration = allAccelerations.reduce((sum, a) => sum + a, 0) / allAccelerations.length;
  const peakAcceleration = Math.max(...allAccelerations);
  const avgForceRatio = dataPoints.reduce((sum, p) => sum + p.forceRatio, 0) / dataPoints.length;
  const totalDistance = splits[splits.length - 1].distance - splits[0].distance;
  const totalTime = splits[splits.length - 1].time - splits[0].time;
  
  // Quality assessment
  let dataQuality: 'excellent' | 'good' | 'fair' | 'poor' = 'good';
  if (rSquared >= 0.95 && dataPoints.length >= 8) {
    dataQuality = 'excellent';
  } else if (rSquared >= 0.90 && dataPoints.length >= 5) {
    dataQuality = 'good';
  } else if (rSquared >= 0.80) {
    dataQuality = 'fair';
  } else {
    dataQuality = 'poor';
    warnings.push('Low R² value - data may not follow linear FV relationship');
  }
  
  if (dataPoints.length < 5) {
    warnings.push('Limited data points - results may be less accurate');
  }
  
  if (totalDistance < 20) {
    warnings.push('Short measurement distance - may not capture full acceleration phase');
  }
  
  const result: HFVPResult = {
    F0,
    V0,
    Pmax,
    RFmax,
    DRF,
    FVSlope,
    mechanicalEffectiveness,
    dataPoints,
    rSquared,
    summary: {
      avgForce,
      avgPower,
      peakVelocity,
      avgAcceleration,
      peakAcceleration,
      avgForceRatio,
      totalDistance,
      totalTime,
    },
    quality: {
      isValid: true,
      warnings,
      dataQuality,
    },
    measurementMode: 'panning',
    isPanningHighQuality: dataPoints.length >= 8 && totalDistance >= 50,
  };
  
  console.log(`✅ H-FVP calculation complete (Panning Mode)`);
  console.log(`   F0: ${F0.toFixed(2)} N (${(F0/bodyMassKg).toFixed(2)} N/kg)`);
  console.log(`   V0: ${V0.toFixed(2)} m/s`);
  console.log(`   Pmax: ${Pmax.toFixed(2)} W (${(Pmax/bodyMassKg).toFixed(2)} W/kg)`);
  console.log(`   RFmax: ${RFmax.toFixed(1)}%`);
  console.log(`   DRF: ${DRF.toFixed(2)} %/(m/s)`);
  console.log(`   Mechanical Effectiveness: ${mechanicalEffectiveness.toFixed(1)}%`);
  console.log(`   Data Quality: ${dataQuality} (R²: ${rSquared.toFixed(3)})`);
  
  return result;
}
