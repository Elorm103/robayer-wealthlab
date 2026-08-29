/**
 * Robayer WealthLab: "Ask Robayer AI" Library entry point — Digital
 * Library 2.0, Phase F (Personal Library Home). Drives the
 * [data-library-ai-entry-root] section on dashboard/index.html, a
 * separate, independent component matching this project's established
 * one-script-per-section convention (library-continue-reading.js,
 * library-recommendations.js).
 *
 * This is deliberately NOT a second AI interface. It never calls
 * POST /api/customer/library/ai/ask itself - it is a real entry point
 * into the one, existing AI Reading Assistant
 * (js/components/library-ai-panel.js), reached by deep-linking into the
 * reader with `?ai=1`, which library-ai-panel.js's own
 * `library-reader:ready` handler opens on load. See that file's own
 * comment on this exact query param.
 *
 * Book context, in priority order (never fabricated - every candidate
 * comes from the same two real endpoints library-continue-reading.js
 * already reads):
 *   1. The most recently read in-progress resource (real
 *      library_progress data).
 *   2. The most recently purchased resource whose owned asset actually
 *      supports the AI Reading Assistant (PDF or EPUB - see
 *      answerService.ts's own format gate).
 * Renders nothing, section stays hidden, if the customer owns no
 * AI-eligible resource at all.
 */

function initLibraryAiEntry() {
  const section = document.querySelector('[data-library-ai-entry-root]');
  if (!section || section.hasAttribute('data-bound')) return;
  section.setAttribute('data-bound', 'true');

  const questionEl = section.querySelector('[data-library-ai-entry-question]');
  const ctaEl = section.querySelector('[data-library-ai-entry-cta]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let progressResult;
    let purchasesResult;
    try {
      [progressResult, purchasesResult] = await Promise.all([
        window.CustomerDashboard.customerFetch('/api/customer/library/progress'),
        window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50'),
      ]);
    } catch {
      // A missed AI entry point is never worth disrupting the rest of
      // the Library over - fail silently, section stays hidden.
      return;
    }

    const purchases = purchasesResult.purchases || [];
    const context = resolveContext(progressResult.progress || [], purchases);
    if (!context) return;

    questionEl.textContent = `Have a question about "${context.bookTitle}"? Ask Robayer AI — grounded in this book only.`;
    const params = new URLSearchParams({ ref: context.purchaseReference, assetId: context.assetId, ai: '1' });
    ctaEl.href = `/dashboard/read/?${params.toString()}`;
    section.hidden = false;
  }

  function isAiEligible(asset) {
    return asset && !asset.revoked && (asset.fileType === 'PDF' || asset.fileType === 'EPUB');
  }

  function resolveContext(progressRecords, purchases) {
    const purchaseByReference = new Map(purchases.map((p) => [p.purchaseReference, p]));

    const inProgress = progressRecords
      .filter((p) => p.status === 'in_progress')
      .map((p) => {
        const purchase = purchaseByReference.get(p.purchaseReference);
        const asset = purchase ? (purchase.assets || []).find((a) => a.assetId === p.assetId) : null;
        return purchase && isAiEligible(asset) ? { progress: p, purchase } : null;
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.progress.lastReadAt) - new Date(a.progress.lastReadAt));

    if (inProgress.length > 0) {
      const { progress, purchase } = inProgress[0];
      return { purchaseReference: purchase.purchaseReference, assetId: progress.assetId, bookTitle: purchase.productTitle };
    }

    // No in-progress reading - fall back to the most recently purchased
    // resource with an AI-eligible asset. `purchases` is already
    // newest-first (the same server order library-list.js relies on).
    for (const purchase of purchases) {
      if (purchase.status !== 'ready') continue;
      const asset = (purchase.assets || []).find(isAiEligible);
      if (asset) return { purchaseReference: purchase.purchaseReference, assetId: asset.assetId, bookTitle: purchase.productTitle };
    }

    return null;
  }
}

document.addEventListener('partials:loaded', initLibraryAiEntry);
document.addEventListener('DOMContentLoaded', initLibraryAiEntry);
