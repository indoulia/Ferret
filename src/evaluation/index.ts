export {
  CORPUS_SCOPE,
  GOLDEN_DATASET_DIR,
  QueryShape,
  computeGoldenChecksum,
  Relevance,
  loadGoldenDataset,
  resolveIdentity,
  type GoldenDataset,
  type GoldenEvidenceExpectation,
  type GoldenExpected,
  type GoldenHistory,
  type GoldenIdentity,
  type GoldenQuery,
} from './dataset.js';

export {
  meanOf,
  ndcgAtK,
  precisionAtK,
  recallOf,
  reciprocalRank,
  type Grades,
} from './metrics.js';

export {
  DEFAULT_K,
  measureRetrievalQuality,
  type MeasurableRetrieval,
  type QueryMeasurement,
  type RetrievalQualityReport,
} from './quality.js';
