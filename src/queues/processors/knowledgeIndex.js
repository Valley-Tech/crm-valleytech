import { indexSource } from '../../ai/knowledge.js';

/** Indexa una fuente de conocimiento (archivo, URL, sitio, FAQ) en Gemini File Search. */
export default async function processKnowledgeIndex(job) {
  return indexSource(job.data.sourceId);
}
