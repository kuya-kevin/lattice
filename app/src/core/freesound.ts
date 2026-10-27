// Freesound API v2 text search (https://freesound.org/docs/api/). Runs where the key is:
// the Electron main process (or the fixture recorder). The renderer never sees the key.

export const TIMBRE_FIELDS = ['brightness', 'warmth', 'roughness', 'hardness', 'depth'] as const;
const RANGE_FIELDS = [...TIMBRE_FIELDS, 'duration', 'bpm', 'pitch'] as const;

export interface Range {
  min?: number;
  max?: number;
}

export type FreesoundFilters = Partial<Record<(typeof RANGE_FIELDS)[number], Range>> & { note_name?: string };

export interface FreesoundHit {
  id: number;
  name: string;
  tags: string[];
  description: string;
  license: string;
  duration: number;
  username: string;
  preview: string; // hq mp3 URL
  timbre: Record<string, number | null>;
  pitch: number | null;
  note_name: string | null;
  bpm: number | null;
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Builds a Solr-style filter: `brightness:[0 TO 40] duration:[* TO 10] note_name:"A"`. */
export function buildFilter(f: FreesoundFilters = {}): string {
  const parts: string[] = [];
  for (const key of RANGE_FIELDS) {
    const r = f[key];
    if (r && (r.min != null || r.max != null)) parts.push(`${key}:[${r.min ?? '*'} TO ${r.max ?? '*'}]`);
  }
  if (f.note_name) parts.push(`note_name:"${f.note_name.replace(/"/g, '')}"`);
  return parts.join(' ');
}

function licenseName(url: string): string {
  if (url.includes('publicdomain/zero')) return 'CC0';
  const m = url.match(/licenses\/([a-z-]+)\//);
  return m ? `CC-${m[1].toUpperCase()}` : url;
}

const r1 = (x: unknown) => (typeof x === 'number' ? Math.round(x * 10) / 10 : null);

export function toHit(r: any): FreesoundHit {
  return {
    id: r.id,
    name: r.name,
    tags: (r.tags ?? []).slice(0, 10),
    description: String(r.description ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200),
    license: licenseName(String(r.license ?? '')),
    duration: r1(r.duration) ?? 0,
    username: r.username,
    preview: r.previews?.['preview-hq-mp3'] ?? '',
    timbre: Object.fromEntries(TIMBRE_FIELDS.map((k) => [k, r1(r[k])])),
    pitch: r1(r.pitch),
    note_name: r.note_name ?? null,
    bpm: r1(r.bpm),
  };
}

export async function searchFreesound(
  token: string,
  query: string,
  filters: FreesoundFilters = {},
  pageSize = 5,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<{ count: number; results: FreesoundHit[] }> {
  const params = new URLSearchParams({
    query,
    fields: `id,name,tags,description,license,duration,username,previews,${RANGE_FIELDS.join(',')},note_name`,
    page_size: String(Math.min(15, Math.max(1, pageSize))),
    token,
  });
  const filter = buildFilter(filters);
  if (filter) params.set('filter', filter);
  const res = await fetchFn(`https://freesound.org/apiv2/search/?${params}`);
  if (!res.ok) throw new Error(`Freesound search failed: HTTP ${res.status}`);
  const data = await res.json();
  return { count: data.count ?? 0, results: (data.results ?? []).map(toHit) };
}
