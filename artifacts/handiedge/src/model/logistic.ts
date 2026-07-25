/**
 * Pure-TypeScript logistic regression — the trained ML component. No native
 * dependencies: it trains by batch gradient descent on standardized features
 * and serializes to plain JSON, so the model is fully portable and the whole
 * pipeline stays single-language.
 */

export interface LogisticModel {
  weights: number[];
  bias: number;
  mean: number[];
  std: number[];
  featureCount: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function standardize(row: number[], mean: number[], std: number[]): number[] {
  return row.map((v, i) => (v - mean[i]!) / (std[i]! || 1));
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
}

/** Train on rows X (n × d) with binary labels y. Deterministic (zero init). */
export function trainLogistic(
  X: number[][],
  y: number[],
  options: TrainOptions = {},
): LogisticModel {
  const epochs = options.epochs ?? 400;
  const lr = options.learningRate ?? 0.1;
  const l2 = options.l2 ?? 1e-4;
  const n = X.length;
  if (n === 0) throw new Error("cannot train on an empty dataset");
  const d = X[0]!.length;

  // Feature standardization.
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j]! / n;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j]! - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;

  const Xs = X.map((row) => standardize(row, mean, std));
  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * Xs[i]![j]!;
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < d; j++) gradW[j] += (err * Xs[i]![j]!) / n;
      gradB += err / n;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (gradW[j] + l2 * weights[j]);
    bias -= lr * gradB;
  }

  return { weights, bias, mean, std, featureCount: d };
}

export function predictLogistic(model: LogisticModel, row: number[]): number {
  if (row.length !== model.featureCount) {
    throw new Error(`feature count mismatch: got ${row.length}, expected ${model.featureCount}`);
  }
  const xs = standardize(row, model.mean, model.std);
  let z = model.bias;
  for (let j = 0; j < model.featureCount; j++) z += model.weights[j]! * xs[j]!;
  return sigmoid(z);
}
