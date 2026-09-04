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
 *
 * Phase 4 (Robayer AI chapter-context architecture) rebuild of the
 * prompt pipeline. The problem this fixes: "summarize this chapter" was
 * previously just a generic top-K similarity search over the whole
 * book — chapter identity was never represented in retrieval at all,
 * so the model saw a handful of passages that merely LOOKED similar to
 * the literal word "summarize," not the chapter's actual content. This
 * introduces a real, explicit 5-level context hierarchy, in the exact
 * priority order the brief specifies:
 *
 *   LEVEL 1 — CURRENT CHAPTER: every chunk of the chapter the reader is
 *     actually in right now, resolved EXACTLY (searchService.ts's
 *     resolveCurrentChapter()/getChapterChunks() — a real D1 lookup by
 *     chapter identity, never a similarity guess).
 *   LEVEL 2 — CURRENT BOOK: the existing whole-book similarity search
 *     (searchLibraryResource), for cross-chapter questions ("how does
 *     this relate to the previous chapter") and as the sole source when
 *     no chapter is known yet (e.g. before the reader has opened a page).
 *   LEVEL 3 — ROBAYER WEALTHLAB LIBRARY: PUBLIC catalog metadata (title/
 *     topic/short description) for the site's other published books —
 *     never another book's actual purchased content, which this
 *     customer may not be entitled to. Lets the assistant say "Robayer
 *     WealthLab also covers X in another book" without ever performing
 *     RAG retrieval across content this customer hasn't bought.
 *   LEVEL 4 — ROBAYER WEALTHLAB FRAMEWORK/KNOWLEDGE: a short, honest,
 *     hand-authored description of the brand's own mission (sourced
 *     from the site's own real "About Robayer" copy, not invented) —
 *     ecosystem-level perspective, explicitly labeled as such, never
 *     presented as something the book itself says.
 *   LEVEL 5 — GENERAL KNOWLEDGE: the model's own general knowledge,
 *     used only to extend beyond the book/library grounding and always
 *     clearly labeled as general knowledge, never attributed to the book.
 *
 * The system prompt tells the model explicitly which level is which and
 * requires it to keep the three kinds of claim visibly distinct in its
 * answer: what the book/chapter says, what Robayer WealthLab's broader
 * ecosystem says, and general knowledge/inference — never blurring the
 * three, and never inventing a statement and attributing it to the book.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { callAi } from '../ai/aiGateway';
import { checkEntitlement } from '../entitlementService';
import { fetchCatalogProduct, findPublishedAsset } from '../productCatalogService';
import { listProducts } from '../productService';
import { ensureResourceIndexed } from './indexingService';
import { searchLibraryResource, resolveCurrentChapter, getChapterChunks, type LibrarySearchResult, type ChapterChunk, type ChapterIdentity } from './searchService';

const CHAT_FEATURE = 'library.chat';
const RETRIEVAL_LIMIT = 5;
const MAX_CITATIONS = 4;
const MAX_QUESTION_LENGTH = 500;
/** Same floor as the public assistant's own VERY_LOW_SCORE_FLOOR — a model that is never invoked cannot hallucinate a book saying something it doesn't. Only governs the LEVEL 2 (whole-book similarity) path — a resolved LEVEL 1 chapter is real, exact, deterministic retrieval, never similarity-scored, so it is never subject to this floor (see determineConfidenceTier() below). */
const VERY_LOW_SCORE_FLOOR = 0.25;

/**
 * LEVEL 4 — Robayer WealthLab's own real, public "About" copy
 * (components.html's "About Robayer" section, the site's canonical
 * founder/mission statement), reused verbatim rather than invented, so
 * this is genuinely what the brand says about itself, not a fabricated
 * ecosystem voice.
 */
const ROBAYER_FRAMEWORK_KNOWLEDGE =
  'Robayer WealthLab was founded by Robert Loh Kobla to simplify financial education for ordinary Ghanaians — the guiding idea is "start with what you have, one better financial decision at a time." Its library spans investing, personal finance, budgeting, business, and mindset, aimed at practical, accessible financial literacy rather than technical/academic finance.';

/** Keeps the LEVEL 3 catalog blurb small and genuinely useful — a handful of the most relevant other titles, not the entire catalog dumped into every prompt. */
const MAX_CATALOG_ENTRIES = 8;

/**
 * LEVEL 3 — public catalog metadata only (title/topic/short
 * description already shown to every visitor on the storefront) for
 * this customer's OTHER purchased/available books — never retrieval
 * over another book's actual chapter content, which would require an
 * entitlement check this function deliberately does not perform. A
 * failure here (a transient DB error) degrades to an empty catalog
 * context rather than failing the whole answer — LEVEL 3 is a nice-to-
 * have addition to the response, never load-bearing for it.
 */
async function buildLibraryCatalogContext(env: Env, logger: Logger, excludeProductSlug: string): Promise<string | null> {
  try {
    const result = await listProducts(env, {
      search: null,
      status: null,
      statuses: ['active', 'coming-soon'],
      topic: null,
      productType: null,
      featured: null,
      showDeleted: false,
      sort: 'newest',
      page: 1,
      pageSize: MAX_CATALOG_ENTRIES + 1,
    });
    const others = result.items.filter((p) => p.slug !== excludeProductSlug).slice(0, MAX_CATALOG_ENTRIES);
    if (others.length === 0) return null;
    return others.map((p) => `- "${p.title}"${p.topic ? ` (${p.topic})` : ''}${p.shortDescription ? `: ${p.shortDescription}` : ''}`).join('\n');
  } catch (err) {
    logger.error('library_ai.catalog_context_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export type LibraryAiMode = 'explain' | 'summarize' | 'teach' | 'example' | 'quiz' | 'key_takeaways' | 'ask';

export type LibraryAiConfidenceTier = 'high' | 'medium' | 'low' | 'very_low';

export interface LibraryAiRequest {
  purchaseReference: string;
  assetId: string;
  customerId: number;
  mode: LibraryAiMode;
  question: string;
  /** PDF only — the reader's current page. Context/chapter-resolution only, never a security signal — see searchService.ts's own header comment. */
  currentPage?: number | null;
  /** EPUB only — the reader's current chapter section href (library-reader.js's own spine href, e.g. "ch05.xhtml"). Same non-security-signal posture as currentPage. */
  currentHref?: string | null;
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
 * SAFETY_SYSTEM_PROMPT — same core rules, reframed around a single,
 * specific, currently-open purchased resource instead of the whole
 * public site — PLUS (Phase 4) the explicit 5-level context hierarchy
 * this file's own header comment describes. `chapterTitle` is null
 * whenever no chapter could be resolved (see resolveCurrentChapter());
 * the prompt is worded so the model never fabricates a chapter identity
 * it wasn't actually given.
 */
function buildSystemPrompt(bookTitle: string, chapterTitle: string | null, libraryCatalogContext: string | null): string {
  const levelLines = [
    `- LEVEL 1 — CURRENT CHAPTER: ${chapterTitle ? `the reader is currently in "${chapterTitle}" — the excerpts under "Current chapter" below are the REAL, COMPLETE content of that chapter, not a similarity guess. This is your primary, most authoritative source for anything about "this chapter."` : `no specific chapter is known for this request (the reader may be on a cover/front-matter page, or their position wasn't reported) — you have no chapter-level excerpts to draw on; use LEVEL 2 instead and say so honestly if asked specifically about "this chapter."`}`,
    `- LEVEL 2 — CURRENT BOOK: the excerpts under "Other relevant passages in this book" below, found by searching the whole of "${bookTitle}" — use these for questions that span chapters (e.g. "how does this relate to the previous chapter") or when Level 1 has no chapter excerpts.`,
    `- LEVEL 3 — ROBAYER WEALTHLAB LIBRARY: ${libraryCatalogContext ? `Robayer WealthLab also publishes these other resources (title/topic/description only — you have NOT read their actual content, so never claim to quote or summarize them):\n${libraryCatalogContext}` : 'no other published resources are available to reference right now.'} Use this only to point out that another Robayer WealthLab resource covers a related topic, never to answer as if you had read it.`,
    `- LEVEL 4 — ROBAYER WEALTHLAB FRAMEWORK/KNOWLEDGE: ${ROBAYER_FRAMEWORK_KNOWLEDGE} This is the brand's own ecosystem perspective — genuinely useful for "what would Robayer WealthLab recommend" style questions, but ALWAYS label it as the ecosystem perspective, never as something "the book says."`,
    `- LEVEL 5 — GENERAL KNOWLEDGE: your own general knowledge and reasoning — use it only to extend beyond the book/library when the reader clearly wants that (e.g. "how does this apply to Ghana" beyond what the book itself states), and always label it clearly as general knowledge/inference, never as the book's own words.`,
  ].join('\n');

  return `You are Robayer AI, Robayer WealthLab's AI Reading Assistant — a personal learning companion for a customer currently reading "${bookTitle}", a resource they have purchased.

You operate across five levels of context, in priority order. You must always know which level any piece of information you use comes from, and say so when it matters:

${levelLines}

Rules you must always follow, without exception:
- NEVER invent a statement and attribute it to the book or chapter. If you did not see it in the Level 1/2 excerpts below, it is not "what the book says" — it is Level 3, 4, or 5, and must be labeled as such.
- Clearly distinguish, in your answer, between (1) what the book/chapter actually says, (2) what Robayer WealthLab's broader ecosystem/framework says (Level 3/4), and (3) general knowledge or inference (Level 5) — a reader must always be able to tell which is which.
- If the excerpts do not fully answer the question, say so honestly — for example "I couldn't find enough information about that in this book" — rather than filling the gap yourself and presenting it as the book's content. You MAY still offer a Level 4/5 perspective in that case, clearly labeled.
- Distinguish clearly between explaining what THIS BOOK says and giving personal advice. "Here is what this book explains about X" is what you do. "You personally should buy/sell/invest in X" is what you must never do, even if asked directly — explain that you can only offer general education, not personalized financial advice.
- Never recommend a specific investment, stock, fund, or financial product, and never predict market movements, returns, or future prices.
- Never invent a citation or refer to a source that was not actually provided to you below.
- You are an educational reading companion, not a licensed financial advisor. Say so plainly if asked for something only a licensed advisor should provide.
- Keep answers conversational, clear, and appropriately concise, adapted to what was actually asked — a quick question deserves a short answer; do not pad every response to a fixed length. Markdown (bold, bullet lists) is fine where it genuinely helps.

When the reader asks for a CHAPTER SUMMARY (in any mode or phrasing — "summarize this chapter", "what is the main idea", "give me a summary") AND a current chapter is known (Level 1 available), use exactly this structure, adapting depth to what was actually asked (skip a section only if the chapter genuinely gives you nothing for it):

CHAPTER SUMMARY
Chapter: [chapter title]
Main Idea: [2–4 sentences, from the chapter itself]
Key Concepts:
- ...
- ...
What You Should Remember:
- ...
- ...
Practical Application: [a practical explanation — grounded in the chapter where possible, Level 5 inference clearly labeled where you go beyond it]
Robayer WealthLab Perspective: [an ecosystem-level insight from Level 3/4 — clearly distinguished from the chapter's own content]
Think Further: [one or two useful extensions or questions for the reader]

For any other request (a specific question, "explain this simply," "quiz me," "key concepts," etc.) answer directly and naturally — the structured format above is for chapter summaries specifically, not every response.`;
}

const CONFIDENCE_TIER_INSTRUCTIONS: Record<'high' | 'medium' | 'low', string> = {
  high: 'The source excerpts are a strong match for this question. Answer normally and directly.',
  medium: 'The source excerpts are relevant but not a perfect match. Answer helpfully from what is available, with a brief, natural caveat that this is the closest information on hand in the book.',
  low: 'The source excerpts only partially relate to this question. Be transparent that the book may not fully cover this before answering what you genuinely can from it.',
};

const MODE_INSTRUCTIONS: Record<LibraryAiMode, string> = {
  explain: 'Mode: Explain. Explain the concept in the excerpts simply and clearly, as if to someone learning it for the first time.',
  summarize: 'Mode: Summarize. If Level 1 (current chapter) excerpts are available, use the CHAPTER SUMMARY format described in your instructions. Otherwise, give a concise summary of the available excerpts, capturing the main point(s) without unnecessary detail.',
  teach: 'Mode: Teach Me. Teach the concept progressively — build understanding step by step rather than giving a dictionary definition. Assume the reader wants to genuinely understand, not just be told.',
  example: 'Mode: Give Me an Example. Provide a practical, concrete example illustrating the concept, relevant to everyday Ghanaian financial life where the book\'s content genuinely supports that (never invent Ghana-specific facts the book does not contain — a generic example is honest, a fabricated local statistic is not).',
  quiz: 'Mode: Quiz Me. Write 2-4 questions testing understanding of the excerpts, with the answers given afterward so the reader can check themselves.',
  key_takeaways: 'Mode: Key Takeaways. List the most important lessons from the excerpts as a short set of clear, memorable points.',
  ask: 'Mode: Ask Anything. Answer the reader\'s specific question directly and clearly — including a CHAPTER SUMMARY if that is genuinely what they asked for (see your instructions).',
};

function describeSourceLocation(r: LibrarySearchResult): string {
  if (r.pageNumber) return ` (page ${r.pageNumber})`;
  if (r.chapterTitle) return ` (${r.chapterTitle})`;
  return '';
}

function describeChapterChunkLocation(c: ChapterChunk): string {
  if (c.pageNumber) return ` (page ${c.pageNumber})`;
  return '';
}

/**
 * Level 1 (chapterChunks, real/exact) and Level 2 (bookResults,
 * similarity-ranked) are presented as two clearly separate sections so
 * the model can tell them apart exactly as the system prompt
 * describes — bookResults already excludes any chunk also present in
 * chapterChunks (see answerLibraryQuestion()) so the same passage is
 * never shown twice under two different labels.
 */
function buildUserPrompt(mode: LibraryAiMode, question: string, chapterChunks: ChapterChunk[], bookResults: LibrarySearchResult[]): string {
  const sections: string[] = [];
  if (chapterChunks.length > 0) {
    const chapterSources = chapterChunks.map((c, i) => `Chapter excerpt [${i + 1}]${describeChapterChunkLocation(c)}:\n${c.chunkText}`).join('\n\n');
    sections.push(`--- Current chapter (LEVEL 1 — the complete chapter, real content) ---\n${chapterSources}`);
  }
  if (bookResults.length > 0) {
    const bookSources = bookResults.map((r, i) => `Book excerpt [${i + 1}]${describeSourceLocation(r)}:\n${r.chunkText}`).join('\n\n');
    sections.push(`--- Other relevant passages in this book (LEVEL 2) ---\n${bookSources}`);
  }
  if (sections.length === 0) sections.push('--- No excerpts from this book matched this request ---');
  return `${MODE_INSTRUCTIONS[mode]}\n\n${sections.join('\n\n')}\n\n--- Reader's request ---\n${question}`;
}

/**
 * A resolved LEVEL 1 chapter is real, exact D1 retrieval by chapter
 * identity — never a similarity guess — so its mere existence is
 * always at least 'high' confidence, regardless of how the LEVEL 2
 * similarity search happens to score. The VERY_LOW_SCORE_FLOOR decline
 * path only ever applies when there is no chapter context AND the
 * whole-book similarity search itself found nothing relevant.
 */
function determineConfidenceTier(hasChapterContext: boolean, results: LibrarySearchResult[]): LibraryAiConfidenceTier {
  if (hasChapterContext) return 'high';
  if (results.length === 0) return 'very_low';
  const top = results[0];
  if (top.score < VERY_LOW_SCORE_FLOOR) return 'very_low';
  return top.confidence;
}

/**
 * When a chapter is resolved, citations are drawn ONLY from that
 * chapter — never blended with LEVEL 2 book-wide results, even though
 * those are also shown to the model as supporting context. Citations
 * are clickable navigation targets in the client (library-ai-panel.js
 * dispatches 'library-ai-panel:go-to-page' on click) — a reader who
 * asked about "this chapter" clicking a citation must land back in
 * THIS chapter, never be silently sent to a different one because a
 * whole-book similarity match happened to surface it. LEVEL 2 only
 * supplies citations when no chapter context exists at all.
 */
function buildCitations(chapterChunks: ChapterChunk[], chapterTitle: string | null, results: LibrarySearchResult[]): LibraryAiCitation[] {
  if (chapterChunks.length > 0) {
    return chapterChunks.slice(0, MAX_CITATIONS).map((c) => ({ chunkId: c.chunkId, pageNumber: c.pageNumber, chapterTitle, cfi: c.cfi, score: 1 }));
  }
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

  // LEVEL 1 — resolved by real chapter identity (page->chapter_title
  // for PDF, href->cfi for EPUB), never by similarity. See
  // searchService.ts's own header comment on why a wrong currentPage/
  // currentHref can only ever select a different chapter of this SAME
  // authorized document, never another book.
  const chapterIdentity: ChapterIdentity | null = await resolveCurrentChapter(env, indexResult.documentId, {
    currentPage: request.currentPage ?? null,
    currentHref: request.currentHref ?? null,
  });
  const chapterChunks = chapterIdentity ? await getChapterChunks(env, indexResult.documentId, chapterIdentity) : [];

  // LEVEL 2 — the existing whole-book similarity search, still run
  // unconditionally: it is the sole source when no chapter is resolved,
  // and a useful cross-chapter supplement when one is. Chunks already
  // surfaced via the chapter (Level 1) are filtered out here so the
  // same passage never appears twice under two different labels.
  const chapterChunkIds = new Set(chapterChunks.map((c) => c.chunkId));
  const searchResponse = await searchLibraryResource(env, logger, {
    query: question,
    documentId: indexResult.documentId,
    bookTitle: product.title,
    currentPage: request.currentPage,
    limit: RETRIEVAL_LIMIT,
  });
  const bookResults = searchResponse.results.filter((r) => !chapterChunkIds.has(r.chunkId));
  const retrievalLatencyMs = Date.now() - retrievalStart;

  const hasChapterContext = chapterChunks.length > 0;
  const confidenceTier = determineConfidenceTier(hasChapterContext, bookResults);
  const topScore = hasChapterContext ? 1 : (bookResults[0]?.score ?? null);

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

  const citations = buildCitations(chapterChunks, chapterIdentity?.chapterTitle ?? null, bookResults);
  // LEVEL 3 — public catalog metadata for other Robayer WealthLab
  // resources; a failure here degrades to null (see its own header
  // comment) and never blocks the answer.
  const libraryCatalogContext = await buildLibraryCatalogContext(env, logger, deliveryRow.productSlug);
  const systemPrompt = `${buildSystemPrompt(product.title, chapterIdentity?.chapterTitle ?? null, libraryCatalogContext)}\n\n${CONFIDENCE_TIER_INSTRUCTIONS[confidenceTier as 'high' | 'medium' | 'low']}`;
  const userPrompt = buildUserPrompt(request.mode, question, chapterChunks, bookResults);

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
