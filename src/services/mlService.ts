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

export async function loadMetaModel(path: string = 'localstorage://meta-model'): Promise<tf.LayersModel | null> {
  try {
    const model = await tf.loadLayersModel(path);
    return model;
  } catch (err) {
    console.warn("No trained ML model found at path", path);
    return null;
  }
}
