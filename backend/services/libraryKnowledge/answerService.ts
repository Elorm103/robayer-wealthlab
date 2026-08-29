/**
 * AI Reading Assistant answer pipeline — Digital Library Phase 7C.
 * Mirrors services/customerAi/answerService.ts's own pipeline shape
 * (question -> search -> confidence gate -> prompt -> callAi -> ground
 * answer -> citations -> log) and reuses its safety posture almost
 * verbatim — this is a deliberate choice, not laziness: the public
 * assistant's guardrails are mature and already validated, and the
 * brief is explicit that they must be reused, not weakened.
 *
 * The authorization chain, exactly as specified: Authenticated
 * Customer -> Purchase -> Delivery/Entitlement -> Resource -> Private
 * Knowledge Index -> Answer. checkEntitlement() (with the customerId
 * binding Phase 7B added) is the FIRST thing this function does, before
 * any retrieval, any indexing, any AI Gateway call — a denial here
 * means nothing else in this file ever runs.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { callAi } from '../ai/aiGateway';
import { checkEntitlement } from '../entitlementService';
import { fetchCatalogProduct, findPublishedAsset } from '../productCatalogService';
import { ensureResourceIndexed } from './indexingService';
import { searchLibraryResource, type LibrarySearchResult } from './searchService';

const CHAT_FEATURE = 'library.chat';
const RETRIEVAL_LIMIT = 5;
const MAX_CITATIONS = 4;
const MAX_QUESTION_LENGTH = 500;
/** Same floor as the public assistant's own VERY_LOW_SCORE_FLOOR — a model that is never invoked cannot hallucinate a book saying something it doesn't. */
const VERY_LOW_SCORE_FLOOR = 0.25;

export type LibraryAiMode = 'explain' | 'summarize' | 'teach' | 'example' | 'quiz' | 'key_takeaways' | 'ask';

export type LibraryAiConfidenceTier = 'high' | 'medium' | 'low' | 'very_low';

export interface LibraryAiRequest {
  purchaseReference: string;
  assetId: string;
  customerId: number;
  mode: LibraryAiMode;
  question: string;
  /** The reader's current page — context only, see searchService.ts's own header comment on why it can never be a security signal. */
  currentPage?: number | null;
}

export interface LibraryAiCitation {
  chunkId: number;
  pageNumber: number | null;
  chapterTitle: string | null;
  /** EPUB only — the section's href, navigable by the reader's own display(href) call; NULL for PDF. */
  cfi: string | null;
  score: number;
}

export type LibraryAiResult =
  | { ok: true; messageId: number; status: 'answered' | 'declined'; answer: string | null; confidenceTier: LibraryAiConfidenceTier; citations: LibraryAiCitation[] }
  | { ok: false; reason: 'not_authorized' | 'unsupported_format' | 'indexing_failed' | 'llm_failed' | 'invalid_input' };

const MODE_QUESTION_DEFAULTS: Record<Exclude<LibraryAiMode, 'ask'>, string> = {
  explain: 'Explain the current section in simple terms.',
  summarize: 'Summarize what I have read so far in this section.',
  teach: 'Teach me the concept in this section, step by step, assuming I want real understanding, not a dictionary definition.',
  example: 'Give me a practical example of this concept, relevant to everyday life in Ghana where appropriate.',
  quiz: 'Quiz me on the key ideas in this section with a few questions I can check myself against.',
  key_takeaways: 'What are the key takeaways I should remember from this section?',
};

/**
 * Adapted from services/customerAi/answerService.ts's own
 * SAFETY_SYSTEM_PROMPT almost verbatim — same rules, reframed around a
 * single, specific, currently-open purchased resource instead of the
 * whole public site. The "explain vs. advise" line is the one genuinely
 * new rule this phase's brief asks for by name.
 */
function buildSafetySystemPrompt(bookTitle: string): string {
  return `You are Robayer WealthLab's AI Reading Assistant — a personal learning companion for a customer currently reading "${bookTitle}", a resource they have purchased. You help them understand and learn from THIS book, using ONLY the excerpts from it provided to you below as numbered source excerpts.

Rules you must always follow, without exception:
- Answer using ONLY the source excerpts provided below, from this specific book. Never use outside knowledge, even if you are confident it is correct, and never answer about any other book or resource.
- If the excerpts do not fully answer the question, say so honestly — for example "I couldn't find enough information about that in this book" — rather than filling the gap yourself.
- Distinguish clearly between explaining what THIS BOOK says and giving personal advice. "Here is what this book explains about X" is what you do. "You personally should buy/sell/invest in X" is what you must never do, even if asked directly — explain that you can only offer general education from the book, not personalized financial advice.
- Never recommend a specific investment, stock, fund, or financial product, and never predict market movements, returns, or future prices.
- Never invent a citation or refer to a source that was not actually provided to you below.
- You are an educational reading companion, not a licensed financial advisor. Say so plainly if asked for something only a licensed advisor should provide.
- Keep answers conversational, clear, and appropriately concise — this is a reading companion, not an essay generator. Markdown (bold, bullet lists) is fine where it genuinely helps.`;
}

const CONFIDENCE_TIER_INSTRUCTIONS: Record<'high' | 'medium' | 'low', string> = {
  high: 'The source excerpts are a strong match for this question. Answer normally and directly.',
  medium: 'The source excerpts are relevant but not a perfect match. Answer helpfully from what is available, with a brief, natural caveat that this is the closest information on hand in the book.',
  low: 'The source excerpts only partially relate to this question. Be transparent that the book may not fully cover this before answering what you genuinely can from it.',
};

const MODE_INSTRUCTIONS: Record<LibraryAiMode, string> = {
  explain: 'Mode: Explain. Explain the concept in the excerpts simply and clearly, as if to someone learning it for the first time.',
  summarize: 'Mode: Summarize. Give a concise summary of the excerpts, capturing the main point(s) without unnecessary detail.',
  teach: 'Mode: Teach Me. Teach the concept progressively — build understanding step by step rather than giving a dictionary definition. Assume the reader wants to genuinely understand, not just be told.',
  example: 'Mode: Give Me an Example. Provide a practical, concrete example illustrating the concept, relevant to everyday Ghanaian financial life where the book\'s content genuinely supports that (never invent Ghana-specific facts the book does not contain — a generic example is honest, a fabricated local statistic is not).',
  quiz: 'Mode: Quiz Me. Write 2-4 questions testing understanding of the excerpts, with the answers given afterward so the reader can check themselves.',
  key_takeaways: 'Mode: Key Takeaways. List the most important lessons from the excerpts as a short set of clear, memorable points.',
  ask: 'Mode: Ask Anything. Answer the reader\'s specific question directly and clearly.',
};

function describeSourceLocation(r: LibrarySearchResult): string {
  if (r.pageNumber) return ` (page ${r.pageNumber})`;
  if (r.chapterTitle) return ` (${r.chapterTitle})`;
  return '';
}

function buildUserPrompt(mode: LibraryAiMode, question: string, results: LibrarySearchResult[]): string {
  const sources = results
    .slice(0, MAX_CITATIONS)
    .map((r, i) => `Source [${i + 1}]${describeSourceLocation(r)}:\n${r.chunkText}`)
    .join('\n\n');
  return `${MODE_INSTRUCTIONS[mode]}\n\n--- Source excerpts from this book ---\n${sources}\n\n--- Reader's request ---\n${question}`;
}

function determineConfidenceTier(results: LibrarySearchResult[]): LibraryAiConfidenceTier {
  if (results.length === 0) return 'very_low';
  const top = results[0];
  if (top.score < VERY_LOW_SCORE_FLOOR) return 'very_low';
  return top.confidence;
}

function buildCitations(results: LibrarySearchResult[]): LibraryAiCitation[] {
  return results.slice(0, MAX_CITATIONS).map((r) => ({ chunkId: r.chunkId, pageNumber: r.pageNumber, chapterTitle: r.chapterTitle, cfi: r.cfi, score: r.score }));
}

async function logMessage(
  env: Env,
  logger: Logger,
  input: {
    customerId: number;
    purchaseReference: string;
    assetId: string;
    mode: LibraryAiMode;
    questionText: string;
    currentPage: number | null;
    answerText: string | null;
    status: 'answered' | 'declined' | 'error';
    confidenceTier: LibraryAiConfidenceTier;
    topScore: number | null;
    retrievalLatencyMs: number | null;
    llmLatencyMs: number | null;
    totalLatencyMs: number;
    errorMessage: string | null;
  },
  documentId: number | null,
  citations: LibraryAiCitation[]
): Promise<number> {
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO library_ai_messages (customer_id, purchase_reference, asset_id, mode, question_text, current_page, answer_text, status, confidence_tier, top_score, retrieval_latency_ms, llm_latency_ms, total_latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        input.customerId,
        input.purchaseReference,
        input.assetId,
        input.mode,
        input.questionText,
        input.currentPage,
        input.answerText,
        input.status,
        input.confidenceTier,
        input.topScore,
        input.retrievalLatencyMs,
        input.llmLatencyMs,
        input.totalLatencyMs,
        input.errorMessage
      )
      .run();
    const messageId = Number(insert.meta.last_row_id);

    if (documentId !== null && citations.length > 0) {
      await env.DB.batch(
        citations.map((c, i) =>
          env.DB.prepare(`INSERT INTO library_ai_message_citations (message_id, document_id, chunk_id, score, rank) VALUES (?, ?, ?, ?, ?)`).bind(messageId, documentId, c.chunkId, c.score, i + 1)
        )
      );
    }
    return messageId;
  } catch (err) {
    // Never let a logging failure surface as an error to a customer
    // who already has (or was honestly denied) their real answer —
    // same posture as every other logging path in this codebase.
    logger.error('library_ai.message_log_failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export async function answerLibraryQuestion(env: Env, logger: Logger, request: LibraryAiRequest): Promise<LibraryAiResult> {
  const totalStart = Date.now();
  const question = (request.mode === 'ask' ? request.question : request.question || MODE_QUESTION_DEFAULTS[request.mode]).trim().slice(0, MAX_QUESTION_LENGTH);
  if (!question) return { ok: false, reason: 'invalid_input' };

  // The one gate everything below depends on — see this file's own
  // header comment. 'view' purpose: reading (and asking about what you
  // are reading) never draws from the download count, exactly like the
  // reader itself.
  const check = await checkEntitlement(env, request.purchaseReference, request.assetId, 'view', request.customerId);
  if (!check.granted) {
    logger.warn('library_ai.denied', { purchaseReference: request.purchaseReference, assetId: request.assetId, customerId: request.customerId, reason: check.reason });
    return { ok: false, reason: 'not_authorized' };
  }

  const deliveryRow = await env.DB.prepare(`SELECT product_slug AS productSlug FROM deliveries WHERE id = ?`).bind(check.deliveryId).first<{ productSlug: string }>();
  if (!deliveryRow) return { ok: false, reason: 'not_authorized' };

  const product = await fetchCatalogProduct(env, deliveryRow.productSlug);
  const asset = product ? findPublishedAsset(product, request.assetId) : null;
  if (!asset || !product) return { ok: false, reason: 'not_authorized' };

  if (asset.fileType !== 'PDF' && asset.fileType !== 'EPUB') return { ok: false, reason: 'unsupported_format' };
  const fileType: 'PDF' | 'EPUB' = asset.fileType;

  const indexResult = await ensureResourceIndexed(env, logger, deliveryRow.productSlug, request.assetId, fileType, await fetchAssetBytes(env, asset.storageKey));
  if (indexResult.status === 'unsupported_format') return { ok: false, reason: 'unsupported_format' };
  if (indexResult.status === 'failed') return { ok: false, reason: 'indexing_failed' };

  const retrievalStart = Date.now();
  const searchResponse = await searchLibraryResource(env, logger, {
    query: question,
    documentId: indexResult.documentId,
    bookTitle: product.title,
    currentPage: request.currentPage,
    limit: RETRIEVAL_LIMIT,
  });
  const retrievalLatencyMs = Date.now() - retrievalStart;

  const confidenceTier = determineConfidenceTier(searchResponse.results);
  const topScore = searchResponse.results[0]?.score ?? null;

  if (confidenceTier === 'very_low') {
    const totalLatencyMs = Date.now() - totalStart;
    const messageId = await logMessage(
      env,
      logger,
      { customerId: request.customerId, purchaseReference: request.purchaseReference, assetId: request.assetId, mode: request.mode, questionText: question, currentPage: request.currentPage ?? null, answerText: null, status: 'declined', confidenceTier, topScore, retrievalLatencyMs, llmLatencyMs: null, totalLatencyMs, errorMessage: null },
      indexResult.documentId,
      []
    );
    return { ok: true, messageId, status: 'declined', answer: null, confidenceTier, citations: [] };
  }

  const citations = buildCitations(searchResponse.results);
  const systemPrompt = `${buildSafetySystemPrompt(product.title)}\n\n${CONFIDENCE_TIER_INSTRUCTIONS[confidenceTier]}`;
  const userPrompt = buildUserPrompt(request.mode, question, searchResponse.results);

  let llmLatencyMs: number | null = null;
  let answerText = '';
  let status: 'answered' | 'error' = 'answered';
  let errorMessage: string | null = null;

  try {
    const llmStart = Date.now();
    const result = await callAi(env, logger, {
      feature: CHAT_FEATURE,
      actorType: 'customer',
      actorId: request.customerId,
      classification: 'CONFIDENTIAL',
      systemPrompt,
      userPrompt,
    });
    llmLatencyMs = Date.now() - llmStart;
    answerText = result.content;
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('library_ai.llm_call_failed', { error: errorMessage });
  }

  const totalLatencyMs = Date.now() - totalStart;
  const messageId = await logMessage(
    env,
    logger,
    {
      customerId: request.customerId,
      purchaseReference: request.purchaseReference,
      assetId: request.assetId,
      mode: request.mode,
      questionText: question,
      currentPage: request.currentPage ?? null,
      answerText: status === 'answered' ? answerText : null,
      status,
      confidenceTier,
      topScore,
      retrievalLatencyMs,
      llmLatencyMs,
      totalLatencyMs,
      errorMessage,
    },
    indexResult.documentId,
    status === 'answered' ? citations : []
  );

  if (status === 'error') {
    return { ok: false, reason: 'llm_failed' }; // the customer-facing route maps this to a graceful "something went wrong" message
  }

  return { ok: true, messageId, status: 'answered', answer: answerText, confidenceTier, citations };
}

async function fetchAssetBytes(env: Env, storageKey: string): Promise<ArrayBuffer> {
  const object = await env.STORAGE.get(storageKey);
  if (!object) throw new Error(`Asset object not found in storage: ${storageKey}`);
  return object.arrayBuffer();
}
