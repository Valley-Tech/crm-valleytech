import { graphRequest } from './graph.js';

/** Lista todas las plantillas de una WABA, paginando hasta el final. */
export async function listTemplates(wabaId, accessToken) {
  const collected = [];
  let after;

  do {
    const page = await graphRequest({
      path: `${wabaId}/message_templates`,
      accessToken,
      params: { limit: 100, ...(after ? { after } : {}) },
    });
    collected.push(...(page?.data ?? []));
    after = page?.paging?.cursors?.after && page?.paging?.next ? page.paging.cursors.after : null;
  } while (after);

  return collected;
}
