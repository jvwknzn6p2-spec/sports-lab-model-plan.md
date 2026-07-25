/**
 * Probability calibration via Platt scaling: fit sigmoid(a·p + b) mapping raw
 * model probabilities to empirical frequencies. Monotonic by construction and
 * serializes to two numbers. Falls back to identity when unfitted.
 */

export interface Calibrator {
  a: number;
  b: number;
  fitted: boolean;
}

export const IDENTITY_CALIBRATOR: Calibrator = { a: 1, b: 0, fitted: false };

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** Fit Platt parameters by gradient descent on (rawProb → outcome). */
export function fitCalibrator(rawProbs: number[], outcomes: number[]): Calibrator {
  const n = rawProbs.length;
  if (n === 0) return { ...IDENTITY_CALIBRATOR };
  let a = 1;
  let b = 0;
  const lr = 0.5;
  for (let epoch = 0; epoch < 500; epoch++) {
    let gA = 0;
    let gB = 0;
    for (let i = 0; i < n; i++) {
      const p = rawProbs[i]!;
      const err = sigmoid(a * p + b) - outcomes[i]!;
      gA += (err * p) / n;
      gB += err / n;
    }
    a -= lr * gA;
    b -= lr * gB;
  }
  return { a, b, fitted: true };
}

export function applyCalibrator(cal: Calibrator, prob: number): number {
  if (!cal.fitted) return prob;
  return sigmoid(cal.a * prob + cal.b);
}
