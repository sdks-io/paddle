/**
 * Paging through Paddle list endpoints.
 *
 * Paddle lists are cursor-based: `meta.pagination.next` is the full URL of the
 * next page (it carries `after=<last id>`), and `meta.pagination.has_more`
 * says whether to continue. The SDK exposes them as
 * `meta.pagination.next` / `meta.pagination.hasMore`; it does not auto-page.
 *
 * Per-page limits (Paddle docs): most lists default 50, max 200;
 * GET /transactions max 30; GET /adjustments max 50.
 */

interface PageMeta {
  pagination: { next: string; hasMore: boolean };
}

/** Extracts the `after` cursor from `meta.pagination.next`, or undefined when there is no next page. */
export function nextCursor(meta: PageMeta): string | undefined {
  if (!meta.pagination.hasMore || !meta.pagination.next) return undefined;
  try {
    return new URL(meta.pagination.next).searchParams.get("after") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects every page. `fetchPage(after)` runs one SDK list call with that cursor.
 * `maxPages` guards against runaway loops when a filter unexpectedly matches everything.
 *
 * Example:
 *   const all = await listAll((after) =>
 *     client.subscriptions.listSubscriptions({ customerId: [customerId], perPage: 200, after }),
 *   );
 */
export async function listAll<T>(
  fetchPage: (after: string | undefined) => Promise<{ data: T[]; meta: PageMeta }>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(after);
    out.push(...res.data);
    after = nextCursor(res.meta);
    if (!after) return out;
  }
  throw new Error(`listAll: more than ${maxPages} pages; narrow the filter`);
}
