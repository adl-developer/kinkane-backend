import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * The BDS client, against fixtures cut from the two response shapes BDS have
 * shown us: the live service's `<resultfields>` records with `fv_`-prefixed
 * names (their "SAMPLE XML" document, record BDZ0012921134) and the
 * integrator's guide's `<record>` shape. The unauthorised body is the one the
 * live endpoint actually returned to an unauthenticated request.
 */

const store = new Map<string, string>();
vi.mock('../lib/redis', () => ({
  redis: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
  },
}));

const CREDENTIALS = {
  BDS_ENRICHMENT_ENABLED: 'true',
  BDS_USERNAME: 'kinkane',
  BDS_PASSWORD: 'p&ss word',
};

const UNAUTHORISED = JSON.stringify({
  response: { error_code: 1, error_msg: 'Unauthorised access! Terminating client.', explain: 'No token or invalid token' },
});
const LOGIN_OK = JSON.stringify({ response: { token: 'jwt-1' } });
// The live response for an account with no Database Licence Subscription. Note
// the reversed names: errorcode carries the message, errormessage the number.
const LICENCE_ERROR = JSON.stringify({
  errordetails: {
    errorcode: 'You need to configure the Database Licence Subscriptions via the ACS for this customer.',
    errormessage: 1,
  },
});

// Trimmed from BDS's sample record — the bio is the real one, the review is
// the empty CDATA block the sample actually has.
const LIVE_SHAPE_NO_REVIEW = `
<resultfields>
<fv_author_bio><![CDATA[<p><strong>Leonid Khriachtchev</strong> graduated from Leningrad State University, Russia, in 1981.</p>]]></fv_author_bio>
<fv_barcode>9789814267823</fv_barcode>
<fv_identifier>9814267821</fv_identifier>
<fv_identifier>9789814267823</fv_identifier>
<fv_identifier>BDZ0012921134</fv_identifier>
<fv_illus/>
<fv_related_ids>9780429066276</fv_related_ids>
<fv_review><![CDATA[ ]]></fv_review>
</resultfields>`;

// Review text is the TextType 06 quote from BDS's ONIX sample for this ISBN.
const LIVE_SHAPE_WITH_REVIEW = `
<resultfields>
<fv_barcode>9780241635537</fv_barcode>
<fv_review><![CDATA[<p>&lsquo;Compelling&rsquo; <i>The Observer</i></p>]]></fv_review>
<fv_prizes>Shortlisted for the Women's Prize for Fiction 2024</fv_prizes>
<fv_related_editions>9780241635544|9780241635551|9780241635544</fv_related_editions>
<fv_index_updated>20260918</fv_index_updated>
</resultfields>`;

function liveEnvelope(...records: string[]) {
  return `<resultscollection><resultsetinformation><search_query>q</search_query></resultsetinformation>${records.join('')}</resultscollection>`;
}

async function loadBds() {
  vi.resetModules();
  Object.assign(process.env, CREDENTIALS);
  const mod = await import('../lib/bds');
  mod.resetBdsTokenForTests();
  return mod;
}

/** Answers login calls with LOGIN_OK and data calls from the queue, in order. */
function mockFetch(dataResponses: string[], loginResponse = LOGIN_OK) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const queue = [...dataResponses];
  const fetchMock = vi.fn(async (url: URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const body = url.searchParams.get('ax') === '_login' ? loginResponse : (queue.shift() ?? '');
    return { ok: true, status: 200, text: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => store.clear());
afterEach(() => {
  for (const k of Object.keys(CREDENTIALS)) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('parseRecords', () => {
  it('reads the live fv_-prefixed shape, taking HTML from CDATA verbatim', async () => {
    const { parseRecords } = await loadBds();
    const [record] = parseRecords(liveEnvelope(LIVE_SHAPE_NO_REVIEW));

    expect(record.isbn13).toBe('9789814267823');
    expect(record.authorBio).toBe(
      '<p><strong>Leonid Khriachtchev</strong> graduated from Leningrad State University, Russia, in 1981.</p>',
    );
  });

  it('treats an empty CDATA review as no review', async () => {
    const { parseRecords } = await loadBds();
    const [record] = parseRecords(liveEnvelope(LIVE_SHAPE_NO_REVIEW));
    expect(record.review).toBeNull();
  });

  it('reads review, prizes, pipe-separated editions and the update date', async () => {
    const { parseRecords } = await loadBds();
    const [record] = parseRecords(liveEnvelope(LIVE_SHAPE_WITH_REVIEW));

    expect(record.review).toBe('<p>&lsquo;Compelling&rsquo; <i>The Observer</i></p>');
    expect(record.prizes).toBe("Shortlisted for the Women's Prize for Fiction 2024");
    expect(record.relatedEditions).toEqual(['9780241635544', '9780241635551']);
    expect(record.indexUpdated).toBe('20260918');
    expect(record.authorBio).toBeNull();
  });

  it('also reads the integrator-guide <record> shape with bare names and escaped text', async () => {
    const { parseRecords } = await loadBds();
    const [record] = parseRecords(
      '<records><record><author_bio>ROSANNE CASH has recorded fourteen albums &amp; more.</author_bio>' +
        '<barcode>9780143119395</barcode><review></review></record></records>',
    );

    expect(record.isbn13).toBe('9780143119395');
    expect(record.authorBio).toBe('ROSANNE CASH has recorded fourteen albums & more.');
    expect(record.review).toBeNull();
  });

  it('falls back to the identifier list when there is no barcode', async () => {
    const { parseRecords } = await loadBds();
    const [record] = parseRecords(
      '<resultfields><fv_identifier>BDZ1</fv_identifier><fv_identifier>9781800961883</fv_identifier></resultfields>',
    );
    expect(record.isbn13).toBe('9781800961883');
  });

  it('drops records with no recoverable ISBN', async () => {
    const { parseRecords } = await loadBds();
    expect(parseRecords('<resultfields><fv_identifier>BDZ1</fv_identifier></resultfields>')).toEqual([]);
  });
});

describe('fetchByIsbns', () => {
  it('logs in once, then sends the token as a bearer header', async () => {
    const { fetchByIsbns } = await loadBds();
    const calls = mockFetch([liveEnvelope(LIVE_SHAPE_WITH_REVIEW)]);

    await fetchByIsbns(['9780241635537']);

    expect(calls).toHaveLength(2);
    expect(calls[0].url.protocol).toBe('https:');
    // 'ax' is the login parameter, not 'sx' — see the note in login().
    expect(calls[0].url.searchParams.get('ax')).toBe('_login');
    expect(calls[0].url.searchParams.get('usr')).toBe('kinkane');
    // Special characters in the password survive URL encoding intact.
    expect(calls[0].url.searchParams.get('pwd')).toBe('p&ss word');
    expect(calls[1].headers.Authorization).toBe('Bearer jwt-1');
    expect(store.get('bds:api-token')).toBe('jwt-1');
  });

  it('reuses a cached token rather than logging in again', async () => {
    store.set('bds:api-token', 'jwt-cached');
    const { fetchByIsbns } = await loadBds();
    const calls = mockFetch([liveEnvelope()]);

    await fetchByIsbns(['9780241635537']);

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-cached');
  });

  it('asks for every ISBN in one OR query with only the fields we store', async () => {
    const { fetchByIsbns } = await loadBds();
    const calls = mockFetch([liveEnvelope()]);

    await fetchByIsbns(['9780241635537', '9781800961883']);

    const params = calls[1].url.searchParams;
    expect(params.get('SF1')).toBe('identifier');
    expect(params.get('ST1')).toBe('9780241635537 OR 9781800961883');
    expect(params.get('PL')).toBe('2');
    expect(params.get('FIELDS')).toContain('author_bio');
    expect(params.get('FIELDS')).toContain('review');
  });

  it('returns an entry for every ISBN asked about, null where BDS had nothing', async () => {
    const { fetchByIsbns } = await loadBds();
    mockFetch([liveEnvelope(LIVE_SHAPE_WITH_REVIEW)]);

    const result = await fetchByIsbns(['9780241635537', '9781800961883']);

    expect(result.get('9780241635537')?.review).toContain('Compelling');
    expect(result.has('9781800961883')).toBe(true);
    expect(result.get('9781800961883')).toBeNull();
  });

  it('ignores records for ISBNs it did not ask about', async () => {
    const { fetchByIsbns } = await loadBds();
    mockFetch([liveEnvelope(LIVE_SHAPE_NO_REVIEW)]);

    const result = await fetchByIsbns(['9780241635537']);
    expect([...result.keys()]).toEqual(['9780241635537']);
  });

  it('replaces a rejected token and retries once — errors arrive with HTTP 200', async () => {
    store.set('bds:api-token', 'jwt-stale');
    const { fetchByIsbns } = await loadBds();
    const calls = mockFetch([UNAUTHORISED, liveEnvelope(LIVE_SHAPE_WITH_REVIEW)]);

    const result = await fetchByIsbns(['9780241635537']);

    expect(result.get('9780241635537')).not.toBeNull();
    expect(calls.map((c) => c.headers.Authorization ?? 'login')).toEqual(['Bearer jwt-stale', 'login', 'Bearer jwt-1']);
  });

  it('throws an auth error when even a fresh token is rejected', async () => {
    const { fetchByIsbns, BdsAuthError } = await loadBds();
    mockFetch([UNAUTHORISED, UNAUTHORISED]);

    await expect(fetchByIsbns(['9780241635537'])).rejects.toBeInstanceOf(BdsAuthError);
  });

  it('raises a request error, not an auth retry, when the account has no data licence', async () => {
    // The live account authenticates but carries no licence; BDS answer with a
    // second error shape whose numeric code is also 1. Treating that as an auth
    // failure would send us round the login loop for a problem no token fixes.
    const { fetchByIsbns, BdsRequestError } = await loadBds();
    const calls = mockFetch([LICENCE_ERROR, LICENCE_ERROR]);

    await expect(fetchByIsbns(['9780241635537'])).rejects.toBeInstanceOf(BdsRequestError);
    await expect(fetchByIsbns(['9780241635537'])).rejects.toThrow(/Database Licence Subscriptions/);
    // Login once, one data call, then the error — no second login.
    expect(calls.filter((c) => c.url.searchParams.get('ax') === '_login')).toHaveLength(1);
  });

  it('throws an auth error when login itself is refused', async () => {
    const { fetchByIsbns, BdsAuthError } = await loadBds();
    mockFetch([], UNAUTHORISED);

    await expect(fetchByIsbns(['9780241635537'])).rejects.toBeInstanceOf(BdsAuthError);
  });

  it('refuses more than 100 ISBNs before making any request', async () => {
    const { fetchByIsbns } = await loadBds();
    const calls = mockFetch([]);
    const isbns = Array.from({ length: 101 }, (_, i) => `978000000${String(i).padStart(4, '0')}`);

    await expect(fetchByIsbns(isbns)).rejects.toThrow(/at most 100/);
    expect(calls).toHaveLength(0);
  });
});
