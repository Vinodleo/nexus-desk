import * as tf from '@tensorflow/tfjs';

export async function trainMetaModel(features: number[][], labels: number[]) {
  if (features.length === 0) return null;
  
  const model = tf.sequential();
  
  // A small lightweight neural network
  model.add(tf.layers.dense({ units: 16, activation: 'relu', inputShape: [features[0].length] }));
  model.add(tf.layers.dense({ units: 8, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
  
  model.compile({ optimizer: 'adam', loss: 'binaryCrossentropy', metrics: ['accuracy'] });
  
  const xs = tf.tensor2d(features);
  const ys = tf.tensor2d(labels, [labels.length, 1]);
  
  await model.fit(xs, ys, {
    epochs: 50,
    batchSize: 32,
    shuffle: true,
    verbose: 0
  });
  
  xs.dispose();
  ys.dispose();
  
  return model;
}

export function predictConfidenceBatch(model: tf.LayersModel, featuresBatch: number[][]): number[] {
  if (featuresBatch.length === 0) return [];
  const xs = tf.tensor2d(featuresBatch);
  const prediction = model.predict(xs) as tf.Tensor;
  const data = prediction.dataSync(); // synchronous download for speed
  xs.dispose();
  prediction.dispose();
  return Array.from(data);
}

/** The model the live scanner uses (set by promotion or online learning). */
export const LIVE_MODEL_PATH = 'localstorage://meta-model';
/** The Lab's latest trained model, waiting to be promoted. */
export const CANDIDATE_MODEL_PATH = 'localstorage://meta-model-candidate';

/** Makes the Lab's candidate model the live one. False if there's no candidate. */
export async function promoteCandidateModel(): Promise<boolean> {
  try {
    await tf.io.copyModel(CANDIDATE_MODEL_PATH, LIVE_MODEL_PATH);
    return true;
  } catch (err) {
    console.warn("No Lab model to promote", err);
    return false;
  }
}

export async function loadMetaModel(path: string = LIVE_MODEL_PATH): Promise<tf.LayersModel | null> {
  try {
    const model = await tf.loadLayersModel(path);
    return model;
  } catch (err) {
    console.warn("No trained ML model found at path", path);
    return null;
  }
}
